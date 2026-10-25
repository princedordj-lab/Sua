import NetInfo from "@react-native-community/netinfo";
import {
  countPendingUploads,
  getNote,
  listGenerationQueue,
  listNotesMissingStudySet,
  pullCourseNotes,
  setNoteAiState,
  setNoteSummary,
  storeStudySet,
  syncPendingNotes,
  updateGeneration,
  type Note,
} from "./notes";
import { jobsApi, studyApi } from "./api";
import { showStudyReady } from "./notifications";
import type { SQLiteDatabase } from "expo-sqlite";
import type { GenerationKind } from "./types";

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

const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 50;
const activeDrains = new WeakMap<SQLiteDatabase, Promise<number>>();

async function pullStudySet(
  deps: DrainDeps,
  noteId: string,
  { notify = true }: { notify?: boolean } = {},
) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
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
 * otherwise audio/file captures get a full note and typed notes keep their
 * own text and only get a study set.
 */
export function generationKindFor(
  note: Pick<Note, "noteKind" | "sourceType"> | null,
  lastKind?: GenerationKind | null,
): GenerationKind {
  if (note?.noteKind === "reference") return "course_reference";
  if (lastKind) return lastKind;
  return note?.sourceType === "typed" ? "study_set" : "lecture_note";
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
  // A note can be deleted while an earlier drain is waiting for the network.
  // Do not submit or mirror work for a queue row whose note no longer exists.
  if (!(await getNote(deps.db, itemName.noteId).catch(() => null))) return false;
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  if (!(await getNote(deps.db, itemName.noteId).catch(() => null))) return false;
  await updateGeneration(deps.db, itemName.id, { state: "active" });
  await setNoteAiState(deps.db, itemName.noteId, "queued");

  // Submit unless the job row already exists (a resumed poll).
  let jobId = itemName.jobId;
  if (!jobId) {
    // The server cannot accept a job for a note it has never seen. Push the
    // sync queue first, exactly like the upload queue does (AGENTS.md ordering).
    await syncPendingNotes(deps.db, token).catch(() => {});
    const job = await jobsApi.create(token, itemName.noteId, itemName.kind);
    if (!job) throw new Error("generation request was not accepted");
    jobId = job.id;
    await updateGeneration(deps.db, itemName.id, {
      state: "active",
      jobId,
    });
  }

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const job = await jobsApi.get(token, jobId);
    if (!(await getNote(deps.db, itemName.noteId).catch(() => null))) return false;
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
    if (job.state === "failed") {
      throw new Error(job.error ?? "generation failed");
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
      await updateGeneration(db, item.id, { state: "failed", error: "Too many attempts" });
      await setNoteAiState(db, item.noteId, "failed");
      continue;
    }
    // Conversion jobs read the uploaded asset, so they must wait until every
    // queued upload for the note is on the server — for files and photos too,
    // not just audio. Leave the row queued; the upload flush (or the next
    // reconnect/foreground tick) re-triggers the drain.
    const note = await getNote(db, item.noteId).catch(() => null);
    if (!note) continue;
    if ((await countPendingUploads(db, item.noteId)) > 0) {
      continue;
    }
    try {
      if (await runOne({ db, getAuthToken, onNoteChange }, item)) drained += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = /unauthor|forbidden|not signed/i.test(message); // server-side permanent rejects
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
  } else if (job.state === "failed") {
    await setNoteAiState(db, noteId, "failed");
  } else if (job.stage) {
    await setNoteAiState(db, noteId, job.stage);
  }
  return job;
}
