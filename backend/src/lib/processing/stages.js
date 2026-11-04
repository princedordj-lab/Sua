/**
 * The document-processing stages, as plain functions.
 *
 * Trigger.dev tasks (src/trigger/*) are thin wrappers around these, which keeps
 * every stage runnable — and testable — without the platform: the offline
 * harness in scripts/test-processing-pipeline.mjs calls them with fake deps.
 *
 * Stage order: extraction (+ OCR fallback) -> AI-ready source persisted ->
 * notes -> summary -> flashcards -> quiz. Each stage writes only its own
 * material, so a failure in one never removes another's result, and a retry
 * resumes at the earliest incomplete stage.
 *
 * Rules this module keeps:
 *  - the original file is never sent to a model; only extracted text is;
 *  - the model's JSON is validated before any nested property is touched;
 *  - no transaction is held open while a provider or storage call is in flight.
 */

import { prisma } from "../../config/prisma.js";
import { withUser } from "../db.js";
import { readAssetBytes } from "../storage.js";
import { claimExtractionAsset, runExtractionPass } from "../extraction.js";
import {
  assembledShortSource,
  condenseMaterial,
  parseJsonObject,
  prepareMaterial,
  singlePassSource,
  writeNote,
} from "../note-pipeline.js";
import { chatCompletion, bulkModel, timeoutForDeadline } from "../ai.js";
import { notifyUser } from "../push.js";
import { longDoc } from "../../config/ai-pipeline.js";
import { loadChunkedSource, runLongDocJob } from "../long-doc.js";
import {
  MATERIAL_STATES,
  PROCESSING_STATES,
  markMaterial,
  markStage,
  materialStates,
} from "./state.js";
import {
  PermanentProcessingError,
  TransientProcessingError,
} from "./errors.js";

/** Everything a stage reaches outside itself. Tests replace all of it. */
export const processingDeps = {
  db: prisma,
  readAssetBytes,
  claimExtractionAsset,
  runExtractionPass,
  prepareMaterial,
  singlePassSource,
  assembledShortSource,
  condenseMaterial,
  chatCompletion,
  writeNote,
  loadChunkedSource,
  runLongDocJob,
  withUser,
  markStage,
  markMaterial,
  notifyUser,
  record: async () => {},
  recordFailure: async () => {},
};

function depsOf(overrides = {}) {
  return { ...processingDeps, ...overrides };
}

// ---------------------------------------------------------------------------
// Extraction (+ OCR fallback) — reuses the resumable page-wise extractor
// ---------------------------------------------------------------------------

const UNREADABLE_MESSAGES = {
  UNREADABLE_PPT: "This .ppt file can't be parsed. Save it as .pptx and upload again.",
  UNREADABLE_FILE: "Couldn't read this file. Try a clearer photo or a text PDF.",
  UNSUPPORTED_FORMAT: "This file type isn't supported yet. Upload a PDF, PPTX, DOCX or TXT file.",
  STORAGE_ERROR: "Couldn't download this file. Please upload it again.",
  LLAMA_AUTH: "Document reading is temporarily unavailable. Tap Try again in a few minutes.",
  LLAMA_QUOTA: "Document reading is temporarily unavailable. Tap Try again in a few minutes.",
  EMPTY_DOCUMENT: "There isn't enough readable text in this file to study.",
};

/** Permanent extraction codes: retrying the same bytes cannot help. */
const PERMANENT_EXTRACT_CODES = new Set([
  "UNREADABLE_PPT",
  "UNREADABLE_FILE",
  "UNSUPPORTED_FORMAT",
  "LLAMA_AUTH",
  "LLAMA_QUOTA",
  "EMPTY_DOCUMENT",
  "STORAGE_ERROR",
]);

/**
 * Run extraction to completion for one asset.
 *
 * A pass is resumable (SourceChunk rows + asset progress columns), so this
 * loops until the asset settles. Transient provider trouble is thrown as a
 * TransientProcessingError so Trigger.dev retries the run, and the next attempt
 * continues from `nextPage` instead of starting over.
 */
