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
} from "expo-audio";
import type { RecordingOptions } from "expo-audio";
import { getDocumentAsync } from "expo-document-picker";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
} from "expo-image-picker";
import { File } from "expo-file-system";
import {
  Bold,
  Camera,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CloudUpload,
  FileText,
  Heading2,
  Image as ImageIcon,
  Italic,
  List,
  ListOrdered,
  Mic,
  Pause,
  PenLine,
  Play,
  Save,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from "lucide-react-native";
import { BottomSheet, CoursePickerSheet } from "../../../components/sheets";
import { Markdown } from "../../../components/markdown";
import { colors } from "../../../config/theme";
import { courseInitials, courseStyle } from "../../../lib/course-style";
import { applyMarkdownTool } from "../../../lib/markdown";
import type { MarkdownTool } from "../../../lib/markdown";
import {
  addRecordingSegment,
  completeRecordingSession,
  countAudioNotesThisMonth,
  createRecordingSession,
  deleteNote,
  discardRecordingSession,
  enqueueUpload,
  finalizeSegment,
  getNote,
  getSetting,
  listInProgressRecordings,
  listSessionSegments,
  listUploadQueue,
  newId,
  removeRecordingSegment,
  saveNote,
  setSetting,
  touchSegmentDuration,
  updateUploadState,
} from "../../../lib/notes";
import type {
  Note,
  RecordingSegment,
  RecordingSession,
  UploadKind,
  UploadQueueItem,
} from "../../../lib/notes";
import { flushUploads } from "../../../lib/uploads";
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

// ~0.5 MB/min so an hour-long lecture lands near 30 MB and each chunk near 1 MB.
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: "document",
  bitRate: 64_000,
  numberOfChannels: 1,
  sampleRate: 44_100,
};

const MODES = [
  { key: "recording", label: "Record", Icon: Mic },
  { key: "typing", label: "Type", Icon: PenLine },
  { key: "upload", label: "Upload", Icon: CloudUpload },
] as const;

type Mode = (typeof MODES)[number]["key"];

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

