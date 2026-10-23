import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";
import { studyQueueConfigured, enqueueStudyJob } from "../lib/queue.js";
import { aiConfigured } from "../lib/ai.js";
import { nextCardState } from "../lib/srs.js";

export const studyRouter = Router();

const GRADES = new Set(["again", "hard", "good", "easy"]);
const DAY_MS = 86_400_000;
const MAX_SYNC_ITEMS = 500;
const MAX_CARD_CHARS = {
  front: 500,
  back: 1500,
};

function requirePipeline(res) {
  if (!studyQueueConfigured() || !process.env.DATABASE_URL || !aiConfigured()) {
    res.status(503).json({ error: "AI processing is not configured" });
    return false;
  }
  return true;
}

function date(value) {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// ---------------------------------------------------------------------------
// Review sync. Client log ids are the idempotency key; the server replays the
// same shared SM-2 transition (`lib/srs.js`) over each card's server state so
// both sides converge. Returns per-card scheduling for the client to mirror.
// ---------------------------------------------------------------------------

studyRouter.post("/sync/reviews", async (req, res) => {
  const identity = await identityFromRequest(req);
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, MAX_SYNC_ITEMS) : [];
  if (!logs.length) return res.status(400).json({ error: "logs[] is required" });
  for (const log of logs) {
    if (!log?.id || !log?.cardId || !GRADES.has(log?.grade)) {
      return res.status(400).json({ error: "each log needs id, cardId and a valid grade" });
    }
  }

  const cards = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    // Only cards the student actually owns are processed.
    const cardIds = [...new Set(logs.map((log) => String(log.cardId)))];
    const owned = new Set(
      (
        await tx.flashcard.findMany({
          where: { id: { in: cardIds }, userId: user.id },
          select: { id: true },
        })
      ).map((card) => card.id),
    );

    // Replay each card's new logs in review order from its server state; write
    // every log idempotently so reconnect retries never double-apply.
    const updated = {};
    for (const cardId of cardIds) {
      if (!owned.has(cardId)) continue;
      let current = await tx.flashcard.findUnique({ where: { id: cardId } });
      for (const log of logs
        .filter((entry) => entry.cardId === cardId)
        .sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)))) {
        current = await withReplay(tx, current, log);
      }
      if (current) {
        updated[cardId] = {
          id: cardId,
          dueAt: current.dueAt,
          ease: current.ease,
          intervalDays: current.intervalDays,
          reps: current.reps,
        };
      }
    }
    return updated;
  });

  res.json({ cards });
});

