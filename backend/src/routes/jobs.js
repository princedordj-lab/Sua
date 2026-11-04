import { Router } from "express";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import { prisma } from "../config/prisma.js";
import { warnIfOverCaps } from "../lib/pipeline.js";
import {
  cancelProcessingRun,
  ensureProcessingJob,
  needsResubmit,
  processingConfigured,
  retryProcessing,
  startProcessing,
} from "../lib/processing/start.js";
import {
  MATERIALS,
  PROCESSING_STATES,
  materialStates,
  shapeProcessing,
} from "../lib/processing/state.js";

export const jobsRouter = Router();

const ACTIVE_STATES = ["queued", "running"];
// The kinds `process-document` can run — anything else is a 400 before a row
// exists, so a typo never becomes a job that fails on the first stage.
const KINDS = new Set(["study_set", "lecture_note", "course_reference"]);
// Job kinds whose payload carries note-generation diagnostics (not user data).
const NOTE_KINDS = new Set(["study_set", "lecture_note", "course_reference"]);

/** Parsed generation metadata (pages read, truncation, check result), or null. */
function jobMeta(job) {
  if (!NOTE_KINDS.has(job.kind) || !job.payload) return null;
  try {
    const parsed = JSON.parse(job.payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// What the client reads to drive status UI.
const PROGRESS_UNITS = {
  reading: "pages",
  reading_scans: "pages",
  digesting: "sections",
  merging: "batches",
  writing: "parts",
};

function stageDetail(job) {
  const unit = PROGRESS_UNITS[job.stage];
  const total = job.progressTotal ?? 0;
  const done = job.progressDone ?? 0;
  if (!unit || total <= 0) return null;
  const current = Math.max(1, Math.min(done || 1, total));
  if (job.stage === "reading" || job.stage === "reading_scans") {
    return `Reading pages ${Math.min(done, total)} of ${total}`;
  }
  if (job.stage === "digesting") return `Analyzing section ${current} of ${total}`;
  if (job.stage === "merging") return `Combining batch ${current} of ${total}`;
  if (job.stage === "writing") return `Writing part ${current} of ${total}`;
  return null;
}

function shapeJob(job) {
  return {
    id: job.id,
    noteId: job.noteId,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    attempts: job.attempts,
    error: job.error,
    meta: jobMeta(job),
    // Long-file progress (additive): "Reading pages 41 of 212".
    progressDone: job.progressDone ?? 0,
    progressTotal: job.progressTotal ?? 0,
    progressUnit: PROGRESS_UNITS[job.stage] ?? null,
    // Server-computed sentence so mobile and web cannot disagree about units.
    stageDetail: stageDetail(job),
    // Trigger.dev processing state (additive; the lifecycle the app renders).
    processingState: job.processingState ?? null,
    triggerState: job.triggerState ?? "none",
    runId: job.runId ?? null,
    errorCategory: job.errorCategory ?? null,
    materials: materialStates(job),
    // Proof of life: a running job with an old heartbeat is not progressing.
    heartbeatAt: job.heartbeatAt ?? job.updatedAt ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
  };
}

function requirePipeline(res) {
  if (!processingConfigured()) {
    res.status(503).json({ error: "AI processing is not configured" });
    return false;
  }
  return true;
}

/**
 * How the client should read a processing row.
 *
 * The queue-era reaper is gone: Trigger.dev owns retries and timeouts, so a
 * stale "running" row is never guessed at from timestamps. The only recovery
 * this API performs is re-submitting a row whose trigger call never landed
 * (`triggerState === "failed"`, or stuck "submitting"), which cannot create a
 * second run: Trigger.dev deduplicates on the document's idempotency key.
 */
async function recoverRow(job) {
  if (!job) return job;
  if (!needsResubmit(job)) return job;
  const retried = await retryProcessing(job).catch((error) => {
    console.warn(`could not re-submit job ${job.id}: ${error?.message ?? error}`);
    return null;
  });
  if (!retried?.job) return job;
  return {
    ...job,
    triggerState: retried.triggered ? "submitted" : "failed",
    runId: retried.runId ?? job.runId,
  };
}

// Enqueue a generation for a note (study set or course reference). Local-first
// clients call this when connectivity returns or when the student picks a
// destination after saving. Active (queued/running) jobs dedupe; failed jobs
// can be re-submitted.
jobsRouter.post("/", async (req, res) => {
  if (!requirePipeline(res)) return;
  const identity = await identityFromRequest(req);
  const noteId = String(req.body?.noteId ?? "");
  if (!noteId) return res.status(400).json({ error: "noteId is required" });
  const kind = req.body?.kind ?? "study_set";
  if (!KINDS.has(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${[...KINDS].join(", ")}` });
  }

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const note = await tx.note.findFirst({
      where: { id: noteId, userId: user.id },
      include: { course: { select: { id: true } } },
    });
    if (!note) return { status: 404, error: "Note not found" };
    // A reference page must never be overwritten by a study set. Turning a
    // normal note into a reference is allowed (it is an explicit destination).
    if (note.noteKind === "reference" && kind !== "course_reference") {
      return {
        status: 409,
        error: "This note is a course reference; only the reference can be regenerated.",
      };
    }
    // One row per (note, kind, processing version): a repeated request finds the
    // running row instead of starting a second run.
    const active = await tx.job.findFirst({
      where: { noteId: note.id, kind, state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return { existing: active };
    const created = await ensureProcessingJob(
      { noteId: note.id, userId: user.id, kind },
      tx,
    ).then((result) => result.job);
    // Mirror the destination immediately; the pipeline re-asserts it when the
    // attempt starts and on finish.
    await tx.note.update({
      where: { id: note.id },
      data: {
        aiState: "queued",
        noteKind: kind === "course_reference" ? "reference" : "note",
      },
    });
    return { job: created };
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  const job = outcome.existing ?? outcome.job;

  // Cap awareness is warn-only until billing (Milestone 5). `authenticate`
  // already resolved this row, so the old code opened a whole transaction — a
  // pinned pooled connection — just to read an id it already had.
  const userId =
    identity.user?.id ??
    (await withUser(identity.clerkId, (tx) => requireUser(tx, identity))).id;
  const warning = await warnIfOverCaps(userId);
  if (warning) console.warn(`[CAP WARNING] ${identity.email}: ${warning}`);

  // Trigger.dev owns the run. A trigger failure is not fatal: the row stays with
  // triggerState "failed" and `POST /api/jobs/:id/retry` (or the next poll's
  // recovery) re-submits it without creating a second run.
  const started =
    !outcome.existing || job.triggerState === "failed"
      ? await startProcessing({
          noteId: job.noteId,
          userId: job.userId,
          kind: job.kind,
        }).catch((error) => {
          console.warn(`trigger failed for job ${job.id}: ${error?.message ?? error}`);
          return null;
        })
      : null;
  const fresh = started?.job
    ? await prisma.job.findUnique({ where: { id: job.id } })
    : job;
  res
    .status(outcome.existing ? 200 : 201)
    .json({ ...shapeJob(fresh ?? job), processing: shapeProcessing(fresh ?? job) });
});

jobsRouter.get("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    return tx.job.findFirst({ where: { id: req.params.id } });
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  const recovered = await recoverRow(job);
  res.json({ ...shapeJob(recovered), processing: shapeProcessing(recovered) });
});

// Latest job for a note (the app polls while the note screen is open).
jobsRouter.get("/note/:noteId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    return tx.job.findFirst({
      where: { noteId: req.params.noteId },
      orderBy: { createdAt: "desc" },
    });
  });
  if (!job) return res.json(null);
  const recovered = await recoverRow(job);
  res.json({ ...shapeJob(recovered), processing: shapeProcessing(recovered) });
});


// Report a mistake on any AI output, saved with its source text (PRD 10).
const TARGET_TYPES = new Set(["summary", "flashcard", "quiz_question", "transcript"]);

// Cancel a queued or running job (stage-boundary safe: workers check the Job
// row between stages and stop quietly; finished work stays checkpointed).
jobsRouter.post("/:id/cancel", async (req, res) => {
  const identity = await identityFromRequest(req);
  const cancelled = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    const job = await tx.job.findFirst({
      where: { id: req.params.id },
      select: { id: true, state: true, noteId: true },
    });
    if (!job) return null;
    const claim = await tx.job.updateMany({
      where: { id: job.id, state: { in: ["queued", "running"] } },
      data: {
        state: "cancelled",
        stage: "cancelled",
        processingState: PROCESSING_STATES.cancelled,
        finishedAt: new Date(),
        lockedUntil: null,
      },
    });
    // Keep aiState "failed" so the app's retry affordance stays available;
    // the cancelled state itself only stops the worker at the next boundary.
    await tx.note.updateMany({
      where: { id: job.noteId },
      data: { aiState: "failed" },
    });
    return { id: job.id, cancelled: claim.count > 0 };
  });
  if (!cancelled) return res.status(404).json({ error: "Job not found" });
  // Stop the Trigger.dev run too (best-effort: the row is the source of truth).
  const row = await prisma.job.findUnique({ where: { id: cancelled.id }, select: { runId: true } });
  if (row?.runId) await cancelProcessingRun(row.runId);
  res.json(cancelled);
});

/**
 * Retry failed processing for a whole document.
 * Only the incomplete materials re-run: anything already generated stays.
 */
jobsRouter.post("/:id/retry", async (req, res) => {
  if (!requirePipeline(res)) return;
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    return tx.job.findFirst({ where: { id: req.params.id } });
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.processingState === "completed") {
    return res.status(409).json({ error: "This note is already complete" });
  }
  const result = await retryProcessing(job);
  if (!result) return res.status(404).json({ error: "Job not found" });
  const fresh = await prisma.job.findUnique({ where: { id: job.id } });
  res.status(202).json({ ...shapeJob(fresh), processing: shapeProcessing(fresh) });
});

/** Retry one failed material (for example only the quiz). */
jobsRouter.post("/:id/materials/:material/retry", async (req, res) => {
  if (!requirePipeline(res)) return;
  const material = String(req.params.material);
  if (!MATERIALS.includes(material)) {
    return res.status(400).json({ error: `material must be one of: ${MATERIALS.join(", ")}` });
  }
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    return tx.job.findFirst({ where: { id: req.params.id } });
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  const result = await retryProcessing(job, { material });
  if (!result) return res.status(404).json({ error: "Job not found" });
  const fresh = await prisma.job.findUnique({ where: { id: job.id } });
  res.status(202).json({ ...shapeJob(fresh), processing: shapeProcessing(fresh) });
});

jobsRouter.post("/feedback", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { targetType, targetId, comment, sourceText, noteId } = req.body ?? {};
  if (!TARGET_TYPES.has(targetType)) {
    return res
      .status(400)
      .json({ error: `targetType must be one of: ${[...TARGET_TYPES].join(", ")}` });
  }
  if (!comment || typeof comment !== "string") {
    return res.status(400).json({ error: "comment is required" });
  }
  const feedback = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.feedback.create({
      data: {
        userId: user.id,
        noteId: typeof noteId === "string" && noteId ? noteId : null,
        targetType,
        targetId: typeof targetId === "string" && targetId ? targetId : null,
        comment: comment.slice(0, 4000),
        sourceText: typeof sourceText === "string" ? sourceText.slice(0, 50_000) : null,
      },
    });
  });
  res.status(201).json({ id: feedback.id });
});
