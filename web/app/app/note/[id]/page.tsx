"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Flag,
  Layers,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Type,
  Volume2,
  X,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Alert,
  Button,
  Card,
  Chip,
  ErrorState,
  IconButton,
  LoadingBlock,
  Modal,
  ProgressBar,
  Segmented,
  StatusBadge,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ReportButton, ReportMistake } from "@/components/report-mistake";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { usePrefs } from "@/lib/prefs";
import { courseStyle } from "@/lib/course-style";
import { relativeDate, dueLabel } from "@/lib/format";
import {
  aiStageLabel,
  GENERIC_FAILURE,
  generationKindFor,
  isAiActive,
  sourceMetaFor,
} from "@/lib/generation";
import { splitNotices } from "@/lib/markdown";
import type { AiState, ServerJob, ServerNote, ServerQuiz, ServerStudy } from "@/lib/types";

type Tab = "notes" | "summary" | "cards" | "quiz";

type ReportTarget = {
  targetType: "summary" | "flashcard" | "quiz_question" | "transcript";
  targetId?: string;
  label: string;
};

export default function NoteViewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const api = useApi();
  const { courses, refresh } = useAppData();
  const { prefs, update } = usePrefs();

  const noteResource = useResource<ServerNote>(`note:${id}`, () => api.notes.get(id));
  const studyResource = useResource<ServerStudy>(`note-study:${id}`, () => api.notes.study(id));

  const [job, setJob] = useState<ServerJob | null>(null);
  const [tab, setTab] = useState<Tab>("notes");
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeDelete = useCallback(() => setDeleteOpen(false), []);
  const closeReport = useCallback(() => setReport(null), []);

  const note = noteResource.data;
  const study = studyResource.data;
  const course = courses.find((row) => row.id === note?.courseId);
  const reference = note?.noteKind === "reference";
  const active = isAiActive(note?.aiState);
  const kind = generationKindFor(note);
  const source = sourceMetaFor(note, job?.meta ?? null);
  const notices = useMemo(
    () => splitNotices(note?.body ?? note?.summary ?? ""),
    [note?.body, note?.summary],
  );
  const cards = study?.flashcards ?? [];
  const quizzes = study?.quizzes ?? [];
  const quiz = quizzes[0] ?? null;

  // Poll the pipeline while it works. The job record (not the note row) is the
  // source of truth for the stage; once terminal, reload note + study once.
  useEffect(() => {
    if (!note) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(shouldContinue: boolean) {
      let next: ServerJob | null = null;
      try {
        next = await api.jobs.forNote(id);
      } catch {
        next = null;
      }
      if (cancelled) return;
      setJob(next);
      if (next && (next.state === "queued" || next.state === "running")) {
        timer = setTimeout(() => void poll(true), 5000);
        return;
      }
      if (shouldContinue && next && (next.state === "done" || next.state === "failed")) {
        noteResource.reload();
        studyResource.reload();
      }
    }

    void poll(isAiActive(note.aiState));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, note?.id, note?.aiState]);

  async function generate() {
    if (!note) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.jobs.enqueue(note.id, generationKindFor(note));
      noteResource.setData((current) =>
        current ? { ...current, aiState: "queued" } : current,
      );
      noteResource.reload();
      setTab("notes");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : GENERIC_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!note) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.notes.sync([{ operation: "delete", id: note.id }]);
      refresh();
      setDeleteOpen(false);
      router.push(`/app/courses/${note.courseId}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not delete this note.");
    } finally {
      setBusy(false);
    }
  }

  if (noteResource.error) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          <ArrowLeft size={16} /> Courses
        </Link>
        <ErrorState message={noteResource.error} onRetry={noteResource.reload} />
      </div>
    );
  }

  if (!note) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          <ArrowLeft size={16} /> Courses
        </Link>
        <LoadingBlock rows={5} />
      </div>
    );
  }

  const style = courseStyle(course?.colour);
  const failureMessage = job?.error || GENERIC_FAILURE;
  const headingReport =
    tab === "summary"
      ? (heading: string | null) => (
          <ReportButton
            compact
            label={`Report a mistake in ${heading ?? "this summary"}`}
            onClick={() =>
              setReport({
                targetType: "summary",
                label: heading ? `Summary · ${heading}` : "Summary",
              })
            }
          />
        )
      : undefined;

  return (
    <div className="note-view">
      <Link href={`/app/courses/${note.courseId}`} className="back-link">
        <ArrowLeft size={16} /> {course?.name ?? "Course"}
      </Link>

      <header className="note-head">
        <div className="note-head-copy">
          <div className="note-head-meta">
            {course ? (
              <span className={`note-course-pill ${style.tint} ${style.text}`}>
                {course.code || course.name}
              </span>
            ) : null}
            <span>{reference ? "Course reference" : "Study note"}</span>
            <span>·</span>
            <span>{relativeDate(note.updatedAt)}</span>
            {note.sourceType === "audio" ? (
              <span className="note-source">
                <Volume2 size={13} /> Recording
              </span>
            ) : null}
            {note.sourceType === "file" ? (
              <span className="note-source">
                <BookOpen size={13} /> Upload
              </span>
            ) : null}
          </div>
          <h1>{note.title || "Untitled note"}</h1>
          <div className="note-head-badges">
            <StatusBadge state={note.aiState ?? "none"} stage={job?.stage ?? note.aiState} />
            {source?.read ? <Chip tone="muted">{source.read}</Chip> : null}
            {source?.truncated ? <Chip tone="warning">Source trimmed</Chip> : null}
            {source?.checkFailed ? <Chip tone="warning">Check flagged</Chip> : null}
          </div>
        </div>
        <div className="note-head-actions">
          {note.sourceType === "typed" ? (
            <Link
              href={`/app/create?noteId=${note.id}&mode=type`}
              className="btn btn-secondary btn-sm"
            >
              <Pencil size={15} /> Edit
            </Link>
          ) : null}
          {!reference ? (
            <Link href={`/app/deck/${note.id}`} className="btn btn-secondary btn-sm">
              <Layers size={15} /> Deck
            </Link>
          ) : null}
          {quiz ? (
            <Link href={`/app/quiz/${quiz.id}`} className="btn btn-primary btn-sm">
              <Play size={15} /> Take quiz
            </Link>
          ) : null}
          <IconButton label="Note actions" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal size={18} />
          </IconButton>
        </div>
      </header>

      {actionError ? <Alert title="That didn’t work">{actionError}</Alert> : null}

      {active ? (
        <Card className="ai-progress">
          <div className="ai-progress-top">
            <span className="ai-progress-icon">
              <Sparkles size={20} />
            </span>
            <div>
              <h2>
                {aiStageLabel(
                  (job?.stage ?? note.aiState ?? "queued") as AiState,
                  kind,
                  note,
                )}
              </h2>
              <p>
                {reference
                  ? "Sua is condensing this material into a reference sheet. You can keep reading while it works."
                  : "Sua is reading your material, writing notes and building your study set. This usually takes a few minutes."}
              </p>
            </div>
          </div>
          <ProgressBar value={72} label="AI progress" />
          <div className="ai-progress-foot">
            <span>Attempt {job?.attempts ?? 1}</span>
            <span>
              {note.sourceType === "typed" ? "Typed note" : "Uploaded material"} ·{" "}
              {reference ? "Reference" : "Lecture note"}
            </span>
          </div>
        </Card>
      ) : null}

      {note.aiState === "failed" ? (
        <Alert
          tone="danger"
          title="The AI run failed"
          action={
            <Button variant="secondary" size="sm" busy={busy} onClick={() => void generate()}>
              Try again
            </Button>
          }
        >
          {failureMessage}
          {job?.attempts ? ` It failed after ${job.attempts} ${job.attempts === 1 ? "attempt" : "attempts"}.` : ""}
        </Alert>
      ) : null}

      {note.aiState === "none" && !reference ? (
        <Alert
          tone="info"
          title="No study set yet"
          action={
            <Button size="sm" busy={busy} onClick={() => void generate()}>
              Generate
            </Button>
          }
        >
          Sua can turn this note into a summary, flashcards and a quiz. It uses one summary from
          your monthly allowance.
        </Alert>
      ) : null}

      {reference && note.aiState === "ready" ? (
        <div className="note-reference-banner">
          <BookOpen size={18} aria-hidden="true" />
          <p>
            Reference sheets are read-only study aids — they never get flashcards or quizzes. Open
            the course&apos;s notes for practice material.
          </p>
        </div>
      ) : null}

      <div className="note-tabs">
        <Segmented
          label="Note view"
          value={tab}
          options={[
            { value: "notes", label: reference ? "Reference" : "Note" },
            ...(!reference
              ? ([{ value: "summary", label: "Summary" }] as const)
              : []),
            ...(!reference
              ? ([
                  { value: "cards", label: `Cards${cards.length ? ` (${cards.length})` : ""}` },
                  { value: "quiz", label: `Quiz${quizzes.length ? ` (${quizzes.length})` : ""}` },
                ] as const)
              : []),
          ]}
          onChange={(value) => setTab(value as Tab)}
        />
        <div className="note-text-size" role="group" aria-label="Note text size">
          <Type size={15} aria-hidden="true" />
          {(["small", "medium", "large"] as const).map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={prefs.noteTextScale === size}
              className={`note-text-size-btn ${prefs.noteTextScale === size ? "is-selected" : ""}`}
              onClick={() => update({ noteTextScale: size })}
              title={`${size} text`}
            >
              {size === "small" ? "A" : size === "medium" ? "A" : "A"}
            </button>
          ))}
        </div>
      </div>

      {tab === "notes" ? (
        <div className="note-reader">
          {notices.notices.length ? (
            <div className="notice-stack">
              {notices.notices.map((notice, index) => (
                <Alert key={index} tone="info">
                  {notice}
                </Alert>
              ))}
            </div>
          ) : null}

          <Card className="note-reader-card">
            {notesBody(note) ? (
              <Markdown text={notesBody(note)} scale={prefs.noteTextScale} />
            ) : (
              <p className="note-empty-copy">
                {active
                  ? "Sua is writing this note now. It will appear here when the run finishes."
                  : "This note has no text yet. Generate a study set or add a transcript."}
              </p>
            )}
          </Card>

          {note.transcript && note.sourceType !== "typed" ? (
            <Card className="note-transcript">
              <button
                type="button"
                className="note-transcript-toggle"
                aria-expanded={showTranscript}
                onClick={() => setShowTranscript((current) => !current)}
              >
                <span>
                  <Volume2 size={16} /> Original transcript
                </span>
                <ChevronRight
                  size={17}
                  className={showTranscript ? "is-open" : ""}
                  aria-hidden="true"
                />
              </button>
              {showTranscript ? (
                <div className="note-transcript-body">
                  <ReportButton
                    label="Report a transcript mistake"
                    onClick={() =>
                      setReport({ targetType: "transcript", label: "Transcript" })
                    }
                  />
                  <Markdown text={note.transcript} scale="small" />
                </div>
              ) : (
                <p className="note-transcript-hint">
                  The capture Sua worked from. Useful when a sentence in the note reads oddly.
                </p>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "summary" ? (
        <div className="note-reader">
          {studyResource.loading && !study ? <LoadingBlock rows={3} /> : null}
          {studyResource.error ? (
            <ErrorState message={studyResource.error} onRetry={studyResource.reload} />
          ) : null}
          {study?.summaryMarkdown ? (
            <Card className="note-reader-card">
              <Markdown
                text={study.summaryMarkdown}
                scale={prefs.noteTextScale}
                renderers={{ afterHeading: headingReport }}
              />
            </Card>
          ) : (
            <Card className="note-empty-card">
              <h2>No summary yet</h2>
              <p>
                {active
                  ? "The summary appears as soon as the AI run finishes."
                  : "Generate a study set to get a summary, flashcards and a quiz from this note."}
              </p>
              {!active ? (
                <Button variant="secondary" size="sm" busy={busy} onClick={() => void generate()}>
                  Generate study set
                </Button>
              ) : null}
            </Card>
          )}
        </div>
      ) : null}

      {tab === "cards" ? (
        <div className="note-cards">
          <div className="note-panel-head">
            <div>
              <h2>Flashcards</h2>
              <p>{cards.length ? `${cards.length} cards from this note.` : "No cards yet."}</p>
            </div>
            {cards.length ? (
              <div className="note-panel-actions">
                <Link href={`/app/deck/${note.id}`} className="btn btn-secondary btn-sm">
                  Manage deck
                </Link>
                <Link href={`/app/review?noteId=${note.id}`} className="btn btn-gold btn-sm">
                  <Play size={15} /> Review
                </Link>
              </div>
            ) : null}
          </div>

          {cards.length ? (
            <>
              <FlipCardViewer cards={cards} noteId={note.id} />
              <div className="card-list">
                {cards.map((card, index) => (
                  <Card key={card.id} className="flashcard-row">
                    <span className="flashcard-index">{index + 1}</span>
                    <div className="flashcard-row-copy">
                      <strong>{card.front}</strong>
                      <p>{card.back}</p>
                      <small>{dueLabel(card.dueAt)}</small>
                    </div>
                    <ReportButton
                      compact
                      label={`Report a mistake in card ${index + 1}`}
                      onClick={() =>
                        setReport({
                          targetType: "flashcard",
                          targetId: card.id,
                          label: `Card ${index + 1}: ${card.front}`,
                        })
                      }
                    />
                  </Card>
                ))}
              </div>
            </>
          ) : (
            <Card className="note-empty-card">
              <Brain size={26} />
              <h2>No flashcards yet</h2>
              <p>
                {active
                  ? "Flashcards will land here when the generation finishes."
                  : "Generate a study set, or add cards by hand in the deck editor."}
              </p>
              <div className="note-empty-actions">
                {!active ? (
                  <Button variant="secondary" size="sm" busy={busy} onClick={() => void generate()}>
                    Generate cards
                  </Button>
                ) : null}
                <Link href={`/app/deck/${note.id}`} className="btn btn-ghost btn-sm">
                  Open deck
                </Link>
              </div>
            </Card>
          )}
        </div>
      ) : null}

      {tab === "quiz" ? (
        <div className="note-quizzes">
          {quiz ? (
            <InlineQuizPlayer quiz={quiz} />
          ) : (
            <Card className="note-empty-card">
              <Flag size={24} />
              <h2>No quiz yet</h2>
              <p>Generate a study set to get a quiz with explanations and AI-marked short answers.</p>
              <div className="note-empty-actions">
                {!active ? (
                  <Button variant="secondary" size="sm" busy={busy} onClick={() => void generate()}>
                    Generate quiz
                  </Button>
                ) : null}
              </div>
            </Card>
          )}
        </div>
      ) : null}

      <Modal
        open={menuOpen}
        onClose={closeMenu}
        title={note.title || "Note"}
        description="Note actions"
      >
        <div className="action-list">
          <button
            type="button"
            className="action-list-row"
            onClick={() => {
              setMenuOpen(false);
              setReport({ targetType: "summary", label: "Summary" });
            }}
          >
            <Flag size={17} /> <span>Report a mistake</span>
          </button>
          {note.sourceType === "typed" ? (
            <Link
              href={`/app/create?noteId=${note.id}&mode=type`}
              className="action-list-row"
              onClick={closeMenu}
            >
              <Pencil size={17} /> <span>Edit note</span>
            </Link>
          ) : null}
          {!reference ? (
            <button
              type="button"
              className="action-list-row"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                void generate();
              }}
            >
              <RefreshCw size={17} /> <span>Regenerate study set</span>
            </button>
          ) : null}
          <button
            type="button"
            className="action-list-row action-list-danger"
            onClick={() => {
              setMenuOpen(false);
              setActionError(null);
              setDeleteOpen(true);
            }}
          >
            <Trash2 size={17} /> <span>Delete note</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={closeDelete}
        title={`Delete ${note.title || "this note"}?`}
        description="The note, its uploads and its study set are removed from the phone and the web."
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete}>
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>
              Delete note
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not delete">{actionError}</Alert> : null}
        <Alert tone="warning">This cannot be undone.</Alert>
      </Modal>

      <ReportMistake
        open={Boolean(report)}
        onClose={closeReport}
        noteId={note.id}
        targetType={report?.targetType ?? "summary"}
        targetId={report?.targetId}
        sourceText={note.transcript ?? note.body}
        label={report?.label}
      />
    </div>
  );
}

/** Typed notes keep text in body; AI-rewritten ones show body, original stays in transcript. */
function notesBody(note: ServerNote) {
  const body = String(note.body ?? "").trim();
  if (body) return body;
  return String(note.summary ?? "").trim();
}

function FlipCardViewer({
  cards,
  noteId,
}: {
  cards: { id: string; front: string; back: string }[];
  noteId: string;
}) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const card = cards[index] ?? cards[0];
  if (!card) return null;

  function goPrev() {
    setFlipped(false);
    setIndex((curr) => Math.max(0, curr - 1));
  }

  function goNext() {
    setFlipped(false);
    setIndex((curr) => Math.min(cards.length - 1, curr + 1));
  }

  return (
    <Card className="flip-card-container" style={{ padding: "1.25rem", marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <Chip tone="brand">
          Card {index + 1} of {cards.length}
        </Chip>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button variant="ghost" size="sm" onClick={() => setFlipped((f) => !f)}>
            <RotateCcw size={14} /> Flip card
          </Button>
          <Link href={`/app/review?noteId=${noteId}`} className="btn btn-gold btn-sm">
            <Play size={14} /> Review Deck (SRS)
          </Link>
        </div>
      </div>

      <button
        type="button"
        className="review-card"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? "Hide answer" : "Show answer"}
        style={{ width: "100%", minHeight: "220px", cursor: "pointer", border: "none" }}
      >
        <span className="review-card-face">
          <span className="review-card-label">{flipped ? "Answer" : "Question / Active Recall"}</span>
          <span className="review-card-text">
            <Markdown text={flipped ? card.back : card.front} scale="large" />
          </span>
          <span className="review-card-hint">
            <Sparkles size={14} /> {flipped ? "Click to view question" : "Click or tap to reveal answer"}
          </span>
        </span>
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
        <Button variant="secondary" size="sm" onClick={goPrev} disabled={index === 0}>
          <ChevronLeft size={16} /> Previous
        </Button>
        <small style={{ color: "var(--text-muted, #888)" }}>
          {index + 1} / {cards.length}
        </small>
        <Button variant="secondary" size="sm" onClick={goNext} disabled={index === cards.length - 1}>
          Next <ChevronRight size={16} />
        </Button>
      </div>
    </Card>
  );
}

function InlineQuizPlayer({ quiz }: { quiz: ServerQuiz }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const questions = quiz.questions;
  const answeredCount = Object.keys(answers).length;
  const correctCount = questions.filter(
    (q) => answers[q.id] && answers[q.id].trim().toLowerCase() === q.answer.trim().toLowerCase(),
  ).length;

  function pick(questionId: string, option: string) {
    if (answers[questionId]) return;
    setAnswers((prev) => ({ ...prev, [questionId]: option }));
  }

  function resetQuiz() {
    setAnswers({});
  }

  return (
    <div className="inline-quiz-player" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600 }}>{quiz.title}</h3>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.875rem", color: "var(--text-muted, #888)" }}>
            {questions.length} questions · instant answer feedback & explanations
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {answeredCount > 0 ? (
            <Chip tone={correctCount === answeredCount ? "success" : "brand"}>
              Score: {correctCount} / {answeredCount}
            </Chip>
          ) : null}
          {answeredCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={resetQuiz}>
              <RotateCcw size={14} /> Retake
            </Button>
          ) : null}
          <Link href={`/app/quiz/${quiz.id}`} className="btn btn-secondary btn-sm">
            Full Screen Mode
          </Link>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        {questions.map((question, qIdx) => {
          const selected = answers[question.id];
          const isAnswered = selected !== undefined;
          const isCorrect = isAnswered && selected.trim().toLowerCase() === question.answer.trim().toLowerCase();
          const options = question.options ?? (question.type === "true_false" ? ["True", "False"] : []);

          return (
            <Card key={question.id} className="quiz-question-card" style={{ padding: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "0.75rem" }}>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
                  <span className="quiz-tile-icon" style={{ minWidth: "28px", height: "28px", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "6px", fontSize: "0.85rem", fontWeight: 700 }}>
                    {qIdx + 1}
                  </span>
                  <strong style={{ fontSize: "1rem", lineHeight: 1.4 }}>{question.prompt}</strong>
                </div>
                {isAnswered ? (
                  <Chip tone={isCorrect ? "success" : "danger"}>
                    {isCorrect ? "Correct" : "Incorrect"}
                  </Chip>
                ) : null}
              </div>

              {options.length > 0 ? (
                <div className="quiz-options" style={{ display: "grid", gridTemplateColumns: "1fr", gap: "0.5rem", marginTop: "0.75rem" }}>
                  {options.map((option, optIdx) => {
                    const picked = selected === option;
                    const isOptionCorrect = option.trim().toLowerCase() === question.answer.trim().toLowerCase();
                    const className = isAnswered
                      ? isOptionCorrect
                        ? "is-correct"
                        : picked
                          ? "is-wrong"
                          : ""
                      : picked
                        ? "is-picked"
                        : "";

                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={isAnswered}
                        className={`quiz-option ${className}`}
                        onClick={() => pick(question.id, option)}
                        style={{ textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: isAnswered ? "default" : "pointer" }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <span className="quiz-option-key" style={{ fontWeight: 700 }}>
                            {question.type === "true_false" ? option.charAt(0) : String.fromCharCode(65 + optIdx)}
                          </span>
                          <span>{option}</span>
                        </span>
                        {isAnswered && isOptionCorrect ? <Check size={16} /> : null}
                        {isAnswered && picked && !isOptionCorrect ? <X size={16} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div style={{ marginTop: "0.5rem" }}>
                  <p><strong>Answer:</strong> {question.answer}</p>
                </div>
              )}

              {isAnswered && question.explanation ? (
                <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", borderRadius: "8px", background: "var(--card-subtle, rgba(255,255,255,0.04))", fontSize: "0.875rem" }}>
                  <strong>Explanation: </strong>
                  <span>{question.explanation}</span>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
