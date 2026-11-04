import { Router } from "express";
import { flushStorageDeletes, purgeNoteRows } from "../lib/note-deletion.js";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import {
  needsResubmit,
  notesAwaitingConversion,
  retryProcessing,
  startProcessing,
  triggerAssetExtraction,
} from "../lib/processing/start.js";

export const notesRouter = Router();

const NOTE_KINDS = new Set(["note", "reference"]);

// The asset projection every note read serves, and the include that carries it.
// Three routes need the same shape (course pull, single note, sync conflicts),
// and they all read it inside a transaction where each statement is a WAN round
// trip. `previewFeatures = ["relationJoins"]` in schema.prisma is what keeps
// this to one statement — the per-query `relationLoadStrategy` arg does not
// exist without that flag, and a client generated without it rejects the query
// with PrismaClientValidationError.
const assetSelect = {
  id: true,
  bytes: true,
  format: true,
  status: true,
  extractState: true,
  pagesDone: true,
  pagesTotal: true,
  truncated: true,
};
const noteInclude = {
  assets: { select: assetSelect, orderBy: { createdAt: "asc" } },
};
// Changes per transaction in /sync. A queued-up student can push the 100-change
// cap, and each change is a write; with `timeout: 15000` on `withUser` the batch
// has to fit in that budget of round trips, not in a row limit.
const SYNC_CHUNK_CHANGES = 25;

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

// The mobile hydration burst pulls every course the account has, so without
// `since` this is a full re-download of bodies *and* transcripts (the whole
// library is megabytes) on one wide fan-out. Each pull holds a pooled connection
// for its whole interactive transaction — long enough for Prisma to expire the
// commit and answer P2028. `since` narrows the read to what moved.
//
// `serverTime` is the watermark the device stores for its next pass, read from
// the server's clock and taken *before* the select: a note's `updatedAt` can be a
// device clock (`/sync` accepts the client's timestamp), so a client must never
// compare its own clock against stored rows.
notesRouter.get("/course/:courseId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const sinceRaw = typeof req.query?.since === "string" ? req.query.since : "";
  const sinceDate = sinceRaw ? new Date(sinceRaw) : null;
  if (sinceRaw && Number.isNaN(sinceDate.getTime())) {
    return res.status(400).json({ error: "invalid since" });
  }
  const serverTime = new Date();
  const notes = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.note.findMany({
      where: {
        userId: user.id,
        courseId: req.params.courseId,
        ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      include: noteInclude,
    });
  });
  res.json({ notes: notes.map(shapeNote), serverTime });
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
  const loaded = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const note = await tx.note.findFirst({
      where: { id: req.params.noteId, userId: user.id },
      include: noteInclude,
    });
    if (!note) return null;
    // A note view is also a resume signal for long jobs, not just extraction.
    const latestJob = await tx.job.findFirst({
      where: { noteId: note.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, state: true, lockedUntil: true },
    });
    return { note, latestJob };
  });
  const note = loaded?.note ?? null;
  if (!note) return res.status(404).json({ error: "Note not found" });
  // Opportunistic resume for uploads without a generation job: a provider
  // parse parked as pending is continued by the next note read. The claim
  // gate keeps this from polling the provider more often than its backoff.
  const stuck = note.assets?.find(
    (asset) =>
      asset.status === "active" &&
      ["pending", "partial"].includes(asset.extractState ?? "none"),
  );
  if (stuck) {
    triggerAssetExtraction(stuck.id).catch(() => {});
  }
  // Repair (never duplicate) a generation whose Trigger.dev submission never
  // landed: Trigger.dev's idempotency key makes a re-submit the same run.
  const latest = loaded.latestJob;
  if (latest && needsResubmit(latest)) {
    retryProcessing(latest).catch(() => {});
  }
  res.json(shapeNote(note));
});

