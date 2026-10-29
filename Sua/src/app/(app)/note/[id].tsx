import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  router,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import {
  ArrowLeft,
  BookOpen,
  BotMessageSquare,
  Brain,
  Flag,
  Mic,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import { BottomSheet } from "../../../components/sheets";
import { Markdown, type MarkdownScale } from "../../../components/markdown";
import {
  AiFailedCard,
  AiProgressCard,
  EmptyCard,
  NoticeCard,
  ReaderCard,
} from "../../../components/note/cards";
import { SegmentedControl, type SegmentOption } from "../../../components/ui";
import { useStringSetting } from "../../../state/settings";
import { jobsApi } from "../../../lib/api";
import {
  countPendingUploads,
  deleteNote,
  enqueueGeneration,
  getLastGeneration,
  getNote,
  isNotePendingSync,
  listFlashcards,
  listQuizzes,
  pullCourseNotes,
  type LastGeneration,
  type LocalFlashcard,
  type LocalQuiz,
  type Note,
} from "../../../lib/notes";
import {
  aiStageLabel,
  drainGenerationQueue,
  generationKindFor,
  isAiActive,
  reconcileAiOutputs,
  refreshNoteFromServer,
  sourceMetaFor,
  userFacingMessage,
} from "../../../lib/generate";
import { splitNotices } from "../../../lib/markdown";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useApp } from "../../../state/AppContext";
import type { JobMeta } from "../../../lib/types";

type ReaderTab = "notes" | "summary" | "cards" | "quiz";

// The pipeline's wording for failures it did not classify lives in lib/generate
// as GENERIC_FAILURE; every terminal failure renders through userFacingMessage.

