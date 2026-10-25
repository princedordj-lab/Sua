import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readAssetBytes } from "./storage.js";
import { withUser } from "./db.js";
import {
  bulkModel,
  geminiImageText,
  geminiTranscribe,
  openRouterChat,
  aiConfigured,
} from "./ai.js";
import { enqueueStudyJob, studyQueueConfigured } from "./queue.js";
import { extractDocumentText } from "./extract.js";
import { prisma } from "../config/prisma.js";

// Cap on the cleaning pass; longer cleaned sources are split into sections.
const CLEAN_CHUNK_CHARS = 30_000;
// Above this, the material is summarised per section then combined (map/reduce)
// so a 2-hour lecture does not break the model context window.
const SECTION_LIMIT_CHARS = 15_000;

const MIME_BY_FORMAT = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

// Free-plan monthly caps; warn-only until Milestone 5 flips ENFORCE_CAPS on.
export const FREE_MONTHLY_LIMITS = {
  summaries: Number(process.env.FREE_MONTHLY_SUMMARIES ?? 10),
  studySets: Number(process.env.FREE_MONTHLY_SETS ?? 10),
  references: Number(process.env.FREE_MONTHLY_REFERENCES ?? 20),
};

const USD_TO_GHS = Number(process.env.USD_TO_GHS_RATE ?? 15);
const DAILY_SPEND_ALERT_GHS = Number(process.env.AI_DAILY_SPEND_ALERT_GHS ?? 50);

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function sourceHashOf(text) {
  return createHash("sha1").update(text).digest("hex");
}

function char(value) {
  return String(value ?? "").trim();
}

function maybeGhs(usdMicros) {
  return (usdMicros / 1_000_000) * USD_TO_GHS;
}

function mimeFor(asset) {
  const format = String(asset.format ?? "").toLowerCase();
  if (asset.kind === "audio") return MIME_BY_FORMAT[format] ?? "audio/mp4";
  if (asset.kind === "image") return MIME_BY_FORMAT[format] ?? "image/jpeg";
  return "application/octet-stream";
}

async function fetchAssetBytes(asset) {
  try {
    return await readAssetBytes(asset);
  } catch (error) {
    throw new Error(`storage fetch failed for asset ${asset.id}: ${error?.message ?? error}`);
  }
}

/**
 * Stage updates run through withUser so row-level security applies with the
 * job owner's identity — every AI pipeline write happens as the student.
 */
async function setStage(job, stage, state = "running") {
  await withUser(job.user.clerkId, (tx) =>
    tx.$transaction([
      tx.job.update({ where: { id: job.id }, data: { stage, state } }),
      tx.note.update({ where: { id: job.noteId }, data: { aiState: stage } }),
    ]),
  );
}

async function recordAiCall(jobId, step, result) {
  await prisma.aiCall.create({
    data: {
      jobId,
      step,
      model: result.model ?? "unknown",
      promptTokens: result.promptTokens ?? 0,
      completionTokens: result.completionTokens ?? 0,
      usdMicros: result.usdMicros ?? 0,
    },
  });
}

/**
 * Runs one BullMQ attempt end to end. Throws on failure so BullMQ retries
 * (3 attempts with exponential backoff); the Job row carries the stage/error
 * the app displays. Every persist is idempotent (replace) so reruns are clean.
 */
export async function processJob(jobId) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      user: { select: { clerkId: true } },
      note: { include: { course: true, assets: true } },
    },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.state === "done") return;
  if (job.kind === "course_reference") {
    await processReference(job);
    return;
  }
  if (job.kind === "quiz_marking") {
    await processQuizMarking(job);
    return;
  }
  await processStudySet(job);
}

async function startAttempt(job) {
  await prisma.job.update({
    where: { id: job.id },
    data: { startedAt: new Date(), attempts: { increment: 1 } },
  });
  // The pipeline, not the device, owns what kind of page a note is. A rerun
  // after a client-side mismatch therefore self-corrects on the next attempt.
  const noteKind = job.kind === "course_reference" ? "reference" : "note";
  await withUser(job.user.clerkId, (tx) =>
    tx.note.update({ where: { id: job.noteId }, data: { noteKind } }),
  ).catch((error) => {
    // A deleted note must fail the job via its own path, not here.
    console.warn(`noteKind update failed for note ${job.noteId}: ${error?.message ?? error}`);
  });
}

