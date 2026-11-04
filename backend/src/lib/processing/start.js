/**
 * Starting (and re-starting) document processing from the API.
 *
 * The API does not process anything: it writes the processing row, triggers one
 * Trigger.dev run and returns. Two boundaries are handled explicitly because a
 * database write and a Trigger.dev API call are NOT atomic:
 *
 *  1. Row written, trigger failed → the row stays with triggerState "failed".
 *     The document is not lost; `POST /api/jobs/:id/retry` (or a repeated
 *     `/complete`) re-submits it.
 *  2. Trigger succeeded, saving the run id failed → the run itself adopts its
 *     own id at start (`adoptRunId`), and the duplicate trigger a retry would
 *     send is deduplicated by Trigger.dev's idempotency key (one key per
 *     document + kind + processing version). No second queue, no second run.
 */

import { prisma } from "../../config/prisma.js";
import { withUser } from "../db.js";
import { aiConfigured } from "../ai.js";
import { hasSettledKind } from "../job-dedupe.js";
import {
  MATERIAL_STATES,
  PROCESSING_STATES,
  markTrigger,
  materialStates,
  resetMaterials,
} from "./state.js";

/** Pipeline revision. Bump it to force every note to be rebuilt once. */
export const PROCESSING_VERSION = "v1";
export const PROCESS_DOCUMENT_TASK = "process-document";
export const IDEMPOTENCY_TTL = "1h";

// Test seam: the offline harness supplies a fake Trigger.dev client.
let triggerClient = null;
export function setTriggerClient(client) {
  triggerClient = client;
}

export function processingConfigured() {
  return Boolean(process.env.DATABASE_URL && aiConfigured() && process.env.TRIGGER_SECRET_KEY);
}

async function client() {
  if (triggerClient) return triggerClient;
  const { tasks } = await import("@trigger.dev/sdk");
  return {
    trigger: (taskId, payload, options) => tasks.trigger(taskId, payload, options),
    cancel: async (runId) => {
      const { runs } = await import("@trigger.dev/sdk");
      return runs.cancel(runId);
    },
  };
}

/** One stable key per document + kind + processing version. */
export function idempotencyKeyFor({ noteId, kind, processingVersion = PROCESSING_VERSION }) {
  return `sua:process:${noteId}:${kind}:${processingVersion}`;
}

/**
 * Find or create the processing row for this note/kind/version.
 * The unique `idempotencyKey` makes concurrent /complete calls collapse onto
 * one row instead of two runs.
 */
export async function ensureProcessingJob(
  { noteId, userId, kind, processingVersion = PROCESSING_VERSION },
  db = prisma,
) {
  const idempotencyKey = idempotencyKeyFor({ noteId, kind, processingVersion });
  const existing = await db.job.findUnique({ where: { idempotencyKey } });
  if (existing) return { job: existing, created: false };
  try {
    const created = await db.job.create({
      data: {
        userId,
        noteId,
        kind,
        state: "queued",
        stage: "queued",
        processingVersion,
        processingState: PROCESSING_STATES.queued,
        triggerState: "none",
        idempotencyKey,
        materials: {},
      },
    });
    return { job: created, created: true };
  } catch (error) {
    // Lost the create race: the other request's row is the truth.
    if (error?.code === "P2002") {
      const raced = await db.job.findUnique({ where: { idempotencyKey } });
      if (raced) return { job: raced, created: false };
    }
    throw error;
  }
}

/**
 * Trigger the orchestrator for a processing row.
 * Returns { triggered, runId, error } — never throws for a trigger failure, so
 * the endpoint can still answer 202 and expose a retry path.
 */
export async function triggerProcessing(job, { assetId = null, db = prisma } = {}) {
  const payload = {
    jobId: job.id,
    noteId: job.noteId,
    userId: job.userId,
    processingVersion: job.processingVersion ?? PROCESSING_VERSION,
    ...(assetId ? { assetId } : {}),
  };
  await markTrigger(job.id, "submitting", { db });
  try {
    const api = await client();
    const handle = await api.trigger(PROCESS_DOCUMENT_TASK, payload, {
      idempotencyKey: `${job.idempotencyKey ?? job.id}:${job.processingVersion ?? PROCESSING_VERSION}`,
      idempotencyKeyTTL: IDEMPOTENCY_TTL,
      tags: [`job:${job.id}`, `note:${job.noteId}`],
    });
    await markTrigger(job.id, "submitted", { runId: handle?.id ?? null, db }).catch(() => {});
    return { triggered: true, runId: handle?.id ?? null, error: null };
  } catch (error) {
    const message = "Sua could not start processing this file. Tap Try again.";
    console.warn(
      `[processing] trigger failed job=${job.id} code=${error?.name ?? "Error"} status=${Number.isFinite(error?.status) ? error.status : "-"}`,
    );
    await markTrigger(job.id, "failed", { error: message, db }).catch(() => {});
    return { triggered: false, runId: null, error: message };
  }
}

/**
 * Full "start this document" path used by upload-completion and POST /jobs.
 * Safe to call repeatedly: an existing submitted/running row is returned as-is.
 */
export async function startProcessing({ noteId, userId, kind, assetId = null }, db = prisma) {
  const { job, created } = await ensureProcessingJob({ noteId, userId, kind }, db);
  const alreadyRunning =
    !created &&
    (["submitting", "submitted"].includes(job.triggerState) ||
      ["extracting", "ocr_processing", "generating"].includes(job.processingState));
  if (alreadyRunning) return { job, triggered: false, runId: job.runId ?? null, reused: true };

  const result = await triggerProcessing(job, { assetId, db });
  return { job: { ...job, runId: result.runId ?? job.runId }, ...result, reused: false };
}

