import { Router } from "express";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import { processingConfigured, triggerQuizMarking } from "../lib/processing/start.js";
import { lockNote } from "../lib/note-lock.js";
import { nextCardState } from "../lib/srs.js";
import { streakViewForUser } from "../lib/streak.js";
import { dayKeyInTimeZone, isValidTimezone } from "../lib/streak-rules.js";

export const studyRouter = Router();

const GRADES = new Set(["again", "hard", "good", "easy"]);
const DAY_MS = 86_400_000;
const MAX_SYNC_ITEMS = 500;
const MAX_CARD_CHARS = {
  front: 500,
  back: 1500,
};

function requirePipeline(res) {
  if (!processingConfigured()) {
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
// Review sync. The server is the only scheduler: a grade is submitted, replayed
// here through the shared SM-2 transition, and the returned `cards` are the
// truth both clients mirror — which is what makes "what if the other device
// graded it first" a non-question.
//
// Client log ids are the idempotency key and the replay is guarded twice. A log
// whose id already exists never advances a card again: the row alone used to be
// idempotent, so a retried batch spent an extra rep and multiplied the interval
// a second time. A log older than the last one already applied for its card is
// recorded for history but does not move the schedule backwards.
//
// What the 15 s transaction budget pays for is round trips, so a full queue is
// committed in chunks: three batched pre-reads, one update per card the chunk
// actually touched, and one `createMany` for every log it records.
// ---------------------------------------------------------------------------

const REVIEW_CHUNK_LOGS = 25;
// A week of backlog is a student who was offline; a week in the future is a
// skewed clock that would schedule the card beyond any horizon the app shows.
const REVIEWED_AT_PAST_MS = 7 * DAY_MS;
const REVIEWED_AT_FUTURE_MS = 10 * 60_000;

function clampReviewedAt(value, serverTime) {
  const parsed = new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) return serverTime;
  const earliest = serverTime.getTime() - REVIEWED_AT_PAST_MS;
  const latest = serverTime.getTime() + REVIEWED_AT_FUTURE_MS;
  return new Date(Math.min(Math.max(parsed.getTime(), earliest), latest));
}

studyRouter.post("/sync/reviews", async (req, res) => {
  const identity = await identityFromRequest(req);
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, MAX_SYNC_ITEMS) : [];
  if (!logs.length) return res.status(400).json({ error: "logs[] is required" });
  for (const log of logs) {
    if (!log?.id || !log?.cardId || !GRADES.has(log?.grade)) {
      return res.status(400).json({ error: "each log needs id, cardId and a valid grade" });
    }
  }

  // `authenticate` already read this row and every chunk needs it, so the
  // transactional fallback is paid once here rather than once per chunk.
  const user =
    identity.user ??
    (await withUser(identity.clerkId, (tx) => requireUser(tx, identity)));

  const serverTime = new Date();
  const cards = {};
  const applied = [];
  const skipped = [];

  for (let start = 0; start < logs.length; start += REVIEW_CHUNK_LOGS) {
    const chunk = logs.slice(start, start + REVIEW_CHUNK_LOGS);
    const outcome = await withUser(identity.clerkId, async (tx) => {
      const chunkApplied = [];
      const chunkSkipped = [];
      const chunkCards = {};
      const cardIds = [...new Set(chunk.map((log) => String(log.cardId)))];
      const logIds = [...new Set(chunk.map((log) => String(log.id)))];

      // Only cards the student actually owns are processed.
      const ownedById = new Map(
        (
          await tx.flashcard.findMany({
            where: { id: { in: cardIds }, userId: user.id },
            select: { id: true, ease: true, intervalDays: true, reps: true, dueAt: true },
          })
        ).map((card) => [card.id, card]),
      );
      // Pre-reads, not a stale cache: both maps grow as this loop writes, so a
      // duplicate id or a second log for the same card inside one chunk still
      // resolves against what the chunk has already done.
      const seen = new Set(
        (
          await tx.reviewLog.findMany({ where: { id: { in: logIds } }, select: { id: true } })
        ).map((row) => row.id),
      );
      const lastAppliedAt = new Map(
        (
          await tx.reviewLog.groupBy({
            by: ["cardId"],
            // Scoped to this account like every other read here: the watermark is
            // this student's own scheduling history, and the role behind
            // DATABASE_URL still bypasses RLS, so the query is the isolation.
            where: { cardId: { in: cardIds }, userId: user.id },
            _max: { reviewedAt: true },
          })
        ).map((row) => [row.cardId, row._max.reviewedAt]),
      );

      const records = [];
      const writes = [];
      for (const cardId of cardIds) {
        const owned = ownedById.get(cardId);
        const cardLogs = chunk
          .filter((log) => String(log.cardId) === cardId)
          .sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)));

        if (!owned) {
          // Not the student's card: nothing is recorded, because a log here would
          // fail the `review_logs_cardId_fkey` cascade as well as the intent. The
          // client drops the grade and the card it belongs to.
          for (const log of cardLogs) {
            chunkSkipped.push({ id: String(log.id), reason: "not_owned" });
          }
          continue;
        }

        let current = owned;
        for (const log of cardLogs) {
          const id = String(log.id);
          if (seen.has(id)) {
            chunkSkipped.push({ id, reason: "already_applied" });
            continue;
          }
          seen.add(id);
          const reviewedAt = clampReviewedAt(log.reviewedAt, serverTime);
          const previous = lastAppliedAt.get(cardId);
          if (previous && reviewedAt <= previous) {
            // Recorded for history, but the watermark stays where it is: an
            // older grade must never pull a card's schedule backwards, and it
            // must not lower the bar the next log is measured against either.
            records.push(logRecord(user.id, cardId, log, current.intervalDays, reviewedAt));
            chunkSkipped.push({ id, reason: "out_of_order" });
            continue;
          }
          const next = nextCardState(current, String(log.grade), reviewedAt);
          current = { ...current, ...next };
          lastAppliedAt.set(cardId, reviewedAt);
          records.push(logRecord(user.id, cardId, log, next.intervalDays, reviewedAt));
          chunkApplied.push(id);
        }

        // Answer with the card's server state whether or not this chunk moved it,
        // so a client that was told "no" still adopts the authoritative schedule.
        chunkCards[cardId] = {
          id: cardId,
          dueAt: current.dueAt,
          ease: current.ease,
          intervalDays: current.intervalDays,
          reps: current.reps,
        };
        if (current !== owned) {
          writes.push(
            tx.flashcard.update({
              where: { id: cardId },
              data: {
                ease: current.ease,
                intervalDays: current.intervalDays,
                reps: current.reps,
                dueAt: current.dueAt,
              },
            }),
          );
        }
      }

      // `skipDuplicates` keeps a chunk that overlaps another (or a retry that
      // raced this one) from ever recording the same grade twice.
      if (records.length) {
        await tx.reviewLog.createMany({ data: records, skipDuplicates: true });
      }
      await Promise.all(writes);
      return { chunkApplied, chunkSkipped, chunkCards };
    });

    applied.push(...outcome.chunkApplied);
    skipped.push(...outcome.chunkSkipped);
    Object.assign(cards, outcome.chunkCards);
  }

  res.json({ cards, applied, skipped, serverTime });
});

