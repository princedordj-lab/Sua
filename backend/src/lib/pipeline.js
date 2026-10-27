import { createHash } from "node:crypto";
import { readAssetBytes } from "./storage.js";
import { withUser } from "./db.js";
import { bulkModel, chatCompletion, aiConfigured } from "./ai.js";
import { enqueueStudyJob, studyQueueConfigured, STALE_QUEUED_MS } from "./queue.js";
import { prepareMaterial, writeNote } from "./note-pipeline.js";
import {
  USER_MESSAGES,
  UserFacingError,
  isUserFacing,
  notePipeline,
} from "../config/ai-pipeline.js";
import { validateStudyPack } from "../config/study-pack-schema.js";
import { prisma } from "../config/prisma.js";

// Material is clamped before it is sent to the model so one giant upload
// cannot overflow the context window (AGENTS.md: 60,000 characters).
export const MAX_NOTE_CHARS = 60_000;

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
export async function processJob(jobId, documentExtraction) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      user: { select: { clerkId: true } },
      note: { include: { course: true, assets: true } },
    },
  });
  if (!job) {
    // Deleting a note cascades its jobs away. Nothing to run, and retrying
    // would only log the same miss three times.
    return;
  }
  if (job.state === "done") return;
  if (job.kind === "course_reference") {
    await processReference(job, documentExtraction);
    return;
  }
  if (job.kind === "quiz_marking") {
    await processQuizMarking(job);
    return;
  }
  await processStudySet(job, documentExtraction);
}

// A note deleted mid-run surfaces as a missing row (P2025) from any later
// write. It is not a retryable failure, so the pipeline closes the job quietly.
class NoteDeletedError extends Error {
  constructor(noteId) {
    super("Note was deleted");
    this.name = "NoteDeletedError";
    this.noteId = noteId;
  }
}

function isNoteGone(error) {
  return error instanceof NoteDeletedError;
}

/**
 * P2025 means "record to update not found" — usually the note, but it could be
 * an asset. Confirm against the note itself before treating the run as deleted.
 */
async function jobTargetDeleted(job, error) {
  if (isNoteGone(error)) return true;
  if (error?.code !== "P2025") return false;
  const note = await withUser(job.user.clerkId, (tx) =>
    tx.note.findFirst({ where: { id: job.noteId }, select: { id: true } }),
  ).catch(() => null);
  return !note;
}

/** Cheap guard so a deleted note stops costing AI calls at the next stage. */
async function assertNoteAlive(job) {
  const note = await withUser(job.user.clerkId, (tx) =>
    tx.note.findFirst({ where: { id: job.noteId }, select: { id: true } }),
  );
  if (!note) throw new NoteDeletedError(job.noteId);
}

