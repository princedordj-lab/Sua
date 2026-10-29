import NetInfo from "@react-native-community/netinfo";
import {
  countPendingUploads,
  getNote,
  isNotePendingSync,
  listGenerationQueue,
  listNotesMissingStudySet,
  pullCourseNotes,
  removeGenerationQueueItem,
  setNoteAiState,
  setNoteSummary,
  storeStudySet,
  syncPendingNotes,
  updateGeneration,
  type Note as NoteRow,
} from "./notes";
import { jobsApi, studyApi } from "./api";
import { showStudyReady } from "./notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import type { AiState, GenerationKind, JobMeta } from "./types";

/**
 * Local-first generation requests.
 *
 * enqueueGeneration() writes a SQLite queue row immediately (the note's
 * ai_state becomes "queued", offline-friendly). drainGenerationQueue() runs
 * whenever connectivity returns or the app foregrounds, mirroring the upload
 * queue drain: it POSTs /jobs, then polls the job until it completes, and
 * finally pulls the outputs locally.
 *
 * Polling is bounded (about 50 x 4s = ~3.5 min per drain pass, enough for a
 * full transcription + generation); a still-running job is left "active" and
 * resumes on the next connectivity/foreground tick.
 *
 * Two server outcomes exist:
 * - study_set: summary/flashcards/quiz come back from /study.
 * - course_reference: the AI-written page is the note body — pull the note
 *   itself and mark ready (there is no study set to cache).
 */

type DrainDeps = {
  db: SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
  onNoteChange?: (noteId: string) => void;
};

/**
 * The one line every failure path ends on. Mirrors USER_MESSAGES.generic in
 * backend/src/config/ai-pipeline.js: a failed run never costs an allowance, so
 * the copy invites a retry and says so.
 */
export const GENERIC_FAILURE =
  "Something went wrong. Tap to try again. This didn't use your monthly allowance.";

// Messages the app may show verbatim. Anything else (a raw provider error, a
// stack line, "Note not found") is replaced by GENERIC_FAILURE before it is
// stored or rendered.
const USER_FACING_MESSAGES = [
  GENERIC_FAILURE,
  "Couldn't read this file. Try a clearer photo or a text PDF.",
  "Couldn't read text from this file. Try a clearer PDF or re-upload.",
  "This .ppt file can't be parsed. Save it as .pptx and upload again.",
  "This file took too long to process. Tap Try again — finished pages are kept.",
  "Too many parts of this file could not be processed. Tap Try again, or upload it by chapter.",
  "This file is too long for one reference sheet. Upload it by chapter.",
  "There isn't enough text here to study yet. Add a bit more and try again.",
  "Could not connect to Sua. Check your internet connection.",
  "Something went wrong on the server. Please try again.",
  "Note is syncing with the server. Please wait a moment.",
  "This note is a course reference; only the reference can be regenerated.",
];

export function userFacingMessage(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return GENERIC_FAILURE;
  return USER_FACING_MESSAGES.includes(value) ? value : GENERIC_FAILURE;
}

const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 50;
// A note whose upload never lands keeps the generation gated (the server must
// have the file). Give that wait a ceiling so the card cannot say "waiting"
// for a whole day; the failed card then offers "View uploads".
const UPLOAD_WAIT_MS = 15 * 60_000;
const activeDrains = new WeakMap<SQLiteDatabase, Promise<number>>();

async function pullStudySet(
  deps: DrainDeps,
  noteId: string,
  { notify = true }: { notify?: boolean } = {},
) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  // The note can be deleted (here or on another device) between the job
  // finishing and this pull; never recreate cards for a row that is gone.
  if (!(await getNote(deps.db, noteId).catch(() => null))) return;
  const study = await studyApi.forNote(token, noteId);
  // Keep the server summary in step even when only the cards were missing.
  if (study.summaryMarkdown) {
    await setNoteSummary(deps.db, noteId, study.summaryMarkdown);
  }
  await storeStudySet(deps.db, noteId, {
    flashcards: study.flashcards,
    quizzes: study.quizzes.map((quiz) => ({
      id: quiz.id,
      title: quiz.title,
      questions: quiz.questions,
    })),
  });
  await setNoteAiState(deps.db, noteId, "ready");
  if (notify) showStudyReady("Your study set is ready");
  deps.onNoteChange?.(noteId);
}

