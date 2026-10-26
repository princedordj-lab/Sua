import { Router } from "express";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import { aiConfigured } from "../lib/ai.js";
import {
  studyQueueConfigured,
  enqueueStudyJob,
  STALE_QUEUED_MS,
  STALE_RUNNING_MS,
} from "../lib/queue.js";
import { warnIfOverCaps } from "../lib/pipeline.js";
import { USER_MESSAGES } from "../config/ai-pipeline.js";

export const jobsRouter = Router();

const ACTIVE_STATES = ["queued", "running"];
// Mirrors the pipeline's dispatcher (processJob) — anything else is a 400.
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
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
  };
}

function requirePipeline(res) {
  if (!studyQueueConfigured() || !process.env.DATABASE_URL || !aiConfigured()) {
    res.status(503).json({ error: "AI processing is not configured" });
    return false;
  }
  return true;
}

function isStale(job) {
  const now = Date.now();
  if (job.state === "queued" && !job.startedAt) {
    return now - job.createdAt.getTime() > STALE_QUEUED_MS;
  }
  if (job.state === "running" && job.startedAt) {
    return now - job.startedAt.getTime() > STALE_RUNNING_MS;
  }
  return false;
}

/**
 * Reads are the client's only heartbeat on a job, so a job whose worker never
 * picked it up (or died mid-run) is closed here as a normal failure: the app
 * then shows the standard retry card instead of waiting forever.
 */
async function reapIfStale(tx, job) {
  if (!job || !isStale(job)) return job;
  try {
    const updated = await tx.job.update({
      where: { id: job.id },
      data: {
        state: "failed",
        stage: "failed",
        error: USER_MESSAGES.generic,
        finishedAt: new Date(),
      },
    });
    await tx.note.updateMany({
      where: { id: job.noteId },
      data: { aiState: "failed" },
    });
    console.warn(
      `[STALE JOB] ${job.id} reaped after ${Math.round(
        (Date.now() - (job.startedAt ?? job.createdAt).getTime()) / 60_000,
      )} min in ${job.state}`,
    );
    return updated;
  } catch (error) {
    // Missing row (note deleted mid-read) is not an error worth failing on.
    console.warn(`[STALE JOB] ${job.id} could not be reaped: ${error?.message ?? error}`);
    return job;
  }
}

/** A failed enqueue must not leave a phantom "queued" job the app will poll. */
async function failUnqueuedJob(clerkId, job) {
  const data = {
    state: "failed",
    stage: "failed",
    error: USER_MESSAGES.generic,
    finishedAt: new Date(),
  };
  try {
    await withUser(clerkId, async (tx) => {
      await tx.job.update({ where: { id: job.id }, data });
      await tx.note.updateMany({
        where: { id: job.noteId },
        data: { aiState: "failed" },
      });
    });
    Object.assign(job, data);
  } catch (error) {
    console.warn(`could not mark job ${job.id} failed: ${error?.message ?? error}`);
  }
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
    const active = await tx.job.findFirst({
      where: { noteId: note.id, state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: "desc" },
    });
    // A dead job (never picked up, or a run that never settled) must not block
    // the retry the student is asking for: close it and create a fresh one.
    if (active) {
      const settled = await reapIfStale(tx, active);
      if (settled.state !== "failed") return { existing: settled };
    }
    const created = await tx.job.create({
      data: { userId: user.id, noteId: note.id, kind },
    });
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

  // Cap awareness is warn-only until billing (Milestone 5).
  const warning = await warnIfOverCaps(
    (await withUser(identity.clerkId, (tx) => requireUser(tx, identity))).id,
  );
  if (warning) console.warn(`[CAP WARNING] ${identity.email}: ${warning}`);

  try {
    await enqueueStudyJob({
      jobId: job.id,
      noteId: job.noteId,
      userId: job.userId,
      kind: job.kind,
    });
  } catch (error) {
    // The row exists but nothing will ever consume it. Close it now so the
    // student gets the standard retry card instead of a job that never runs.
    console.warn(`enqueue failed for job ${job.id}: ${error?.message ?? error}`);
    await failUnqueuedJob(identity.clerkId, job);
  }
  res.status(outcome.existing ? 200 : 201).json(shapeJob(job));
});

jobsRouter.get("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    const found = await tx.job.findFirst({ where: { id: req.params.id } });
    return reapIfStale(tx, found);
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(shapeJob(job));
});

// Latest job for a note (the app polls while the note screen is open).
jobsRouter.get("/note/:noteId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    const found = await tx.job.findFirst({
      where: { noteId: req.params.noteId },
      orderBy: { createdAt: "desc" },
    });
    return reapIfStale(tx, found);
  });
  if (!job) return res.json(null);
  res.json(shapeJob(job));
});

// Report a mistake on any AI output, saved with its source text (PRD 10).
const TARGET_TYPES = new Set(["summary", "flashcard", "quiz_question", "transcript"]);

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
