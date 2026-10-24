import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ArrowLeft, FileText, Pencil, Plus, Trash2 } from "lucide-react-native";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useApp } from "../../../state/AppContext";
import {
  countDeckDue,
  deleteLocalCard,
  getNote,
  listDeckCards,
  listQuizAttempts,
  listQuizzes,
  newId,
  upsertLocalCard,
  type LocalFlashcard,
  type LocalQuiz,
} from "../../../lib/notes";
import { flushStudyProgress } from "../../../lib/progress";

export default function Deck() {
  const pv = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const { getAuthToken } = useApp();
  const [noteTitle, setNoteTitle] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const [cards, setCards] = useState<LocalFlashcard[]>([]);
  const [quizzes, setQuizzes] = useState<LocalQuiz[]>([]);
  const [due, setDue] = useState(0);
  const [editing, setEditing] = useState<{
    card: LocalFlashcard | null;
    visible: boolean;
  }>({ card: null, visible: false });
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");

  const load = useCallback(async () => {
    const note = await getNote(db, String(id));
    setNoteTitle(note?.title ?? "");
    setNoteMissing(!note);
    setCards(await listDeckCards(db, String(id)));
    setQuizzes(await listQuizzes(db, String(id)));
    setDue(await countDeckDue(db, String(id), new Date().toISOString()));
  }, [db, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const dueLabel =
    due > 0
      ? `${due} card${due === 1 ? "" : "s"} due`
      : cards.length
        ? "All caught up"
        : "";

  function confirmDelete(card: LocalFlashcard) {
    Alert.alert("Delete card", "Remove this card from the deck?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await deleteLocalCard(db, card.id, card.noteId);
            } catch {
              // Best-effort; refresh shows the current local state.
            }
            await load();
          })();
        },
      },
    ]);
  }

  function openEditor(card: LocalFlashcard | null) {
    setFront(card?.front ?? "");
    setBack(card?.back ?? "");
    setEditing({ card, visible: true });
  }

  async function saveCard() {
    const cleanFront = front.trim();
    const cleanBack = back.trim();
    if (!cleanFront || !cleanBack) return;
    const card = editing.card;
    try {
      await upsertLocalCard(db, {
        id: card ? card.id : newId(),
        noteId: String(id),
        front: cleanFront,
        back: cleanBack,
        op: card ? "update" : "create",
      });
    } catch {
      // The local write is best-effort; the editor closes regardless.
    }
    void flushStudyProgress({ db, getAuthToken });
    setEditing({ card: null, visible: false });
    await load();
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-row items-center justify-between px-5 py-2">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
        >
          <ArrowLeft size={20} color={pv.ink.DEFAULT} />
        </Pressable>
        <Pressable
          onPress={() => router.push({ pathname: "/note/[id]", params: { id: String(id) } })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open the source note"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
        >
          <FileText size={19} color={pv.ink.DEFAULT} />
        </Pressable>
      </View>

      <View className="px-5">
        <Text numberOfLines={1} className="text-3xl font-sans-black text-ink">
          {noteTitle || (noteMissing ? "Deck" : "Loading…")}
        </Text>

        <View className="mt-4 flex-row gap-3">
          <Pressable
            onPress={() =>
              router.push({ pathname: "/review", params: { deck: String(id) } })
            }
            accessibilityRole="button"
            accessibilityLabel="Review the due cards in this deck"
            className="min-h-12 flex-1 items-center justify-center rounded-btn border border-brand bg-brand-light px-4 active:opacity-80"
          >
            <Text className="text-label font-sans-extrabold text-brand-dark">
              {due > 0 ? `Review ${due} due` : "Review"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => openEditor(null)}
            accessibilityRole="button"
            accessibilityLabel="Add a flashcard"
            className="min-h-12 flex-1 items-center justify-center gap-1 flex-row rounded-btn bg-brand-strong px-4 active:opacity-80"
          >
            <Plus size={17} color={colors.ink.inverse} />
            <Text className="text-label font-sans-extrabold text-ink-inverse">
              Add card
            </Text>
          </Pressable>
        </View>
        {dueLabel ? (
          <Text className="mt-2 text-small text-ink-soft">{dueLabel}</Text>
        ) : null}

        <Text className="mt-7 text-body-lg font-sans-extrabold text-ink">
          Flashcards ({cards.length})
        </Text>
      </View>

      <FlatList
        className="flex-1 px-5"
        contentContainerClassName="pb-8"
        data={cards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View className="mt-3 rounded-card bg-surface p-card shadow-card">
            <Pressable
              onLongPress={() => confirmDelete(item)}
              accessibilityRole="button"
              accessibilityLabel={`Flashcard: ${item.front}`}
              className="active:opacity-80"
            >
              <Text className="text-body font-sans-extrabold text-ink">
                {item.front}
              </Text>
              <Text numberOfLines={2} className="mt-1 text-small leading-5 text-ink-soft">
                {item.back}
              </Text>
              <Text className="mt-2 text-caption text-ink-faint">
                {item.reps === 0
                  ? cardDueHint(item)
                  : `${item.reps} review${item.reps === 1 ? "" : "s"} · ease ${item.ease.toFixed(1)}`}
              </Text>
            </Pressable>
            <View className="mt-3 flex-row justify-end gap-2">
              <Pressable
                onPress={() => openEditor(item)}
                accessibilityRole="button"
                accessibilityLabel="Edit this card"
                className="h-9 w-9 items-center justify-center rounded-full bg-soft active:opacity-80"
              >
                <Pencil size={16} color={pv.ink.DEFAULT} />
              </Pressable>
              <Pressable
                onPress={() => confirmDelete(item)}
                accessibilityRole="button"
                accessibilityLabel="Delete this card"
                className="h-9 w-9 items-center justify-center rounded-full bg-danger-soft active:opacity-80"
              >
                <Trash2 size={16} color={colors.danger} />
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View className="mt-3 items-center rounded-card border border-dashed border-line bg-surface px-6 py-10">
            <Text className="text-body-lg font-sans-extrabold text-ink">
              This deck is empty
            </Text>
            <Text className="mt-2 text-center text-small leading-5 text-ink-soft">
              Generate a study set from the note, or add cards by hand.
            </Text>
          </View>
        }
      />

      {quizzes.length > 0 ? (
        <View className="px-5 pb-8">
          <Text className="text-body-lg font-sans-extrabold text-ink">
            Quizzes ({quizzes.length})
          </Text>
          {quizzes.map((quiz) => (
            <View key={quiz.id} className="mt-3 rounded-card bg-brand/5 p-card shadow-card">
              <Pressable
                onPress={() => router.push({ pathname: "/quiz/[id]", params: { id: quiz.id } })}
                accessibilityRole="button"
                accessibilityLabel={`Take quiz: ${quiz.title}`}
                className="active:opacity-80"
              >
                <Text className="text-body font-sans-extrabold text-ink">
                  {quiz.title}
                </Text>
                <Text className="mt-1 text-small text-ink-soft">
                  {quiz.questions.length} question{quiz.questions.length === 1 ? "" : "s"}
                </Text>
                <QuizMeta quizId={quiz.id} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <Modal visible={editing.visible} transparent animationType="slide">
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-card bg-cream px-5 pb-8 pt-5">
            <Text className="text-body-lg font-sans-extrabold text-ink">
              {editing.card ? "Edit card" : "New card"}
            </Text>
            <Text className="mt-4 text-caption font-sans-extrabold text-ink-soft">
              QUESTION
            </Text>
            <TextInput
              value={front}
              onChangeText={setFront}
              placeholder="e.g. Define glycogenesis"
              placeholderTextColor={pv.ink.faint}
              multiline
              className="mt-1 min-h-16 rounded-input border border-line bg-surface px-3 py-2.5 text-body text-ink"
            />
            <Text className="mt-3 text-caption font-sans-extrabold text-ink-soft">
              ANSWER
            </Text>
            <TextInput
              value={back}
              onChangeText={setBack}
              placeholder="The storage of glucose as glycogen…"
              placeholderTextColor={pv.ink.faint}
              multiline
              className="mt-1 min-h-20 rounded-input border border-line bg-surface px-3 py-2.5 text-body text-ink"
            />
            <View className="mt-5 flex-row gap-3">
              <Pressable
                onPress={() => setEditing({ card: null, visible: false })}
                accessibilityRole="button"
                accessibilityLabel="Cancel editing"
                className="min-h-12 flex-1 items-center justify-center rounded-btn border border-line bg-surface active:opacity-80"
              >
                <Text className="text-label font-sans-bold text-ink">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveCard()}
                accessibilityRole="button"
                accessibilityLabel="Save the card"
                className="min-h-12 flex-1 items-center justify-center rounded-btn bg-brand-strong active:opacity-80"
              >
                <Text className="text-label font-sans-bold text-ink-inverse">Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function cardDueHint(card: LocalFlashcard) {
  if (!card.dueAt) return "Ready to review";
  const date = new Date(card.dueAt);
  if (Number.isNaN(date.getTime())) return "Ready to review";
  if (date.getTime() <= Date.now()) return "Due now";
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  return days <= 1 ? "Due tomorrow" : `Due in ${days} days`;
}

function QuizMeta({ quizId }: { quizId: string }) {
  const db = useSQLiteContext();
  const [label, setLabel] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const attempts = await listQuizAttempts(db, quizId);
        if (!attempts.length) {
          setLabel("No attempts yet");
          return;
        }
        const best = attempts.reduce(
          (max, attempt) => Math.max(max, attempt.correct ?? 0),
          0,
        );
        setLabel(`${attempts.length} attempt${attempts.length === 1 ? "" : "s"} · best ${best}`);
      })();
    }, [db, quizId]),
  );
  if (label === null) return null;
  return <Text className="mt-1 text-caption text-ink-faint">{label}</Text>;
}