// A student who wrote offline can push the whole 100-change queue in one
// request, and every change is at least one write. Inside `withUser` that is a
// budget of WAN round trips, not of rows, so the queue is committed in chunks:
// each change still resolves exactly as before because a retried chunk is a
// no-op — the timestamp guard rejects only *strictly* older writes, so an
// already-accepted change falls through the same branch, and deletes are
// idempotent (`skipDuplicates` tombstone + `deleteMany`).
notesRouter.post("/sync", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  if (changes.length > 100) return res.status(400).json({ error: "Too many changes" });

  // `authenticate` already read this row, and it is needed by every chunk, so
  // the transactional fallback happens once here rather than once per chunk.
  const user =
    identity.user ??
    (await withUser(identity.clerkId, (tx) => requireUser(tx, identity)));

  const notes = [];
  const results = [];
  // Storage deletes are external I/O, so the keys are collected and flushed
  // after every transaction (withUser caps a transaction at 15 s).
  const storageKeys = [];

  for (let start = 0; start < changes.length; start += SYNC_CHUNK_CHANGES) {
    const chunk = changes.slice(start, start + SYNC_CHUNK_CHANGES);
    const outcome = await withUser(identity.clerkId, async (tx) => {
      const chunkNotes = [];
      const chunkResults = [];
      const chunkStorageKeys = [];

      const ids = chunk
        .map((change) => (typeof change?.id === "string" ? change.id : ""))
        .filter(Boolean);
      const courseIds = [
        ...new Set(
          chunk
            .map((change) =>
              typeof change?.courseId === "string" ? change.courseId : "",
            )
            .filter(Boolean),
        ),
      ];
      // Three batched reads replace the per-change lookups a full queue would
      // otherwise pay for. They are pre-reads, not a stale cache: the maps are
      // updated as the loop writes, so a later change in this chunk still sees
      // a tombstone or note row this transaction has just created.
      const tombstoneOwners = new Map(
        (
          await tx.noteTombstone.findMany({
            where: { id: { in: ids } },
            select: { id: true, userId: true },
          })
        ).map((row) => [row.id, row.userId]),
      );
      const existingById = new Map(
        (await tx.note.findMany({ where: { id: { in: ids } } })).map(
          (row) => [row.id, row],
        ),
      );
      const ownedCourses = new Set(
        (
          await tx.course.findMany({
            where: { userId: user.id, id: { in: courseIds } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );

      // Deferred to one `purgeNoteRows` per chunk: the tombstone above is what
      // guards the id against being recreated, and it is written in order, so
      // the rows themselves can go at commit time.
      const purgeIds = [];

      for (const change of chunk) {
        if (!change?.id) {
          chunkResults.push({ id: "", status: "rejected", reason: "missing id" });
          continue;
        }
        if (change.operation === "delete") {
          if (tombstoneOwners.has(change.id) && tombstoneOwners.get(change.id) !== user.id) {
            chunkResults.push({ id: change.id, status: "rejected", reason: "id not available" });
            continue;
          }
          const owned = existingById.get(change.id);
          if (owned && owned.userId !== user.id) {
            chunkResults.push({ id: change.id, status: "rejected", reason: "id not available" });
            continue;
          }
          // Record the deletion before touching the note. A concurrent upsert
          // that lands after this transaction must find the tombstone, not a
          // free id it can recreate the note under.
          await tx.noteTombstone.createMany({
            data: [{ id: change.id, userId: user.id }],
            skipDuplicates: true,
          });
          tombstoneOwners.set(change.id, user.id);
          existingById.delete(change.id);
          purgeIds.push(change.id);
          // Idempotent: deleting a note that is already gone still succeeds.
          chunkResults.push({ id: change.id, status: "accepted" });
          continue;
        }
        // A tombstoned id can never come back. Tell the device so it removes its
        // copy instead of retrying the upsert forever.
        if (tombstoneOwners.has(change.id)) {
          chunkResults.push({ id: change.id, status: "deleted" });
          continue;
        }
        if (!change.courseId || typeof change.title !== "string" || typeof change.body !== "string") {
          chunkResults.push({ id: change.id, status: "rejected", reason: "invalid payload" });
          continue;
        }
        if (!ownedCourses.has(change.courseId)) {
          chunkResults.push({ id: change.id, status: "rejected", reason: "course not found" });
          continue;
        }
        const existing = existingById.get(change.id);
        if (existing && existing.userId !== user.id) {
          chunkResults.push({ id: change.id, status: "rejected", reason: "id not available" });
          continue;
        }
        const parsedUpdatedAt = change.updatedAt ? new Date(change.updatedAt) : null;
        if (parsedUpdatedAt && Number.isNaN(parsedUpdatedAt.getTime())) {
          chunkResults.push({ id: change.id, status: "rejected", reason: "invalid updatedAt" });
          continue;
        }
        // Timestamp guard: reject a write that is older than what the server
        // already holds and hand the newer copy back so the device can adopt it.
        if (
          existing &&
          parsedUpdatedAt &&
          parsedUpdatedAt.getTime() < existing.updatedAt.getTime()
        ) {
          chunkResults.push({ id: change.id, status: "conflict", note: shapeNote(existing) });
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
        existingById.set(change.id, note);
        chunkNotes.push(note);
        chunkResults.push({ id: change.id, status: "accepted" });
      }

      if (purgeIds.length) {
        chunkStorageKeys.push(
          ...(await purgeNoteRows(tx, { userId: user.id, noteIds: purgeIds })),
        );
      }

      return { notes: chunkNotes, results: chunkResults, storageKeys: chunkStorageKeys };
    });
    notes.push(...outcome.notes);
    results.push(...outcome.results);
    storageKeys.push(...outcome.storageKeys);
  }

  res.json({ notes: notes.map(shapeNote), results });

  // Storage cleanup for deleted notes, outside the transaction. Failures are
  // queued for the janitor instead of being lost with the asset row.
  await flushStorageDeletes(storageKeys, user.id);

  // A pushed note may be the missing half of a conversion-marked upload that
  // landed first (the /complete route covers the reverse order). One row per
  // note + kind + processing version, so this is safe to repeat.
  const waiting = await notesAwaitingConversion(
    identity.clerkId,
    notes.map((note) => note.id),
  ).catch((error) => {
    console.warn("Conversion lookup failed:", error?.message ?? error);
    return [];
  });
  for (const target of waiting) {
    await startProcessing(target).catch((error) => {
      console.warn(`processing start failed for note ${target.noteId}: ${error?.message ?? error}`);
    });
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
      // Retired cards are the ones the student deleted. This pull is what a
      // device rebuilds its local deck from, so leaking them would resurrect a
      // deleted card on every re-pull.
      where: { noteId: note.id, retiredAt: null },
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
