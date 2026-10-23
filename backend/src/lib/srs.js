// SM-2 lite transition shared conceptually with the app (src/lib/srs.ts).
// Both sides must keep the same constants so scheduling stays in step.

const DAY_MS = 86_400_000;
const RELEARN_DELAY_MS = 10 * 60_000; // "Again" cards come back the same session
const MIN_EASE = 1.3;

/**
 * Next scheduling state for one graded card. `grade` is again|hard|good|easy.
 * Fresh reps==0 cards step 1d (good/hard) or 4d (easy); consecutive successes
 * then move 6d and interval*ease.
 */
export function nextCardState(card, grade, now = new Date()) {
  const { ease, intervalDays, reps } = card;
  let nextEase = ease;
  let interval = 0;
  let delay = DAY_MS;

  if (grade === "again") {
    nextEase = Math.max(MIN_EASE, ease - 0.2);
    interval = 0;
    delay = RELEARN_DELAY_MS;
  } else if (grade === "hard") {
    nextEase = Math.max(MIN_EASE, ease - 0.15);
    interval = reps === 0 ? 1 : Math.max(1, Math.round(intervalDays * 1.2));
  } else if (grade === "good") {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(intervalDays * ease);
  } else if (grade === "easy") {
    nextEase = ease + 0.15;
    interval = reps === 0 ? 4 : Math.max(6, Math.round(intervalDays * ease * 1.3));
  } else {
    throw new Error(`Unknown grade: ${grade}`);
  }

  const dueAt = new Date(now.getTime() + intervalMs(grade, interval, delay));
  return { ease: nextEase, intervalDays: interval, reps: reps + 1, dueAt };
}

function intervalMs(grade, interval, dayDelay) {
  // "Again" always re-learns in ~10 minutes regardless of its day interval.
  return grade === "again" ? dayDelay : interval * DAY_MS;
}
