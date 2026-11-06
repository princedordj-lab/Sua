// @ts-nocheck
/**
 * The processing stages as Trigger.dev tasks.
 *
 * Each task is a thin wrapper around the plain function in
 * `src/lib/processing/stages.js`, so the stage logic stays testable offline and
 * the platform only provides scheduling, retries and machine sizing.
 *
 * `@ts-nocheck` on purpose: the backend is plain JS ESM (see AGENTS.md) and the
 * stage modules carry no type annotations. Trigger.dev bundles these files with
 * esbuild; the payload types below are the contract.
 */
import { task, logger } from "@trigger.dev/sdk";
import {
  extractStage,
  finalizeStage,
  materialStage,
  sourceStage,
} from "../lib/processing/stages.js";
import { classifyFailure } from "../lib/processing/errors.js";
import { longDoc } from "../config/ai-pipeline.js";

/**
 * Retry hints: a 429 tells us exactly how long to wait (Retry-After), a 5xx or
 * a network blip gets the exponential default. A permanent failure aborts the
 * run so Trigger.dev does not retry a broken file three times.
 */
function catchErrorFor({ error }) {
  const classified = classifyFailure(error);
  if (classified.category === "permanent") {
    return { skipRetrying: true };
  }
  if (classified.retryAfterMs) {
    logger.warn("retrying after provider delay", {
      code: classified.code,
      retryAfterMs: classified.retryAfterMs,
    });
    return { retryDelayInMs: classified.retryAfterMs };
  }
  return { retry: { maxAttempts: 4, minTimeoutInMs: 3_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true } };
}

export const extractDocument = task({
  id: "extract-document",
  description: "Extract text from an uploaded document, OCR only the pages that need it",
  // PDF rendering and OCR are the heaviest work in the pipeline.
  machine: { preset: "medium-1x" },
  maxDuration: longDoc.extractBudgetMs / 1000 * 20,
  // A provider parse can remain pending across several persisted poll
  // intervals (up to LLAMAPARSE_TIMEOUT_MS). The stage throws a typed transient
  // error with retryAfterMs, so these attempts resume the same asset without
  // re-uploading or re-submitting the parse.
  retry: { maxAttempts: 24, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true },
  concurrency: { total: 4 },
  catchError: catchErrorFor,
  run: async (payload, { ctx }) => {
    logger.info("extracting document", { jobId: payload.jobId, assetId: payload.assetId });
    const result = await extractStage({ jobId: payload.jobId, assetId: payload.assetId });
    logger.info("extraction finished", { jobId: payload.jobId, state: result.state, pages: result.pagesTotal, ocrPages: result.ocrPages });
    return result;
  },
});

export const prepareSource = task({
  id: "prepare-source",
  description: "Normalize, condense and persist the AI-ready source text",
  machine: "small-1x",
  maxDuration: 600,
  retry: { maxAttempts: 3, minTimeoutInMs: 3_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true },
  catchError: catchErrorFor,
  run: async (payload, { ctx }) => {
    const result = await sourceStage({ jobId: payload.jobId });
    logger.info("source ready", { jobId: payload.jobId, chars: result.chars, condensed: Boolean(result.condensed) });
    return result;
  },
});

/** Build the five stage tasks from one shape: the wrapper never differs. */
function materialTask({ id, material, description, machine = "small-1x", maxDuration = 900, concurrency = 6 }) {
  return task({
    id,
    description,
    machine,
    maxDuration,
    retry: { maxAttempts: 4, minTimeoutInMs: 3_000, maxTimeoutInMs: 120_000, factor: 2, randomize: true },
    concurrency: { total: concurrency },
    catchError: catchErrorFor,
    run: async (payload) => {
      logger.info("material started", { jobId: payload.jobId, material });
      try {
        const result = await materialStage(payload.jobId, material, {
          record: async (step, value) =>
            logger.debug("ai call", { step, ms: value?.durationMs ?? null }),
        });
        logger.info("material finished", { jobId: payload.jobId, material, state: result.state });
        return { ...result, category: "done" };
      } catch (error) {
        const classified = classifyFailure(error);
        if (classified.category === "permanent") {
          // A broken input or an unusable model answer will not improve by
          // retrying: report it and let the orchestrator keep the other
          // materials that already succeeded.
          logger.error("material failed permanently", {
            jobId: payload.jobId,
            material,
            code: classified.code,
          });
          return { material, state: "failed", category: "permanent", code: classified.code };
        }
        // Transient: rethrow so Trigger.dev retries THIS stage only.
        throw error;
      }
    },
  });
}

export const generateNotes = materialTask({
  id: "generate-notes",
  material: "notes",
  description: "Write the lecture note / course reference body",
  machine: "small-2x",
  maxDuration: 1_800,
});

export const generateSummary = materialTask({
  id: "generate-summary",
  material: "summary",
  description: "Write the note summary",
});

export const generateFlashcards = materialTask({
  id: "generate-flashcards",
  material: "flashcards",
  description: "Write spaced-repetition flashcards",
});

export const generateQuiz = materialTask({
  id: "generate-quiz",
  material: "quiz",
  description: "Write the practice quiz",
});

export const finalizeDocument = task({
  id: "finalize-document",
  description: "Close the processing row: usage, note state and the completion push",
  machine: "small-1x",
  maxDuration: 120,
  retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  run: async (payload) => {
    const result = await finalizeStage({ jobId: payload.jobId, materialStates: payload.materialStates ?? null });
    logger.info("document finalized", { jobId: payload.jobId, state: result?.state });
    return result;
  },
});

/** Material name -> task, used by the orchestrator. */
export const MATERIAL_TASKS = {
  notes: generateNotes,
  summary: generateSummary,
  flashcards: generateFlashcards,
  quiz: generateQuiz,
};

/** Quiz marking: short AI work that must not run inside an API request. */
export const markQuiz = task({
  id: "mark-quiz",
  description: "Mark short-answer quiz questions with the AI provider",
  machine: "small-1x",
  maxDuration: 300,
  retry: { maxAttempts: 3, minTimeoutInMs: 3_000, maxTimeoutInMs: 60_000, factor: 2, randomize: true },
  concurrency: { total: 6 },
  catchError: catchErrorFor,
  run: async (payload) => {
    const { processQuizMarking } = await import("../lib/pipeline.js");
    const { prisma } = await import("../config/prisma.js");
    const job = await prisma.job.findUnique({ where: { id: payload.jobId } });
    if (!job) return { state: "missing" };
    await processQuizMarking(job);
    return { state: "done" };
  },
});
