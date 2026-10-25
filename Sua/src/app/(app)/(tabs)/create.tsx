import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { getDocumentAsync } from "expo-document-picker";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
} from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import { EnrichedMarkdownTextInput } from "react-native-enriched-markdown";
import type {
  EnrichedMarkdownTextInputInstance,
  MarkdownTextInputStyle,
  StyleState,
} from "react-native-enriched-markdown";
import {
  AlertTriangle,
  Bold,
  Camera,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CloudUpload,
  FileText,
  Flag,
  Heading,
  Image as ImageIcon,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Mic,
  Pause,
  PenLine,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  BookOpen,
} from "lucide-react-native";
import { BottomSheet, CoursePickerSheet } from "../../../components/sheets";
import { Markdown } from "../../../components/markdown";
import { ProgressBar } from "../../../components/progress-bar";
import { WifiToggle } from "../../../components/wifi-toggle";
import { colors, fontFamily } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { useStringSetting } from "../../../state/settings";
import { courseStyle } from "../../../lib/course-style";
import {
  addRecordingSegment,
  completeRecordingSession,
  countAudioNotesThisMonth,
  createRecordingSession,
  deleteNote,
  discardRecordingSession,
  enqueueGeneration,
  enqueueUpload,
  finalizeSegment,
  getNote,
  getSetting,
  getLastGenerationKind,
  listInProgressRecordings,
  listSessionSegments,
  listUploadQueue,
  newId,
  removeRecordingSegment,
  removeUploadQueueItem,
  saveNote,
  setSetting,
  touchSegmentDuration,
  updateUploadState,
} from "../../../lib/notes";
import type {
  AiState,
  GenerationKind,
  Note,
  NoteKind,
  RecordingSegment,
  RecordingSession,
  UploadKind,
  UploadQueueItem,
  UploadTarget,
} from "../../../lib/notes";
import { drainGenerationQueue, generationKindFor } from "../../../lib/generate";
import { jobsApi } from "../../../lib/api";
import { flushUploads } from "../../../lib/uploads";
import {
  ensureCameraPermission,
  ensureMicPermission,
  promptForSettings,
} from "../../../lib/permissions";
import { useApp } from "../../../state/AppContext";
import type { Course } from "../../../lib/types";

// The spec's free tier is 3 recordings/month; enforcement lands with billing
// (M5), so the cap exists but stays out of the way for now.
const FREE_RECORDING_LIMIT = 9999;
// Free-plan 60-minute cap, enforced by the app's own chunk timer.
const RECORDING_LIMIT_MS = 60 * 60 * 1000;
// A crash, call, or dead battery loses at most this much audio: the recorder
// stops and restarts on every boundary, finalising each chunk's file.
const SEGMENT_MS = 2 * 60 * 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const AUTOSAVE_DELAY_MS = 1500;

// The two destinations the student picks map to three server job kinds.
// "Lecture note" always requests a real AI-written note (not just a summary).
function jobKindForTarget(target: UploadTarget): GenerationKind {
  return target === "course_reference" ? "course_reference" : "lecture_note";
}

function noteKindForTarget(target: UploadTarget): NoteKind {
  return target === "course_reference" ? "reference" : "note";
}

// Third-party native component without NativeWind support: typography flows
// through StyleSheet with theme tokens, matching the renderer's size classes.
const editorStyleSheet = StyleSheet.create({
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fontFamily.sans,
    minHeight: 176,
    textAlignVertical: "top",
  },
});
// Color flows through the resolved palette at the call site so the editor and
// its markdown token styles follow the appearance preference.
function editorBodyStyle(ink: string) {
  return { ...editorStyleSheet.body, color: ink } as const;
}
function editorMarkdownStyle(ink: string): MarkdownTextInputStyle {
  return {
    strong: { color: ink },
    em: { color: ink },
    link: { color: colors.brand.DEFAULT, underline: true },
    h1: { fontSize: 28, fontWeight: "800", color: ink },
    h2: { fontSize: 22, fontWeight: "800", color: ink },
    h3: { fontSize: 17, fontWeight: "700", color: ink },
    list: { itemSpacing: 4 },
  };
}

// ~0.5 MB/min so an hour-long lecture lands near 30 MB and each chunk near 1 MB.
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: "document",
  bitRate: 64_000,
  numberOfChannels: 1,
  sampleRate: 44_100,
};

const MODES = [
  { key: "recording", label: "Recording", Icon: Mic },
  { key: "typing", label: "Typing", Icon: PenLine },
  { key: "upload", label: "Upload", Icon: CloudUpload },
] as const;

type Mode = (typeof MODES)[number]["key"];

const TOOLS = [
  { key: "bold", label: "Bold", Icon: Bold },
  { key: "italic", label: "Italic", Icon: Italic },
  { key: "heading", label: "Heading", Icon: Heading },
  { key: "bullet", label: "Bulleted list", Icon: List },
  { key: "numbered", label: "Numbered list", Icon: ListOrdered },
  { key: "undo", label: "Undo", Icon: Undo2 },
] as const;

type ToolKey = (typeof TOOLS)[number]["key"];

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

const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/aac",
  "audio/*",
];

type TypedStatus = "idle" | "saving" | "saved" | "queued";
type RecordPhase = "idle" | "starting" | "recording" | "paused" | "saved";

type Recovery = { session: RecordingSession; segments: RecordingSegment[] };

type Draft = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  dirty: boolean;
  sourceType: Note["sourceType"] | null;
};

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

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function extensionOf(name: string, uri: string, fallback: string) {
  const fromName = name.match(/\.([A-Za-z0-9]+)(?:\?|$)/);
  if (fromName) return fromName[1].toLowerCase();
  const fromUri = uri.match(/\.([A-Za-z0-9]+)(?:\?|$)/);
  if (fromUri) return fromUri[1].toLowerCase();
  return fallback;
}

