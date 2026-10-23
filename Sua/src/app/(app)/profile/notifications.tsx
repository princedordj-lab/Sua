import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ArrowLeft, Bell, Clock3 } from "lucide-react-native";
import { router } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { useApp } from "../../../state/AppContext";
import { useBooleanSetting } from "../../../state/settings";
import { SwitchRow } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePalette } from "../../../state/appearance";
import { getSetting, setSetting } from "../../../lib/notes";
import {
  cancelDailyReviewReminder,
  registerForPushAndReport,
  scheduleDailyReviewReminder,
} from "../../../lib/notifications";
import { profileApi, pushApi } from "../../../lib/api";

const DEFAULT_TIME = "18:00";

const isValidTime = (raw: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim());

export default function NotificationSettings() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const { getAuthToken } = useApp();
  const pushEnabled = useBooleanSetting(db, "push_enabled");
  const reminderOn = useBooleanSetting(db, "review_reminder_enabled");
  const [time, setTime] = useState(DEFAULT_TIME);

  useEffect(() => {
    let cancelled = false;
    getSetting(db, "review_reminder_time")
      .then((stored) => {
        if (!cancelled && stored) setTime(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

  // Push opt-out removes this device's Expo token from the server so the
  // generation-finished announce stops; local pushes (the study-ready
  // foreground banner) continue regardless. Enabling registers again from
  // here: the app-level registration effect only runs at session start.
  const togglePush = useCallback(
    async (next: boolean) => {
      await pushEnabled.update(next);
      if (next) {
        try {
          const expoToken = await registerForPushAndReport();
          const authToken = await getAuthToken();
          if (expoToken && authToken) {
            await setSetting(db, "expo_push_token", expoToken).catch(() => {});
            await pushApi.registerToken(authToken, expoToken).catch(() => {});
          }
        } catch {
          // Silent: the next foreground event retries via the drain points.
        }
        return;
      }
      const expoToken = await getSetting(db, "expo_push_token").catch(() => null);
      if (!expoToken) return;
      try {
        const authToken = await getAuthToken();
        if (authToken) {
          await profileApi.deletePushToken(authToken, expoToken);
        }
        await setSetting(db, "expo_push_token", "").catch(() => {});
      } catch {
        // Offline: the local gate keeps this device from receiving pushes;
        // sign-out unregisters the server row, so this never lingers long.
      }
    },
    [db, getAuthToken, pushEnabled],
  );

  const toggleReminder = useCallback(
    async (next: boolean) => {
      if (next) {
        if (!isValidTime(time)) {
          Alert.alert("Check the time", "Use a 24-hour time like 18:00.");
          await reminderOn.update(false);
          return;
        }
        const scheduled = await scheduleDailyReviewReminder(time.trim());
        if (!scheduled) {
          Alert.alert(
            "Reminder not scheduled",
            "Sua needs notification permission for the daily review reminder.",
          );
          await reminderOn.update(false);
          return;
        }
        await setSetting(db, "review_reminder_time", time.trim()).catch(() => {});
        await reminderOn.update(true);
        return;
      }
      await cancelDailyReviewReminder();
      await reminderOn.update(false);
    },
    [db, reminderOn, time],
  );

  const commitTime = async () => {
    const trimmed = time.trim();
    if (!isValidTime(trimmed)) {
      const stored = (await getSetting(db, "review_reminder_time")) || DEFAULT_TIME;
      setTime(stored);
      if (reminderOn.value) {
        Alert.alert("Check the time", "Use a 24-hour time like 18:00.");
      }
      return;
    }
    await setSetting(db, "review_reminder_time", trimmed).catch(() => {});
    if (reminderOn.value) {
      const scheduled = await scheduleDailyReviewReminder(trimmed);
      if (!scheduled) {
        Alert.alert("Reminder update failed", "Keep the reminder on and try again.");
      }
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
        >
          <ArrowLeft size={20} color={pv.ink.DEFAULT} />
        </Pressable>
        <Text className="flex-1 text-body-lg font-sans-extrabold text-ink">
          Notifications
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-8">
        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SwitchRow
            Icon={Bell}
            title="Study-set ready pushes"
            subtitle="A push when a recording or upload finishes processing on the server."
            value={pushEnabled.value}
            onChange={(next) => void togglePush(next)}
          />
        </View>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SwitchRow
            Icon={Clock3}
            title="Daily review reminder"
            subtitle="A local reminder to clear your due cards. Works offline; scheduled on this device only."
            value={reminderOn.value}
            onChange={(next) => void toggleReminder(next)}
          />
          <View className="px-card pb-3">
            <Text className="text-label font-sans-semibold text-ink-soft">
              Reminder time (24-hour)
            </Text>
            <View className="mt-2 flex-row items-center gap-3">
              <TextInput
                value={time}
                onChangeText={setTime}
                onEndEditing={() => void commitTime()}
                placeholder="18:00"
                placeholderTextColor={pv.ink.faint}
                keyboardType="numbers-and-punctuation"
                inputMode="numeric"
                maxLength={5}
                accessibilityLabel="Daily review reminder time"
                className="h-12 w-28 rounded-input border border-line bg-cream px-4 text-body text-ink"
              />
              <Text className="flex-1 text-small leading-5 text-ink-soft">
                {reminderOn.value
                  ? "Daily at this time. Changes reschedule immediately."
                  : "Turn the reminder on to use this time."}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
