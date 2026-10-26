import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";
import { aiConfigured } from "../lib/ai.js";
import { studyQueueConfigured, enqueueStudyJob } from "../lib/queue.js";
import { warnIfOverCaps } from "../lib/pipeline.js";

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
    const user = await ensureUser(tx, identity);
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
    });
    // A differently-destinationed request while one is running wins nothing:
    // the active job still owns the note until it settles.
    if (active) return { existing: active };
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
    (await withUser(identity.clerkId, (tx) => ensureUser(tx, identity))).id,
  );
  if (warning) console.warn(`[CAP WARNING] ${identity.email}: ${warning}`);

  try {
    await enqueueStudyJob(job.id);
  } catch (error) {
    // The row exists; the drain can retry the enqueue, so keep 201 semantics.
    console.warn(`enqueue failed for job ${job.id}: ${error?.message ?? error}`);
  }
  res.status(outcome.existing ? 200 : 201).json(shapeJob(job));
});

jobsRouter.get("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await ensureUser(tx, identity);
    return tx.job.findFirst({ where: { id: req.params.id } });
  });
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(shapeJob(job));
});

// Latest job for a note (the app polls while the note screen is open).
jobsRouter.get("/note/:noteId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const job = await withUser(identity.clerkId, async (tx) => {
    await ensureUser(tx, identity);
    return tx.job.findFirst({
      where: { noteId: req.params.noteId },
      orderBy: { createdAt: "desc" },
    });
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
    const user = await ensureUser(tx, identity);
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