function courseContextOf(note) {
  return [
    note.course.name,
    note.course.code ? `course code ${note.course.code}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const WEAK_SOURCE_ERROR =
  "No usable source material. Record a longer lecture, upload readable files, or add typed content.";

/** Doc text (already extracted or re-fetched), image OCR, audio transcription. */
async function collectRawSource(job, note) {
  const orderedAssets = note.assets
    .filter((asset) => asset.status === "active" && asset.publicId !== "pending")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const pieces = [];
  if (char(note.body)) {
    pieces.push(char(note.body));
  }

  for (const asset of orderedAssets) {
    if (asset.kind === "document" && asset.extractedText) {
      pieces.push(char(asset.extractedText));
      continue;
    }
    if (asset.kind === "document") {
      const bytes = await fetchAssetBytes(asset);
      pieces.push(char(extractDocumentText(bytes, asset.format, asset.kind) ?? ""));
      continue;
    }
    if (asset.kind === "image") {
      if (asset.extractedText) {
        pieces.push(char(asset.extractedText));
        continue;
      }
      const bytes = await fetchAssetBytes(asset);
      const ocr = await geminiImageText({ bytes, mimeType: mimeFor(asset) });
      await withUser(job.user.clerkId, (tx) =>
        tx.asset.update({ where: { id: asset.id }, data: { extractedText: ocr.text } }),
      );
      await recordAiCall(job.id, "ocr", ocr);
      if (ocr.text) pieces.push(char(ocr.text));
      continue;
    }
    if (asset.kind === "audio") {
      if (asset.extractedText) {
        pieces.push(char(asset.extractedText));
        continue;
      }
      const bytes = await fetchAssetBytes(asset);
      const transcription = await geminiTranscribe({
        bytes,
        mimeType: mimeFor(asset),
        languageHint: "English (may include a Ghanaian university accent)",
      });
      await withUser(job.user.clerkId, (tx) =>
        tx.asset.update({ where: { id: asset.id }, data: { extractedText: transcription.text } }),
      );
      await recordAiCall(job.id, "transcribe", transcription);
      if (transcription.text) pieces.push(char(transcription.text));
      continue;
    }
  }
  return pieces.filter(Boolean).join("\n\n");
}

async function persistTranscript(user, note, raw) {
  // Keep the original transcript on the note so the student can audit the AI.
  await withUser(user.clerkId, (tx) =>
    tx.note.update({ where: { id: note.id }, data: { transcript: raw } }),
  );
}

async function guardRerun(job, hash) {
  // Caching: an identical source for the same destination reuses existing
  // outputs. The kind is part of the identity — a study_set run must never
  // make a later lecture_note run skip writing the note body.
  const priorDone = await prisma.job.findFirst({
    where: {
      noteId: job.noteId,
      kind: job.kind,
      state: "done",
      sourceHash: hash,
      id: { not: job.id },
    },
  });
  if (priorDone) {
    await finishJob(job, hash);
    return true;
  }
  return false;
}

export async function processStudySet(job) {
  const { note, user } = job;
  await startAttempt(job);

  try {
    // ---- 1. Assemble the raw source text --------------------------------
    await setStage(job, "transcribing");
    const raw = await collectRawSource(job, note);
    if (raw.length < 80) throw new Error(WEAK_SOURCE_ERROR);

    // ---- 2. Clean with course context ------------------------------------
    const courseContext = courseContextOf(note);
    const cleaned = await cleanText(raw, courseContext, job);
    await persistTranscript(user, note, raw);

    if (await guardRerun(job, sourceHashOf(cleaned))) return;

    // ---- 2b. Full lecture note from the uploaded material -----------------
    if (job.kind === "lecture_note") {
      await setStage(job, "writing");
      const body = await generateLectureNote({
        cleaned,
        courseContext,
        jobId: job.id,
      });
      await withUser(user.clerkId, (tx) =>
        tx.note.update({ where: { id: note.id }, data: { body } }),
      );
    }

    // ---- 3. Summarise (with sectioning for long material) ----------------
    await setStage(job, "summarising");
    let studySet;
    if (cleaned.length <= SECTION_LIMIT_CHARS) {
      studySet = await generateStudySet({
        cleaned,
        courseContext,
        durationMinutes: totalAudioMinutes(note),
        jobId: job.id,
      });
    } else {
      const sections = splitSections(cleaned);
      const sectionSummaries = [];
      for (const [index, section] of sections.entries()) {
        const result = await openRouterChat({
          system:
            `You are Sua, a study assistant for African university students. Summarise ` +
            `section ${index + 1}/${sections.length} of lecture material for "${courseContext}". ` +
            "Return plain markdown bullets carrying every fact, term, formula and example. No preamble.",
          user: section,
          model: bulkModel(),
          temperature: 0.2,
        });
        await recordAiCall(job.id, "section_summarise", result);
        sectionSummaries.push(result.text);
      }
      studySet = await generateStudySet({
        cleaned: sectionSummaries.join("\n\n"),
        courseContext,
        durationMinutes: totalAudioMinutes(note),
        jobId: job.id,
        reduceNote:
          "The material below is a section-by-section summary of one long lecture; combine it into a single coherent study set.",
      });
    }

    await setStage(job, "making_cards");

    // ---- 4. Persist outputs (replace), usage, spend alert, notify ---------
    await persistStudySet(job, note, studySet);
    await bumpUsage(job.userId, job.kind);
    await checkDailySpend();
    await finishJob(job, sourceHashOf(cleaned));
    await notifyStudent(job, note);
  } catch (error) {
    const message = error?.message ?? String(error);
    await setFailed(job, message);
    throw error;
  }
}

/**
 * AI marking of short-answer quiz questions. Note.aiState is NOT touched — the
 * note finished its own pipeline long ago; this job only settles an attempt.
 */
export async function processQuizMarking(job) {
  let payload;
  try {
    payload = JSON.parse(job.payload ?? "{}");
  } catch {
    throw new Error("quiz_marking payload is not valid JSON");
  }
  const attemptId = payload.attemptId;
  if (!attemptId) throw new Error("quiz_marking payload is missing attemptId");

  // BullMQ owns the job retry counter; keep the Job row in step with it.
  await prisma.job.update({
    where: { id: job.id },
    data: { state: "running", stage: "marking", startedAt: new Date(), attempts: { increment: 1 } },
  });

  try {
    const attempt = await withUser(job.user.clerkId, (tx) =>
      tx.quizAttempt.findUnique({
        where: { id: attemptId },
        include: { quiz: { include: { questions: { orderBy: { ordinal: "asc" } } } } },
      }),
    );
    if (!attempt) throw new Error(`Attempt ${attemptId} not found for marking`);
    if (attempt.state === "marked") {
      // Already settled (e.g. a race with another worker); just close the job.
      await prisma.job.update({
        where: { id: job.id },
        data: { state: "done", stage: "ready", finishedAt: new Date(), error: null },
      });
      return;
    }

    const details = Array.isArray(attempt.details) ? attempt.details : [];
    const unmarked = details.filter(
      (entry) => (entry.verdict === undefined || entry.verdict === null) && entry.answer,
    );
    if (!unmarked.length) {
      // Client answers never reached us — nothing to mark AI-side.
      await settleMarking(job, attemptId, details, countCorrect(details));
      return;
    }

    const questionById = new Map(attempt.quiz.questions.map((question) => [question.id, question]));
    const items = unmarked
      .filter((entry) => questionById.has(String(entry.questionId)))
      .map((entry) => {
        const question = questionById.get(String(entry.questionId));
        return {
          questionId: entry.questionId,
          prompt: question.prompt,
          modelAnswer: question.answer,
          explanation: question.explanation,
          studentAnswer: String(entry.answer ?? ""),
        };
      });
    if (!items.length) {
      await settleMarking(job, attemptId, details, countCorrect(details));
      return;
    }

    const attemptMark = async (stricter) => {
      const result = await openRouterChat({
        system:
          "You are Sua's fair marking assistant for African university students. Mark each short " +
          "answer against the model answer, accepting equivalent phrasing, synonyms and minor " +
          "typos. Output ONLY valid JSON: {\"marks\":[{\"questionId\":\"...\",\"verdict\":\"correct|partial|wrong\",\"comment\":\"one short helpful sentence\"}]} — no prose, no code fences." +
          (stricter ? " Schema exactly as instructed. No extra keys." : ""),
        user: JSON.stringify({ questions: items }),
        model: bulkModel(),
        json: true,
        temperature: stricter ? 0 : 0.1,
      });
      await recordAiCall(job.id, stricter ? "quiz_marking_retry" : "quiz_marking", result);
      const parsed = parseStudySetJson(result.text);
      if (!parsed || !Array.isArray(parsed.marks)) return null;
      const shaped = parsed.marks.filter(
        (mark) =>
          typeof mark?.questionId === "string" &&
          ["correct", "partial", "wrong"].includes(mark?.verdict),
      );
      return shaped.length === items.length ? shaped : null;
    };

    let marks = await attemptMark(false);
    if (!marks) marks = await attemptMark(true);
    if (!marks) {
      // Attempt (not job) carries the failure so the app offers a retry.
      await withUser(job.user.clerkId, (tx) =>
        tx.quizAttempt.update({
          where: { id: attemptId },
          data: { state: "marking_failed", error: "The AI could not mark this attempt. Try again." },
        }),
      );
      await finishMarkingJob(job);
      return;
    }

    const markByQuestion = new Map(marks.map((mark) => [mark.questionId, mark]));
    const merged = details.map((entry) => {
      if (entry.verdict !== undefined && entry.verdict !== null) return entry;
      const mark = markByQuestion.get(String(entry.questionId));
      return {
        ...entry,
        verdict: mark?.verdict === "correct",
        partial: mark?.verdict === "partial",
        comment: mark?.comment ?? "",
      };
    });
    await settleMarking(job, attemptId, merged, countCorrect(merged));
    } catch (error) {
    const message = error?.message ?? String(error);
    await withUser(job.user.clerkId, (tx) =>
      tx.quizAttempt.update({
        where: { id: attemptId },
        data: { state: "marking_failed", error: message.slice(0, 500) },
      }),
    ).catch(() => {});
    await setFailed(job, message);
    throw error;
  }
}

function countCorrect(details) {
  return details.filter((entry) => entry?.verdict === true).length;
}

async function settleMarking(job, attemptId, details, correct) {
  await withUser(job.user.clerkId, (tx) =>
    tx.quizAttempt.update({
      where: { id: attemptId },
      data: { state: "marked", details, correct },
    }),
  );
  await finishMarkingJob(job);
}

async function finishMarkingJob(job) {
  await prisma.job.update({
    where: { id: job.id },
    data: { state: "done", stage: "ready", finishedAt: new Date(), error: null },
  });
}

export async function processReference(job) {
  const { note, user } = job;
  await startAttempt(job);

  try {
    await setStage(job, "transcribing");
    const raw = await collectRawSource(job, note);
    if (raw.length < 80) throw new Error(WEAK_SOURCE_ERROR);

    const courseContext = courseContextOf(note);
    const cleaned = await cleanText(raw, courseContext, job);
    await persistTranscript(user, note, raw);

    if (await guardRerun(job, sourceHashOf(cleaned))) return;

    await setStage(job, "writing");
    const reference = await generateReference({
      cleaned,
      courseContext,
      jobId: job.id,
    });
    await withUser(user.clerkId, (tx) =>
      tx.note.update({ where: { id: note.id }, data: { body: reference } }),
    );
    await bumpUsage(job.userId, job.kind);
    await checkDailySpend();
    await finishJob(job, sourceHashOf(cleaned));
    await notifyStudent(job, note);
  } catch (error) {
    const message = error?.message ?? String(error);
    await setFailed(job, message);
    throw error;
  }
}

async function setFailed(job, message) {
  await withUser(job.user.clerkId, (tx) =>
    tx.$transaction([
      tx.job.update({
        where: { id: job.id },
        data: {
          state: "failed",
          stage: "failed",
          error: message.slice(0, 2000),
          finishedAt: new Date(),
        },
      }),
      tx.note.update({ where: { id: job.noteId }, data: { aiState: "failed" } }),
    ]),
  );
}

// 2-minute chunks are the source unit; audio minutes ≈ asset count × 2.
function totalAudioMinutes(note) {
  const audioAssets = note.assets.filter((asset) => asset.kind === "audio").length;
  return Math.max(1, Math.round((audioAssets || 1) * 2));
}

function splitSections(text, { sectionLimit = SECTION_LIMIT_CHARS } = {}) {
  const paragraphs = text.split(/\n{2,}/);
  const sections = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > SECTION_LIMIT_CHARS) {
      sections.push(current);
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }
  if (current.trim()) sections.push(current);
  return sections;
}

async function cleanText(raw, courseContext, job) {
  const system =
    "You are Sua, a text cleaner for Ghanaian university lecture material on " +
    courseContext +
    ". Remove filler words and speech artifacts, fix obvious technical-term " +
    "mishearings using the course name as context, and normalise paragraphs with " +
    "markdown headings where obvious. Never invent content and never summarise — " +
    "every stated fact must survive. Output only the cleaned text.";
  const source = raw.length <= CLEAN_CHUNK_CHARS ? [raw] : splitSections(raw);
  const cleaned = [];
  for (const section of source) {
    const result = await openRouterChat({
      system,
      user: section,
      model: bulkModel(),
      temperature: 0,
    });
    await recordAiCall(job.id, "cleanup", result);
    cleaned.push(result.text);
  }
  return cleaned.join("\n\n");
}

// ---------------------------------------------------------------------------
// Generation + validation
// ---------------------------------------------------------------------------

const REQUIRED_SECTIONS = {
  Overview: "overview",
  "Key Points": "keyPoints",
  "Key Terms": "keyTerms",
  "Likely Exam Questions": "examQuestions",
};

function studySetPrompt({ courseContext, durationMinutes, reduceNote = "" }) {
  const cardTarget = Math.min(25, Math.max(10, Math.round((durationMinutes / 60) * 10 + 10)));
  return `Lecture course context: ${courseContext}
${reduceNote}
From the lecture material below, produce a study set as a single JSON object:
{
  "summary": {
    "overview": "2-4 sentence overview",
    "keyPoints": ["...", "..."],
    "keyTerms": [{"term": "...", "definition": "..."}],
    "formulasExamples": ["... (omit the key entirely if none exist)"],
    "examQuestions": ["...", "..."]
  },
  "flashcards": [{"front": "...", "back": "..."}],
  "quiz": [
    {"type": "mcq", "prompt": "...", "options": ["A", "B", "C", "D"], "answer": "A", "explanation": "..."},
    {"type": "true_false", "prompt": "statement...", "answer": "True", "explanation": "..."},
    {"type": "short_answer", "prompt": "...", "answer": "...", "explanation": "..."}
  ]
}
Rules:
- The summary must contain Overview, Key Points, Key Terms and Likely Exam Questions.
- Flashcards: target ${cardTarget} cards (about 10-25 per lecture hour); the front asks, the back answers concisely.
- Quiz: 5-10 questions mixing mcq, true_false and short_answer. Every question has an explanation. For mcq the answer is the exact option text.
- Use only what the lecture teaches. Keep technical terms exact.
Return ONLY the JSON object.`;
}

function parseStudySetJson(text) {
  const trimmed = text.replace(/```json|```/g, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function validateStudySet(set) {
  if (!set || !set.summary || !Array.isArray(set.flashcards) || !Array.isArray(set.quiz)) {
    return "missing summary/flashcards/quiz";
  }
  for (const [heading, key] of Object.entries(REQUIRED_SECTIONS)) {
    if (!set.summary[key]) return `summary missing ${heading}`;
  }
  if (set.flashcards.length < 5) return "too few flashcards";
  if (set.quiz.length < 3) return "too few quiz questions";
  const validTypes = new Set(["mcq", "true_false", "short_answer"]);
  for (const question of set.quiz) {
    if (!validTypes.has(question.type) || !question.prompt || !question.answer) {
      return "malformed quiz question";
    }
    if (
      question.type === "mcq" &&
      (!Array.isArray(question.options) || question.options.length < 2)
    ) {
      return "mcq question missing options";
    }
  }
  return null;
}

export async function generateStudySet({ cleaned, courseContext, durationMinutes, jobId, reduceNote }) {
  const prompt = studySetPrompt({ courseContext, durationMinutes, reduceNote });
  const attempt = async (stricter) => {
    const result = await openRouterChat({
      system: stricter
        ? "You are Sua, a study assistant for African university students. Output ONLY valid JSON matching the requested schema exactly — no prose, no code fences."
        : "You are Sua, a study assistant for African university students. You are an AI " +
          "study tool, not the student's lecturer; students verify important facts against " +
          "their textbook. Output only valid JSON.",
      user: `${prompt}\n\n=== LECTURE MATERIAL ===\n${cleaned}`,
      model: bulkModel(),
      json: true,
      maxTokens: 8192,
      temperature: stricter ? 0 : 0.2,
    });
    await recordAiCall(jobId, stricter ? "generate_study_set_retry" : "generate_study_set", result);
    const set = parseStudySetJson(result.text);
    const problem = validateStudySet(set);
    return { result, set, problem };
  };

  let outcome = await attempt(false);
  if (outcome.problem) {
    // One stricter retry before giving up (PRD quality rule).
    outcome = await attempt(true, outcome.problem);
    if (outcome.problem) {
      throw new Error(
        `Generated study set failed validation (${outcome.problem}). Tap Try again.`,
      );
    }
  }
  outcome.set.summaryMarkdown = summaryToMarkdown(outcome.set);
  return outcome.set;
}

function summaryToMarkdown(summary) {
  const lines = ["## Overview", char(summary.overview), "", "## Key Points"];
  for (const point of summary.keyPoints ?? []) lines.push(`- ${point}`);
  lines.push("", "## Key Terms");
  for (const term of summary.keyTerms ?? []) lines.push(`- **${term.term}** — ${term.definition}`);
  if ((summary.formulasExamples ?? []).length) {
    lines.push("", "## Formulas & Examples");
    for (const item of summary.formulasExamples) lines.push(`- ${item}`);
  }
  lines.push("", "## Likely Exam Questions");
  for (const [index, question] of (summary.examQuestions ?? []).entries()) {
    lines.push(`${index + 1}. ${question}`);
  }
  return lines.join("\n");
}

async function persistStudySet(job, note, set) {
  await withUser(job.user.clerkId, (tx) =>
    tx.$transaction(async (inner) => {
      await inner.note.update({
        where: { id: note.id },
        data: { summary: set.summaryMarkdown },
      });
      // Regeneration replaces, never duplicates.
      await inner.flashcard.deleteMany({ where: { noteId: note.id } });
      await inner.flashcard.createMany({
        data: (set.flashcards ?? []).map((card) => ({
          userId: job.userId,
          noteId: note.id,
          courseId: note.courseId,
          front: String(card.front).slice(0, 2000),
          back: String(card.back).slice(0, 4000),
        })),
      });
      const oldQuizzes = await inner.quiz.findMany({
        where: { noteId: note.id },
        select: { id: true },
      });
      if (oldQuizzes.length) {
        await inner.quizQuestion.deleteMany({
          where: { quizId: { in: oldQuizzes.map((quiz) => quiz.id) } },
        });
        await inner.quiz.deleteMany({ where: { noteId: note.id } });
      }
      const quiz = await inner.quiz.create({
        data: {
          userId: job.userId,
          courseId: note.courseId,
          noteId: note.id,
          title: `${note.title || "Untitled note"} quiz`,
        },
      });
      await inner.quizQuestion.createMany({
        data: (set.quiz ?? []).map((question, index) => ({
          quizId: quiz.id,
          ordinal: index + 1,
          type: question.type,
          prompt: String(question.prompt).slice(0, 4000),
          options: question.options ? question.options.map(String) : null,
          answer: String(question.answer).slice(0, 2000),
          explanation: String(question.explanation ?? "").slice(0, 4000),
        })),
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Document → lecture note / course reference generation
// ---------------------------------------------------------------------------

// Material bound to one writing call; multiple parts continue one document.
const NOTE_PART_CHARS = 12_000;
const NOTE_MIN_CHARS = 400;
const NOTE_BODY_MAX_CHARS = 100_000;

const LECTURE_SYSTEM =
  "You are Sua, a study assistant for African university students. You are an AI " +
  "study tool, not the student's lecturer; students verify important facts against " +
  "their textbook.";

export async function generateLectureNote({ cleaned, courseContext, jobId }) {
  const parts = splitSections(cleaned, { sectionLimit: NOTE_PART_CHARS });
  const bodyIntro =
    `Course context: ${courseContext}. Write the material into a complete,` +
    " well-structured lecture note in markdown:\n" +
    "- H2 (##) for major sections matching how the material is organised; H3 for subtopics.\n" +
    "- Clear flowing explanations (short paragraphs), worked examples, and bulleted lists where they help.\n" +
    "- Preserve every fact, term, formula and example the material teaches; keep technical terms exact.\n" +
    "- Use only what the material contains. Never invent extra content.\n" +
    "- Return markdown only, no preamble.";

  const generated = [];
  for (const [index, part] of parts.entries()) {
    // Long lectures are written part by part; feed the tail of the previous
    // part so the model continues the same structure instead of restarting it.
    const tail =
      generated.length > 0
        ? generated[generated.length - 1].slice(-900).trim()
        : "";
    const partHeader =
      parts.length > 1
        ? `This is part ${index + 1}/${parts.length} of one long material. Continue the note seamlessly from the previous parts — keep the markdown heading structure coherent, do not repeat headings.` +
          (tail ? `\nThe previous part ended with:\n"""\n${tail}\n"""\nContinue from there.` : "")
        : "";
    const result = await openRouterChat({
      system: LECTURE_SYSTEM,
      user: `${bodyIntro}\n${partHeader}\n\n=== SOURCE MATERIAL (part ${index + 1}/${parts.length}) ===\n${part}`,
      model: bulkModel(),
      temperature: 0.2,
      maxTokens: 8192,
    });
    await recordAiCall(jobId, "note_part", result);
    if (char(result.text)) generated.push(char(result.text));
  }

  const body = generated.join("\n\n");
  if (body.length < NOTE_MIN_CHARS) {
    throw new Error(
      "Generated lecture note was too short. Tap Try again.",
    );
  }
  if (!/^##\s/m.test(body)) {
    throw new Error(
      "Generated lecture note had no sections. Tap Try again.",
    );
  }
  return body.slice(0, NOTE_BODY_MAX_CHARS);
}

const REFERENCE_SCHEMA = `{
  "overview": "1-3 sentences on what this material covers",
  "keyTerms": [{"term": "...", "definition": "..."}],
  "formulas": ["...(omit the key entirely if none exist)"],
  "keyFacts": ["... must-know facts, all carried over from the material"],
  "focusAreas": ["... where revision time should go (omit if unclear)"]
}`;

function referenceToMarkdown(reference) {
  const lines = ["## Overview", char(reference.overview), "", "## Key Terms"];
  for (const term of reference.keyTerms ?? []) {
    lines.push(`- **${char(term.term)}** — ${char(term.definition)}`);
  }
  const formulas = reference.formulas ?? [];
  if (formulas.length) {
    lines.push("", "## Formulas");
    for (const formula of formulas) lines.push(`- ${formula}`);
  }
  lines.push("", "## Must-Know Facts");
  for (const fact of reference.keyFacts ?? []) lines.push(`- ${fact}`);
  if ((reference.focusAreas ?? []).length) {
    lines.push("", "## Where to Focus");
    for (const area of reference.focusAreas) lines.push(`- ${area}`);
  }
  return lines.join("\n");
}

function validateReference(reference, minTerms = 3) {
  if (!reference || !char(reference.overview)) return "missing overview";
  const keyTerms = reference.keyTerms ?? [];
  if (keyTerms.length < minTerms) return "too few key terms";
  for (const term of keyTerms) {
    if (!char(term?.term) || !char(term?.definition)) return "malformed key term";
  }
  const keyFacts = reference.keyFacts ?? [];
  if (keyFacts.length < 1) return "no key facts";
  return null;
}

export async function generateReference({ cleaned, courseContext, jobId }) {
  // A single photographed slide rarely carries three distinct terms; keep the
  // bar high for real lecture material and low for short sources.
  const minTerms = cleaned.length < 2000 ? 1 : 3;
  const prompt =
    `Course context: ${courseContext}\nFrom the lecture material below, produce a compact ` +
    "course reference sheet as a single JSON object:\n" +
    REFERENCE_SCHEMA +
    "\nRules:\n" +
    "- Everything must come from the material itself; keep technical terms exact.\n" +
    "- Key terms: 3-20 with crisp one-line definitions.\n" +
    "- Include every formula the material states.\n" +
    "- Return ONLY the JSON object.";
  const attempt = async (stricter) => {
    const result = await openRouterChat({
      system: stricter
        ? "Output ONLY valid JSON matching the requested schema exactly — no prose, no code fences."
        : LECTURE_SYSTEM + " Output only valid JSON.",
      user: `${prompt}\n\n=== MATERIAL ===\n${cleaned}`,
      model: bulkModel(),
      json: true,
      maxTokens: 4096,
      temperature: stricter ? 0 : 0.2,
    });
    await recordAiCall(jobId, stricter ? "generate_reference_retry" : "generate_reference", result);
    const reference = parseStudySetJson(result.text);
    const problem = validateReference(reference, minTerms);
    return { reference, problem };
  };

  let outcome = await attempt(false);
  if (outcome.problem) {
    outcome = await attempt(true);
    if (outcome.problem) {
      throw new Error(
        `Generated reference failed validation (${outcome.problem}). Tap Try again.`,
      );
    }
  }
  return referenceToMarkdown(outcome.reference);
}

/**
 * Pick up a finished upload whose note just arrived server-side (or vice
 * versa): when a note exists, has an active asset the student marked for AI
 * conversion, and the extraction has produced text, enqueue the conversion
 * job once. Runs in the caller's identity context, idempotent across
 * repeated syncs. Returns the created job or null.
 */
export async function maybeEnqueueGeneration(clerkId, noteId) {
  if (!studyQueueConfigured() || !process.env.DATABASE_URL || !aiConfigured()) {
    return null;
  }
  const job = await withUser(clerkId, async (tx) => {
    const note = await tx.note.findFirst({
      where: { id: noteId },
      include: { jobs: true, assets: true },
    });
    if (!note) return null;
    // One conversion per requested destination: dedupe on active work and on
    // a job that already produced this kind for the note. A completed
    // study_set must not block a later lecture_note or reference conversion.
    const active = note.jobs.some(
      (row) => row.state === "queued" || row.state === "running",
    );
    if (active) return null;
    // Images and audio start with no extracted text (OCR/transcription happens
    // inside the job), so their conversions trigger immediately; documents wait for extraction.
    const asset = note.assets
      .filter(
        (row) =>
          row.status === "active" &&
          (row.task === "lecture_note" || row.task === "course_reference") &&
          (row.kind === "image" ||
            row.kind === "audio" ||
            (row.extractedText ?? "").length > 0),
      )
      .find((row) => !note.jobs.some((job) => job.kind === row.task));
    if (!asset) return null;
    const created = await tx.job.create({
      data: { userId: note.userId, noteId: note.id, kind: asset.task },
    });
    await tx.note.update({
      where: { id: note.id },
      data: { aiState: "queued" },
    });
    return created;
  });
  if (!job) return null;
  try {
    await enqueueStudyJob(job.id);
  } catch (error) {
    console.warn(
      `enqueue failed for generation job ${job.id}: ${error?.message ?? error}`,
    );
  }
  return job;
}

// ---------------------------------------------------------------------------
// Usage, cost, notifications
// ---------------------------------------------------------------------------

async function bumpUsage(userId, kind = "study_set") {
  const month = monthKey();
  if (kind === "course_reference") {
    await prisma.usage.upsert({
      where: { userId_month: { userId, month } },
      update: { references: { increment: 1 } },
      create: { userId, month, references: 1 },
    });
    return;
  }
  await prisma.usage.upsert({
    where: { userId_month: { userId, month } },
    update: { summaries: { increment: 1 }, studySets: { increment: 1 } },
    create: { userId, month, summaries: 1, studySets: 1 },
  });
}

async function checkDailySpend() {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const result = await prisma.aiCall.aggregate({
    _sum: { usdMicros: true },
    where: { createdAt: { gte: day } },
  });
  const ghs = maybeGhs(result._sum.usdMicros ?? 0);
  if (ghs > DAILY_SPEND_ALERT_GHS) {
    console.warn(
      `[AI SPEND ALERT] Today's AI spend is GHS ${ghs.toFixed(2)}, over the GHS ${DAILY_SPEND_ALERT_GHS} threshold.`,
    );
  }
}

