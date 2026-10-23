import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ArrowLeft, CloudUpload, FileText, Sparkles } from "lucide-react-native";
import { router, useFocusEffect } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { useBooleanSetting } from "../../../state/settings";
import { SwitchRow } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { countAudioNotesThisMonth } from "../../../lib/notes";

export default function DataSettings() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const wifiOnly = useBooleanSetting(db, "wifi_only");
  const autoGenerate = useBooleanSetting(db, "auto_generate");
  const [monthlyRecordings, setMonthlyRecordings] = useState<number | null>(
    null,
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      countAudioNotesThisMonth(db)
        .then((count) => {
          if (!cancelled) setMonthlyRecordings(count);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [db]),
  );

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
          Data & AI
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-8">
        <Text className="mt-4 px-1 text-caption font-sans-extrabold text-ink-soft">
          UPLOADS
        </Text>
        <View className="mt-2 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SwitchRow
            Icon={CloudUpload}
            title="Wi-Fi only uploads"
            subtitle="Wait for Wi-Fi before uploading recordings and files. Turn off to also upload on mobile data."
            value={wifiOnly.value}
            onChange={(next) => void wifiOnly.update(next)}
          />
        </View>

        <Text className="mt-5 px-1 text-caption font-sans-extrabold text-ink-soft">
          AI GENERATION
        </Text>
        <View className="mt-2 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SwitchRow
            Icon={Sparkles}
            title="Auto-generate study sets"
            subtitle="Queue summary, flashcards and a quiz every time a note is saved. Turn off to keep generation manual (the note's Generate button still works)."
            value={autoGenerate.value}
            onChange={(next) => void autoGenerate.update(next)}
          />
          <View className="flex-row items-center gap-3 px-card py-3">
            <FileText size={19} color={colors.brand.DEFAULT} />
            <View className="flex-1">
              <Text className="text-body font-sans-bold text-ink">
                Recordings this month
              </Text>
              <Text className="mt-0.5 text-small text-ink-soft">
                Free-plan metering; limits arrive with billing.
              </Text>
            </View>
            <Text className="text-body-lg font-sans-extrabold text-brand">
              {monthlyRecordings ?? "–"}
            </Text>
          </View>
        </View>

        <Text className="mt-5 px-1 text-caption font-sans-extrabold text-ink-soft">
          YOUR DATA
        </Text>
        <View className="mt-2 rounded-card bg-surface p-card shadow-card">
          <Text className="text-body font-sans-bold text-ink">
            Sua never trains on student content
          </Text>
          <Text className="mt-1 text-small leading-5 text-ink-soft">
            Recordings, notes and quiz answers are used only to power your own
            study features — never to train AI models.
          </Text>
          <Text className="mt-3 text-body font-sans-bold text-ink">
            Audio is kept until you delete it
          </Text>
          <Text className="mt-1 text-small leading-5 text-ink-soft">
            Deleting a recording, its note, or your whole account removes the
            audio and every derived summary, card and quiz.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
