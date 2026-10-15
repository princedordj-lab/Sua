import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  Bold,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CloudUpload,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Mic,
  PenLine,
  Save,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from "lucide-react-native";
import { BottomSheet, CoursePickerSheet } from "../../../components/sheets";
import { colors } from "../../../config/theme";
import { courseInitials, courseStyle } from "../../../lib/course-style";
import { countNotesBySource, deleteNote, getNote, saveNote } from "../../../lib/notes";
import { useApp } from "../../../state/AppContext";
import type { Course } from "../../../lib/types";

const FREE_RECORDING_LIMIT = 9999;

const MODES = [
  { key: "recording", label: "Recording", Icon: Mic },
  { key: "typing", label: "Typing", Icon: PenLine },
] as const;

type Mode = (typeof MODES)[number]["key"];

// Formatting affordances from the reference design. Rich text editing is a
// follow-up, so the buttons render disabled until then.
const TOOLS = [
  { key: "bold", label: "Bold", Icon: Bold },
  { key: "italic", label: "Italic", Icon: Italic },
  { key: "heading", label: "Heading", Icon: Heading2 },
  { key: "bullet", label: "Bulleted list", Icon: List },
  { key: "numbered", label: "Numbered list", Icon: ListOrdered },
  { key: "undo", label: "Undo", Icon: Undo2 },
] as const;

const HELP_ROWS = [
  {
    Icon: Mic,
    title: "Record a lecture",
    body: "Tap the mic. Recording works offline and syncs when you reconnect.",
  },
  {
    Icon: CloudUpload,
    title: "Upload a file",
    body: "Audio, PDFs, slides, or a photo of the board.",
  },
  {
    Icon: PenLine,
    title: "Type a note",
    body: "Write it out, then save — or queue a summary for when you’re online.",
  },
] as const;

type TypedStatus = "idle" | "saving" | "saved" | "queued";

