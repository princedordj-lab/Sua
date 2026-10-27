"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bold,
  BookOpen,
  Check,
  CloudUpload,
  Code2,
  FileAudio,
  FileText,
  Heading2,
  Italic,
  Keyboard,
  List,
  ListOrdered,
  Loader2,
  Mic,
  Pause,
  Play,
  Redo2,
  Save,
  Sparkles,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  PageHeader,
  ProgressBar,
  Segmented,
  Select,
  TextInput,
  Toggle,
} from "@/components/ui";
import {
  EMPTY_FORMATTING,
  RichEditor,
  type EditorFormatting,
  type RichEditorHandle,
} from "@/components/rich-editor";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { usePrefs } from "@/lib/prefs";
import { stripMarkdown } from "@/lib/markdown";
import {
  ACCEPT_ALL,
  formatBytes,
  uploadFile,
  validateFile,
} from "@/lib/uploads";
import type { ServerNote } from "@/lib/types";

type Mode = "type" | "upload" | "record";

const MAX_RECORD_SECONDS = 12 * 60;

type SaveState = "saved" | "dirty" | "saving" | "error";

/** Records a lecture or voice note, transcodes to mono 16 kHz WAV, then uploads. */
export function CreateWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const api = useApi();
  const { courses, loading, error, refresh } = useAppData();
  const { prefs } = usePrefs();

  const queryMode = params.get("mode");
  const mode: Mode = queryMode === "upload" || queryMode === "record" ? queryMode : "type";
  const noteIdParam = params.get("noteId");
  const courseIdParam = params.get("courseId");

  const existing = useResource<ServerNote | null>(
    `create-note:${noteIdParam ?? "new"}`,
    () => (noteIdParam ? api.notes.get(noteIdParam) : Promise.resolve(null)),
  );

  const activeCourses = courses.filter((course) => !course.archived);
  const fallbackCourse =
    (prefs.rememberCaptureCourse ? prefs.lastCourseId : null) ??
    activeCourses[0]?.id ??
    courses[0]?.id ??
    "";

  if (existing.error) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          Back to courses
        </Link>
        <ErrorState message={existing.error} onRetry={existing.reload} />
      </div>
    );
  }

  if (noteIdParam && existing.loading && !existing.data) {
    return <LoadingBlock rows={4} />;
  }

  return (
    <Workspace
      key={noteIdParam ?? "new-note"}
      mode={mode}
      initialNote={existing.data ?? null}
      initialCourseId={courseIdParam ?? ""}
      fallbackCourseId={fallbackCourse}
      courses={activeCourses.length ? activeCourses : courses}
      coursesLoading={loading}
      coursesError={error}
      refreshCourses={refresh}
      router={router}
    />
  );
}

