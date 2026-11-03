/**
 * Postgres-backed job queue for Sua AI operations.
 *
 * Neon Postgres is the queue and the source of truth (FOR UPDATE SKIP LOCKED);
 * there is no Redis, no BullMQ and no separate worker. Work starts immediately
 * from the request that caused it — via `waitUntil`, registered synchronously
 * by lib/background.js — and the cron tick is only a janitor and a safety net.
 */

import { runAfterResponse } from "./background.js";
import { processingBudgetMs } from "./budget.js";
import { aiConfigured } from "./ai.js";

// Stale limits shared by reaper and submit path.
export const STALE_QUEUED_MS = 10 * 60_000;

/**
 * How many claiming passes one invocation may perform. A yield re-queues the
 * job with no delay, so a targeted run can spend its whole budget on one long
 * document instead of returning after a single pass.
 */
export function maxPassesPerInvocation() {
  const value = Number(process.env.MAX_PASSES_PER_INVOCATION);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 6;
}

/** True when the AI pipeline can actually run. */
export function pipelineConfigured() {
  return Boolean(process.env.DATABASE_URL) && aiConfigured();
}

/**
 * Start a runner pass after the response.
 *
 * Synchronous by design: the waitUntil registration has to happen before the
 * handler returns, or the platform may freeze the invocation and the work —
 * including the job just created — silently never starts.
 *
 * @returns {{scheduled: boolean}}
 */
export function triggerRunner(targetJobId = null) {
  const scheduled = runAfterResponse(`runner ${targetJobId ?? "queue"}`, async () => {
    // Imported inside the task: runner → pipeline → queue would otherwise be a
    // static import cycle.
    const { runJobs } = await import("./runner.js");
    return runJobs({
      targetJobId,
      maxJobs: targetJobId ? maxPassesPerInvocation() : 2,
      maxPasses: maxPassesPerInvocation(),
      budgetMs: processingBudgetMs(),
    });
  });
  return { scheduled };
}

/**
 * A job row already exists in Postgres; this only asks the platform to keep
 * the invocation alive long enough to run it.
 *
 * @returns {{scheduled: boolean}}
 */
export function enqueueStudyJob(payload) {
  const jobId =
    typeof payload === "object" && payload !== null
      ? (payload.jobId ?? payload.id)
      : payload;

  if (!jobId) return { scheduled: false };
  return triggerRunner(String(jobId));
}