/**
 * Which of these notes still want a run started, and with which asset.
 *
 * The sync tail used to open one transaction per pushed note — up to 100 of
 * them, most discovering nothing to do — to answer a question that is a single
 * read. `withUser`'s budget is WAN round trips, not rows, so the whole chunk is
 * one query here and the caller only spends a Trigger.dev call on a note that
 * actually wants conversion.
 *
 * A note qualifies when an active image/document asset asks for a conversion the
 * note has not already had: `hasSettledKind` is the same rule `POST /jobs` uses,
 * so a re-sync of an old note cannot re-bill a finished study set.
 */
export async function notesAwaitingConversion(clerkId, noteIds) {
  const ids = (noteIds ?? []).filter((id) => typeof id === "string" && id);
  if (!ids.length || !processingConfigured()) return [];
  const tasks = ["lecture_note", "course_reference"];
  const rows = await withUser(clerkId, (tx) =>
    tx.note.findMany({
      where: {
        id: { in: ids },
        assets: {
          some: {
            status: "active",
            task: { in: tasks },
            kind: { in: ["image", "document"] },
          },
        },
      },
      select: {
        id: true,
        userId: true,
        assets: {
          where: { status: "active", task: { in: tasks }, kind: { in: ["image", "document"] } },
          orderBy: { createdAt: "asc" },
          select: { id: true, task: true, kind: true },
        },
        jobs: { select: { kind: true, state: true } },
      },
    }),
  );
  const wanted = [];
  for (const note of rows) {
    const asset = note.assets.find((row) => !hasSettledKind(note.jobs, row.task));
    if (!asset) continue;
    wanted.push({
      noteId: note.id,
      userId: note.userId,
      kind: asset.task,
      // Only a document carries its own extraction run; a photo is read whole
      // by the generation stage.
      assetId: asset.kind === "document" ? asset.id : null,
    });
  }
  return wanted;
}

/**
 * Retry a failed document (or one material of it).
 *
 * Completed materials are kept: only the failed/pending ones re-run, which is
 * what makes "retry the quiz" cheap and keeps finished notes, summaries and
 * cards intact when a later stage dies.
 */
export async function retryProcessing(jobOrId, { material = null } = {}, db = prisma) {
  const job =
    typeof jobOrId === "string" ? await db.job.findUnique({ where: { id: jobOrId } }) : jobOrId;
  if (!job) return null;

  const next = resetMaterials(job, { only: material });
  const kept = Object.entries(next)
    .filter(([, value]) => value.state === MATERIAL_STATES.done)
    .map(([name]) => name);
  const note = await db.note.findUnique({
    where: { id: job.noteId },
    select: {
      id: true,
      assets: { where: { status: "active", kind: "document" }, select: { id: true } },
    },
  });
  if (!note) return null;

  await db.job.update({
    where: { id: job.id },
    data: {
      state: "queued",
      stage: "queued",
      processingState: PROCESSING_STATES.queued,
      triggerState: "none",
      error: null,
      errorCategory: null,
      errorCode: null,
      errorStage: null,
      finishedAt: null,
      materials: next,
    },
  });
  await db.note.updateMany({ where: { id: job.noteId }, data: { aiState: "queued" } }).catch(() => {});

  // A material-only retry skips extraction (the source is already persisted).
  const assetId = material ? null : note.assets?.[0]?.id ?? null;
  const refreshed = await db.job.findUnique({ where: { id: job.id } });
  const result = await triggerProcessing(refreshed, { assetId, db });
  console.log(
    `[processing] retry job=${job.id} material=${material ?? "all"} kept=${kept.length ? kept.join(",") : "none"} triggered=${result.triggered}`,
  );
  return { job: refreshed, ...result, materials: next };
}

/** The run tells the row who it is, so a lost run-id write still resolves. */
export async function adoptRunId(jobId, runId, db = prisma) {
  if (!jobId || !runId) return;
  await db.job
    .updateMany({ where: { id: jobId }, data: { runId, triggerState: "submitted" } })
    .catch(() => {});
}

/** Cancelling the run is best-effort; the row is what the API reports. */
export async function cancelProcessingRun(runId) {
  if (!runId) return false;
  try {
    const api = await client();
    await api.cancel(runId);
    return true;
  } catch (error) {
    console.warn(`[processing] could not cancel run ${runId}: ${error?.name ?? "Error"}`);
    return false;
  }
}

/** A row whose trigger call never landed can be re-submitted without a queue. */
export async function needsResubmit(job) {
  if (!job) return false;
  if (job.triggerState === "failed") return true;
  const idleMs = Date.now() - new Date(job.updatedAt ?? job.createdAt).getTime();
  return job.triggerState === "submitting" && idleMs > 2 * 60_000;
}



/**
 * Extraction-only trigger for a plain upload (no generation requested).
 * The asset carries its own progress columns, so this run needs no job row.
 */
export async function triggerAssetExtraction(assetId) {
  if (!assetId) return { triggered: false };
  const api = await client();
  const handle = await api.trigger("extract-document", { assetId }, {
    idempotencyKey: `sua:extract:${assetId}`,
    idempotencyKeyTTL: IDEMPOTENCY_TTL,
    tags: [`asset:${assetId}`],
  });
  return { triggered: true, runId: handle?.id ?? null };
}

/** Quiz marking is short AI work, but it must not run inside a request either. */
export async function triggerQuizMarking(jobId) {
  if (!jobId) return { triggered: false };
  const api = await client();
  const handle = await api.trigger("mark-quiz", { jobId }, {
    idempotencyKey: `sua:mark:${jobId}`,
    idempotencyKeyTTL: IDEMPOTENCY_TTL,
    tags: [`job:${jobId}`],
  });
  return { triggered: true, runId: handle?.id ?? null };
}
