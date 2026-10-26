// SM-2 lite, identical to Sua/src/lib/srs.ts and backend/src/lib/srs.js.
// The web is online-only: every grade is posted immediately, then the server's
// scheduling response replaces this optimistic state.

const DAY_MS = 86_400_000;
const RELEARN_DELAY_MS = 10 * 60_000;
const MIN_EASE = 1.3;

import type { CardGrade } from "./types";

export type SchedulingState = {
  ease: number;
  intervalDays: number;
  reps: number;
};

export const GRADE_LABELS: { key: CardGrade; label: string; hint: string }[] = [
  { key: "again", label: "Again", hint: "10 min" },
  { key: "hard", label: "Hard", hint: "Sooner" },
  { key: "good", label: "Good", hint: "On track" },
  { key: "easy", label: "Easy", hint: "Later" },
];

export function nextState(card: SchedulingState, grade: CardGrade) {
  const { ease, intervalDays, reps } = card;
  let nextEase = ease;
  let interval = 0;

  if (grade === "again") {
    nextEase = Math.max(MIN_EASE, ease - 0.2);
    interval = 0;
  } else if (grade === "hard") {
    nextEase = Math.max(MIN_EASE, ease - 0.15);
    interval = reps === 0 ? 1 : Math.max(1, Math.round(intervalDays * 1.2));
  } else if (grade === "good") {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(intervalDays * ease);
  } else {
    nextEase = ease + 0.15;
    interval = reps === 0 ? 4 : Math.max(6, Math.round(intervalDays * ease * 1.3));
  }

  return { ease: nextEase, intervalDays: interval, reps: reps + 1 };
}

export function nextDueMs(card: SchedulingState, grade: CardGrade, nowMs = Date.now()) {
  if (grade === "again") return nowMs + RELEARN_DELAY_MS;
  return nowMs + nextState(card, grade).intervalDays * DAY_MS;
}