function detectUploadKind(extension: string, mime?: string): UploadKind {
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext) || mime?.startsWith("image/")) {
    return "image";
  }
  if (["m4a", "mp3", "wav", "ogg", "aac"].includes(ext) || mime?.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

function copyToPersistentStorage(sourceUri: string, fileName: string): string {
  try {
    const uploadDir = new Directory(Paths.document, "uploads");
    if (!uploadDir.exists) {
      uploadDir.create();
    }
    const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const destFile = new File(uploadDir, safeName);
    const sourceFile = new File(sourceUri);
    sourceFile.copy(destFile);
    return destFile.uri;
  } catch {
    return sourceUri;
  }
}

function fileSizeOf(path: string) {
  try {
    return new File(path).size ?? 0;
  } catch {
    return 0;
  }
}

function deleteQuietly(path: string) {
  if (!path) return;
  try {
    new File(path).delete();
  } catch {
    // Already gone — nothing to clean up.
  }
}

// Fire-and-forget save for drafts that must not be lost outside an explicit
// tap on Save (note switch, blur, Done). Errors are swallowed: the draft
// stays in memory and the next explicit save retries.
function saveDraftQuietly(db: SQLiteDatabase, draft: Draft) {
  if (!draft.dirty || !draft.courseId) return;
  void saveNote(db, {
    id: draft.id,
    courseId: draft.courseId,
    title: draft.title.trim() || "Untitled note",
    body: draft.body,
    sourceType: draft.sourceType ?? "typed",
  }).catch(() => {});
}

function SegmentedControl({
  mode,
  onChange,
  disabled = false,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
}) {
  const pv = usePalette();
  return (
    <View className="mt-5 flex-row rounded-chip bg-surface p-1.5 shadow-card">
      {MODES.map(({ key, label, Icon }) => {
        const selected = mode === key;
        return (
          <View
            key={key}
            className={`min-h-12 flex-1 flex-row  ${
              selected ? "bg-brand-strong rounded-full" : ""
            } ${disabled ? "opacity-60" : ""}`}
          >
            {/* Visual state lives on the wrapper so the pressable's class set
                stays static; only plain value utilities toggle after mount. */}
            <Pressable
              onPress={() => {
                if (!disabled) onChange(key);
              }}
              disabled={disabled}
              accessibilityRole="tab"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={label}
              className="flex-1 self-stretch flex-row items-center justify-center gap-2 active:opacity-80"
            >
              <Icon size={18} color={selected ? colors.ink.inverse : pv.ink.soft} />
              <Text
                className={`text-label font-sans-bold ${
                  selected ? "text-ink-inverse" : "text-ink-soft"
                }`}
              >
                {label}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function CourseSelect({
  course,
  onPress,
  disabled = false,
}: {
  course?: Course;
  onPress: () => void;
  disabled?: boolean;
}) {
  const pv = usePalette();
  const style = course ? courseStyle(course.color, pv) : null;
  return (
    <View
      className={`mt-4 self-start flex-row rounded-chip border border-line bg-surface px-4 py-3 ${
        disabled ? "opacity-60" : ""
      }`}
    >
      {/* The disabled dim lives on the wrapper View so the Pressable's class
          set never changes. */}
      <Pressable
        onPress={() => {
          if (!disabled) onPress();
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel={
          course ? `Course: ${course.name}. Tap to change` : "Choose a course"
        }
        className="flex-1 self-stretch flex-row items-center gap-3 active:opacity-80"
      >
      <View
        style={{ backgroundColor: style ? style.tint : pv.successSoft }}
        className="h-9 w-9 items-center justify-center rounded-full"
      >
        <BookOpen
          size={18}
          color={style ? style.accent : colors.brand.DEFAULT}
        />
      </View>
      <Text className="text-label font-sans-bold text-ink" numberOfLines={1}>
        {course
          ? [course.code, course.name].filter(Boolean).join(" ")
          : "Choose a course"}
      </Text>
      <ChevronDown size={18} color={pv.ink.faint} />
      </Pressable>
    </View>
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
        <View className={`h-full rounded-chip ${reached ? "bg-danger" : "bg-brand-strong"} ${bar}`} />
      </View>
      {reached ? (
        <Text className="mt-2 text-small text-ink-soft">
          Free plan limit. Upgrade in your profile for unlimited recordings.
        </Text>
      ) : null}
    </View>
  );
}

function uploadStateLabel(item: UploadQueueItem) {
  if (item.state === "uploading") return "Uploading…";
  if (item.state === "uploaded") return "Uploaded";
  if (item.state === "failed") return "Failed";
  return "Queued";
}

export default function Create() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const { courses, getAuthToken } = useApp();
  const params = useLocalSearchParams<{ mode?: string; noteId?: string; courseId?: string }>();

  const [mode, setMode] = useState<Mode>(
    params.mode === "typing"
      ? "typing"
      : params.mode === "upload"
        ? "upload"
        : "recording",
  );
  // null = follow the first loaded course until the user picks one explicitly.
  const [pickedCourseId, setPickedCourseId] = useState<string | null>(null);
  const [pickingCourse, setPickingCourse] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [wifiOnly, setWifiOnly] = useState(true);

  // Typing draft lives up here so switching modes never drops the text.
  // The id is a fresh draft until an edit session swaps it for a stored note.
  const [typedNoteId, setTypedNoteId] = useState(() => newId());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [typedStatus, setTypedStatus] = useState<TypedStatus>("idle");
  const [dirty, setDirty] = useState(false);
  const [noteSourceType, setNoteSourceType] = useState<Note["sourceType"] | null>(null);
  const [sourceTranscript, setSourceTranscript] = useState<string | null>(null);
  // AI pipeline state for the loaded note; server-owned fields mirrored into SQLite.
  const [aiState, setAiState] = useState<AiState>("none");
  const [summaryMarkdown, setSummaryMarkdown] = useState<string | null>(null);
  const [openedNoteKind, setOpenedNoteKind] = useState<NoteKind>("note");
  // Destination of the last AI request for this note, so retries and failure
  // copy match what was asked for (a lecture note is not just a summary).
  const [lastRequestedKind, setLastRequestedKind] =
    useState<GenerationKind | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportComment, setReportComment] = useState("");
  const [reportSending, setReportSending] = useState(false);
  const [reported, setReported] = useState(false);
  const [summaryGenerationError, setSummaryGenerationError] = useState<string | null>(null);

  // Editor affordances: rich native markdown editor with undo history.
  const editorRef = useRef<EnrichedMarkdownTextInputInstance>(null);
  const bodyRef = useRef(body);
  useEffect(() => {
    bodyRef.current = body;
  });
  const historyRef = useRef<string[]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [styleState, setStyleState] = useState<StyleState>({
    bold: { isActive: false },
    italic: { isActive: false },
    underline: { isActive: false },
    strikethrough: { isActive: false },
    spoiler: { isActive: false },
    link: { isActive: false },
    heading: { isActive: false, level: 2 },
    unorderedList: { isActive: false, depth: 0 },
    orderedList: { isActive: false, depth: 0 },
  });
  const historyDepthRef = useRef(0);
  useEffect(() => {
    historyDepthRef.current = historyDepth;
  });

  const [usedRecordings, setUsedRecordings] = useState(0);
  const [recordPhase, setRecordPhase] = useState<RecordPhase>("idle");
  const [recordMs, setRecordMs] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chunked recording bookkeeping (all refs so the 1s tick never resets).
  const sessionRef = useRef<{ id: string; courseId: string } | null>(null);
  const segmentIdRef = useRef<number | null>(null);
  const segmentIndexRef = useRef(0);
  const baseMsRef = useRef(0);
  const segmentMsRef = useRef(0);
  const rotatingRef = useRef(false);
  const phaseRef = useRef<RecordPhase>(recordPhase);
  useEffect(() => {
    phaseRef.current = recordPhase;
  });

  const [uploadItems, setUploadItems] = useState<UploadQueueItem[]>([]);
  // A destination prompt: the picked file (queued after confirm), the typing
  // save, or the just-stopped recording. Closing the sheet means: cancel for
  // files, keep editing for typing, save-without-AI for recordings.
  const [pendingPrompt, setPendingPrompt] = useState<{
    mode: "file" | "typing" | "recording";
    uri?: string;
    name?: string;
    size?: number;
    kind?: UploadKind;
    target: UploadTarget;
  } | null>(null);

  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  // Re-read the route params when they change (e.g. Home's Type tile or a
  // course detail pushing a second time) — the adjust-during-render pattern
  // instead of an effect.
  const [seenModeParam, setSeenModeParam] = useState(params.mode);
  if (params.mode !== seenModeParam) {
    setSeenModeParam(params.mode);
    if (params.mode === "typing") setMode("typing");
    else if (params.mode === "upload") setMode("upload");
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

  // Course selection: "remember last used" (default) restores the course of
  // the most recent capture; with the pref off a fresh session always starts
  // unpicked so the user has to choose. The record/save/upload flows persist
  // the course at each capture (rememberLastCourse).
  const rememberCoursePref = useStringSetting(db, "remember_capture_course", "1");
  const lastCourse = useStringSetting(db, "create_last_course", "");
  const rememberOn = rememberCoursePref.value !== "0";
  const remembered =
    rememberOn && lastCourse.value && courses.some((item) => item.id === lastCourse.value)
      ? lastCourse.value
      : "";
  // Follow the remembered course until the user picks one explicitly.
  const courseId = pickedCourseId ?? remembered ?? (rememberOn ? courses[0]?.id ?? "" : "");
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
  const recordingActive = recordPhase === "recording" || recordPhase === "paused";

  // Latest draft for fire-and-forget saves that run outside the render
  // closure (note switch, blur, Done) without exhausting effect deps.
  const draftRef = useRef<Draft>({
    id: typedNoteId,
    courseId,
    title,
    body,
    dirty,
    sourceType: noteSourceType,
  });
  useEffect(() => {
    draftRef.current = { id: typedNoteId, courseId, title, body, dirty, sourceType: noteSourceType };
  });

  // Persist the capture course when "remember last used" is on. Best-effort:
  // a failed write just means the next session restores an older course.
  const rememberLastCourse = useCallback(
    async (rememberedCourseId: string) => {
      const stored = await getSetting(db, "remember_capture_course").catch(() => null);
      if (stored === "0") return;
      await setSetting(db, "create_last_course", rememberedCourseId).catch(() => {});
    },
    [db],
  );

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
        historyRef.current = [];
        setHistoryDepth(0);
        if (note) {
          setTypedNoteId(note.id);
          setTitle(note.title);
          setBody(note.body);
          setPickedCourseId(note.courseId);
          setNoteSourceType(note.sourceType);
          setSourceTranscript(note.transcript);
          setAiState(note.aiState);
          setSummaryMarkdown(note.summary);
          setTypedStatus("idle");
          setDirty(false);
        } else {
          // Unknown id: show an empty draft so Save can (re)create it.
          setTypedNoteId(target);
          setTitle("");
          setBody("");
          setNoteSourceType(null);
          setSourceTranscript(null);
          setAiState("none");
          setSummaryMarkdown(null);
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

  // Quiet-save a beat after the last keystroke, so an app switch, screen
  // lock, or crash never loses what was typed. The snapshot comparison keeps
  // a save in flight from marking newer edits as clean.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      const snapshot = draftRef.current;
      if (!snapshot.dirty || !snapshot.courseId) return;
      saveNote(db, {
        id: snapshot.id,
        courseId: snapshot.courseId,
        title: snapshot.title.trim() || "Untitled note",
        body: snapshot.body,
        sourceType: snapshot.sourceType ?? "typed",
      })
        .then(() => {
          const current = draftRef.current;
          if (
            current.id === snapshot.id &&
            current.title === snapshot.title &&
            current.body === snapshot.body
          ) {
            draftRef.current = { ...current, dirty: false };
            setDirty(false);
            setTypedStatus("saved");
          }
        })
        .catch(() => {
          // Stay dirty; the next edit, blur, or explicit save retries.
        });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [body, courseId, db, dirty, title, typedNoteId]);

  useEffect(() => {
    let cancelled = false;
    countAudioNotesThisMonth(db)
      .then((count) => {
        if (!cancelled) setUsedRecordings(count);
      })
      .catch(() => {});
    getSetting(db, "wifi_only")
      .then((value) => {
        if (!cancelled && value !== null) setWifiOnly(value !== "0");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

  const refreshRecoveries = useCallback(() => {
    if (sessionRef.current) {
      setRecoveries([]);
      return;
    }
    listInProgressRecordings(db).then(setRecoveries).catch(() => {});
  }, [db]);

  useEffect(() => {
    if (recordPhase === "idle") refreshRecoveries();
  }, [db, recordPhase, refreshRecoveries]);

  const refreshUploads = useCallback(() => {
    listUploadQueue(db).then(setUploadItems).catch(() => {});
  }, [db]);

  useEffect(() => {
    if (mode === "upload") refreshUploads();
  }, [mode, refreshUploads]);

  const handleUploadProgress = useCallback((item: UploadQueueItem) => {
    setUploadItems((prev) => {
      const idx = prev.findIndex((p) => p.id === item.id);
      if (idx === -1) return [item, ...prev];
      const next = [...prev];
      next[idx] = item;
      return next;
    });
  }, []);

  const runUploadFlush = useCallback(() => {
    void flushUploads({
      db,
      getAuthToken,
      onProgress: handleUploadProgress,
    }).finally(() => {
      refreshUploads();
      void drainGenerationQueue({ db, getAuthToken }).catch(() => {});
    });
  }, [db, getAuthToken, handleUploadProgress, refreshUploads]);

  useEffect(() => {
    const hasActive = uploadItems.some(
      (item) => item.state === "uploading" || item.state === "pending",
    );
    if (!hasActive || mode !== "upload") return;
    const interval = setInterval(() => {
      refreshUploads();
    }, 2000);
    return () => clearInterval(interval);
  }, [mode, refreshUploads, uploadItems]);

  // Leaving the screen is a clean recording boundary: finalise the in-flight
  // chunk so its file stays playable, but keep the session open — returning
  // to the Record tab offers Resume / Save / Discard instead of losing it.
  useEffect(() => {
    const rec = recorder;
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (phaseRef.current !== "recording" && phaseRef.current !== "paused") return;
      void (async () => {
        try {
          await rec.stop();
        } catch {
          // Recorder already stopped — the segment finalisation below still runs.
        }
        const segmentId = segmentIdRef.current;
        if (segmentId !== null) {
          try {
            await finalizeSegment(db, segmentId, segmentMsRef.current);
          } catch {
            // Recovery will treat the chunk as un-finalised and discard it.
          }
        }
      })();
    };
  }, [db, recorder]);

  const setWifiOnlyPref = (next: boolean) => {
    setWifiOnly(next);
    void setSetting(db, "wifi_only", next ? "1" : "0").catch(() => {});
  };

  const beginSegment = async (sessionId: string, index: number) => {
    await recorder.prepareToRecordAsync();
    const path = recorder.uri;
    if (!path) throw new Error("Audio recorder did not provide a valid file URI");
    segmentIndexRef.current = index;
    segmentMsRef.current = 0;
    segmentIdRef.current = await addRecordingSegment(db, {
      sessionId,
      segmentIndex: index,
      path,
    });
    recorder.record();
  };

  const startRecording = async () => {
    if (recordPhase !== "idle" || stopping) return;
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
    const sessionId = newId();
    try {
      const permission = await ensureMicPermission();
      if (!permission.granted) {
        setRecordPhase("idle");
        promptForSettings(
          "Microphone access needed",
          "Allow microphone access to record your lectures.",
          permission.canAskAgain,
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await createRecordingSession(db, sessionId, course.id);
      sessionRef.current = { id: sessionId, courseId: course.id };
      void rememberLastCourse(course.id);
      segmentIdRef.current = null;
      baseMsRef.current = 0;
      segmentMsRef.current = 0;
      await beginSegment(sessionId, 0);
      setRecordMs(0);
      setRecordPhase("recording");
    } catch {
      if (sessionRef.current?.id === sessionId && segmentIdRef.current === null) {
        void discardRecordingSession(db, sessionId).catch(() => {});
      }
      sessionRef.current = null;
      setRecordPhase("idle");
      Alert.alert("Couldn’t start recording", "Try again in a moment.");
    }
  };

  const finishRecording = async (
    opts: { alreadyStopped?: boolean; target?: UploadTarget } = {},
  ) => {
    const session = sessionRef.current;
    if (!session) {
      setRecordPhase("idle");
      return;
    }
    setStopping(true);
    try {
      if (!opts.alreadyStopped) await recorder.stop();
      const segmentId = segmentIdRef.current;
      if (segmentId !== null) {
        await finalizeSegment(db, segmentId, segmentMsRef.current);
        segmentIdRef.current = null;
      }
      const segments = (await listSessionSegments(db, session.id)).filter(
        (segment) => segment.path,
      );
      const noteId = newId();
      await saveNote(db, {
        id: noteId,
        courseId: session.courseId,
        title: `Recording · ${nowLabel()}`,
        body: "",
        sourceType: "audio",
        sourceRef: session.id,
        noteKind: opts.target ? noteKindForTarget(opts.target) : undefined,
      });
      for (const segment of segments) {
        await enqueueUpload(db, {
          noteId,
          kind: "audio",
          localPath: segment.path,
          format: extensionOf(segment.path, segment.path, "m4a"),
          bytes: fileSizeOf(segment.path),
          // Carry the destination through the upload so /complete can start the
          // conversion server-side and the local row mirrors its stages.
          target: opts.target,
        });
      }
      await completeRecordingSession(db, session.id);
      sessionRef.current = null;
      baseMsRef.current = 0;
      segmentMsRef.current = 0;
      setUsedRecordings((count) => count + 1);
      setRecordPhase("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        setRecordPhase("idle");
        setRecordMs(0);
      }, 3000);
      if (opts.target) {
        // Choosing "Lecture note" or "Course reference" is a promise: queue the
        // job even when the auto-generate preference is off (that setting only
        // governs captures with no explicit choice). The drain waits for every
        // segment to upload, so queueing while offline is safe.
        await enqueueGeneration(db, noteId, jobKindForTarget(opts.target));
      }
      runUploadFlush();
    } catch {
      // The session row is still in_progress, so the recovery banner offers
      // Resume / Save / Discard on the next visit instead of losing the take.
      setRecordPhase("idle");
      Alert.alert("Recording failed", "The recording could not be saved. Try again.");
    } finally {
      setStopping(false);
    }
  };

  const rotateSegment = async () => {
    const session = sessionRef.current;
    const segmentId = segmentIdRef.current;
    if (rotatingRef.current || !session || segmentId === null) return;
    rotatingRef.current = true;
    try {
      await recorder.stop();
      await finalizeSegment(db, segmentId, segmentMsRef.current);
      baseMsRef.current += segmentMsRef.current;
      segmentIdRef.current = null;
      await beginSegment(session.id, segmentIndexRef.current + 1);
      setRecordMs(baseMsRef.current);
    } catch {
      rotatingRef.current = false;
      await finishRecording({ alreadyStopped: true });
      return;
    }
    rotatingRef.current = false;
  };

  // The interval reads these so its effect only depends on the phase. Updated
  // in an effect (not during render) to always hold the latest closures.
  const recordActionsRef = useRef<{
    rotate: () => Promise<void>;
    stop: () => Promise<void>;
  }>({ rotate: async () => {}, stop: async () => {} });
  useEffect(() => {
    recordActionsRef.current.rotate = rotateSegment;
    recordActionsRef.current.stop = () => finishRecording();
  });

  useEffect(() => {
    if (recordPhase !== "recording") return;
    const timer = setInterval(() => {
      if (rotatingRef.current) return;
      segmentMsRef.current += 1000;
      const total = baseMsRef.current + segmentMsRef.current;
      setRecordMs(total);
      const segmentId = segmentIdRef.current;
      if (segmentId !== null && segmentMsRef.current % 5000 === 0) {
        void touchSegmentDuration(db, segmentId, segmentMsRef.current).catch(() => {});
      }
      if (segmentMsRef.current >= SEGMENT_MS) {
        void recordActionsRef.current.rotate();
      } else if (total >= RECORDING_LIMIT_MS) {
        void recordActionsRef.current.stop();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [db, recordPhase]);

  const pauseRecording = () => {
    if (recordPhase !== "recording" || rotatingRef.current || stopping) return;
    try {
      recorder.pause();
      setRecordPhase("paused");
    } catch {
      // Pause unavailable — recording simply continues.
    }
  };

  const resumeRecording = () => {
    if (recordPhase !== "paused" || stopping) return;
    try {
      recorder.record();
      setRecordPhase("recording");
    } catch {
      Alert.alert("Couldn’t resume", "Try starting a new recording.");
    }
  };

  // Done presses stop the take and ask what to make before saving. Segment
  // bookkeeping happens here (not in finishRecording) so the session still
  // belongs to `sessionRef` when the sheet confirms — a crash in between
  // recovers through the existing banner instead of losing the take.
  const stopRecording = async () => {
    if (recordPhase !== "recording" && recordPhase !== "paused") return;
    if (stopping || rotatingRef.current) return;
    setStopping(true);
    try {
      await recorder.stop();
      const segmentId = segmentIdRef.current;
      if (segmentId !== null) {
        await finalizeSegment(db, segmentId, segmentMsRef.current);
        segmentIdRef.current = null;
      }
      setRecordPhase("idle");
      setRecordMs(baseMsRef.current);
      setPendingPrompt({ mode: "recording", target: "lecture_note" });
    } catch {
      // Nothing finalised cleanly — fall back to the plain save path (the
      // in-progress session stays recoverable through the banner).
      await finishRecording().catch(() => {});
    } finally {
      setStopping(false);
    }
  };

  // An un-finalised chunk written by a crash is not reliably playable, so
  // recovery drops its row and file; everything finalised stays.
  const clearActiveSegments = async (recovery: Recovery) => {
    for (const segment of recovery.segments) {
      if (segment.state !== "active") continue;
      deleteQuietly(segment.path);
      try {
        await removeRecordingSegment(db, segment.id);
      } catch {
        // Row already gone — the file cleanup above is what matters.
      }
    }
  };

  const recoverySavable = (recovery: Recovery) =>
    recovery.segments.some((segment) => segment.state === "finalized" && segment.path);

  const saveRecovery = async (recovery: Recovery) => {
    const segments = recovery.segments.filter(
      (segment) => segment.state === "finalized" && segment.path,
    );
    if (!segments.length) return;
    try {
      const noteId = newId();
      await saveNote(db, {
        id: noteId,
        courseId: recovery.session.courseId,
        title: `Recording · ${nowLabel()}`,
        body: "",
        sourceType: "audio",
        sourceRef: recovery.session.id,
      });
      for (const segment of segments) {
        await enqueueUpload(db, {
          noteId,
          kind: "audio",
          localPath: segment.path,
          format: extensionOf(segment.path, segment.path, "m4a"),
          bytes: fileSizeOf(segment.path),
        });
      }
      await clearActiveSegments(recovery);
      await completeRecordingSession(db, recovery.session.id);
      setUsedRecordings((count) => count + 1);
      refreshRecoveries();
      const autoGenerate = (await getSetting(db, "auto_generate")) !== "0";
      if (autoGenerate) {
        // A recovered lecture becomes a full lecture note, like a normal take.
        await enqueueGeneration(db, noteId, "lecture_note");
      }
      runUploadFlush();
    } catch {
      Alert.alert("Couldn’t save the recording", "Try again in a moment.");
    }
  };

  const discardRecovery = async (recovery: Recovery) => {
    try {
      for (const segment of recovery.segments) deleteQuietly(segment.path);
      await discardRecordingSession(db, recovery.session.id);
      refreshRecoveries();
    } catch {
      Alert.alert("Couldn’t discard", "Try again in a moment.");
    }
  };

  const resumeRecovery = async (recovery: Recovery) => {
    if (recordPhase !== "idle" || stopping) return;
    setRecordPhase("starting");
    try {
      const permission = await ensureMicPermission();
      if (!permission.granted) {
        setRecordPhase("idle");
        promptForSettings(
          "Microphone access needed",
          "Allow microphone access to resume the recording.",
          permission.canAskAgain,
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await clearActiveSegments(recovery);
      sessionRef.current = {
        id: recovery.session.id,
        courseId: recovery.session.courseId,
      };
      segmentIdRef.current = null;
      // session.duration_ms already totals every finalised chunk.
      baseMsRef.current = recovery.session.durationMs;
      segmentMsRef.current = 0;
      const nextIndex = recovery.segments.length
        ? Math.max(...recovery.segments.map((segment) => segment.segmentIndex)) + 1
        : 0;
      await beginSegment(recovery.session.id, nextIndex);
      setPickedCourseId(recovery.session.courseId);
      setRecordMs(baseMsRef.current);
      setRecordPhase("recording");
      setRecoveries((prev) => prev.filter((item) => item.session.id !== recovery.session.id));
    } catch {
      sessionRef.current = null;
      setRecordPhase("idle");
      Alert.alert("Couldn’t resume", "Try again in a moment.");
    }
  };

  const persistNote = async (queueSummary: boolean, target?: UploadTarget) => {
    if (!course || !canSave) return;
    setTypedStatus("saving");
    try {
      await saveNote(db, {
        id: typedNoteId,
        courseId: course.id,
        title: title.trim() || "Untitled note",
        body,
        sourceType: noteSourceType ?? "typed",
        noteKind: target ? noteKindForTarget(target) : undefined,
      });
      void rememberLastCourse(course.id);
      const autoGenerate = (await getSetting(db, "auto_generate")) !== "0";
      // An explicit destination always generates; the preference only decides
      // for a plain save with no chosen output.
      const shouldGenerate = queueSummary && (Boolean(target) || autoGenerate);
      setTypedStatus(shouldGenerate ? "queued" : "saved");
      setDirty(false);
      if (shouldGenerate) {
        // Local-first: the note's ai_state flips immediately; the drain call
        // self-gates on connectivity and mirrors pipeline stages to this UI.
        await enqueueGeneration(
          db,
          typedNoteId,
          target ? jobKindForTarget(target) : "study_set",
        );
        setAiState("queued");
        void drainGenerationQueue({
          db,
          getAuthToken,
          onNoteChange: () => {
            void refreshAiState();
          },
        }).catch(() => {});
      }
    } catch {
      setTypedStatus("idle");
      Alert.alert("Couldn’t save the note", "Your text is still here — try saving again.");
    }
  };

  // Re-read the AI columns (stage changes and results are written by the
  // generation drain, not by this screen's own saves).
  const refreshAiState = useCallback(async () => {
    const note = await getNote(db, typedNoteId).catch(() => null);
    if (!note) return;
    setAiState(note.aiState);
    setSummaryMarkdown(note.summary);
    setOpenedNoteKind(note.noteKind);
    setLastRequestedKind(
      await getLastGenerationKind(db, note.id).catch(() => null),
    );
    if (note.aiState === "failed") {
      const generation = await db
        .getFirstAsync<{ error: string }>(
          "SELECT error FROM generation_queue WHERE note_id = ? AND state = 'failed' ORDER BY updated_at DESC LIMIT 1",
          note.id,
        )
        .catch(() => null);
      setSummaryGenerationError(generation?.error ?? null);
    } else {
      setSummaryGenerationError(null);
    }
  }, [db, typedNoteId]);

  // While a generation is in flight, poll the local row so returning to this
  // screen picks up stage changes and the finished study set.
  const aiActive =
    aiState === "queued" ||
    aiState === "transcribing" ||
    aiState === "summarising" ||
    aiState === "making_cards" ||
    aiState === "writing";
  useEffect(() => {
    if (!aiActive) return;
    const timer = setInterval(() => {
      void refreshAiState();
      // Dropped connectivity resumes the drain on the next foreground/reconnect.
      void drainGenerationQueue({
        db,
        getAuthToken,
        onNoteChange: () => {
          void refreshAiState();
        },
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [aiActive, db, getAuthToken, refreshAiState]);

  // Shared session reset for Done and Delete. Runs in an event handler, so
  // generating the fresh draft id here keeps render pure. The ref is marked
  // clean immediately so a blur firing mid-navigation can't re-save (or
  // resurrect a just-deleted note).
  const resetDraftSession = () => {
    draftRef.current = { ...draftRef.current, dirty: false, sourceType: null };
    setTypedNoteId(newId());
    setTitle("");
    setBody("");
    setNoteSourceType(null);
    setSourceTranscript(null);
    setAiState("none");
    setSummaryMarkdown(null);
    setReportComment("");
    setReported(false);
    setTypedStatus("idle");
    setDirty(false);
    historyRef.current = [];
    setHistoryDepth(0);
    void getSetting(db, "remember_capture_course")
      .then((stored) => {
        if (stored === "0") setPickedCourseId(null);
      })
      .catch(() => {});
  };

  // Done: keep everything typed (quiet save) and drop back to a fresh draft,
  // returning to whichever screen opened the note when there is one. Reads
  // state directly — this closure is re-rendered with every keystroke.
  const finishEditing = () => {
    saveDraftQuietly(db, draftRef.current);
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

  const pushHistory = (snapshot: string) => {
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 50) historyRef.current.shift();
    setHistoryDepth(historyRef.current.length);
  };

  const runEditorTool = (tool: ToolKey) => {
    if (tool === "undo") {
      const previous = historyRef.current.pop();
      if (previous === undefined) return;
      setHistoryDepth(historyRef.current.length);
      setBody(previous);
      setDirty(true);
      editorRef.current?.setValue(previous);
      editorRef.current?.focus();
      return;
    }
    pushHistory(bodyRef.current);
    setDirty(true);
    const editor = editorRef.current;
    if (!editor) return;
    if (tool === "bold") editor.toggleBold();
    else if (tool === "italic") editor.toggleItalic();
    else if (tool === "heading") editor.toggleHeading(2);
    else if (tool === "bullet") editor.toggleUnorderedList();
    else editor.toggleOrderedList();
  };

  const queueFile = async (input: {
    uri: string;
    name: string;
    size: number;
    kind: UploadKind;
    target: UploadTarget;
  }) => {
    if (!course) {
      Alert.alert("Pick a course first", "Choose which course this file belongs to.");
      return;
    }
    if (input.size > MAX_FILE_BYTES) {
      Alert.alert("File too large", "Uploads are limited to 25 MB per file.");
      return;
    }
    const fallbackFormat =
      input.kind === "image" ? "jpg" : input.kind === "audio" ? "m4a" : "pdf";
    const format = extensionOf(input.name, input.uri, fallbackFormat);
    try {
      const noteId = newId();
      await saveNote(db, {
        id: noteId,
        courseId: course.id,
        title: input.name.replace(/\.[^.]+$/, "").trim() || "Untitled file",
        body: "",
        sourceType: input.kind === "audio" ? "audio" : "file",
        noteKind: noteKindForTarget(input.target),
      });
      await enqueueUpload(db, {
        noteId,
        kind: input.kind,
        localPath: input.uri,
        format,
        bytes: input.size,
        target: input.target,
      });
      // The conversion also starts server-side from /complete, but a local queue
      // row keeps the stage UI live and makes "retry" possible. POST /jobs reuses
      // the active server job for this note, so the two never duplicate work.
      await enqueueGeneration(db, noteId, jobKindForTarget(input.target));
      void rememberLastCourse(course.id);
      refreshUploads();
      runUploadFlush();
    } catch {
      Alert.alert(
        "Couldn’t queue the upload",
        "Your file is still on this device — try again.",
      );
    }
  };

  const confirmDestination = async () => {
    const prompt = pendingPrompt;
    if (!prompt) return;
    setPendingPrompt(null);
    if (prompt.mode === "file") {
      await queueFile({
        uri: prompt.uri!,
        name: prompt.name!,
        size: prompt.size!,
        kind: prompt.kind!,
        target: prompt.target,
      });
    } else if (prompt.mode === "typing") {
      await persistNote(true, prompt.target);
    } else {
      await finishRecording({ target: prompt.target });
    }
  };

  // Recordings interpret a swiped sheet (or the explicit row) as "keep the
  // take, skip the AI". Typing dismisses without saving anything.
  const dismissDestination = () => {
    const prompt = pendingPrompt;
    if (!prompt) return;
    setPendingPrompt(null);
    if (prompt.mode === "recording") {
      void finishRecording();
    }
  };

  const pickDocument = async () => {
    try {
      const result = await getDocumentAsync({
        type: DOCUMENT_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const ext = extensionOf(asset.name, asset.uri, "pdf");
      const kind = detectUploadKind(ext, asset.mimeType);
      const safeUri = copyToPersistentStorage(asset.uri, asset.name);
      setPendingPrompt({
        mode: "file",
        uri: safeUri,
        name: asset.name,
        size: asset.size ?? fileSizeOf(safeUri),
        kind,
        target: "lecture_note",
      });
    } catch {
      Alert.alert("Couldn’t open the file picker", "Try again in a moment.");
    }
  };

  const pickImage = async (source: "library" | "camera") => {
    try {
      if (source === "camera") {
        const permission = await ensureCameraPermission();
        if (!permission.granted) {
          promptForSettings(
            "Camera access needed",
            "Allow camera access to photograph the board.",
            permission.canAskAgain,
          );
          return;
        }
      }
      const result =
        source === "camera"
          ? await launchCameraAsync({ quality: 0.8 })
          : await launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
      if (result.canceled) return;
      const asset = result.assets[0];
      const fileName = asset.fileName ?? `photo-${Date.now()}.jpg`;
      const safeUri = copyToPersistentStorage(asset.uri, fileName);
      setPendingPrompt({
        mode: "file",
        uri: safeUri,
        name: fileName,
        size: asset.fileSize ?? fileSizeOf(safeUri),
        kind: "image",
        target: "lecture_note",
      });
    } catch {
      Alert.alert("Couldn’t open the camera", "Try again in a moment.");
    }
  };

  const retryUpload = async (item: UploadQueueItem) => {
    try {
      await updateUploadState(db, item.id, {
        state: "pending",
        error: null,
        resetAttempts: true,
      });
      refreshUploads();
      runUploadFlush();
    } catch {
      refreshUploads();
    }
  };

  const cancelUpload = async (item: UploadQueueItem) => {
    try {
      await removeUploadQueueItem(db, item.id);
      refreshUploads();
    } catch {
      refreshUploads();
    }
  };

  const typedStatusLabel = noteLoading
    ? "Loading…"
    : typedStatus === "saving"
      ? "Saving…"
      : typedStatus === "saved"
        ? "Saved offline"
        : typedStatus === "queued"
          ? "Summary queued"
          : "Offline note";

  const isRecording = recordPhase === "recording";
  const isPaused = recordPhase === "paused";

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerClassName="px-screen pb-tabbar pt-6"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="relative flex-row items-center justify-center">
          <Text className="text-h1 font-sans-extrabold text-ink">Create</Text>
          <Pressable
            onPress={() => setHelpOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Help with creating"
            className="absolute right-0 h-11 w-11 items-center justify-center rounded-full border border-line bg-surface active:opacity-80"
          >
            <CircleHelp size={20} color={pv.ink.soft} />
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
              className="mt-4 min-h-12 flex-row items-center justify-center rounded-btn bg-brand-strong px-6 active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Add a course"
            >
              <Text className="text-body font-sans-bold text-gold">Add a course</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <SegmentedControl
              mode={mode}
              onChange={setMode}
              disabled={recordingActive}
            />
            <CourseSelect
              course={course}
              onPress={() => setPickingCourse(true)}
              disabled={recordingActive}
            />

            {mode === "recording" ? (
              <>
                <View className="mt-4 items-center rounded-card bg-surface p-card-lg shadow-card">
                  <Pressable
                    onPress={
                      isPaused
                        ? resumeRecording
                        : isRecording
                          ? stopRecording
                          : startRecording
                    }
                    disabled={recordPhase === "starting" || stopping}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isPaused
                        ? "Resume recording"
                        : isRecording
                          ? "Stop recording"
                          : "Start recording"
                    }
                    accessibilityState={{
                      busy: recordPhase === "starting" || stopping,
                    }}
                    className="active:opacity-90"
                  >
                    {/* The dim state lives on the inner circle, keeping the
                        pressable's class set static. */}
                    <View
                      className={`h-44 w-44 items-center justify-center rounded-full ${
                        recordPhase === "starting" || stopping || limitReached
                          ? "opacity-60"
                          : ""
                      } ${
                        isRecording || isPaused ? "bg-success-soft/70" : "bg-gold-soft/60"
                      }`}
                    >
                      <View
                        className={`h-36 w-36 items-center justify-center rounded-full ${
                          isRecording || isPaused ? "bg-success-soft" : "bg-gold-soft"
                        }`}
                      >
                        <View
                          className={`h-28 w-28 items-center justify-center rounded-full border-4 border-white ${
                            isRecording || isPaused ? "bg-brand-strong" : "bg-gold"
                          } shadow-gold`}
                        >
                          {isRecording ? (
                            <Square
                              size={30}
                              color={colors.ink.inverse}
                              fill={colors.ink.inverse}
                            />
                          ) : isPaused ? (
                            <Play
                              size={34}
                              color={colors.ink.inverse}
                              fill={colors.ink.inverse}
                            />
                          ) : (
                            <Mic size={38} color={pv.ink.DEFAULT} strokeWidth={2.25} />
                          )}
                        </View>
                      </View>
                    </View>
                  </Pressable>

                  {isRecording || isPaused ? (
                    <>
                      <Text className="mt-6 text-display font-sans-extrabold text-ink">
                        {clockLabel(recordMs / 1000)}
                      </Text>
                      <Text className="mt-1 text-body font-sans-semibold text-ink-soft">
                        {isPaused ? "Paused — tap to resume" : "Recording… tap to stop"}
                      </Text>
                      <Pressable
                        onPress={isPaused ? stopRecording : pauseRecording}
                        disabled={stopping}
                        accessibilityRole="button"
                        accessibilityLabel={isPaused ? "Stop recording" : "Pause recording"}
                        className="mt-4 min-h-11 flex-row items-center justify-center gap-2 rounded-btn border border-brand px-6 active:opacity-80"
                      >
                        {isPaused ? (
                          <Square size={16} color={colors.brand.DEFAULT} />
                        ) : (
                          <Pause size={16} color={colors.brand.DEFAULT} />
                        )}
                        <Text className="text-label font-sans-bold text-brand">
                          {isPaused ? "Stop" : "Pause"}
                        </Text>
                      </Pressable>
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
                        Works offline, saved in small chunks as you go.
                      </Text>
                      <Text className="mt-1 text-center text-caption text-ink-faint">
                        Free plan · 60-minute max per recording
                      </Text>
                    </>
                  )}

                  {recordPhase === "idle" ? (
                    <View className="mt-5 flex-row flex-wrap items-center justify-center gap-3">
                      <WifiToggle value={wifiOnly} onChange={setWifiOnlyPref} />
                      <View className="flex-row items-center gap-1.5 rounded-chip bg-success-soft px-3 py-2">
                        <CheckCircle2 size={15} color={colors.brand.DEFAULT} />
                        <Text className="text-small font-sans-bold text-ink">
                          Saved offline
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </View>

                {recordPhase === "idle" && recoveries.length > 0 ? (
                  <View className="mt-4 rounded-card border border-warning bg-warning-soft p-card">
                    <Text className="text-body-lg font-sans-extrabold text-ink">
                      Unfinished recording found
                    </Text>
                    {recoveries.map((recovery) => (
                      <View key={recovery.session.id} className="mt-2">
                        <Text className="text-small leading-5 text-ink-soft">
                          {clockLabel(recovery.session.durationMs / 1000)} captured before Sua
                          closed
                          {recoverySavable(recovery)
                            ? " — continue it, save what’s there, or discard it."
                            : " — no audio could be recovered."}
                        </Text>
                        <View className="mt-3 flex-row flex-wrap gap-2">
                          {recoverySavable(recovery) ? (
                            <>
                              <Pressable
                                onPress={() => resumeRecovery(recovery)}
                                accessibilityRole="button"
                                accessibilityLabel="Continue recording"
                                className="min-h-10 flex-row items-center justify-center rounded-btn bg-brand-strong px-4 active:opacity-80"
                              >
                                <Play size={15} color={colors.ink.inverse} />
                                <Text className="ml-2 text-label font-sans-bold text-ink-inverse">
                                  Continue
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => saveRecovery(recovery)}
                                accessibilityRole="button"
                                accessibilityLabel="Save recovered recording"
                                className="min-h-10 flex-row items-center justify-center rounded-btn border border-brand bg-surface px-4 active:opacity-80"
                              >
                                <Text className="text-label font-sans-bold text-brand">
                                  Save
                                </Text>
                              </Pressable>
                            </>
                          ) : null}
                          <Pressable
                            onPress={() => discardRecovery(recovery)}
                            accessibilityRole="button"
                            accessibilityLabel="Discard recovered recording"
                            className="min-h-10 flex-row items-center justify-center rounded-btn border border-danger px-4 active:opacity-80"
                          >
                            <Text className="text-label font-sans-bold text-danger">
                              Discard
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}

                <Pressable
                  onPress={() => setMode("upload")}
                  accessibilityRole="button"
                  accessibilityLabel="Choose a file to upload"
                  className="mt-4 items-center rounded-card border-2 border-dashed border-line bg-surface px-5 py-6 active:opacity-80"
                >
                  <View className="h-16 w-16 items-center justify-center rounded-full bg-success-soft">
                    <CloudUpload size={26} color={colors.brand.DEFAULT} strokeWidth={2.25} />
                  </View>
                  <Text className="mt-3 text-body-lg font-sans-extrabold text-ink">
                    Already have a file?
                  </Text>
                  <Text className="mt-1 text-center text-small text-ink-soft">
                    Upload audio, PDF, slides or a photo of the board
                  </Text>
                  <View className="mt-4 min-h-12 flex-row items-center justify-center rounded-btn border border-brand px-6">
                    <Text className="text-body font-sans-bold text-brand">Choose file</Text>
                  </View>
                </Pressable>
                <UsageMeter used={usedRecordings} limit={FREE_RECORDING_LIMIT} />
              </>
            ) : mode === "upload" ? (
              <View className="mt-4">
                <View className="items-center rounded-card border-2 border-dashed border-line bg-surface px-5 py-6">
                  <View className="h-16 w-16 items-center justify-center rounded-full bg-success-soft">
                    <CloudUpload size={26} color={colors.brand.DEFAULT} strokeWidth={2.25} />
                  </View>
                  <Text className="mt-3 text-body-lg font-sans-extrabold text-ink">
                    Add study material
                  </Text>
                  <Text className="mt-1 text-center text-small text-ink-soft">
                    PDFs, slides, typed notes or a photo of the board — text is
                    extracted automatically when the upload lands.
                  </Text>
                  <View className="mt-4 w-full gap-3">
                    <Pressable
                      onPress={pickDocument}
                      accessibilityRole="button"
                      accessibilityLabel="Choose a file"
                      className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn border border-brand active:opacity-80"
                    >
                      <FileText size={17} color={colors.brand.DEFAULT} />
                      <Text className="text-body font-sans-bold text-brand">Choose a file</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => pickImage("library")}
                      accessibilityRole="button"
                      accessibilityLabel="Choose a photo"
                      className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn border border-brand active:opacity-80"
                    >
                      <ImageIcon size={17} color={colors.brand.DEFAULT} />
                      <Text className="text-body font-sans-bold text-brand">Choose a photo</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => pickImage("camera")}
                      accessibilityRole="button"
                      accessibilityLabel="Take a photo"
                      className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn border border-brand active:opacity-80"
                    >
                      <Camera size={17} color={colors.brand.DEFAULT} />
                      <Text className="text-body font-sans-bold text-brand">Take a photo</Text>
                    </Pressable>
                  </View>
                </View>

                <View className="mt-4 rounded-card bg-surface p-card shadow-card">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-body font-sans-semibold text-ink">
                      Upload settings
                    </Text>
                    <WifiToggle value={wifiOnly} onChange={setWifiOnlyPref} />
                  </View>
                </View>

                {uploadItems.length ? (
                  <View className="mt-4 gap-3 rounded-card bg-surface p-card shadow-card">
                    <View className="flex-row items-center justify-between">
                      <Text className="text-caption font-sans-extrabold text-ink-soft">
                        UPLOAD QUEUE
                      </Text>
                      <Pressable
                        onPress={() => router.push("/uploads")}
                        accessibilityRole="link"
                        accessibilityLabel="Open the uploads screen"
                        className="active:opacity-70"
                      >
                        <Text className="text-caption font-sans-bold text-brand">
                          View uploads
                        </Text>
                      </Pressable>
                    </View>
                    {uploadItems.map((item) => (
                      <View key={item.id} className="gap-2">
                        <View className="flex-row items-center gap-3">
                          <View className="h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft">
                            {item.kind === "image" ? (
                              <ImageIcon size={16} color={colors.brand.DEFAULT} />
                            ) : item.kind === "audio" ? (
                              <Mic size={16} color={colors.brand.DEFAULT} />
                            ) : (
                              <FileText size={16} color={colors.brand.DEFAULT} />
                            )}
                          </View>
                          <View className="flex-1">
                            <Text
                              numberOfLines={1}
                              className="text-body font-sans-bold text-ink"
                            >
                              {baseName(item.localPath)}
                            </Text>
                            <Text
                              numberOfLines={2}
                              className={`text-caption ${
                                item.state === "failed" ? "text-danger" : "text-ink-soft"
                              }`}
                            >
                              {uploadStateLabel(item)}
                              {item.state === "failed" && item.error
                                ? ` — ${item.error}`
                                : ""}
                            </Text>
                          </View>
                          {item.state === "failed" ? (
                            <View className="flex-row items-center gap-2">
                              <Pressable
                                onPress={() => retryUpload(item)}
                                accessibilityRole="button"
                                accessibilityLabel={`Retry upload of ${baseName(item.localPath)}`}
                                className="min-h-9 flex-row items-center justify-center rounded-btn border border-brand px-3 active:opacity-80"
                              >
                                <Text className="text-caption font-sans-bold text-brand">
                                  Retry
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => cancelUpload(item)}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove ${baseName(item.localPath)}`}
                                className="h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface active:opacity-80"
                              >
                                <Trash2 size={15} color={colors.danger} />
                              </Pressable>
                            </View>
                          ) : item.state === "uploaded" ? (
                            <Pressable
                              onPress={() =>
                                router.push({
                                  pathname: "/(app)/note/[id]",
                                  params: { id: item.noteId },
                                })
                              }
                              accessibilityRole="button"
                              accessibilityLabel={`View note for ${baseName(item.localPath)}`}
                              className="min-h-9 flex-row items-center justify-center rounded-btn bg-brand-strong px-3 active:opacity-80"
                            >
                              <Text className="text-caption font-sans-bold text-ink-inverse">
                                View note
                              </Text>
                            </Pressable>
                          ) : (
                            <Pressable
                              onPress={() => cancelUpload(item)}
                              accessibilityRole="button"
                              accessibilityLabel={`Cancel upload of ${baseName(item.localPath)}`}
                              className="h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface active:opacity-80"
                            >
                              <Trash2 size={15} color={pv.ink.soft} />
                            </Pressable>
                          )}
                        </View>
                        {item.state === "uploading" ? (
                          <ProgressBar progress={item.progress} showPercent />
                        ) : null}
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text className="mt-4 text-center text-small text-ink-soft">
                    Nothing waiting. Uploads queue offline and resume when you’re
                    connected.
                  </Text>
                )}
              </View>
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
                      placeholderTextColor={pv.ink.faint}
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
                  <View className="mt-3">
                    <EnrichedMarkdownTextInput
                      key={typedNoteId}
                      ref={editorRef}
                      defaultValue={body}
                      onChangeMarkdown={(markdown) => {
                        setBody(markdown);
                        setDirty(true);
                      }}
                      onChangeState={setStyleState}
                      markdownShortcuts={{
                        heading: true,
                        unorderedList: true,
                        orderedList: true,
                      }}
                      placeholder="Start writing…"
                      placeholderTextColor={pv.ink.faint}
                      cursorColor={colors.brand.DEFAULT}
                      selectionColor={colors.brand.DEFAULT}
                      scrollEnabled={false}
                      markdownStyle={editorMarkdownStyle(pv.ink.DEFAULT)}
                      style={editorBodyStyle(pv.ink.DEFAULT)}
                      accessibilityLabel="Note body"
                    />
                  </View>
                  <View className="mt-3 flex-row items-center justify-between border-t border-line pt-2">
                    <View className="flex-row items-center">
                      {TOOLS.map(({ key, label, Icon }) => {
                        const isUndo = key === "undo";
                        const disabledTool = isUndo && historyDepth === 0;
                        const activeStyle =
                          key === "bold"
                            ? styleState.bold.isActive
                            : key === "italic"
                              ? styleState.italic.isActive
                              : key === "heading"
                                ? styleState.heading.isActive
                                : key === "bullet"
                                  ? styleState.unorderedList.isActive
                                  : key === "numbered"
                                    ? styleState.orderedList.isActive
                                    : false;
                        return (
                          <View key={key} className={disabledTool ? "opacity-40" : ""}>
                            <Pressable
                              disabled={disabledTool}
                              onPress={() => runEditorTool(key)}
                              accessibilityRole="button"
                              accessibilityLabel={label}
                              accessibilityState={{ disabled: disabledTool }}
                              className="h-11 w-11 items-center justify-center rounded-input active:bg-line"
                            >
                              <Icon
                                size={19}
                                color={
                                  activeStyle ? colors.brand.DEFAULT : pv.ink.DEFAULT
                                }
                              />
                            </Pressable>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                </View>

                {sourceTranscript ? (
                  <View className="mt-4 rounded-card border border-line bg-surface p-card">
                    <Text className="text-caption font-sans-extrabold text-ink-soft">
                      EXTRACTED TEXT
                    </Text>
                    <Markdown text={sourceTranscript} className="mt-2" />
                  </View>
                ) : null}

                {aiState === "failed" ? (
                  <View className="mt-4 rounded-card border border-warning bg-warning-soft p-card">
                    <View className="flex-row items-center gap-2">
                      <AlertTriangle size={18} color={colors.warning} />
                      <Text className="text-body-lg font-sans-extrabold text-ink">
                        {lastRequestedKind === "lecture_note"
                          ? "Couldn’t finish the lecture note"
                          : openedNoteKind === "reference"
                            ? "Couldn’t finish the reference"
                            : "Couldn’t finish the summary"}
                      </Text>
                    </View>
                    <Text className="mt-1 text-small leading-5 text-ink-soft">
                      {summaryGenerationError ||
                        "Try again while you’re connected. Your note is safe."}
                    </Text>
                    <View className="mt-3 flex-row gap-2">
                      <Pressable
                        onPress={() => {
                          void (async () => {
                            const note = await getNote(db, typedNoteId).catch(
                              () => null,
                            );
                            const lastKind = await getLastGenerationKind(
                              db,
                              typedNoteId,
                            ).catch(() => null);
                            await enqueueGeneration(
                              db,
                              typedNoteId,
                              generationKindFor(note, lastKind),
                            );
                            setAiState("queued");
                            void drainGenerationQueue({
                              db,
                              getAuthToken,
                              onNoteChange: () => {
                                void refreshAiState();
                              },
                            }).catch(() => {});
                          })();
                        }}
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
                  <View className="mt-4 flex-row items-center gap-2.5 rounded-card bg-surface p-card shadow-card">
                    <Loader2 size={17} color={colors.brand.DEFAULT} />
                    <Text className="text-body font-sans-bold text-ink">
                      {aiState === "queued"
                        ? "Waiting to be processed…"
                        : aiState === "transcribing"
                          ? "Transcribing your lecture…"
                          : aiState === "summarising"
                            ? "Writing your summary…"
                        : aiState === "writing"
                          ? openedNoteKind === "reference"
                            ? "Writing your reference…"
                            : "Writing your lecture note…"
                          : "Making flashcards and a quiz…"}
                    </Text>
                  </View>
                ) : summaryMarkdown ? (
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
                    <Markdown text={summaryMarkdown} className="mt-3" />
                    <Text className="mt-2 text-caption text-ink-faint">
                      AI study aid — verify important facts against your textbook.
                    </Text>
                  </View>
                ) : null}

                <View className="mt-4 flex-row gap-3">
                  {/* The disabled dim (opacity-45) lives on the wrapper View so
                      the Pressable's class set is static. */}
                  <View className={`flex-1 ${canSave ? "" : "opacity-45"}`}>
                    <Pressable
                      onPress={() => persistNote(false)}
                      disabled={!canSave}
                      className="min-h-12 w-full flex-row items-center justify-center gap-2 rounded-btn border border-brand bg-surface active:opacity-80"
                      accessibilityRole="button"
                      accessibilityLabel="Save note"
                    >
                      <Save size={17} color={colors.brand.DEFAULT} />
                      <Text className="text-label font-sans-bold text-brand">Save</Text>
                    </Pressable>
                  </View>
                  <View className={`flex-1 ${canSave ? "" : "opacity-45"}`}>
                    <Pressable
                      onPress={() => {
                        if (body.trim().length < 80) {
                          Alert.alert(
                            "Note is a bit short",
                            "Add a little more detail (at least a few sentences) before generating summaries and flashcards.",
                          );
                          return;
                        }
                        setPendingPrompt({ mode: "typing", target: "lecture_note" });
                      }}
                      disabled={!canSave}
                      className="min-h-12 w-full flex-row items-center justify-center gap-2 rounded-btn bg-gold shadow-gold active:opacity-80"
                      accessibilityRole="button"
                      accessibilityLabel="Save and generate"
                    >
                      <Sparkles size={17} color={pv.ink.DEFAULT} />
                      <Text className="text-label font-sans-extrabold text-ink">
                        Save and generate
                      </Text>
                    </Pressable>
                  </View>
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
        visible={pendingPrompt !== null}
        onClose={dismissDestination}
        title="What should Sua make?"
        subtitle={
          pendingPrompt
            ? pendingPrompt.mode === "file"
              ? `${pendingPrompt.name} → ${course?.name ?? "your course"}`
              : `${pendingPrompt.mode === "typing" ? "Note" : "Recording"} → ${
                  course?.name ?? "your course"
                }`
            : undefined
        }
      >
        {pendingPrompt ? (
          <>
            {(
              [
                {
                  target: "lecture_note" as UploadTarget,
                  Icon: FileText,
                  title: "Lecture note",
                  body: "An AI-written note, plus a summary, flashcards and a quiz. Your original capture stays in Transcript.",
                },
                {
                  target: "course_reference" as UploadTarget,
                  Icon: BookOpen,
                  title: "Course reference",
                  body: "Condensed key terms, formulas and must-know facts, shown in the course Reference section.",
                },
              ] as const
            ).map(({ target, Icon, title: rowTitle, body }) => {
              const selected = pendingPrompt.target === target;
              return (
                <Pressable
                  key={target}
                  onPress={() =>
                    setPendingPrompt({ ...pendingPrompt, target })
                  }
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Set destination to ${rowTitle}`}
                  className={`flex-row gap-3 rounded-input border p-4 active:opacity-80 ${
                    selected ? "border-brand bg-success-soft" : "border-line bg-surface"
                  }`}
                >
                  <View className="h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10">
                    <Icon size={18} color={colors.brand.DEFAULT} />
                  </View>
                  <View className="flex-1 gap-1">
                    <Text className="text-body font-sans-bold text-ink">{rowTitle}</Text>
                    <Text className="text-small leading-5 text-ink-soft">{body}</Text>
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              onPress={confirmDestination}
              accessibilityRole="button"
              accessibilityLabel={
                pendingPrompt.mode === "file"
                  ? "Queue the upload"
                  : pendingPrompt.mode === "typing"
                    ? "Save the note"
                    : "Save the recording"
              }
              className="mt-1 min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong active:opacity-80"
            >
              {pendingPrompt.mode === "file" ? (
                <CloudUpload size={17} color={colors.ink.inverse} />
              ) : (
                <Save size={17} color={colors.ink.inverse} />
              )}
              <Text className="text-body font-sans-bold text-surface">
                {pendingPrompt.mode === "file"
                  ? "Add to uploads"
                  : pendingPrompt.mode === "typing"
                    ? "Save note"
                    : "Save recording"}
              </Text>
            </Pressable>
            {pendingPrompt.mode === "recording" ? (
              <Pressable
                onPress={() => {
                  setPendingPrompt(null);
                  void finishRecording();
                }}
                accessibilityRole="button"
                accessibilityLabel="Save the recording without an AI summary"
                className="min-h-9 items-center justify-center active:opacity-70"
              >
                <Text className="text-small font-sans-bold text-ink-soft">
                  Save without AI
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </BottomSheet>

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
            {/* The busy dim lives on the wrapper View so the Pressable's class
                set stays static. */}
            <View
              className={`min-h-12 self-stretch ${
                !reportComment.trim() || reportSending ? "opacity-50" : ""
              }`}
            >
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
                        noteId: typedNoteId,
                        comment: reportComment.trim(),
                        sourceText: sourceTranscript ?? undefined,
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
                className="self-stretch flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong active:opacity-80"
              >
                <Text className="text-label font-sans-bold text-ink-inverse">
                  {reportSending ? "Sending…" : "Send report"}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}
