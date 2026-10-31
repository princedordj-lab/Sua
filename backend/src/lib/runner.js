import { prisma } from "../config/prisma.js";
import { processJob } from "./pipeline.js";
import { extractDocument, isRenderedPageBlank, renderPdfPage } from "./extract.js";
import { extractNext } from "./extraction.js";
import { isUserFacing, isJobYield, USER_MESSAGES, longDoc } from "../config/ai-pipeline.js";

export const ALLOWED_JOB_KINDS = [
  "study_set",
  "lecture_note",
  "course_reference",
  "quiz_marking",
];

export const MIN_NOTE_CHARS = 40;
export const DEFAULT_BUDGET_MS = 240_000;
export const DEFAULT_LEASE_MS = 360_000;
export const BACKOFF_DELAYS_SEC = [30, 120, 600];

/**
 * Distinguishes transient (network/concurrency/rate limit/model glitch) failures
 * from permanent user/validation errors that should not be retried.
 */
export function isTransient(error) {
  if (!error) return false;
  if (isUserFacing(error)) return false;
  if (error.name === "NoteDeletedError" || error.code === "P2025") return false;

  const msg = String(error.message ?? error).toLowerCase();
  if (msg.includes("too short") || msg.includes("disallowed")) return false;
  if (msg.includes("unauthorized") || msg.includes("not found")) return false;

  // Rate limits (429)
  if (
    error.status === 429 ||
    error.statusCode === 429 ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  ) {
    return true;
  }

  // Network / connection errors
  if (
    error.code === "ETIMEDOUT" ||
    error.code === "ECONNRESET" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ENOTFOUND" ||
    error.code === "EAI_AGAIN" ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return true;
  }

  // Upstream 5xx errors
  const status = error.status || error.statusCode;
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return true;
  }
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable")
  ) {
    return true;
  }

  // Database transient errors (deadlock, connection pool)
  if (
    error.code === "P1001" ||
    error.code === "P1008" ||
    error.code === "P1017" ||
    error.code === "40P01"
  ) {
    return true;
  }

  // Model schema parse failure or unexpected output format (often transient on temperature retry)
  if (msg.includes("json") || msg.includes("schema") || msg.includes("parse")) {
    return true;
  }

  return false;
}

/**
 * Concise classification code for telemetry and troubleshooting.
 */
