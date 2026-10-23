import NetInfo from "@react-native-community/netinfo";
import {
  countPendingUploads,
  getNote,
  listGenerationQueue,
  pullCourseNotes,
  setNoteAiState,
  storeStudySet,
  updateGeneration,
} from "./notes";
import { jobsApi, studyApi } from "./api";
import { showStudyReady } from "./notifications";
import type { SQLiteDatabase } from "expo-sqlite";

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

async function pullStudySet(deps: DrainDeps, noteId: string) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  const study = await studyApi.forNote(token, noteId);
  await storeStudySet(deps.db, noteId, {
    flashcards: study.flashcards,
    quizzes: study.quizzes.map((quiz) => ({
      id: quiz.id,
      title: quiz.title,
      questions: quiz.questions,
    })),
  });
  await setNoteAiState(deps.db, noteId, "ready");
  showStudyReady("Your study set is ready");
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

async function runOne(
  deps: DrainDeps,
  itemName: {
    id: number;
    noteId: string;
    kind: "study_set" | "course_reference";
    jobId: string | null;
  },
) {
  const token = await deps.getAuthToken();
  if (!token) throw new Error("no auth token");
  await updateGeneration(deps.db, itemName.id, { state: "active" });
  await setNoteAiState(deps.db, itemName.noteId, "queued");

  // Submit unless the job row already exists (a resumed poll).
  let jobId = itemName.jobId;
  if (!jobId) {
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
    if (job.state === "done") {
      await updateGeneration(deps.db, itemName.id, { state: "done", jobId });
      if (itemName.kind === "course_reference") {
        await finishReference(deps, itemName.noteId);
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
}

export async function drainGenerationQueue({ db, getAuthToken, onNoteChange }: DrainDeps) {
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
    // Recordings generate against transcribed audio, so their job must wait
    // until every segment is on the server. Leave the row queued; finishing
    // uploads (or the next reconnect/foreground tick) re-triggers the drain.
    const note = await getNote(db, item.noteId).catch(() => null);
    if (note?.sourceType === "audio" && (await countPendingUploads(db, item.noteId)) > 0) {
      continue;
    }
    try {
      await runOne({ db, getAuthToken, onNoteChange }, item);
      drained += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = /not found|unauthor/i.test(message); // server-side permanent rejects
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