export async function extractStage({ jobId = null, assetId }, overrides = {}) {
  const deps = depsOf(overrides);
  const db = deps.db;
  if (!assetId) return { state: "skipped", reason: "no-asset" };

  const claimed = await deps.claimExtractionAsset({ targetAssetId: assetId, db });
  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new PermanentProcessingError(`asset ${assetId} is gone`, {
      code: "MISSING_OBJECT",
      safeMessage: "This file is no longer available. Please upload it again.",
    });
  }

  if (!claimed && (asset.extractState === "done" || Boolean(asset.extractedText))) {
    return summarizeAsset(asset, { resumed: true });
  }
  if (jobId) {
    await markStage(
      jobId,
      {
        processingState: PROCESSING_STATES.extracting,
        stage: "extracting",
        progressDone: asset.pagesDone ?? 0,
        progressTotal: asset.pagesTotal ?? 0,
      },
      db,
    );
  }

  let passes = 0;
  let current = asset;
  for (;;) {
    passes += 1;
    await deps.runExtractionPass(assetId, longDoc.extractBudgetMs, {
      db,
      readAssetBytes: deps.readAssetBytes,
      record: deps.record,
      recordFailure: deps.recordFailure,
    });
    current = await db.asset.findUnique({ where: { id: assetId } });
    if (!current) {
      throw new PermanentProcessingError(`asset ${assetId} vanished during extraction`, {
        code: "MISSING_OBJECT",
        safeMessage: "This file is no longer available. Please upload it again.",
      });
    }
    if (jobId) {
      await markStage(
        jobId,
        {
          processingState: (current.ocrPages ?? 0) > 0
            ? PROCESSING_STATES.ocr
            : PROCESSING_STATES.extracting,
          stage: current.extractState === "partial" ? "reading_scans" : "extracting",
          progressDone: current.pagesDone ?? 0,
          progressTotal: current.pagesTotal ?? 0,
        },
        db,
      );
    }
    if (["done", "failed", "partial"].includes(current.extractState)) break;
    if (current.providerNextPollAt && current.providerNextPollAt.getTime() > Date.now()) break;
    if (passes > 200) {
      throw new TransientProcessingError(`asset ${assetId} extraction did not settle`, {
        code: "EXTRACTION_LOOP",
      });
    }
  }

  if (current.extractState === "failed") {
    const code = String(current.extractErrorCode ?? "UNREADABLE_FILE");
    const message =
      UNREADABLE_MESSAGES[code] ?? "Couldn't read this file. Try a clearer PDF or re-upload.";
    if (PERMANENT_EXTRACT_CODES.has(code)) {
      throw new PermanentProcessingError(`asset ${assetId} extraction failed: ${code}`, {
        code,
        safeMessage: message,
      });
    }
    // Provider-side trouble (timeout, 5xx, a parked parse) is worth another run.
    throw new TransientProcessingError(`asset ${assetId} extraction failed: ${code}`, { code });
  }
  return summarizeAsset(current, { passes });
}

function summarizeAsset(asset, extra = {}) {
  return {
    state: asset.extractState,
    pagesTotal: asset.pagesTotal ?? 0,
    pagesDone: asset.pagesDone ?? 0,
    ocrPages: asset.ocrPages ?? 0,
    truncated: Boolean(asset.truncated),
    errorCode: asset.extractErrorCode ?? null,
    ...extra,
  };
}


// ---------------------------------------------------------------------------
// Source: extract once, normalize, condense, persist as AI input
// ---------------------------------------------------------------------------

const SOURCE_MAX_CHARS = 120_000;

/**
 * Build the AI-ready source text for a job and store it on the row.
 *
 * This is the step that makes the rest of the pipeline cheap: extraction runs
 * once, the normalized/condensed text is saved, and every material stage reads
 * it from Postgres. A failure later in generation therefore never repeats
 * extraction, OCR or digests.
 */