export function errorCodeFor(error) {
  if (!error) return null;
  if (error.name === "NoteDeletedError" || error.code === "P2025") return "NOTE_DELETED";
  if (isUserFacing(error)) return "USER_FACING";

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

/**
 * Claims the next eligible job atomically using Postgres FOR UPDATE SKIP LOCKED.
 * If targetJobId is specified, attempts to claim that specific job first.
 */
export async function claimJob({ leaseMs = DEFAULT_LEASE_MS, targetJobId = null } = {}) {
  const leaseSeconds = Math.max(30, Math.ceil(leaseMs / 1000));
  const leaseInterval = `${leaseSeconds} seconds`;

  return await prisma.$transaction(async (tx) => {
    // 1. Mark dead only leased jobs that expired and exhausted their retries.
    // A running row without a lease is an orphan (for example, an older
    // runner released a job after an unexpected early return). It is safely
    // reclaimable from its durable checkpoint and must not be failed here.
    await tx.$executeRaw`
      UPDATE "jobs"
      SET "state" = 'failed',
          "stage" = 'failed',
          "error" = 'Job timed out and exhausted retry attempts',
          "errorCode" = 'TIMEOUT',
          "lockedUntil" = NULL,
          "finishedAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "state" = 'running'
        AND "lockedUntil" < NOW()
        AND "attempts" >= "maxAttempts"
    `.catch(() => {});

    // 2. Select next claimable candidate
    let rows;
    if (targetJobId) {
      rows = await tx.$queryRaw`
        SELECT "id", "attempts", "maxAttempts", "kind", "noteId", "userId", "state", "stage", "lockedUntil"
        FROM "jobs"
        WHERE "id" = ${targetJobId}
          AND (
            ("state" = 'queued' AND "runAfter" <= NOW())
            OR (
              "state" = 'running'
              AND (
                "lockedUntil" IS NULL
                OR ("lockedUntil" < NOW() AND "attempts" < "maxAttempts")
              )
            )
          )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
    }

    if (!rows || rows.length === 0) {
      rows = await tx.$queryRaw`
        SELECT "id", "attempts", "maxAttempts", "kind", "noteId", "userId", "state", "stage", "lockedUntil"
        FROM "jobs"
        WHERE ("state" = 'queued' AND "runAfter" <= NOW())
           OR (
             "state" = 'running'
             AND (
               "lockedUntil" IS NULL
               OR ("lockedUntil" < NOW() AND "attempts" < "maxAttempts")
             )
           )
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
    }

    if (!rows || rows.length === 0) return null;
    const candidate = rows[0];

    if (candidate.state === "running" && !candidate.lockedUntil) {
      console.warn(
        `[queue-recover] job=${candidate.id} stage=${candidate.stage ?? "-"} reason=missing_lease`,
      );
    }

    // 3. Lock candidate and set state to running
    await tx.$executeRaw`
      UPDATE "jobs"
      SET "state" = 'running',
          "lockedUntil" = NOW() + (${leaseInterval})::interval,
          "updatedAt" = NOW()
      WHERE "id" = ${candidate.id}
    `;

    return candidate;
  });
}

/**
 * Extends lease time for a currently running job.
 */
export async function extendLease(jobId, extraMs = 180_000) {
  const extraSec = Math.max(10, Math.ceil(extraMs / 1000));
  const interval = `${extraSec} seconds`;
  await prisma.$executeRaw`
    UPDATE "jobs"
    SET "lockedUntil" = GREATEST("lockedUntil", NOW()) + (${interval})::interval,
        "updatedAt" = NOW()
    WHERE "id" = ${jobId} AND "state" = 'running'
  `.catch(() => {});
}

/**
 * Releases a running job back to queued without incrementing attempts.
 */
export async function releaseJob(jobId) {
  await prisma.job.updateMany({
    where: { id: jobId, state: "running" },
    data: { state: "queued", lockedUntil: null },
  }).catch(() => {});
}

/**
 * A yield is not a failure. Finished stages live on the checkpoint, so the
 * attempt is returned (a big file may legitimately need many invocations) and
 * the job is queued again for the next poll/tick to continue.
 */
export async function releaseJobForResume(jobId) {
  await prisma
    .$executeRaw`
      UPDATE "jobs"
      SET "state" = 'queued',
          "lockedUntil" = NULL,
          "runAfter" = NOW() + interval '2 seconds',
          "attempts" = GREATEST("attempts" - 1, 0),
          "updatedAt" = NOW()
      WHERE "id" = ${jobId} AND "state" = 'running'
    `
    .catch((error) => {
      console.warn(`could not re-queue yielded job ${jobId}: ${error?.message ?? error}`);
    });
}

/** Extraction failed for a document the job depends on — permanent, honest, no retry. */
function failJobExtraction(job, asset) {
  const message =
    asset.extractErrorCode === "UNREADABLE_PPT"
      ? "This .ppt file can't be parsed. Save it as .pptx and upload again."
      : "Couldn't read text from this file. Try a clearer PDF or re-upload.";
  console.warn(`Job ${job.id} failed: asset extraction ${asset.extractErrorCode ?? "failed"}`);
  return prisma.job
    .updateMany({
      where: { id: job.id },
      data: {
        state: "failed",
        stage: "failed",
        lockedUntil: null,
        finishedAt: new Date(),
        error: message,
        errorCode: "EXTRACTION_FAILED",
        errorStage: "extract",
      },
    })
    .then(() =>
      job.kind !== "quiz_marking" && job.noteId
        ? prisma.note.updateMany({
            where: { id: job.noteId },
            data: { aiState: "failed" },
          }).catch(() => {})
        : undefined,
    );
}

async function handleJobFailure(job, error) {
  const current = await prisma.job.findUnique({
    where: { id: job.id },
    select: { attempts: true, maxAttempts: true, stage: true, state: true },
  });
  if (!current || current.state === "done") return;

  const attempts = current.attempts ?? 1;
  const maxAttempts = current.maxAttempts ?? 3;
  const code = errorCodeFor(error);
  const stage = current.stage ?? "failed";
  const transient = isTransient(error);

  if (transient && attempts < maxAttempts) {
    const delaySec = BACKOFF_DELAYS_SEC[attempts - 1] ?? 600;
    const runAfter = new Date(Date.now() + delaySec * 1000);
    console.log(`Scheduling retry ${attempts + 1}/${maxAttempts} for job ${job.id} in ${delaySec}s`);
    await prisma.job.updateMany({
      where: { id: job.id },
      data: {
        state: "queued",
        runAfter,
        lockedUntil: null,
        errorCode: code,
        errorStage: stage,
      },
    }).catch(() => {});
    if (job.kind !== "quiz_marking" && job.noteId) {
      await prisma.note.updateMany({
        where: { id: job.noteId },
        data: { aiState: "queued" },
      }).catch(() => {});
    }
  } else {
    console.warn(`Job ${job.id} marked failed permanently (transient=${transient}, attempt=${attempts}/${maxAttempts})`);
    await prisma.job.updateMany({
      where: { id: job.id },
      data: {
        state: "failed",
        stage: "failed",
        lockedUntil: null,
        finishedAt: new Date(),
        errorCode: code,
        errorStage: stage,
      },
    }).catch(() => {});
    if (job.kind !== "quiz_marking" && job.noteId) {
      await prisma.note.updateMany({
        where: { id: job.noteId },
        data: { aiState: "failed" },
      }).catch(() => {});
    }
  }
}

async function processClaimedJob(claimed, deadline = null) {
  const jobId = claimed.id;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      note: { include: { assets: true } },
      user: { select: { id: true, clerkId: true } },
    },
  });

  if (!job) {
    console.warn(`Job ${jobId} not found in database; skipping.`);
    return;
  }
  if (job.state === "done") {
    await prisma.job.updateMany({
      where: { id: jobId },
      data: { lockedUntil: null },
    }).catch(() => {});
    return;
  }

  // 1. Kind check
  if (!ALLOWED_JOB_KINDS.includes(job.kind)) {
    console.warn(`Job ${jobId} rejected: disallowed kind "${job.kind}"`);
    await prisma.job.updateMany({
      where: { id: jobId },
      data: {
        state: "failed",
        stage: "failed",
        error: `Disallowed job kind: ${job.kind}`,
        errorCode: "DISALLOWED_KIND",
        finishedAt: new Date(),
        lockedUntil: null,
      },
    }).catch(() => {});
    return;
  }

  // 2. Note ownership check
  if (!job.note || job.note.id !== job.noteId) {
    console.warn(`Note ${job.noteId} not found for job ${jobId}`);
    await prisma.job.updateMany({
      where: { id: jobId },
      data: {
        state: "failed",
        stage: "failed",
        error: "Note was deleted",
        errorCode: "NOTE_DELETED",
        finishedAt: new Date(),
        lockedUntil: null,
      },
    }).catch(() => {});
    return;
  }
  if (job.note.userId !== job.userId) {
    console.warn(`Note ${job.noteId} does not belong to user ${job.userId}`);
    await prisma.job.updateMany({
      where: { id: jobId },
      data: {
        state: "failed",
        stage: "failed",
        error: "Unauthorized note access",
        errorCode: "UNAUTHORIZED",
        finishedAt: new Date(),
        lockedUntil: null,
      },
    }).catch(() => {});
    return;
  }

  // 3. Note content length validation (for non-quiz_marking)
  if (job.kind !== "quiz_marking") {
    const hasMedia = job.note.assets && job.note.assets.some((a) => a.status === "active");
    const hasTranscript = Boolean(job.note.transcript && job.note.transcript.trim());
    if (!hasMedia && !hasTranscript) {
      const normalizedBody = String(job.note.body ?? "").trim();
      if (normalizedBody.length < MIN_NOTE_CHARS) {
        console.warn(`Job ${jobId} aborted: note body too short (${normalizedBody.length} chars)`);
        const errorMessage = "Note content is too short (minimum 40 characters required).";
        await prisma.job.updateMany({
          where: { id: jobId },
          data: {
            state: "failed",
            stage: "failed",
            error: errorMessage,
            errorCode: "NOTE_TOO_SHORT",
            finishedAt: new Date(),
            lockedUntil: null,
          },
        }).catch(() => {});
        await prisma.note.updateMany({
          where: { id: job.note.id },
          data: { aiState: "failed" },
        }).catch(() => {});
        return;
      }
    }
  }

  // 3.5 Long-file extraction gate. A generation job never runs against a
  // source still being read: one bounded extraction pass runs inline here
  // (this invocation owns its budget); if the file needs more passes, the
  // job is released WITHOUT spending an attempt — the tick cron or the next
  // status poll re-queues it the moment extraction finishes.
  if (job.kind !== "quiz_marking") {
    const documents = (job.note.assets ?? []).filter(
      (asset) => asset.kind === "document" && asset.status === "active",
    );
    const failedAsset = documents.find((asset) => asset.extractState === "failed");
    if (failedAsset) {
      return failJobExtraction(job, failedAsset);
    }
    const unfinished = documents.filter((asset) =>
      ["pending", "partial", "running"].includes(asset.extractState ?? "none"),
    );
    if (unfinished.length) {
      for (const asset of unfinished) {
        await extractNext({
          targetAssetId: asset.id,
          budgetMs: Math.min(120_000, longDoc.extractBudgetMs),
        }).catch((error) => {
          console.warn(`Extraction pass failed for asset ${asset.id}: ${error?.message ?? error}`);
        });
      }
      const states = await prisma.asset.findMany({
        where: { id: { in: unfinished.map((asset) => asset.id) } },
        select: { extractState: true },
      }).catch(() => []);
      const failedNow = states.find((asset) => asset.extractState === "failed");
      if (failedNow) return failJobExtraction(job, { extractErrorCode: null, ...failedNow });
      if (states.some((asset) => asset.extractState !== "done")) {
        await releaseJob(job.id);
        await prisma.job.updateMany({
          where: { id: job.id, state: "queued" },
          data: { runAfter: new Date(Date.now() + 60_000) },
        }).catch(() => {});
        console.log(`Job ${job.id} released: extraction still in progress (${states.map((s) => s.extractState).join(",")})`);
        return;
      }
    }
  }

  // 4. Run pipeline
  const started = Date.now();
  try {
    await processJob(jobId, { extractDocument, renderPdfPage, isRenderedPageBlank }, deadline);
    console.log(`Job ${jobId} completed in ${Date.now() - started}ms`);
    // Release lock upon success
    await prisma.job.updateMany({
      where: { id: jobId },
      data: { lockedUntil: null },
    }).catch(() => {});
  } catch (error) {
    if (isJobYield(error)) {
      await releaseJobForResume(jobId);
      console.log(
        `Job ${jobId} yielded at ${error?.stage ?? "stage"} after ${Date.now() - started}ms; re-queued to resume from checkpoint`,
      );
      return;
    }
    console.warn(`Job ${jobId} failed: ${error?.message ?? error}`);
    await handleJobFailure(job, error);
  }
}

