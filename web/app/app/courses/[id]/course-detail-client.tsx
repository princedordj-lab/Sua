"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  ChevronRight,
  CloudUpload,
  FileText,
  Keyboard,
  Mic,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
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
  IconButton,
  LoadingBlock,
  Modal,
  ProgressBar,
  Segmented,
  Select,
  StatusBadge,
  TextInput,
} from "@/components/ui";
import { MarkdownPreview } from "@/components/markdown";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { courseStyle } from "@/lib/course-style";
import { examCountdown, relativeDate, shortDate } from "@/lib/format";
import { isAiActive } from "@/lib/generation";
import { formatBytes } from "@/lib/uploads";
import type { ServerNote, ServerStudySet } from "@/lib/types";

type Tab = "notes" | "study";

const GROUPS: { key: ServerNote["sourceType"]; label: string; hint: string; Icon: typeof FileText }[] = [
  { key: "typed", label: "Typed notes", hint: "Written by you", Icon: Keyboard },
  { key: "audio", label: "Recordings", hint: "Lectures and voice notes", Icon: Mic },
  { key: "file", label: "Uploads", hint: "Slides, PDFs and photos", Icon: CloudUpload },
];

function UploadRow({ note }: { note: ServerNote }) {
  const assets = note.assets ?? [];
  const size = assets.length
    ? formatBytes(assets.reduce((total, asset) => total + asset.bytes, 0))
    : "Size unavailable";
  let status = "Upload details unavailable";
  if (assets.some((asset) => asset.status === "pending")) {
    status = "Upload pending";
  } else if (note.aiState === "ready") {
    status = "Ready";
  } else if (note.aiState === "failed") {
    status = "Needs attention";
  } else if (assets.length) {
    status = "Uploaded";
  }

  return (
    <div className="upload-row">
      <strong className="upload-row-name">{note.title || "Untitled upload"}</strong>
      <div className="upload-row-meta">
        <span>{size}</span>
        <span>{status}</span>
      </div>
    </div>
  );
}