export async function sourceStage({ jobId }, overrides = {}) {
  const deps = depsOf(overrides);
  const db = deps.db;
  const job = await loadJob(db, jobId);
  if (!job) throw new PermanentProcessingError(`job ${jobId} is gone`, { code: "MISSING_JOB" });
  if (job.sourceText && job.sourceText.trim().length >= 40) {
    return { chars: job.sourceText.length, resumed: true, sourceType: job.sourceMeta?.sourceType ?? "file" };
  }

  const note = job.note;
  const courseContext = courseContextOf(note);
  const aiDeps = buildAiDeps(job, deps);
  const prepared = await deps.prepareMaterial({ note, kind: job.kind, courseContext, deps: aiDeps });
  const condensed = await deps.condenseMaterial(prepared.material, {
    courseContext,
    sourceType: prepared.source?.sourceType ?? "file",
    deps: prepared.deps ?? aiDeps,
  });
  const text = String(condensed.text ?? "").trim();
  if (text.length < 40) {
    throw new PermanentProcessingError(`job ${jobId} produced too little text`, {
      code: "EMPTY_DOCUMENT",
      safeMessage: "There isn't enough readable text in this file to study. Add a bit more and try again.",
    });
  }
  const sourceText = text.slice(0, SOURCE_MAX_CHARS);
  await db.job.update({
    where: { id: jobId },
    data: {
      sourceText,
      sourceMeta: {
        sourceType: prepared.source?.sourceType ?? "file",
        condensed: Boolean(condensed.condensed),
        chunks: condensed.chunks ?? 0,
        chars: sourceText.length,
        truncated: text.length > SOURCE_MAX_CHARS,
      },
    },
  });
  return {
    chars: sourceText.length,
    condensed: Boolean(condensed.condensed),
    sourceType: prepared.source?.sourceType ?? "file",
  };
}

async function loadJob(db, jobId) {
  return db.job.findUnique({
    where: { id: jobId },
    include: { note: { include: { course: true, assets: true } }, user: { select: { id: true, clerkId: true } } },
  });
}

function courseContextOf(note) {
  return [note?.course?.name, note?.course?.code ? `course code ${note.course.code}` : ""]
    .filter(Boolean)
    .join(", ");
}

/**
 * The deps the generation helpers need (AI-call accounting, stage mirroring and
 * a liveness check). Deliberately tiny: a short write per call, never a
 * transaction around a provider call.
 */
function buildAiDeps(job, deps) {
  const db = deps.db;
  return {
    record: (step, result) => recordAiCall(db, job.id, step, result),
    recordFailure: (step, error, durationMs) => recordAiFailure(db, job.id, step, error, durationMs),
    setStage: (stage, progress) =>
      deps.markStage(job.id, { stage, progressDone: progress?.done, progressTotal: progress?.total }, db),
    assertAlive: async () => {
      const note = await db.note.findUnique({ where: { id: job.noteId }, select: { id: true } });
      if (!note) {
        const error = new Error("note was deleted");
        error.name = "NoteDeletedError";
        throw error;
      }
    },
    readBytes: deps.readAssetBytes,
    deadline: null,
  };
}

async function recordAiCall(db, jobId, step, result) {
  await db.aiCall
    .create({
      data: {
        jobId,
        step,
        model: result?.model ?? "unknown",
        promptTokens: result?.promptTokens ?? 0,
        completionTokens: result?.completionTokens ?? 0,
        usdMicros: result?.usdMicros ?? 0,
        durationMs: result?.durationMs ?? null,
      },
    })
    .catch((error) => {
      if (error?.code === "P2003" || error?.code === "P2025") return;
      console.warn(`could not record AI call for job ${jobId}: ${error?.message ?? error}`);
    });
}

