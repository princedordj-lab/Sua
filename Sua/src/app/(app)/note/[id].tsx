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
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronUp,
  Flag,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import { BottomSheet } from "../../../components/sheets";
import { Markdown, type MarkdownScale } from "../../../components/markdown";
import { useStringSetting } from "../../../state/settings";
import { jobsApi } from "../../../lib/api";
import {
  countPendingUploads,
  deleteNote,
  enqueueGeneration,
  getLastGenerationKind,
  getNote,
  listFlashcards,
  listQuizzes,
  pullCourseNotes,
  type Note,
} from "../../../lib/notes";
import {
  drainGenerationQueue,
  generationKindFor,
  reconcileAiOutputs,
  refreshNoteFromServer,
} from "../../../lib/generate";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useApp } from "../../../state/AppContext";
import type { GenerationKind } from "../../../lib/types";

const AI_ACTIVE_STATES = [
  "queued",
  "transcribing",
  "summarising",
  "making_cards",
  "writing",
] as const;

function stageLabel(note: Note, pendingUploads: number) {
  if (note.aiState === "queued") {
    return pendingUploads > 0 && note.sourceType !== "typed"
      ? "Waiting for your upload to finish…"
      : "Waiting to be processed…";
  }
  if (note.aiState === "transcribing") return "Transcribing your lecture…";
  if (note.aiState === "summarising") return "Writing your summary…";
  if (note.aiState === "writing") {
    return note.noteKind === "reference"
      ? "Writing your reference…"
      : "Writing your lecture note…";
  }
  return "Making your flashcards and a quiz…";
}

