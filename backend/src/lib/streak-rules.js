// Pure daily-streak rules. No Prisma or network imports so the offline test
// script can exercise the same code the API and sweep use.

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value) {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

export function isValidTimezone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function dayKeyInTimeZone(date, timeZone = "UTC") {
  const tz = isValidTimezone(timeZone) ? timeZone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall through to UTC.
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Day key from a UTC offset in minutes (east positive). Used only when the
 * client's timezone name is unusable — a device whose Intl reports "UTC" while
 * its clock is offset would otherwise have evening opens filed under the
 * previous UTC day. DST is safe because the offset is read at open time.
 */
export function dayKeyForOffset(date, offsetMinutes) {
  const offset = Number(offsetMinutes);
  const safe =
    Number.isInteger(offset) && Math.abs(offset) <= 840 ? offset : 0;
  return new Date(date.getTime() + safe * 60_000).toISOString().slice(0, 10);
}

/** Whole calendar days from `b` to `a` (a - b). */
export function dayDiff(a, b) {
  if (!isDayKey(a) || !isDayKey(b)) return 0;
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * Length of the run ending at the most recent active day. Consecutive active
 * days may be up to two calendar days apart; a gap of three or more ends the
 * run. The count is the number of active days in that run.
 */
export function computeRunStreak(days) {
  const unique = [...new Set((days ?? []).filter(isDayKey))].sort().reverse();
  if (!unique.length) return { streakDays: 0, lastActiveDay: null };
  let streakDays = 1;
  let cursor = unique[0];
  for (let index = 1; index < unique.length; index += 1) {
    if (dayDiff(cursor, unique[index]) > 2) break;
    streakDays += 1;
    cursor = unique[index];
  }
  return { streakDays, lastActiveDay: unique[0] };
}

/**
 * Display view for a cached user row. A missed sweep cannot leak a stale count:
 * a latest active day three or more days old reads as zero.
 */
export function streakView(user, now = new Date()) {
  const timeZone = user?.streakTimezone || "UTC";
  const lastActiveDay = user?.lastActiveDay ?? null;
  if (!lastActiveDay) {
    return { streakDays: 0, activeToday: false, lastActiveDay: null };
  }
  const today = dayKeyInTimeZone(now, timeZone);
  const gap = dayDiff(today, lastActiveDay);
  if (gap >= 3) {
    return { streakDays: 0, activeToday: false, lastActiveDay };
  }
  return {
    streakDays: Math.max(0, Number(user?.streakDays) || 0),
    activeToday: gap === 0,
    lastActiveDay,
  };
}