function logRecord(userId, cardId, log, newIntervalDays, reviewedAt) {
  return {
    id: String(log.id),
    userId,
    cardId,
    grade: String(log.grade),
    reviewedAt,
    prevIntervalDays: Number(log.prevIntervalDays) || 0,
    newIntervalDays,
  };
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

  const stored = await withUser(identity.clerkId, async (tx) => {
    const user =
      identity.user ??
      (await requireUser(tx, identity));
    const quizIds = [...new Set(attempts.map((attempt) => String(attempt.quizId)))];
    const owned = new Set(
      (
        await tx.quiz.findMany({
          where: { id: { in: quizIds }, userId: user.id },
          select: { id: true },
        })
      ).map((quiz) => quiz.id),
    );
    const records = attempts
      .filter((attempt) => owned.has(String(attempt.quizId)))
      .map((attempt) => ({
        id: String(attempt.id),
        userId: user.id,
        quizId: String(attempt.quizId),
        startedAt: date(attempt.startedAt),
        finishedAt: date(attempt.finishedAt),
        total: Number(attempt.total) || 0,
        correct: Number(attempt.correct) || 0,
        state: "marked",
        details: attempt.details ?? undefined,
      }));
    // One statement for the whole batch instead of one round trip per attempt.
    // `skipDuplicates` is the same promise the per-row upsert made: an id already
    // on the server is left exactly as it is, so a reconnect retry cannot replace
    // a stored verdict, and it never spends a second transaction.
    if (records.length) {
      await tx.quizAttempt.createMany({ data: records, skipDuplicates: true });
    }
    return records.length;
  });

  res.json({ ok: true, stored });
});

