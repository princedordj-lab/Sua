"use client";

import { useState } from "react";
import { Flag, Send } from "lucide-react";
import { Alert, Button, Modal, TextArea } from "@/components/ui";
import { useApi } from "@/lib/use-api";

type Target = "summary" | "flashcard" | "quiz_question" | "transcript";

/**
 * Report-a-mistake dialog shared by the note summary, flashcards and quiz
 * questions. Posts to `/api/jobs/feedback` with the source text so the report
 * can be reviewed without the student pasting anything else.
 */
export function ReportMistake({
  open,
  onClose,
  noteId,
  targetType,
  targetId,
  sourceText,
  label,
}: {
  open: boolean;
  onClose: () => void;
  noteId: string;
  targetType: Target;
  targetId?: string;
  sourceText?: string | null;
  label?: string;
}) {
  const api = useApi();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    onClose();
    setComment("");
    setSent(false);
    setError(null);
  }

  async function send() {
    if (!comment.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.jobs.feedback({
        targetType,
        targetId,
        noteId,
        comment: comment.trim(),
        sourceText: sourceText ?? undefined,
      });
      setSent(true);
      setComment("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Report a mistake"
      description="Tell us what Sua got wrong — it helps improve the next generation."
      footer={
        sent ? (
          <Button variant="secondary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              busy={busy}
              disabled={!comment.trim()}
              onClick={() => void send()}
              icon={!busy ? <Send size={16} /> : undefined}
            >
              Send report
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <Alert tone="success" title="Thanks — report sent.">
          We read every report and use it to improve the notes, cards and quizzes Sua writes.
        </Alert>
      ) : (
        <>
          {error ? <Alert title="Could not send the report">{error}</Alert> : null}
          {label ? <p className="report-target">{label}</p> : null}
          <TextArea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What was wrong? e.g. the formula in Key Terms is missing a square."
            rows={4}
            aria-label="Report comment"
          />
        </>
      )}
    </Modal>
  );
}

export function ReportButton({
  onClick,
  label = "Report a mistake",
  compact = false,
}: {
  onClick: () => void;
  label?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`report-button ${compact ? "is-compact" : ""}`}
      aria-label={label}
      title={label}
    >
      <Flag size={14} aria-hidden="true" />
      {compact ? null : <span>{label}</span>}
    </button>
  );
}