function Workspace({
  mode: initialMode,
  initialNote,
  initialCourseId,
  fallbackCourseId,
  courses,
  coursesLoading,
  coursesError,
  refreshCourses,
  router,
}: {
  mode: Mode;
  initialNote: ServerNote | null;
  initialCourseId: string;
  fallbackCourseId: string;
  courses: { id: string; name: string; code: string | null }[];
  coursesLoading: boolean;
  coursesError: string | null;
  refreshCourses: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  const api = useApi();
  const { update } = usePrefs();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [courseId, setCourseId] = useState(initialCourseId || fallbackCourseId);
  const effectiveCourseId =
    courses.find((course) => course.id === courseId)?.id ?? courses[0]?.id ?? "";

  if (coursesError) {
    return (
      <div>
        <PageHeader title="Create" description="Add a note, upload material or record a lecture." />
        <ErrorState message={coursesError} onRetry={refreshCourses} />
      </div>
    );
  }

  if (coursesLoading && !courses.length) return <LoadingBlock rows={4} />;

  if (!courses.length) {
    return (
      <div>
        <PageHeader title="Create" description="Add a note, upload material or record a lecture." />
        <EmptyState
          icon={<BookOpen size={26} />}
          title="Make a course first"
          body="Every note lives inside a course. Add one, then come back to capture your lecture."
          action={
            <Link href="/app/courses" className="btn btn-primary btn-md">
              Go to courses
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="create-page">
      <PageHeader
        eyebrow={initialNote ? "Edit note" : "Capture"}
        title={initialNote ? "Edit your note" : "Add to your study space"}
        description={
          initialNote
            ? "Your changes save automatically. Regenerate the study set when the note is ready."
            : "Start with your own words, lecture slides, or a recording. Sua handles the rest."
        }
      />

      <div className="create-grid">
        <div className="create-main">
          {initialNote ? null : (
            <Segmented
              label="Capture mode"
              value={mode}
              options={[
                { value: "type", label: "Type", hint: "Write it out" },
                { value: "upload", label: "Upload", hint: "PDF or slides" },
                { value: "record", label: "Record", hint: "Lecture audio" },
              ]}
              onChange={setMode}
            />
          )}

          <Card className="create-course-bar">
            <Field label="Course" htmlFor="create-course">
              <Select
                id="create-course"
                value={effectiveCourseId}
                onChange={(event) => {
                  setCourseId(event.target.value);
                  update({ lastCourseId: event.target.value });
                }}
              >
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                    {course.code ? ` · ${course.code}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>

          {mode === "type" ? (
            <TypedEditor
              note={initialNote}
              courseId={effectiveCourseId}
              onCourseUsed={() => update({ lastCourseId: effectiveCourseId })}
              router={router}
              api={api}
            />
          ) : null}

          {mode === "upload" ? (
            <UploadPanel
              courseId={effectiveCourseId}
              api={api}
              router={router}
              onCourseUsed={() => update({ lastCourseId: effectiveCourseId })}
            />
          ) : null}

          {mode === "record" ? <RecordPanel courseId={effectiveCourseId} api={api} router={router} /> : null}
        </div>

        <aside className="create-aside">
          <Card className="create-tips">
            <span className="create-tips-icon">
              <Sparkles size={19} />
            </span>
            <h2>What Sua does with it</h2>
            <ul>
              <li>Reads documents, slides, photos and transcripts.</li>
              <li>Writes a clean lecture note and a summary.</li>
              <li>Builds flashcards and a quiz for exam practice.</li>
            </ul>
            <p>
              Uploads are capped at 25 MB. A lecture recording can run up to 12 minutes on the web
              before you should start a second take.
            </p>
          </Card>
          {initialNote ? null : (
            <Card className="create-tips create-tips-quiet">
              <h2>Already have material?</h2>
              <p>
                You can also add slides as a course reference sheet — a condensed, read-only page
                without cards or quizzes.
              </p>
              <Link href="/app/courses" className="text-link-sm">
                Browse courses
              </Link>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ typed */

function TypedEditor({
  note,
  courseId,
  onCourseUsed,
  router,
  api,
}: {
  note: ServerNote | null;
  courseId: string;
  onCourseUsed: () => void;
  router: ReturnType<typeof useRouter>;
  api: ReturnType<typeof useApi>;
}) {
  const [noteId, setNoteId] = useState(note?.id ?? null);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [noteKind, setNoteKind] = useState<"note" | "reference">(note?.noteKind ?? "note");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<Date | null>(note ? new Date(note.updatedAt) : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [formatting, setFormatting] = useState<EditorFormatting>(EMPTY_FORMATTING);
  const editorRef = useRef<RichEditorHandle | null>(null);
  const saveRef = useRef<() => Promise<string | null>>(async () => null);

  // A plain function rather than useCallback: the autosave effect calls it
  // through a ref (so the 2s debounce never restarts on unrelated renders) and
  // the React Compiler cannot preserve hand-written memoization here.
  const save = async (): Promise<string | null> => {
    const cleanTitle = title.trim() || "Untitled note";
    const id = noteId ?? crypto.randomUUID();
    if (!noteId) setNoteId(id);
    setSaveState("saving");
    setSaveError(null);
    try {
      await api.notes.sync([
        {
          operation: "upsert",
          id,
          courseId,
          title: cleanTitle,
          body,
          sourceType: note?.sourceType ?? "typed",
          noteKind,
          updatedAt: new Date().toISOString(),
        },
      ]);
      setSaveState("saved");
      setSavedAt(new Date());
      onCourseUsed();
      return id;
    } catch (cause) {
      setSaveState("error");
      setSaveError(cause instanceof Error ? cause.message : "Could not save this note.");
      return null;
    }
  };

  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = setTimeout(() => void saveRef.current(), 2000);
    return () => clearTimeout(timer);
  }, [saveState, title, body, noteKind, courseId]);

  const plainText = stripMarkdown(body).trim();
  const words = plainText ? plainText.split(/\s+/).length : 0;

  function markDirty() {
    setSaveState("dirty");
  }

  async function openNote() {
    const id = noteId ?? (await save());
    if (id) router.push(`/app/note/${id}`);
  }

  async function generate() {
    if (body.trim().length < 40) {
      setSaveError("Note content must be at least 40 characters to generate a study set.");
      return;
    }
    setGenerating(true);
    setSaveError(null);
    try {
      const id = noteId ?? (await save());
      if (!id) return;
      await api.jobs.enqueue(id, noteKind === "reference" ? "course_reference" : "study_set");
      router.push(`/app/jobs/${id}`);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not start generation.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="typed-editor">
      <Card className="editor-card">
        <div className="editor-title-row">
          <TextInput
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              markDirty();
            }}
            placeholder="Note title — e.g. Photosynthesis: light reactions"
            aria-label="Note title"
            className="editor-title"
          />
          <Chip tone={noteKind === "reference" ? "info" : "brand"}>
            {noteKind === "reference" ? "Reference" : "Study note"}
          </Chip>
        </div>

        <div className="editor-toolbar" role="toolbar" aria-label="Text formatting">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.undo()}
            disabled={!formatting.canUndo}
            aria-label="Undo"
            title="Undo"
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.redo()}
            disabled={!formatting.canRedo}
            aria-label="Redo"
            title="Redo"
          >
            <Redo2 size={16} />
          </button>
          <span className="editor-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleHeading()}
            aria-label="Heading"
            aria-pressed={formatting.heading}
            title="Heading"
            className={formatting.heading ? "is-active" : undefined}
          >
            <Heading2 size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleBold()}
            aria-label="Bold"
            aria-pressed={formatting.bold}
            title="Bold"
            className={formatting.bold ? "is-active" : undefined}
          >
            <Bold size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleItalic()}
            aria-label="Italic"
            aria-pressed={formatting.italic}
            title="Italic"
            className={formatting.italic ? "is-active" : undefined}
          >
            <Italic size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleBulletList()}
            aria-label="Bulleted list"
            aria-pressed={formatting.bullet}
            title="Bulleted list"
            className={formatting.bullet ? "is-active" : undefined}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleNumberedList()}
            aria-label="Numbered list"
            aria-pressed={formatting.numbered}
            title="Numbered list"
            className={formatting.numbered ? "is-active" : undefined}
          >
            <ListOrdered size={16} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.toggleCode()}
            aria-label="Inline code"
            aria-pressed={formatting.code}
            title="Inline code"
            className={formatting.code ? "is-active" : undefined}
          >
            <Code2 size={16} />
          </button>
          <span className="editor-toolbar-spacer" />
          <span className="editor-word-count">
            {words} {words === 1 ? "word" : "words"}
          </span>
        </div>

        <RichEditor
          ref={editorRef}
          initialMarkdown={note?.body ?? ""}
          onChange={(markdown) => {
            setBody(markdown);
            markDirty();
          }}
          onFormattingChange={setFormatting}
          placeholder="Start typing, or paste your lecture notes…"
          ariaLabel="Note body"
        />

        <div className="editor-status">
          <span className={`editor-save editor-save-${saveState}`}>
            {saveState === "saving" ? (
              <>
                <Loader2 size={14} className="spin" /> Saving…
              </>
            ) : saveState === "dirty" ? (
              <>Unsaved changes</>
            ) : saveState === "error" ? (
              <>Not saved</>
            ) : (
              <>
                <Check size={14} /> Saved
                {savedAt
                  ? ` · ${savedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </>
            )}
          </span>
          <span className="editor-actions">
            <Button
              variant="ghost"
              size="sm"
              busy={saveState === "saving"}
              onClick={() => void save()}
              icon={<Save size={15} />}
            >
              Save now
            </Button>
          </span>
        </div>
      </Card>

      {saveError ? <Alert title="Could not save">{saveError}</Alert> : null}

      <div className="editor-actions-bar">
        <Toggle
          label="Save as a course reference sheet"
          description="A condensed reference page — no flashcards or quiz, perfect for formula sheets."
          checked={noteKind === "reference"}
          onChange={(checked) => {
            setNoteKind(checked ? "reference" : "note");
            markDirty();
          }}
        />
        <div className="editor-actions-buttons">
          <Button
            variant="secondary"
            onClick={() => void openNote()}
            disabled={!title.trim() && !body.trim()}
          >
            <FileText size={16} /> Open note
          </Button>
          <Button busy={generating} onClick={() => void generate()}>
            <Sparkles size={16} />
            {noteKind === "reference" ? "Build reference sheet" : "Generate study set"}
          </Button>
        </div>
      </div>

      <p className="create-footnote">
        Autosaves every couple of seconds while you type. Sua never shares your notes.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- upload */

function UploadPanel({
  courseId,
  api,
  router,
  onCourseUsed,
}: {
  courseId: string;
  api: ReturnType<typeof useApi>;
  router: ReturnType<typeof useRouter>;
  onCourseUsed: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);

  function choose(next: File | null) {
    setError(null);
    setFile(null);
    if (!next) return;
    try {
      validateFile(next);
      setFile(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file cannot be uploaded.");
    }
  }

  async function start() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setPercent(0);
    setPhase("Getting a secure upload link…");
    try {
      const { format, kind } = validateFile(file);
      const noteId = crypto.randomUUID();
      const title = file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Uploaded material";
      const noteKind = reference ? "reference" : "note";
      await api.notes.sync([
        {
          operation: "upsert",
          id: noteId,
          courseId,
          title,
          body: "",
          sourceType: kind === "audio" ? "audio" : "file",
          noteKind,
          updatedAt: new Date().toISOString(),
        },
      ]);
      onCourseUsed();
      setPhase("Uploading your file…");
      await uploadFile(api, file, {
        format,
        kind,
        noteId,
        task: reference ? "course_reference" : "lecture_note",
        fileName: file.name,
        onProgress: setPercent,
      });
      setPhase("Starting Sua…");
      await api.jobs.enqueue(
        noteId,
        kind === "audio"
          ? "study_set"
          : reference
            ? "course_reference"
            : "lecture_note",
      );
      router.push(`/app/jobs/${noteId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload that file.");
      setBusy(false);
      setPercent(0);
      setPhase("");
    }
  }

  return (
    <div className="upload-panel">
      <Card
        className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
        as="section"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ALL}
          className="visually-hidden"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
          id="upload-input"
        />
        {file ? (
          <div className="dropzone-file">
            <span className="dropzone-file-icon">
              {file.type.startsWith("audio/") ? <FileAudio size={26} /> : <FileText size={26} />}
            </span>
            <div>
              <strong>{file.name}</strong>
              <p>{formatBytes(file.size)} · ready to upload</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove file"
              onClick={() => {
                setFile(null);
                setPercent(0);
                setPhase("");
              }}
            >
              <X size={17} />
            </button>
          </div>
        ) : (
          <div
            className="dropzone-empty"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              choose(event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <span className="dropzone-icon">
              <CloudUpload size={28} />
            </span>
            <h2>Drop a PDF, slide deck or photo here</h2>
            <p>PDF, PPTX, DOCX, TXT, JPG, PNG, WebP or audio — up to 25 MB.</p>
            <Button variant="secondary" onClick={() => inputRef.current?.click()} type="button">
              Choose a file
            </Button>
            <button
              type="button"
              className="text-link-sm dropzone-browse"
              onClick={() => inputRef.current?.click()}
            >
              or browse your device
            </button>
          </div>
        )}
      </Card>

      {error ? <Alert title="Could not use that file">{error}</Alert> : null}

      {busy ? (
        <Card className="upload-progress">
          <div className="upload-progress-head">
            <span>{phase}</span>
            {percent > 0 ? <strong>{percent}%</strong> : null}
          </div>
          <ProgressBar value={percent} label="Upload progress" />
          <p>Keep this tab open until the upload finishes. Sua takes over after that.</p>
        </Card>
      ) : null}

      <Card className="upload-options">
        <Toggle
          label="Use as a course reference sheet"
          description="For formula sheets and slide dumps you want to read, not drill. References skip cards and quizzes."
          checked={reference}
          onChange={setReference}
        />
        <div className="upload-actions">
          <Button busy={busy} disabled={!file} onClick={() => void start()} icon={<CloudUpload size={17} />}>
            Upload and summarise
          </Button>
          <span>Uploads are private to your account.</span>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- record */

function RecordPanel({
  courseId,
  api,
  router,
}: {
  courseId: string;
  api: ReturnType<typeof useApi>;
  router: ReturnType<typeof useRouter>;
}) {
  const [status, setStatus] = useState<"idle" | "requesting" | "recording" | "paused" | "processing">(
    "idle",
  );
  const [seconds, setSeconds] = useState(0);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secondsRef = useRef(0);
  const routerRef = useRef(router);
  const apiRef = useRef(api);
  const courseRef = useRef(courseId);

  useEffect(() => {
    routerRef.current = router;
    apiRef.current = api;
    courseRef.current = courseId;
  });

  useEffect(() => {
    if (status !== "recording") return;
    const interval = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  useEffect(() => {
    secondsRef.current = seconds;
  }, [seconds]);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function finishRecording() {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const recorder = recorderRef.current;
    const type = recorder?.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    recorderRef.current = null;
    setStatus("processing");
    setPercent(0);

    if (!blob.size) {
      setStatus("idle");
      setError("That recording came back empty. Check your microphone and try again.");
      return;
    }
    if (secondsRef.current < 2) {
      setStatus("idle");
      setSeconds(0);
      setError("That take was too short. Record at least a few seconds.");
      return;
    }

    try {
      let audio: Blob;
      try {
        audio = await toWav(blob);
      } catch {
        if (/ogg/.test(type)) {
          audio = blob;
        } else {
          throw new Error(
            "Your browser recorded a format Sua can’t convert. Try Chrome or Edge, or upload an audio file instead.",
          );
        }
      }
      const format = /ogg/.test(audio.type) ? "ogg" : "wav";
      const noteId = crypto.randomUUID();
      const title = `Lecture recording · ${new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`;
      await apiRef.current.notes.sync([
        {
          operation: "upsert",
          id: noteId,
          courseId: courseRef.current,
          title,
          body: "",
          sourceType: "audio",
          noteKind: "note",
          updatedAt: new Date().toISOString(),
        },
      ]);
      await uploadFile(apiRef.current, audio, {
        format,
        kind: "audio",
        noteId,
        task: "lecture_note",
        fileName: `recording.${format}`,
        onProgress: setPercent,
      });
      await apiRef.current.jobs.enqueue(noteId, "study_set");
      routerRef.current.push(`/app/jobs/${noteId}`);
    } catch (cause) {
      setStatus("idle");
      setSeconds(0);
      setError(cause instanceof Error ? cause.message : "Could not upload the recording.");
    }
  }

  async function start() {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot record audio. Try Chrome, Edge or Safari on a laptop.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("This browser does not support in-browser recording. Upload an audio file instead.");
      return;
    }
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((entry) =>
        MediaRecorder.isTypeSupported(entry),
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => void finishRecording();
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start(1000);
      setSeconds(0);
      secondsRef.current = 0;
      setStatus("recording");
      stopTimerRef.current = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORD_SECONDS * 1000);
    } catch (cause) {
      setStatus("idle");
      setError(
        cause instanceof Error && cause.name === "NotAllowedError"
          ? "Microphone permission was blocked. Allow it in your browser settings, then try again."
          : "Could not start the microphone. Check that no other app is using it.",
      );
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function togglePause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setStatus("paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      setStatus("recording");
    }
  }

  const recording = status === "recording" || status === "paused";
  const processing = status === "processing";
  const percentTime = Math.min(100, (seconds / MAX_RECORD_SECONDS) * 100);

  return (
    <div className="record-panel">
      <Card className={`record-card ${recording ? "is-live" : ""}`}>
        <div className="record-visual" aria-hidden="true">
          <span className={`record-pulse ${recording ? "is-live" : ""}`}>
            <Mic size={34} />
          </span>
        </div>
        <h2>
          {status === "requesting"
            ? "Waiting for your microphone…"
            : recording
              ? status === "paused"
                ? "Recording paused"
                : "Listening…"
              : processing
                ? "Preparing your note…"
                : "Record a lecture"}
        </h2>
        <p className="record-timer" aria-live="polite">
          {formatSeconds(seconds)}
          <span> / {formatSeconds(MAX_RECORD_SECONDS)}</span>
        </p>
        <ProgressBar value={recording || processing ? percentTime : 0} tone="gold" label="Recording length" />
        <p className="record-hint">
          {recording
            ? "Keep this tab open. Sua uploads the take when you stop."
            : processing
              ? "Transcoding and uploading. This can take a minute for a long take."
              : "Up to 12 minutes. A quiet room and a close microphone make the transcript much better."}
        </p>

        <div className="record-actions">
          {recording ? (
            <>
              <Button variant="secondary" onClick={togglePause} icon={
                status === "paused" ? <Play size={17} /> : <Pause size={17} />
              }>
                {status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button variant="danger" onClick={stop} icon={<Square size={16} />}>
                Stop and save
              </Button>
            </>
          ) : processing ? (
            <Button busy disabled icon={<Loader2 size={17} />}>
              Uploading
            </Button>
          ) : (
            <Button onClick={() => void start()} icon={<Mic size={17} />}>
              Start recording
            </Button>
          )}
        </div>

        {processing ? (
          <div className="record-upload">
            <span>Upload progress</span>
            <strong>{percent}%</strong>
            <ProgressBar value={percent} label="Recording upload progress" />
          </div>
        ) : null}
      </Card>

      {error ? <Alert title="Recording problem">{error}</Alert> : null}

      <Card className="record-note">
        <Keyboard size={18} aria-hidden="true" />
        <p>
          Recording is a web convenience, not a replacement for a quiet room. If the microphone is
          blocked, upload an audio file instead — Sua treats it exactly the same.
        </p>
      </Card>
    </div>
  );
}

function formatSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * MediaRecorder has no WAV encoder, and the upload allowlist does not accept
 * webm. Decode the take and re-encode it as mono 16 kHz PCM WAV (about 32 KB/s,
 * so 12 minutes stays under the 25 MB cap).
 */
async function toWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
    const context = new AudioContext();
    context
      .decodeAudioData(arrayBuffer)
      .then((buffer) => {
        resolve(buffer);
      })
      .catch(reject)
      .finally(() => void context.close());
  });

  const targetRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
