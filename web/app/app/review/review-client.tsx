"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronRight,
  Layers,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  ProgressBar,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { usePrefs } from "@/lib/prefs";
import { GRADE_LABELS, nextDueMs } from "@/lib/srs";
import { dueLabel } from "@/lib/format";
import type { CardGrade, ServerDueCard, ServerDueResponse } from "@/lib/types";

type Outcome = Record<CardGrade, number>;

const EMPTY_OUTCOME: Outcome = { again: 0, hard: 0, good: 0, easy: 0 };

/** Days of look-ahead offered when nothing is due (matches mobile). */
const AHEAD_DAYS = 7;

export function ReviewWorkspace() {
  const params = useSearchParams();
  const courseId = params.get("courseId");
  const noteId = params.get("noteId");
  const api = useApi();
  const { courses, refresh } = useAppData();
  const { prefs } = usePrefs();
  const limit = prefs.reviewSessionLength;

  const due = useResource<ServerDueResponse>(
    `review:${limit}:${courseId ?? ""}:${noteId ?? ""}`,
    () => api.study.due(limit, AHEAD_DAYS),
  );

  // Same order as mobile: today's due cards first, and only when that queue is
  // empty does the session fall back to a short review-ahead.
  const selection = useMemo(() => {
    const matches = (card: ServerDueCard) => {
      if (noteId && card.noteId !== noteId) return false;
      if (courseId && card.courseId !== courseId) return false;
      return true;
    };
    const dueNow = (due.data?.cards ?? []).filter(matches);
    if (dueNow.length) return { cards: dueNow, ahead: false };
    const later = (due.data?.aheadCards ?? []).filter(matches).slice(0, limit);
    return { cards: later, ahead: later.length > 0 };
  }, [due.data, courseId, noteId, limit]);

  const cards = selection.cards;
  const reviewingAhead = selection.ahead;

  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(EMPTY_OUTCOME);
  const [finished, setFinished] = useState(false);
  const actionsRef = useRef<{ flip: () => void; grade: (grade: CardGrade) => void }>({
    flip: () => {},
    grade: () => {},
  });

  const card = cards[index] ?? null;
  const course = courses.find((row) => row.id === card?.courseId);
  const total = cards.length;
  const complete = finished || (total > 0 && index >= total);

  function flip() {
    if (card) setFlipped((value) => !value);
  }

  async function grade(gradeValue: CardGrade) {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    const now = new Date();
    try {
      await api.study.syncReviews([
        {
          id: crypto.randomUUID(),
          cardId: card.id,
          grade: gradeValue,
          reviewedAt: now.toISOString(),
          prevIntervalDays: card.intervalDays,
        },
      ]);
      setOutcome((current) => ({ ...current, [gradeValue]: current[gradeValue] + 1 }));
      refresh();
      if (index + 1 >= total) {
        setFinished(true);
      } else {
        setIndex((value) => value + 1);
        setFlipped(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save that grade.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    actionsRef.current = { flip, grade: (value) => void grade(value) };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (complete) return;
      if (event.code === "Space" || event.key === "Enter") {
        event.preventDefault();
        actionsRef.current.flip();
        return;
      }
      const map: Record<string, CardGrade> = {
        "1": "again",
        "2": "hard",
        "3": "good",
        "4": "easy",
      };
      const value = map[event.key];
      if (value) {
        event.preventDefault();
        actionsRef.current.grade(value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [complete]);

  function restart() {
    setIndex(0);
    setFlipped(false);
    setOutcome(EMPTY_OUTCOME);
    setFinished(false);
    setError(null);
    due.reload();
  }

  if (due.error) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <ErrorState message={due.error} onRetry={due.reload} />
      </div>
    );
  }

  if (due.loading && !due.data) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <LoadingBlock rows={4} />
      </div>
    );
  }

  if (!total) {
    const dueElsewhere = (due.data?.due ?? 0) > 0 && Boolean(courseId || noteId);
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <PageHeader
          eyebrow="Daily review"
          title="Nothing to review"
          description="Sua only shows cards when they are ready to come back — or just before they are."
        />
        <EmptyState
          icon={<Brain size={27} />}
          title={dueElsewhere ? "No cards due in this selection" : "You’re all caught up"}
          body={
            dueElsewhere
              ? `${due.data?.due} ${due.data?.due === 1 ? "card is" : "cards are"} due in other decks. Open the full review to keep the streak going.`
              : "Generate a study set from any note — cards land here when due."
          }
          action={
            <div className="empty-actions">
              {dueElsewhere ? (
                <Link href="/app/review" className="btn btn-secondary btn-md">
                  Review everything
                </Link>
              ) : null}
              <Link href="/app/study" className="btn btn-primary btn-md">
                <Layers size={16} /> Open study sets
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  if (complete) {
    const graded = outcome.again + outcome.hard + outcome.good + outcome.easy;
    const strong = graded - outcome.again;
    return (
      <div className="review-complete">
        <Card className="review-complete-card">
          <span className="review-complete-icon">
            <CheckCircle2 size={30} />
          </span>
          <p className="eyebrow-sm">Daily review</p>
          <h1>{graded > 0 ? "Review complete" : "Nothing to review"}</h1>
          <p>
            {graded > 0
              ? `${strong} of ${graded} kept fresh. Come back when cards are due.`
              : "Generate a study set from any note — cards land here when due."}
          </p>
          {outcome.again > 0 ? (
            <p className="review-return-note">
              {outcome.again} {outcome.again === 1 ? "card returns" : "cards return"} shortly.
            </p>
          ) : null}
          {graded > 0 ? (
            <div className="review-outcome-grid">
              {GRADE_LABELS.map((entry) => (
                <div key={entry.key} className={`review-outcome rating-${entry.key}`}>
                  <strong>{outcome[entry.key]}</strong>
                  <span>{entry.label}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="review-complete-actions">
            <Button variant="secondary" onClick={restart} icon={<RotateCcw size={16} />}>
              Check for more
            </Button>
            <Link href="/app/study" className="btn btn-primary btn-md">
              Back to study <ChevronRight size={16} />
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const nextDue = card ? nextDueMs(card, "good") : 0;

  return (
    <div className="review-page">
      <div className="review-topbar">
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <div className="review-topbar-meta">
          <Chip tone="brand">
            {card ? `${index + 1} / ${total}` : ""}
          </Chip>
          {reviewingAhead ? <Chip tone="gold">Reviewing ahead</Chip> : null}
          <span>{course?.name ?? card?.noteTitle}</span>
        </div>
      </div>

      <div className="review-progress">
        <ProgressBar
          value={(index / Math.max(1, total)) * 100}
          label="Review session progress"
        />
        <span>
          {index} of {total} done
        </span>
      </div>

      {error ? <Alert title="Could not save that grade">{error}</Alert> : null}

      <button
        type="button"
        className="review-card"
        onClick={flip}
        aria-label={flipped ? "Hide the answer" : "Show the answer"}
      >
        <span className="review-card-face">
          <span className="review-card-label">{flipped ? "Answer" : "Question"}</span>
          <span className="review-card-text">
            <Markdown text={flipped ? card?.back ?? "" : card?.front ?? ""} scale="large" />
          </span>
          {!flipped ? (
            <span className="review-card-hint">
              <Sparkles size={15} /> Tap or press space to reveal
            </span>
          ) : (
            <span className="review-card-hint">
              <ArrowRight size={15} /> Grade how it felt
            </span>
          )}
        </span>
      </button>

      <div className="review-meta-row">
        <span>{card?.noteTitle || "Untitled note"}</span>
        <span>{dueLabel(card?.dueAt)}</span>
        <span>Due again on “Good”: {new Date(nextDue).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      </div>

      {flipped ? (
        <div className="review-grades" role="group" aria-label="Grade this card">
          {GRADE_LABELS.map((entry, gradeIndex) => (
            <button
              key={entry.key}
              type="button"
              disabled={busy}
              className={`review-grade rating-${entry.key}`}
              onClick={() => void grade(entry.key)}
            >
              <span className="review-grade-key">{gradeIndex + 1}</span>
              <strong>{entry.label}</strong>
              <small>{entry.hint}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="review-reveal">
          <Button size="lg" onClick={flip}>
            Show answer <ArrowRight size={17} />
          </Button>
          <span className="review-shortcut">or press space</span>
        </div>
      )}

      <p className="review-footnote">
        {reviewingAhead
          ? `Nothing was due, so these are the cards coming up in the next ${AHEAD_DAYS} days. Grades save straight to your account.`
          : "Grades save straight to your account, so the phone sees the same schedule next pull."}
      </p>
    </div>
  );
}
