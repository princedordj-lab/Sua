/**
 * One place that knows how long an invocation may run.
 *
 * A serverless function is terminated at its maximum duration, so any pass that
 * planned for longer than the real ceiling is killed mid-flight: its lease has
 * to expire before another invocation can reclaim the work. That is correct,
 * but slow, and from the app it is indistinguishable from a hang. So the
 * ceiling is configuration, not a constant copied into three files:
 *
 *   PLATFORM_MAX_DURATION_MS=300000  (default)
 *     300 s is the documented Hobby *and* Pro default/maximum with Fluid
 *     compute, which Vercel enables by default for new projects.
 *   PLATFORM_MAX_DURATION_MS=60000
 *     A Hobby project without Fluid compute is capped at 60 s. A budget above
 *     the real ceiling is worse than a small one, so set this if the dashboard
 *     shows the 60 s limit.
 *
 * Nothing here talks to the database or the network: the arithmetic is the part
 * that has to be testable, because a wrong lease or a tick that overruns its
 * own function limit is exactly what leaves jobs stuck.
 */

const DEFAULTS = {
  platformMaxMs: 300_000,
  safetyMs: 12_000,
  minBudgetMs: 15_000,
  // Below this there is no point starting another phase of work.
  minPhaseMs: 10_000,
  // A model call started with less window than this is a call that cannot
  // finish; the caller should save its progress and yield instead.
  minCallWindowMs: 25_000,
};

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/** The deployed function ceiling, in ms. */
export function platformMaxMs() {
  return positiveInt("PLATFORM_MAX_DURATION_MS", DEFAULTS.platformMaxMs);
}

/** Headroom kept for the final checkpoint/status writes before the ceiling. */
export function processingSafetyMs() {
  return positiveInt("PROCESSING_SAFETY_MS", DEFAULTS.safetyMs);
}

/** How much wall clock one pass may spend on real work. */
export function processingBudgetMs() {
  const budget = platformMaxMs() - processingSafetyMs();
  return Math.max(DEFAULTS.minBudgetMs, budget);
}

/** Extraction is cheaper per unit of progress, but still bounded. */
export function extractionBudgetMs() {
  return Math.max(DEFAULTS.minPhaseMs, Math.round(processingBudgetMs() * 0.5));
}

/** Window below which a stage should not start another model call. */
export function minCallWindowMs() {
  return positiveInt("MIN_AI_CALL_WINDOW_MS", DEFAULTS.minCallWindowMs);
}

export function minPhaseMs() {
  return DEFAULTS.minPhaseMs;
}

/**
 * How long a claimed job stays protected from other invocations.
 *
 * It must outlive the longest pass it protects: a second invocation that could
 * still steal a live job is duplicate AI spend on the same document. The cap
 * keeps a dead lease recoverable within minutes rather than hours.
 */
export function leaseMsFor(budgetMs = processingBudgetMs()) {
  return Math.min(
    platformMaxMs() + 120_000,
    Math.max(120_000, Math.round(budgetMs) + 60_000),
  );
}

/**
 * Silence after which a `running` row is declared interrupted.
 *
 * Never less than the lease (a live pass legitimately holds it for the whole
 * pass) and never so long that the app shows "Combining" for an hour.
 */
export function interruptedAfterMs(leaseMs = leaseMsFor()) {
  const value = positiveInt("INTERRUPTED_RUNNING_MS", Math.max(300_000, leaseMs * 2));
  return Math.max(leaseMs, value);
}

/**
 * Split one tick invocation between the three things it must do, so their sum
 * can never exceed the function's ceiling the way three independent budgets did.
 * Client polls remain the primary drain; the cron is the janitor.
 */
export function tickBudgetPlan(budgetMs = processingBudgetMs()) {
  const generationMs = Math.round(budgetMs * 0.55);
  const extractionMs = Math.round(budgetMs * 0.25);
  return {
    totalMs: budgetMs,
    generationMs,
    extractionMs,
    maintenanceMs: Math.max(0, budgetMs - generationMs - extractionMs),
  };
}

export function remainingMs(deadline, now = Date.now()) {
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - now);
}

/** Printed once at boot so a plan/budget mismatch is visible in the logs. */
export function budgetReport() {
  const platform = platformMaxMs();
  const budget = processingBudgetMs();
  const plan = tickBudgetPlan(budget);
  return {
    platformMaxMs: platform,
    budgetMs: budget,
    leaseMs: leaseMsFor(budget),
    interruptedAfterMs: interruptedAfterMs(leaseMsFor(budget)),
    tick: plan,
    source: process.env.PLATFORM_MAX_DURATION_MS ? "env" : "default",
  };
}