async function closeDeletedJob(job) {
  await prisma.job
    .updateMany({
      where: { id: job.id },
      data: {
        state: "failed",
        stage: "failed",
        error: "Note was deleted",
        finishedAt: new Date(),
      },
    })
    .catch(() => {});
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

/**
 * Everything the note pipeline needs from the outside world. All of it runs
 * outside withUser — the pipeline only calls back into the database for short,
 * idempotent writes.
 */
function noteDeps(job, documentExtraction) {
  return {
    record: (step, result) => recordAiCall(job.id, step, result),
    readBytes: (asset) => fetchAssetBytes(asset),
    saveAssetText: (asset, value) =>
      withUser(job.user.clerkId, (tx) =>
        tx.asset.update({
          where: { id: asset.id },
          data: { extractedText: value },
        }),
      ),
    setStage: (stage) => setStage(job, stage),
    assertAlive: () => assertNoteAlive(job),
    ...documentExtraction,
  };
}

async function persistTranscript(job, note, transcript) {
  // Keep the original capture on the note so the student can audit the AI.
  await withUser(job.user.clerkId, (tx) =>
    tx.note.update({ where: { id: note.id }, data: { transcript } }),
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

export async function processStudySet(job, documentExtraction) {
  const { note, user } = job;
  await startAttempt(job);

  try {
    // ---- 1-3. Read, clean, split + digest --------------------------------
    const courseContext = courseContextOf(note);
    const prepared = await prepareMaterial({
      note,
      kind: job.kind,
      courseContext,
      deps: noteDeps(job, documentExtraction),
    });

    // The source hash is known before the expensive write, so a repeat run
    // reuses the existing outputs instead of paying for the strong model.
    const hash = sourceHashOf(prepared.sourceHashInput);
    if (await guardRerun(job, hash)) return;

    let material;
    if (job.kind === "lecture_note") {
      // ---- 4. Write + check the note body --------------------------------
      const written = await writeNote({ prepared, kind: job.kind, courseContext });
      await withUser(user.clerkId, (tx) =>
        tx.note.update({
          where: { id: note.id },
          data: { body: written.body, transcript: written.transcript },
        }),
      );
      // The study set is built from the note the student actually reads.
      material = written.body;
      prepared.meta = written.meta;
    } else {
      await persistTranscript(job, note, prepared.source.transcript);
      material = prepared.material;
    }
    if (material.length > MAX_NOTE_CHARS) {
      material = material.slice(0, MAX_NOTE_CHARS);
    }
    if (material.length < 40) {
      throw new UserFacingError(USER_MESSAGES.unreadable || "Note content is too short (minimum 40 characters required).");
    }

    // ---- 5. Summary, flashcards and quiz ---------------------------------
    await setStage(job, "summarising");
    const studySet = await generateStudySet({
      cleaned: material,
      courseContext,
      durationMinutes: totalAudioMinutes(note),
      jobId: job.id,
    });

    await setStage(job, "making_cards");

    // ---- 6. Persist outputs (replace), usage, spend alert, notify --------
    // Another deletion check: the note may be gone by the time the cards exist.
    await assertNoteAlive(job);
    await persistStudySet(job, note, studySet);
    await bumpUsage(job.userId, job.kind);
    await checkDailySpend();
    await finishJob(job, hash, prepared.meta);
    await notifyStudent(job, note);
  } catch (error) {
    if (await jobTargetDeleted(job, error)) {
      await closeDeletedJob(job);
      return;
    }
    await setFailed(job, error);
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
      const result = await chatCompletion({
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
    await setFailed(job, error);
    throw error;
  }
}

function countCorrect(details) {
  return details.filter((entry) => entry?.verdict === true).length;
}

async function settleMarking(job, attemptId, details, correct) {
  // Whatever the marker never saw (a blank typed answer, a question it skipped)
  // still has to settle as wrong, or the app shows it as "still marking".
  const settled = details.map((entry) =>
    entry && (entry.verdict === undefined || entry.verdict === null)
      ? { ...entry, verdict: false, partial: false, comment: entry.comment ?? "" }
      : entry,
  );
  await withUser(job.user.clerkId, (tx) =>
    tx.quizAttempt.update({
      where: { id: attemptId },
      data: { state: "marked", details: settled, correct },
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

export async function processReference(job, documentExtraction) {
  const { note, user } = job;
  await startAttempt(job);

  try {
    const courseContext = courseContextOf(note);
    const prepared = await prepareMaterial({
      note,
      kind: job.kind,
      courseContext,
      deps: noteDeps(job, documentExtraction),
    });
    const hash = sourceHashOf(prepared.sourceHashInput);
    if (await guardRerun(job, hash)) return;

    const written = await writeNote({ prepared, kind: job.kind, courseContext });
    await assertNoteAlive(job);
    await withUser(user.clerkId, (tx) =>
      tx.note.update({
        where: { id: note.id },
        data: { body: written.body, transcript: written.transcript },
      }),
    );
    await bumpUsage(job.userId, job.kind);
    await checkDailySpend();
    await finishJob(job, hash, written.meta);
    await notifyStudent(job, note);
  } catch (error) {
    if (await jobTargetDeleted(job, error)) {
      await closeDeletedJob(job);
      return;
    }
    await setFailed(job, error);
    throw error;
  }
}

/**
 * Only messages written for the student are stored and shown verbatim. Provider
 * errors (rate limits, timeouts, stack traces) become the standard retry line:
 * the app promises not to charge a failed run, so it must not leak internals.
 */
async function setFailed(job, error) {
  const message = isUserFacing(error)
    ? error.message
    : USER_MESSAGES.generic;
  if (!isUserFacing(error)) {
    console.warn(`Job ${job.id} failed: ${error?.message ?? error}`);
  }
  const data = {
    state: "failed",
    stage: "failed",
    error: message.slice(0, 2000),
    finishedAt: new Date(),
  };
  // Two independent writes: a missing job must not hide the note update, and a
  // deleted note must not throw over the original failure.
  await prisma.job.updateMany({ where: { id: job.id }, data }).catch(() => {});
  await withUser(job.user.clerkId, (tx) =>
    tx.note.updateMany({ where: { id: job.noteId }, data: { aiState: "failed" } }),
  ).catch(() => {});
}

// 2-minute chunks are the source unit; audio minutes ≈ asset count × 2.
function totalAudioMinutes(note) {
  const audioAssets = note.assets.filter((asset) => asset.kind === "audio").length;
  return Math.max(1, Math.round((audioAssets || 1) * 2));
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
  const cardTarget = Math.min(20, Math.max(8, Math.round((durationMinutes / 60) * 10 + 10)));
  return `Lecture course context: ${courseContext}
${reduceNote}
From the lecture material below, produce a complete university study pack conforming to this JSON specification:
{
  "shortSummary": "A 4-6 sentence clear, high-yield overview of the material.",
  "keyTerms": [
    {"term": "key term name", "definition": "concise, accurate definition"}
  ],
  "formulas": ["relevant mathematical, scientific, or logical equations, or empty array [] if none exist"],
  "examQuestions": ["3-6 likely exam or tutorial questions based strictly on the content"],
  "flashcards": [
    {"front": "Active recall question or concept prompt", "back": "Concise, complete answer"}
  ],
  "quiz": [
    {
      "type": "mcq",
      "prompt": "Question prompt testing understanding",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": "Exact text of the correct option",
      "explanation": "One sentence explaining why this option is correct."
    }
  ]
}
Rules:
- shortSummary: 4-6 sentences clear, high-yield overview.
- keyTerms: 5-10 key terms with definitions.
- formulas: relevant formulas/equations, or empty array [] if none exist.
- examQuestions: 3-6 likely exam questions.
- flashcards: ${cardTarget} active recall cards (target 8-20 cards); front asks, back answers concisely.
- quiz: 5-8 multiple-choice questions with 4 options each, an exact matching answer, and a one-sentence explanation.
- Use only what the lecture material teaches. Do not fabricate facts not present in the notes.
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
  const check = validateStudyPack(set);
  if (!check.success) return check.error;
  return null;
}

export async function generateStudySet({
  cleaned,
  courseContext,
  durationMinutes,
  jobId,
  reduceNote,
  record = (step, result) => recordAiCall(jobId, step, result),
}) {
  const prompt = studySetPrompt({ courseContext, durationMinutes, reduceNote });
  const attempt = async (stricter, priorProblem = null) => {
    const result = await chatCompletion({
      system: stricter
        ? "You are Sua, an exam-focused study assistant for African university students. Output ONLY valid JSON matching the requested study pack schema exactly — no prose, no code fences."
        : "You are Sua, an exam-focused study assistant for African university students. Use only the student's notes provided. Write clearly in simple English. Output only valid JSON.",
      user: `${prompt}\n\n=== LECTURE MATERIAL ===\n${cleaned}`,
      model: bulkModel(),
      json: true,
      maxTokens: notePipeline.studySetMaxTokens,
      temperature: stricter ? 0 : 0.2,
    });
    await record(stricter ? "generate_study_set_retry" : "generate_study_set", result);
    const parsed = parseStudySetJson(result.text);
    const validation = validateStudyPack(parsed);
    return {
      result,
      set: validation.success ? validation.data : null,
      problem: validation.success ? null : (validation.error || "Invalid study pack structure"),
    };
  };

  let outcome = await attempt(false);
  if (outcome.problem) {
    // One stricter retry with temperature 0 before failing.
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

function summaryToMarkdown(pack) {
  const lines = ["## Overview", char(pack.shortSummary), ""];
  if ((pack.keyTerms ?? []).length) {
    lines.push("## Key Terms");
    for (const term of pack.keyTerms) lines.push(`- **${term.term}** — ${term.definition}`);
    lines.push("");
  }
  if ((pack.formulas ?? []).length) {
    lines.push("## Formulas & Examples");
    for (const item of pack.formulas) lines.push(`- ${item}`);
    lines.push("");
  }
  if ((pack.examQuestions ?? []).length) {
    lines.push("## Likely Exam Questions");
    for (const [index, question] of pack.examQuestions.entries()) {
      lines.push(`${index + 1}. ${question}`);
    }
  }
  return lines.join("\n").trim();
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
    // A job that was queued but never picked up (worker or Redis down) is dead:
    // it must not block the conversion forever.
    const active = note.jobs.some((row) => {
      if (row.state === "running") return true;
      if (row.state !== "queued") return false;
      if (row.startedAt) return true;
      return Date.now() - row.createdAt.getTime() < STALE_QUEUED_MS;
    });
    if (active) return null;
    // Audio is deliberately absent: a recording is many 2-minute assets, so the
    // server would fire on the first segment. The app enqueues after the last
    // one uploads. Documents without a text layer (scanned PDFs) are included —
    // the job OCRs them instead of waiting for extraction that never comes.
    const asset = note.assets
      .filter(
        (row) =>
          row.status === "active" &&
          (row.task === "lecture_note" || row.task === "course_reference") &&
          (row.kind === "image" || row.kind === "document"),
      )
      // A failed run must not permanently block this destination: the student
      // is allowed to retry a lecture note that died on a model error.
      .find(
        (row) =>
          !note.jobs.some(
            (job) => job.kind === row.task && job.state !== "failed",
          ),
      );
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
    await enqueueStudyJob({
      jobId: job.id,
      noteId: job.noteId,
      userId: job.userId,
      kind: job.kind,
    });
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

async function finishJob(job, hash, meta = null) {
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
          // Diagnostics live on the job so the app can show what the AI read
          // (pages used, truncation, check result) without a schema change.
          ...(meta ? { payload: JSON.stringify(meta) } : {}),
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
