/**
 * Document-processing state for the Direct Express processing pipeline.
 *
 * PostgreSQL is the source of truth: one `jobs` row per (note, kind,
 * processingVersion) carries the lifecycle state, the per-material state,
 * and the processing lease (lockedUntil/heartbeatAt).
 *
 * Every write here is a single short statement (no interactive transaction, no
 * network I/O in between) to keep Neon round-trips fast and safe from pool saturation.
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
const ACTIVE_PROCESSING_STATES = [
  PROCESSING_STATES.uploaded,
  PROCESSING_STATES.queued,
  PROCESSING_STATES.extracting,
  PROCESSING_STATES.ocr,
  PROCESSING_STATES.generating,
];

/**
 * How long a row may look active without writing anything. Every stage and
 * every material update renews `heartbeatAt`. Silence past this window means
 * the execution is stalled or was terminated.
 */
export const STALE_ACTIVE_RUN_MS = Math.max(
  600_000,
  Number(process.env.PROCESSING_STALE_RUN_MS ?? 7_200_000),
);

export function canRetryProcessing(job, { now = Date.now() } = {}) {
  if (!job) return false;
  if ([PROCESSING_STATES.failed, PROCESSING_STATES.cancelled].includes(job.processingState)) return true;
  if (job.processingState === PROCESSING_STATES.completed) return false;
  if (job.triggerState === "failed") return true;
  if (!ACTIVE_PROCESSING_STATES.includes(job.processingState)) return false;
  const stamp = job.heartbeatAt ?? job.updatedAt;
  const beat = stamp instanceof Date ? stamp.getTime() : Date.parse(stamp ?? "");
  if (!Number.isFinite(beat)) return false;
  return now - beat > STALE_ACTIVE_RUN_MS;
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
// Writes & Leases (one statement each, no interactive transaction)
// ---------------------------------------------------------------------------

/**
 * Atomically acquire an exclusive processing lease on a job.
 * Ensures only one execution context processes a job at any given time.
 */
export async function acquireProcessingLease(jobId, { leaseMs = 300_000, db = prisma } = {}) {
  if (!jobId) return { acquired: false };
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  if (typeof db.$executeRaw === "function") {
    try {
      const leaseInterval = `${Math.round(leaseMs / 1000)} seconds`;
      const updated = await db.$executeRaw`
        UPDATE "jobs"
        SET "lockedUntil" = NOW() + ${leaseInterval}::interval,
            "heartbeatAt" = NOW(),
            "attempts" = "attempts" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${jobId}
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= NOW())
      `;
      return { acquired: updated > 0 };
    } catch {
      // Fall through to ORM fallback if raw SQL fails or is unsupported
    }
  }

  // Fallback for mock test databases
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return { acquired: false };
  if (job.lockedUntil && new Date(job.lockedUntil).getTime() > now.getTime()) {
    return { acquired: false };
  }
  await db.job.update({
    where: { id: jobId },
    data: {
      lockedUntil: leaseUntil,
      heartbeatAt: now,
      attempts: (job.attempts ?? 0) + 1,
    },
  });
  return { acquired: true };
}

/**
 * Extend an existing lease while processing is in progress.
 */
export async function extendProcessingLease(jobId, { leaseMs = 300_000, db = prisma } = {}) {
  if (!jobId) return;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  if (typeof db.$executeRaw === "function") {
    try {
      const leaseInterval = `${Math.round(leaseMs / 1000)} seconds`;
      await db.$executeRaw`
        UPDATE "jobs"
        SET "lockedUntil" = NOW() + ${leaseInterval}::interval,
            "heartbeatAt" = NOW(),
            "updatedAt" = NOW()
        WHERE "id" = ${jobId}
      `;
      return;
    } catch {
      // Fall through
    }
  }

  await db.job.updateMany({
    where: { id: jobId },
    data: { lockedUntil: leaseUntil, heartbeatAt: now },
  }).catch(() => {});
}

/**
 * Release an acquired lease when processing settles, yields, or errors out.
 */
export async function releaseProcessingLease(jobId, { db = prisma } = {}) {
  if (!jobId) return;
  await db.job.updateMany({
    where: { id: jobId },
    data: { lockedUntil: null, heartbeatAt: new Date() },
  }).catch(() => {});
}

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
 * each other's keys.
 */
export async function markMaterial(jobId, material, state, { error = null, db = prisma } = {}) {
  if (!jobId || !MATERIALS.includes(material)) return;
  const value = { state, error, at: new Date().toISOString() };

  if (typeof db.$executeRaw === "function") {
    try {
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
      return;
    } catch {
      // Fall through to ORM fallback
    }
  }

  // Fallback for mock test databases
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (job) {
    const materials = typeof job.materials === "object" && job.materials ? { ...job.materials } : {};
    materials[material] = value;
    await db.job.update({
      where: { id: jobId },
      data: { materials, heartbeatAt: new Date() },
    });
  }
}

/** Record that the processing start was attempted / succeeded / failed. */
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
