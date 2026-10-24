import { useCallback, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import NetInfo from "@react-native-community/netinfo";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Loader2,
  Plus,
  X,
} from "lucide-react-native";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useApp } from "../../../state/AppContext";
import {
  newId,
  recordQuizAttempt,
  listQuizAttempts,
  listQuizzes,
  upsertLocalCard,
  updateAttemptResult,
  type LocalQuiz,
  type LocalQuizAttempt,
  type LocalQuizQuestion,
} from "../../../lib/notes";
import { studyApi } from "../../../lib/api";
import { flushStudyProgress } from "../../../lib/progress";

type QuizDetail = {
  questionId: string;
  prompt: string;
  type: LocalQuizQuestion["type"];
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  verdict: boolean | null;
  partial: boolean;
  comment: string;
};

export default function Quiz() {
  const pv = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const { getAuthToken } = useApp();
  const [quiz, setQuiz] = useState<LocalQuiz | null>(null);
  const [phase, setPhase] = useState<"loading" | "intro" | "playing" | "marking" | "result">(
    "loading",
  );
  const [details, setDetails] = useState<QuizDetail[]>([]);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadQuiz = useCallback(async () => {
    const quizzes = await listQuizzes(db, String(id));
    return quizzes.find((item) => item.id === String(id)) ?? null;
  }, [db, id]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const stored = await loadQuiz();
        setQuiz(stored);
        setDetails([]);
        setPhase(stored ? "intro" : "loading");
      })();
      return () => {
        if (poller.current) clearInterval(poller.current);
        poller.current = null;
      };
    }, [loadQuiz]),
  );

  if (!quiz) {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center">
          <Text className="text-body text-ink-soft">Quiz not found on this device.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const current = quiz;
  const questions = current.questions;
  const question = questions[index];
  const shortCount = questions.filter((item) => item.type === "short_answer").length;

  function start() {
    const fresh: QuizDetail[] = questions.map((item) => ({
      questionId: item.id,
      prompt: item.prompt,
      type: item.type,
      userAnswer: "",
      correctAnswer: item.answer,
      explanation: item.explanation,
      verdict: null,
      partial: false,
      comment: "",
    }));
    setDetails(fresh);
    setPicked(null);
    setTyped("");
    setIndex(0);
    setAttemptError(null);
    setPhase("playing");
  }

  function finish(graded: QuizDetail[], markState: "marked" | "pending_marking") {
    const localId = newId();
    setAttemptId(localId);
    void (async () => {
      const finishedAt = new Date().toISOString();
      const correct = graded.filter((entry) => entry.verdict === true).length;
      try {
        await recordQuizAttempt(db, {
          id: localId,
          quizId: current.id,
          noteId: current.noteId,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          finishedAt,
          correct,
          total: graded.length,
          state: markState,
          details: graded as unknown as LocalQuizAttempt["details"],
          error: null,
        });
      } catch {
        // Persisting the attempt is best-effort; grading still shows.
      }
    })();
    setDetails(graded);
    setPhase(markState === "marked" ? "result" : "marking");
  }

  function submitForMarking() {
    const grade = details;
    finish(grade, "pending_marking");
    void (async () => {
      const token = await getAuthToken();
      const net = await NetInfo.fetch();
      const pollId = attemptId ?? newId();
      if (!net.isConnected || !token) {
        setAttemptError(
          "Sua will mark this as soon as you're back online. Check it later on this screen.",
        );
        return;
      }
      try {
        await studyApi.submitAttempt(token, {
          id: pollId,
          quizId: current.id,
          total: grade.length,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          finishedAt: new Date().toISOString(),
          details: grade.map((entry) => ({
            questionId: entry.questionId,
            answer: entry.userAnswer || undefined,
            verdict: entry.verdict,
          })),
        });
        startPolling(pollId);
      } catch {
        setAttemptError("Couldn't reach the marker. It will retry automatically online.");
      }
    })();
  }

  function startPolling(pollId: string) {
    if (poller.current) clearInterval(poller.current);
    let tries = 0;
    poller.current = setInterval(() => {
      tries += 1;
      void (async () => {
        const token = await getAuthToken();
        if (!token) return;
        try {
          const attempt = await studyApi.getAttempt(token, pollId);
          if (attempt.state === "marked" || attempt.state === "marking_failed") {
            if (poller.current) clearInterval(poller.current);
            poller.current = null;
            await updateAttemptResult(db, {
              id: pollId,
              state: attempt.state,
              correct: attempt.correct ?? 0,
              details: attempt.details ?? [],
              error: attempt.error ?? null,
            });
            if (attempt.state === "marked" && Array.isArray(attempt.details)) {
              setDetails(attempt.details as QuizDetail[]);
            } else {
              setAttemptError(
                attempt.error || "Marking failed. Try submitting again when online.",
              );
            }
            setPhase("result");
          } else if (tries > 60) {
            if (poller.current) clearInterval(poller.current);
            poller.current = null;
          }
        } catch {
          if (tries > 60 && poller.current) {
            clearInterval(poller.current);
            poller.current = null;
          }
        }
      })();
    }, 4_000);
  }

  function pickOption(option: string) {
    if (picked !== null) return;
    setPicked(option);
    const correct = option === question.answer;
    setDetails((prev) =>
      prev.map((entry, position) =>
        position === index
          ? { ...entry, userAnswer: option, verdict: correct }
          : entry,
      ),
    );
  }

  function nextQuestion() {
    if (index + 1 >= questions.length) {
      const grade = details;
      const hasShort = grade.some(
        (entry) => entry.type === "short_answer" && entry.verdict === null,
      );
      if (hasShort) {
        void submitForMarking();
      } else {
        finish(grade, "marked");
      }
      return;
    }
    setIndex(index + 1);
    setPicked(null);
    setTyped("");
  }

  function shortContinue() {
    setDetails((prev) =>
      prev.map((entry, position) =>
        position === index ? { ...entry, userAnswer: typed.trim() } : entry,
      ),
    );
    nextQuestion();
  }

  async function makeCardsFromMistakes() {
    const wrong = details.filter((entry) => entry.verdict !== true);
    const created = new Set<string>();
    for (const entry of wrong) {
      const front = entry.prompt;
      const answer =
        entry.type === "mcq"
          ? entry.correctAnswer
          : entry.type === "short_answer"
            ? entry.comment || entry.explanation || entry.correctAnswer
            : entry.correctAnswer;
      if (!front || !answer) continue;
      try {
        await upsertLocalCard(db, {
          id: newId(),
          noteId: current.noteId,
          front,
          back: answer,
          op: "create",
        });
        created.add(front);
      } catch {
        // Skip failures; the rest still land.
      }
    }
    void flushStudyProgress({ db, getAuthToken });
    if (created.size) {
      Alert.alert("Cards added", `${created.size} new card${created.size === 1 ? "" : "s"} queued for review.`);
    } else {
      Alert.alert("Nothing to add", "No distinct mistakes were found to turn into cards.");
    }
  }

  function verdictRow(entry: QuizDetail) {
    if (entry.verdict === true) {
      return <Check size={18} color={colors.success} />;
    }
    if (entry.partial) {
      return <CircleAlert size={18} color={colors.warning} />;
    }
    if (entry.verdict === false) {
      return <X size={18} color={colors.danger} />;
    }
    return <Loader2 size={18} color={pv.ink.faint} />;
  }

  if (phase === "intro" || phase === "loading") {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-row items-center px-5 py-2">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="px-5 pb-10">
          <Text className="mt-2 text-3xl font-sans-black text-ink">{current.title}</Text>
          <Text className="mt-2 text-body leading-6 text-ink-soft">
            {questions.length} question{questions.length === 1 ? "" : "s"}
            {shortCount ? ` · ${shortCount} short answer${shortCount === 1 ? "" : "s"} (marked online)` : ""}
          </Text>
          <Pressable
            onPress={start}
            accessibilityRole="button"
            accessibilityLabel="Start the quiz"
            className="mt-8 min-h-12 items-center justify-center rounded-btn bg-brand-strong active:opacity-80"
          >
            <Text className="text-label font-sans-extrabold text-ink-inverse">
              Start quiz
            </Text>
          </Pressable>
          <PastAttempts quizId={current.id} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === "playing") {
    const optionList = question.options ?? [];
    const revealed = picked !== null;
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-row items-center justify-between px-5 py-2">
          <Pressable
            onPress={() => {
              if (poller.current) clearInterval(poller.current);
              router.back();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Exit the quiz"
            className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          </Pressable>
          <Text className="text-body font-sans-extrabold text-ink">
            {index + 1} / {questions.length}
          </Text>
          <View className="h-10 w-10" />
        </View>

        <ScrollView contentContainerClassName="px-5 pb-8">
          <Text className="mt-4 text-xl leading-8 font-sans-extrabold text-ink">
            {question.prompt}
          </Text>

          {question.type === "short_answer" ? (
            <>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder="Type your answer…"
                placeholderTextColor={pv.ink.faint}
                multiline
                className="mt-5 min-h-24 rounded-card border border-line bg-surface px-4 py-3 text-body text-ink"
              />
              <Text className="mt-2 text-small text-ink-soft">
                Short answers are marked by Sua&apos;s AI at the end (online needed).
              </Text>
            </>
          ) : null}

          {question.type === "mcq"
            ? optionList.map((option, position) => (
                <Pressable
                  key={option}
                  onPress={() => pickOption(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`Answer option ${String.fromCharCode(65 + position)}`}
                  className={
                    revealed
                      ? option === question.answer
                        ? "mt-3 min-h-12 flex-row items-center rounded-btn border-2 border-success bg-success-soft px-4 active:opacity-80"
                        : option === picked
                          ? "mt-3 min-h-12 flex-row items-center rounded-btn border-2 border-danger bg-danger-soft px-4 active:opacity-80"
                          : "mt-3 min-h-12 items-center justify-center rounded-btn border border-line bg-surface px-4 active:opacity-80"
                      : "mt-3 min-h-12 items-center justify-center rounded-btn border border-line bg-surface px-4 active:opacity-80"
                  }
                >
                  <Text className="text-body font-sans-semibold text-ink">{option}</Text>
                </Pressable>
              ))
            : null}
          {question.type === "true_false" ? (
            <View className="mt-4 flex-row gap-3">
              {["True", "False"].map((option) => (
                <Pressable
                  key={option}
                  onPress={() => pickOption(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`Answer ${option}`}
                  className={
                    revealed
                      ? option === question.answer
                        ? "min-h-12 flex-1 items-center justify-center rounded-btn border-2 border-success bg-success-soft px-4 active:opacity-80"
                        : option === picked
                          ? "min-h-12 flex-1 items-center justify-center rounded-btn border-2 border-danger bg-danger-soft px-4 active:opacity-80"
                          : "min-h-12 flex-1 items-center justify-center rounded-btn border border-line bg-surface px-4 active:opacity-80"
                      : "min-h-12 flex-1 items-center justify-center rounded-btn border border-line bg-surface px-4 active:opacity-80"
                  }
                >
                  <Text className="text-body font-sans-semibold text-ink">{option}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {revealed ? (
            <View className="mt-4 rounded-card bg-surface-2 p-card shadow-card">
              <Text className="text-caption font-sans-extrabold text-ink-soft">
                {picked === question.answer ? "CORRECT" : "NOT QUITE"}
              </Text>
              <Text className="mt-1 text-small leading-5 text-ink">
                {question.explanation}
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View className="px-5 pb-4">
          <Pressable
            onPress={() => void shortContinue()}
            accessibilityRole="button"
            accessibilityLabel="Continue to the next question"
            className="min-h-12 items-center justify-center rounded-btn bg-brand-strong active:opacity-80"
          >
            <Text className="text-label font-sans-extrabold text-ink-inverse">
              {revealed ? "Next question" : "Continue"}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === "marking") {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center px-8">
          <Loader2 size={26} color={colors.brand.DEFAULT} />
          <Text className="mt-4 text-2xl font-sans-black text-ink">Marking your quiz…</Text>
          <Text className="mt-2 text-center text-body leading-6 text-ink-soft">
            Sua&apos;s AI is reading your short answers. Keep this screen open or come
            back later — the score lands here either way.
          </Text>
          {attemptError ? (
            <Text className="mt-3 text-center text-small text-ink-soft">
              {attemptError}
            </Text>
          ) : null}
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Leave the marking screen"
            className="mt-8 min-h-12 items-center justify-center rounded-btn border border-line bg-surface px-6 active:opacity-80"
          >
            <Text className="text-label font-sans-bold text-ink">Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const answered = details.filter((entry) => entry.verdict === true).length;
  const percent = details.length ? Math.round((answered / details.length) * 100) : 0;
  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mt-4 text-caption font-sans-extrabold text-ink-soft">
          QUIZ COMPLETE
        </Text>
        <Text className="text-4xl font-sans-black text-ink">
          {percent}%
        </Text>
        <Text className="mt-1 text-body text-ink-soft">
          {answered} of {details.length} correct
        </Text>

        {attemptError ? (
          <View className="mt-3 rounded-card bg-warning-soft p-card">
            <Text className="text-small leading-5 text-ink">{attemptError}</Text>
          </View>
        ) : null}

        {details.filter((entry) => entry.verdict !== true).length > 0 ? (
          <Pressable
            onPress={() => void makeCardsFromMistakes()}
            accessibilityRole="button"
            accessibilityLabel="Turn your mistakes into flashcards"
            className="mt-4 min-h-12 flex-row items-center justify-center gap-2 rounded-btn border border-brand bg-brand-light active:opacity-80"
          >
            <Plus size={17} color={colors.brand.DEFAULT} />
            <Text className="text-label font-sans-extrabold text-brand-light">
              Make cards from mistakes
            </Text>
          </Pressable>
        ) : null}

        <View className="mt-6 gap-3">
          {details.map((entry) => (
            <View key={entry.questionId} className="rounded-card bg-surface p-card shadow-card">
              <View className="flex-row items-start gap-2">
                {verdictRow(entry)}
                <View className="flex-1">
                  <Text className="text-body font-sans-extrabold text-ink">
                    {entry.prompt}
                  </Text>
                  <Text className="mt-1 text-small text-ink-soft">
                    You: {entry.userAnswer || "—"}
                  </Text>
                  {entry.verdict !== true ? (
                    <Text className="mt-0.5 text-small text-ink-soft">
                      Answer: {entry.correctAnswer}
                    </Text>
                  ) : null}
                  {(entry.comment || entry.explanation) && entry.verdict !== true ? (
                    <Text className="mt-2 text-small leading-5 text-ink">
                      {entry.comment || entry.explanation}
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>
          ))}
        </View>

        <View className="mt-6 flex-row gap-3">
          <Pressable
            onPress={() => setPhase("intro")}
            accessibilityRole="button"
            accessibilityLabel="Try the quiz again"
            className="min-h-12 flex-1 items-center justify-center rounded-btn border border-line bg-surface active:opacity-80"
          >
            <Text className="text-label font-sans-bold text-ink">Try again</Text>
          </Pressable>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Finish the quiz"
            className="min-h-12 flex-1 items-center justify-center rounded-btn bg-brand-strong active:opacity-80"
          >
            <Text className="text-label font-sans-bold text-ink-inverse">Done</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PastAttempts({ quizId }: { quizId: string }) {
  const db = useSQLiteContext();
  const [attempts, setAttempts] = useState<ReturnType<typeof listQuizAttempts> extends Promise<infer T> ? T : never>([]);
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        setAttempts(await listQuizAttempts(db, quizId));
      })();
    }, [db, quizId]),
  );
  if (!attempts.length) return null;
  return (
    <View className="mt-8">
      <Text className="text-body-lg font-sans-extrabold text-ink">Past attempts</Text>
      {attempts.slice(0, 5).map((attempt) => (
        <View
          key={attempt.id}
          className="mt-2 flex-row items-center justify-between rounded-card bg-surface px-4 py-3"
        >
          <Text className="text-small text-ink-soft">
            {attempt.finishedAt
              ? new Date(attempt.finishedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              : "—"}
          </Text>
          <Text className="text-small font-sans-bold text-ink">
            {attempt.correct ?? 0}/{attempt.total ?? 0}
            {attempt.state === "pending_marking" ? " · marking…" : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}