async function recordAiFailure(db, jobId, step, error, durationMs) {
  await db.aiCall
    .create({
      data: {
        jobId,
        step: `${step}_failed`,
        model: "unknown",
        status: Number.isFinite(error?.status) ? error.status : null,
        errorCode: String(error?.kind ?? error?.name ?? "ERROR").slice(0, 40),
        durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      },
    })
    .catch(() => {});
}


// ---------------------------------------------------------------------------
// Material generation: prompts and strict validation
// ---------------------------------------------------------------------------

/**
 * Every array read goes through `asArray`. This is the direct fix for
 * "Cannot read properties of undefined (reading 'map')": a model response is
 * never allowed to reach a `.map` before it has been validated.
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, max = 4_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const SUMMARY_SYSTEM =
  "You are Sua, an exam-focused study assistant for African university students. " +
  "Write in clear, simple English, using only the material provided. Output only valid JSON.";
const CARDS_SYSTEM =
  "You are Sua. You write spaced-repetition flashcards for university exam revision. " +
  "One idea per card, question on the front, short precise answer on the back, using only the material. " +
  "Output only valid JSON.";
const QUIZ_SYSTEM =
  "You are Sua. You write exam-style quiz questions for university revision, using only the material. " +
  "Output only valid JSON.";

export const MATERIAL_SPECS = {
  summary: {
    step: "summary",
    maxTokens: 1_200,
    system: SUMMARY_SYSTEM,
    prompt: (course) =>
      `Summarise the study material for a student revising for exams${
        course ? ` (${course})` : ""
      }.\n\nReturn JSON: {"summary": "markdown"}\n` +
      "`summary` must be 150-400 words of Markdown starting with `## Overview`, then `## Key Terms` " +
      "(5-10 bullets of **term** — definition), then `## Likely Exam Questions` (3-6 numbered questions). " +
      "Use only the material.",
    validate: (parsed) => {
      const summary = text(parsed?.summary ?? parsed?.shortSummary ?? parsed?.markdown, 12_000);
      if (summary.length < 80) return { success: false, error: "summary must be at least 80 characters" };
      if (!/^#/m.test(summary)) return { success: false, error: "summary must be Markdown with headings" };
      return { success: true, data: { summary } };
    },
  },
  flashcards: {
    step: "flashcards",
    maxTokens: 4_000,
    system: CARDS_SYSTEM,
    prompt: (course) =>
      `Write 12-20 flashcards from the study material${
        course ? ` for ${course}` : ""
      }.\n\nReturn JSON: {"flashcards": [{"front": "...", "back": "..."}]}\n` +
      "Fronts must be questions or prompts that stand alone; backs must be short and factual. " +
      "No duplicate fronts. Use only the material.",
    validate: (parsed) => {
      const seen = new Set();
      const cards = [];
      for (const raw of asArray(parsed?.flashcards ?? parsed?.cards)) {
        const front = text(raw?.front ?? raw?.question, 2_000);
        const back = text(raw?.back ?? raw?.answer, 4_000);
        if (!front || !back) continue;
        const key = front.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push({ front, back });
        if (cards.length >= 40) break;
      }
      if (cards.length < 5) {
        return {
          success: false,
          error: `flashcards must contain at least 5 usable cards (found ${cards.length})`,
        };
      }
      return { success: true, data: { flashcards: cards } };
    },
  },
};

// The quiz uses the same shape the existing study-pack schema normalizes.
MATERIAL_SPECS.quiz = {
  step: "quiz",
  maxTokens: 4_000,
  system: QUIZ_SYSTEM,
  prompt: (course) =>
    `Write a 6-10 question quiz from the study material${
      course ? ` for ${course}` : ""
    }.\n\nReturn JSON: {"quiz": {"title": "...", "questions": [...]}}\n` +
    "Each question is one of:\n" +
    '- {"type":"mcq","prompt":"...","options":["...","..."],"correctIndex":0,"explanation":"..."}\n' +
    '- {"type":"true_false","prompt":"...","correctAnswer":"True"|"False","explanation":"..."}\n' +
    '- {"type":"short_answer","prompt":"...","answer":"...","explanation":"..."}\n' +
    "Use only the material.",
  validate: (parsed) => {
    const quiz = parsed?.quiz ?? parsed;
    const questions = [];
    for (const raw of asArray(quiz?.questions ?? parsed?.questions)) {
      const prompt = text(raw?.prompt ?? raw?.question, 2_000);
      if (!prompt) continue;
      const type = normalizeQuestionType(raw?.type);
      const explanation = text(raw?.explanation, 1_500);
      if (type === "mcq") {
        const options = asArray(raw?.options).map((option) => text(option, 500)).filter(Boolean);
        const index = Number(raw?.correctIndex ?? raw?.correct_index);
        if (options.length < 2 || options.length > 6) continue;
        if (!Number.isInteger(index) || index < 0 || index >= options.length) continue;
        questions.push({ type, prompt, options, correctIndex: index, explanation });
      } else if (type === "true_false") {
        const answer = canonicalBoolean(raw?.correctAnswer ?? raw?.answer);
        if (!answer) continue;
        questions.push({ type, prompt, correctAnswer: answer, explanation });
      } else {
        const answer = text(raw?.answer ?? raw?.correctAnswer, 2_000);
        if (!answer) continue;
        questions.push({ type, prompt, answer, explanation });
      }
      if (questions.length >= 20) break;
    }
    if (questions.length < 3) {
      return {
        success: false,
        error: `quiz must contain at least 3 valid questions (found ${questions.length})`,
      };
    }
    return {
      success: true,
      data: { quiz: { title: text(quiz?.title, 200) || "Practice quiz", questions } },
    };
  },
};

function normalizeQuestionType(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
  if (["mcq", "multiple_choice", "single_choice", "choice"].includes(raw)) return "mcq";
  if (["true_false", "truefalse", "tf", "boolean"].includes(raw)) return "true_false";
  if (["short_answer", "short", "open", "open_ended", "essay", "fill_blank"].includes(raw)) {
    return "short_answer";
  }
  return "mcq";
}

function canonicalBoolean(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "t", "yes"].includes(raw)) return "True";
  if (["false", "f", "no"].includes(raw)) return "False";
  return null;
}

/**
 * One AI call for one material, with a single temperature-0 repair pass.
 * A response that still fails validation becomes a controlled
 * PermanentProcessingError — never an unhandled TypeError in the task.
 */