// ---------------------------------------------------------------------------
// Home summary for online clients. Web has no local database, so this small
// read-only aggregate supplies the numbers mobile derives from SQLite — which
// means the day boundaries here have to mean the same thing they do on the
// device. Buckets are keyed on the student's own day, not UTC: a UTC+1 student
// reviewing at 20:00 is "tomorrow" under UTC bucketing, so the two surfaces
// showed a different week every single day. `POST /me/activity` already resolves
// a zone this way, and an unusable zone must never wedge the read.
// ---------------------------------------------------------------------------

/** UTC offset in minutes for `timeZone` at `date`, via the same Intl rule. */
function zoneOffsetMinutes(date, timeZone) {
  if (!isValidTimezone(timeZone)) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "00";
  // "today's date + that wall clock, read as UTC" minus the real instant is the
  // offset. Midnight is spelled "24" by en-GB on some ICU versions.
  const clock = `${part("hour") === "24" ? "00" : part("hour")}:${part("minute")}:${part("second")}`;
  const asUtc = Date.parse(`${dayKeyInTimeZone(date, timeZone)}T${clock}Z`);
  if (Number.isNaN(asUtc)) return 0;
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function dayKeyAtOffset(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

studyRouter.get("/home-summary", async (req, res) => {
  const identity = await identityFromRequest(req);
  const requested = String(req.query?.timezone ?? "").trim();
  const rawOffset = Number(req.query?.utcOffsetMinutes);
  const hasOffset = Number.isInteger(rawOffset) && Math.abs(rawOffset) <= 840;
  const timezone = isValidTimezone(requested) ? requested : "UTC";
  // Same precedence as the streak sync: a usable zone name wins, then the
  // reported offset, then UTC.
  const offsetMinutes =
    timezone === "UTC" ? (hasOffset ? rawOffset : 0) : zoneOffsetMinutes(new Date(), timezone);

  const summary = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const now = new Date();
    const todayKey = dayKeyAtOffset(now, offsetMinutes);
    // Seed the seven buckets from local noon, a day's walk back: midnight and
    // 23:00 are where a DST shift can land you on a neighbouring date, noon is
    // not. The floor for the read is then a generous 24 h earlier — the bucketing
    // below only counts keys it recognises, so a wide floor costs rows, not truth.
    const noonAnchor = Date.parse(`${todayKey}T12:00:00Z`);
    const weekStart = new Date(noonAnchor - 6 * DAY_MS - 12 * 3_600_000);

    const [due, totalCards, logs, attempts] = await Promise.all([
      tx.flashcard.count({
        where: { userId: user.id, retiredAt: null, dueAt: { lte: now } },
      }),
      tx.flashcard.count({ where: { userId: user.id, retiredAt: null } }),
      tx.reviewLog.findMany({
        where: { userId: user.id, reviewedAt: { gte: weekStart } },
        select: { reviewedAt: true, grade: true },
      }),
      tx.quizAttempt.findMany({
        where: { userId: user.id, finishedAt: { gte: weekStart } },
        select: { finishedAt: true },
      }),
    ]);

    const byDay = new Map();
    for (let offset = 6; offset >= 0; offset -= 1) {
      byDay.set(dayKeyAtOffset(new Date(noonAnchor - offset * DAY_MS), offsetMinutes), 0);
    }
    // `graded`/`kept` are the week's recall rate — the same definition the phone
    // computes locally: anything but "again" counts as remembered.
    let graded = 0;
    let kept = 0;
    for (const log of logs) {
      const key = dayKeyAtOffset(log.reviewedAt, offsetMinutes);
      if (!byDay.has(key)) continue;
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
      graded += 1;
      if (log.grade !== "again") kept += 1;
    }
    // Quizzes bucketed by the same recognised keys, so "today" and the week sum
    // cannot disagree with the bars the client just drew.
    let quizzesWeek = 0;
    let quizAttemptsToday = 0;
    for (const attempt of attempts) {
      const key = dayKeyAtOffset(attempt.finishedAt, offsetMinutes);
      if (!byDay.has(key)) continue;
      quizzesWeek += 1;
      if (key === todayKey) quizAttemptsToday += 1;
    }

    // The streak is the synced app-open streak (POST /me/activity keeps it
    // current); the weekly chart keeps reporting actual study activity.
    const streak = streakViewForUser(user, now);

    return {
      due,
      totalCards,
      reviewedToday: byDay.get(todayKey) ?? 0,
      quizAttemptsToday,
      quizzesWeek,
      recallPercent: graded ? Math.round((kept / graded) * 100) : 0,
      streakDays: streak.streakDays,
      streakActiveToday: streak.activeToday,
      streakLastActiveDay: streak.lastActiveDay,
      weekly: [...byDay.entries()].map(([date, reviewed]) => ({ date, reviewed })),
    };
  });
  res.json(summary);
});

