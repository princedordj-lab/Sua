/**
 * One row lock, one invariant: at most one piece of work is created for a note
 * at a time.
 *
 * Three routes create jobs — `POST /jobs`, upload completion and the note sync
 * — and every one of them used to read "is there an active job?" and then
 * create one. Two concurrent requests (a double-tapped Retry, a sync racing an
 * upload completion, two devices) both read "none" and both create: two jobs,
 * two model spends, two notifications, two writers racing over the same
 * flashcards.
 *
 * A unique partial index would be the database-level answer, but the queue also
 * allows a *failed* job to be replaced, and staleness is time-based — a
 * constraint cannot express either without a backfill and a new column. Taking
 * a row lock on the note first turns the read-then-create into a serialised
 * read-then-create: the second transaction blocks until the first commits and
 * then sees the job the first one created.
 *
 * The query is written by hand because Prisma has no `FOR UPDATE` in its query
 * builder. It carries the owner predicate so it still works the day the
 * database role stops bypassing row-level security.
 */

/**
 * Lock one note for the rest of the caller's transaction.
 *
 * @returns {Promise<boolean>} false when the note does not exist (under lock)
 */
export async function lockNote(tx, noteId, userId) {
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "notes"
    WHERE "id" = ${noteId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  return Array.isArray(rows) && rows.length > 0;
}