async function generateMaterial(spec, { material, courseContext, job, deps }) {
  const call = async (stricter) => {
    const started = Date.now();
    let result;
    try {
      result = await deps.chatCompletion({
        system: stricter
          ? `${spec.system} Previous output was invalid: reply with ONLY the JSON object in the requested shape.`
          : spec.system,
        user: `${spec.prompt(courseContext)}\n\n=== STUDY MATERIAL ===\n${material}`,
        model: bulkModel(),
        json: true,
        maxTokens: spec.maxTokens,
        temperature: stricter ? 0 : 0.2,
        timeoutMs: timeoutForDeadline(deps.deadline ?? null),
      });
    } catch (error) {
      await deps.recordFailure?.(spec.step, error, Date.now() - started);
      throw error;
    }
    await deps.record?.(stricter ? `${spec.step}_retry` : spec.step, result);
    const parsed = parseJsonObject(result.text);
    const validation = parsed ? spec.validate(parsed) : { success: false, error: "unparseable JSON" };
    return { validation, parsed };
  };

  let outcome = await call(false);
  if (!outcome.validation.success) {
    console.warn(
      `[processing] invalid output job=${job.id} material=${spec.step} reason=${String(outcome.validation.error).slice(0, 120)}`,
    );
    outcome = await call(true);
  }
  if (!outcome.validation.success) {
    throw new PermanentProcessingError(
      `${spec.step} generation returned invalid output: ${outcome.validation.error}`,
      {
        code: "AI_INVALID_OUTPUT",
        safeMessage: `The AI could not produce usable ${spec.step}. Tap Try again.`,
      },
    );
  }
  return outcome.validation.data;
}


