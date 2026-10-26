"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  ChevronRight,
  Flag,
  Layers,
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
  PageHeader,
  TextArea,
} from "@/components/ui";
import { ReportButton, ReportMistake } from "@/components/report-mistake";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { dueLabel, examCountdown, relativeDate } from "@/lib/format";
import { courseStyle } from "@/lib/course-style";
import type { ServerNote, ServerStudy } from "@/lib/types";

type Editing = {
  mode: "create" | "edit";
  id: string;
  front: string;
  back: string;
};

export default function DeckPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const { courses } = useAppData();
  const note = useResource<ServerNote>(`deck-note:${id}`, () => api.notes.get(id));
  const study = useResource<ServerStudy>(`deck-study:${id}`, () => api.notes.study(id));

  const [editor, setEditor] = useState<Editing | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ id: string; front: string } | null>(null);
  const [reportFor, setReportFor] = useState<{ id: string; front: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeEditor = useCallback(() => setEditor(null), []);
  const closeDelete = useCallback(() => setDeleteFor(null), []);
  const closeReport = useCallback(() => setReportFor(null), []);

  const course = courses.find((row) => row.id === note.data?.courseId);
  const style = courseStyle(course?.colour);
  const cards = study.data?.flashcards ?? [];
  const quizzes = study.data?.quizzes ?? [];

  function openCreate() {
    setEditor({ mode: "create", id: crypto.randomUUID(), front: "", back: "" });
    setError(null);
  }

  function openEdit(card: { id: string; front: string; back: string }) {
    setEditor({ mode: "edit", id: card.id, front: card.front, back: card.back });
    setError(null);
  }

  async function saveCard() {
    if (!editor) return;
    if (!editor.front.trim() || !editor.back.trim()) {
      setError("A card needs both a front and a back.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editor.mode === "create") {
        const created = await api.study.createCard(id, {
          id: editor.id,
          front: editor.front.trim(),
          back: editor.back.trim(),
        });
        study.setData((current) =>
          current
            ? {
                ...current,
                flashcards: [...current.flashcards, created],
              }
            : current,
        );
      } else {
        const updated = await api.study.updateCard(editor.id, {
          front: editor.front.trim(),
          back: editor.back.trim(),
        });
        study.setData((current) =>
          current
            ? {
                ...current,
                flashcards: current.flashcards.map((card) =>
                  card.id === updated.id
                    ? { ...card, front: updated.front, back: updated.back }
                    : card,
                ),
              }
            : current,
        );
      }
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this card.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteFor) return;
    setBusy(true);
    setError(null);
    try {
      await api.study.deleteCard(deleteFor.id);
      study.setData((current) =>
        current
          ? { ...current, flashcards: current.flashcards.filter((card) => card.id !== deleteFor.id) }
          : current,
      );
      setDeleteFor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this card.");
    } finally {
      setBusy(false);
    }
  }

  if (note.error) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <ErrorState message={note.error} onRetry={note.reload} />
      </div>
    );
  }

  if (!note.data) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <LoadingBlock rows={4} />
      </div>
    );
  }

  return (
    <div className="deck-page">
      <Link href={`/app/note/${id}`} className="back-link">
        <ArrowLeft size={16} /> {note.data.title || "Note"}
      </Link>

      <PageHeader
        eyebrow={course?.name ?? "Study deck"}
        title={note.data.title || "Study deck"}
        description="Every card from this note. Edit a card, add your own, or start a review."
        actions={
          <div className="deck-head-actions">
            {cards.length ? (
              <Link href={`/app/review?noteId=${id}`} className="btn btn-gold btn-md">
                <Play size={16} /> Review deck
              </Link>
            ) : null}
            <Button onClick={openCreate} icon={<Plus size={16} />}>
              Add card
            </Button>
          </div>
        }
      />

      {error && !editor && !deleteFor ? <Alert title="That didn’t work">{error}</Alert> : null}
      {study.error ? <ErrorState message={study.error} onRetry={study.reload} /> : null}

      <div className="deck-summary">
        <span className={`deck-summary-icon ${style.tint} ${style.text}`}>
          <Layers size={20} />
        </span>
        <div>
          <strong>
            {cards.length} {cards.length === 1 ? "card" : "cards"} · {quizzes.length}{" "}
            {quizzes.length === 1 ? "quiz" : "quizzes"}
          </strong>
          <p>Updated {relativeDate(note.data.updatedAt)}</p>
        </div>
        {quizzes[0] ? (
          <Link href={`/app/quiz/${quizzes[0].id}`} className="btn btn-secondary btn-sm">
            <Flag size={15} /> Take quiz
          </Link>
        ) : null}
      </div>

      {study.loading && !study.data ? <LoadingBlock rows={4} /> : null}

      {study.data && cards.length === 0 ? (
        <EmptyState
          icon={<Brain size={26} />}
          title="No cards in this deck"
          body="Generate a study set from the note, or add the first card yourself."
          action={
            <Button variant="secondary" onClick={openCreate} icon={<Plus size={16} />}>
              Add a card
            </Button>
          }
        />
      ) : null}

      {cards.length ? (
        <ol className="deck-list">
          {cards.map((card, index) => (
            <li key={card.id}>
              <Card className="deck-card">
                <span className="deck-card-index">{index + 1}</span>
                <div className="deck-card-copy">
                  <strong>{card.front}</strong>
                  <p>{card.back}</p>
                  <div className="deck-card-meta">
                    <Chip tone={card.dueAt && new Date(card.dueAt) <= new Date() ? "warning" : "muted"}>
                      {dueLabel(card.dueAt)}
                    </Chip>
                    {typeof card.reps === "number" ? <span>{card.reps} reviews</span> : null}
                    {typeof card.intervalDays === "number" ? (
                      <span>{card.intervalDays === 0 ? "New" : `${card.intervalDays}d interval`}</span>
                    ) : null}
                  </div>
                </div>
                <div className="deck-card-actions">
                  <ReportButton
                    compact
                    label={`Report a mistake in card ${index + 1}`}
                    onClick={() => setReportFor({ id: card.id, front: card.front })}
                  />
                  <IconButton label={`Edit card ${index + 1}`} onClick={() => openEdit(card)}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label={`Delete card ${index + 1}`}
                    onClick={() => {
                      setError(null);
                      setDeleteFor({ id: card.id, front: card.front });
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      ) : null}

      {quizzes.length ? (
        <section className="deck-quizzes">
          <div className="section-heading-row">
            <div>
              <h2 className="section-title">Quizzes from this note</h2>
              <p className="section-hint">Short answers are marked by Sua with feedback.</p>
            </div>
          </div>
          <div className="quiz-tile-grid">
            {quizzes.map((quiz) => (
              <div key={quiz.id} className="quiz-tile card">
                <span className="quiz-tile-icon">
                  <Flag size={19} />
                </span>
                <div>
                  <strong>{quiz.title}</strong>
                  <p>{quiz.questions.length} questions</p>
                </div>
                <Link href={`/app/quiz/${quiz.id}`} className="btn btn-secondary btn-sm">
                  Start <ChevronRight size={14} />
                </Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Modal
        open={Boolean(editor)}
        onClose={closeEditor}
        title={editor?.mode === "edit" ? "Edit card" : "New card"}
        description="Keep the front short and the back specific — that is what makes recall work."
        footer={
          <>
            <Button variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void saveCard()}>
              {editor?.mode === "edit" ? "Save card" : "Add card"}
            </Button>
          </>
        }
      >
        {error ? <Alert title="Could not save">{error}</Alert> : null}
        <Field label="Front — the prompt" htmlFor="deck-front">
          <TextArea
            id="deck-front"
            rows={3}
            value={editor?.front ?? ""}
            onChange={(event) =>
              setEditor((current) => (current ? { ...current, front: event.target.value } : current))
            }
            placeholder="e.g. What does the light reaction produce?"
          />
        </Field>
        <Field label="Back — the answer" htmlFor="deck-back">
          <TextArea
            id="deck-back"
            rows={4}
            value={editor?.back ?? ""}
            onChange={(event) =>
              setEditor((current) => (current ? { ...current, back: event.target.value } : current))
            }
            placeholder="ATP, NADPH and oxygen…"
          />
        </Field>
      </Modal>

      <Modal
        open={Boolean(deleteFor)}
        onClose={closeDelete}
        title="Delete this card?"
        description={deleteFor?.front}
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete}>
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>
              Delete card
            </Button>
          </>
        }
      >
        {error ? <Alert title="Could not delete">{error}</Alert> : null}
        <Alert tone="warning">Its review history is removed too. This cannot be undone.</Alert>
      </Modal>

      <ReportMistake
        open={Boolean(reportFor)}
        onClose={closeReport}
        noteId={id}
        targetType="flashcard"
        targetId={reportFor?.id}
        sourceText={note.data.summary ?? note.data.body}
        label={reportFor?.front}
      />
    </div>
  );
}