async function withReplay(tx, card, log) {
  const reviewedAt = date(log.reviewedAt);
  const { ease, intervalDays, reps, dueAt } = nextCardState(
    {
      ease: card.ease,
      intervalDays: card.intervalDays,
      reps: card.reps,
    },
    String(log.grade),
    reviewedAt,
  );
  const updated = await tx.flashcard.update({
    where: { id: card.id },
    data: { ease, intervalDays, reps, dueAt, updatedAt: new Date() },
  });
  await tx.reviewLog.upsert({
    where: { id: String(log.id) },
    create: {
      id: String(log.id),
      userId: card.userId,
      cardId: card.id,
      grade: String(log.grade),
      reviewedAt,
      prevIntervalDays: Number(log.prevIntervalDays) || 0,
      newIntervalDays: intervalDays,
    },
    update: {},
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Quiz attempt sync for fully self-graded (MCQ/true-false) offline attempts.
// `marked` rows are stored as-is; server-owned AI verdicts arrive via
// POST /attempts and are never overwritten here.
// ---------------------------------------------------------------------------

studyRouter.post("/sync/quiz-attempts", async (req, res) => {
  const identity = await identityFromRequest(req);
  const attempts = Array.isArray(req.body?.attempts)
    ? req.body.attempts.slice(0, MAX_SYNC_ITEMS)
    : [];
  if (!attempts.length) return res.status(400).json({ error: "attempts[] is required" });
  for (const attempt of attempts) {
    if (!attempt?.id || !attempt?.quizId) {
      return res.status(400).json({ error: "each attempt needs id and quizId" });
    }
    if (attempt?.state && attempt.state !== "marked") {
      return res.status(400).json({
        error: "only fully graded (marked) attempts sync here — AI-marked ones use POST /attempts",
      });
    }
  }

  await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const quizIds = [...new Set(attempts.map((attempt) => String(attempt.quizId)))];
    const owned = new Set(
      (
        await tx.quiz.findMany({
          where: { id: { in: quizIds }, userId: user.id },
          select: { id: true },
        })
      ).map((quiz) => quiz.id),
    );
    for (const attempt of attempts) {
      if (!owned.has(String(attempt.quizId))) continue;
      await tx.quizAttempt.upsert({
        where: { id: String(attempt.id) },
        create: {
          id: String(attempt.id),
          userId: user.id,
          quizId: String(attempt.quizId),
          startedAt: date(attempt.startedAt),
          finishedAt: date(attempt.finishedAt),
          total: Number(attempt.total) || 0,
          correct: Number(attempt.correct) || 0,
          state: "marked",
          details: attempt.details ?? undefined,
        },
        update: {},
      });
    }
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Quiz attempt submission. Details carry client-graded MCQ verdicts; short
// answers without verdicts trigger the quiz_marking job (BullMQ). Idempotent
// by client-generated attempt id; the marking job dedupes while active.
// ---------------------------------------------------------------------------

studyRouter.post("/attempts", async (req, res) => {
  if (!requirePipeline(res)) return;
  const identity = await identityFromRequest(req);
  const attempt = req.body ?? {};
  if (!attempt.id || !attempt.quizId) {
    return res.status(400).json({ error: "id and quizId are required" });
  }

  const created = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const quiz = await tx.quiz.findFirst({
      where: { id: String(attempt.quizId), userId: user.id },
      include: { questions: { orderBy: { ordinal: "asc" } } },
    });
    if (!quiz) return { error: "Quiz not found", status: 404 };
    if (!quiz.noteId) {
      return { error: "Quizzes without a note cannot be AI-marked", status: 400 };
    }

    const details = Array.isArray(attempt.details) ? attempt.details : [];
    const validQuestionIds = new Set(quiz.questions.map((question) => question.id));
    const shaped = details
      .filter((entry) => entry?.questionId && validQuestionIds.has(String(entry.questionId)))
      .slice(0, quiz.questions.length);

    const needsMarking = quiz.questions.some((question) => {
      if (question.type !== "short_answer") return false;
      const entry = shaped.find((item) => String(item.questionId) === question.id);
      return entry ? entry.verdict === undefined || entry.verdict === null : true;
    });
    const correct = shaped.filter((entry) => entry.verdict === true).length;

    const row = await tx.quizAttempt.upsert({
      where: { id: String(attempt.id) },
      create: {
        id: String(attempt.id),
        userId: user.id,
        quizId: quiz.id,
        startedAt: date(attempt.startedAt),
        finishedAt: date(attempt.finishedAt),
        total: Number(attempt.total) || quiz.questions.length,
        correct,
        state: needsMarking ? "pending_marking" : "marked",
        details: shaped.length ? shaped : undefined,
      },
      update: needsMarking ? { state: "pending_marking", correct, details: shaped.length ? shaped : undefined } : {},
    });
    return {
      attempt: row,
      noteId: quiz.noteId,
      needsMarking,
      attemptId: String(attempt.id),
    };
  });

  if (created.error) return res.status(created.status).json({ error: created.error });

  let job = null;
  if (created.needsMarking) {
    // One live marking job per attempt; a stale failed job can be resubmitted.
    job = await withUser(identity.clerkId, async (tx) => {
      const user = await ensureUser(tx, identity);
      const activeStates = ["queued", "running"];
      const existing = await tx.job.findFirst({
        where: {
          noteId: created.noteId,
          kind: "quiz_marking",
          state: { in: activeStates },
          payload: { contains: created.attemptId },
        },
      });
      if (existing) return existing;
      return tx.job.create({
        data: {
          userId: user.id,
          noteId: created.noteId,
          kind: "quiz_marking",
          stage: "marking",
          payload: JSON.stringify({ attemptId: created.attemptId }),
        },
      });
    });
    try {
      await enqueueStudyJob(job.id);
    } catch (error) {
      console.warn(`enqueue failed for marking job ${job.id}: ${error?.message ?? error}`);
    }
  }

  res.json({ attempt: created.attempt, job: job?.id ?? null });
});

// Polling endpoint while the quiz screen waits for AI marking.
studyRouter.get("/attempts/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const attempt = await withUser(identity.clerkId, async (tx) => {
    await ensureUser(tx, identity);
    return tx.quizAttempt.findUnique({ where: { id: req.params.id } });
  });
  if (!attempt) return res.status(404).json({ error: "Attempt not found" });
  res.json({
    id: attempt.id,
    state: attempt.state,
    correct: attempt.correct,
    total: attempt.total,
    details: attempt.details,
    error: attempt.error,
  });
});

