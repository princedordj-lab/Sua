import { prisma } from "../config/prisma.js";
import { notifyUser } from "./push.js";
import {
  computeRunStreak,
  dayDiff,
  dayKeyInTimeZone,
  isDayKey,
  streakView,
} from "./streak-rules.js";

const HISTORY_LIMIT = 400;

export function streakViewForUser(user, now = new Date()) {
  return streakView(user, now);
}

/**
 * Record open days for one user and recompute the cached run. `days` may hold
 * offline backfills; today in the supplied timezone is always included so a
 * stale queue can never turn a returning student into a reset.
 */
export async function recordActiveDays(
  tx,
  userId,
  days,
  timezone,
  now = new Date(),
  today = dayKeyInTimeZone(now, timezone || "UTC"),
) {
  const timeZone = timezone || "UTC";
  const unique = [...new Set([today, ...(days ?? []).filter(isDayKey)])].sort();

  // Concurrent pings (shell + page loaders) must not recompute interleaved.
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;

  await tx.userActiveDay.createMany({
    data: unique.map((day) => ({ userId, day })),
    skipDuplicates: true,
  });

  const rows = await tx.userActiveDay.findMany({
    where: { userId },
    select: { day: true },
    orderBy: { day: "desc" },
    take: HISTORY_LIMIT,
  });

  const run = computeRunStreak(rows.map((row) => row.day));
  const user = await tx.user.update({
    where: { id: userId },
    data: {
      streakDays: run.streakDays,
      lastActiveDay: run.lastActiveDay,
      streakTimezone: timeZone,
      streakWarningSentFor: null,
    },
    select: { streakDays: true, lastActiveDay: true, streakTimezone: true },
  });

  // Keep only the window the recompute reads; no run can span more days than
  // that, so this never changes a computed streak.
  const cutoffDay = new Date(
    Date.parse(`${today}T00:00:00Z`) - HISTORY_LIMIT * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  await tx.userActiveDay.deleteMany({
    where: { userId, day: { lt: cutoffDay } },
  });

  return streakView(user, now);
}

/**
 * Daily inactivity sweep, called from the jobs tick. A two-day absence sends a
 * warning once; a three-day absence clears the streak and sends one reset
 * notice. Every update is conditional on the snapshot's `lastActiveDay`, so an
 * open that lands while the sweep runs wins instead of being overwritten — the
 * row simply stops matching and no notice is sent. The per-user push calls are
 * bounded by `budgetMs`; whatever is left waits for the next tick.
 */
export async function sendStreakNotices({
  now = new Date(),
  limit = 500,
  budgetMs = 45_000,
} = {}) {
  let rows = [];
  try {
    rows = await prisma.user.findMany({
      where: { lastActiveDay: { not: null }, streakDays: { gt: 0 } },
      select: {
        id: true,
        streakDays: true,
        lastActiveDay: true,
        streakTimezone: true,
        streakWarningSentFor: true,
      },
      orderBy: { lastActiveDay: "asc" },
      take: Math.min(1000, Math.max(1, limit)),
    });
  } catch (error) {
    console.warn(`Streak sweep skipped: ${error?.message ?? error}`);
    return { checked: 0, warned: 0, reset: 0, failed: 0, pending: 0 };
  }

  const deadline = Date.now() + Math.max(1_000, budgetMs);
  let checked = 0;
  let warned = 0;
  let reset = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    checked += 1;
    try {
      const lastActiveDay = row.lastActiveDay;
      if (!lastActiveDay) continue;
      const today = dayKeyInTimeZone(now, row.streakTimezone || "UTC");
      const gap = dayDiff(today, lastActiveDay);

      if (gap >= 3) {
        const { count } = await prisma.user.updateMany({
          where: { id: row.id, lastActiveDay },
          data: { streakDays: 0, lastActiveDay: null, streakWarningSentFor: null },
        });
        if (!count) continue;
        await notifyUser(row.id, {
          title: "Your streak was reset",
          body: "You were away for 3 days, so your streak restarted. Open Sua to begin a new one.",
          mobilePath: "/home",
          webPath: "/app/home",
          tag: "streak-reset",
        });
        reset += 1;
      } else if (gap === 2 && row.streakWarningSentFor !== lastActiveDay) {
        const { count } = await prisma.user.updateMany({
          where: {
            id: row.id,
            lastActiveDay,
            OR: [
              { streakWarningSentFor: null },
              { streakWarningSentFor: { not: lastActiveDay } },
            ],
          },
          data: { streakWarningSentFor: lastActiveDay },
        });
        if (!count) continue;
        await notifyUser(row.id, {
          title: "Keep your streak alive",
          body: `Open Sua today to keep your ${row.streakDays}-day streak.`,
          mobilePath: "/home",
          webPath: "/app/home",
          tag: "streak-warning",
        });
        warned += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`Streak notice failed for ${row.id}: ${error?.message ?? error}`);
    }
  }

  return { checked, warned, reset, failed, pending: rows.length - checked };
}
