import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/**
 * Push notifications for "your study set is ready".
 *
 * - Response surfaces: the app foregrounds when a push arrives, so a completed
 *   generation is shown locally even without a server round trip.
 * - Server pushes arrive via Expo Push; registering the device token needs a
 *   development build (expo-notifications has native code, no Expo Go).
 * - Android requires a notification channel.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Non-fatal: notifications are optional and degrade to foreground-only status.
export async function registerForPushAndReport(): Promise<string | null> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      const request = await Notifications.requestPermissionsAsync();
      granted = request.granted;
    }
    if (!granted) return null;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("study", {
        name: "Study updates",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let token = null;
    try {
      token = await Notifications.getDevicePushTokenAsync();
    } catch {
      // Android emulator / Expo Go has no push registration.
      return null;
    }
    const data = token.data;
    if (typeof data !== "string") return null;
    const expoToken = await Notifications.getExpoPushTokenAsync();
    return expoToken.data;
  } catch {
    return null;
  }
}

export async function showStudyReady(body = "Your note now has a summary, flashcards and a quiz.") {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Your study set is ready",
        body,
        sound: true,
      },
      trigger: { channelId: "study", type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1 },
    });
  } catch {
    // Local notification failure is never worth surfacing to the student.
  }
}

// The daily review reminder is scheduled locally (per-device; no server
// round trip). "00:00"-style HH:MM is translated into the next matching
// occurrence, repeating every day. Storage keys live in the settings KV.
export const REVIEW_REMINDER_CHANNEL = "reviews";

export async function ensureReviewReminderChannel() {
  try {
    await Notifications.setNotificationChannelAsync(REVIEW_REMINDER_CHANNEL, {
      name: "Daily reviews",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  } catch {
    // Channel setup is Android-only and non-fatal.
  }
}

export async function scheduleDailyReviewReminder(timeOfDay: string) {
  const [hour = 18, minute = 0] = timeOfDay.split(":").map(Number);
  try {
    const granted = (
      await Notifications.getPermissionsAsync()
    ).granted ||
      (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return false;
    await ensureReviewReminderChannel();
    await Notifications.cancelScheduledNotificationAsync("daily-review");
    await Notifications.scheduleNotificationAsync({
      identifier: "daily-review",
      content: {
        title: "Time to review",
        body: "Your daily cards are due — a few minutes is enough.",
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        channelId: REVIEW_REMINDER_CHANNEL,
        hour: Math.max(0, Math.min(23, hour)),
        minute: Math.max(0, Math.min(59, minute)),
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelDailyReviewReminder() {
  try {
    await Notifications.cancelScheduledNotificationAsync("daily-review");
  } catch {
    // Nothing scheduled / already gone.
  }
}