// ---------------------------------------------------------------------------
// Manual flashcards (PRD: students can edit, delete and add cards). Client-
// generated ids keep every call idempotent through offline queues.
// ---------------------------------------------------------------------------

function cardFields(body) {
  const front = String(body?.front ?? "").trim().slice(0, MAX_CARD_CHARS.front);
  const back = String(body?.back ?? "").trim().slice(0, MAX_CARD_CHARS.back);
  if (!front || !back) return null;
  return { front, back };
}

studyRouter.post("/notes/:noteId/cards", async (req, res) => {
  const identity = await identityFromRequest(req);
  const fields = cardFields(req.body);
  if (!req.body?.id) return res.status(400).json({ error: "id is required" });
  if (!fields) return res.status(400).json({ error: "front and back are required" });

  const card = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const note = await tx.note.findFirst({
      where: { id: req.params.noteId, userId: user.id },
    });
    if (!note) return { error: "Note not found", status: 404 };
    return {
      card: await tx.flashcard.upsert({
        where: { id: String(req.body.id) },
        create: {
          id: String(req.body.id),
          userId: user.id,
          noteId: note.id,
          courseId: note.courseId,
          ...fields,
          dueAt: new Date(Date.now() + DAY_MS),
        },
        update: { front: fields.front, back: fields.back },
      }),
    };
  });
  if (card.error) return res.status(card.status).json({ error: card.error });
  res.status(201).json(shapeCard(card.card));
});

studyRouter.patch("/cards/:cardId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const fields = cardFields(req.body);
  if (!fields) return res.status(400).json({ error: "front and back are required" });

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const card = await tx.flashcard.findFirst({
      where: { id: req.params.cardId, userId: user.id },
    });
    if (!card) return { error: "Card not found", status: 404 };
    return {
      card: await tx.flashcard.update({ where: { id: card.id }, data: fields }),
    };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json(shapeCard(outcome.card));
});

studyRouter.delete("/cards/:cardId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const card = await tx.flashcard.findFirst({
      where: { id: req.params.cardId, userId: user.id },
    });
    if (!card) return { error: "Card not found", status: 404 };
    await tx.flashcard.delete({ where: { id: card.id } });
    return { deleted: card.id };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ ok: true, id: outcome.deleted });
});

function shapeCard(card) {
  return {
    id: card.id,
    noteId: card.noteId,
    front: card.front,
    back: card.back,
    dueAt: card.dueAt,
    ease: card.ease,
    intervalDays: card.intervalDays,
    reps: card.reps,
  };
}