async function finishReference(deps: DrainDeps, noteId: string) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  // The reference markdown is the note body on the server; pull the course so
  // the local note picks it up before the screen reads aiState.
  const note = await getNote(deps.db, noteId);
  if (note) {
    await pullCourseNotes(deps.db, token, note.courseId).catch(() => {});
  }
  await setNoteAiState(deps.db, noteId, "ready");
  showStudyReady("Your course reference is ready");
  deps.onNoteChange?.(noteId);
}

async function finishLectureNote(deps: DrainDeps, noteId: string) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  // A lecture note writes both halves: the body (pull the note) and the study
  // set (pull the cards/quiz), otherwise the deck and quiz show 0.
  const note = await getNote(deps.db, noteId);
  if (note) {
    await pullCourseNotes(deps.db, token, note.courseId).catch(() => {});
  }
  await pullStudySet(deps, noteId, { notify: false });
  showStudyReady("Your lecture note is ready");
  await setNoteAiState(deps.db, noteId, "ready");
  deps.onNoteChange?.(noteId);
}

/**
 * Which server job a note should request next. Explicit last choice wins;
 * otherwise every capture gets a full note. Typed notes are no longer treated
 * as "just a summary": the original wording is kept in transcript, so a
 * lecture_note is safe and gives the student a cleaner, structured version.
 */
export function generationKindFor(
  note: Pick<NoteRow, "noteKind" | "sourceType"> | null,
  lastKind?: GenerationKind | null,
): GenerationKind {
  if (note?.noteKind === "reference") return "course_reference";
  if (lastKind) return lastKind;
  return "lecture_note";
}

/** Stages during which the note is still being worked on. */
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

/**
 * One sentence for every pipeline stage. Shared by the note screen and the
 * capture screen so the two never disagree about what Sua is doing.
 * `progress` ({ done, total }) comes from the server's long-file counter and
 * renders as "Reading pages 41 of 212…" for big documents.
 */
