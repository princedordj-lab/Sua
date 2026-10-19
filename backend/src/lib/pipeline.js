import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { cloudinary } from "../config/cloudinary.js";
import { withUser } from "./db.js";
import {
  bulkModel,
  geminiImageText,
  geminiTranscribe,
  openRouterChat,
} from "./ai.js";
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
  const url = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: "restricted",
    sign_url: true,
    secure: true,
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`storage fetch failed (${response.status}) for asset ${asset.id}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
export async function processStudySet(jobId) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      user: { select: { clerkId: true } },
      note: { include: { course: true, assets: true } },
    },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.state === "done") return;

  const { note, user } = job;
  await prisma.job.update({
    where: { id: job.id },
    data: { startedAt: new Date(), attempts: { increment: 1 } },
  });

  try {
    // ---- 1. Assemble the raw source text --------------------------------
    await setStage(job, "transcribing");
    const orderedAssets = note.assets
      .filter((asset) => asset.status === "active" && asset.publicId !== "pending")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const pieces = [];
    const chunks = [];
    if (note.sourceType === "typed" && char(note.body)) {
      pieces.push(char(note.body));
      chunks.push({ kind: "typed" });
    }

    for (const asset of orderedAssets) {
      if (asset.kind === "document" && asset.extractedText) {
        pieces.push(char(asset.extractedText));
        chunks.push({ kind: "document" });
        continue;
      }
      if (asset.kind === "document") {
        const bytes = await fetchAssetBytes(asset);
        pieces.push(char(extractDocumentText(bytes, asset.format, asset.kind) ?? ""));
        chunks.push({ kind: "document" });
        continue;
      }
      if (asset.kind === "image") {
        const bytes = await fetchAssetBytes(asset);
        const ocr = await geminiImageText({ bytes, mimeType: mimeFor(asset) });
        await withUser(user.clerkId, (tx) =>
          tx.asset.update({ where: { id: asset.id }, data: { extractedText: ocr.text } }),
        );
        await recordAiCall(job.id, "ocr", ocr);
        if (ocr.text) {
          pieces.push(char(ocr.text));
          chunks.push({ kind: "image" });
        }
        continue;
      }
      if (asset.kind === "audio") {
        const bytes = await fetchAssetBytes(asset);
        const transcription = await geminiTranscribe({
          bytes,
          mimeType: mimeFor(asset),
          languageHint: "English (may include a Ghanaian university accent)",
        });
        await recordAiCall(job.id, "transcribe", transcription);
        pieces.push(char(transcription.text));
        chunks.push({ kind: "audio" });
      }
    }

    const raw = pieces.filter(Boolean).join("\n\n");
    if (raw.length < 80) {
      throw new Error(
        "No usable source material. Record a longer lecture, upload readable files, or add typed content.",
      );
    }

    // ---- 2. Clean with course context ------------------------------------
    const courseContext = [
      note.course.name,
      note.course.code ? `course code ${note.course.code}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const cleaned = await cleanText(raw, courseContext, job);

    // Keep the original transcript on the note so the student can audit the AI.
    await withUser(user.clerkId, (tx) =>
      tx.note.update({ where: { id: note.id }, data: { transcript: raw } }),
    );

    // Caching: an identical source reuses existing outputs.
    const hash = sourceHashOf(cleaned);
    const priorDone = await prisma.job.findFirst({
      where: { noteId: note.id, state: "done", sourceHash: hash, id: { not: job.id } },
    });
    if (priorDone) {
      await finishJob(job, hash);
      return;
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
    await bumpUsage(job.userId);
    await checkDailySpend();
    await finishJob(job, hash);
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

function splitSections(text) {
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

async function generateStudySet({ cleaned, courseContext, durationMinutes, jobId, reduceNote }) {
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
// Usage, cost, notifications
// ---------------------------------------------------------------------------

async function bumpUsage(userId) {
  const month = monthKey();
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
async function notifyStudent(job, note) {
  const tokens = await prisma.pushToken.findMany({ where: { userId: job.userId } });
  if (!tokens.length) return;
  const messages = tokens.slice(0, 100).map((row) => ({
    to: row.token,
    title: "Your study set is ready",
    body: `${note.title || "Your note"} now has a summary, flashcards and a quiz.`,
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
  return null;
}
