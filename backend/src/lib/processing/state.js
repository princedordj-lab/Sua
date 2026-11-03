/**
 * Document-processing state for the Trigger.dev pipeline.
 *
 * PostgreSQL is the source of truth: one `jobs` row per (note, kind,
 * processingVersion) carries the lifecycle state, the per-material state and
 * the Trigger.dev run id. Trigger.dev owns scheduling and retries; this module
 * owns what the state *means* and is the only writer of those columns, so the
 * worker (src/trigger/*) and the API cannot drift apart.
 *
 * Every write here is a single short statement (no interactive transaction, no
 * network I/O in between): the previous implementation held Prisma
 * transactions open across model calls and object-storage reads, which is what
 * surfaced as P2028 "expired transaction" capacity errors.
 */

import { prisma } from "../../config/prisma.js";

export const PROCESSING_STATES = {
  uploaded: "uploaded",
  queued: "queued",
  extracting: "extracting",
  ocr: "ocr_processing",
  generating: "generating",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export const MATERIALS = ["notes", "summary", "flashcards", "quiz"];

export const MATERIAL_STATES = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

/** The generation kind each material belongs to (references have no cards/quiz). */
export function materialsForKind(kind) {
  // A course reference is a written sheet + summary; a study set adds cards and
  // a quiz to an existing note (no body rewrite); a lecture note is all four.
  if (kind === "course_reference") return ["notes", "summary"];
  if (kind === "study_set") return ["summary", "flashcards", "quiz"];
  return MATERIALS;
}

/**
 * Client-facing copy per material. The app must never be left on a generic
 * "Pulling out the important parts": every stage says what is happening now.
 */
const MATERIAL_LABELS = {
  notes: "Generating notes",
  summary: "Generating summary",
  flashcards: "Generating flashcards",
  quiz: "Generating quiz",
};

const STATE_LABELS = {
  uploaded: "Upload received",
  queued: "Waiting to start",
  extracting: "Extracting document",
  ocr_processing: "Processing scanned pages",
  generating: "Preparing study content",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Normalised per-material map from the raw JSON column. */
export function materialStates(job) {
  const raw = job?.materials && typeof job.materials === "object" ? job.materials : {};
  const out = {};
  for (const material of MATERIALS) {
    const value = raw[material];
    out[material] = {
      state: MATERIAL_STATES[value?.state] ? value.state : MATERIAL_STATES.pending,
      error: typeof value?.error === "string" ? value.error : null,
      at: value?.at ?? null,
    };
  }
  return out;
}

/**
 * One server-computed sentence so mobile and web can never disagree:
 * "Extracting document", "Generating flashcards (2 of 4)", "Completed".
 */
export function stageSentence(job) {
  if (!job) return null;
  if (job.processingState === "failed") return STATE_LABELS.failed;
  if (job.processingState === "completed") return STATE_LABELS.completed;
  if (job.processingState === "cancelled") return STATE_LABELS.cancelled;
  const materials = materialStates(job);
  const kindMaterials = materialsForKind(job.kind);
  const running = kindMaterials.find(
    (material) => materials[material].state === MATERIAL_STATES.running,
  );
  const done = kindMaterials.filter(
    (material) => materials[material].state === MATERIAL_STATES.done,
  ).length;
  if (running) return `${MATERIAL_LABELS[running]} (${done + 1} of ${kindMaterials.length})`;
  if (job.processingState === "generating") {
    return `Preparing study content (${done} of ${kindMaterials.length} ready)`;
  }
  return STATE_LABELS[job.processingState] ?? STATE_LABELS.queued;
}

/** Whether the client should show a retry affordance. */
export function canRetryProcessing(job) {
  if (!job) return false;
  if (["failed", "cancelled"].includes(job.processingState)) return true;
  // A row whose trigger call never landed can never run; let the student retry.
  return job.triggerState === "failed" && ["queued", "uploaded"].includes(job.processingState);
}

/**
 * Shape returned by every processing endpoint (additive to the existing job
 * and asset payloads, so current clients keep working unchanged).
 */
export function shapeProcessing(job) {
  if (!job) return null;
  const materials = materialStates(job);
  const kindMaterials = materialsForKind(job.kind);
  return {
    jobId: job.id,
    noteId: job.noteId,
    kind: job.kind,
    state: job.processingState,
    stage: job.stage,
    detail: stageSentence(job),
    progressDone: job.progressDone ?? 0,
    progressTotal: job.progressTotal ?? 0,
    runId: job.runId ?? null,
    triggerState: job.triggerState ?? "none",
    processingVersion: job.processingVersion ?? "v1",
    materials: Object.fromEntries(
      kindMaterials.map((material) => [material, materials[material]]),
    ),
    completedMaterials: kindMaterials.filter(
      (material) => materials[material].state === MATERIAL_STATES.done,
    ),
    error: job.error ?? null,
    errorCategory: job.errorCategory ?? null,
    canRetry: canRetryProcessing(job),
    updatedAt: job.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writes (one statement each, no interactive transaction)
// ---------------------------------------------------------------------------

/**
 * Advance the stage. `state`/`stage` keep the legacy client contract
 * (queued|running|done|failed); `processingState` carries the new lifecycle.
 */
export async function markStage(
  jobId,
  { processingState, stage, state, progressDone, progressTotal, error, errorCategory, errorCode, errorStage, finished = false } = {},
  db = prisma,
) {
  if (!jobId) return;
  const data = { heartbeatAt: new Date() };
  if (processingState) data.processingState = processingState;
  if (stage) data.stage = stage;
  if (processingState || stage) {
    data.state = state ?? (processingState === "completed" ? "done" : processingState === "failed" ? "failed" : "running");
    if (data.state === "failed") data.stage = stage ?? "failed";
  }
  if (Number.isFinite(progressDone)) data.progressDone = Math.max(0, Math.round(progressDone));
  if (Number.isFinite(progressTotal)) data.progressTotal = Math.max(0, Math.round(progressTotal));
  if (error !== undefined) data.error = error;
  if (errorCategory !== undefined) data.errorCategory = errorCategory;
  if (errorCode !== undefined) data.errorCode = errorCode;
  if (errorStage !== undefined) data.errorStage = errorStage;
  if (finished) data.finishedAt = new Date();
  await db.job.updateMany({ where: { id: jobId }, data });
}

/**
 * Write one material's state. The whole `materials.<name>` object is replaced
 * in one statement, so two materials finishing concurrently cannot clobber
 * each other's keys (the same rule the digest checkpoint follows).
 */
export async function markMaterial(jobId, material, state, { error = null, db = prisma } = {}) {
  if (!jobId || !MATERIALS.includes(material)) return;
  const value = { state, error, at: new Date().toISOString() };
  await db.$executeRaw`
    UPDATE "jobs"
    SET "materials" = jsonb_set(
          COALESCE("materials", '{}'::jsonb),
          ARRAY[${material}::text],
          ${JSON.stringify(value)}::jsonb,
          true
        ),
        "heartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = ${jobId}
  `;
}

/** Record that the trigger call was attempted / succeeded / failed. */
export async function markTrigger(jobId, triggerState, { runId, error = null, db = prisma } = {}) {
  if (!jobId) return;
  await db.job.updateMany({
    where: { id: jobId },
    data: {
      triggerState,
      ...(runId ? { runId } : {}),
      ...(triggerState === "failed"
        ? { error, errorCategory: "transient", errorStage: "trigger" }
        : {}),
      heartbeatAt: new Date(),
    },
  });
}

/**
 * Reset the materials a retry must redo, keeping everything already finished.
 * This is what makes "retry quiz only" and "retry after a partial failure"
 * resume from the earliest incomplete stage instead of starting over.
 */
export function resetMaterials(job, { only = null } = {}) {
  const current = materialStates(job);
  const next = {};
  for (const material of MATERIALS) {
    const keepDone = current[material].state === MATERIAL_STATES.done;
    const targeted = !only || only === material;
    next[material] = targeted && !keepDone
      ? { state: MATERIAL_STATES.pending, error: null, at: null }
      : current[material];
    if (only && targeted) next[material] = { state: MATERIAL_STATES.pending, error: null, at: null };
  }
  return next;
}

