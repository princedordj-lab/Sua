// @ts-nocheck
/**
 * process-document — the one orchestration task.
 *
 * The API triggers this with ids only (never file bytes, never extracted text):
 * everything it needs is read from PostgreSQL and Neon Object Storage.
 *
 * It coordinates the stage tasks:
 *   extract-document (when the payload carries an assetId)
 *     -> prepare-source
 *     -> generate-notes / generate-summary / generate-flashcards / generate-quiz
 *     -> finalize-document
 *
 * Why this shape:
 *  - Each material is its own run, so it retries on its own and a quiz failure
 *    never re-runs (or removes) the notes, summary or flashcards.
 *  - Every stage skips work already recorded on the row, so an orchestrator
 *    retry resumes at the earliest incomplete stage instead of restarting.
 *  - Extraction is deliberately its own task: it finishes and persists
 *    extracted text BEFORE any AI generation, so a generation failure never
 *    repeats reading or OCRing the file.
 */
import { task, logger } from "@trigger.dev/sdk";
import {
  MATERIAL_TASKS,
  extractDocument,
  finalizeDocument,
  prepareSource,
} from "./stages.js";
import { adoptRunId } from "../lib/processing/start.js";
import {
  PROCESSING_STATES,
  markStage,
  materialsForKind,
  shapeProcessing,
} from "../lib/processing/state.js";
import { prisma } from "../config/prisma.js";

export const processDocument = task({
  id: "process-document",
  description: "Extract a document and generate its study materials",
  machine: "small-1x",
  maxDuration: 3_600,
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, factor: 2, randomize: true },
  concurrency: { total: 10 },
  run: async (payload, { ctx }) => {
    const { jobId, noteId, assetId } = payload;
    // The run owns its id even if the API's write of it was lost.
    await adoptRunId(jobId, ctx.run.id);
    logger.info("process-document started", { jobId, noteId, hasAsset: Boolean(assetId) });

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      logger.warn("processing row is gone; nothing to do", { jobId });
      return { state: "missing" };
    }
    if (job.processingState === "completed") {
      return { state: "completed", skipped: true };
    }

    await prisma.note
      .updateMany({ where: { id: noteId }, data: { aiState: "queued" } })
      .catch(() => {});
    await markStage(jobId, {
      processingState: PROCESSING_STATES.queued,
      stage: "queued",
      state: "running",
    });

    // ---- 1. Extraction (+ OCR fallback), persisted before any AI call ------
    if (assetId) {
      const extracted = await extractDocument.triggerAndWait({ jobId, assetId });
      if (!extracted.ok) {
        // Extraction exhausted its own retries. Leave the row recoverable and
        // let the orchestrator retry later; nothing was lost.
        logger.error("extraction stage failed", { jobId, assetId });
        throw new Error("document extraction failed");
      }
      if (["failed", "partial"].includes(extracted.output?.state)) {
        logger.warn("extraction settled without full text", {
          jobId,
          state: extracted.output?.state,
        });
      }
    }

    // ---- 2. AI-ready source text, saved on the row -------------------------
    const source = await prepareSource.triggerAndWait({ jobId });
    if (!source.ok) {
      throw new Error("source preparation failed");
    }

    // ---- 3. Materials, one independent run each ----------------------------
    const materials = materialsForKind(job.kind);
    const verdicts = {};
    let failedPermanently = false;
    let failedTransiently = false;

    for (const material of materials) {
      const child = MATERIAL_TASKS[material];
      if (!child) continue;
      const result = await child.triggerAndWait({ jobId });
      if (!result.ok) {
        // The stage's own retries are exhausted: this is transient trouble
        // (rate limit, provider outage, capacity) — retry the document later.
        logger.error("material stage exhausted its retries", { jobId, material });
        verdicts[material] = { state: "failed", category: "transient" };
        failedTransiently = true;
        continue;
      }
      verdicts[material] = {
        state: result.output?.state ?? "unknown",
        category: result.output?.category ?? null,
        code: result.output?.code ?? null,
        skipped: Boolean(result.output?.skipped),
      };
      if (verdicts[material].category === "permanent") failedPermanently = true;
    }

    // ---- 4. Close the row --------------------------------------------------
    const refreshed = await prisma.job.findUnique({ where: { id: jobId } });
    const current = shapeProcessing(refreshed);
    await finalizeDocument.triggerAndWait({
      jobId,
      materialStates: current?.materials ?? null,
    });

    if (failedTransiently) {
      // A retry resumes at the incomplete material: completed ones are marked
      // done on the row and skipped by their stage.
      throw new Error("one or more materials were not generated");
    }
    return {
      state: failedPermanently ? "failed" : "completed",
      materials: verdicts,
      job: shapeProcessing(await prisma.job.findUnique({ where: { id: jobId } })),
    };
  },
});
