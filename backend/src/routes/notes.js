import { Router } from "express";
import { flushStorageDeletes, purgeNoteRows } from "../lib/note-deletion.js";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
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
    // Long-file provenance (additive): split-group display and page progress.
    groupId: note.groupId ?? null,
    partIndex: note.partIndex ?? null,
    sourceAssetId: note.sourceAssetId ?? null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    assets: note.assets?.map((asset) => ({
      id: asset.id,
      bytes: asset.bytes,
      format: asset.format,
      status: asset.status,
      extractState: asset.extractState ?? "none",
      pagesDone: asset.pagesDone ?? 0,
      pagesTotal: asset.pagesTotal ?? 0,
      truncated: asset.truncated ?? false,
    })),
  };
}

notesRouter.get("/course/:courseId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const notes = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.note.findMany({
      where: { userId: user.id, courseId: req.params.courseId },
      orderBy: { updatedAt: "desc" },
      include: {
        assets: {
          select: {
            id: true,
            bytes: true,
            format: true,
            status: true,
            extractState: true,
            pagesDone: true,
            pagesTotal: true,
            truncated: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  });
  res.json(notes.map(shapeNote));
});

// Deletions another device must learn about: without this a note deleted on
// one device simply disappears from the course list, and every other device
// keeps its cached copy forever. User-scoped, ordered by (deletedAt, id) so a
// batch of deletes created in one transaction pages without skipping ids.
notesRouter.get("/tombstones", async (req, res) => {
  const identity = await identityFromRequest(req);
  const sinceRaw = typeof req.query?.since === "string" ? req.query.since : "";
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: "invalid since" });
  }
  const afterId = typeof req.query?.after === "string" ? req.query.after : "";
  const limit = Math.min(1000, Math.max(1, Number(req.query?.limit ?? 500) || 500));
  const deleted = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.noteTombstone.findMany({
      where: {
        userId: user.id,
        ...(since
          ? {
              OR: [
                { deletedAt: { gt: since } },
                ...(afterId ? [{ deletedAt: since, id: { gt: afterId } }] : []),
              ],
            }
          : {}),
      },
      orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, deletedAt: true },
    });
  });
  const last = deleted[deleted.length - 1];
  res.json({
    deleted,
    cursor: last ? { deletedAt: last.deletedAt, id: last.id } : null,
  });
});

// Single note by id — the web viewer is link-addressed (/app/note/:id) and has
// no local SQLite row to read from, so deep links need this lookup.
notesRouter.get("/:noteId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const note = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.note.findFirst({
      where: { id: req.params.noteId, userId: user.id },
      include: {
        assets: {
          select: {
            id: true,
            bytes: true,
            format: true,
            status: true,
            extractState: true,
            pagesDone: true,
            pagesTotal: true,
            truncated: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  });
  if (!note) return res.status(404).json({ error: "Note not found" });
  res.json(shapeNote(note));
});

notesRouter.post("/sync", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  if (changes.length > 100) return res.status(400).json({ error: "Too many changes" });

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const notes = [];
    const results = [];
    // Storage deletes are external I/O, so the keys are returned and deleted
    // after the transaction (withUser caps a transaction at 15 s).
    const storageKeys = [];
    for (const change of changes) {
      if (!change?.id) {
        results.push({ id: "", status: "rejected", reason: "missing id" });
        continue;
      }
      if (change.operation === "delete") {
        const tombstone = await tx.noteTombstone.findUnique({
          where: { id: change.id },
          select: { userId: true },
        });
        if (tombstone && tombstone.userId !== user.id) {
          results.push({ id: change.id, status: "rejected", reason: "id not available" });
          continue;
        }
        const owned = await tx.note.findUnique({
          where: { id: change.id },
          select: { userId: true },
        });
        if (owned && owned.userId !== user.id) {
          results.push({ id: change.id, status: "rejected", reason: "id not available" });
          continue;
        }
        // Record the deletion before touching the note. A concurrent upsert
        // that lands after this transaction must find the tombstone, not a
        // free id it can recreate the note under.
        await tx.noteTombstone.createMany({
          data: [{ id: change.id, userId: user.id }],
          skipDuplicates: true,
        });
        storageKeys.push(...(await purgeNoteRows(tx, { userId: user.id, noteIds: [change.id] })));
        // Idempotent: deleting a note that is already gone still succeeds.
        results.push({ id: change.id, status: "accepted" });
        continue;
      }
      // A tombstoned id can never come back. Tell the device so it removes its
      // copy instead of retrying the upsert forever.
      const tombstone = await tx.noteTombstone.findUnique({
        where: { id: change.id },
        select: { userId: true },
      });
      if (tombstone) {
        results.push({ id: change.id, status: "deleted" });
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
      // A device that has not received the AI-written body yet pushes an empty
      // one with a fresh timestamp. Accepting it would wipe the note the student
      // can already read, so empty incoming text never replaces stored text.
      const incomingBody = change.body;
      const keepStoredBody =
        !incomingBody.trim() && Boolean((existing?.body ?? "").trim());
      const data = {
        courseId: change.courseId,
        title: change.title,
        body: keepStoredBody ? existing.body : incomingBody,
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
    return { notes, results, userId: user.id, storageKeys };
  });
  res.json({ notes: outcome.notes.map(shapeNote), results: outcome.results });

  // Storage cleanup for deleted notes, outside the transaction. Failures are
  // queued for the janitor instead of being lost with the asset row.
  await flushStorageDeletes(outcome.storageKeys, outcome.userId);

  // A pushed note may be the missing half of a conversion-marked upload that
  // landed first (the /complete route covers the reverse order). Idempotent.
  for (const note of outcome.notes) {
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
    const user = await requireUser(tx, identity);
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
