/**
 * Postgres-backed job queue for Sua AI operations.
 * Replaces Redis/BullMQ with Neon Postgres row locking (FOR UPDATE SKIP LOCKED).
 * Jobs are triggered immediately via Vercel waitUntil in serverless environments,
 * or processed via tick crons and dev-mode background timers.
 */

export const STUDY_QUEUE = "sua-study-set";

// Stale limits shared by reaper and submit path
export const STALE_QUEUED_MS = 10 * 60_000;
export const STALE_RUNNING_MS = 90 * 60_000;

export function studyQueueConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Triggers runner processing asynchronously.
 * In Vercel serverless environments, uses waitUntil so the execution extends beyond response delivery.
 * In local dev or standalone scripts, invokes runJobs asynchronously.
 */
async function triggerRunner(targetJobId) {
  try {
    const { runJobs } = await import("./runner.js");

    try {
      const vercel = await import("@vercel/functions");
      if (typeof vercel?.waitUntil === "function") {
        vercel.waitUntil(
          runJobs({ targetJobId, maxJobs: 1, budgetMs: 240_000 }).catch((err) => {
            console.warn("waitUntil runner error:", err?.message ?? err);
          }),
        );
        return;
      }
    } catch {
      // Not in Vercel or @vercel/functions unavailable
    }

    // Fire-and-forget fallback for local dev
    runJobs({ targetJobId, maxJobs: 1, budgetMs: 240_000 }).catch((err) => {
      console.warn("Runner error:", err?.message ?? err);
    });
  } catch (err) {
    console.warn("Failed to trigger runner:", err?.message ?? err);
  }
}

/**
 * Enqueue a study job. The job row is already created in Postgres;
 * this triggers execution via waitUntil or the internal runner loop.
 */
export async function enqueueStudyJob(payload) {
  const data =
    typeof payload === "object" && payload !== null
      ? {
          jobId: payload.jobId ?? payload.id,
          noteId: payload.noteId,
          userId: payload.userId,
          kind: payload.kind ?? "study_set",
        }
      : { jobId: String(payload) };

  const jobId = data.jobId;
  if (!jobId) return;

  // Fire runner in the background
  triggerRunner(jobId);
}
