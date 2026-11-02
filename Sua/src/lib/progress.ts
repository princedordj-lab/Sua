// Reviews, quiz attempts and manual card edits are personal study progress:
// they mutate SQLite first and flush to /api/study when connectivity allows.
// Client ids (review log id / attempt id / card id) are the idempotency keys,
// and /sync/reviews enforces them: a log the server has already replayed comes
// back under `skipped`, so retrying a half-completed flush never re-advances a
// card and the reply always carries the authoritative schedule to adopt.
import NetInfo from "@react-native-community/netinfo";
import {
  applyDeckScheduling,
  dropLocalCard,
  listAttemptsWithState,
  listPendingCardOps,
  listUnsyncedReviews,
  markAttemptSynced,
  markCardOpDone,
  markCardOpFailed,
  markReviewsSynced,
  updateAttemptResult,
  type LocalQuizAttempt,
} from "./notes";
import { studyApi } from "./api";
import { deviceTimeZone, deviceUtcOffsetMinutes } from "./streak";
import type { ServerHomeSummary, ServerReviewSyncResponse } from "./types";

type DrainDeps = {
  db: import("expo-sqlite").SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
};

/**
 * Grades per request. The server commits its own chunks, so this only needs to
 * keep one POST from turning into a transaction long enough to expire — and a
 * part-failed queue resumes where it stopped rather than re-paying for grades
 * the server already applied.
 */
const REVIEW_FLUSH_CHUNK = 50;

export async function flushStudyProgress(deps: DrainDeps) {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return { reviews: 0, cards: 0, attempts: 0 };
  const token = await deps.getAuthToken();
  if (!token) return { reviews: 0, cards: 0, attempts: 0 };

  const reviews = await flushReviews(deps, token);
  const cards = await flushCardOps(deps, token);
  const attempts = await flushAttempts(deps, token);
  return { reviews, cards, attempts };
}

async function flushReviews(deps: DrainDeps, token: string) {
  const logs = await listUnsyncedReviews(deps.db);
  if (!logs.length) return 0;
  let settled = 0;

  for (let start = 0; start < logs.length; start += REVIEW_FLUSH_CHUNK) {
    const chunk = logs.slice(start, start + REVIEW_FLUSH_CHUNK);
    let result: ServerReviewSyncResponse;
    try {
      result = await studyApi.postReviews(token, chunk);
    } catch {
      // Capacity or connectivity. Stop here and leave the rest queued: the
      // server applies a log id at most once, so the next burst resumes this
      // queue instead of paying for the same grades twice.
      break;
    }

    // The server is the only scheduler. Adopt whatever it computed for every card
    // it answered for — including a card whose grade it declined to replay. This
    // is the step that used to be dead code: the response was discarded and every
    // card marked synced, so the phone went on believing its own arithmetic about
    // a due date the rest of the account had already moved on from.
    await applyDeckScheduling(deps.db, Object.values(result.cards ?? {}));

    const settledIds = new Set<string>(result.applied ?? []);
    for (const skip of result.skipped ?? []) {
      if (skip.reason === "not_owned") {
        // This device is holding a card the account no longer has. The grade can
        // never be accepted, so forget the card and its history rather than
        // resending a batch the server refuses on every future burst.
        const log = chunk.find((entry) => entry.id === skip.id);
        if (log) await dropLocalCard(deps.db, log.cardId);
        continue;
      }
      // already_applied / out_of_order: recorded, and the schedule already covers
      // it. Nothing left for this row to do.
      settledIds.add(skip.id);
    }

    const ids = chunk.filter((log) => settledIds.has(log.id)).map((log) => log.id);
    if (!ids.length) continue;
    await markReviewsSynced(deps.db, ids);
    settled += ids.length;
  }

  return settled;
}

async function flushCardOps(deps: DrainDeps, token: string) {
  const ops = await listPendingCardOps(deps.db);
  let flushed = 0;
  for (const op of ops) {
    try {
      if (op.op === "create" && op.noteId) {
        await studyApi.createCard(token, op.noteId, {
          id: op.cardId,
          front: op.payload?.front ?? "",
          back: op.payload?.back ?? "",
        });
      } else if (op.op === "update") {
        await studyApi.updateCard(token, op.cardId, {
          front: op.payload?.front ?? "",
          back: op.payload?.back ?? "",
        });
      } else if (op.op === "delete") {
        await studyApi.deleteCard(token, op.cardId);
      }
      await markCardOpDone(deps.db, op.id);
      flushed += 1;
    } catch {
      await markCardOpFailed(deps.db, op.id, "Sync failed — retrying", op.attempts + 1);
    }
  }
  return flushed;
}

async function flushAttempts(deps: DrainDeps, token: string) {
  let flushed = 0;

  // Fully self-graded (MCQ / true-false) attempts just upload for storage.
  const markedLocally = (await listAttemptsWithState(deps.db, ["marked"])).filter(
    (attempt) => !attempt.synced,
  );
  if (markedLocally.length) {
    try {
      await studyApi.postAttempts(
        token,
        markedLocally.map((attempt) => ({
          id: attempt.id,
          quizId: attempt.quizId,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          total: attempt.total,
          correct: attempt.correct,
          details: attempt.details,
        })),
      );
      for (const attempt of markedLocally) await markAttemptSynced(deps.db, attempt.id);
      flushed += markedLocally.length;
    } catch {
      // stays unsynced; the next flush retries
    }
  }

  // Attempts held for AI marking: submit idempotently, then poll the result.
  // marking_failed is left alone here — retrying is a screen-level action so a
  // dead backend cannot churn AI spend silently.
  const held = await listAttemptsWithState(deps.db, ["pending_marking"]);
  for (const attempt of held) {
    try {
      const response = await studyApi.submitAttempt(token, {
        id: attempt.id,
        quizId: attempt.quizId,
        total: attempt.total,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        // Older builds stored the quiz screen's richer detail shape, where the
        // student's answer lived in `userAnswer`; the marker reads `answer`.
        details: attempt.details.map((entry) => {
          const legacy = entry as { userAnswer?: string };
          return {
            questionId: entry.questionId,
            answer: entry.answer ?? legacy.userAnswer ?? undefined,
            verdict: entry.verdict,
          };
        }),
      });
      if (response.attempt.state === "pending_marking") continue;
      await updateAttemptResult(deps.db, {
        id: attempt.id,
        state: response.attempt.state as LocalQuizAttempt["state"],
        correct: response.attempt.correct,
        details: (response.attempt.details ?? []) as LocalQuizAttempt["details"],
        error: null,
      });
      if (response.attempt.state === "marked") {
        await markAttemptSynced(deps.db, attempt.id);
        flushed += 1;
      }
    } catch {
      // server unreachable; retry on the next flush
    }
  }
  return flushed;
}

/**
 * The server's own week, bucketed in this device's timezone — the numbers the
 * web draws, counting reviews made on either surface. Null whenever it cannot
 * answer (offline, no session, a busy server), which is what lets Home and Study
 * fall back to SQLite instead of an empty chart.
 */
export async function loadHomeSummary(
  getAuthToken: () => Promise<string | null>,
): Promise<ServerHomeSummary | null> {
  try {
    const token = await getAuthToken();
    if (!token) return null;
    return await studyApi.homeSummary(token, {
      timezone: deviceTimeZone(),
      utcOffsetMinutes: deviceUtcOffsetMinutes(),
    });
  } catch {
    return null;
  }
}