export function aiStageLabel(
  state: AiState,
  kind: GenerationKind,
  {
    pendingUploads = 0,
    sourceType,
    progress,
  }: {
    pendingUploads?: number;
    sourceType?: NoteRow["sourceType"];
    progress?: { done: number; total: number } | null;
  } = {},
): string {
  const progressSuffix =
    progress && progress.total > 1 && progress.done > 0
      ? ` (${Math.min(progress.done, progress.total)} of ${progress.total})`
      : "";
  switch (state) {
    case "queued":
      return pendingUploads > 0 && sourceType !== "typed"
        ? "Waiting for your upload to finish…"
        : "Waiting to start…";
    case "reading":
      return (kind === "course_reference"
        ? "Reading your material…"
        : "Reading and taking in your material…") + progressSuffix;
    case "reading_scans":
      return "Reading pages from the scan…" + progressSuffix;
    case "digesting":
      return "Pulling out the important parts…" + progressSuffix;
    case "merging":
      // Long-file reduce stage. The server's counter still counts digest
      // groups, so no "(x of y)" here — it would describe a different unit.
      return "Combining the important parts…";
    case "writing":
      return (kind === "course_reference"
        ? "Writing your reference sheet…"
        : "Writing your study notes…") + progressSuffix;
    case "checking":
      return "Checking every number against your source…";
    case "summarising":
      return "Writing your summary…";
    case "making_cards":
      return "Making flashcards and a quiz…";
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

/**
 * What the AI actually read, for the line under a note's title. Falls back to
 * the note's own source type when the job metadata isn't on the device yet.
 */
export function sourceMetaFor(
  note: Pick<NoteRow, "sourceType"> | null,
  meta: JobMeta | null,
): SourceSummary | null {
  if (!note) return null;
  const sourceType =
    meta?.sourceType ??
    (note.sourceType === "audio"
      ? "recording"
      : note.sourceType === "file"
        ? "file"
        : "typed");
  const source =
    sourceType === "recording"
      ? "Recording"
      : sourceType === "file"
        ? "Document"
        : "Typed note";
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

/**
 * Push this note before asking the server to work on it. POST /jobs answers
 * 404 for a note the server has never seen, and that 404 used to be swallowed
 * into a silent retry loop, so check the acknowledgement instead of assuming
 * the push worked.
 */
async function pushNoteOrThrow(deps: DrainDeps, token: string, noteId: string) {
  try {
    await syncPendingNotes(deps.db, token);
  } catch {
    // A previous pass may still have delivered it; the check below decides.
  }
  if (await isNotePendingSync(deps.db, noteId)) {
    throw new Error(GENERIC_FAILURE);
  }
}

/**
 * The note vanished while a request was in flight (deleted on another device).
 * The queue row goes with it; nothing must be retried or mirrored.
 */
async function dropQueueForGoneNote(deps: DrainDeps, itemId: number, noteId: string) {
  const note = await getNote(deps.db, noteId).catch(() => null);
  if (note) return false;
  await removeGenerationQueueItem(deps.db, itemId).catch(() => {});
  return true;
}

function isNotFound(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}

async function runOne(
  deps: DrainDeps,
  itemName: {
    id: number;
    noteId: string;
    kind: GenerationKind;
    jobId: string | null;
  },
) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  // A note can be deleted while an earlier drain is waiting for the network.
  // Do not submit or mirror work for a queue row whose note no longer exists.
  if (!(await getNote(deps.db, itemName.noteId).catch(() => null))) {
    await removeGenerationQueueItem(deps.db, itemName.id).catch(() => {});
    return false;
  }
  await updateGeneration(deps.db, itemName.id, { state: "active" });
  await setNoteAiState(deps.db, itemName.noteId, "queued");

  // Submit unless the job row already exists (a resumed poll).
  let jobId = itemName.jobId;
  if (!jobId) {
    // The server cannot accept a job for a note it has never seen, so the note
    // is pushed (and acknowledged) before the request goes out.
    await pushNoteOrThrow(deps, token, itemName.noteId);
    let job;
    try {
      job = await jobsApi.create(token, itemName.noteId, itemName.kind);
    } catch (error) {
      // A delete that landed on the server first answers 404; the note is
      // gone, so the request is moot rather than retryable.
      if (isNotFound(error) && (await dropQueueForGoneNote(deps, itemName.id, itemName.noteId))) {
        return false;
      }
      throw error;
    }
    if (!job) throw new Error(GENERIC_FAILURE);
    // The server closes a job when it cannot queue it (worker/Redis down). That
    // is a real failure, not something to poll for three minutes.
    if (job.state === "failed") throw new Error(userFacingMessage(job.error));
    jobId = job.id;
    await updateGeneration(deps.db, itemName.id, {
      state: "active",
      jobId,
    });
  }

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    let job;
    try {
      job = await jobsApi.get(token, jobId);
    } catch (error) {
      // The job row cascades away with a deleted note.
      if (isNotFound(error) && (await dropQueueForGoneNote(deps, itemName.id, itemName.noteId))) {
        return false;
      }
      throw error;
    }
    if (!(await getNote(deps.db, itemName.noteId).catch(() => null))) {
      await removeGenerationQueueItem(deps.db, itemName.id).catch(() => {});
      return false;
    }
    if (job.state === "done") {
      await updateGeneration(deps.db, itemName.id, { state: "done", jobId });
      if (itemName.kind === "course_reference") {
        await finishReference(deps, itemName.noteId);
      } else if (itemName.kind === "lecture_note") {
        await finishLectureNote(deps, itemName.noteId);
      } else {
        await pullStudySet(deps, itemName.noteId);
      }
      return;
    }
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(userFacingMessage(job.error));
    }
    // Mirror the pipeline stage into the note so the UI updates live.
    await setNoteAiState(deps.db, itemName.noteId, job.stage);
    deps.onNoteChange?.(itemName.noteId);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return true;
}

async function drainGenerationQueueNow({ db, getAuthToken, onNoteChange }: DrainDeps) {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return 0;
  const queue = await listGenerationQueue(db);
  let drained = 0;
  for (const item of queue) {
    if (item.attempts >= MAX_ATTEMPTS) {
      await updateGeneration(db, item.id, { state: "failed", error: GENERIC_FAILURE });
      await setNoteAiState(db, item.noteId, "failed");
      onNoteChange?.(item.noteId);
      continue;
    }
    // Conversion jobs read the uploaded asset, so they must wait until every
    // queued upload for the note is on the server — for files and photos too,
    // not just audio. Leave the row queued; the upload flush (or the next
    // reconnect/foreground tick) re-triggers the drain. The wait is capped so a
    // stuck upload cannot keep the card "waiting" indefinitely.
    const note = await getNote(db, item.noteId).catch(() => null);
    if (!note) {
      await removeGenerationQueueItem(db, item.id).catch(() => {});
      continue;
    }
    if ((await countPendingUploads(db, item.noteId)) > 0) {
      const waitedMs = Date.now() - Date.parse(item.updatedAt);
      if (Number.isFinite(waitedMs) && waitedMs > UPLOAD_WAIT_MS) {
        await updateGeneration(db, item.id, {
          state: "failed",
          error: GENERIC_FAILURE,
        });
        await setNoteAiState(db, item.noteId, "failed");
        onNoteChange?.(item.noteId);
      }
      continue;
    }
    try {
      if (await runOne({ db, getAuthToken, onNoteChange }, item)) drained += 1;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // Classify before normalising: the shown copy is allowlisted, but a
      // permanent reject (auth, a reference that only accepts references, a
      // note the server does not have) must not burn three retry passes.
      const fatal =
        /unauthor|forbidden|not signed|course reference|not found/i.test(raw);
      const message = userFacingMessage(raw);
      const nextAttempts = item.attempts + 1;
      await updateGeneration(db, item.id, {
        state: fatal || nextAttempts >= MAX_ATTEMPTS ? "failed" : "queued",
        error: message,
        bumpAttempts: true,
      });
      if (fatal || nextAttempts >= MAX_ATTEMPTS) {
        await setNoteAiState(db, item.noteId, "failed");
        onNoteChange?.(item.noteId);
      }
    }
  }
  return drained;
}

// Screens, reconnect listeners, and foreground refreshes can all request a
// drain at once. Share one in-flight pass per database so a retry cannot race
// the periodic worker over the same SQLite queue rows.
export function drainGenerationQueue(deps: DrainDeps) {
  const active = activeDrains.get(deps.db);
  if (active) return active;

  const drain = drainGenerationQueueNow(deps);
  activeDrains.set(deps.db, drain);
  const clearActiveDrain = () => {
    if (activeDrains.get(deps.db) === drain) activeDrains.delete(deps.db);
  };
  void drain.then(clearActiveDrain, clearActiveDrain);
  return drain;
}

/**
 * Missed outputs reconcile: upload-triggered conversions run entirely on the
 * server (there is no local queue row), so the device learns about them by
 * pulling notes. This fetches any study set that finished server-side but was
 * never cached here (cards/quiz would otherwise stay at zero).
 */
export async function reconcileAiOutputs({
  db,
  getAuthToken,
  onNoteChange,
}: DrainDeps) {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return 0;
  const token = await getAuthToken();
  if (!token) return 0;
  const notes = await listNotesMissingStudySet(db).catch(() => []);
  let pulled = 0;
  for (const note of notes) {
    try {
      await pullStudySet({ db, getAuthToken, onNoteChange }, note.id, {
        notify: false,
      });
      pulled += 1;
    } catch {
      // Still generating, or the note has no study set (a reference) — the
      // next pass retries. Never let reconciliation fail a screen load.
    }
  }
  return pulled;
}

/**
 * Mirror the server job for a single note. Used while a note is active but has
 * no local queue row (an upload conversion), so stages and the finished body
 * appear without waiting for the next full hydration pass.
 */
export async function refreshNoteFromServer(
  { db, getAuthToken }: Pick<DrainDeps, "db" | "getAuthToken">,
  noteId: string,
) {
  const token = await getAuthToken();
  if (!token) return null;
  const job = await jobsApi.latestForNote(token, noteId).catch(() => null);
  if (!job) return null;

  if (job.state === "done") {
    const note = await getNote(db, noteId).catch(() => null);
    if (note) {
      await pullCourseNotes(db, token, note.courseId).catch(() => {});
      if (note.noteKind !== "reference") {
        // No local notification: the pipeline already sent a push.
        await pullStudySet({ db, getAuthToken }, noteId, { notify: false }).catch(
          () => {},
        );
      }
    }
    await setNoteAiState(db, noteId, "ready");
  } else if (job.state === "failed" || job.state === "cancelled") {
    await setNoteAiState(db, noteId, "failed");
  } else if (job.stage) {
    await setNoteAiState(db, noteId, job.stage);
  }
  return job;
}
