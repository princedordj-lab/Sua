/**
 * Starting (and re-starting) document processing from the API.
 *
 * Replaces Trigger.dev with Direct Express Processing.
 * Uses `@vercel/functions` `waitUntil` to execute processing in the background
 * without blocking API responses.
 *
 * PostgreSQL maintains atomic processing leases and checkpoints so processing
 * is completely resumable and idempotent.
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
import { runDirectProcessing } from "./orchestrator.js";
import { extractNext } from "../extraction.js";

/** Pipeline revision. Bump it to force every note to be rebuilt once. */
export const PROCESSING_VERSION = "v1";
export const PROCESS_DOCUMENT_TASK = "process-document";
export const IDEMPOTENCY_TTL = "1h";

/**
 * Executes a promise in the background.
 * Uses Vercel's `waitUntil` if available (keeps serverless function alive),
 * or standard background execution with unhandled rejection protection in Node/dev.
 */
export function runInBackground(promise) {
  try {
    import("@vercel/functions")
      .then((vercel) => {
        if (typeof vercel?.waitUntil === "function") {
          vercel.waitUntil(promise);
        }
      })
      .catch(() => {});
  } catch {
    // Not running on Vercel
  }

  // Ensure errors do not escape as unhandled rejections
  Promise.resolve(promise).catch((error) => {
    console.error("[processing] background task error:", error?.message ?? error);
  });
}

// Test seam: allows offline tests to intercept triggers.
let directExecutor = null;
export function setDirectExecutor(fn) {
  directExecutor = fn;
}

export function setTriggerClient(client) {
  if (!client) {
    directExecutor = null;
    return;
  }
  directExecutor = async (taskId, payload, options) => {
    if (typeof client.trigger === "function") {
      return client.trigger(taskId, payload, options);
    }
  };
}

export function processingConfigured() {
  return Boolean(process.env.DATABASE_URL && aiConfigured());
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
 * Trigger direct processing for a row.
 * Returns { triggered, runId, error }.
 */
export async function triggerProcessing(job, { assetId = null, material = null, db = prisma } = {}) {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await markTrigger(job.id, "submitting", { db }).catch(() => {});

  if (directExecutor) {
    try {
      const payload = {
        jobId: job.id,
        noteId: job.noteId,
        userId: job.userId,
        processingVersion: job.processingVersion ?? PROCESSING_VERSION,
        ...(assetId ? { assetId } : {}),
        ...(material ? { material } : {}),
      };
      const handle = await directExecutor(PROCESS_DOCUMENT_TASK, payload, {
        idempotencyKey: `${job.idempotencyKey ?? job.id}:${job.processingVersion ?? PROCESSING_VERSION}`,
        idempotencyKeyTTL: IDEMPOTENCY_TTL,
      });
      await markTrigger(job.id, "submitted", { runId: handle?.id ?? runId, db }).catch(() => {});
      return { triggered: true, runId: handle?.id ?? runId, error: null };
    } catch (error) {
      const message = "Sua could not start processing this file. Tap Try again.";
      console.warn(`[processing] trigger execution failed job=${job.id}:`, error);
      await markTrigger(job.id, "failed", { error: message, db }).catch(() => {});
      return { triggered: false, runId: null, error: message };
    }
  }

  await markTrigger(job.id, "submitted", { runId, db }).catch(() => {});
  runInBackground(runDirectProcessing(job.id, { assetId, material }));
  return { triggered: true, runId, error: null };
}

/**
 * Full "start this document" path used by upload-completion and POST /jobs.
 * Safe to call repeatedly: an existing running row is returned as-is.
 */
export async function startProcessing({ noteId, userId, kind, assetId = null }, db = prisma) {
  const { job, created } = await ensureProcessingJob({ noteId, userId, kind }, db);
  const alreadyRunning =
    !created &&
    (["submitting", "submitted"].includes(job.triggerState) ||
      (job.lockedUntil && new Date(job.lockedUntil).getTime() > Date.now()) ||
      ["extracting", "ocr_processing", "generating"].includes(job.processingState));
  if (alreadyRunning) return { job, triggered: false, runId: job.runId ?? null, reused: true };

  const result = await triggerProcessing(job, { assetId, db });
  return { job: { ...job, runId: result.runId ?? job.runId }, ...result, reused: false };
}

/**
 * Which of these notes still want a run started, and with which asset.
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
  const result = await triggerProcessing(refreshed, { assetId, material, db });
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

/** Cancelling the run: direct orchestrator checks job.processingState at every stage boundary. */
export async function cancelProcessingRun(runId) {
  return true;
}

/** A row whose run never landed or that was interrupted can be resumed. */
export async function needsResubmit(job) {
  if (!job) return false;
  if (job.triggerState === "failed") return true;
  if (["extracting", "ocr_processing", "generating", "queued"].includes(job.processingState)) {
    const isLocked = job.lockedUntil && new Date(job.lockedUntil).getTime() > Date.now();
    if (!isLocked) {
      const idleMs = Date.now() - new Date(job.updatedAt ?? job.createdAt).getTime();
      return idleMs > 2 * 60_000;
    }
  }
  return false;
}

/**
 * Extraction-only trigger for a plain upload (no generation requested).
 * The asset carries its own progress columns, so this run needs no job row.
 */
export async function triggerAssetExtraction(assetId) {
  if (!assetId) return { triggered: false };
  const runId = `extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (directExecutor) {
    try {
      await directExecutor("extract-document", { assetId });
      return { triggered: true, runId };
    } catch {
      return { triggered: false, runId: null };
    }
  }
  runInBackground(extractNext({ targetAssetId: assetId }));
  return { triggered: true, runId };
}

/** Quiz marking: runs AI marking directly via background execution. */
export async function triggerQuizMarking(jobId) {
  if (!jobId) return { triggered: false };
  const runId = `mark_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (directExecutor) {
    try {
      await directExecutor("mark-quiz", { jobId });
      return { triggered: true, runId };
    } catch {
      return { triggered: false, runId: null };
    }
  }

  runInBackground(
    (async () => {
      const { processQuizMarking } = await import("../pipeline.js");
      const job = await prisma.job.findUnique({ where: { id: jobId }, include: { user: true } });
      if (job) await processQuizMarking(job);
    })(),
  );
  return { triggered: true, runId };
}
