import type { AiState, GenerationKind, JobMeta, ServerNote } from "./types";

/**
 * Which generation a note should (re)run. References always regenerate as a
 * reference; typed notes keep their own text and get a study set around it;
 * recordings and uploads become full lecture notes. Mirrors mobile's
 * `generationKindFor` plus the typed-save default in `create.tsx`.
 */
export function generationKindFor(
  note: Pick<ServerNote, "noteKind" | "sourceType"> | null,
): GenerationKind {
  if (note?.noteKind === "reference") return "course_reference";
  if (note?.sourceType === "typed") return "study_set";
  return "lecture_note";
}

export const AI_ACTIVE_STATES: ReadonlySet<AiState> = new Set<AiState>([
  "queued",
  "reading",
  "reading_scans",
  "digesting",
  "merging",
  "writing",
  "checking",
  "summarising",
  "making_cards",
]);

export function isAiActive(state: AiState | null | undefined): boolean {
  return state ? AI_ACTIVE_STATES.has(state) : false;
}

/** One sentence per pipeline stage, shared by the note, create and job screens.
 * `progress` ({ done, total }) is the server's long-file page counter and
 * renders as "Reading pages 41 of 212…" for big documents. */
export function aiStageLabel(
  state: AiState,
  kind: GenerationKind,
  {
    sourceType,
    progress,
  }: {
    sourceType?: ServerNote["sourceType"];
    progress?: { done: number; total: number } | null;
  } = {},
): string {
  const progressSuffix =
    progress && progress.total > 1 && progress.done > 0
      ? ` (${Math.min(progress.done, progress.total)} of ${progress.total})`
      : "";
  switch (state) {
    case "queued":
      return sourceType && sourceType !== "typed"
        ? "Waiting for your upload to finish…"
        : "Waiting to start…";
    case "reading":
      return (
        (kind === "course_reference"
          ? "Reading your material…"
          : "Reading and taking in your material…") + progressSuffix
      );
    case "reading_scans":
      return "Reading pages from the scan…" + progressSuffix;
    case "digesting":
      return "Pulling out the important parts…" + progressSuffix;
    case "merging":
      // Long-file reduce stage; the server counter is in digest groups, so no
      // "(x of y)" suffix here.
      return "Combining the important parts…";
    case "writing":
      return (
        (kind === "course_reference"
          ? "Writing your reference sheet…"
          : "Writing your study notes…") + progressSuffix
      );
    case "checking":
      return "Checking every number against your source…";
    case "summarising":
      return "Writing your summary…";
    case "making_cards":
      return "Making flashcards and a quiz…";
    case "marking":
      return "Marking your quiz…";
    default:
      return "";
  }
}

export type SourceSummary = {
  source: "Recording" | "Document" | "Typed note";
  read: string | null;
  truncated: boolean;
  checkFailed: boolean;
};

export function sourceMetaFor(
  note: Pick<ServerNote, "sourceType"> | null,
  meta: JobMeta | null,
): SourceSummary | null {
  if (!note) return null;
  const sourceType =
    meta?.sourceType ??
    (note.sourceType === "audio" ? "recording" : note.sourceType === "file" ? "file" : "typed");
  const source: SourceSummary["source"] =
    sourceType === "recording" ? "Recording" : sourceType === "file" ? "Document" : "Typed note";
  const pages = meta?.pagesUsed ?? 0;
  const minutes = meta?.minutes ?? 0;
  const read =
    sourceType === "recording" && minutes > 0
      ? `${minutes} min recording`
      : pages > 1
        ? `${pages} pages read`
        : null;
  return {
    source,
    read,
    truncated: Boolean(meta?.truncated),
    checkFailed: meta?.checkPassed === false,
  };
}

export const GENERIC_FAILURE =
  "Something went wrong. Try again. This didn’t use your monthly allowance.";
