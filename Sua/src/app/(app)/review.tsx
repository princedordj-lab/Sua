import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Check, Flame, X } from "lucide-react-native";
import { colors } from "../../config/theme";
import { usePalette } from "../../state/appearance";
import { useApp } from "../../state/AppContext";
import {
  gradeCard,
  getSetting,
  listDueCards,
  getNote,
  type LocalFlashcard,
} from "../../lib/notes";
import { flushStudyProgress } from "../../lib/progress";
import type { CardGrade } from "../../lib/srs";

const DAY_MS = 86_400_000;

export default function Review() {
  const pv = usePalette();
  const { deck, courseId } = useLocalSearchParams<{ deck?: string; courseId?: string }>();
  const db = useSQLiteContext();
  const { getAuthToken } = useApp();
  const [cards, setCards] = useState<LocalFlashcard[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [tallies, setTallies] = useState<Record<CardGrade, number>>({
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  });
  const [done, setDone] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        // Session length preference (default keeps the shipped 30-card cap).
        const stored = await getSetting(db, "review_session_length").catch(() => null);
        const parsed = parseInt(stored ?? "30", 10);
        const sessionLength = Math.max(5, Math.min(50, parsed || 30));
        // Fresh cards (never scheduled) and today's due cards first; without
        // enough due cards the session still offers a short review-ahead.
        const now = new Date().toISOString();
        let queue = await listDueCards(db, now);
        if (deck) queue = queue.filter((card) => card.noteId === deck);
        if (courseId) {
          const noteIds = new Set(
            (
              await Promise.all(queue.map((card) => getNote(db, card.noteId)))
            )
              .filter((note) => note?.courseId === courseId)
              .map((note) => note!.id),
          );
          queue = queue.filter((card) => noteIds.has(card.noteId));
        }
        if (queue.length && deck) {
          queue = queue.filter((card) => card.noteId === deck);
        }
        if (!queue.length) {
          const ahead = await listDueCards(db, new Date(Date.now() + 7 * DAY_MS).toISOString());
          if (deck) queue = ahead.filter((card) => card.noteId === deck);
          else if (courseId) {
            const noteIds = new Set(
              (
                await Promise.all(ahead.map((card) => getNote(db, card.noteId)))
              )
                .filter((note) => note?.courseId === courseId)
                .map((note) => note!.id),
            );
            queue = ahead.filter((card) => noteIds.has(card.noteId));
          } else queue = ahead.slice(0, sessionLength);
        }
        queue = queue.slice(0, sessionLength);
        setCards(queue);
        setIndex(0);
        setFlipped(false);
        setDone(false);
        setTallies({ again: 0, hard: 0, good: 0, easy: 0 });
      })();
    }, [courseId, db, deck]),
  );

  const total = cards.length;

  const handleGrade = (grade: CardGrade) => {
    const card = cards[index];
    if (!card) return;
    void (async () => {
      try {
        await gradeCard(db, card.id, grade);
      } catch {
        // Scheduling write is best-effort; the session keeps moving.
      }
      setTallies((prev) => ({ ...prev, [grade]: prev[grade] + 1 }));
      if (index + 1 >= total) {
        setDone(true);
        void flushStudyProgress({ db, getAuthToken });
      } else {
        setIndex(index + 1);
        setFlipped(false);
      }
    })();
  };

  const card = cards[index];

  if (done || (!card && total === 0)) {
    const graded = tallies.again + tallies.hard + tallies.good + tallies.easy;
    const strong = graded - tallies.again;
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center px-8">
          <Flame size={30} color={colors.gold.DEFAULT} />
          <Text className="mt-4 text-3xl font-sans-black text-ink">
            {graded > 0 ? "Review complete" : "Nothing to review"}
          </Text>
          {graded > 0 ? (
            <>
              <Text className="mt-2 text-center text-body leading-6 text-ink-soft">
                {strong} of {graded} kept fresh. Come back when cards are due.
              </Text>
              {tallies.again > 0 ? (
                <Text className="mt-1 text-small text-ink-soft">
                  {tallies.again} card{tallies.again === 1 ? "" : "s"} return shortly.
                </Text>
              ) : null}
            </>
          ) : (
            <Text className="mt-2 text-center text-body leading-6 text-ink-soft">
              Generate a study set from any note — cards land here when due.
            </Text>
          )}
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Finish the review session"
            className="mt-8 min-h-12 items-center justify-center rounded-btn bg-brand px-6 active:opacity-80"
          >
            <Text className="text-label font-sans-bold text-ink-inverse">Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-row items-center justify-between px-5 py-2">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Exit the review session"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
        >
          <ArrowLeft size={20} color={pv.ink.DEFAULT} />
        </Pressable>
        <Text className="text-body font-sans-extrabold text-ink">
          {index + 1} / {total}
        </Text>
        <View className="h-10 w-10" />
      </View>

      <Pressable
        onPress={() => setFlipped(true)}
        accessibilityRole="button"
        accessibilityLabel={flipped ? "Answer shown" : "Reveal the answer"}
        className={`mx-5 mt-3 flex-1 items-center justify-center rounded-card p-card-lg shadow-card ${
          flipped ? "bg-success-soft" : "bg-surface"
        }`}
      >
        <Text className="text-caption font-sans-extrabold text-ink-soft">
          {flipped ? "ANSWER" : "QUESTION"}
        </Text>
        <Text className="mt-4 text-center text-3xl leading-9 font-sans-extrabold text-ink">
          {card.front || "—"}
        </Text>
        {flipped ? (
          <>
            <View className="my-5 h-px w-2/3 bg-line" />
            <Text className="text-center text-xl leading-8 text-ink">
              {card.back || "—"}
            </Text>
          </>
        ) : (
          <Text className="mt-8 text-small text-ink-faint">Tap to reveal</Text>
        )}
      </Pressable>

      {flipped ? (
        <View className="flex-row gap-2 px-5 pb-4 pt-3">
          <Pressable
            onPress={() => handleGrade("again")}
            accessibilityRole="button"
            accessibilityLabel="Grade again"
            className="flex-1 items-center justify-center gap-1 rounded-btn bg-danger py-3 active:opacity-80"
          >
            <X size={17} color={colors.ink.inverse} />
            <Text className="text-caption font-sans-bold text-ink-inverse">Again</Text>
          </Pressable>
          <Pressable
            onPress={() => handleGrade("hard")}
            accessibilityRole="button"
            accessibilityLabel="Grade hard"
            className="flex-1 items-center justify-center gap-1 rounded-btn bg-warning py-3 active:opacity-80"
          >
            <Text className="text-caption font-sans-bold text-ink-inverse">Hard</Text>
          </Pressable>
          <Pressable
            onPress={() => handleGrade("good")}
            accessibilityRole="button"
            accessibilityLabel="Grade good"
            className="flex-1 items-center justify-center gap-1 rounded-btn bg-success py-3 active:opacity-80"
          >
            <Check size={17} color={colors.ink.inverse} />
            <Text className="text-caption font-sans-bold text-ink-inverse">Good</Text>
          </Pressable>
          <Pressable
            onPress={() => handleGrade("easy")}
            accessibilityRole="button"
            accessibilityLabel="Grade easy"
            className="flex-1 items-center justify-center gap-1 rounded-btn bg-brand py-3 active:opacity-80"
          >
            <Text className="text-caption font-sans-bold text-ink-inverse">Easy</Text>
          </Pressable>
        </View>
      ) : (
        <View className="px-5 pb-6">
          <Text className="text-center text-small text-ink-faint">
            Answer honestly — honest grades make the loop work.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}
