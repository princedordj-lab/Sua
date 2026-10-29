import { prisma } from "../config/prisma.js";
import { deleteAssetObject } from "./storage.js";

const PENDING_PUBLIC_ID = "pending";

/** Object keys that belong to these notes, collected before the rows go. */
async function storageKeysFor(tx, { userId, noteIds }) {
  if (!noteIds.length) return [];
  const assets = await tx.asset.findMany({
    where: { noteId: { in: noteIds }, userId },
    select: { storageProvider: true, publicId: true, resourceType: true },
  });
  return assets
    .filter((asset) => asset.publicId && asset.publicId !== PENDING_PUBLIC_ID)
    .map((asset) => ({
      provider: asset.storageProvider ?? "cloudinary",
      publicId: asset.publicId,
      resourceType: asset.resourceType ?? "raw",
    }));
}

// Provenance is cosmetic; a whole-course delete must not spend its 15 s
// transaction budget on hundreds of array rewrites.
const CHAT_SCRUB_LIMIT = 100;

/** Ask Sua messages keep their text but lose the pointer to a deleted note. */
async function scrubChatProvenance(tx, { userId, noteIds }) {
  for (const noteId of noteIds.slice(0, CHAT_SCRUB_LIMIT)) {
    await tx.$executeRaw`
      UPDATE "chat_messages"
      SET "sourceNoteIds" = array_remove("sourceNoteIds", ${noteId})
      WHERE "userId" = ${userId} AND ${noteId} = ANY("sourceNoteIds")
    `;
  }
}

/**
 * Delete everything Postgres owns for these notes, inside the caller's
 * withUser transaction. Children cascade from the note row
 * (jobs -> ai_calls, flashcards -> review_logs, quizzes -> questions/attempts,
 * assets -> source_chunks). Returns storage keys that still need deleting —
 * object I/O must happen after the transaction commits.
 */
export async function purgeNoteRows(tx, { userId, noteIds }) {
  if (!noteIds.length) return [];
  const keys = await storageKeysFor(tx, { userId, noteIds });
  // Feedback stores a copy of the source text, so it must not outlive the note.
  await tx.feedback.deleteMany({ where: { noteId: { in: noteIds }, userId } });
  await scrubChatProvenance(tx, { userId, noteIds });
  await tx.note.deleteMany({ where: { id: { in: noteIds }, userId } });
  return keys;
}

const RETRY_BACKOFF_MS = [60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const STORAGE_DELETE_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

/**
 * Delete the objects behind the returned keys. A failure is recorded so the
 * tick janitor can retry; the asset row is already gone, so this is the only
 * remaining pointer to the bytes.
 */
export async function flushStorageDeletes(keys, userId) {
  for (const key of keys) {
    try {
      await deleteAssetObject({
        publicId: key.publicId,
        storageProvider: key.provider,
        resourceType: key.resourceType,
      });
    } catch (error) {
      console.warn(`Storage object delete failed for asset ${key.publicId}:`, error?.message ?? error);
      await prisma.storageDeletion
        .create({
          data: {
            userId,
            provider: key.provider,
            publicId: key.publicId,
            resourceType: key.resourceType,
            lastError: String(error?.code ?? error?.message ?? "unknown").slice(0, 200),
          },
        })
        .catch((queueError) => {
          console.error("Could not queue storage deletion:", queueError?.message ?? queueError);
        });
    }
  }
}

/** Called by the tick janitor: retry queued object deletes with backoff. */
export async function retryStorageDeletions({ limit = 20 } = {}) {
  const rows = await prisma.storageDeletion.findMany({
    where: {
      nextAttemptAt: { lte: new Date() },
      attempts: { lt: STORAGE_DELETE_MAX_ATTEMPTS },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deleteAssetObject({
        publicId: row.publicId,
        storageProvider: row.provider,
        resourceType: row.resourceType,
      });
      await prisma.storageDeletion.delete({ where: { id: row.id } }).catch(() => {});
      deleted += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
      await prisma.storageDeletion
        .update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: String(error?.code ?? error?.message ?? "unknown").slice(0, 200),
            nextAttemptAt: new Date(Date.now() + delay),
          },
        })
        .catch(() => {});
      failed += 1;
    }
  }
  return { retried: rows.length, deleted, failed };
}

/**
 * A device offline longer than the retention window must resync from scratch;
 * keeping tombstones forever would grow the table for no sync benefit.
 */
export async function pruneNoteTombstones({ olderThanDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await prisma.noteTombstone.deleteMany({
    where: { deletedAt: { lt: cutoff } },
  });
  return result.count;
}
