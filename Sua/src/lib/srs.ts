// SM-2 lite scheduling, shared conceptually with the server (backend/src/lib/srs.js).
// Keep the constants identical on both sides so review sync converges.

const DAY_MS = 86_400_000;
const RELEARN_DELAY_MS = 10 * 60_000; // "Again" cards come back the same session
const MIN_EASE = 1.3;

export type CardGrade = "again" | "hard" | "good" | "easy";

export type SchedulingState = {
  ease: number;
  intervalDays: number;
  reps: number;
};

export const GRADE_LABELS: { key: CardGrade; label: string }[] = [
  { key: "again", label: "Again" },
  { key: "hard", label: "Hard" },
  { key: "good", label: "Good" },
  { key: "easy", label: "Easy" },
];

/** Timestamp (ms) a freshly graded card is next due. */
export function nextDueMs(card: SchedulingState, grade: CardGrade, nowMs = Date.now()) {
  const { intervalDays } = nextState(card, grade, nowMs);
  if (grade === "again") return nowMs + RELEARN_DELAY_MS;
  return nowMs + intervalDays * DAY_MS;
}

/** Next {ease, intervalDays, reps} for one graded card. */
export function nextState(card: SchedulingState, grade: CardGrade, _nowMs?: number) {
  const ease = card.ease;
  let nextEase = ease;
  let intervalDays = 0;

  if (grade === "again") {
    nextEase = Math.max(MIN_EASE, ease - 0.2);
    intervalDays = 0;
  } else if (grade === "hard") {
    nextEase = Math.max(MIN_EASE, ease - 0.15);
    intervalDays = card.reps === 0 ? 1 : Math.max(1, Math.round(card.intervalDays * 1.2));
  } else if (grade === "good") {
    intervalDays = card.reps === 0 ? 1 : card.reps === 1 ? 6 : Math.round(card.intervalDays * ease);
  } else if (grade === "easy") {
    nextEase = ease + 0.15;
    intervalDays = card.reps === 0 ? 4 : Math.max(6, Math.round(card.intervalDays * ease * 1.3));
  } else {
    throw new Error(`Unknown grade: ${grade satisfies never}`);
  }

  return {
    ease: nextEase,
    intervalDays,
    reps: card.reps + 1,
  };
}
