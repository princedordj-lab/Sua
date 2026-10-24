import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import {
  Brain,
  ChevronRight,
  Flame,
  MessageCircleQuestion,
  Sparkles,
} from "lucide-react-native";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useApp } from "../../../state/AppContext";
import {
  computeStreak,
  computeWeeklyProgress,
  countDueCards,
  getNextDueAt,
  listStudySetNotes,
  type LocalStudySetRef,
} from "../../../lib/notes";

export default function Study() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const { courses } = useApp();
  const [due, setDue] = useState(0);
  const [nextDue, setNextDue] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [weekly, setWeekly] = useState({
    cardsReviewed: 0,
    recallPercent: 0,
    quizzesTaken: 0,
  });
  const [sets, setSets] = useState<LocalStudySetRef[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const now = new Date().toISOString();
    setDue(await countDueCards(db, now));
    setNextDue(await getNextDueAt(db));
    setStreak(await computeStreak(db));
    setWeekly(await computeWeeklyProgress(db));
    setSets(await listStudySetNotes(db));
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const courseById = new Map(courses.map((course) => [course.id, course]));
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  function nextDueLabel() {
    if (!nextDue) return null;
    const date = new Date(nextDue);
    if (Number.isNaN(date.getTime())) return null;
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) {
      return `Next cards in ${Math.max(1, Math.round((date.getTime() - today.getTime()) / 60000))} min`;
    }
    return `Next cards ${date.toLocaleDateString(undefined, { weekday: "short" })}`;
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerClassName="px-5 pb-8 pt-6"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <Text className="text-small font-sans-bold text-ink-soft">
          Your learning loop
        </Text>
        <Text className="mt-1 text-3xl font-sans-black text-ink">Study</Text>

        <View className="mt-6 rounded-card bg-brand-strong p-card-lg">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Sparkles size={18} color={colors.gold.DEFAULT} />
              <Text className="text-caption font-sans-extrabold text-gold">
                DAILY REVIEW
              </Text>
            </View>
            {streak > 0 ? (
              <View className="flex-row items-center gap-1 rounded-chip bg-black/20 px-2.5 py-1">
                <Flame size={13} color={colors.gold.DEFAULT} />
                <Text className="text-caption font-sans-bold text-ink-inverse">
                  {streak}-day streak
                </Text>
              </View>
            ) : null}
          </View>
          <Text className="mt-3 text-2xl font-sans-black text-ink-inverse">
            {due > 0 ? `${due} card${due === 1 ? "" : "s"} ready.` : "Nothing due right now."}
          </Text>
          <Text className="mt-2 text-body leading-6 text-ink-inverse/80">
            {due > 0
              ? "A focused 15 minutes now keeps your memory fresh."
              : (nextDueLabel() ?? "Generate a study set from any note to start the loop.")}
          </Text>
          <Pressable
            onPress={() => router.push("/review")}
            accessibilityRole="button"
            accessibilityLabel="Start the flashcard review session"
            className="mt-5 min-h-12 items-center justify-center rounded-btn border border-gold bg-brand-light px-5 active:opacity-80"
          >
            <Text className="text-label font-sans-extrabold text-gold">
              {due > 0 ? "Start review" : "Review anyway"}
            </Text>
          </Pressable>
        </View>

        <View className="mt-4 flex-row gap-3">
          <View className="flex-1 items-center rounded-card bg-surface p-card shadow-card">
            <Text className="text-caption font-sans-extrabold text-ink-soft">
              CARDS · 7 DAYS
            </Text>
            <Text className="mt-1 text-body-lg font-sans-black text-ink">
              {weekly.cardsReviewed}
            </Text>
          </View>
          <View className="flex-1 items-center rounded-card bg-surface p-card shadow-card">
            <Text className="text-caption font-sans-extrabold text-ink-soft">
              RECALL
            </Text>
            <Text className="mt-1 text-body-lg font-sans-black text-ink">
              {weekly.recallPercent}%
            </Text>
          </View>
          <View className="flex-1 items-center rounded-card bg-surface p-card shadow-card">
            <Text className="text-caption font-sans-extrabold text-ink-soft">
              QUIZZES
            </Text>
            <Text className="mt-1 text-body-lg font-sans-black text-ink">
              {weekly.quizzesTaken}
            </Text>
          </View>
        </View>

        <View className="mt-8">
          <Text className="text-body-lg font-sans-extrabold text-ink">Study sets</Text>
          {sets.length === 0 ? (
            <View className="mt-3 items-center rounded-card border border-dashed border-line bg-surface px-6 py-10">
              <Brain size={28} color={pv.ink.faint} />
              <Text className="mt-3 text-body-lg font-sans-extrabold text-ink">
                No study sets yet
              </Text>
              <Text className="mt-2 text-center text-small leading-5 text-ink-soft">
                Open any note and tap Generate — Sua makes flashcards and a quiz
                you can review offline.
              </Text>
            </View>
          ) : (
            <View className="mt-3 gap-3">
              {sets.map((set) => {
                const course = courseById.get(set.courseId);
                return (
                  <Pressable
                    key={set.noteId}
                    onPress={() =>
                      router.push({ pathname: "/deck/[id]", params: { id: set.noteId } })
                    }
                    className="flex-row items-center rounded-card bg-surface p-card shadow-card active:opacity-80"
                    accessibilityRole="button"
                    accessibilityLabel={`Study set for ${set.noteTitle || "untitled note"}`}
                  >
                    <View className="h-11 w-11 items-center justify-center rounded-input bg-brand/10">
                      <Brain size={21} color={colors.brand.DEFAULT} />
                    </View>
                    <View className="ml-3 flex-1">
                      <Text numberOfLines={1} className="text-body font-sans-extrabold text-ink">
                        {course?.code ? `${course.code} · ` : ""}
                        {set.noteTitle || "Untitled note"}
                      </Text>
                      <Text className="mt-1 text-small text-ink-soft">
                        {set.flashcardCount} flashcard{set.flashcardCount === 1 ? "" : "s"}
                        {" · "}
                        {set.quizCount} quiz{set.quizCount === 1 ? "" : "zes"}
                      </Text>
                    </View>
                    <ChevronRight size={19} color={pv.ink.faint} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <Pressable
          onPress={() => router.push("/ask-sua")}
          accessibilityRole="button"
          accessibilityLabel="Ask Sua assistant"
          className="mt-6 flex-row items-center rounded-card border border-line bg-surface p-card shadow-card active:opacity-80"
        >
          <View className="h-11 w-11 items-center justify-center rounded-input bg-gold/15">
            <MessageCircleQuestion size={21} color={colors.gold.DEFAULT} />
          </View>
          <View className="ml-3 flex-1">
            <Text className="text-body font-sans-extrabold text-ink">Ask Sua</Text>
            <Text className="mt-1 text-small text-ink-soft">
              Answers from your notes, with citations.
            </Text>
          </View>
          <ChevronRight size={19} color={pv.ink.faint} />
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