// ---------------------------------------------------------------------------
// Material stages
// ---------------------------------------------------------------------------

/**
 * Shared shell for one material: skip if already done, mark it running, run the
 * generator, then record the outcome. A transient failure is re-thrown so
 * Trigger.dev retries the run (completed materials are untouched); a permanent
 * one is recorded and re-thrown as a controlled error for the orchestrator.
 */
export async function materialStage(jobId, material, overrides = {}) {
  const deps = depsOf(overrides);
  const db = deps.db;
  const job = await loadJob(db, jobId);
  if (!job) return { material, state: MATERIAL_STATES.failed, error: "job is gone" };

  if (materialStates(job)[material]?.state === MATERIAL_STATES.done) {
    return { material, state: MATERIAL_STATES.done, skipped: true };
  }
  if (!job.sourceText || job.sourceText.trim().length < 40) {
    // Without persisted source text no material can be produced: a pipeline
    // order problem, not the student's, so it is retryable.
    throw new TransientProcessingError(`job ${jobId} has no source text for ${material}`, {
      code: "NO_SOURCE",
    });
  }

  await deps.markMaterial(jobId, material, MATERIAL_STATES.running, { db });
  try {
    if (material === "notes") {
      const result = await runNotesMaterial(job, deps);
      const completed = result.completed ?? ["notes"];
      for (const other of completed) {
        await deps.markMaterial(jobId, other, MATERIAL_STATES.done, { db });
      }
      return { material, state: MATERIAL_STATES.done, mode: result.mode };
    }

    const spec = MATERIAL_SPECS[material];
    const data = await generateMaterial(spec, {
      material: job.sourceText,
      courseContext: courseContextOf(job.note),
      job,
      deps: { ...buildAiDeps(job, deps), deadline: deps.deadline ?? null },
    });
    await persistMaterial(material, job, data, deps);
    await deps.markMaterial(jobId, material, MATERIAL_STATES.done, { db });
    return { material, state: MATERIAL_STATES.done };
  } catch (error) {
    const { classifyFailure } = await import("./errors.js");
    const classified = classifyFailure(error);
    await deps.markMaterial(jobId, material, MATERIAL_STATES.failed, {
      db,
      error: classified.code,
    });
    throw error;
  }
}

/**
 * Notes material: the note body.
 * Long documents keep the sectioned writer (chunking, map/reduce, per-section
 * checkpoints); short ones take the single write. `study_set` has no body.
 */
async function runNotesMaterial(job, deps) {
  if (job.kind === "study_set") return { mode: "none", completed: ["notes"] };
  const note = job.note;
  const courseContext = courseContextOf(note);
  const aiDeps = buildAiDeps(job, deps);

  const chunks = await deps.loadChunkedSource(job.user.clerkId, note);
  // A document whose whole stored text fits one generation call skips map/reduce
  // entirely — digesting it first would charge the student for a step the writer
  // does not need. Photos have no chunk rows, so a mixed note is assembled here
  // instead of being quietly reduced to its document text.
  const shortSource = chunks?.rows?.length
    ? (deps.singlePassSource(note, chunks) ?? (await deps.assembledShortSource(note, aiDeps, chunks)))
    : null;
  if (chunks?.rows?.length && !shortSource) {
    const result = await deps.runLongDocJob({
      job: { ...job, checkpoint: job.checkpoint ?? {} },
      note,
      kind: job.kind,
      clerkId: job.user.clerkId,
      deps: aiDeps,
      source: chunks,
    });
    // The sectioned writer owns the summary, cards and quiz for long files.
    return {
      mode: "long-doc",
      completed: ["notes", "summary", "flashcards", "quiz"],
      parts: result?.parts?.length ?? 1,
    };
  }

  const prepared = await deps.prepareMaterial({
    note,
    kind: job.kind,
    courseContext,
    deps: aiDeps,
    ...(shortSource ? { source: shortSource } : {}),
  });
  const written = await deps.writeNote({ prepared, kind: job.kind, courseContext });
  await deps.withUser(job.user.clerkId, (tx) =>
    tx.note.update({
      where: { id: note.id },
      data: { body: written.body, transcript: written.transcript },
    }),
  );
  return { mode: "single", completed: ["notes"] };
}