function clockLabel(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function usageBarWidth(ratio: number) {
  if (ratio <= 0) return "w-0";
  if (ratio >= 1) return "w-full";
  if (ratio >= 0.75) return "w-3/4";
  if (ratio >= 0.5) return "w-1/2";
  if (ratio >= 0.25) return "w-1/4";
  return "w-1/12";
}

// Fire-and-forget save for drafts that must not be lost outside an explicit
// tap on Save (note switch, blur, Done). Errors are swallowed: the draft
// stays in memory and the next explicit save retries.
function saveDraftQuietly(
  db: SQLiteDatabase,
  draft: { id: string; courseId: string; title: string; body: string; dirty: boolean },
) {
  if (!draft.dirty || !draft.courseId) return;
  void saveNote(db, {
    id: draft.id,
    courseId: draft.courseId,
    title: draft.title.trim() || "Untitled note",
    body: draft.body,
    sourceType: "typed",
  }).catch(() => {});
}

function SegmentedControl({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  return (
    <View className="mt-5 flex-row rounded-chip bg-surface p-1.5 shadow-card">
      {MODES.map(({ key, label, Icon }) => {
        const selected = mode === key;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-chip active:opacity-80 ${
              selected ? "bg-brand" : ""
            }`}
          >
            <Icon size={18} color={selected ? colors.ink.inverse : colors.ink.soft} />
            <Text
              className={`text-label font-sans-bold ${
                selected ? "text-ink-inverse" : "text-ink-soft"
              }`}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CourseSelect({ course, onPress }: { course?: Course; onPress: () => void }) {
  const style = course ? courseStyle(course.color) : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        course ? `Course: ${course.name}. Tap to change` : "Choose a course"
      }
      className="mt-4 flex-row items-center rounded-card bg-surface p-3 shadow-card active:opacity-80"
    >
      <View
        style={{ backgroundColor: style ? style.tint : colors.successSoft }}
        className="h-12 w-12 items-center justify-center rounded-input"
      >
        <Text
          style={{ color: style ? style.accent : colors.brand.DEFAULT }}
          className="text-body font-sans-extrabold"
        >
          {course ? courseInitials(course) : "+"}
        </Text>
      </View>
      <View className="ml-3 flex-1">
        <Text className="text-body-lg font-sans-bold text-ink" numberOfLines={1}>
          {course ? course.name : "Choose a course"}
        </Text>
        {course?.code ? (
          <Text className="mt-0.5 text-caption font-sans-bold text-ink-soft" numberOfLines={1}>
            {course.code}
          </Text>
        ) : null}
      </View>
      <ChevronDown size={20} color={colors.ink.faint} />
    </Pressable>
  );
}

function UsageMeter({ used, limit }: { used: number; limit: number }) {
  const reached = used >= limit;
  const bar = usageBarWidth(Math.min(1, used / limit));
  return (
    <View className="mt-4 rounded-card bg-surface p-card shadow-card">
      <View className="flex-row items-center justify-between">
        <Text className="text-body font-sans-semibold text-ink">
          {used} of {limit} recordings used
        </Text>
        {reached ? (
          <Text className="text-caption font-sans-extrabold text-danger">LIMIT REACHED</Text>
        ) : null}
      </View>
      <View className="mt-3 h-2 overflow-hidden rounded-chip bg-line">
        <View className={`h-full rounded-chip ${reached ? "bg-danger" : "bg-brand"} ${bar}`} />
      </View>
      {reached ? (
        <Text className="mt-2 text-small text-ink-soft">
          Free plan limit. Upgrade in your profile for unlimited recordings.
        </Text>
      ) : null}
    </View>
  );
}

function UploadCard() {
  return (
    <View className="mt-4 items-center rounded-card border-2 border-dashed border-line bg-surface px-5 py-6">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-success-soft">
        <CloudUpload size={26} color={colors.brand.DEFAULT} strokeWidth={2.25} />
      </View>
      <Text className="mt-3 text-body-lg font-sans-extrabold text-ink">
        Already have a file?
      </Text>
      <Text className="mt-1 text-center text-small text-ink-soft">
        Upload audio, PDF, slides or a photo of the board
      </Text>
      <Pressable
        onPress={() =>
          Alert.alert(
            "File upload",
            "Picking files from your device is coming soon. Record or type your note for now.",
          )
        }
        accessibilityRole="button"
        accessibilityLabel="Choose file"
        className="mt-4 min-h-12 flex-row items-center justify-center rounded-btn border border-brand px-6 active:opacity-80"
      >
        <Text className="text-body font-sans-bold text-brand">Choose file</Text>
      </Pressable>
    </View>
  );
}

export default function Create() {
  const db = useSQLiteContext();
  const { courses } = useApp();
  const params = useLocalSearchParams<{ mode?: string; noteId?: string; courseId?: string }>();

  const [mode, setMode] = useState<Mode>(
    params.mode === "typing" ? "typing" : "recording",
  );
  // null = follow the first loaded course until the user picks one explicitly.
  const [pickedCourseId, setPickedCourseId] = useState<string | null>(null);
  const [pickingCourse, setPickingCourse] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [wifiOnly, setWifiOnly] = useState(true);

  // Typing draft lives up here so switching modes never drops the text.
  // The id is a fresh draft until an edit session swaps it for a stored note.
  const [typedNoteId, setTypedNoteId] = useState(() => `note-${Date.now()}`);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [typedStatus, setTypedStatus] = useState<TypedStatus>("idle");
  const [savedAt, setSavedAt] = useState(nowLabel());
  const [dirty, setDirty] = useState(false);

  const [usedRecordings, setUsedRecordings] = useState(0);
  const [recordPhase, setRecordPhase] = useState<
    "idle" | "starting" | "recording" | "saved"
  >("idle");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recordings live in the document directory: they are study material, not
  // throwaway cache.
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    directory: "document",
  });
  const recorderState = useAudioRecorderState(recorder);

  // Re-read the route params when they change (e.g. Home's Type tile or a
  // course detail pushing a second time) — the adjust-during-render pattern
  // instead of an effect.
  const [seenModeParam, setSeenModeParam] = useState(params.mode);
  if (params.mode !== seenModeParam) {
    setSeenModeParam(params.mode);
    if (params.mode === "typing") setMode("typing");
    else if (params.mode === "recording") setMode("recording");
  }
  const [seenNoteParam, setSeenNoteParam] = useState(params.noteId);
  if (params.noteId !== seenNoteParam) {
    setSeenNoteParam(params.noteId);
    if (params.noteId) {
      // Opening a stored note: force typing; the load effect swaps the
      // content. The session reset (Done/Delete) happens in those handlers.
      setMode("typing");
    }
  }
  const [seenCourseParam, setSeenCourseParam] = useState(params.courseId);
  if (params.courseId !== seenCourseParam) {
    setSeenCourseParam(params.courseId);
    if (params.courseId) setPickedCourseId(params.courseId);
  }

  // Follow the first loaded course until the user picks one explicitly.
  const courseId = pickedCourseId ?? courses[0]?.id ?? "";
  const course = useMemo(
    () => courses.find((item) => item.id === courseId),
    [courses, courseId],
  );
  const limitReached = usedRecordings >= FREE_RECORDING_LIMIT;
  // A note requested by the route that this screen hasn't swapped in yet.
  const targetNoteId =
    params.noteId && params.noteId !== "new" ? params.noteId : null;
  const noteLoading = Boolean(targetNoteId && targetNoteId !== typedNoteId);
  const canSave =
    Boolean(course) &&
    (title.trim().length > 0 || body.trim().length > 0) &&
    typedStatus !== "saving" &&
    !noteLoading;

  const isEditing = Boolean(targetNoteId);

  // Latest draft for fire-and-forget saves that run outside the render
  // closure (note switch, blur, Done) without exhausting effect deps.
  const draftRef = useRef({ id: typedNoteId, courseId, title, body, dirty });
  useEffect(() => {
    draftRef.current = { id: typedNoteId, courseId, title, body, dirty };
  });

  // Swap in an existing note when ?noteId= arrives (and silently save the
  // outgoing draft first so nothing typed is lost). noteLoading is derived
  // from targetNoteId !== typedNoteId, so this effect never flips state
  // synchronously — it only completes the swap (or un-sticks on failure).
  useEffect(() => {
    const target = params.noteId;
    if (!target || target === "new") return;
    if (target === typedNoteId) return;
    const outgoing = draftRef.current;
    if (outgoing.id !== target) saveDraftQuietly(db, outgoing);
    let cancelled = false;
    getNote(db, target)
      .then((note) => {
        if (cancelled) return;
        if (note) {
          setTypedNoteId(note.id);
          setTitle(note.title);
          setBody(note.body);
          setPickedCourseId(note.courseId);
          setTypedStatus("idle");
          setDirty(false);
        } else {
          // Unknown id: show an empty draft so Save can (re)create it.
          setTypedNoteId(target);
          setTitle("");
          setBody("");
          setTypedStatus("idle");
          setDirty(false);
        }
      })
      .catch(() => {
        // Keep what's on screen but un-stick the derived loading state.
        if (!cancelled) setTypedNoteId(target);
      });
    return () => {
      cancelled = true;
    };
  }, [db, params.noteId, typedNoteId]);

  // Leaving the screen with unsaved edits keeps them: silent save on blur.
  useFocusEffect(
    useCallback(() => {
      return () => {
        saveDraftQuietly(db, draftRef.current);
      };
    }, [db]),
  );

  useEffect(() => {
    let cancelled = false;
    countNotesBySource(db, "audio")
      .then((count) => {
        if (!cancelled) setUsedRecordings(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

  // Leaving the screen abandons any live recording; the saved-notes flow is
  // explicit (tap stop) so nothing half-recorded is written.
  useEffect(() => {
    const recorderRef = recorder;
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (recorderRef.isRecording) void recorderRef.stop().catch(() => {});
    };
  }, [recorder]);

  const startRecording = async () => {
    if (recordPhase !== "idle") return;
    if (!course) {
      Alert.alert("Pick a course first", "Choose which course this lecture belongs to.");
      return;
    }
    if (limitReached) {
      Alert.alert(
        "Recording limit reached",
        `The free plan includes ${FREE_RECORDING_LIMIT} recordings. Upgrade in your profile for unlimited recordings.`,
      );
      return;
    }
    setRecordPhase("starting");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setRecordPhase("idle");
        Alert.alert(
          "Microphone access needed",
          "Allow microphone access in Settings to record your lectures.",
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordPhase("recording");
    } catch {
      setRecordPhase("idle");
      Alert.alert("Couldn’t start recording", "Try again in a moment.");
    }
  };

  const stopRecording = async () => {
    if (recordPhase !== "recording") return;
    try {
      await recorder.stop();
      // Stop first whatever happens; only the save step needs a course.
      if (!course) {
        setRecordPhase("idle");
        return;
      }
      await saveNote(db, {
        id: `note-${Date.now()}`,
        courseId: course.id,
        title: `Recording · ${nowLabel()}`,
        body: "",
        sourceType: "audio",
        sourceRef: recorder.uri,
      });
      setUsedRecordings((count) => count + 1);
      setRecordPhase("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setRecordPhase("idle"), 3000);
    } catch {
      setRecordPhase("idle");
      Alert.alert("Recording failed", "The recording could not be saved. Try again.");
    }
  };

  const persistNote = async (queueSummary: boolean) => {
    if (!course || !canSave) return;
    setTypedStatus("saving");
    try {
      await saveNote(db, {
        id: typedNoteId,
        courseId: course.id,
        title: title.trim() || "Untitled note",
        body,
        sourceType: "typed",
      });
      setSavedAt(nowLabel());
      setTypedStatus(queueSummary ? "queued" : "saved");
      setDirty(false);
    } catch {
      setTypedStatus("idle");
      Alert.alert("Couldn’t save the note", "Your text is still here — try saving again.");
    }
  };

  // Shared session reset for Done and Delete. Runs in an event handler, so
  // generating the fresh draft id here keeps render pure. The ref is marked
  // clean immediately so a blur firing mid-navigation can't re-save (or
  // resurrect a just-deleted note).
  const resetDraftSession = () => {
    draftRef.current = { ...draftRef.current, dirty: false };
    setTypedNoteId(`note-${Date.now()}`);
    setTitle("");
    setBody("");
    setTypedStatus("idle");
    setDirty(false);
  };

  // Done: keep everything typed (quiet save) and drop back to a fresh draft,
  // returning to whichever screen opened the note when there is one. Reads
  // state directly — this closure is re-rendered with every keystroke.
  const finishEditing = () => {
    saveDraftQuietly(db, { id: typedNoteId, courseId, title, body, dirty });
    resetDraftSession();
    router.setParams({ noteId: "", courseId: "" });
    if (router.canGoBack()) router.back();
  };

  const confirmDeleteNote = () => {
    const target = params.noteId;
    if (!target || target === "new") return;
    const label = title.trim() || "this note";
    Alert.alert(
      `Delete ${label.length > 28 ? `${label.slice(0, 28)}…` : label}?`,
      "This removes the note from this device and queues the deletion for sync.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            // Guard the window while delete is in flight: a blur in here
            // must not quiet-save the draft back over the deleted row.
            draftRef.current = { ...draftRef.current, dirty: false };
            deleteNote(db, target)
              .then(() => {
                resetDraftSession();
                router.setParams({ noteId: "", courseId: "" });
                if (router.canGoBack()) router.back();
              })
              .catch(() => {
                draftRef.current = { ...draftRef.current, dirty: true };
                Alert.alert("Couldn’t delete the note", "Try again in a moment.");
              });
          },
        },
      ],
    );
  };

  const typedStatusLabel = noteLoading
    ? "Loading…"
    : typedStatus === "saving"
      ? "Saving…"
      : typedStatus === "saved"
        ? `Saved ${savedAt}`
        : typedStatus === "queued"
          ? "Summary queued"
          : "Offline note";

  const isRecording = recordPhase === "recording";

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerClassName="px-screen pb-tabbar pt-6"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-h1 font-sans-extrabold text-ink">Create</Text>
          <Pressable
            onPress={() => setHelpOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Help with creating"
            className="h-11 w-11 items-center justify-center rounded-full border border-line bg-surface active:opacity-80"
          >
            <CircleHelp size={20} color={colors.ink.soft} />
          </Pressable>
        </View>

        {courses.length === 0 ? (
          <View className="mt-5 items-center rounded-card bg-surface p-card-lg shadow-card">
            <Text className="text-body-lg font-sans-extrabold text-ink">
              Add a course first
            </Text>
            <Text className="mt-2 text-center text-body text-ink-soft">
              Every recording and note belongs to a course, so your study material
              stays organized.
            </Text>
            <Pressable
              onPress={() => router.push("/(app)/(tabs)/courses")}
              className="mt-4 min-h-12 flex-row items-center justify-center rounded-btn bg-brand px-6 active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Add a course"
            >
              <Text className="text-body font-sans-bold text-gold">Add a course</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <SegmentedControl mode={mode} onChange={setMode} />
            <CourseSelect course={course} onPress={() => setPickingCourse(true)} />

            {mode === "recording" ? (
              <>
                <View className="mt-4 items-center rounded-card bg-surface p-card-lg shadow-card">
                  <Pressable
                    onPress={isRecording ? stopRecording : startRecording}
                    disabled={recordPhase === "starting"}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isRecording ? "Stop recording" : "Start recording"
                    }
                    accessibilityState={{ busy: recordPhase === "starting" }}
                    className={`active:opacity-90 ${
                      recordPhase === "starting" || limitReached ? "opacity-60" : ""
                    }`}
                  >
                    <View
                      className={`h-44 w-44 items-center justify-center rounded-full ${
                        isRecording ? "bg-success-soft/70" : "bg-gold-soft/60"
                      }`}
                    >
                      <View
                        className={`h-36 w-36 items-center justify-center rounded-full ${
                          isRecording ? "bg-success-soft" : "bg-gold-soft"
                        }`}
                      >
                        <View
                          className={`h-28 w-28 items-center justify-center rounded-full border-4 border-white ${
                            isRecording ? "bg-brand" : "bg-gold"
                          } shadow-gold`}
                        >
                          {isRecording ? (
                            <Square
                              size={30}
                              color={colors.ink.inverse}
                              fill={colors.ink.inverse}
                            />
                          ) : (
                            <Mic size={38} color={colors.ink.DEFAULT} strokeWidth={2.25} />
                          )}
                        </View>
                      </View>
                    </View>
                  </Pressable>

                  {isRecording ? (
                    <>
                      <Text className="mt-6 text-display font-sans-extrabold text-ink">
                        {clockLabel(recorderState.durationMillis / 1000)}
                      </Text>
                      <Text className="mt-1 text-body font-sans-semibold text-ink-soft">
                        Recording… tap to stop
                      </Text>
                    </>
                  ) : recordPhase === "saved" ? (
                    <>
                      <Text className="mt-6 text-title font-sans-extrabold text-ink">
                        Saved offline
                      </Text>
                      <Text className="mt-1 text-center text-body text-ink-soft">
                        We’ll transcribe it when you’re connected.
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text className="mt-6 text-title font-sans-extrabold text-ink">
                        Ready to record
                      </Text>
                      <Text className="mt-1 text-center text-body text-ink-soft">
                        Works offline. We’ll process it when you’re connected.
                      </Text>
                    </>
                  )}

                  {recordPhase === "idle" ? (
                    <View className="mt-5 flex-row flex-wrap items-center justify-center gap-3">
                      <View className="flex-row items-center gap-2 rounded-chip bg-success-soft px-3 py-2">
                        <Text className="text-small font-sans-bold text-ink">
                          Wi-Fi only upload
                        </Text>
                        <Switch
                          value={wifiOnly}
                          onValueChange={setWifiOnly}
                          trackColor={{ true: colors.brand.DEFAULT, false: colors.line }}
                          thumbColor={colors.surface}
                          accessibilityLabel="Wi-Fi only upload"
                        />
                      </View>
                      <View className="flex-row items-center gap-1.5 rounded-chip bg-success-soft px-3 py-2">
                        <CheckCircle2 size={15} color={colors.brand.DEFAULT} />
                        <Text className="text-small font-sans-bold text-ink">
                          Saved offline
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </View>

                <UploadCard />
                <UsageMeter used={usedRecordings} limit={FREE_RECORDING_LIMIT} />
              </>
            ) : (
              <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                className="mt-4"
              >
                <View className="rounded-card bg-surface p-card-lg shadow-card">
                  <View className="flex-row items-start justify-between gap-3">
                    <TextInput
                      value={title}
                      onChangeText={(value) => {
                        setTitle(value);
                        setDirty(true);
                      }}
                      placeholder="Note title"
                      placeholderTextColor={colors.ink.faint}
                      className="flex-1 text-h3 font-sans-extrabold text-ink"
                      accessibilityLabel="Note title"
                    />
                    <View className="items-end gap-2">
                      <View className="flex-row items-center gap-1.5 rounded-chip bg-success-soft px-2.5 py-1.5">
                        <CheckCircle2 size={14} color={colors.brand.DEFAULT} />
                        <Text className="text-caption font-sans-bold text-brand">
                          {typedStatusLabel}
                        </Text>
                      </View>
                      {isEditing ? (
                        <View className="flex-row items-center gap-3">
                          <Pressable
                            onPress={finishEditing}
                            accessibilityRole="button"
                            accessibilityLabel="Done editing"
                            className="min-h-8 flex-row items-center justify-center rounded-btn border border-brand px-3 active:opacity-80"
                          >
                            <Text className="text-caption font-sans-bold text-brand">Done</Text>
                          </Pressable>
                          <Pressable
                            onPress={confirmDeleteNote}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="Delete note"
                            className="h-8 w-8 items-center justify-center rounded-full active:opacity-80"
                          >
                            <Trash2 size={17} color={colors.danger} />
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  </View>
                  <TextInput
                    value={body}
                    onChangeText={(value) => {
                      setBody(value);
                      setDirty(true);
                    }}
                    placeholder="Start writing…"
                    placeholderTextColor={colors.ink.faint}
                    multiline
                    textAlignVertical="top"
                    className="mt-3 min-h-44 text-body leading-7 text-ink"
                    accessibilityLabel="Note body"
                  />
                  <View className="mt-3 flex-row items-center justify-between border-t border-line pt-2">
                    {TOOLS.map(({ key, label, Icon }) => (
                      <Pressable
                        key={key}
                        disabled
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityState={{ disabled: true }}
                        className="h-11 w-11 items-center justify-center rounded-input opacity-50"
                      >
                        <Icon size={19} color={colors.ink.DEFAULT} />
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View className="mt-4 flex-row gap-3">
                  <Pressable
                    onPress={() => persistNote(false)}
                    disabled={!canSave}
                    className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-brand bg-surface active:opacity-80 ${
                      canSave ? "" : "opacity-45"
                    }`}
                    accessibilityRole="button"
                    accessibilityLabel="Save note"
                  >
                    <Save size={17} color={colors.brand.DEFAULT} />
                    <Text className="text-label font-sans-bold text-brand">Save</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => persistNote(true)}
                    disabled={!canSave}
                    className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-btn bg-gold shadow-gold active:opacity-80 ${
                      canSave ? "" : "opacity-45"
                    }`}
                    accessibilityRole="button"
                    accessibilityLabel="Save and summarise"
                  >
                    <Sparkles size={17} color={colors.ink.DEFAULT} />
                    <Text className="text-label font-sans-extrabold text-ink">
                      Save and summarise
                    </Text>
                  </Pressable>
                </View>
              </KeyboardAvoidingView>
            )}
          </>
        )}
      </ScrollView>

      <CoursePickerSheet
        visible={pickingCourse}
        courses={courses}
        currentCourseId={courseId}
        heading="Create in"
        onSelect={(targetId) => {
          setPickingCourse(false);
          setPickedCourseId(targetId);
        }}
        onClose={() => setPickingCourse(false)}
      />

      <BottomSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Creating with Sua"
        subtitle="Three ways to turn a lesson into study material."
      >
        {HELP_ROWS.map(({ Icon, title: rowTitle, body: rowBody }) => (
          <View key={rowTitle} className="flex-row gap-3 rounded-input bg-surface p-4">
            <View className="h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success-soft">
              <Icon size={20} color={colors.brand.DEFAULT} />
            </View>
            <View className="flex-1">
              <Text className="text-body font-sans-bold text-ink">{rowTitle}</Text>
              <Text className="mt-0.5 text-small leading-5 text-ink-soft">{rowBody}</Text>
            </View>
          </View>
        ))}
      </BottomSheet>
    </SafeAreaView>
  );
}
