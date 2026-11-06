/**
 * Direct Express Processing Orchestrator.
 *
 * Coordinates the full document processing lifecycle:
 *   1. Acquire processing lease on PostgreSQL `jobs` row
 *   2. Resumable extraction (extractStage) -> verified terminal completion
 *   3. Source preparation & normalization (sourceStage)
 *   4. Independent material generation (materialStage) with budget yield checks
 *   5. Finalization (finalizeStage): push notification, usage bump, completion state
 *   6. Release processing lease
 *
 * Runs within Vercel's execution window (e.g. 300s via Fluid Compute).
 * If time runs low, checkpoints state and yields cleanly for the next status poll or retry.
 */

import { prisma } from "../../config/prisma.js";
import {
  extractStage,
  finalizeStage,
  materialStage,
  sourceStage,
} from "./stages.js";
import { classifyFailure, safeFailureMessage } from "./errors.js";
import {
  PROCESSING_STATES,
  acquireProcessingLease,
  extendProcessingLease,
  markStage,
  materialsForKind,
  releaseProcessingLease,
  shapeProcessing,
} from "./state.js";
import { minCallWindowMs, processingBudgetMs } from "../budget.js";

export const orchestratorDeps = {
  db: prisma,
  extractStage,
  sourceStage,
  materialStage,
  finalizeStage,
  acquireLease: acquireProcessingLease,
  extendLease: extendProcessingLease,
  releaseLease: releaseProcessingLease,
  markStage,
  budgetMs: processingBudgetMs,
  minCallMs: minCallWindowMs,
};

function depsOf(overrides = {}) {
  return { ...orchestratorDeps, ...overrides };
}

/**
 * Report stage failure safely on the Job row.
 */
async function reportStageFailure(jobId, stage, error, deps) {
  const classified = classifyFailure(error);
  await deps.markStage(
    jobId,
    {
      processingState: PROCESSING_STATES.failed,
      stage: "failed",
      state: "failed",
      error: safeFailureMessage(error),
      errorCategory: classified.category ?? "transient",
      errorCode: classified.code ?? null,
      errorStage: stage,
    },
    deps.db,
  ).catch(() => {});
}

/**
 * Run direct document processing for a job.
 *
 * @param {string} jobId - The job ID to process
 * @param {object} options
 * @param {string|null} [options.assetId] - Document asset ID for extraction
 * @param {string|null} [options.material] - Specific material to target (retry)
 * @param {number|null} [options.deadline] - Optional wall-clock deadline ms
 * @param {object} [options.overrides] - Test dependency injection
 */
