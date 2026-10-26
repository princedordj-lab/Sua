"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Flag,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Chip,
  ErrorState,
  LoadingBlock,
  ProgressBar,
  TextArea,
} from "@/components/ui";
import { ReportButton, ReportMistake } from "@/components/report-mistake";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import type {
  ServerAttempt,
  ServerAttemptDetails,
  ServerQuizDetail,
  ServerQuizQuestion,
} from "@/lib/types";

type AnswerMap = Record<string, string>;
type VerdictMap = Record<string, boolean>;

export default function QuizPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const quiz = useResource<ServerQuizDetail>(`quiz:${id}`, () => api.study.quiz(id));

  const [answers, setAnswers] = useState<AnswerMap>({});
  const [verdicts, setVerdicts] = useState<VerdictMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [attempt, setAttempt] = useState<ServerAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptOffline, setAttemptOffline] = useState(false);
  const [cardsAdded, setCardsAdded] = useState<number | null>(null);
  const [reportFor, setReportFor] = useState<{ id: string; prompt: string } | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());

  const questions = quiz.data?.questions ?? [];
  const answeredCount = questions.filter((question) => answers[question.id]?.trim()).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;
  const pendingMarking =
    submitted &&
    attempt !== null &&
    (attempt.state === "pending_marking" || attempt.state === "marking" || attempt.state === "queued");

  const attemptDetails = useMemo(() => {
    const map = new Map<string, ServerAttemptDetails>();
    for (const detail of attempt?.details ?? []) map.set(detail.questionId, detail);
    return map;
  }, [attempt]);

  // Poll the AI marker while short answers are being graded.
  useEffect(() => {
    if (!pendingMarking || !attempt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      try {
        const next = await api.study.attempt(attempt!.id);
        if (cancelled) return;
        setAttempt(next);
        if (next.state === "pending_marking" || next.state === "marking") {
          timer = setTimeout(() => void tick(), 4000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => void tick(), 6000);
      }
    }
    timer = setTimeout(() => void tick(), 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMarking, attempt?.id, attempt?.state]);

  function verdictFor(question: ServerQuizQuestion): boolean | null {
    const detail = attemptDetails.get(question.id);
    if (detail && typeof detail.verdict === "boolean") return detail.verdict;
    if (typeof verdicts[question.id] === "boolean") return verdicts[question.id];
    return null;
  }

  function pick(question: ServerQuizQuestion, option: string) {
    if (submitted) return;
    setAnswers((current) => ({ ...current, [question.id]: option }));
    if (question.type !== "short_answer") {
      setVerdicts((current) => ({ ...current, [question.id]: option === question.answer }));
    }
  }

  async function submit() {
    if (!quiz.data || !allAnswered || busy) return;
    setBusy(true);
    setError(null);
    setCardsAdded(null);
    setSubmitted(true);
    const details = questions.map((question) => ({
      questionId: question.id,
      answer: answers[question.id]?.trim() || undefined,
      ...(question.type === "short_answer"
        ? {}
        : { verdict: Boolean(verdicts[question.id]) }),
    }));
    const payload = {
      id: crypto.randomUUID(),
      quizId: quiz.data.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      total: questions.length,
      details,
    };
    try {
      const result = await api.study.submitAttempt(payload);
      setAttempt(result.attempt);
      setAttemptOffline(false);
    } catch {
      // The local verdicts still make a useful result screen if the API is
      // unavailable; short answers simply stay unmarked.
      setAttempt({
        id: payload.id,
        state: "marked",
        correct: details.filter((entry) => entry.verdict === true).length,
        total: questions.length,
        details: details.map((entry) => ({
          questionId: entry.questionId,
          answer: entry.answer,
          verdict: entry.verdict ?? null,
        })),
      });
      setAttemptOffline(true);
    } finally {
      setBusy(false);
    }
  }

  async function makeCardsFromMistakes() {
    if (!quiz.data || busy) return;
    const wrong = questions.filter((question) => verdictFor(question) !== true);
    if (!wrong.length) return;
    setBusy(true);
    setError(null);
    let created = 0;
    for (const question of wrong) {
      const detail = attemptDetails.get(question.id);
      const back =
        question.type === "short_answer"
          ? detail?.comment || question.explanation || question.answer
          : question.answer;
      if (!question.prompt || !back) continue;
      try {
        await api.study.createCard(quiz.data.noteId, {
          id: crypto.randomUUID(),
          front: question.prompt,
          back,
        });
        created += 1;
      } catch {
        // Skip failed cards; the rest still land.
      }
    }
    setCardsAdded(created);
    setBusy(false);
  }

  function retake() {
    setAnswers({});
    setVerdicts({});
    setSubmitted(false);
    setAttempt(null);
    setError(null);
    setAttemptOffline(false);
    setCardsAdded(null);
  }

  if (quiz.error) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <ErrorState message={quiz.error} onRetry={quiz.reload} />
      </div>
    );
  }

  if (!quiz.data) {
    return (
      <div>
        <Link href="/app/study" className="back-link">
          <ArrowLeft size={16} /> Study
        </Link>
        <LoadingBlock rows={5} />
      </div>
    );
  }

  const record = quiz.data;
  const correctCount = questions.filter((question) => verdictFor(question) === true).length;
  const missed = questions.filter((question) => verdictFor(question) !== true);
  const shortCount = questions.filter((question) => question.type === "short_answer").length;
  const marked = attempt?.state === "marked";
  const markingFailed = attempt?.state === "marking_failed";

  return (
    <div className="quiz-page">
      <Link href={`/app/note/${record.noteId}`} className="back-link">
        <ArrowLeft size={16} /> {record.noteTitle || "Note"}
      </Link>

      <header className="quiz-head">
        <div>
          <p className="eyebrow-sm">{attempt ? "Result" : "Quiz"}</p>
          <h1>{record.title}</h1>
          <p>
            {questions.length} question{questions.length === 1 ? "" : "s"}
            {shortCount ? ` · ${shortCount} short answer${shortCount === 1 ? "" : "s"} marked by Sua` : ""}
          </p>
        </div>
        {!submitted ? (
          <Chip tone={allAnswered ? "success" : "muted"}>
            {answeredCount}/{questions.length} answered
          </Chip>
        ) : pendingMarking ? (
          <Chip tone="info">
            <Loader2 size={12} className="spin" /> Marking
          </Chip>
        ) : marked ? (
          <Chip tone={correctCount === questions.length ? "success" : "warning"}>
            {correctCount}/{questions.length} correct
          </Chip>
        ) : markingFailed ? (
          <Chip tone="danger">Marking failed</Chip>
        ) : null}
      </header>

      {!submitted ? (
        <ProgressBar value={(answeredCount / Math.max(1, questions.length)) * 100} label="Quiz progress" />
      ) : null}

      {error ? <Alert title="Could not finish that">{error}</Alert> : null}
      {attemptOffline ? (
        <Alert tone="warning" title="The result was not saved">
          Sua could not reach the marker, so this score is on this screen only. Try submitting again
          when you are back online.
        </Alert>
      ) : null}

      {submitted && attempt ? (
        <Card className={`quiz-result ${marked ? (missed.length ? "is-mixed" : "is-perfect") : ""}`}>
          <div className="quiz-result-score">
            <strong>
              {correctCount}
              <span>/{questions.length}</span>
            </strong>
            <span>{marked ? "correct" : "marking…"}</span>
          </div>
          <div className="quiz-result-copy">
            <h2>
              {pendingMarking
                ? "Sua is marking your short answers"
                : marked
                  ? missed.length === 0
                    ? "Clean sweep. That material is solid."
                    : missed.length === 1
                      ? "One question to revisit."
                      : `${missed.length} questions to revisit.`
                  : "Marking did not finish"}
            </h2>
            <p>
              {pendingMarking
                ? "This usually takes a few seconds. The page updates when the marker is done."
                : marked
                  ? missed.length
                    ? "Read the explanation under each missed question, then turn them into flashcards."
                    : "Take the deck for a review while it is fresh."
                  : attempt.error || "Open the quiz again and resubmit when you are online."}
            </p>
            {marked ? (
              <div className="quiz-result-actions">
                {missed.length ? (
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={() => void makeCardsFromMistakes()}
                    icon={<Plus size={16} />}
                  >
                    Make cards from mistakes
                  </Button>
                ) : null}
                <Link href={`/app/deck/${record.noteId}`} className="btn btn-primary btn-md">
                  Open deck <ChevronRight size={15} />
                </Link>
                <Button variant="ghost" onClick={retake} icon={<RotateCcw size={15} />}>
                  Retake
                </Button>
              </div>
            ) : null}
            {cardsAdded !== null ? (
              <p className="quiz-result-note">
                {cardsAdded > 0
                  ? `${cardsAdded} card${cardsAdded === 1 ? "" : "s"} added to the deck and scheduled for review.`
                  : "No new cards were added — those questions may already be in the deck."}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <ol className="quiz-list">
        {questions.map((question, index) => {
          const answer = answers[question.id] ?? "";
          const verdict = verdictFor(question);
          const detail = attemptDetails.get(question.id);
          const revealed = submitted && (question.type === "short_answer" ? marked : true);
          const options =
            question.type === "true_false" ? ["True", "False"] : question.options ?? [];
          return (
            <li key={question.id}>
              <Card className={`quiz-question ${revealed ? (verdict ? "is-correct" : "is-wrong") : ""}`}>
                <div className="quiz-question-head">
                  <span className="quiz-question-number">{index + 1}</span>
                  <div>
                    <p className="quiz-question-type">
                      {question.type === "mcq"
                        ? "Multiple choice"
                        : question.type === "true_false"
                          ? "True or false"
                          : "Short answer"}
                    </p>
                    <h2>{question.prompt}</h2>
                  </div>
                  <ReportButton
                    compact
                    label={`Report a mistake in question ${index + 1}`}
                    onClick={() => setReportFor({ id: question.id, prompt: question.prompt })}
                  />
                </div>

                {question.type === "short_answer" ? (
                  <>
                    <TextArea
                      value={answer}
                      onChange={(event) =>
                        setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                      }
                      placeholder="Type your answer…"
                      rows={3}
                      disabled={submitted}
                      aria-label={`Answer for question ${index + 1}`}
                    />
                    {!submitted ? (
                      <p className="quiz-question-hint">
                        Sua marks short answers with feedback once you submit the quiz.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="quiz-options" role="radiogroup" aria-label={`Question ${index + 1} options`}>
                    {options.map((option, position) => {
                      const picked = answer === option;
                      const isAnswer = option === question.answer;
                      const className = revealed
                        ? isAnswer
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
                          role="radio"
                          aria-checked={picked}
                          disabled={submitted}
                          className={`quiz-option ${className}`}
                          onClick={() => pick(question, option)}
                        >
                          <span className="quiz-option-key">
                            {question.type === "true_false"
                              ? option.charAt(0)
                              : String.fromCharCode(65 + position)}
                          </span>
                          <span>{option}</span>
                          {revealed && isAnswer ? <Check size={16} /> : null}
                          {revealed && picked && !isAnswer ? <X size={16} /> : null}
                        </button>
                      );
                    })}
                  </div>
                )}

                {revealed ? (
                  <div className={`quiz-verdict ${verdict ? "is-correct" : "is-wrong"}`}>
                    <p className="quiz-verdict-head">
                      {verdict ? (
                        <>
                          <Check size={16} /> Correct
                        </>
                      ) : (
                        <>
                          <CircleAlert size={16} /> {detail?.partial ? "Partially correct" : "Not quite"}
                        </>
                      )}
                    </p>
                    {question.type === "short_answer" && detail?.comment ? (
                      <p className="quiz-verdict-comment">{detail.comment}</p>
                    ) : null}
                    <p>
                      <strong>Answer:</strong> {question.answer}
                    </p>
                    {question.explanation ? <p>{question.explanation}</p> : null}
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>

      {pendingMarking ? (
        <Card className="quiz-marking">
          <span className="quiz-marking-icon">
            <Sparkles size={20} />
          </span>
          <div>
            <h2>Marking your short answers</h2>
            <p>Sua reads each answer against the note. The score updates automatically.</p>
          </div>
          <Loader2 size={20} className="spin" aria-label="Marking" />
        </Card>
      ) : null}

      {!submitted ? (
        <div className="quiz-submit">
          <p>
            {allAnswered
              ? shortCount
                ? "Short answers are sent to Sua for marking when you submit."
                : "All questions answered. Your score is ready."
              : `Answer every question to finish. ${questions.length - answeredCount} left.`}
          </p>
          <Button size="lg" disabled={!allAnswered} busy={busy} onClick={() => void submit()}>
            <Flag size={17} /> Submit quiz
          </Button>
        </div>
      ) : null}

      <ReportMistake
        open={Boolean(reportFor)}
        onClose={() => setReportFor(null)}
        noteId={record.noteId}
        targetType="quiz_question"
        targetId={reportFor?.id}
        sourceText={record.noteTitle}
        label={reportFor?.prompt}
      />
    </div>
  );
}