const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
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
  return (
    <View className="mt-5 flex-row rounded-chip bg-surface p-1.5 shadow-card">
      {MODES.map(({ key, label, Icon }) => {
        const selected = mode === key;
        return (
          <Pressable
            key={key}
            onPress={() => {
              if (!disabled) onChange(key);
            }}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={label}
            className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-chip active:opacity-80 ${
              selected ? "bg-brand" : ""
            } ${disabled ? "opacity-60" : ""}`}
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

function CourseSelect({
  course,
  onPress,
  disabled = false,
}: {
  course?: Course;
  onPress: () => void;
  disabled?: boolean;
}) {
  const style = course ? courseStyle(course.color) : null;
  return (
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
      className={`mt-4 flex-row items-center rounded-card bg-surface p-3 shadow-card active:opacity-80 ${
        disabled ? "opacity-60" : ""
      }`}
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

function WifiToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View className="flex-row items-center gap-2 rounded-chip bg-success-soft px-3 py-2">
      <Text className="text-small font-sans-bold text-ink">Wi-Fi only upload</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.brand.DEFAULT, false: colors.line }}
        thumbColor={colors.surface}
        accessibilityLabel="Wi-Fi only upload"
      />
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
  const [savedAt, setSavedAt] = useState(nowLabel());
  const [dirty, setDirty] = useState(false);
  const [noteSourceType, setNoteSourceType] = useState<Note["sourceType"] | null>(null);
  const [sourceTranscript, setSourceTranscript] = useState<string | null>(null);

  // Editor affordances: markdown toolbar with undo, plus a rendered preview.
  const bodyInputRef = useRef<TextInput>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [selectionOverride, setSelectionOverride] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const historyRef = useRef<string[]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [previewing, setPreviewing] = useState(false);

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
        setPreviewing(false);
        setSelectionOverride(null);
        if (note) {
          setTypedNoteId(note.id);
          setTitle(note.title);
          setBody(note.body);
          setPickedCourseId(note.courseId);
          setNoteSourceType(note.sourceType);
          setSourceTranscript(note.transcript);
          setTypedStatus("idle");
          setDirty(false);
        } else {
          // Unknown id: show an empty draft so Save can (re)create it.
          setTypedNoteId(target);
          setTitle("");
          setBody("");
          setNoteSourceType(null);
          setSourceTranscript(null);
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
            setSavedAt(nowLabel());
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
    const path = recorder.uri ?? "";
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
      await createRecordingSession(db, sessionId, course.id);
      sessionRef.current = { id: sessionId, courseId: course.id };
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

  const finishRecording = async (opts: { alreadyStopped?: boolean } = {}) => {
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
      void flushUploads({ db, getAuthToken }).finally(() => refreshUploads());
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

  const stopRecording = async () => {
    if (recordPhase !== "recording" && recordPhase !== "paused") return;
    if (stopping || rotatingRef.current) return;
    await finishRecording();
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
      void flushUploads({ db, getAuthToken }).finally(() => refreshUploads());
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

  const persistNote = async (queueSummary: boolean) => {
    if (!course || !canSave) return;
    setTypedStatus("saving");
    try {
      await saveNote(db, {
        id: typedNoteId,
        courseId: course.id,
        title: title.trim() || "Untitled note",
        body,
        sourceType: noteSourceType ?? "typed",
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
    draftRef.current = { ...draftRef.current, dirty: false, sourceType: null };
    setTypedNoteId(newId());
    setTitle("");
    setBody("");
    setNoteSourceType(null);
    setSourceTranscript(null);
    setTypedStatus("idle");
    setDirty(false);
    setPreviewing(false);
    setSelectionOverride(null);
    historyRef.current = [];
    setHistoryDepth(0);
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

  const applyTool = (tool: MarkdownTool) => {
    if (previewing) return;
    pushHistory(body);
    const result = applyMarkdownTool(body, selection.start, selection.end, tool);
    setBody(result.text);
    setSelection({ start: result.selectionStart, end: result.selectionEnd });
    setSelectionOverride({ start: result.selectionStart, end: result.selectionEnd });
    setDirty(true);
    bodyInputRef.current?.focus();
  };

  const undoTool = () => {
    if (previewing) return;
    const previous = historyRef.current.pop();
    if (previous === undefined) return;
    setHistoryDepth(historyRef.current.length);
    setBody(previous);
    setDirty(true);
    bodyInputRef.current?.focus();
  };

  const queueFile = async (input: {
    uri: string;
    name: string;
    size: number;
    kind: UploadKind;
  }) => {
    if (!course) {
      Alert.alert("Pick a course first", "Choose which course this file belongs to.");
      return;
    }
    if (input.size > MAX_FILE_BYTES) {
      Alert.alert("File too large", "Uploads are limited to 25 MB per file.");
      return;
    }
    const format = extensionOf(
      input.name,
      input.uri,
      input.kind === "image" ? "jpg" : "pdf",
    );
    try {
      const noteId = newId();
      await saveNote(db, {
        id: noteId,
        courseId: course.id,
        title: input.name.replace(/\.[^.]+$/, "").trim() || "Untitled file",
        body: "",
        sourceType: "file",
      });
      await enqueueUpload(db, {
        noteId,
        kind: input.kind,
        localPath: input.uri,
        format,
        bytes: input.size,
      });
      refreshUploads();
      void flushUploads({ db, getAuthToken }).finally(() => refreshUploads());
    } catch {
      Alert.alert(
        "Couldn’t queue the upload",
        "Your file is still on this device — try again.",
      );
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
      await queueFile({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? 0,
        kind: "document",
      });
    } catch {
      Alert.alert("Couldn’t open the file picker", "Try again in a moment.");
    }
  };

  const pickImage = async (source: "library" | "camera") => {
    try {
      if (source === "camera") {
        const permission = await requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(
            "Camera access needed",
            "Allow camera access in Settings to photograph the board.",
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
      await queueFile({
        uri: asset.uri,
        name: asset.fileName ?? `photo-${Date.now()}.jpg`,
        size: asset.fileSize ?? 0,
        kind: "image",
      });
    } catch {
      Alert.alert("Couldn’t open the camera", "Try again in a moment.");
    }
  };

  const retryUpload = async (item: UploadQueueItem) => {
    try {
      await updateUploadState(db, item.id, { state: "pending", error: null });
      refreshUploads();
      void flushUploads({ db, getAuthToken }).finally(() => refreshUploads());
    } catch {
      // Refresh below surfaces the unchanged row.
      refreshUploads();
    }
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
  const isPaused = recordPhase === "paused";

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
                    className={`active:opacity-90 ${
                      recordPhase === "starting" || stopping || limitReached
                        ? "opacity-60"
                        : ""
                    }`}
                  >
                    <View
                      className={`h-44 w-44 items-center justify-center rounded-full ${
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
                            isRecording || isPaused ? "bg-brand" : "bg-gold"
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
                            <Mic size={38} color={colors.ink.DEFAULT} strokeWidth={2.25} />
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
                                className="min-h-10 flex-row items-center justify-center rounded-btn bg-brand px-4 active:opacity-80"
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
                    <Text className="text-caption font-sans-extrabold text-ink-soft">
                      UPLOAD QUEUE
                    </Text>
                    {uploadItems.map((item) => (
                      <View key={item.id} className="flex-row items-center gap-3">
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
                            {item.state === "failed" && item.error ? ` — ${item.error}` : ""}
                          </Text>
                        </View>
                        {item.state === "failed" ? (
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
                  {previewing ? (
                    <Markdown text={body} className="mt-3 min-h-44" />
                  ) : (
                    <TextInput
                      ref={bodyInputRef}
                      value={body}
                      onChangeText={(value) => {
                        setBody(value);
                        setDirty(true);
                      }}
                      onSelectionChange={(event) => {
                        const next = event.nativeEvent.selection;
                        setSelection(next);
                        if (
                          selectionOverride &&
                          next.start === selectionOverride.start &&
                          next.end === selectionOverride.end
                        ) {
                          setSelectionOverride(null);
                        }
                      }}
                      selection={selectionOverride ?? undefined}
                      placeholder="Start writing…"
                      placeholderTextColor={colors.ink.faint}
                      multiline
                      textAlignVertical="top"
                      className="mt-3 min-h-44 text-body leading-7 text-ink"
                      accessibilityLabel="Note body"
                    />
                  )}
                  <View className="mt-3 flex-row items-center justify-between border-t border-line pt-2">
                    <View className="flex-row items-center">
                      {TOOLS.map(({ key, label, Icon }) => {
                        const isUndo = key === "undo";
                        const disabledTool =
                          previewing || (isUndo && historyDepth === 0);
                        return (
                          <Pressable
                            key={key}
                            disabled={disabledTool}
                            onPress={() => (isUndo ? undoTool() : applyTool(key))}
                            accessibilityRole="button"
                            accessibilityLabel={label}
                            accessibilityState={{ disabled: disabledTool }}
                            className={`h-11 w-11 items-center justify-center rounded-input active:bg-line ${
                              disabledTool ? "opacity-40" : ""
                            }`}
                          >
                            <Icon size={19} color={colors.ink.DEFAULT} />
                          </Pressable>
                        );
                      })}
                    </View>
                    <Pressable
                      onPress={() => {
                        setPreviewing((current) => !current);
                        setSelectionOverride(null);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={previewing ? "Edit note" : "Preview note"}
                      className="h-11 flex-row items-center justify-center px-2 active:opacity-80"
                    >
                      <Text className="text-caption font-sans-bold text-brand">
                        {previewing ? "Edit" : "Preview"}
                      </Text>
                    </Pressable>
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
