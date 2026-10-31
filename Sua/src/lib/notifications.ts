import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

/**
 * Push notifications (Android-first; iOS compiles but is untested until an
 * Apple Developer account + APNs key exist).
 *
 * - Server pushes arrive through Expo Push, so registration needs a
 *   development/release build (expo-notifications has native code; Expo Go
 *   cannot receive Android remote pushes since SDK 53).
 * - Android 13 only shows the permission prompt after a notification channel
 *   exists, so the channel is created before asking (Expo SDK 57 docs).
 * - Registration is explicit: the student turns it on from
 *   profile -> Notifications. Nothing asks on launch.
 * - Everything is non-fatal: denial degrades to local notifications only.
 */

export const STUDY_CHANNEL = "study";
export const REVIEW_REMINDER_CHANNEL = "reviews";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushPermissionState = "granted" | "denied" | "undetermined";

function permissionState(settings: Notifications.NotificationPermissionsStatus): PushPermissionState {
  if (
    settings.granted ||
    settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  ) {
    return "granted";
  }
  const status = settings.status as string;
  return status === "denied" ? "denied" : "undetermined";
}

export async function getPushPermissionState(): Promise<PushPermissionState> {
  try {
    return permissionState(await Notifications.getPermissionsAsync());
  } catch {
    return "undetermined";
  }
}

export async function ensureStudyChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(STUDY_CHANNEL, {
      name: "Study updates",
      description: "When a recording or upload finishes processing.",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
    });
  } catch {
    // Channel setup is Android-only and non-fatal.
  }
}

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

async function getExpoToken(): Promise<string | null> {
  const id = projectId();
  if (!id) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    // No Play services / missing FCM credentials / offline.
    return null;
  }
}

/**
 * Turn this device on: channel -> permission -> Expo token.
 * Returns the token, or null when permission was denied or push is unavailable.
 */
export async function registerForPushAndReport(): Promise<string | null> {
  try {
    await ensureStudyChannel();
    const current = await getPushPermissionState();
    const next =
      current === "granted"
        ? current
        : permissionState(
            await Notifications.requestPermissionsAsync({
              ios: { allowAlert: true, allowBadge: true, allowSound: true },
            }),
          );
    if (next !== "granted") return null;
    return await getExpoToken();
  } catch {
    return null;
  }
}

/**
 * Expo can roll a token while the app runs; the old one stops delivering.
 * The native listener reports a device token, so re-resolve the Expo token.
 */
export function addPushTokenRefreshListener(onToken: (token: string) => void) {
  try {
    return Notifications.addPushTokenListener(() => {
      void getExpoToken().then((token) => {
        if (token) onToken(token);
      });
    });
  } catch {
    return { remove: () => {} };
  }
}

export function openNotificationSettings() {
  void Linking.openSettings().catch(() => {});
}

export async function showStudyReady(body = "Your note now has a summary, flashcards and a quiz.") {
  try {
    await ensureStudyChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Your study set is ready",
        body,
        sound: true,
      },
      trigger: {
        channelId: STUDY_CHANNEL,
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 1,
      },
    });
  } catch {
    // Local notification failure is never worth surfacing to the student.
  }
}

// The daily review reminder is scheduled locally (per-device; no server
// round trip). "00:00"-style HH:MM is translated into the next matching
// occurrence, repeating every day. Storage keys live in the settings KV.
export async function ensureReviewReminderChannel() {
  if (Platform.OS !== "android") return;
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
    const granted =
      (await Notifications.getPermissionsAsync()).granted ||
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
