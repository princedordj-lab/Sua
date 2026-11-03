/**
 * "Is the job already on this note alive?" — one rule, three call sites.
 *
 * `POST /jobs`, upload completion's `maybeEnqueueGeneration` and the quiz
 * marking route all used to answer this question with their own slightly
 * different copy. They disagreed about released jobs (queued with a
 * `startedAt` because a pass yielded or is waiting on extraction), about dead
 * workers, and about how long "queued but never picked up" is allowed to
 * block a retry.
 *
 * Kept pure so the matrix is testable without a database.
 */

export const ACTIVE_JOB_STATES = ["queued", "running"];

export const DEFAULT_STALE_QUEUED_MS = 10 * 60_000;

/**
 * A job is alive when a worker could still make progress on it.
 *
 * - `running` with a recent heartbeat: a pass owns it (or owned it moments
 *   ago). Alive either way — the lease decides whether it can be reclaimed.
 * - `queued` that already ran: a yielded pass or the extraction gate parked it,
 *   so it is alive while its own retry clock has not expired.
 * - `queued` that never ran: alive for `staleQueuedMs`, after which the
 *   invocation that was supposed to pick it up is gone.
 */
export function jobIsAlive(job, { now = Date.now(), staleQueuedMs = DEFAULT_STALE_QUEUED_MS, staleRunningMs } = {}) {
  if (!job) return false;
  const runningWindow = Number.isFinite(staleRunningMs) ? staleRunningMs : 15 * 60_000;

  if (job.state === "running") {
    const aliveAt = job.heartbeatAt ?? job.startedAt ?? job.createdAt;
    return now - new Date(aliveAt).getTime() <= runningWindow;
  }
  if (job.state !== "queued") return false;
  if (job.startedAt) {
    const aliveAt = job.heartbeatAt ?? job.startedAt;
    return now - new Date(aliveAt).getTime() <= runningWindow;
  }
  return now - new Date(job.createdAt).getTime() <= staleQueuedMs;
}

/**
 * @param {object|null} active  newest queued/running job for the note, if any
 * @returns {"create"|"reuse"}  what the caller should do under its note lock
 */
export function decideJobCreation(active, options = {}) {
  if (!active) return "create";
  return jobIsAlive(active, options) ? "reuse" : "create";
}

/**
 * A destination already produced for this note must not be produced again by
 * the upload-completion path. A failed run is not "produced" — the student is
 * allowed to retry a lecture note that died on a model error.
 */
export function hasSettledKind(jobs, kind) {
  return (jobs ?? []).some((job) => job.kind === kind && job.state !== "failed");
}
