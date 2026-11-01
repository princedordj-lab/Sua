import type { SQLiteDatabase } from "expo-sqlite";
import { streakApi } from "./api";
import { getSetting, setSetting } from "./notes";

/**
 * Daily app-open streak, synced from the server. The device only owns two
 * things: the local days it still has to submit (settings KV, so no SQLite
 * migration) and the last server answer, which lets Home and Study show a
 * truthful number offline. Keys are per account so signing into another
 * student never submits or displays the previous account's days.
 */

export type AppStreak = {
  streakDays: number;
  lastActiveDay: string | null;
  activeToday: boolean;
};

export type CachedStreak = AppStreak & { syncedDay: string | null };

export const EMPTY_APP_STREAK: AppStreak = {
  streakDays: 0,
  lastActiveDay: null,
  activeToday: false,
};

const DAY_MS = 86_400_000;
const PENDING_LIMIT = 60;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function pendingKey(userId: string) {
  return `app_streak_pending:${userId}`;
}

function cacheKey(userId: string) {
  return `app_streak_cache:${userId}`;
}

function isDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY.test(value);
}

export function localDayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

export function deviceTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // Older engines without Intl time zones report UTC, like the server's
    // fallback in lib/streak-rules.js.
  }
  return "UTC";
}

/** Minutes east of UTC right now (Lagos = 60). Lets the server file evening
 * opens under the local day when the engine reports "UTC" for a zone it does
 * not know. */
export function deviceUtcOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset();
}

function dayDiff(a: string, b: string) {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS,
  );
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isDayKey) : [];
  } catch {
    return [];
  }
}

export async function readPendingDays(db: SQLiteDatabase, userId: string) {
  return parseList(await getSetting(db, pendingKey(userId)).catch(() => null));
}

async function writePendingDays(
  db: SQLiteDatabase,
  userId: string,
  days: string[],
) {
  const unique = [...new Set(days.filter(isDayKey))].sort().slice(-PENDING_LIMIT);
  await setSetting(db, pendingKey(userId), JSON.stringify(unique)).catch(() => {});
}

/** Appends today's local day so the queue always contains this open. */
export async function recordAppOpen(
  db: SQLiteDatabase,
  userId: string,
  date = new Date(),
) {
  const today = localDayKey(date);
  const pending = await readPendingDays(db, userId);
  if (pending.includes(today)) return pending;
  const next = [...pending, today].sort().slice(-PENDING_LIMIT);
  await writePendingDays(db, userId, next);
  return next;
}

export async function readCachedStreak(
  db: SQLiteDatabase,
  userId: string,
): Promise<CachedStreak> {
  const raw = await getSetting(db, cacheKey(userId)).catch(() => null);
  if (!raw) return { ...EMPTY_APP_STREAK, syncedDay: null };
  try {
    const parsed = JSON.parse(raw) as Partial<CachedStreak>;
    return {
      streakDays: Math.max(0, Number(parsed.streakDays) || 0),
      lastActiveDay: isDayKey(parsed.lastActiveDay) ? parsed.lastActiveDay : null,
      activeToday: parsed.activeToday === true,
      syncedDay: isDayKey(parsed.syncedDay) ? parsed.syncedDay : null,
    };
  } catch {
    return { ...EMPTY_APP_STREAK, syncedDay: null };
  }
}

async function writeCachedStreak(
  db: SQLiteDatabase,
  userId: string,
  value: CachedStreak,
) {
  await setSetting(db, cacheKey(userId), JSON.stringify(value)).catch(() => {});
}

/**
 * Offline estimate before the server answers: start from the cached run, apply
 * queued days in order (a three-day gap restarts the run), then count today.
 * Mirrors computeRunStreak in backend/src/lib/streak-rules.js.
 */
export function optimisticStreak(
  cache: CachedStreak,
  pending: string[],
  today = localDayKey(),
): AppStreak {
  // A sync already answered for today: the server unioned today in, so queued
  // leftovers are days it counted (a request that landed before the local clear
  // was lost). Applying them again would double-count.
  if (cache.syncedDay === today) {
    return {
      streakDays: cache.streakDays,
      lastActiveDay: cache.lastActiveDay,
      activeToday: cache.lastActiveDay === today,
    };
  }
  let streak = cache.lastActiveDay ? cache.streakDays : 0;
  let cursor = cache.lastActiveDay;
  const queued = [...new Set(pending.filter(isDayKey))].sort();
  for (const day of queued) {
    if (today < day) continue;
    if (!cursor || day <= cursor) continue;
    streak = dayDiff(day, cursor) >= 3 ? 1 : streak + 1;
    cursor = day;
  }
  if (!cursor) {
    streak = 1;
    cursor = today;
  } else if (today > cursor) {
    streak = dayDiff(today, cursor) >= 3 ? 1 : streak + 1;
    cursor = today;
  }
  return {
    streakDays: streak,
    lastActiveDay: cursor,
    activeToday: cursor === today,
  };
}

type SyncOptions = {
  db: SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
  userId: string;
  // Pulls the server's current weather even when this device already reported
  // today (pull-to-refresh), instead of trusting the local cache.
  force?: boolean;
};

let inFlight: { userId: string; promise: Promise<AppStreak | null> } | null =
  null;

async function runSync({
  db,
  getAuthToken,
  userId,
  force = false,
}: SyncOptions): Promise<AppStreak | null> {
  const today = localDayKey();
  const [cache, pending] = await Promise.all([
    readCachedStreak(db, userId),
    readPendingDays(db, userId),
  ]);
  if (!force && pending.length === 0 && cache.syncedDay === today) {
    return cache;
  }
  const token = await getAuthToken().catch(() => null);
  if (!token) return null;
  const submitted = [...pending];
  const response = await streakApi.record(token, {
    days: submitted,
    timezone: deviceTimeZone(),
    utcOffsetMinutes: deviceUtcOffsetMinutes(),
  });
  const value: AppStreak = {
    streakDays: Math.max(0, Number(response.streakDays) || 0),
    activeToday: response.activeToday === true,
    lastActiveDay: isDayKey(response.lastActiveDay)
      ? response.lastActiveDay
      : null,
  };
  await writeCachedStreak(db, userId, { ...value, syncedDay: today });
  // Days queued while this request was in flight stay for the next pass.
  const remaining = await readPendingDays(db, userId);
  await writePendingDays(
    db,
    userId,
    remaining.filter((day) => !submitted.includes(day)),
  );
  return value;
}

/** Posts queued opens and returns the server's streak, or null offline. */
export function syncAppStreak(options: SyncOptions) {
  if (inFlight?.userId === options.userId) return inFlight.promise;
  const promise = runSync(options);
  inFlight = { userId: options.userId, promise };
  const clear = () => {
    if (inFlight?.promise === promise) inFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}
