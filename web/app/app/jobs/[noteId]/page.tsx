"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CircleDashed,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Alert, Button, Card, Chip, ErrorState, LoadingBlock, ProgressBar } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { aiStageLabel, GENERIC_FAILURE, generationKindFor, isAiActive } from "@/lib/generation";
import { isReading, readingLabel } from "@/lib/extract";
import type { AiState, ServerJob, ServerNote } from "@/lib/types";

const STAGES: { key: AiState; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "reading", label: "Reading your material" },
  { key: "reading_scans", label: "Reading scans" },
  { key: "digesting", label: "Pulling out the important parts" },
  { key: "writing", label: "Writing your notes" },
  { key: "checking", label: "Checking numbers" },
  { key: "summarising", label: "Summarising" },
  { key: "making_cards", label: "Making cards and quiz" },
];

function stageIndex(stage: AiState | undefined) {
  if (!stage) return 0;
  const index = STAGES.findIndex((entry) => entry.key === stage);
  return index === -1 ? 0 : index;
}

export default function JobStatusPage() {
  const { noteId } = useParams<{ noteId: string }>();
  const api = useApi();
  const note = useResource<ServerNote>(`job-note:${noteId}`, () => api.notes.get(noteId));
  const [job, setJob] = useState<ServerJob | null>(null);
  const [loadingJob, setLoadingJob] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      let next: ServerJob | null = null;
      try {
        next = await api.jobs.forNote(noteId);
      } catch {
        next = null;
      }
      if (cancelled) return;
      setJob(next);
      setLoadingJob(false);
      if (next && (next.state === "queued" || next.state === "running")) {
        timer = setTimeout(() => void poll(), 5000);
      } else if (next && (next.state === "done" || next.state === "failed")) {
        note.reload();
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // No job exists while the API is still reading the upload; follow the note
  // row instead so the stage list advances once generation starts.
  const readingNow = isReading(note.data?.assets?.[0]?.extractState);
  const reloadNote = note.reload;
  useEffect(() => {
    if (!readingNow) return;
    const timer = setInterval(() => reloadNote(), 5000);
    return () => clearInterval(timer);
  }, [readingNow, reloadNote]);

  async function retry() {
    if (!note.data) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.jobs.enqueue(note.data.id, generationKindFor(note.data));
      setLoadingJob(true);
      const next = await api.jobs.forNote(note.data.id);
      setJob(next);
      setLoadingJob(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : GENERIC_FAILURE);
    } finally {
      setBusy(false);
    }
  }

  if (note.error) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          <ArrowLeft size={16} /> Courses
        </Link>
        <ErrorState message={note.error} onRetry={note.reload} />
      </div>
    );
  }

  if (!note.data) {
    return (
      <div>
        <Link href="/app/courses" className="back-link">
          <ArrowLeft size={16} /> Courses
        </Link>
        <LoadingBlock rows={4} />
      </div>
    );
  }

  const record = note.data;
  const kind = generationKindFor(record);
  const asset = record.assets?.[0] ?? null;
  const reading = Boolean(asset && isReading(asset.extractState)) && !job;
  const active = reading || (job ? job.state === "queued" || job.state === "running" : isAiActive(record.aiState));
  const failed = job?.state === "failed" || record.aiState === "failed";
  const done = job?.state === "done" || record.aiState === "ready";
  const stage = (job?.stage ?? record.aiState ?? "queued") as AiState;
  const currentIndex = done
    ? STAGES.length
    : reading
      ? 1
      : stageIndex(stage);
  const percent = done ? 100 : Math.min(94, Math.max(6, (currentIndex / STAGES.length) * 100));

  return (
    <div className="job-page">
      <Link href={`/app/note/${record.id}`} className="back-link">
        <ArrowLeft size={16} /> {record.title || "Note"}
      </Link>

      <Card className={`job-hero ${failed ? "is-failed" : done ? "is-done" : ""}`}>
        <span className="job-hero-icon" aria-hidden="true">
          {failed ? <TriangleAlert size={26} /> : done ? <Check size={26} /> : <Sparkles size={26} />}
        </span>
        <div className="job-hero-copy">
          <p className="eyebrow-sm">{record.noteKind === "reference" ? "Reference sheet" : "Study set"}</p>
          <h1>
            {failed
              ? "That run didn’t finish"
              : done
                ? "Your study set is ready"
                : reading && asset
                  ? readingLabel(
                      asset.extractState ?? "pending",
                      asset.extractedPages ?? 0,
                      asset.totalPages ?? 0,
                    )
                  : aiStageLabel(stage, kind, record)}
          </h1>
          <p>
            {failed
              ? job?.error || GENERIC_FAILURE
              : done
                ? "Summary, flashcards and quiz are waiting in the note."
                : reading
                  ? "Sua reads the file in the background, then writes your notes and study set. You can leave this page."
                  : "You can leave this page — the pipeline keeps running in the background."}
          </p>
          <div className="job-hero-meta">
            <Chip tone={failed ? "danger" : done ? "success" : "info"}>
              {failed ? "Failed" : done ? "Ready" : reading ? "Reading" : `Attempt ${job?.attempts ?? 1}`}
            </Chip>
            <span>{record.sourceType === "typed" ? "Typed note" : record.sourceType === "audio" ? "Recording" : "Upload"}</span>
          </div>
        </div>
      </Card>

      {actionError ? <Alert title="Could not start another run">{actionError}</Alert> : null}

      <Card className="job-panel">
        <div className="job-panel-head">
          <div>
            <h2>{failed ? "What happened" : done ? "Pipeline complete" : "Live progress"}</h2>
            <p>
              {failed
                ? "The material is safe. Try again, or edit the note if the source was thin."
                : "Sua shows each step so you know what it is doing with your notes."}
            </p>
          </div>
          {active ? <Loader2 size={20} className="spin" aria-label="Working" /> : null}
        </div>

        {!failed ? <ProgressBar value={percent} label="Pipeline progress" /> : null}

        <ol className="stage-list">
          {STAGES.map((entry, index) => {
            const state = done
              ? "is-done"
              : failed
                ? index < currentIndex
                  ? "is-done"
                  : index === currentIndex
                    ? "is-failed"
                    : ""
                : index < currentIndex
                  ? "is-done"
                  : index === currentIndex
                    ? "is-active"
                    : "";
            return (
              <li key={entry.key} className={`stage-row ${state}`}>
                <span className="stage-dot" aria-hidden="true">
                  {state === "is-done" ? (
                    <Check size={13} />
                  ) : state === "is-active" ? (
                    <Loader2 size={13} className="spin" />
                  ) : state === "is-failed" ? (
                    <TriangleAlert size={13} />
                  ) : (
                    <CircleDashed size={13} />
                  )}
                </span>
                <span>{entry.label}</span>
                {index === currentIndex && !done && !failed ? <small>In progress</small> : null}
              </li>
            );
          })}
        </ol>

        <div className="job-actions">
          {done ? (
            <Link href={`/app/note/${record.id}`} className="btn btn-primary btn-md">
              <FileText size={17} /> Open the note
            </Link>
          ) : failed ? (
            <Button busy={busy} onClick={() => void retry()} icon={<RefreshCw size={17} />}>
              Try again
            </Button>
          ) : (
            <Link href={`/app/note/${record.id}`} className="btn btn-secondary btn-md">
              Read while it works
            </Link>
          )}
          <Link href={`/app/courses/${record.courseId}`} className="btn btn-ghost btn-md">
            Back to course
          </Link>
        </div>
      </Card>

      {loadingJob ? <p className="job-loading-note">Looking for the latest job…</p> : null}
    </div>
  );
}