export default function NoteView() {
  const pv = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const noteScale = useStringSetting(db, "note_text_scale", "medium");
  const noteScaleValue = (["small", "medium", "large"].includes(noteScale.value)
    ? noteScale.value
    : "medium") as MarkdownScale;
  const { courses, getAuthToken } = useApp();
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [flashcardCount, setFlashcardCount] = useState(0);
  const [quizCount, setQuizCount] = useState(0);
  const [quizId, setQuizId] = useState<string | null>(null);
  const [lastGenerationKind, setLastGenerationKind] =
    useState<GenerationKind | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportComment, setReportComment] = useState("");
  const [reportSending, setReportSending] = useState(false);
  const [reported, setReported] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const screenActiveRef = useRef(false);
  const retryingRef = useRef(false);

  const course = courses.find((item) => item.id === note?.courseId);
  const aiActive = note
    ? (AI_ACTIVE_STATES as readonly string[]).includes(note.aiState)
    : false;

  const load = useCallback(async () => {
    try {
      const row = await getNote(db, id);
      if (!screenActiveRef.current) return;
      setNote(row);
      setMissing(!row);
      if (!row) {
        setPendingUploads(0);
        setFlashcardCount(0);
        setQuizCount(0);
        setQuizId(null);
        setLastGenerationKind(null);
        return;
      }
      const [pending, cards, quizzes, lastKind] = await Promise.all([
        countPendingUploads(db, row.id),
        listFlashcards(db, row.id).catch(() => []),
        listQuizzes(db, row.id).catch(() => []),
        getLastGenerationKind(db, row.id).catch(() => null),
      ]);
      if (!screenActiveRef.current) return;
      setPendingUploads(pending);
      setFlashcardCount(cards.length);
      setQuizCount(quizzes.length);
      setQuizId(quizzes[0]?.id ?? null);
      setLastGenerationKind(lastKind);
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

  // Retries reuse the destination the student originally chose; a reference
  // always regenerates as a reference. See generationKindFor().
  const generationKind = generationKindFor(note, lastGenerationKind);

  // The empty-state call to action follows the destination this note is for.
  const emptyStateCopy = useMemo(() => {
    if (generationKind === "course_reference") {
      return {
        title: "Make a course reference from this?",
        body: "A condensed reference sheet with key terms and key facts — no flashcards or quiz.",
        cta: "Make reference",
      };
    }
    if (generationKind === "lecture_note") {
      return {
        title: "Turn this capture into a lecture note?",
        body: "Sua writes a full note, then adds a summary, flashcards and a quiz.",
        cta: "Write note",
      };
    }
    return {
      title: "Turn this note into a study set?",
      body: "A summary with flashcards and a quiz, in one tap.",
      cta: "Generate",
    };
  }, [generationKind]);

  const queueGeneration = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await enqueueGeneration(db, id, generationKind);
      await load();
      await drainGenerationQueue({ db, getAuthToken });
    } catch {
      if (screenActiveRef.current) Alert.alert(
        "Couldn’t queue the generation",
        "Your note is saved — try again in a moment.",
      );
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

  // Mirror pipeline stages live while a generation is in flight. Upload
  // conversions have no local queue row, so the server job is the source.
  useEffect(() => {
    if (!aiActive) return;
    const timer = setInterval(() => {
      void refreshNoteFromServer({ db, getAuthToken }, id)
        .catch(() => {})
        .finally(() => {
          if (screenActiveRef.current) void load();
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
    if (note.aiState !== "ready" || flashcardCount > 0 || quizCount > 0) return;
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
  }, [db, flashcardCount, getAuthToken, load, note, quizCount]);

  const confirmDelete = () => {
    Alert.alert(
      "Delete this note?",
      "The note and its uploads are removed from this device and your account when you next connect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteNote(db, id);
                if (router.canGoBack()) router.back();
                else router.replace("/courses");
              } catch {
                Alert.alert("Couldn’t delete", "Try again in a moment.");
              }
            })();
          },
        },
      ],
    );
  };

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

  const reference = note?.noteKind === "reference";

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
            className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          </Pressable>
          <View className="flex-1 items-center px-2">
            <Text numberOfLines={1} className="text-body-lg font-sans-extrabold text-ink">
              {note?.title || "Untitled note"}
            </Text>
          </View>
          <Pressable
            onPress={() =>
              note &&
              router.push({
                pathname: "/(app)/(tabs)/create",
                params: { mode: "typing", noteId: note.id, courseId: note.courseId },
              })
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Edit this note"
            className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <Pencil size={18} color={pv.ink.DEFAULT} />
          </Pressable>
          <Pressable
            onPress={confirmDelete}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Delete this note"
            className="ml-1 h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <Trash2 size={18} color={colors.danger} />
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
                    Lecture note
                  </Text>
                </View>
              )}
              {course ? (
                <View className="rounded-chip bg-surface px-2.5 py-1.5">
                  <Text className="text-caption font-sans-bold text-ink-soft">
                    {course.code || course.name}
                  </Text>
                </View>
              ) : null}
              <View className="flex-1 items-end">
                <Text className="text-caption text-ink-faint">
                  {note.syncState === "pending" ? "Waiting to sync" : "Synced"}
                </Text>
              </View>
            </View>

            {note.aiState === "failed" ? (
              <View className="mt-4 rounded-card border border-warning bg-warning-soft p-card">
                <View className="flex-row items-center gap-2">
                  <AlertTriangle size={18} color={colors.warning} />
                  <Text className="text-body-lg font-sans-extrabold text-ink">
                    {reference
                      ? "Couldn’t finish the reference"
                      : "Couldn’t finish the summary"}
                  </Text>
                </View>
                <Text className="mt-1 text-small leading-5 text-ink-soft">
                  Try again while you’re connected. Your note is safe.
                </Text>
                {pendingUploads > 0 ? (
                  <Pressable
                    onPress={() => router.push("/uploads")}
                    accessibilityRole="link"
                    accessibilityLabel="Check upload status first"
                    className="mt-2 active:opacity-70"
                  >
                    <Text className="text-small font-sans-bold text-brand">
                      Some files still need to upload — check Uploads first.
                    </Text>
                  </Pressable>
                ) : null}
                <View className={`mt-3 self-start ${retrying ? "opacity-60" : ""}`}>
                  <Pressable
                    disabled={retrying}
                    onPress={() => void queueGeneration()}
                    accessibilityRole="button"
                    accessibilityLabel="Try generating again"
                    className="min-h-10 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong px-4 active:opacity-80"
                  >
                    <RefreshCw size={15} color={colors.ink.inverse} />
                    <Text className="text-label font-sans-bold text-ink-inverse">
                      Try again
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : aiActive ? (
              <View className="mt-4 flex-row items-center justify-between gap-2 rounded-card bg-surface p-card shadow-card">
                <View className="flex-row flex-1 items-center gap-2.5">
                  <Loader2 size={17} color={colors.brand.DEFAULT} />
                  <Text className="flex-1 text-body font-sans-bold text-ink">
                    {stageLabel(note, pendingUploads)}
                  </Text>
                </View>
                {pendingUploads > 0 ? (
                  <Pressable
                    onPress={() => router.push("/uploads")}
                    accessibilityRole="link"
                    accessibilityLabel="View upload progress"
                    className="active:opacity-70"
                  >
                    <Text className="text-caption font-sans-bold text-brand">
                      View uploads
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Reference pages are written straight into the body. */}
            {reference ? (
              note.body ? (
                <View className="mt-4 rounded-card bg-surface p-card-lg shadow-card">
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-2">
                      <BookOpen size={18} color={colors.brand.DEFAULT} />
                      <Text className="text-body-lg font-sans-extrabold text-ink">
                        Reference
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => setReportOpen(true)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Report a mistake in the reference"
                      className="h-9 w-9 items-center justify-center rounded-full active:opacity-80"
                    >
                      <Flag size={17} color={pv.ink.faint} />
                    </Pressable>
                  </View>
                  <Markdown text={note.body} className="mt-3" scale={noteScaleValue} />
                  <Text className="mt-2 text-caption text-ink-faint">
                    AI study aid — verify important facts against your textbook.
                  </Text>
                </View>
              ) : !aiActive && note.aiState !== "failed" ? (
                <View className="mt-4 rounded-card bg-surface p-card shadow-card">
                  <Text className="text-body font-sans-bold text-ink">
                    Sua hasn’t written this page yet.
                  </Text>
                  <Pressable
                    onPress={() => void queueGeneration()}
                    accessibilityRole="button"
                    accessibilityLabel="Generate the course reference"
                    className="mt-3 min-h-10 flex-row items-center justify-center gap-2 self-start rounded-btn bg-brand-strong px-4 active:opacity-80"
                  >
                    <RefreshCw size={15} color={colors.ink.inverse} />
                    <Text className="text-label font-sans-bold text-ink-inverse">
                      Make it now
                    </Text>
                  </Pressable>
                </View>
              ) : null
            ) : (
              <>
                {note.summary ? (
                  <View className="mt-4 rounded-card bg-surface p-card-lg shadow-card">
                    <View className="flex-row items-center justify-between">
                      <View className="flex-row items-center gap-2">
                        <Sparkles size={18} color={colors.brand.DEFAULT} />
                        <Text className="text-body-lg font-sans-extrabold text-ink">
                          AI Study Summary
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => setReportOpen(true)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Report a mistake in the summary"
                        className="h-9 w-9 items-center justify-center rounded-full active:opacity-80"
                      >
                        <Flag size={17} color={pv.ink.faint} />
                      </Pressable>
                    </View>
                    <Markdown text={note.summary} className="mt-3" />
                    <Text className="mt-2 text-caption text-ink-faint">
                      AI study aid — verify important facts against your textbook.
                    </Text>
                  </View>
                ) : null}

                {note.body ? (
                  <View className="mt-4 rounded-card bg-surface p-card-lg shadow-card">
                    <Text className="text-caption font-sans-extrabold text-ink-soft">
                      YOUR TEXT
                    </Text>
                    <Markdown text={note.body} className="mt-2" />
                  </View>
                ) : !aiActive && note.aiState === "none" && !note.summary ? (
                  <View className="mt-4 rounded-card bg-surface p-card shadow-card">
                    <Text className="text-body font-sans-bold text-ink">
                      {emptyStateCopy.title}
                    </Text>
                    <Text className="mt-1 text-small leading-5 text-ink-soft">
                      {emptyStateCopy.body}
                    </Text>
                    <Pressable
                      onPress={() => void queueGeneration()}
                      accessibilityRole="button"
                      accessibilityLabel={`Generate ${generationKind === "course_reference" ? "a course reference" : generationKind === "lecture_note" ? "a lecture note" : "a study set"}`}
                      className="mt-3 min-h-10 flex-row items-center justify-center gap-2 self-start rounded-btn bg-brand-strong px-4 active:opacity-80"
                    >
                      <Sparkles size={15} color={colors.ink.inverse} />
                      <Text className="text-label font-sans-bold text-ink-inverse">
                        {emptyStateCopy.cta}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
            )}

            {reference ? null : (
              <View className="mt-4 flex-row gap-3">
                <Pressable
                  disabled={flashcardCount === 0}
                  onPress={() =>
                    router.push({ pathname: "/deck/[id]", params: { id: String(id) } })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Open this note's deck"
                  // NativeWind #1711/#1712: a className that toggles (shadow-card
                  // + active:opacity here) on a Pressable crashes the navigation
                  // tree on RN 0.86 — the class set stays static; `disabled`
                  // already gates interaction.
                  className="flex-1 rounded-card bg-surface p-card shadow-card active:opacity-80"
                >
                  <Text className="text-caption font-sans-extrabold text-ink-soft">
                    FLASHCARDS
                  </Text>
                  <Text className="mt-1 text-body-lg font-sans-extrabold text-ink">
                    {flashcardCount}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={quizCount === 0}
                  onPress={() =>
                    router.push({ pathname: "/quiz/[id]", params: { id: quizId ?? "" } })
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Open this note's quiz"
                  className="flex-1 rounded-card bg-surface p-card shadow-card"
                >
                  <Text className="text-caption font-sans-extrabold text-ink-soft">
                    QUIZ
                  </Text>
                  <Text className="mt-1 text-body-lg font-sans-extrabold text-ink">
                    {quizCount}
                  </Text>
                </Pressable>
              </View>
            )}

            {note.transcript ? (
              <Pressable
                onPress={() => setTranscriptOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityLabel={
                  transcriptOpen ? "Hide the transcript" : "Show the transcript"
                }
                className="mt-4 flex-row items-center justify-between rounded-card bg-surface p-card shadow-card active:opacity-80"
              >
                <Text className="text-body font-sans-bold text-ink">
                  Transcript
                </Text>
                {transcriptOpen ? (
                  <ChevronUp size={18} color={pv.ink.faint} />
                ) : (
                  <ChevronDown size={18} color={pv.ink.faint} />
                )}
              </Pressable>
            ) : null}
            {note.transcript && transcriptOpen ? (
              <View className="mt-2 rounded-card bg-surface p-card">
                <Markdown text={note.transcript} scale={noteScaleValue} />
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report a mistake"
        subtitle="Tell us what the AI got wrong — it helps improve Sua."
      >
        {reported ? (
          <View className="rounded-input bg-success-soft p-4">
            <Text className="text-body font-sans-bold text-ink">Thanks — report sent.</Text>
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
                    Alert.alert("Couldn’t send the report", "Try again when you’re connected.");
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
