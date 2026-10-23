import { Router } from "express";
import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";
import { maybeEnqueueGeneration } from "../lib/pipeline.js";

export const notesRouter = Router();

const NOTE_KINDS = new Set(["note", "reference"]);

function shapeNote(note) {
  return {
    id: note.id,
    courseId: note.courseId,
    title: note.title,
    body: note.body,
    sourceType: note.sourceType,
    aiState: note.aiState,
    transcript: note.transcript,
    summary: note.summary,
    noteKind: note.noteKind ?? "note",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

notesRouter.get("/course/:courseId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const notes = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.note.findMany({
      where: { userId: user.id, courseId: req.params.courseId },
      orderBy: { updatedAt: "desc" },
    });
  });
  res.json(notes.map(shapeNote));
});

notesRouter.post("/sync", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  if (changes.length > 100) return res.status(400).json({ error: "Too many changes" });

  const { notes, results } = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const notes = [];
    const results = [];
    for (const change of changes) {
      if (!change?.id) {
        results.push({ id: "", status: "rejected", reason: "missing id" });
        continue;
      }
      if (change.operation === "delete") {
        const assets = await tx.asset.findMany({
          where: { noteId: change.id, userId: user.id },
        });
        for (const asset of assets) {
          if (cloudinaryConfigured() && asset.publicId && asset.publicId !== "pending") {
            try {
              await cloudinary.uploader.destroy(asset.publicId, {
                resource_type: asset.resourceType,
              });
            } catch (err) {
              console.warn(`Cloudinary destroy failed for asset ${asset.publicId}:`, err);
            }
          }
        }
        await tx.asset.deleteMany({ where: { noteId: change.id, userId: user.id } });
        await tx.note.deleteMany({ where: { id: change.id, userId: user.id } });
        // Idempotent: deleting a note that is already gone still succeeds.
        results.push({ id: change.id, status: "accepted" });
        continue;
      }
      if (!change.courseId || typeof change.title !== "string" || typeof change.body !== "string") {
        results.push({ id: change.id, status: "rejected", reason: "invalid payload" });
        continue;
      }
      const course = await tx.course.findFirst({ where: { id: change.courseId, userId: user.id } });
      if (!course) {
        results.push({ id: change.id, status: "rejected", reason: "course not found" });
        continue;
      }
      const existing = await tx.note.findUnique({ where: { id: change.id } });
      if (existing && existing.userId !== user.id) {
        results.push({ id: change.id, status: "rejected", reason: "id not available" });
        continue;
      }
      const parsedUpdatedAt = change.updatedAt ? new Date(change.updatedAt) : null;
      if (parsedUpdatedAt && Number.isNaN(parsedUpdatedAt.getTime())) {
        results.push({ id: change.id, status: "rejected", reason: "invalid updatedAt" });
        continue;
      }
      // Timestamp guard: reject a write that is older than what the server
      // already holds and hand the newer copy back so the device can adopt it.
      if (
        existing &&
        parsedUpdatedAt &&
        parsedUpdatedAt.getTime() < existing.updatedAt.getTime()
      ) {
        results.push({ id: change.id, status: "conflict", note: shapeNote(existing) });
        continue;
      }
      const data = {
        courseId: change.courseId,
        title: change.title,
        body: change.body,
        sourceType: change.sourceType || "typed",
        // A reference stays a reference across edits; new notes default plain.
        noteKind: NOTE_KINDS.has(change.noteKind)
          ? change.noteKind
          : existing?.noteKind ?? "note",
        ...(parsedUpdatedAt ? { updatedAt: parsedUpdatedAt } : {}),
      };
      const note = existing
        ? await tx.note.update({ where: { id: existing.id }, data })
        : await tx.note.create({
            data: { id: change.id, userId: user.id, ...data },
          });
      notes.push(note);
      results.push({ id: change.id, status: "accepted" });
    }
    return { notes, results };
  });
  res.json({ notes: notes.map(shapeNote), results });

  // A pushed note may be the missing half of a conversion-marked upload that
  // landed first (the /complete route covers the reverse order). Idempotent.
  for (const note of notes) {
    try {
      await maybeEnqueueGeneration(identity.clerkId, note.id);
    } catch (error) {
      console.warn(
        `Generation enqueue failed for note ${note.id}:`,
        error?.message ?? error,
      );
    }
  }
});

// Everything the pipeline generated for one note. The client caches this into
// its local study tables after a generation job completes (or offline pull).
notesRouter.get("/:noteId/study", async (req, res) => {
  const identity = await identityFromRequest(req);
  const study = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const note = await tx.note.findFirst({
      where: { id: req.params.noteId, userId: user.id },
    });
    if (!note) return null;
    const flashcards = await tx.flashcard.findMany({
      where: { noteId: note.id },
      orderBy: { createdAt: "asc" },
    });
    const quizzes = await tx.quiz.findMany({
      where: { noteId: note.id },
      include: { questions: { orderBy: { ordinal: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      summaryMarkdown: note.summary ?? "",
      flashcards: flashcards.map((card) => ({
        id: card.id,
        front: card.front,
        back: card.back,
        dueAt: card.dueAt,
        ease: card.ease,
        intervalDays: card.intervalDays,
        reps: card.reps,
      })),
      quizzes: quizzes.map((quiz) => ({
        id: quiz.id,
        noteId: quiz.noteId,
        title: quiz.title,
        questions: quiz.questions.map((question) => ({
          id: question.id,
          quizId: question.quizId,
          ordinal: question.ordinal,
          type: question.type,
          prompt: question.prompt,
          options: question.options,
          answer: question.answer,
          explanation: question.explanation,
        })),
      })),
    };
  });
  if (!study) return res.status(404).json({ error: "Note not found" });
  res.json(study);
});
