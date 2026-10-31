/**
 * Pure yield/stall accounting for the job runner. Kept separate from Prisma so
 * the thresholds and the no-progress rule can be tested offline.
 *
 * A pass that yields has not failed: finished work is on the checkpoint. But a
 * pass that yields while the checkpoint and progress counters stand still is a
 * poisoned wave, and an unbounded sequence of those is exactly the "stuck on
 * Combining" symptom.
 */

export const YIELD_DEFAULTS = {
  maxRuntimeMs: 45 * 60_000,
  maxYields: 60,
  maxStalled: 3,
  minRateLimitDelayMs: 30_000,
  maxRateLimitDelayMs: 10 * 60_000,
};

export function clampDelay(ms, min = YIELD_DEFAULTS.minRateLimitDelayMs, max = YIELD_DEFAULTS.maxRateLimitDelayMs) {
  const value = Number.isFinite(ms) ? ms : min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * @param {object} current  previous recovery state ({ runtimeMs, yields, stalled, signal })
 * @param {object} input    { signal, elapsedMs, maxRuntimeMs?, maxYields?, maxStalled? }
 * @returns {{ runtimeMs:number, yields:number, stalled:number, signal:number, fail:string|null }}
 */
export function nextYieldState(current = {}, input = {}) {
  const runtimeMs = Math.max(0, (current.runtimeMs ?? 0) + Math.max(0, input.elapsedMs ?? 0));
  const yields = (current.yields ?? 0) + 1;
  const previousSignal = Number.isFinite(current.signal) ? current.signal : null;
  const signal = Number.isFinite(input.signal) ? input.signal : 0;
  // progressDone changes unit between stages (digests -> batches -> parts), so
  // a stage switch is progress even when the raw counter drops.
  const stageChanged = Boolean(input.stage && current.stage && input.stage !== current.stage);
  const advanced = stageChanged || previousSignal == null || signal > previousSignal;
  const stalled = advanced ? 0 : (current.stalled ?? 0) + 1;

  const maxRuntimeMs = input.maxRuntimeMs ?? YIELD_DEFAULTS.maxRuntimeMs;
  const maxYields = input.maxYields ?? YIELD_DEFAULTS.maxYields;
  const maxStalled = input.maxStalled ?? YIELD_DEFAULTS.maxStalled;

  let fail = null;
  if (runtimeMs >= maxRuntimeMs) fail = "runtime";
  else if (yields >= maxYields) fail = "yields";
  else if (stalled >= maxStalled) fail = "stalled";

  return {
    runtimeMs,
    yields,
    stalled,
    signal,
    stage: input.stage ?? current.stage ?? null,
    fail,
  };
}

/** One number that grows whenever a pass saves new work. */
export function progressSignal({ progressDone = 0, checkpoint = {} } = {}) {
  const digests = Object.keys(checkpoint.digests ?? {}).length;
  const reduce = Object.keys(checkpoint.reduce ?? {}).length;
  return Math.max(0, Number(progressDone) || 0) + digests + reduce;
}

export function yieldDelayMs(error, random = Math.random) {
  if (error?.reason === "rate_limit") {
    const base = clampDelay(error?.retryAfterMs);
    // Jitter keeps several parked jobs from waking on the same second.
    return clampDelay(base + Math.floor(random() * 5_000));
  }
  return 2_000;
}