// Study sets across every course (the web Study tab has no local SQLite to
// derive them from). Only notes with generated cards or quizzes are returned.
studyRouter.get("/sets", async (req, res) => {
  const identity = await identityFromRequest(req);
  const sets = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const [notes, cardCounts] = await Promise.all([
      tx.note.findMany({
        where: { userId: user.id },
        select: {
          id: true,
          title: true,
          courseId: true,
          updatedAt: true,
          _count: { select: { quizzes: true } },
        },
        orderBy: { updatedAt: "desc" },
      }),
      // One grouped count for every deck at once, and it is the *live* count: a
      // retired (deleted) card must not keep a deck on the list. `_count.select`
      // cannot carry a relation filter in this client, so the count is its own
      // query rather than a flag on the note read.
      tx.flashcard.groupBy({
        by: ["noteId"],
        where: { userId: user.id, retiredAt: null },
        _count: { _all: true },
      }),
    ]);
    const cardsByNote = new Map(cardCounts.map((row) => [row.noteId, row._count._all]));
    return notes
      .map((note) => ({
        noteId: note.id,
        noteTitle: note.title,
        courseId: note.courseId,
        cards: cardsByNote.get(note.id) ?? 0,
        quizzes: note._count.quizzes,
        updatedAt: note.updatedAt,
      }))
      .filter((set) => set.cards > 0 || set.quizzes > 0);
  });
  res.json({ sets });
});

// Due cards across all courses for an online review session. `limit` comes
// from the student's session-length preference (clamped server-side).
// `ahead=N` (days, 1-30) also returns `aheadCards`: cards coming up in that
// window. Mobile offers the same short review-ahead when nothing is due yet;
// the web asks for both in one round trip and picks client-side.
//
// `noteId`/`courseId` scope the queue server-side. Without them a client has to
// take the globally-most-due `limit` cards and filter afterwards, so a deck
// buried below the cut-off answers "nothing due here" while the phone reviews
// those very cards — which is why the filter belongs in the query, not the page.
studyRouter.get("/due", async (req, res) => {
  const identity = await identityFromRequest(req);
  const limit = Math.min(
    50,
    Math.max(5, Number(req.query.limit) || 30),
  );
  const aheadDays = Math.min(30, Math.max(1, Number(req.query.ahead) || 0));
  const noteId = typeof req.query.noteId === "string" && req.query.noteId ? req.query.noteId : null;
  const courseId =
    typeof req.query.courseId === "string" && req.query.courseId ? req.query.courseId : null;
  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const now = new Date();
    const aheadUntil = new Date(now.getTime() + aheadDays * 86_400_000);
    const scope = {
      userId: user.id,
      retiredAt: null,
      ...(noteId ? { noteId } : {}),
      ...(courseId ? { courseId } : {}),
    };
    const [due, cards, aheadCards] = await Promise.all([
      tx.flashcard.count({ where: { ...scope, dueAt: { lte: now } } }),
      tx.flashcard.findMany({
        where: { ...scope, dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: limit,
        include: { note: { select: { title: true } } },
      }),
      aheadDays > 0
        ? tx.flashcard.findMany({
            where: { ...scope, dueAt: { gt: now, lte: aheadUntil } },
            orderBy: { dueAt: "asc" },
            take: limit,
            include: { note: { select: { title: true } } },
          })
        : Promise.resolve([]),
    ]);
    const shape = (card) => ({
      ...shapeCard(card),
      courseId: card.courseId,
      noteTitle: card.note?.title ?? "",
    });
    return {
      due,
      aheadDays,
      cards: cards.map(shape),
      aheadCards: aheadCards.map(shape),
    };
  });
  res.json(outcome);
});