export async function runDirectProcessing(jobId, options = {}) {
  const { assetId = null, material = null, deadline = null, overrides = {} } = options;
  const deps = depsOf(overrides);
  const db = deps.db;

  const startedAt = Date.now();
  const maxBudget = deps.budgetMs();
  const computedDeadline = deadline ?? (startedAt + maxBudget);

  // 1. Acquire processing lease
  const lease = await deps.acquireLease(jobId, { db });
  if (!lease.acquired) {
    console.log(`[orchestrator] job ${jobId} already has an active lease; skipping`);
    const existing = await db.job.findUnique({ where: { id: jobId } });
    return { status: "already_locked", job: shapeProcessing(existing) };
  }

  try {
    const job = await db.job.findUnique({
      where: { id: jobId },
      include: {
        note: {
          select: {
            id: true,
            assets: { where: { status: "active" }, select: { id: true, kind: true } },
          },
        },
      },
    });

    if (!job) {
      console.warn(`[orchestrator] job ${jobId} is gone; aborting`);
      return { status: "missing" };
    }

    if (job.processingState === PROCESSING_STATES.completed) {
      return { status: "completed", skipped: true, job: shapeProcessing(job) };
    }

    if (job.processingState === PROCESSING_STATES.cancelled) {
      return { status: "cancelled", job: shapeProcessing(job) };
    }

    // Set initial running state
    await db.note
      .updateMany({ where: { id: job.noteId }, data: { aiState: "queued" } })
      .catch(() => {});
    await deps.markStage(
      jobId,
      {
        processingState: PROCESSING_STATES.queued,
        stage: "queued",
        state: "running",
      },
      db,
    );

    // 2. Extraction (+ OCR fallback)
    const effectiveAssetId =
      assetId ??
      job.note?.assets?.find((a) => a.kind === "document")?.id ??
      null;

    if (effectiveAssetId && !material) {
      const asset = await db.asset.findUnique({ where: { id: effectiveAssetId } });
      if (asset && asset.extractState !== "done") {
        await deps.markStage(
          jobId,
          {
            processingState: PROCESSING_STATES.extracting,
            stage: "extracting",
          },
          db,
        );

        let extractResult;
        try {
          extractResult = await deps.extractStage({ jobId, assetId: effectiveAssetId }, { db, deadline: computedDeadline });
        } catch (error) {
          console.error(`[orchestrator] extraction failed for job ${jobId}:`, error);
          await reportStageFailure(jobId, "extracting", error, deps);
          throw error;
        }

        // Verify extraction reached terminal success. extractStage throws on
        // failed / partial / parked-provider results, so this is a second gate
        // for anything that returns a non-"done" state: a run must never
        // prepare a source from pages it does not have.
        if (extractResult && extractResult.state !== "done" && extractResult.state !== "skipped" && extractResult.state !== "resumed") {
          const err = new Error(`Extraction did not settle: ${extractResult.state}`);
          await reportStageFailure(jobId, "extracting", err, deps);
          throw err;
        }
      }
    }

    // Extend lease after extraction
    await deps.extendLease(jobId, { db });

    // 3. Source Preparation & Normalization
    if (!material) {
      const currentJob = await db.job.findUnique({ where: { id: jobId } });
      if (!currentJob.sourceText || currentJob.sourceText.trim().length < 40) {
        await deps.markStage(
          jobId,
          {
            processingState: PROCESSING_STATES.generating,
            stage: "preparing",
          },
          db,
        );

        try {
          await deps.sourceStage({ jobId }, { db, deadline: computedDeadline });
        } catch (error) {
          console.error(`[orchestrator] source preparation failed for job ${jobId}:`, error);
          await reportStageFailure(jobId, "preparing", error, deps);
          throw error;
        }
      }
    }

    // Extend lease after source preparation
    await deps.extendLease(jobId, { db });

    // 4. Material Generation
    const targetMaterials = material ? [material] : materialsForKind(job.kind);
    let yieldedEarly = false;

    for (const mat of targetMaterials) {
      // Check cancellation between stages
      const latest = await db.job.findUnique({ where: { id: jobId }, select: { processingState: true } });
      if (latest?.processingState === PROCESSING_STATES.cancelled) {
        return { status: "cancelled", job: shapeProcessing(await db.job.findUnique({ where: { id: jobId } })) };
      }

      // Check remaining execution window: yield if running low so we don't crash mid-model call
      const remainingMs = computedDeadline - Date.now();
      if (remainingMs < deps.minCallMs()) {
        console.log(`[orchestrator] yielding job ${jobId} before ${mat}: ${remainingMs}ms remaining`);
        yieldedEarly = true;
        break;
      }

      try {
        await deps.materialStage(jobId, mat, { db, deadline: computedDeadline });
        await deps.extendLease(jobId, { db });
      } catch (error) {
        const classified = classifyFailure(error);
        if (classified.category === "permanent") {
          console.error(`[orchestrator] material ${mat} failed permanently for job ${jobId}:`, error);
        } else {
          console.warn(`[orchestrator] material ${mat} failed transiently for job ${jobId}:`, error);
          await reportStageFailure(jobId, mat, error, deps);
          throw error;
        }
      }
    }

    // 5. Finalize Stage
    if (!yieldedEarly) {
      const finalized = await deps.finalizeStage({ jobId }, { db });
      const finalJob = await db.job.findUnique({ where: { id: jobId } });
      return {
        status: finalized?.state ?? "completed",
        job: shapeProcessing(finalJob),
      };
    }

    // Clean yield: release lease so polling / retry can continue
    return {
      status: "yielded",
      job: shapeProcessing(await db.job.findUnique({ where: { id: jobId } })),
    };
  } finally {
    await deps.releaseLease(jobId, { db }).catch(() => {});
  }
}
