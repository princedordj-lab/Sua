import { bulkModel, chatCompletion, timeoutForDeadline } from "./ai.js";
import { USER_MESSAGES, isUserFacing, notePipeline } from "../config/ai-pipeline.js";
import { validateStudyPack } from "../config/study-pack-schema.js";
import { prisma } from "../config/prisma.js";
import { withUser } from "./db.js";

// Free-plan monthly caps; warn-only until Milestone 5 flips ENFORCE_CAPS on.
export const FREE_MONTHLY_LIMITS = {
  summaries: Number(process.env.FREE_MONTHLY_SUMMARIES ?? 10),
  studySets: Number(process.env.FREE_MONTHLY_SETS ?? 10),
  references: Number(process.env.FREE_MONTHLY_REFERENCES ?? 20),
};

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function char(value) {
  return String(value ?? "").trim();
}

async function recordAiCall(jobId, step, result) {
  try {
    await prisma.aiCall.create({
      data: {
        jobId,
        step,
        model: result.model ?? "unknown",
        promptTokens: result.promptTokens ?? 0,
        completionTokens: result.completionTokens ?? 0,
        usdMicros: result.usdMicros ?? 0,
        durationMs: result.durationMs ?? null,
      },
    });
  } catch (error) {
    // Deleting a note cascades its jobs away. A marking call that was already
    // in flight must not crash on the missing parent row.
    if (error?.code === "P2003" || error?.code === "P2025") return;
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

  // The task owns the job retry counter; keep the Job row in step with it.
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

// ---------------------------------------------------------------------------
// Study pack generation + validation (the eval harness's entry point)
// ---------------------------------------------------------------------------

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
  deadline = null,
  record = (step, result) => recordAiCall(jobId, step, result),
  recordFailure = null,
}) {
  const prompt = studySetPrompt({ courseContext, durationMinutes, reduceNote });
  const attempt = async (stricter, priorProblem = null) => {
    const step = stricter ? "generate_study_set_retry" : "generate_study_set";
    const started = Date.now();
    let result;
    try {
      result = await chatCompletion({
        system: stricter
          ? "You are Sua, an exam-focused study assistant for African university students. Output ONLY valid JSON matching the requested study pack schema exactly — no prose, no code fences."
          : "You are Sua, an exam-focused study assistant for African university students. Use only the student's notes provided. Write clearly in simple English. Output only valid JSON.",
        user: `${prompt}\n\n=== LECTURE MATERIAL ===\n${cleaned}`,
        model: bulkModel(),
        json: true,
        maxTokens: notePipeline.studySetMaxTokens,
        temperature: stricter ? 0 : 0.2,
        timeoutMs: timeoutForDeadline(deadline),
      });
    } catch (error) {
      await recordFailure?.(step, error, Date.now() - started);
      throw error;
    }
    await record(step, result);
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