// A single quiz for deep links. The web quiz screen only knows the quiz id, so
// it also gets the note/course context needed for back links.
studyRouter.get("/quizzes/:quizId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const quiz = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const row = await tx.quiz.findFirst({
      where: { id: req.params.quizId, userId: user.id },
      include: {
        questions: { orderBy: { ordinal: "asc" } },
        note: { select: { id: true, title: true, courseId: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      noteId: row.noteId,
      title: row.title,
      noteTitle: row.note?.title ?? "",
      courseId: row.note?.courseId ?? null,
      questions: row.questions.map((question) => ({
        id: question.id,
        quizId: question.quizId,
        ordinal: question.ordinal,
        type: question.type,
        prompt: question.prompt,
        options: question.options,
        answer: question.answer,
        explanation: question.explanation,
      })),
    };
  });
  if (!quiz) return res.status(404).json({ error: "Quiz not found" });
  res.json(quiz);
});

// ---------------------------------------------------------------------------
// Quiz attempt submission. Details carry client-graded MCQ verdicts; short
// answers without verdicts trigger the quiz_marking job (Postgres queue). Idempotent
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
    const user = await requireUser(tx, identity);
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

    // Anything the app cannot grade by tapping needs the marker. Compare
    // against the two tappable types rather than "short_answer", so questions
    // stored with legacy vocabulary ("multiple_choice") are still marked.
    const needsMarking = quiz.questions.some((question) => {
      if (question.type === "mcq" || question.type === "true_false") return false;
      const entry = shaped.find((item) => String(item.questionId) === question.id);
      return entry ? entry.verdict === undefined || entry.verdict === null : true;
    });
    const correct = shaped.filter((entry) => entry.verdict === true).length;

    // Resubmitting a held attempt must never undo a settled result: the app
    // retries pending rows on every flush, and the marker may already be done.
    const existing = await tx.quizAttempt.findUnique({
      where: { id: String(attempt.id) },
      select: { state: true },
    });
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
      update:
        needsMarking && existing?.state !== "marked"
          ? { state: "pending_marking", correct, details: shaped.length ? shaped : undefined }
          : {},
    });
    return {
      attempt: row,
      noteId: quiz.noteId,
      // A settled attempt needs no new marking job, even though the payload
      // still carries unmarked short answers.
      needsMarking: needsMarking && existing?.state !== "marked",
      attemptId: String(attempt.id),
    };
  });

  if (created.error) return res.status(created.status).json({ error: created.error });

  let job = null;
  if (created.needsMarking) {
    // One live marking job per attempt; a stale failed job can be resubmitted.
    // The note row is locked first: a double-submitted attempt (an offline retry
    // racing the first response) would otherwise find no job in both
    // transactions and create two marking jobs for the same attempt.
    job = await withUser(identity.clerkId, async (tx) => {
      const user = await requireUser(tx, identity);
      if (!(await lockNote(tx, created.noteId, user.id))) return null;
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
    if (job) {
      try {
        await triggerQuizMarking(job.id);
      } catch (error) {
        console.warn(`marking trigger failed for job ${job.id}: ${error?.message ?? error}`);
      }
    }
  }

  res.json({ attempt: created.attempt, job: job?.id ?? null });
});

// Polling endpoint while the quiz screen waits for AI marking.
studyRouter.get("/attempts/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const attempt = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
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
    const user = await requireUser(tx, identity);
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
        // Re-adding a card under a retired id revives it rather than silently
        // creating a second card the student cannot see.
        update: { front: fields.front, back: fields.back, retiredAt: null },
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
    const user = await requireUser(tx, identity);
    const card = await tx.flashcard.findFirst({
      where: { id: req.params.cardId, userId: user.id, retiredAt: null },
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
    const user = await requireUser(tx, identity);
    const card = await tx.flashcard.findFirst({
      where: { id: req.params.cardId, userId: user.id, retiredAt: null },
    });
    if (!card) return { error: "Card not found", status: 404 };
    // Soft retire, not delete. The row is what `review_logs` points at, so a hard
    // delete both erases the student's history and makes any review still queued
    // on another device fail the foreign key when it arrives. Retiring keeps the
    // history and takes the card out of study through `retiredAt: null` on reads.
    await tx.flashcard.update({ where: { id: card.id }, data: { retiredAt: new Date() } });
    return { retired: card.id };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ ok: true, id: outcome.retired });
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
