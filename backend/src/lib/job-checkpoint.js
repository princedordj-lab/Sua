/**
 * Durable writes to the single `Job.checkpoint` JSONB column.
 *
 * Every long-file stage shares that one column, so a write owns a *path* and
 * nothing else: whole-key patches merge one level deep with `||`, and one
 * merge result is written with `jsonb_set` on ARRAY[parent, key]. Both run as a
 * single statement, so concurrent writers cannot lose each other's keys through
 * a read-modify-write race.
 *
 * Two rules this module exists to enforce:
 *
 * 1. A failed checkpoint write is an ERROR, never a warning. Work that is not
 *    on the row is not finished work; swallowing the failure let the reduce
 *    stage believe a wave was saved, spend the pass's remaining budget on the
 *    next level, and then repay the same wave on every later pass — which is
 *    what left long documents yielding at "Combining" forever.
 * 2. Path writes are first-write-wins (`WHERE <path> IS NULL`). A slower
 *    attempt resuming from an older snapshot therefore cannot overwrite a newer
 *    value another attempt already persisted; it adopts what the row holds.
 *
 * Logs carry job ids, paths and error classes only — never source text.
 */

import { prisma } from "../config/prisma.js";

export class CheckpointWriteError extends Error {
  constructor(message, { jobId = null, path = null, attempts = null, cause = null } = {}) {
    super(message);
    this.name = "CheckpointWriteError";
    // The runner treats a checkpoint write as transient (bounded retries, then
    // a real failure) instead of "the AI said something wrong".
    this.kind = "checkpoint_write";
    this.retryable = true;
    this.jobId = jobId;
    this.path = path;
    this.attempts = attempts;
    this.cause = cause;
  }
}

const WRITE_ATTEMPTS = 3;
const WRITE_BACKOFF_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** jsonb comes back parsed from pg; keep the string form working too. */
function fromJsonb(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Harnesses and tests replace the database with an in-memory store. The store
 * implements exactly the operations below, so a test can make a write fail,
 * reorder two attempts, or inspect what was persisted without Postgres.
 *
 *   merge(jobId, patch, progressIncrement)  -> void
 *   writeEntry(jobId, parent, key, value)   -> { stored, value }
 *   read(jobId)                             -> checkpoint object | null
 */
let store = null;

export function setCheckpointStore(next) {
  store = next;
}

export function checkpointStore() {
  return store;
}


// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function withRetries(jobId, path, operation) {
  let last = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // A deleted job row can never be written; retrying is pointless.
      if (error?.code === "P2025") throw error;
      last = error;
      if (attempt < WRITE_ATTEMPTS) await sleep(WRITE_BACKOFF_MS * attempt);
    }
  }
  const error = new CheckpointWriteError(
    `checkpoint write failed for ${path || "job"} after ${WRITE_ATTEMPTS} attempts: ${last?.message ?? last}`,
    { jobId, path, attempts: WRITE_ATTEMPTS, cause: last },
  );
  error.code = last?.code;
  throw error;
}

/**
 * Merge top-level checkpoint keys (Postgres `||`: the whole value of each key
 * you pass replaces whatever was there, other keys survive untouched).
 */
export async function mergeCheckpointKeys(jobId, patch, { progressIncrement = 0 } = {}) {
  if (!jobId) throw new CheckpointWriteError("checkpoint write without a job id", { path: "job" });
  if (store) {
    await withRetries(jobId, Object.keys(patch ?? {}).join(","), () =>
      store.merge(jobId, patch, progressIncrement),
    );
    return;
  }
  const increment = Math.max(0, Math.round(progressIncrement));
  const written = await withRetries(jobId, Object.keys(patch ?? {}).join(","), () =>
    prisma.$executeRaw`
      UPDATE "jobs"
      SET "checkpoint" = COALESCE("checkpoint", '{}'::jsonb) || ${JSON.stringify(patch ?? {})}::jsonb,
          "progressDone" = "progressDone" + ${increment},
          "heartbeatAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "id" = ${jobId}
    `,
  );
  // Zero rows means the job row is gone (deleted or cancelled). That is not a
  // write failure — the pipeline's own liveness check closes the job — but it
  // must be visible in the log instead of looking like a saved checkpoint.
  if (Number(written) === 0) {
    console.warn(
      `[checkpoint] no job row for ${jobId}; patch ${Object.keys(patch ?? {}).join(",")} not stored`,
    );
  }
}


/**
 * Write one entry under `checkpoint[parent][key]` and report what the row now
 * holds. Returns `{ stored: false, value }` when a value was already there:
 * the caller must use the row's value, not its own, so two attempts can never
 * disagree about a finished merge.
 */
export async function writeCheckpointEntry(jobId, parent, key, value) {
  if (!jobId) throw new CheckpointWriteError("checkpoint entry without a job id", { path: parent });
  const path = `${parent}.${key}`;
  if (store) {
    return withRetries(jobId, path, () => store.writeEntry(jobId, parent, key, value));
  }
  const valueJson = JSON.stringify(value);
  const written = await withRetries(jobId, path, () =>
    prisma.$queryRaw`
      UPDATE "jobs"
      SET "checkpoint" = jsonb_set(
            COALESCE("checkpoint", '{}'::jsonb)
              || jsonb_build_object(
                   ${parent}::text,
                   COALESCE(jsonb_extract_path("checkpoint", ${parent}::text), '{}'::jsonb)
                 ),
            ARRAY[${parent}::text, ${key}::text],
            ${valueJson}::jsonb,
            true
          ),
          "heartbeatAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "id" = ${jobId}
        AND jsonb_extract_path("checkpoint", ${parent}::text, ${key}::text) IS NULL
      RETURNING jsonb_extract_path("checkpoint", ${parent}::text, ${key}::text) AS "value"
    `,
  );
  const saved = Array.isArray(written) ? written[0] : null;
  if (saved) return { stored: true, value: fromJsonb(saved.value) ?? value };

  // Nothing was updated: either another attempt already stored this entry (use
  // its value) or the job row is gone (a cancelled or deleted job).
  const rows = await withRetries(jobId, path, () =>
    prisma.$queryRaw`
      SELECT jsonb_extract_path("checkpoint", ${parent}::text, ${key}::text) AS "value"
      FROM "jobs"
      WHERE "id" = ${jobId}
    `,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    throw new CheckpointWriteError(`job ${jobId} is gone; checkpoint entry not written`, {
      jobId,
      path,
    });
  }
  if (row.value == null) {
    throw new CheckpointWriteError(`checkpoint entry ${path} did not persist for job ${jobId}`, {
      jobId,
      path,
    });
  }
  return { stored: false, value: fromJsonb(row.value) };
}

/** Current checkpoint of a job (used to adopt whatever another attempt saved). */
export async function readJobCheckpoint(jobId) {
  if (!jobId) return null;
  if (store) return store.read(jobId);
  const row = await prisma.job
    .findUnique({ where: { id: jobId }, select: { checkpoint: true } })
    .catch(() => null);
  return row?.checkpoint ?? null;
}
