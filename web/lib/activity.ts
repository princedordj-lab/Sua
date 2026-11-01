"use client";

import type { ApiClient } from "./use-api";

/**
 * Reports this browser's daily app open to POST /me/activity. The server owns
 * the streak count; the web only guarantees the day lands at most once, so the
 * app shell and the Home/Study loaders can all call this without double-posting.
 */

const STORAGE_KEY = "sua.activity.v1";

type ActivityGuard = { userId: string; day: string };

export function localDayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

export function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    // Older engines fall back to the server's UTC handling.
  }
  return "UTC";
}

/** Minutes east of UTC (Lagos = 60); used when the zone name is unusable. */
export function browserUtcOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset();
}

function readGuard(): ActivityGuard | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActivityGuard>;
    if (typeof parsed.userId !== "string" || typeof parsed.day !== "string") {
      return null;
    }
    return { userId: parsed.userId, day: parsed.day };
  } catch {
    return null;
  }
}

function writeGuard(guard: ActivityGuard) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(guard));
  } catch {
    // Private-mode storage can be unavailable; the in-memory guard still
    // prevents a second post in this session.
  }
}

let inFlight: Promise<void> | null = null;
let inFlightKey = "";

export function ensureDailyActivity(api: ApiClient, userId: string | null | undefined) {
  if (!userId) return Promise.resolve();
  const today = localDayKey();
  const key = `${userId}:${today}`;
  const guard = readGuard();
  if (guard?.userId === userId && guard.day === today) return Promise.resolve();
  if (inFlight && inFlightKey === key) return inFlight;
  // The guard is written only after success, so a failed request is retried by
  // the next mount instead of being silently skipped for the day.
  const promise = api.streak
    .record({
      days: [],
      timezone: browserTimeZone(),
      utcOffsetMinutes: browserUtcOffsetMinutes(),
    })
    .then(() => writeGuard({ userId, day: today }));
  inFlight = promise;
  inFlightKey = key;
  const clear = () => {
    if (inFlight === promise) {
      inFlight = null;
      inFlightKey = "";
    }
  };
  void promise.then(clear, clear);
  return promise;
}

/** Lets a page render even when the activity request is slow. */
export function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
