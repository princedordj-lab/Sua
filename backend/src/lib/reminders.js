import { prisma } from "../config/prisma.js";
import { notifyUser } from "./push.js";

/**
 * Daily "cards are due" reminder for the web client.
 *
 * Mobile schedules the same reminder locally (offline-first, per device), so
 * this sweep only targets WebPushSubscription rows unless a caller says
 * otherwise. It runs from the jobs tick, which is a single daily cron on the
 * Hobby plan: `reminderTime` is treated as "not before" only when
 * REMINDERS_EXACT_TIME=1 (hourly cron / Pro); otherwise the reminder goes out
 * with the morning check and the UI copy says so.
 */

const MIN_GAP_MS = 20 * 60 * 60 * 1000;

function localHHMM(timezone, now) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  }
}

function isDue(setting, now) {
  if (!setting.remindersEnabled) return false;
  const last = setting.lastReminderSentAt?.getTime() ?? 0;
  if (last && now.getTime() - last < MIN_GAP_MS) return false;
  if (process.env.REMINDERS_EXACT_TIME === "1") {
    return localHHMM(setting.timezone, now) >= setting.reminderTime;
  }
  return true;
}

export async function sendDueReminders({ limit = 200, transports = ["web"] } = {}) {
  const now = new Date();
  let settings = [];
  try {
    settings = await prisma.notificationSetting.findMany({
      where: { remindersEnabled: true },
      take: Math.min(500, Math.max(1, limit)),
      orderBy: { lastReminderSentAt: "asc" },
    });
  } catch (error) {
    // The migration may not have run in a preview environment.
    console.warn(`Reminder sweep skipped: ${error?.message ?? error}`);
    return { checked: 0, sent: 0 };
  }

  let sent = 0;
  for (const setting of settings) {
    if (!isDue(setting, now)) continue;
    let due = 0;
    try {
      due = await prisma.flashcard.count({
        where: { userId: setting.userId, dueAt: { lte: now } },
      });
    } catch (error) {
      console.warn(`Reminder count failed: ${error?.message ?? error}`);
      continue;
    }

    if (due > 0) {
      await notifyUser(setting.userId, {
        title: "Time to review",
        body: `${due} card${due === 1 ? "" : "s"} due — a few minutes is enough.`,
        webPath: "/app/review",
        mobilePath: "/review",
        tag: "daily-review",
        transports,
      });
      sent += 1;
    }

    // Stamp even a zero-due day: without it every tick would re-count the same
    // student all day.
    await prisma.notificationSetting
      .update({
        where: { userId: setting.userId },
        data: { lastReminderSentAt: now, lastDueCount: due },
      })
      .catch(() => {});
  }

  return { checked: settings.length, sent };
}