export function CourseDetailClient() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const api = useApi();
  const { courses, refresh, updateCourse, deleteCourse } = useAppData();

  const course = courses.find((row) => row.id === id);

  const notes = useResource<ServerNote[]>(`course-notes:${id}`, () =>
    api.notes.listForCourse(id),
  );
  const sets = useResource<ServerStudySet[]>(`course-sets:${id}`, async () => {
    const result = await api.study.sets();
    return result.sets.filter((set) => set.courseId === id);
  });

  const [tab, setTab] = useState<Tab>("notes");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveNote, setMoveNote] = useState<ServerNote | null>(null);
  const [deleteNote, setDeleteNote] = useState<ServerNote | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [deleteTarget, setDeleteTarget] = useState("");
  const [deleteNotesToo, setDeleteNotesToo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeEditor = useCallback(() => setEditOpen(false), []);
  const closeDelete = useCallback(() => setDeleteOpen(false), []);
  const closeMoveNote = useCallback(() => setMoveNote(null), []);
  const closeDeleteNote = useCallback(() => setDeleteNote(null), []);
  const [form, setForm] = useState({
    name: "",
    code: "",
    lecturer: "",
    examDate: "",
  });

  const all = useMemo(() => notes.data ?? [], [notes.data]);
  const studyNotes = useMemo(() => all.filter((note) => note.noteKind !== "reference"), [all]);
  const references = useMemo(() => all.filter((note) => note.noteKind === "reference"), [all]);
  const readyCount = studyNotes.filter((note) => note.aiState === "ready").length;

  if (!course) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          <ArrowLeft size={16} /> Courses
        </Link>
        <EmptyState
          icon={<BookOpen size={26} />}
          title="Course not found"
          body="It may have been deleted on another device. Refresh your courses to check again."
          action={
            <Button variant="secondary" onClick={refresh}>
              Refresh courses
            </Button>
          }
        />
      </div>
    );
  }

  const style = courseStyle(course.colour);
  const countdown = examCountdown(course.examDate);
  const otherCourses = courses.filter((row) => row.id !== course.id && !row.archived);

  function openEditor() {
    if (!course) return;
    setForm({
      name: course.name,
      code: course.code ?? "",
      lecturer: course.lecturer ?? "",
      examDate: course.examDate?.slice(0, 10) ?? "",
    });
    setActionError(null);
    setEditOpen(true);
    setMenuOpen(false);
  }

  async function saveCourse() {
    if (!course) return;
    if (!form.name.trim()) {
      setActionError("Give the course a name.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await updateCourse(course.id, {
        name: form.name.trim(),
        code: form.code.trim(),
        lecturer: form.lecturer.trim(),
        examDate: form.examDate || null,
      });
      setEditOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not save this course.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!course) return;
    setMenuOpen(false);
    try {
      await updateCourse(course.id, { archived: !course.archived });
    } catch {
      refresh();
    }
  }

  async function confirmDeleteCourse() {
    if (!course) return;
    if (course.noteCount > 0 && !deleteTarget && !deleteNotesToo) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteCourse(course.id, deleteNotesToo ? undefined : deleteTarget || undefined);
      router.push("/app/courses");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete this course.");
    } finally {
      setBusy(false);
    }
  }

  async function moveNoteTo() {
    if (!moveNote || !moveTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      const updatedAt = new Date().toISOString();
      await api.notes.sync([
        {
          operation: "upsert",
          id: moveNote.id,
          courseId: moveTarget,
          title: moveNote.title,
          body: moveNote.body,
          sourceType: moveNote.sourceType,
          noteKind: moveNote.noteKind,
          updatedAt,
        },
      ]);
      notes.setData((current) =>
        current ? current.filter((row) => row.id !== moveNote.id) : current,
      );
      sets.reload();
      refresh();
      setMoveNote(null);
      setMoveTarget("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not move this note.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteNote() {
    if (!deleteNote) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.notes.sync([{ operation: "delete", id: deleteNote.id }]);
      notes.setData((current) =>
        current ? current.filter((row) => row.id !== deleteNote.id) : current,
      );
      sets.reload();
      refresh();
      setDeleteNote(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete this note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="course-detail">
      <Link href="/app/courses" className="back-link">
        <ArrowLeft size={16} /> Courses
      </Link>

      <Card className="course-hero">
        <span
          className="course-hero-stripe"
          style={{ background: style.hex }}
          aria-hidden="true"
        />
        <div className="course-hero-main">
          <div className="course-hero-top">
            <div className="course-hero-copy">
              <p className="course-hero-code" style={{ color: style.hex }}>
                {course.code || "NO CODE"}
              </p>
              <h1>{course.name}</h1>
              {course.lecturer ? (
                <p className="course-hero-lecturer">{course.lecturer}</p>
              ) : (
                <button
                  type="button"
                  className="course-lecturer-link"
                  onClick={() => setMenuOpen(true)}
                >
                  Add lecturer details
                </button>
              )}
            </div>
            <div className="course-hero-actions">
              <IconButton
                label={`Manage ${course.name}`}
                className="course-hero-menu"
                onClick={() => setMenuOpen(true)}
              >
                <MoreHorizontal size={20} />
              </IconButton>
              {countdown ? <Chip tone={countdown.tone}>{countdown.label}</Chip> : null}
              {course.archived ? <Chip tone="muted">Archived</Chip> : null}
              {course.examDate ? (
                <span className="course-hero-exam">Exam {shortDate(course.examDate)}</span>
              ) : null}
            </div>
          </div>

          <div className="course-hero-stats">
            <div className="course-hero-stat">
              <span>Notes</span>
              <strong>{studyNotes.length}</strong>
            </div>
            <div className="course-hero-stat">
              <span>Study sets</span>
              <strong>{sets.data?.length ?? 0}</strong>
            </div>
            <div className="course-hero-stat">
              <span>Ready</span>
              <strong>{readyCount}</strong>
            </div>
          </div>
        </div>
      </Card>

      {actionError && !editOpen && !deleteOpen && !moveNote && !deleteNote ? (
        <Alert title="That didn’t work">{actionError}</Alert>
      ) : null}

      <div className="course-detail-tabs">
        <Segmented
          label="Course view"
          value={tab}
          options={[
            { value: "notes", label: "Notes" },
            { value: "study", label: "Study sets" },
          ]}
          onChange={setTab}
        />
        <div className="course-detail-actions">
          <Link href={`/app/create?courseId=${course.id}&mode=type`} className="btn btn-secondary btn-sm">
            <Plus size={15} /> Add note
          </Link>
          <Link href={`/app/create?courseId=${course.id}&mode=upload`} className="btn btn-primary btn-sm">
            <CloudUpload size={15} /> Upload
          </Link>
        </div>
      </div>

      {tab === "study" ? (
        <section className="course-study">
          {sets.error ? <ErrorState message={sets.error} onRetry={sets.reload} /> : null}
          {sets.loading && !sets.data ? <LoadingBlock rows={3} /> : null}
          {sets.data && sets.data.length === 0 && !sets.loading ? (
            <EmptyState
              icon={<BookOpen size={26} />}
              title="No study sets yet"
              body="Generate a study set from a note and its flashcards and quizzes appear here."
              action={
                <Link href={`/app/create?courseId=${course.id}&mode=type`} className="btn btn-secondary btn-sm">
                  Start a note
                </Link>
              }
            />
          ) : null}
          {sets.data && sets.data.length > 0 ? (
            <>
              <div className="course-study-actions">
                <Link href={`/app/review?courseId=${course.id}`} className="btn btn-gold btn-md">
                  <Play size={17} /> Review this course
                </Link>
                <p>Short sessions across every deck in {course.code || course.name}.</p>
              </div>
              <div className="course-set-grid">
                {sets.data.map((set) => (
                  <Link key={set.noteId} href={`/app/deck/${set.noteId}`} className="course-set-card card">
                    <strong>{set.noteTitle || "Untitled note"}</strong>
                    <span>
                      {set.cards} {set.cards === 1 ? "card" : "cards"} · {set.quizzes}{" "}
                      {set.quizzes === 1 ? "quiz" : "quizzes"}
                    </span>
                    <small>Updated {relativeDate(set.updatedAt)}</small>
                    <ChevronRight size={17} aria-hidden="true" />
                  </Link>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : (
        <>
          {notes.error ? <ErrorState message={notes.error} onRetry={notes.reload} /> : null}
          {notes.loading && !notes.data ? <LoadingBlock rows={4} /> : null}

          {!notes.loading && all.length === 0 ? (
            <EmptyState
              icon={<FileText size={26} />}
              title="No notes yet"
              body="Record a lecture, upload slides or type your first note. Sua turns it into a study set."
              action={
                <Link href={`/app/create?courseId=${course.id}&mode=type`} className="btn btn-secondary btn-sm">
                  Type a note
                </Link>
              }
            />
          ) : null}

          {GROUPS.map(({ key, label, hint, Icon }) => {
            const group = studyNotes.filter((note) => note.sourceType === key);
            if (!group.length) return null;
            return (
              <section key={key} className="note-group">
                <div className="note-group-head">
                  <div>
                    <h2>
                      <Icon size={16} /> {label}
                    </h2>
                    <p>{hint}</p>
                  </div>
                  <Chip tone="muted">{group.length}</Chip>
                </div>
                <div className="note-tiles">
                  {group.map((note) => (
                    <div className={`note-tile${key === "file" ? " note-tile-upload" : ""}`} key={note.id}>
                      <Link href={`/app/note/${note.id}`} className="note-tile-main">
                        {key === "file" ? (
                          <UploadRow note={note} />
                        ) : (
                          <>
                            <div className="note-tile-title">
                              <strong>{note.title || "Untitled note"}</strong>
                              <StatusBadge state={note.aiState ?? "none"} stage={note.aiState} />
                            </div>
                            <MarkdownPreview text={note.summary || note.body || note.transcript || ""} lines={2} />
                            <div className="note-tile-meta">
                              <span>{relativeDate(note.updatedAt)}</span>
                              {note.aiState === "ready" ? <span>Study set ready</span> : null}
                              {isAiActive(note.aiState) ? (
                                <span className="note-tile-live">
                                  <ProgressBar value={60} label="AI working" /> AI working
                                </span>
                              ) : null}
                            </div>
                          </>
                        )}
                      </Link>
                      <div className="note-tile-actions">
                        <IconButton
                          label={`Move ${note.title || "note"} to another course`}
                          onClick={() => {
                            setMoveNote(note);
                            setMoveTarget("");
                            setActionError(null);
                          }}
                        >
                          <ArrowRightLeft size={16} />
                        </IconButton>
                        <IconButton
                          label={`Delete ${note.title || "note"}`}
                          onClick={() => {
                            setDeleteNote(note);
                            setActionError(null);
                          }}
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {references.length ? (
            <section className="note-group">
              <div className="note-group-head">
                <div>
                  <h2>
                    <BookOpen size={16} /> Course references
                  </h2>
                  <p>Condensed key points from your slides and photos.</p>
                </div>
                <Chip tone="muted">{references.length}</Chip>
              </div>
              <div className="note-tiles">
                {references.map((note) => (
                  <div className="note-tile note-tile-reference" key={note.id}>
                    <Link href={`/app/note/${note.id}`} className="note-tile-main">
                      <div className="note-tile-title">
                        <strong>{note.title || "Untitled reference"}</strong>
                        <StatusBadge state={note.aiState ?? "none"} stage={note.aiState} />
                      </div>
                      <MarkdownPreview
                        text={note.body || note.transcript || "Waiting for the AI to summarise this file…"}
                        lines={3}
                      />
                      <div className="note-tile-meta">
                        <span>Reference sheet</span>
                        <span>{relativeDate(note.updatedAt)}</span>
                      </div>
                    </Link>
                    <div className="note-tile-actions">
                      <IconButton
                        label={`Delete ${note.title || "reference"}`}
                        onClick={() => {
                          setDeleteNote(note);
                          setActionError(null);
                        }}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <Modal open={menuOpen} onClose={closeMenu} title={course.name} description="Course actions">
        <div className="action-list">
          <button type="button" className="action-list-row" onClick={openEditor}>
            <Pencil size={17} /> <span>Edit course details</span>
          </button>
          <button type="button" className="action-list-row" onClick={() => void toggleArchive()}>
            <BookOpen size={17} />
            <span>{course.archived ? "Restore to this semester" : "Archive course"}</span>
          </button>
          <button
            type="button"
            className="action-list-row action-list-danger"
            onClick={() => {
              setMenuOpen(false);
              setDeleteTarget("");
              setDeleteNotesToo(false);
              setActionError(null);
              setDeleteOpen(true);
            }}
          >
            <Trash2 size={17} /> <span>Delete course</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        onClose={closeEditor}
        title="Edit course"
        description="Notes and study sets stay attached to this course."
        footer={
          <>
            <Button variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void saveCourse()}>
              Save changes
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not save">{actionError}</Alert> : null}
        <div className="form-grid">
          <Field label="Course name" htmlFor="cd-name">
            <TextInput
              id="cd-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Course code" htmlFor="cd-code">
            <TextInput
              id="cd-code"
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
            />
          </Field>
          <Field label="Lecturer" htmlFor="cd-lecturer">
            <TextInput
              id="cd-lecturer"
              value={form.lecturer}
              onChange={(event) => setForm({ ...form, lecturer: event.target.value })}
            />
          </Field>
          <Field label="Exam date" htmlFor="cd-exam">
            <TextInput
              id="cd-exam"
              type="date"
              value={form.examDate}
              onChange={(event) => setForm({ ...form, examDate: event.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(moveNote)}
        onClose={closeMoveNote}
        title="Move note"
        description={`Choose where “${moveNote?.title || "this note"}” should live.`}
        footer={
          <>
            <Button variant="ghost" onClick={closeMoveNote}>
              Cancel
            </Button>
            <Button busy={busy} disabled={!moveTarget} onClick={() => void moveNoteTo()}>
              Move note
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not move">{actionError}</Alert> : null}
        <Field label="Move to" htmlFor="move-course">
          <Select
            id="move-course"
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
          >
            <option value="">Choose a course…</option>
            {otherCourses.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        </Field>
        {otherCourses.length === 0 ? (
          <Alert tone="info">Create another course first, then move this note into it.</Alert>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(deleteNote)}
        onClose={closeDeleteNote}
        title={`Delete ${deleteNote?.title || "this note"}?`}
        description="The note, its uploads and its study set are removed from every device."
        footer={
          <>
            <Button variant="ghost" onClick={closeDeleteNote}>
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void confirmDeleteNote()}>
              Delete note
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not delete">{actionError}</Alert> : null}
        <Alert tone="warning">This cannot be undone.</Alert>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={closeDelete}
        title={`Delete ${course.name}?`}
        description={
          course.noteCount > 0
            ? `This course has ${course.noteCount} ${course.noteCount === 1 ? "note" : "notes"}. Move them somewhere else or delete them permanently.`
            : "The course and its study sets will be removed from every device."
        }
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={course.noteCount > 0 && !deleteTarget && !deleteNotesToo}
              onClick={() => void confirmDeleteCourse()}
            >
              Delete course
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not delete">{actionError}</Alert> : null}
        {course.noteCount > 0 ? (
          <>
            <Field label="Move notes to" htmlFor="cd-move-target">
              <Select
                id="cd-move-target"
                value={deleteTarget}
                disabled={deleteNotesToo}
                onChange={(event) => {
                  setDeleteTarget(event.target.value);
                  setDeleteNotesToo(false);
                }}
              >
                <option value="">Choose a course…</option>
                {otherCourses.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={deleteNotesToo}
                onChange={(event) => {
                  setDeleteNotesToo(event.target.checked);
                  if (event.target.checked) setDeleteTarget("");
                }}
              />
              <span>Delete the notes too, instead of moving them</span>
            </label>
          </>
        ) : (
          <Alert tone="warning">
            This cannot be undone. Notes and generated study sets in this course will be deleted.
          </Alert>
        )}
      </Modal>
    </div>
  );
}