export default function NoteView() {
  const pv = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const noteScale = useStringSetting(db, "note_text_scale", "medium");
  const noteScaleValue = (["small", "medium", "large"].includes(noteScale.value)
    ? noteScale.value
    : "medium") as MarkdownScale;
  const { courses, getAuthToken, flushNoteQueue } = useApp();
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  // Whether this device still holds an unsent change. Read from the queue (not
  // the stored flag) so a lost queue row cannot leave the badge stuck forever.
  const [syncPending, setSyncPending] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [flashcards, setFlashcards] = useState<LocalFlashcard[]>([]);
  const [quizzes, setQuizzes] = useState<LocalQuiz[]>([]);
  const [lastGeneration, setLastGeneration] = useState<LastGeneration | null>(
    null,
  );
  // Diagnostics from the server job: what the AI actually read, and the exact
  // message for a failed run. Best effort — offline notes simply have none.
  const [jobMeta, setJobMeta] = useState<JobMeta | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  // Long-file progress counter ("Reading pages 41 of 212"), live-polled.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [tab, setTab] = useState<ReaderTab>("notes");
  const [showOriginal, setShowOriginal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportComment, setReportComment] = useState("");
  const [reportSending, setReportSending] = useState(false);
  const [reported, setReported] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const screenActiveRef = useRef(false);
  const retryingRef = useRef(false);
  // Set before navigating away from a delete so the 5 s stage poll and any
  // in-flight load/refresh cannot put the note back on screen.
  const deletedRef = useRef(false);

  const course = courses.find((item) => item.id === note?.courseId);
  const reference = note?.noteKind === "reference";
  const aiActive = isAiActive(note?.aiState);
  const quiz = quizzes[0] ?? null;
  const questionCount = quizzes.reduce(
    (total, item) => total + (item.questions?.length ?? 0),
    0,
  );

  const load = useCallback(async () => {
    if (deletedRef.current) return;
    try {
      const row = await getNote(db, id);
      if (!screenActiveRef.current || deletedRef.current) return;
      setNote(row);
      setMissing(!row);
      if (!row) {
        setPendingUploads(0);
        setFlashcards([]);
        setQuizzes([]);
        setLastGeneration(null);
        setJobMeta(null);
        setJobError(null);
        setProgress(null);
        setSyncPending(false);
        return;
      }
      const [pending, cards, quizRows, last, queued] = await Promise.all([
        countPendingUploads(db, row.id),
        listFlashcards(db, row.id).catch(() => [] as LocalFlashcard[]),
        listQuizzes(db, row.id).catch(() => [] as LocalQuiz[]),
        getLastGeneration(db, row.id).catch(() => null),
        isNotePendingSync(db, row.id).catch(() => false),
      ]);
      if (!screenActiveRef.current || deletedRef.current) return;
      setPendingUploads(pending);
      setFlashcards(cards);
      setQuizzes(quizRows);
      setLastGeneration(last);
      setSyncPending(queued);
    } catch {
      setMissing(true);
    }
  }, [db, id]);

  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      void load();
      return () => {
        screenActiveRef.current = false;
      };
    }, [load]),
  );

  // Opening a note is the last chance to notice work the server finished while
  // this device was closed: the stage poll below only runs while a generation
  // looks active locally, so a missed finish leaves the body blank until a
  // manual pull. One course pull per visit heals this note (and its siblings).
  // Throttled rather than once-per-mount: auth callbacks can re-run the focus
  // effect, and coming back later should still pick up new server work.
  const healedRef = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  useFocusEffect(
    useCallback(() => {
      const key = String(id);
      const now = Date.now();
      if (healedRef.current.id === key && now - healedRef.current.at < 20_000) {
        return;
      }
      healedRef.current = { id: key, at: now };
      let cancelled = false;
      void (async () => {
        const local = await getNote(db, id).catch(() => null);
        if (!local?.courseId) return;
        const token = await getAuthToken().catch(() => null);
        if (!token || cancelled) return;
        // Offline, a stale token or a server hiccup must never block the reader:
        // the local copy is shown either way.
        await pullCourseNotes(db, token, local.courseId).catch(() => {});
        if (!cancelled) await load();
      })();
      return () => {
        cancelled = true;
      };
    }, [db, getAuthToken, id, load]),
  );

  // Retries reuse the destination the student originally chose; a reference
  // always regenerates as a reference. See generationKindFor().
  const generationKind = generationKindFor(note, lastGeneration?.kind ?? null);

  // A finished (or failed) run has job metadata on the server: pages read,
  // truncation, the fidelity check, and the exact failure message. It is not
  // synced into SQLite, so ask once per state change and keep it in memory.
  const aiState = note?.aiState;
  const noteId = note?.id;
  useEffect(() => {
    if (!noteId || (aiState !== "ready" && aiState !== "failed")) return;
    let cancelled = false;
    void (async () => {
      const token = await getAuthToken().catch(() => null);
      if (!token) return;
      const job = await jobsApi.latestForNote(token, noteId).catch(() => null);
      if (cancelled || !job) return;
      setJobMeta(job.meta ?? null);
      setJobError(job.error ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [aiState, getAuthToken, noteId]);

  // Mirror pipeline stages live while a generation is in flight. Upload
  // conversions have no local queue row, so the server job is the source.
  // The returned job also carries the long-file progress counter.
  useEffect(() => {
    if (!aiActive) return;
    const timer = setInterval(() => {
      if (deletedRef.current) return;
      void refreshNoteFromServer({ db, getAuthToken }, id)
        .then((job) => {
          if (job?.progressTotal && job.progressTotal > 0) {
            setProgress({ done: job.progressDone ?? 0, total: job.progressTotal });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (screenActiveRef.current && !deletedRef.current) void load();
        });
      void drainGenerationQueue({ db, getAuthToken }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [aiActive, db, getAuthToken, id, load]);

  // Upload conversions run server-side and finish without a local queue row.
  // When a ready note has no cards cached, pull them once per visit.
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (!note || note.noteKind === "reference") return;
    if (note.aiState !== "ready" || flashcards.length || quizzes.length) return;
    if (reconciledRef.current) return;
    reconciledRef.current = true;
    let cancelled = false;
    void (async () => {
      await reconcileAiOutputs({ db, getAuthToken }).catch(() => {});
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [db, flashcards.length, getAuthToken, load, note, quizzes.length]);

  const queueGeneration = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setJobError(null);
    try {
      await enqueueGeneration(db, id, generationKind);
      await load();
      await drainGenerationQueue({ db, getAuthToken });
    } catch {
      if (screenActiveRef.current) {
        Alert.alert(
          "Couldn’t queue the generation",
          "Your note is saved — try again in a moment.",
        );
      }
    } finally {
      retryingRef.current = false;
      setRetrying(false);
      if (screenActiveRef.current) {
        await load();
      }
    }
  };

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const token = await getAuthToken();
      if (token && note?.courseId) {
        await pullCourseNotes(db, token, note.courseId).catch(() => {});
      }
    } finally {
      await load().catch(() => {});
      setRefreshing(false);
    }
  }, [db, getAuthToken, load, note?.courseId]);

  const confirmDelete = () => {
    Alert.alert(
      "Delete this note?",
      "Its files, flashcards and quizzes will be permanently deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              // Mark first: the stage poll may fire between the await below and
              // the navigation, and it must not reload the row we just removed.
              deletedRef.current = true;
              try {
                await deleteNote(db, id);
                // Send the delete at once instead of waiting for the next
                // reconnect/foreground pass; the local queue keeps it safe.
                void flushNoteQueue();
                if (router.canGoBack()) router.back();
                else router.replace("/courses");
              } catch {
                deletedRef.current = false;
                Alert.alert("Couldn’t delete", "Try again in a moment.");
              }
            })();
          },
        },
      ],
    );
  };

  const openEditor = () => {
    if (!note) return;
    router.push({
      pathname: "/(app)/(tabs)/create",
      params: { mode: "typing", noteId: note.id, courseId: note.courseId },
    });
  };

  // The note body is what the AI wrote; the transcript is the original capture.
  // Notices are stripped from the body and rendered above it as quotes.
  const { notices, body } = useMemo(
    () => splitNotices(note?.body ?? ""),
    [note?.body],
  );
  const original = (note?.transcript ?? "").trim();
  const canShowOriginal = Boolean(
    original && body && original !== body.trim(),
  );

  const tabs = useMemo<SegmentOption<ReaderTab>[]>(
    () => [
      { key: "notes", label: "Notes" },
      { key: "summary", label: "Summary" },
      { key: "cards", label: "Cards", count: flashcards.length || null },
      { key: "quiz", label: "Quiz", count: questionCount || null },
    ],
    [flashcards.length, questionCount],
  );

  const hasContent = Boolean(
    note?.body?.trim() ||
      note?.summary?.trim() ||
      flashcards.length ||
      quizzes.length,
  );

  const study = () => {
    if (flashcards.length) {
      router.push({ pathname: "/review", params: { deck: String(id) } });
      return;
    }
    if (quiz) {
      router.push({ pathname: "/quiz/[id]", params: { id: quiz.id } });
    }
  };

  const emptyStateCopy = useMemo(() => {
    if (generationKind === "course_reference") {
      return {
        title: "Make a reference sheet from this?",
        body: "A one-page reference with key terms, formulas and must-know facts. No flashcards or quiz.",
        cta: "Make reference sheet",
      };
    }
    if (generationKind === "lecture_note") {
      return {
        title: "Turn this into study notes?",
        body: "Sua writes a full note from your material, then adds a summary, flashcards and a quiz.",
        cta: "Write study notes",
      };
    }
    return {
      title: "Add a summary, flashcards and a quiz?",
      body: "Your own text stays as written; Sua adds the study set around it.",
      cta: "Generate study set",
    };
  }, [generationKind]);

  const sourceMeta = sourceMetaFor(note, jobMeta);
  const sourceLine = sourceMeta
    ? [sourceMeta.source, sourceMeta.read].filter(Boolean).join(" · ")
    : null;

  if (missing) {
    return (
      <SafeAreaView className="flex-1 bg-cream">
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Mic size={26} color={colors.brand.DEFAULT} />
          <Text className="text-body font-sans-bold text-ink">
            This note isn’t on this device
          </Text>
          <Text className="text-center text-small leading-5 text-ink-soft">
            It may have been deleted. Connect, then pull down on your notes list
            to refresh.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} />
        }
      >
        <View className="flex-row items-center py-3">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="h-11 w-11 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          </Pressable>
          <View className="flex-1 items-center px-2">
            <Text
              numberOfLines={1}
              className="text-body-lg font-sans-extrabold text-ink"
            >
              {note?.title || "Untitled note"}
            </Text>
            {course ? (
              <Text numberOfLines={1} className="text-caption text-ink-faint">
                {course.code || course.name}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => setMenuOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="More options"
            className="h-11 w-11 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <MoreHorizontal size={20} color={pv.ink.DEFAULT} />
          </Pressable>
        </View>

        {note ? (
          <>
            <View className="mt-1 flex-row items-center gap-2">
              {reference ? (
                <View className="flex-row items-center gap-1.5 rounded-chip bg-brand/10 px-2.5 py-1.5">
                  <BookOpen size={13} color={colors.brand.DEFAULT} />
                  <Text className="text-caption font-sans-bold text-brand">
                    Course reference
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center gap-1.5 rounded-chip bg-success-soft px-2.5 py-1.5">
                  <Brain size={13} color={colors.brand.DEFAULT} />
                  <Text className="text-caption font-sans-bold text-brand">
                    Study notes
                  </Text>
                </View>
              )}
              {sourceLine ? (
                <Text className="flex-1 text-caption text-ink-faint">
                  {sourceLine}
                </Text>
              ) : (
                <View className="flex-1" />
              )}
              <Text className="text-caption text-ink-faint">
                {syncPending ? "Waiting to sync" : "Synced"}
              </Text>
            </View>

            {note.aiState === "failed" ? (
              <AiFailedCard
                title={
                  reference
                    ? "Couldn’t finish the reference"
                    : "Couldn’t finish these notes"
                }
                message={userFacingMessage(jobError ?? lastGeneration?.error)}
                onRetry={() => void queueGeneration()}
                retrying={retrying}
                pendingUploads={pendingUploads}
                onViewUploads={() => router.push("/uploads")}
              />
            ) : aiActive && note.aiState ? (
              <AiProgressCard
                label={aiStageLabel(note.aiState, generationKind, {
                  pendingUploads,
                  sourceType: note.sourceType,
                  progress,
                })}
                pendingUploads={pendingUploads}
                onViewUploads={() => router.push("/uploads")}
              />
            ) : null}

            {reference ? (
              body ? (
                <>
                  <NoticeCard notices={notices} />
                  <ReaderCard
                    title={showOriginal ? "Original material" : "Reference sheet"}
                    action={
                      canShowOriginal ? (
                        <Pressable
                          onPress={() => setShowOriginal((open) => !open)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={
                            showOriginal
                              ? "Show the reference sheet"
                              : "Show the original material"
                          }
                          className="min-h-11 justify-center active:opacity-70"
                        >
                          <Text className="text-caption font-sans-bold text-brand">
                            {showOriginal ? "Reference" : "Original"}
                          </Text>
                        </Pressable>
                      ) : undefined
                    }
                  >
                    <Markdown
                      text={showOriginal ? original : body}
                      scale={noteScaleValue}
                    />
                    {showOriginal ? null : (
                      <Text className="mt-3 text-caption text-ink-faint">
                        AI study aid — verify important facts against your
                        textbook.
                      </Text>
                    )}
                  </ReaderCard>
                </>
              ) : !aiActive && note.aiState !== "failed" ? (
                <View className="mt-4">
                  <EmptyCard
                    title={emptyStateCopy.title}
                    body={emptyStateCopy.body}
                    cta={emptyStateCopy.cta}
                    onPress={() => void queueGeneration()}
                    Icon={BookOpen}
                  />
                </View>
              ) : null
            ) : hasContent ? (
              <>
                <SegmentedControl
                  options={tabs}
                  value={tab}
                  onChange={setTab}
                  className="mt-4 shadow-card"
                />

                {tab === "notes" ? (
                  <>
                    <NoticeCard notices={notices} />
                    <ReaderCard
                      title={showOriginal ? "Original capture" : "Study notes"}
                      action={
                        canShowOriginal ? (
                          <Pressable
                            onPress={() => setShowOriginal((open) => !open)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={
                              showOriginal
                                ? "Show the AI notes"
                                : "Show the original capture"
                            }
                            className="min-h-11 justify-center active:opacity-70"
                          >
                            <Text className="text-caption font-sans-bold text-brand">
                              {showOriginal ? "AI notes" : "Original"}
                            </Text>
                          </Pressable>
                        ) : undefined
                      }
                    >
                      <Markdown
                        text={showOriginal ? original : body}
                        scale={noteScaleValue}
                      />
                      {showOriginal ? null : (
                        <Text className="mt-3 text-caption text-ink-faint">
                          AI study aid — verify important facts against your
                          textbook.
                        </Text>
                      )}
                    </ReaderCard>
                  </>
                ) : null}

                {tab === "summary" ? (
                  note.summary ? (
                    <ReaderCard title="Summary">
                      <Markdown text={note.summary} scale={noteScaleValue} />
                      <Text className="mt-3 text-caption text-ink-faint">
                        AI study aid — verify important facts against your
                        textbook.
                      </Text>
                    </ReaderCard>
                  ) : (
                    <View className="mt-4">
                      <EmptyCard
                        title="No summary yet"
                        body={
                          aiActive
                            ? "Sua is still working on it."
                            : "Generate a study set to get a summary with key points, terms and likely exam questions."
                        }
                        cta={aiActive ? undefined : "Add a summary"}
                        onPress={() => void queueGeneration()}
                        Icon={Sparkles}
                      />
                    </View>
                  )
                ) : null}

                {tab === "cards" ? (
                  flashcards.length ? (
                    <ReaderCard
                      title={`${flashcards.length} ${
                        flashcards.length === 1 ? "card" : "cards"
                      }`}
                      action={
                        <Pressable
                          onPress={() =>
                            router.push({
                              pathname: "/deck/[id]",
                              params: { id: String(id) },
                            })
                          }
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Open the deck"
                          className="min-h-11 justify-center active:opacity-70"
                        >
                          <Text className="text-caption font-sans-bold text-brand">
                            Open deck
                          </Text>
                        </Pressable>
                      }
                    >
                      <View className="gap-3">
                        {flashcards.map((card) => (
                          <View
                            key={card.id}
                            className="rounded-input border border-line p-3"
                          >
                            <Text className="text-body font-sans-bold text-ink">
                              {card.front}
                            </Text>
                            <Text className="mt-1 text-small leading-5 text-ink-soft">
                              {card.back}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </ReaderCard>
                  ) : (
                    <View className="mt-4">
                      <EmptyCard
                        title="No flashcards yet"
                        body={
                          aiActive
                            ? "Sua is making them now."
                            : "Generate a study set and Sua will turn this note into cards you can review."
                        }
                        cta={aiActive ? undefined : "Make flashcards"}
                        onPress={() => void queueGeneration()}
                        Icon={Brain}
                      />
                    </View>
                  )
                ) : null}

                {tab === "quiz" ? (
                  quiz ? (
                    <ReaderCard title="Quiz">
                      <Text className="text-small leading-5 text-ink-soft">
                        {questionCount}{" "}
                        {questionCount === 1 ? "question" : "questions"} ·
                        multiple choice, true/false and short answer. Your score
                        is saved after you finish.
                      </Text>
                      <Pressable
                        onPress={() =>
                          router.push({
                            pathname: "/quiz/[id]",
                            params: { id: quiz.id },
                          })
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Start the quiz"
                        className="mt-4 min-h-12 flex-row items-center justify-center gap-2 self-start rounded-btn bg-brand-strong px-4 active:opacity-80"
                      >
                        <Play size={15} color={colors.ink.inverse} />
                        <Text className="text-label font-sans-bold text-ink-inverse">
                          Start quiz
                        </Text>
                      </Pressable>
                    </ReaderCard>
                  ) : (
                    <View className="mt-4">
                      <EmptyCard
                        title="No quiz yet"
                        body={
                          aiActive
                            ? "Sua is writing the questions now."
                            : "Generate a study set to test yourself on this note."
                        }
                        cta={aiActive ? undefined : "Make a quiz"}
                        onPress={() => void queueGeneration()}
                        Icon={Sparkles}
                      />
                    </View>
                  )
                ) : null}
              </>
            ) : !aiActive && note.aiState !== "failed" ? (
              <View className="mt-4">
                <EmptyCard
                  title={emptyStateCopy.title}
                  body={emptyStateCopy.body}
                  cta={emptyStateCopy.cta}
                  onPress={() => void queueGeneration()}
                  Icon={Sparkles}
                />
              </View>
            ) : null}

            {/* One gold action per screen: study what exists, or ask about a
                reference. A note with nothing generated yet has no gold button
                (the empty card above carries the only call to action). */}
            {reference ? (
              body ? (
                <Pressable
                  onPress={() =>
                    note.courseId
                      ? router.push({
                          pathname: "/ask-sua",
                          params: { courseId: note.courseId },
                        })
                      : router.push("/ask-sua")
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Ask Sua about this reference"
                  className="mt-5 min-h-14 flex-row items-center justify-center gap-2 rounded-btn bg-gold shadow-gold active:opacity-80"
                >
                  <BotMessageSquare size={18} color={pv.ink.DEFAULT} />
                  <Text className="text-body font-sans-extrabold text-ink">
                    Ask Sua about this
                  </Text>
                </Pressable>
              ) : null
            ) : flashcards.length || quiz ? (
              <Pressable
                onPress={study}
                accessibilityRole="button"
                accessibilityLabel={
                  flashcards.length ? "Study this note" : "Take this quiz"
                }
                className="mt-5 min-h-14 flex-row items-center justify-center gap-2 rounded-btn bg-gold shadow-gold active:opacity-80"
              >
                <Play size={18} color={pv.ink.DEFAULT} />
                <Text className="text-body font-sans-extrabold text-ink">
                  {flashcards.length ? "Study this note" : "Take the quiz"}
                </Text>
              </Pressable>
            ) : null}

            {sourceMeta?.truncated || sourceMeta?.checkFailed ? (
              <Text className="mt-4 text-center text-caption text-ink-faint">
                {sourceMeta.truncated
                  ? "Part of your source was too long to read — the notes cover what Sua could read."
                  : "Some numbers may not match your source — check the important ones."}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="Note options"
      >
        <Pressable
          onPress={() => {
            setMenuOpen(false);
            void queueGeneration();
          }}
          accessibilityRole="button"
          accessibilityLabel="Regenerate with AI"
          className="min-h-12 flex-row items-center gap-3 rounded-input bg-surface px-4 active:opacity-80"
        >
          <RefreshCw size={18} color={colors.brand.DEFAULT} />
          <View className="flex-1">
            <Text className="text-body font-sans-bold text-ink">
              Regenerate with AI
            </Text>
            <Text className="text-caption text-ink-soft">
              {generationKind === "course_reference"
                ? "Rewrite this reference sheet from your upload."
                : generationKind === "lecture_note"
                  ? "Rewrite the notes, summary, cards and quiz."
                  : "Rebuild the summary, cards and quiz."}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => {
            setMenuOpen(false);
            openEditor();
          }}
          accessibilityRole="button"
          accessibilityLabel="Edit this note"
          className="min-h-12 flex-row items-center gap-3 rounded-input bg-surface px-4 active:opacity-80"
        >
          <Pencil size={18} color={colors.brand.DEFAULT} />
          <Text className="flex-1 text-body font-sans-bold text-ink">
            Edit note
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setMenuOpen(false);
            setReportOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Report a mistake"
          className="min-h-12 flex-row items-center gap-3 rounded-input bg-surface px-4 active:opacity-80"
        >
          <Flag size={18} color={colors.brand.DEFAULT} />
          <Text className="flex-1 text-body font-sans-bold text-ink">
            Report a mistake
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setMenuOpen(false);
            confirmDelete();
          }}
          accessibilityRole="button"
          accessibilityLabel="Delete this note"
          className="min-h-12 flex-row items-center gap-3 rounded-input bg-danger-soft px-4 active:opacity-80"
        >
          <Trash2 size={18} color={colors.danger} />
          <Text className="flex-1 text-body font-sans-bold text-danger">
            Delete note
          </Text>
        </Pressable>
      </BottomSheet>

      <BottomSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report a mistake"
        subtitle="Tell us what the AI got wrong — it helps improve Sua."
      >
        {reported ? (
          <View className="rounded-input bg-success-soft p-4">
            <Text className="text-body font-sans-bold text-ink">
              Thanks — report sent.
            </Text>
          </View>
        ) : (
          <View className="gap-3">
            <TextInput
              value={reportComment}
              onChangeText={setReportComment}
              placeholder="What was wrong?"
              placeholderTextColor={pv.ink.faint}
              multiline
              textAlignVertical="top"
              className="min-h-24 rounded-input border border-line bg-surface p-3 text-body leading-6 text-ink"
              accessibilityLabel="Report comment"
            />
            <Pressable
              onPress={() => {
                if (!reportComment.trim() || reportSending) return;
                setReportSending(true);
                void (async () => {
                  try {
                    const token = await getAuthToken();
                    if (!token) throw new Error("Not signed in");
                    await jobsApi.feedback(token, {
                      targetType: "summary",
                      noteId: id,
                      comment: reportComment.trim(),
                      sourceText: note?.transcript ?? undefined,
                    });
                    setReported(true);
                    setReportComment("");
                  } catch {
                    Alert.alert(
                      "Couldn’t send the report",
                      "Try again when you’re connected.",
                    );
                  } finally {
                    setReportSending(false);
                  }
                })();
              }}
              disabled={!reportComment.trim() || reportSending}
              accessibilityRole="button"
              accessibilityLabel="Send report"
              className={`min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong active:opacity-80 ${
                !reportComment.trim() || reportSending ? "opacity-50" : ""
              }`}
            >
              <Text className="text-label font-sans-bold text-ink-inverse">
                {reportSending ? "Sending…" : "Send report"}
              </Text>
            </Pressable>
          </View>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}