async function persistMaterial(material, job, data, deps) {
  if (material === "summary") {
    await deps.withUser(job.user.clerkId, (tx) =>
      tx.note.update({ where: { id: job.noteId }, data: { summary: data.summary } }),
    );
    return;
  }
  if (material === "flashcards") {
    await persistCards(job, data.flashcards, deps);
    return;
  }
  if (material === "quiz") {
    await persistQuiz(job, data.quiz, deps);
    return;
  }
  throw new Error(`unknown material ${material}`);
}


/** Cards are matched by normalised front so SM-2 progress survives a re-run. */
async function persistCards(job, cards, deps) {
  const key = (front) => String(front ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  await deps.withUser(job.user.clerkId, async (tx) => {
    const existing = await tx.flashcard.findMany({
      where: { noteId: job.noteId, retiredAt: null },
      select: { id: true, front: true },
    });
    const byFront = new Map(existing.map((card) => [key(card.front), card]));
    const kept = new Set();
    for (const card of cards) {
      const front = String(card.front).slice(0, 2_000);
      const back = String(card.back).slice(0, 4_000);
      const match = byFront.get(key(front));
      if (match) {
        kept.add(match.id);
        await tx.flashcard.update({ where: { id: match.id }, data: { back } });
      } else {
        await tx.flashcard.create({
          data: {
            userId: job.userId,
            noteId: job.noteId,
            courseId: job.note.courseId,
            front,
            back,
          },
        });
      }
    }
    const retired = existing.filter((card) => !kept.has(card.id)).map((card) => card.id);
    if (retired.length) {
      await tx.flashcard.updateMany({
        where: { id: { in: retired } },
        data: { retiredAt: new Date() },
      });
    }
  });
}

/** The quiz keeps its row (and attempt history); only the questions replace. */
async function persistQuiz(job, quiz, deps) {
  await deps.withUser(job.user.clerkId, async (tx) => {
    const existing = await tx.quiz.findFirst({ where: { noteId: job.noteId } });
    const row = existing
      ? await tx.quiz.update({ where: { id: existing.id }, data: { title: quiz.title } })
      : await tx.quiz.create({
          data: {
            userId: job.userId,
            noteId: job.noteId,
            courseId: job.note.courseId,
            title: quiz.title,
          },
        });
    await tx.quizQuestion.deleteMany({ where: { quizId: row.id } });
    await tx.quizQuestion.createMany({
      data: quiz.questions.map((question, index) => ({
        quizId: row.id,
        ordinal: index + 1,
        type: question.type,
        prompt: question.prompt,
        options: question.options ?? null,
        answer:
          question.type === "mcq"
            ? String(question.options[question.correctIndex] ?? "")
            : question.type === "true_false"
              ? question.correctAnswer
              : question.answer,
        explanation: question.explanation ?? "",
      })),
    });
  });
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/**
 * Close a run: usage, note aiState and the completion push, then the job row.
 * `complete` is the honest verdict — a document whose materials did not all
 * succeed is marked failed with the materials that did succeed kept on the row.
 */
export async function finalizeStage({ jobId, materialStates: states = null }, overrides = {}) {
  const deps = depsOf(overrides);
  const db = deps.db;
  const job = await loadJob(db, jobId);
  if (!job) return null;
  const materials = states ?? materialStates(job);
  const required = requiredMaterials(job.kind);
  const failed = required.filter((material) => materials[material]?.state === MATERIAL_STATES.failed);
  const done = required.filter((material) => materials[material]?.state === MATERIAL_STATES.done);
  // A material that never reached a verdict (its run died before writing one)
  // is not a success: only what the row says is done may be reported as ready.
  const unfinished = required.filter((material) => !done.includes(material));

  if (failed.length || unfinished.length) {
    const message =
      "Some study materials could not be prepared. Tap Try again — the finished parts are saved.";
    await deps.markStage(
      jobId,
      {
        processingState: PROCESSING_STATES.failed,
        stage: "failed",
        state: "failed",
        error: message,
        errorCategory: "permanent",
        finished: true,
      },
      db,
    );
    await db.note
      .updateMany({ where: { id: job.noteId }, data: { aiState: "failed" } })
      .catch(() => {});
    return { state: "failed", materials, done };
  }

  await deps.markStage(
    jobId,
    { processingState: PROCESSING_STATES.completed, stage: "ready", state: "done", progressDone: 1, progressTotal: 1, error: null, errorCategory: null, finished: true },
    db,
  );
  // The destination is asserted where the work is claimed to be finished: an
  // upload converted to a reference must read as a reference even if the client
  // created the note before that choice existed. Never the other way round — a
  // study set on an existing reference must not downgrade it.
  const noteKind = job.kind === "course_reference" ? { noteKind: "reference" } : {};
  await db.note
    .updateMany({ where: { id: job.noteId }, data: { aiState: "ready", ...noteKind } })
    .catch(() => {});
  await bumpUsage(db, job.userId, job.kind).catch(() => {});
  await notifyCompletion(job, deps);
  return { state: "completed", materials, done };
}

function requiredMaterials(kind) {
  if (kind === "course_reference") return ["notes", "summary"];
  if (kind === "study_set") return ["summary", "flashcards", "quiz"];
  return ["notes", "summary", "flashcards", "quiz"];
}

async function bumpUsage(db, userId, kind) {
  const month = new Date().toISOString().slice(0, 7);
  if (kind === "course_reference") {
    await db.usage.upsert({
      where: { userId_month: { userId, month } },
      update: { references: { increment: 1 } },
      create: { userId, month, references: 1 },
    });
    return;
  }
  await db.usage.upsert({
    where: { userId_month: { userId, month } },
    update: { summaries: { increment: 1 }, studySets: { increment: 1 } },
    create: { userId, month, summaries: 1, studySets: 1 },
  });
}

const COMPLETION_NOTICE = {
  study_set: {
    title: "Your study set is ready",
    body: (note) => `${note?.title || "Your note"} now has a summary, flashcards and a quiz.`,
  },
  lecture_note: {
    title: "Your lecture note is ready",
    body: (note) => `${note?.title || "Your note"} now has a full note, summary, flashcards and a quiz.`,
  },
  course_reference: {
    title: "Your course reference is ready",
    body: (note) => `${note?.title || "Your upload"} was saved to your course reference.`,
  },
};

/**
 * Tell the student their study set is on the device. Awaited, not detached:
 * a Trigger.dev task is frozen the moment it returns, so an unawaited push
 * would never reach Expo. A failed delivery is never a failed run.
 */
async function notifyCompletion(job, deps) {
  const copy = COMPLETION_NOTICE[job.kind] ?? COMPLETION_NOTICE.study_set;
  try {
    await deps.notifyUser(job.userId, {
      title: copy.title,
      body: copy.body(job.note),
      mobilePath: `/note/${job.noteId}`,
      webPath: `/app/note/${job.noteId}`,
      tag: `job-${job.id}`,
      priority: "high",
    });
  } catch (error) {
    console.warn(`completion push failed for job ${job.id}: ${error?.message ?? error}`);
  }
}