async function finishJob(job, hash) {
  await withUser(job.user.clerkId, (tx) =>
    tx.$transaction([
      tx.job.update({
        where: { id: job.id },
        data: {
          state: "done",
          stage: "ready",
          sourceHash: hash,
          finishedAt: new Date(),
          error: null,
        },
      }),
      tx.note.update({ where: { id: job.noteId }, data: { aiState: "ready" } }),
    ]),
  );
}

// Expo Push: fire-and-forget (a failed notification must never fail the job).
const NOTIFY_COPY = {
  study_set: {
    title: "Your study set is ready",
    body: (note) => `${note.title || "Your note"} now has a summary, flashcards and a quiz.`,
  },
  lecture_note: {
    title: "Your lecture note is ready",
    body: (note) => `${note.title || "Your note"} now has a full note, summary, flashcards and a quiz.`,
  },
  course_reference: {
    title: "Your course reference is ready",
    body: (note) => `${note.title || "Your upload"} was saved to your course reference.`,
  },
};

async function notifyStudent(job, note) {
  const copy = NOTIFY_COPY[job.kind] ?? NOTIFY_COPY.study_set;
  const tokens = await prisma.pushToken.findMany({ where: { userId: job.userId } });
  if (!tokens.length) return;
  const messages = tokens.slice(0, 100).map((row) => ({
    to: row.token,
    title: copy.title,
    body: copy.body(note),
    sound: "default",
  }));
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
    if (!response.ok) console.warn(`Expo push failed (${response.status})`);
  } catch (error) {
    console.warn(`Expo push errored (job still complete): ${error?.message ?? error}`);
  }
}

/** Warn-only cap check; returns a warning string or null. */
export async function warnIfOverCaps(userId) {
  const usage = await prisma.usage.findFirst({ where: { userId, month: monthKey() } });
  if (!usage) return null;
  if (usage.summaries > FREE_MONTHLY_LIMITS.summaries) {
    return `Free plan: ${usage.summaries} summaries this month (limit ${FREE_MONTHLY_LIMITS.summaries})`;
  }
  if (usage.studySets > FREE_MONTHLY_LIMITS.studySets) {
    return `Free plan: ${usage.studySets} study sets this month (limit ${FREE_MONTHLY_LIMITS.studySets})`;
  }
  if (usage.references > FREE_MONTHLY_LIMITS.references) {
    return `Free plan: ${usage.references} course references this month (limit ${FREE_MONTHLY_LIMITS.references})`;
  }
  return null;
}