/**
 * Runner entry point: processes up to maxJobs within budgetMs.
 * Designed to be invoked by Vercel waitUntil, tick cron, or dev interval.
 */
export async function runJobs({
  maxJobs = 1,
  budgetMs = DEFAULT_BUDGET_MS,
  targetJobId = null,
} = {}) {
  const startTime = Date.now();
  // Leave headroom under the platform function limit for the final writes and
  // the release/complete update after a stage boundary.
  const deadline = startTime + Math.max(30_000, budgetMs - 15_000);
  let processed = 0;
  let errors = 0;

  while (processed < maxJobs && Date.now() - startTime < budgetMs) {
    const remainingMs = budgetMs - (Date.now() - startTime);
    if (remainingMs < 10_000) {
      // Less than 10 seconds remaining in budget; stop to avoid timeout
      break;
    }

    const claimed = await claimJob({
      leaseMs: Math.min(360_000, Math.max(remainingMs + 60_000, 120_000)),
      targetJobId: processed === 0 ? targetJobId : null,
    }).catch((err) => {
      console.warn("claimJob error:", err?.message ?? err);
      return null;
    });

    if (!claimed) break;

    try {
      // The invocation's own budget, not just a job budget: stages stop
      // starting calls past this point and yield the job back to the queue.
      await processClaimedJob(claimed, deadline);
      processed++;
    } catch (err) {
      errors++;
      console.error(`Unexpected runner failure on job ${claimed.id}:`, err);
    }
  }

  return { processed, errors, durationMs: Date.now() - startTime };
}
