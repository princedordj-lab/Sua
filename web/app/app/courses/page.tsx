"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  CalendarDays,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
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
  PageHeader,
  Segmented,
  Select,
  TextInput,
} from "@/components/ui";
import { COURSE_COLOURS, courseStyle } from "@/lib/course-style";
import { examCountdown, shortDate } from "@/lib/format";
import type { ServerCourse } from "@/lib/types";

type Filter = "all" | "active" | "archived";

type FormState = {
  name: string;
  code: string;
  lecturer: string;
  examDate: string;
  colour: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  code: "",
  lecturer: "",
  examDate: "",
  colour: COURSE_COLOURS[1].hex,
};

function formFromCourse(course: ServerCourse): FormState {
  return {
    name: course.name,
    code: course.code ?? "",
    lecturer: course.lecturer ?? "",
    examDate: course.examDate?.slice(0, 10) ?? "",
    colour: course.colour,
  };
}

export default function CoursesPage() {
  const { courses, loading, error, refresh, addCourse, updateCourse, deleteCourse } =
    useAppData();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ServerCourse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<ServerCourse | null>(null);
  const [deleteFor, setDeleteFor] = useState<ServerCourse | null>(null);
  const [moveTo, setMoveTo] = useState<string>("");
  const [deleteNotes, setDeleteNotes] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return courses.filter((course) => {
      if (filter === "active" && course.archived) return false;
      if (filter === "archived" && !course.archived) return false;
      if (!needle) return true;
      return (
        course.name.toLowerCase().includes(needle) ||
        (course.code ?? "").toLowerCase().includes(needle) ||
        (course.lecturer ?? "").toLowerCase().includes(needle)
      );
    });
  }, [courses, filter, query]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditorOpen(true);
  }

  function openEdit(course: ServerCourse) {
    setEditing(course);
    setForm(formFromCourse(course));
    setFormError(null);
    setEditorOpen(true);
    setActionsFor(null);
  }

  async function save() {
    if (!form.name.trim()) {
      setFormError("Give the course a name.");
      return;
    }
    if (form.examDate && Number.isNaN(new Date(form.examDate).getTime())) {
      setFormError("Use a valid exam date.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (editing) {
        await updateCourse(editing.id, {
          name: form.name.trim(),
          code: form.code.trim(),
          lecturer: form.lecturer.trim(),
          examDate: form.examDate || null,
          colour: form.colour,
        });
      } else {
        await addCourse({
          name: form.name.trim(),
          code: form.code.trim(),
          lecturer: form.lecturer.trim(),
          examDate: form.examDate || null,
          colour: form.colour,
        });
      }
      setEditorOpen(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save this course.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(course: ServerCourse) {
    setActionsFor(null);
    try {
      await updateCourse(course.id, { archived: !course.archived });
    } catch {
      refresh();
    }
  }

  async function confirmDelete() {
    if (!deleteFor) return;
    if (deleteFor.noteCount > 0 && !deleteNotes && !moveTo) return;
    setBusy(true);
    try {
      await deleteCourse(deleteFor.id, deleteNotes ? undefined : moveTo || undefined);
      setDeleteFor(null);
      setMoveTo("");
      setDeleteNotes(false);
    } catch {
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const moveTargets = courses.filter(
    (course) => course.id !== deleteFor?.id && !course.archived,
  );

  return (
    <div>
      <PageHeader
        eyebrow="Your study space"
        title="Courses"
        description="Group notes by the course they belong to. Exam dates drive the countdown across Sua."
        actions={
          <Button icon={<Plus size={17} />} onClick={openCreate}>
            New course
          </Button>
        }
      />

      <div className="toolbar">
        <div className="search-box">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by course, code or lecturer"
            aria-label="Search courses"
          />
        </div>
        <div className="toolbar-segmented">
          <Segmented
            label="Filter courses"
            value={filter}
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "This semester" },
              { value: "archived", label: "Archived" },
            ]}
            onChange={setFilter}
          />
        </div>
      </div>

      {error ? <ErrorState message={error} onRetry={refresh} /> : null}
      {loading && !courses.length ? <LoadingBlock rows={4} /> : null}

      {!loading && !error && visible.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={26} />}
          title={courses.length ? "No courses match that filter" : "Add your first course"}
          body={
            courses.length
              ? "Try another search, or switch back to All to see every course."
              : "Courses keep your notes, study sets and exam countdown in one place."
          }
          action={
            <Button variant="secondary" onClick={openCreate} icon={<Plus size={16} />}>
              Add a course
            </Button>
          }
        />
      ) : null}

      <div className="course-grid">
        {visible.map((course) => {
          const style = courseStyle(course.colour);
          const countdown = examCountdown(course.examDate);
          return (
            <Card key={course.id} className={`course-card ${course.archived ? "is-archived" : ""}`}>
              <Link href={`/app/courses/${course.id}`} className="course-card-link">
                <div className="course-card-top">
                  <span className={`course-dot ${style.dot}`} aria-hidden="true" />
                  {course.archived ? <Chip tone="muted">Archived</Chip> : null}
                  {countdown ? <Chip tone={countdown.tone}>{countdown.label}</Chip> : null}
                </div>
                <h3>{course.name}</h3>
                <p className="course-card-meta">
                  {[course.code, course.lecturer].filter(Boolean).join(" · ") || "No code yet"}
                </p>
                <div className="course-card-footer">
                  <span>{course.noteCount} {course.noteCount === 1 ? "note" : "notes"}</span>
                  {course.examDate ? (
                    <span className="course-exam">
                      <CalendarDays size={13} /> {shortDate(course.examDate)}
                    </span>
                  ) : null}
                  <ChevronRight size={17} className="course-chevron" aria-hidden="true" />
                </div>
              </Link>
              <IconButton
                label={`Manage ${course.name}`}
                className="course-menu"
                onClick={() => setActionsFor(course)}
              >
                <MoreHorizontal size={18} />
              </IconButton>
            </Card>
          );
        })}
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? "Edit course" : "New course"}
        description={
          editing
            ? "Rename the course or update its exam date. Notes stay attached."
            : "A course groups the notes and study sets for one paper."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void save()}>
              {editing ? "Save changes" : "Create course"}
            </Button>
          </>
        }
      >
        {formError ? <Alert title="Could not save">{formError}</Alert> : null}
        <div className="form-grid">
          <Field label="Course name" htmlFor="course-name">
            <TextInput
              id="course-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="e.g. Organic Chemistry"
              autoFocus
            />
          </Field>
          <Field label="Course code" htmlFor="course-code">
            <TextInput
              id="course-code"
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
              placeholder="e.g. CHEM 201"
            />
          </Field>
          <Field label="Lecturer" htmlFor="course-lecturer">
            <TextInput
              id="course-lecturer"
              value={form.lecturer}
              onChange={(event) => setForm({ ...form, lecturer: event.target.value })}
              placeholder="Optional"
            />
          </Field>
          <Field label="Exam date" htmlFor="course-exam">
            <TextInput
              id="course-exam"
              type="date"
              value={form.examDate}
              onChange={(event) => setForm({ ...form, examDate: event.target.value })}
            />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Course colour</span>
          <div className="colour-row" role="radiogroup" aria-label="Course colour">
            {COURSE_COLOURS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="radio"
                aria-checked={form.colour === entry.hex}
                aria-label={entry.key}
                className={`colour-swatch ${entry.dot} ${form.colour === entry.hex ? "is-selected" : ""}`}
                onClick={() => setForm({ ...form, colour: entry.hex })}
              />
            ))}
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(actionsFor)}
        onClose={() => setActionsFor(null)}
        title={actionsFor?.name ?? "Course"}
        description="Rename it, archive it for the semester, or delete it."
      >
        <div className="action-list">
          <button type="button" className="action-list-row" onClick={() => actionsFor && openEdit(actionsFor)}>
            <Pencil size={17} /> <span>Rename or edit details</span>
          </button>
          <button
            type="button"
            className="action-list-row"
            onClick={() => actionsFor && void toggleArchive(actionsFor)}
          >
            {actionsFor?.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}
            <span>{actionsFor?.archived ? "Restore to this semester" : "Archive course"}</span>
          </button>
          <button
            type="button"
            className="action-list-row action-list-danger"
            onClick={() => {
              setDeleteFor(actionsFor);
              setActionsFor(null);
              setMoveTo("");
              setDeleteNotes(false);
            }}
          >
            <Trash2 size={17} /> <span>Delete course</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={Boolean(deleteFor)}
        onClose={() => setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? "course"}?`}
        description={
          deleteFor && deleteFor.noteCount > 0
            ? `This course has ${deleteFor.noteCount} ${deleteFor.noteCount === 1 ? "note" : "notes"}. Move them to another course or delete them permanently.`
            : "The course and its study sets will be removed from every device."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteFor(null)}>
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void confirmDelete()} disabled={
              Boolean(deleteFor && deleteFor.noteCount > 0 && !deleteNotes && !moveTo)
            }>
              Delete course
            </Button>
          </>
        }
      >
        {deleteFor && deleteFor.noteCount > 0 ? (
          <>
            <Field label="Move notes to" htmlFor="move-target">
              <Select
                id="move-target"
                value={moveTo}
                onChange={(event) => {
                  setMoveTo(event.target.value);
                  setDeleteNotes(false);
                }}
                disabled={deleteNotes}
              >
                <option value="">Choose a course…</option>
                {moveTargets.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={deleteNotes}
                onChange={(event) => {
                  setDeleteNotes(event.target.checked);
                  if (event.target.checked) setMoveTo("");
                }}
              />
              <span>Delete the notes too, instead of moving them</span>
            </label>
            {!deleteNotes && !moveTo ? (
              <Alert tone="warning">
                Pick a course to move the notes to, or tick the box to delete them.
              </Alert>
            ) : null}
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
