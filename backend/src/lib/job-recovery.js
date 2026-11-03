/**
 * Pure yield/stall accounting for the job runner. Kept separate from Prisma so
 * the thresholds and the no-progress rule can be tested offline.
 *
 * A pass that yields has not failed: finished work is on the checkpoint. But a
 * pass that yields while the checkpoint and progress counters stand still is a
 * poisoned wave, and an unbounded sequence of those is exactly the "stuck on
 * Combining" symptom.
 */

import { isUserFacing } from "../config/ai-pipeline.js";

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

/**
 * A budget yield is "out of time for this invocation", not "wait for the
 * provider". Only those may be re-claimed immediately by the same invocation;
 * a rate-limit yield must keep its delay or the provider is hammered.
 */
export function isBudgetYield(error) {
  return error?.reason !== "rate_limit";
}

/**
 * Should this invocation keep working the same job after a yield?
 *
 * A targeted run (a kick for one job) used to exit after a single pass even
 * with most of its budget unused, so a long document advanced one pass per
 * client poll. Continuing is safe because the checkpoint is durable: a pass
 * that made no progress is caught by the stall accounting, and the pass count
 * keeps one job from monopolising the invocation.
 */
export function shouldContinueInInvocation({
  remainingMs,
  passes,
  minContinueMs = 15_000,
  maxPasses = 6,
}) {
  if (!Number.isFinite(remainingMs) || remainingMs < minContinueMs) return false;
  return (passes ?? 0) < maxPasses;
}

/**
 * Stable error code for a failed job. Moved here from the runner so the
 * pipeline's `setFailed` writes the same codes the runner does — a failure
 * without a code is a failure the diagnostics cannot group.
 */
export function errorCodeFor(error) {
  if (!error) return null;
  if (error.name === "NoteDeletedError" || error.code === "P2025") return "NOTE_DELETED";
  if (error.name === "JobCancelledError" || error.cancelled) return "CANCELLED";
  if (isUserFacing(error)) return "USER_FACING";

  const kind = error.kind;
  if (kind === "rate_limit") return "RATE_LIMIT";
  if (kind === "timeout") return "TIMEOUT";
  if (kind === "too_large") return "INPUT_TOO_LARGE";
  if (kind === "auth") return "AI_AUTH";
  if (kind === "quota") return "AI_QUOTA";
  if (kind === "invalid_output") return "PARSE_ERROR";
  if (kind === "transient") return "AI_TRANSIENT";
  if (kind === "bad_request") return "AI_BAD_REQUEST";
  // A checkpoint that cannot be written is not the model's fault: the durable
  // state is missing, so the pass must be retried rather than reported as bad
  // output.
  if (kind === "checkpoint_write") return "CHECKPOINT_WRITE";

  const msg = String(error.message ?? error).toLowerCase();
  if (msg.includes("too short")) return "NOTE_TOO_SHORT";
  if (msg.includes("disallowed")) return "DISALLOWED_KIND";
  if (
    error.status === 429 ||
    error.statusCode === 429 ||
    msg.includes("rate limit") ||
    msg.includes("429")
  ) {
    return "RATE_LIMIT";
  }
  if (msg.includes("timeout") || msg.includes("timed out") || error.code === "ETIMEDOUT") {
    return "TIMEOUT";
  }
  if (msg.includes("json") || msg.includes("parse")) return "PARSE_ERROR";
  if (msg.includes("schema") || msg.includes("validation")) return "SCHEMA_INVALID";
  if (error.code && typeof error.code === "string") return error.code.toUpperCase().slice(0, 32);

  return "INTERNAL_ERROR";
}
