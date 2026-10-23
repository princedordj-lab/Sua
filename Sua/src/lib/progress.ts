// Reviews, quiz attempts and manual card edits are personal study progress:
// they mutate SQLite first and flush to /api/study when connectivity allows.
// Idempotency keys are client ids (review log id / attempt id / card id), so
// retries after a half-completed flush are safe.
import NetInfo from "@react-native-community/netinfo";
import {
  applyDeckScheduling,
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

type DrainDeps = {
  db: import("expo-sqlite").SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
};

export async function flushStudyProgress(deps: DrainDeps) {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return { reviews: 0, cards: 0, attempts: 0 };
  const token = await deps.getAuthToken();
  if (!token) return { reviews: 0, cards: 0, attempts: 0 };

  const reviews = await flushReviews(deps, token);
  await flushReviewsScheduling(deps, token);
  const cards = await flushCardOps(deps, token);
  const attempts = await flushAttempts(deps, token);
  return { reviews, cards, attempts };
}

async function flushReviews(deps: DrainDeps, token: string) {
  const logs = await listUnsyncedReviews(deps.db);
  if (!logs.length) return 0;
  try {
    await studyApi.postReviews(token, logs);
    await markReviewsSynced(deps.db, logs.map((log) => log.id));
    return logs.length;
  } catch {
    return 0;
  }
}

/** Mirror the server's replayed scheduling back onto local cards. */
async function flushReviewsScheduling(deps: DrainDeps, token: string) {
  const sample = await listUnsyncedReviews(deps.db, 1);
  if (!sample.length) return;
  try {
    const result = await studyApi.postReviews(token, sample);
    const cards = result.cards ? Object.values(result.cards) : [];
    if (cards.length) await applyDeckScheduling(deps.db, cards);
  } catch {
    // scheduling mirror is best-effort: grades already synced above
  }
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
        details: attempt.details,
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
