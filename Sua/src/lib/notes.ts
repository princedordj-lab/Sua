import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";
import { notesApi } from "./api";
import { nextDueMs, nextState, type CardGrade } from "./srs";
import type { GenerationKind, NoteKind, ServerNote, SyncResult } from "./types";

export type { GenerationKind, NoteKind };

export type NoteSyncState = "pending" | "synced" | "error";

export type AiState =
  | "none"
  | "queued"
  | "transcribing"
  | "summarising"
  | "making_cards"
  | "writing"
  | "ready"
  | "failed";

export type Note = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: "typed" | "audio" | "file";
  // Local-only pointer to the raw file (e.g. a recording's session id). Never synced.
  sourceRef: string | null;
  // Local-only text extracted from an uploaded file (server keeps its copy on the asset).
  transcript: string | null;
  // AI outputs on the note itself; server-owned after the pipeline writes them.
  aiState: AiState;
  summary: string | null;
  noteKind: NoteKind;
  createdAt: string;
  updatedAt: string;
  syncState: NoteSyncState;
};

export type SyncQueueItem = {
  id: number;
  entity: "note";
  entityId: string;
  operation: "upsert" | "delete";
  payload: string;
  createdAt: string;
};

// Mirror of the server Course row so an offline cold start can still list
// courses (and therefore create notes) without the API.
export type LocalCourse = {
  id: string;
  name: string;
  code: string;
  colour: string;
  lecturer: string;
  examDate: string | null;
  archived: boolean;
  updatedAt: string;
};

export type RecordingSession = {
  id: string;
  courseId: string;
  state: "in_progress" | "complete";
  segmentCount: number;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
};

export type RecordingSegment = {
  id: number;
  sessionId: string;
  segmentIndex: number;
  path: string;
  state: "active" | "finalized";
  durationMs: number;
  createdAt: string;
};

export type UploadKind = "audio" | "document" | "image";
export type UploadState = "pending" | "uploading" | "uploaded" | "failed";
export type UploadTarget = "lecture_note" | "course_reference";

export type UploadQueueItem = {
  id: number;
  noteId: string;
  kind: UploadKind;
  localPath: string;
  format: string;
  bytes: number;
  state: UploadState;
  attempts: number;
  assetId: string | null;
  // lecture_note | course_reference for documents/photos; null = plain upload.
  target: UploadTarget | null;
  // Live progress (0-100); persisted so a killed app still shows where it was.
  sentBytes: number;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function newId() {
  return Crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

// Each step must be idempotent: installs created before versioned migrations
// (user_version = 0) replay every step, and a step that throws is retried on
// the next launch because the pragma only advances after it succeeds.
const MIGRATIONS: ((db: SQLiteDatabase) => Promise<void>)[] = [
  // 1 — base schema
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL,
        course_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'typed',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS notes_course_idx ON notes(course_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
  // 2 — local-only raw file pointer on notes
  async (db) => {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!columns.some((column) => column.name === "source_ref")) {
      await db.execAsync("ALTER TABLE notes ADD COLUMN source_ref TEXT");
    }
  },
  // 3 — offline course cache + key/value settings
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        colour TEXT NOT NULL DEFAULT '#7C5CFC',
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
  },
  // 4 — extracted source text for uploaded files
  async (db) => {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!columns.some((column) => column.name === "transcript")) {
      await db.execAsync("ALTER TABLE notes ADD COLUMN transcript TEXT");
    }
  },
  // 5 — chunked recording sessions (crash recovery)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS recording_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        course_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'in_progress',
        segment_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recording_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recording_segments_session_idx
        ON recording_segments(session_id, segment_index);
    `);
  },
  // 6 — durable upload queue (survives restarts; resumes on reconnect)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS upload_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        local_path TEXT NOT NULL,
        format TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        asset_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS upload_queue_state_idx ON upload_queue(state, id);
    `);
  },
  // 7 — AI pipeline outputs and the local generation request queue
  async (db) => {
    await db.execAsync(`
      ALTER TABLE notes ADD COLUMN ai_state TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE notes ADD COLUMN summary TEXT;
      CREATE TABLE IF NOT EXISTS flashcards (
        id TEXT PRIMARY KEY NOT NULL,
        note_id TEXT NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flashcards_note_idx ON flashcards(note_id);
      CREATE TABLE IF NOT EXISTS quizzes (
        id TEXT PRIMARY KEY NOT NULL,
        note_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id TEXT PRIMARY KEY NOT NULL,
        quiz_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options TEXT,
        answer TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS quiz_questions_quiz_idx ON quiz_questions(quiz_id, ordinal);
      CREATE TABLE IF NOT EXISTS generation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        job_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS generation_queue_state_idx ON generation_queue(state, id);
    `);
  },
  // 8 — Ask Sua chat cache (server is source of truth; cache is read-only)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY NOT NULL,
        course_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_note_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_course_idx
        ON chat_messages(course_id, created_at);
    `);
  },
  // 9 — note kind (study note vs AI course reference), upload destination and
  // live upload progress
  async (db) => {
    const noteColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!noteColumns.some((column) => column.name === "note_kind")) {
      await db.execAsync(
        "ALTER TABLE notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'note'",
      );
    }
    const queueColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(upload_queue)");
    if (!queueColumns.some((column) => column.name === "target")) {
      await db.execAsync("ALTER TABLE upload_queue ADD COLUMN target TEXT");
    }
    if (!queueColumns.some((column) => column.name === "sent_bytes")) {
      await db.execAsync(
        "ALTER TABLE upload_queue ADD COLUMN sent_bytes INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!queueColumns.some((column) => column.name === "progress")) {
      await db.execAsync(
        "ALTER TABLE upload_queue ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
      );
    }
  },
  // 10 — generation destination (full study set vs condensed course reference)
  async (db) => {
    const generationColumns = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info(generation_queue)",
    );
    if (!generationColumns.some((column) => column.name === "kind")) {
      await db.execAsync(
        "ALTER TABLE generation_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'study_set'",
      );
    }
  },
  // 11 — personal study progress: card scheduling, review logs, quiz attempts
  // and the manual card mutation queue (all client-owned, synced when online).
  async (db) => {
    await db.execAsync(`
      ALTER TABLE flashcards ADD COLUMN due_at TEXT;
      ALTER TABLE flashcards ADD COLUMN interval_days REAL NOT NULL DEFAULT 0;
      ALTER TABLE flashcards ADD COLUMN ease REAL NOT NULL DEFAULT 2.5;
      ALTER TABLE flashcards ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE flashcards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS flashcards_due_idx ON flashcards(due_at);

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY NOT NULL,
        card_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        grade TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        prev_interval_days REAL NOT NULL,
        new_interval_days REAL NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS reviews_card_idx ON reviews(card_id, reviewed_at);

      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        quiz_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        total INTEGER NOT NULL,
        correct INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'marked',
        details TEXT,
        error TEXT,
        synced INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS quiz_attempts_quiz_idx ON quiz_attempts(quiz_id);

      CREATE TABLE IF NOT EXISTS card_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        op_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        note_id TEXT,
        payload TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS card_queue_state_idx ON card_queue(state, id);
    `);
  },
  // 12 — course details mirrored for offline course management
  async (db) => {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(courses)");
    if (!columns.some((column) => column.name === "lecturer")) {
      await db.execAsync("ALTER TABLE courses ADD COLUMN lecturer TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === "exam_date")) {
      await db.execAsync("ALTER TABLE courses ADD COLUMN exam_date TEXT");
    }
  },
];

export async function migrateDb(db: SQLiteDatabase) {
  await db.execAsync("PRAGMA journal_mode = WAL;");
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await MIGRATIONS[version](db);
    version += 1;
    await db.execAsync(`PRAGMA user_version = ${version}`);
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    title: String(row.title),
    body: String(row.body),
    sourceType: row.source_type as Note["sourceType"],
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    transcript: row.transcript == null ? null : String(row.transcript),
    aiState: (row.ai_state as AiState) ?? "none",
    summary: row.summary == null ? null : String(row.summary),
    noteKind: (row.note_kind as NoteKind) ?? "note",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: row.sync_state as NoteSyncState,
  };
}

export async function listNotes(db: SQLiteDatabase, courseId: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM notes WHERE course_id = ? ORDER BY updated_at DESC",
    courseId,
  );
  return rows.map(rowToNote);
}

export async function getNote(db: SQLiteDatabase, id: string) {
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM notes WHERE id = ?",
    id,
  );
  return row ? rowToNote(row) : null;
}

export async function saveNote(
  db: SQLiteDatabase,
  input: Pick<Note, "id" | "courseId" | "title" | "body" | "sourceType"> & {
    sourceRef?: string | null;
    noteKind?: NoteKind;
  },
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO notes (id, course_id, title, body, source_type, source_ref, note_kind, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body,
       source_ref = COALESCE(excluded.source_ref, notes.source_ref),
       note_kind = COALESCE(?, notes.note_kind),
       updated_at = excluded.updated_at, sync_state = 'pending'`,
    input.id,
    input.courseId,
    input.title,
    input.body,
    input.sourceType,
    input.sourceRef ?? null,
    input.noteKind ?? "note",
    now,
    now,
    input.noteKind ?? null,
  );
  await db.runAsync(
    "DELETE FROM sync_queue WHERE entity = 'note' AND entity_id = ? AND operation = 'upsert'",
    input.id,
  );
  await db.runAsync(
    "INSERT INTO sync_queue (entity, entity_id, operation, payload, created_at) VALUES ('note', ?, 'upsert', ?, ?)",
    input.id,
    // source_ref stays on the device: the server note shape has no field for it.
    JSON.stringify({
      id: input.id,
      courseId: input.courseId,
      title: input.title,
      body: input.body,
      sourceType: input.sourceType,
      noteKind: input.noteKind,
      updatedAt: now,
    }),
    now,
  );
  return getNote(db, input.id);
}

let uploadCanceller: ((noteId: string) => void) | null = null;
export function registerUploadCanceller(canceller: (noteId: string) => void) {
  uploadCanceller = canceller;
}

export async function deleteNote(db: SQLiteDatabase, id: string) {
  uploadCanceller?.(id);
  const note = await getNote(db, id).catch(() => null);
  if (note?.sourceRef) {
    const segments = await listSessionSegments(db, note.sourceRef).catch(() => []);
    for (const segment of segments) {
      if (segment.path) {
        try {
          new File(segment.path).delete();
        } catch {}
      }
    }
  }
  const uploadRows = await db
    .getAllAsync<{ local_path: string }>(
      "SELECT local_path FROM upload_queue WHERE note_id = ?",
      id,
    )
    .catch(() => []);
  for (const row of uploadRows) {
    if (row.local_path) {
      try {
        new File(row.local_path).delete();
      } catch {}
    }
  }
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    // Remove unsent upserts and prior delete markers before writing the final
    // operation. An older upsert must never recreate a note after its delete.
    await db.runAsync(
      "DELETE FROM sync_queue WHERE entity = 'note' AND entity_id = ?",
      id,
    );
    await db.runAsync("DELETE FROM notes WHERE id = ?", id);
    // Files queued for upload would sync into an orphaned note; drop them too.
    await db.runAsync("DELETE FROM upload_queue WHERE note_id = ?", id);
    await db.runAsync("DELETE FROM generation_queue WHERE note_id = ?", id);
    await db.runAsync("DELETE FROM reviews WHERE note_id = ?", id);
    await db.runAsync("DELETE FROM card_queue WHERE note_id = ?", id);
    await db.runAsync("DELETE FROM quiz_attempts WHERE note_id = ?", id);
    await db.runAsync("DELETE FROM flashcards WHERE note_id = ?", id);
    await db.runAsync(
      "DELETE FROM quiz_questions WHERE quiz_id IN (SELECT id FROM quizzes WHERE note_id = ?)",
      id,
    );
    await db.runAsync("DELETE FROM quizzes WHERE note_id = ?", id);
    if (note?.sourceRef) {
      await db.runAsync("DELETE FROM recording_segments WHERE session_id = ?", note.sourceRef);
      await db.runAsync("DELETE FROM recording_sessions WHERE id = ?", note.sourceRef);
    }
    await db.runAsync(
      "INSERT INTO sync_queue (entity, entity_id, operation, payload, created_at) VALUES ('note', ?, 'delete', '{}', ?)",
      id,
      now,
    );
  });
}

// Extraction result written directly (no sync enqueue): the server owns its
// copy on the asset, this only feeds the local reader.
export async function setNoteTranscript(db: SQLiteDatabase, id: string, transcript: string) {
  await db.runAsync("UPDATE notes SET transcript = ? WHERE id = ?", transcript, id);
}

export async function pendingSyncCount(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_queue",
  );
  return row?.count ?? 0;
}

export async function countNotesBySource(
  db: SQLiteDatabase,
  sourceType: Note["sourceType"],
) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM notes WHERE source_type = ?",
    sourceType,
  );
  return row?.count ?? 0;
}

// Free-plan usage counts recordings created in the current calendar month.
export async function countAudioNotesThisMonth(db: SQLiteDatabase) {
  const month = new Date().toISOString().slice(0, 7);
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM notes WHERE source_type = 'audio' AND substr(created_at, 1, 7) = ?",
    month,
  );
  return row?.count ?? 0;
}

// The server cascades note rows when a course is deleted; mirror that locally
// and drop queued changes for those notes so nothing tries to sync orphans.
export async function purgeCourseLocally(db: SQLiteDatabase, courseId: string) {
  const noteRows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM notes WHERE course_id = ?",
    courseId,
  );
  for (const row of noteRows) {
    uploadCanceller?.(row.id);
  }
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "DELETE FROM sync_queue WHERE entity = 'note' AND entity_id IN (SELECT id FROM notes WHERE course_id = ?)",
      courseId,
    );
    await db.runAsync(
      "DELETE FROM upload_queue WHERE note_id IN (SELECT id FROM notes WHERE course_id = ?)",
      courseId,
    );
    await db.runAsync("DELETE FROM notes WHERE course_id = ?", courseId);
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// Push queued changes, honouring per-change acknowledgements from the server.
// Only accepted rows leave the queue — rejected changes are marked locally
// and conflicts adopt the newer server copy (see the timestamp guard in the
// backend sync route).
export async function syncPendingNotes(db: SQLiteDatabase, token: string) {
  const queue = await db.getAllAsync<SyncQueueItem>(
    "SELECT * FROM sync_queue ORDER BY id ASC LIMIT 100",
  );
  if (!queue.length) return 0;

  // Several saves of the same note can queue up offline; only the newest
  // change per note matters (its payload carries the latest updatedAt).
  const latestByEntity = new Map<string, SyncQueueItem>();
  for (const item of queue) latestByEntity.set(item.entityId, item);
  const batch = [...latestByEntity.values()].sort((a, b) => a.id - b.id);

  const changes = batch.map((item) => ({
    operation: item.operation,
    id: item.entityId,
    ...(item.operation === "upsert" ? JSON.parse(item.payload) : {}),
  }));
  const response = await notesApi.sync(token, changes);
  const results = new Map<string, SyncResult>(
    (response.results ?? []).map((result) => [result.id, result]),
  );

  await db.withTransactionAsync(async () => {
    for (const item of batch) {
      const status = results.get(item.entityId)?.status ?? "accepted";
      if (status === "rejected") {
        // Unrecoverable (bad course, foreign id, malformed payload): drop the
        // queue row and flag the note so it is not silently shown as synced.
        if (item.operation === "upsert") {
          await db.runAsync(
            "UPDATE notes SET sync_state = 'error' WHERE id = ?",
            item.entityId,
          );
        }
        await db.runAsync("DELETE FROM sync_queue WHERE id = ?", item.id);
        continue;
      }
      if (item.operation === "upsert") {
        await db.runAsync("UPDATE notes SET sync_state = 'synced' WHERE id = ?", item.entityId);
      }
      await db.runAsync("DELETE FROM sync_queue WHERE id = ?", item.id);
    }
  });

  // Conflict copies are newer than what we sent; apply them after the queue
  // rows for accepted changes are gone so the pull guard below lets them in.
  for (const result of results.values()) {
    if (result.status === "conflict" && result.note) {
      await db.runAsync("UPDATE notes SET sync_state = 'synced' WHERE id = ?", result.note.id);
      await upsertSyncedNote(db, result.note);
    }
  }
  for (const note of response.notes) await upsertSyncedNote(db, note);
  return batch.length;
}

// Never clobber local rows that still have queued (or newer) changes — a pull
// delivering a stale server copy must not lose an offline edit.
export async function upsertSyncedNote(db: SQLiteDatabase, note: ServerNote) {
  const queued = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM sync_queue WHERE entity = 'note' AND entity_id = ?",
    note.id,
  );
  if (queued) return;
  const local = await getNote(db, note.id);
  if (local) {
    if (local.syncState === "pending") return;
    if (local.updatedAt > note.updatedAt) return;
  }
  await db.runAsync(
    `INSERT INTO notes (id, course_id, title, body, source_type, transcript, ai_state, summary, note_kind, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body, source_type = excluded.source_type,
       ai_state = excluded.ai_state, summary = COALESCE(excluded.summary, notes.summary),
       note_kind = excluded.note_kind,
       updated_at = excluded.updated_at, sync_state = 'synced'`,
    note.id,
    note.courseId,
    note.title,
    note.body,
    note.sourceType,
    // The server's transcript (pipeline output) wins; keep locally extracted text otherwise.
    note.transcript ?? local?.transcript ?? null,
    note.aiState ?? "none",
    note.summary ?? local?.summary ?? null,
    note.noteKind ?? local?.noteKind ?? "note",
    note.createdAt,
    note.updatedAt,
  );
}

export async function pullCourseNotes(db: SQLiteDatabase, token: string, courseId: string) {
  const notes = await notesApi.listForCourse(token, courseId);
  for (const note of notes) await upsertSyncedNote(db, note);
}

// ---------------------------------------------------------------------------
// Local course cache
// ---------------------------------------------------------------------------

function rowToCourse(row: Record<string, unknown>): LocalCourse {
  return {
    id: String(row.id),
    name: String(row.name),
    code: String(row.code),
    colour: String(row.colour),
    lecturer: String(row.lecturer ?? ""),
    examDate: row.exam_date ? String(row.exam_date) : null,
    archived: Boolean(row.archived),
    updatedAt: String(row.updated_at),
  };
}

export async function replaceLocalCourses(
  db: SQLiteDatabase,
  courses: Omit<LocalCourse, "updatedAt">[],
) {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM courses");
    for (const course of courses) {
      await db.runAsync(
        "INSERT INTO courses (id, name, code, colour, lecturer, exam_date, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        course.id,
        course.name,
        course.code,
        course.colour,
        course.lecturer,
        course.examDate,
        course.archived ? 1 : 0,
        now,
      );
    }
  });
}

export async function upsertLocalCourse(db: SQLiteDatabase, course: Omit<LocalCourse, "updatedAt">) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO courses (id, name, code, colour, lecturer, exam_date, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code,
       colour = excluded.colour, lecturer = excluded.lecturer, exam_date = excluded.exam_date,
       archived = excluded.archived, updated_at = excluded.updated_at`,
    course.id,
    course.name,
    course.code,
    course.colour,
    course.lecturer,
    course.examDate,
    course.archived ? 1 : 0,
    now,
  );
}

export async function removeLocalCourse(db: SQLiteDatabase, id: string) {
  await db.runAsync("DELETE FROM courses WHERE id = ?", id);
}

export async function listLocalCourses(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM courses ORDER BY archived ASC, name ASC",
  );
  return rows.map(rowToCourse);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting(db: SQLiteDatabase, key: string) {
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string) {
  await db.runAsync(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

// ---------------------------------------------------------------------------
// Chunked recording (crash recovery)
// ---------------------------------------------------------------------------

function rowToSession(row: Record<string, unknown>): RecordingSession {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    state: row.state as RecordingSession["state"],
    segmentCount: Number(row.segment_count),
    durationMs: Number(row.duration_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToSegment(row: Record<string, unknown>): RecordingSegment {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    segmentIndex: Number(row.segment_index),
    path: String(row.path),
    state: row.state as RecordingSegment["state"],
    durationMs: Number(row.duration_ms),
    createdAt: String(row.created_at),
  };
}

export async function createRecordingSession(db: SQLiteDatabase, id: string, courseId: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    "INSERT INTO recording_sessions (id, course_id, state, segment_count, duration_ms, created_at, updated_at) VALUES (?, ?, 'in_progress', 0, 0, ?, ?)",
    id,
    courseId,
    now,
    now,
  );
}

export async function listInProgressRecordings(db: SQLiteDatabase) {
  const sessions = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM recording_sessions WHERE state = 'in_progress' ORDER BY created_at ASC",
  );
  return Promise.all(
    sessions.map(async (row) => ({
      session: rowToSession(row),
      segments: await listSessionSegments(db, String(row.id)),
    })),
  );
}

// Registers the segment row before recording starts so a crash leaves a
// recoverable record of the in-flight file instead of an orphan on disk.
export async function addRecordingSegment(
  db: SQLiteDatabase,
  input: { sessionId: string; segmentIndex: number; path: string },
) {
  const now = new Date().toISOString();
  const result = await db.runAsync(
    "INSERT INTO recording_segments (session_id, segment_index, path, state, duration_ms, created_at) VALUES (?, ?, ?, 'active', 0, ?)",
    input.sessionId,
    input.segmentIndex,
    input.path,
    now,
  );
  await db.runAsync(
    "UPDATE recording_sessions SET segment_count = ?, updated_at = ? WHERE id = ?",
    input.segmentIndex + 1,
    now,
    input.sessionId,
  );
  return Number(result.lastInsertRowId);
}

export async function touchSegmentDuration(db: SQLiteDatabase, segmentId: number, durationMs: number) {
  await db.runAsync("UPDATE recording_segments SET duration_ms = ? WHERE id = ?", durationMs, segmentId);
}

export async function finalizeSegment(db: SQLiteDatabase, segmentId: number, durationMs: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE recording_segments SET state = 'finalized', duration_ms = ? WHERE id = ?",
    durationMs,
    segmentId,
  );
  await db.runAsync(
    "UPDATE recording_sessions SET duration_ms = duration_ms + ?, updated_at = ? WHERE id = (SELECT session_id FROM recording_segments WHERE id = ?)",
    durationMs,
    now,
    segmentId,
  );
}

export async function listSessionSegments(db: SQLiteDatabase, sessionId: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM recording_segments WHERE session_id = ? ORDER BY segment_index ASC",
    sessionId,
  );
  return rows.map(rowToSegment);
}

// Drops a chunk whose file was removed (an un-finalised segment truncated by
// a crash is not reliably playable, so recovery discards it).
export async function removeRecordingSegment(db: SQLiteDatabase, id: number) {
  await db.runAsync("DELETE FROM recording_segments WHERE id = ?", id);
}

export async function completeRecordingSession(db: SQLiteDatabase, sessionId: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE recording_sessions SET state = 'complete', updated_at = ? WHERE id = ?",
    now,
    sessionId,
  );
}

export async function discardRecordingSession(db: SQLiteDatabase, sessionId: string) {
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM recording_segments WHERE session_id = ?", sessionId);
    await db.runAsync("DELETE FROM recording_sessions WHERE id = ?", sessionId);
  });
}

// ---------------------------------------------------------------------------
// Upload queue
// ---------------------------------------------------------------------------

function rowToUpload(row: Record<string, unknown>): UploadQueueItem {
  return {
    id: Number(row.id),
    noteId: String(row.note_id),
    kind: row.kind as UploadKind,
    localPath: String(row.local_path),
    format: String(row.format),
    bytes: Number(row.bytes),
    state: row.state as UploadState,
    attempts: Number(row.attempts),
    assetId: row.asset_id == null ? null : String(row.asset_id),
    target: row.target == null ? null : (String(row.target) as UploadTarget),
    sentBytes: Number(row.sent_bytes ?? 0),
    progress: Number(row.progress ?? 0),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function enqueueUpload(
  db: SQLiteDatabase,
  input: {
    noteId: string;
    kind: UploadKind;
    localPath: string;
    format: string;
    bytes: number;
    target?: UploadTarget | null;
  },
) {
  const now = new Date().toISOString();
  // Same file queued twice (e.g. retry racing a save) stays a single row.
  const existing = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM upload_queue WHERE note_id = ? AND local_path = ? AND state != 'uploaded'",
    input.noteId,
    input.localPath,
  );
  if (existing) return existing.id;
  const result = await db.runAsync(
    "INSERT INTO upload_queue (note_id, kind, local_path, format, bytes, target, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
    input.noteId,
    input.kind,
    input.localPath,
    input.format,
    input.bytes,
    input.target ?? null,
    now,
    now,
  );
  return Number(result.lastInsertRowId);
}

// Pending uploads ready to process — excludes permanently failed rows (attempts >= 3)
// and throttles failed retries with exponential backoff so connectivity hiccups don't
// spam upload tasks in a tight loop.
export async function listPendingUploads(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM upload_queue WHERE state = 'pending' OR (state = 'failed' AND attempts < 3) ORDER BY id ASC",
  );
  const now = Date.now();
  return rows.map(rowToUpload).filter((item) => {
    if (item.state === "pending") return true;
    if (item.state === "failed") {
      // Exponential backoff: attempt 1 -> 5s, attempt 2 -> 30s, attempt 3 -> 120s
      const delays = [5_000, 30_000, 120_000];
      const delay = delays[Math.max(0, item.attempts - 1)] ?? 120_000;
      const lastAttempt = new Date(item.updatedAt).getTime();
      return now - lastAttempt >= delay;
    }
    return false;
  });
}

// Everything not yet uploaded — including rows stuck in 'uploading' from a
// crash, which are reset by the flusher.
export async function listUploadQueue(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM upload_queue WHERE state != 'uploaded' ORDER BY id ASC",
  );
  return rows.map(rowToUpload);
}

// Everything ever queued, newest first — feeds the Uploads screen history.
export async function listUploadHistory(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM upload_queue ORDER BY updated_at DESC, id DESC",
  );
  return rows.map(rowToUpload);
}

// Progress-only write; kept separate from updateUploadState and not touching
// updated_at so frequent progress ticks do not reshuffle history ordering.
export async function updateUploadProgress(
  db: SQLiteDatabase,
  id: number,
  { sentBytes, progress }: { sentBytes: number; progress: number },
) {
  await db.runAsync(
    "UPDATE upload_queue SET sent_bytes = ?, progress = ? WHERE id = ?",
    sentBytes,
    progress,
    id,
  );
}

export async function updateUploadState(
  db: SQLiteDatabase,
  id: number,
  patch: {
    state?: UploadState;
    assetId?: string | null;
    error?: string | null;
    bumpAttempts?: boolean;
    resetAttempts?: boolean;
  },
) {
  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.state) {
    updates.push("state = ?");
    values.push(patch.state);
  }
  if (patch.assetId !== undefined) {
    updates.push("asset_id = ?"); // plain set: an explicit null clears the pointer
    values.push(patch.assetId);
  }
  updates.push("error = ?");
  values.push(patch.error ?? null);
  if (patch.resetAttempts) {
    updates.push("attempts = 0");
  } else {
    updates.push("attempts = attempts + ?");
    values.push(patch.bumpAttempts ? 1 : 0);
  }
  updates.push("updated_at = ?");
  values.push(now);
  values.push(id);
  await db.runAsync(
    `UPDATE upload_queue SET ${updates.join(", ")} WHERE id = ?`,
    ...values,
  );
}

// Progress resets whenever a row leaves its in-flight state, so a resumed
// retry always starts its bar from zero.
export async function resetUploadProgress(db: SQLiteDatabase, id: number) {
  await db.runAsync(
    "UPDATE upload_queue SET sent_bytes = 0, progress = 0 WHERE id = ?",
    id,
  );
}

export async function removeUploadQueueItem(db: SQLiteDatabase, id: number) {
  const row = await db.getFirstAsync<{ local_path: string }>(
    "SELECT local_path FROM upload_queue WHERE id = ?",
    id,
  );
  if (row?.local_path) {
    try {
      new File(row.local_path).delete();
    } catch {
      // Ignore if already deleted
    }
  }
  await db.runAsync("DELETE FROM upload_queue WHERE id = ?", id);
}

// True while any of a note's queued files are still unsettled. Recording
// generations wait for this: the job would otherwise transcribe an incomplete
// take. Files that keep failing (3+ attempts) stop blocking so the queue can
// surface an honest "no usable source" error instead of hanging forever.
export async function countPendingUploads(db: SQLiteDatabase, noteId: string) {
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM upload_queue
     WHERE note_id = ? AND (
       state IN ('pending', 'uploading') OR (state = 'failed' AND attempts < 3)
     )`,
    noteId,
  );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// AI study sets (server-owned outputs cached locally) + generation queue
// ---------------------------------------------------------------------------

export type LocalFlashcard = {
  id: string;
  noteId: string;
  front: string;
  back: string;
  dueAt: string | null;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
};

export type LocalQuizQuestion = {
  id: string;
  quizId: string;
  type: "mcq" | "true_false" | "short_answer";
  prompt: string;
  options: string[] | null;
  answer: string;
  explanation: string;
  ordinal?: number;
};

// Server-generated study set replaces local flashcards/quizzes wholesale.
// Scheduling columns are personal: a redeployed card keeps the student's
// local scheduling if their reviews for it have not synced yet.
export async function storeStudySet(
  db: SQLiteDatabase,
  noteId: string,
  study: {
    flashcards: {
      id: string;
      front: string;
      back: string;
      dueAt?: string;
      ease?: number;
      intervalDays?: number;
      reps?: number;
    }[];
    quizzes: {
      id: string;
      title: string;
      questions: LocalQuizQuestion[];
    }[];
  },
) {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    const keepScheduling = new Set(
      (
        await db.getAllAsync<{ card_id: string }>(
          "SELECT DISTINCT card_id FROM reviews WHERE note_id = ? AND synced = 0",
          noteId,
        )
      ).map((row) => row.card_id),
    );
    const previous = new Map(
      (
        await db.getAllAsync<Record<string, unknown>>(
          "SELECT * FROM flashcards WHERE note_id = ?",
          noteId,
        )
      ).map((row) => [String(row.id), row]),
    );
    await db.runAsync("DELETE FROM flashcards WHERE note_id = ?", noteId);
    for (const card of study.flashcards) {
      const prior = previous.get(card.id);
      const preserve = keepScheduling.has(card.id) && prior != null;
      const dueAt =
        preserve && prior
          ? String(prior.due_at ?? card.dueAt ?? null)
          : (card.dueAt ?? null);
      const ease = preserve && prior ? Number(prior.ease ?? 2.5) : (card.ease ?? 2.5);
      const intervalDays = preserve && prior ? Number(prior.interval_days ?? 0) : (card.intervalDays ?? 0);
      const reps = preserve && prior ? Number(prior.reps ?? 0) : (card.reps ?? 0);
      await db.runAsync(
        "INSERT OR REPLACE INTO flashcards (id, note_id, front, back, due_at, interval_days, ease, reps, lapses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        card.id,
        noteId,
        card.front,
        card.back,
        dueAt,
        intervalDays,
        ease,
        reps,
        prior ? Number(prior.lapses ?? 0) : 0,
        now,
      );
    }
    for (const quiz of study.quizzes) {
      await db.runAsync(
        "DELETE FROM quiz_questions WHERE quiz_id = ?",
        quiz.id,
      );
      await db.runAsync(
        "INSERT OR REPLACE INTO quizzes (id, note_id, title, created_at) VALUES (?, ?, ?, ?)",
        quiz.id,
        noteId,
        quiz.title,
        now,
      );
      for (const question of quiz.questions) {
        await db.runAsync(
          "INSERT OR REPLACE INTO quiz_questions (id, quiz_id, ordinal, type, prompt, options, answer, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          question.id,
          quiz.id,
          question.ordinal ?? 0,
          question.type,
          question.prompt,
          question.options ? JSON.stringify(question.options) : null,
          question.answer,
          question.explanation ?? "",
        );
      }
    }
  });
}

export async function listFlashcards(db: SQLiteDatabase, noteId: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM flashcards WHERE note_id = ? ORDER BY created_at ASC",
    noteId,
  );
  return rows.map(rowToFlashcard);
}

function rowToFlashcard(row: Record<string, unknown>): LocalFlashcard {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    front: String(row.front),
    back: String(row.back),
    dueAt: row.due_at == null ? null : String(row.due_at),
    intervalDays: Number(row.interval_days ?? 0),
    ease: Number(row.ease ?? 2.5),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
  };
}

export type LocalQuiz = {
  id: string;
  noteId: string;
  title: string;
  questions: LocalQuizQuestion[];
};

export async function listQuizzes(db: SQLiteDatabase, noteId: string) {
  const quizRows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM quizzes WHERE note_id = ? ORDER BY created_at ASC",
    noteId,
  );
  const quizzes: LocalQuiz[] = [];
  for (const quiz of quizRows) {
    const id = String(quiz.id);
    const questions = (
      await db.getAllAsync<Record<string, unknown>>(
        "SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal ASC",
        id,
      )
    ).map(
      (row): LocalQuizQuestion => ({
        id: String(row.id),
        quizId: String(row.quiz_id),
        type: row.type as LocalQuizQuestion["type"],
        prompt: String(row.prompt),
        options: row.options ? (JSON.parse(String(row.options)) as string[]) : null,
        answer: String(row.answer),
        explanation: String(row.explanation ?? ""),
      }),
    );
    quizzes.push({
      id,
      noteId: String(quiz.note_id),
      title: String(quiz.title ?? ""),
      questions,
    });
  }
  return quizzes;
}

export async function countQuizzes(db: SQLiteDatabase, noteId: string) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM quizzes WHERE note_id = ?",
    noteId,
  );
  return row?.count ?? 0;
}

export async function setNoteAiState(db: SQLiteDatabase, id: string, aiState: AiState) {
  await db.runAsync("UPDATE notes SET ai_state = ? WHERE id = ?", aiState, id);
}

export async function setNoteSummary(db: SQLiteDatabase, id: string, summary: string) {
  await db.runAsync("UPDATE notes SET summary = ? WHERE id = ?", summary, id);
}

// ---------------------------------------------------------------------------
// Generation request queue (offline-first: requests queue until connectivity)
// ---------------------------------------------------------------------------

export type GenerationQueueItem = {
  id: number;
  noteId: string;
  state: "queued" | "active" | "done" | "failed";
  // What the server job should produce (passed through on submit).
  kind: GenerationKind;
  jobId: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowToGeneration(row: Record<string, unknown>): GenerationQueueItem {
  return {
    id: Number(row.id),
    noteId: String(row.note_id),
    state: row.state as GenerationQueueItem["state"],
    kind: (row.kind as GenerationKind) ?? "study_set",
    jobId: row.job_id == null ? null : String(row.job_id),
    attempts: Number(row.attempts),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// One live request per note; re-queuing a failed note replaces the row.
export async function enqueueGeneration(
  db: SQLiteDatabase,
  noteId: string,
  kind: GenerationKind = "study_set",
) {
  const now = new Date().toISOString();
  const existing = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM generation_queue WHERE note_id = ? AND state IN ('queued', 'active')",
    noteId,
  );
  if (existing) return existing.id;
  await setNoteAiState(db, noteId, "queued");
  const result = await db.runAsync(
    "INSERT INTO generation_queue (note_id, kind, state, attempts, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?)",
    noteId,
    kind,
    now,
    now,
  );
  return Number(result.lastInsertRowId);
}

export async function listGenerationQueue(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM generation_queue WHERE state IN ('queued', 'active') ORDER BY id ASC",
  );
  return rows.map(rowToGeneration);
}

/**
 * The destination the student last asked for on this note. Retries reuse it so
 * a failed lecture-note run is retried as a lecture note, not a plain summary.
 */
export async function getLastGenerationKind(
  db: SQLiteDatabase,
  noteId: string,
): Promise<GenerationKind | null> {
  const row = await db.getFirstAsync<{ kind: string | null }>(
    "SELECT kind FROM generation_queue WHERE note_id = ? ORDER BY id DESC LIMIT 1",
    noteId,
  );
  if (!row?.kind) return null;
  return row.kind === "lecture_note" || row.kind === "course_reference"
    ? row.kind
    : "study_set";
}

/**
 * Notes whose AI run finished on the server but whose study set never reached
 * this device. Upload-triggered conversions have no local queue row, so this
 * is how their cards and quiz get cached locally.
 */
export async function listNotesMissingStudySet(
  db: SQLiteDatabase,
  limit = 5,
): Promise<{ id: string }[]> {
  return db.getAllAsync<{ id: string }>(
    `SELECT n.id AS id FROM notes n
     WHERE n.note_kind != 'reference'
       AND n.ai_state = 'ready'
       AND NOT EXISTS (SELECT 1 FROM flashcards f WHERE f.note_id = n.id)
       AND NOT EXISTS (SELECT 1 FROM quizzes q WHERE q.note_id = n.id)
     ORDER BY n.updated_at DESC
     LIMIT ?`,
    limit,
  );
}

export async function updateGeneration(
  db: SQLiteDatabase,
  id: number,
  patch: {
    state: "queued" | "active" | "done" | "failed";
    jobId?: string | null;
    error?: string | null;
    bumpAttempts?: boolean;
  },
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE generation_queue SET state = ?, job_id = COALESCE(?, job_id), error = ?,
       attempts = attempts + ?, updated_at = ? WHERE id = ?`,
    patch.state,
    patch.jobId ?? null,
    patch.error ?? null,
    patch.bumpAttempts ? 1 : 0,
    now,
    id,
  );
}

// ---------------------------------------------------------------------------
// Ask Sua chat cache
// ---------------------------------------------------------------------------

export type ChatMessageRow = {
  id: string;
  courseId: string;
  role: "user" | "assistant";
  content: string;
  sourceNoteIds: string[];
  createdAt: string;
};

function rowToChatMessage(row: Record<string, unknown>): ChatMessageRow {
  let sourceNoteIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.source_note_ids ?? "[]"));
    if (Array.isArray(parsed)) sourceNoteIds = parsed.map(String);
  } catch {
    sourceNoteIds = [];
  }
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    role: row.role === "user" ? "user" : "assistant",
    content: String(row.content),
    sourceNoteIds,
    createdAt: String(row.created_at),
  };
}

export async function listCourseMessages(db: SQLiteDatabase, courseId: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM chat_messages WHERE course_id = ? ORDER BY created_at ASC",
    courseId,
  );
  return rows.map(rowToChatMessage);
}

// Server is the source of truth; a refresh replaces the course's cache.
export async function replaceCourseMessages(
  db: SQLiteDatabase,
  courseId: string,
  messages: ChatMessageRow[],
) {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM chat_messages WHERE course_id = ?", courseId);
    for (const message of messages) {
      await db.runAsync(
        `INSERT OR REPLACE INTO chat_messages
           (id, course_id, role, content, source_note_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        message.id,
        message.courseId,
        message.role,
        message.content,
        JSON.stringify(message.sourceNoteIds ?? []),
        message.createdAt || now,
      );
    }
  });
}

export async function upsertChatMessage(
  db: SQLiteDatabase,
  message: ChatMessageRow,
) {
  await db.runAsync(
    `INSERT OR REPLACE INTO chat_messages
       (id, course_id, role, content, source_note_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    message.id,
    message.courseId,
    message.role,
    message.content,
    JSON.stringify(message.sourceNoteIds ?? []),
    message.createdAt || new Date().toISOString(),
  );
}

// Last-used course so the chat screen opens where the student left off.
export const ASK_SUA_COARSE_KEY = "ask_sua_course_id";

// ---------------------------------------------------------------------------
// Study progress: SM-2-lite flashcard scheduling, review logs, quiz attempts
// and the manual card mutation queue (offline-first; flushed when online).
// ---------------------------------------------------------------------------


export type LocalQuizAttempt = {
  id: string;
  quizId: string;
  noteId: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  correct: number;
  state: "marked" | "pending_marking" | "marking_failed";
  details: {
    questionId: string;
    answer?: string;
    verdict?: boolean;
    partial?: boolean;
    comment?: string;
  }[];
  error: string | null;
  synced: boolean;
};

export type LocalCardOp = {
  id: number;
  op: "create" | "update" | "delete";
  opId: string;
  cardId: string;
  noteId: string | null;
  payload: { front?: string; back?: string } | null;
  attempts: number;
};

function rowToAttempt(row: Record<string, unknown>): LocalQuizAttempt {
  return {
    id: String(row.id),
    quizId: String(row.quiz_id),
    noteId: String(row.note_id),
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    total: Number(row.total ?? 0),
    correct: Number(row.correct ?? 0),
    state: (row.state as LocalQuizAttempt["state"]) ?? "marked",
    details: row.details ? JSON.parse(String(row.details)) : [],
    error: row.error == null ? null : String(row.error),
    synced: Number(row.synced ?? 0) === 1,
  };
}

/** Cards due at or before the ISO cutoff, across every deck. */
export async function listDueCards(db: SQLiteDatabase, cutoffIso: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM flashcards WHERE (due_at IS NULL OR due_at <= ?) ORDER BY due_at IS NULL DESC, due_at ASC",
    cutoffIso,
  );
  return rows.map(rowToFlashcard);
}

export async function countDueCards(db: SQLiteDatabase, cutoffIso: string) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM flashcards WHERE (due_at IS NULL OR due_at <= ?)",
    cutoffIso,
  );
  return row?.count ?? 0;
}

export async function getNextDueAt(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ next: string | null }>(
    "SELECT MIN(due_at) as next FROM flashcards WHERE due_at > ?",
    new Date().toISOString(),
  );
  return row?.next ?? null;
}

/**
 * Apply one grade to a card, storing its scheduling locally and appending an
 * (unsynced) review log. Returns the updated card.
 */
export async function gradeCard(db: SQLiteDatabase, cardId: string, grade: CardGrade) {
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM flashcards WHERE id = ?",
    cardId,
  );
  if (!row) throw new Error("Card not found");
  const card = rowToFlashcard(row);
  const now = Date.now();
  const state = { ease: card.ease, intervalDays: card.intervalDays, reps: card.reps };
  const next = nextState(state, grade, now);
  const dueAtIso = new Date(nextDueMs(state, grade, now)).toISOString();
  const lapses = grade === "again" ? card.lapses + 1 : card.lapses;
  await db.runAsync(
    "UPDATE flashcards SET due_at = ?, ease = ?, interval_days = ?, reps = ?, lapses = ? WHERE id = ?",
    dueAtIso,
    next.ease,
    next.intervalDays,
    next.reps,
    lapses,
    cardId,
  );
  await db.runAsync(
    "INSERT INTO reviews (id, card_id, note_id, grade, reviewed_at, prev_interval_days, new_interval_days, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    newId(),
    cardId,
    card.noteId,
    grade,
    new Date(now).toISOString(),
    card.intervalDays,
    next.intervalDays,
  );
  return { ...card, dueAt: dueAtIso, ease: next.ease, intervalDays: next.intervalDays, reps: next.reps, lapses };
}

export async function listDeckCards(db: SQLiteDatabase, noteId: string) {
  return listFlashcards(db, noteId);
}

export async function countDeckDue(db: SQLiteDatabase, noteId: string, cutoffIso: string) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM flashcards WHERE note_id = ? AND (due_at IS NULL OR due_at <= ?)",
    noteId,
    cutoffIso,
  );
  return row?.count ?? 0;
}

export type StudyLog = {
  id: string;
  cardId: string;
  grade: CardGrade;
  reviewedAt: string;
  prevIntervalDays: number;
  newIntervalDays: number;
};

export async function listUnsyncedReviews(db: SQLiteDatabase, limit = 500) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM reviews WHERE synced = 0 ORDER BY reviewed_at ASC LIMIT ?",
    limit,
  );
  return rows.map(
    (row): StudyLog => ({
      id: String(row.id),
      cardId: String(row.card_id),
      grade: row.grade as CardGrade,
      reviewedAt: String(row.reviewed_at),
      prevIntervalDays: Number(row.prev_interval_days ?? 0),
      newIntervalDays: Number(row.new_interval_days ?? 0),
    }),
  );
}

export async function markReviewsSynced(db: SQLiteDatabase, ids: string[]) {
  for (const id of ids) {
    await db.runAsync("UPDATE reviews SET synced = 1 WHERE id = ?", id);
  }
}

/** Apply server-replayed scheduling back onto the local cards. */
export async function applyDeckScheduling(
  db: SQLiteDatabase,
  cards: { id: string; dueAt: string; ease: number; intervalDays: number; reps: number }[],
) {
  for (const card of cards) {
    await db.runAsync(
      "UPDATE flashcards SET due_at = ?, ease = ?, interval_days = ?, reps = ? WHERE id = ?",
      card.dueAt,
      card.ease,
      card.intervalDays,
      card.reps,
      card.id,
    );
  }
}

// ---------------------------------------------------------------------------
// Quiz attempts
// ---------------------------------------------------------------------------

export async function recordQuizAttempt(
  db: SQLiteDatabase,
  attempt: Omit<LocalQuizAttempt, "synced">,
) {
  await db.runAsync(
    `INSERT OR REPLACE INTO quiz_attempts
       (id, quiz_id, note_id, started_at, finished_at, total, correct, state, details, error, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attempt.id,
    attempt.quizId,
    attempt.noteId,
    attempt.startedAt,
    attempt.finishedAt,
    attempt.total,
    attempt.correct,
    attempt.state,
    attempt.details.length ? JSON.stringify(attempt.details) : null,
    attempt.error,
    0,
  );
}

export async function listQuizAttempts(db: SQLiteDatabase, quizId: string) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM quiz_attempts WHERE quiz_id = ? ORDER BY finished_at DESC",
    quizId,
  );
  return rows.map(rowToAttempt);
}

export async function getQuizAttempt(db: SQLiteDatabase, id: string) {
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM quiz_attempts WHERE id = ?",
    id,
  );
  return row ? rowToAttempt(row) : null;
}

/** Settle the AI marking result (or the next poll of a held attempt). */
export async function updateAttemptResult(
  db: SQLiteDatabase,
  attempt: {
    id: string;
    state: LocalQuizAttempt["state"];
    correct: number;
    details: LocalQuizAttempt["details"];
    error?: string | null;
  },
) {
  await db.runAsync(
    "UPDATE quiz_attempts SET state = ?, correct = ?, details = ?, error = ? WHERE id = ?",
    attempt.state,
    attempt.correct,
    attempt.details.length ? JSON.stringify(attempt.details) : null,
    attempt.error ?? null,
    attempt.id,
  );
}

export async function listAttemptsWithState(
  db: SQLiteDatabase,
  states: LocalQuizAttempt["state"][],
) {
  const placeholders = states.map(() => "?").join(", ");
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM quiz_attempts WHERE state IN (${placeholders})`,
    states,
  );
  return rows.map(rowToAttempt);
}

export async function markAttemptSynced(db: SQLiteDatabase, id: string) {
  await db.runAsync("UPDATE quiz_attempts SET synced = 1 WHERE id = ?", id);
}

// ---------------------------------------------------------------------------
// Manual card mutation queue (add/edit/delete flashcards, offline-first)
// ---------------------------------------------------------------------------

export type CardOpInput = {
  op: "create" | "update" | "delete";
  cardId: string;
  noteId?: string | null;
  front?: string;
  back?: string;
};

export async function enqueueCardOp(db: SQLiteDatabase, input: CardOpInput) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO card_queue (op, op_id, card_id, note_id, payload, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    input.op,
    newId(),
    input.cardId,
    input.noteId ?? null,
    input.front || input.back ? JSON.stringify({ front: input.front, back: input.back }) : null,
    now,
    now,
  );
}

export async function listPendingCardOps(db: SQLiteDatabase, limit = 100) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM card_queue WHERE state = 'pending' ORDER BY id ASC LIMIT ?",
    limit,
  );
  return rows.map((row): LocalCardOp => ({
    id: Number(row.id),
    op: row.op as LocalCardOp["op"],
    opId: String(row.op_id),
    cardId: String(row.card_id),
    noteId: row.note_id == null ? null : String(row.note_id),
    payload: row.payload ? JSON.parse(String(row.payload)) : null,
    attempts: Number(row.attempts ?? 0),
  }));
}

export async function markCardOpDone(db: SQLiteDatabase, id: number) {
  await db.runAsync(
    "UPDATE card_queue SET state = 'done', updated_at = ? WHERE id = ?",
    new Date().toISOString(),
    id,
  );
}

export async function markCardOpFailed(
  db: SQLiteDatabase,
  id: number,
  error: string,
  attempts: number,
) {
  // Three failed attempts retire the op; study-set pulls can still repair it.
  await db.runAsync(
    "UPDATE card_queue SET state = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?",
    attempts >= 3 ? "failed" : "pending",
    attempts,
    error,
    new Date().toISOString(),
    id,
  );
}

/**
 * Insert or edit a flashcard locally, then queue the matching server op.
 * New cards are due tomorrow; edits keep the scheduling untouched.
 */
export async function upsertLocalCard(
  db: SQLiteDatabase,
  input: {
    id: string;
    noteId: string;
    front: string;
    back: string;
    op: "create" | "update";
  },
) {
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM flashcards WHERE id = ?",
    input.id,
  );
  const op = input.op === "create" && existing ? ("update" as const) : input.op;
  if (op === "create") {
    await db.runAsync(
      `INSERT INTO flashcards (id, note_id, front, back, due_at, interval_days, ease, reps, lapses, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 2.5, 0, 0, ?)`,
      input.id,
      input.noteId,
      input.front,
      input.back,
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString(),
    );
  } else {
    await db.runAsync(
      "UPDATE flashcards SET front = ?, back = ? WHERE id = ?",
      input.front,
      input.back,
      input.id,
    );
  }
  await enqueueCardOp(db, {
    op,
    cardId: input.id,
    noteId: input.noteId,
    front: input.front,
    back: input.back,
  });
}

export async function deleteLocalCard(db: SQLiteDatabase, cardId: string, noteId: string) {
  await db.runAsync("DELETE FROM flashcards WHERE id = ?", cardId);
  await enqueueCardOp(db, { op: "delete", cardId, noteId });
}

// ---------------------------------------------------------------------------
// Study tab aggregates (all local, offline-safe)
// ---------------------------------------------------------------------------

export type LocalStudySetRef = {
  noteId: string;
  courseId: string;
  noteTitle: string;
  flashcardCount: number;
  quizCount: number;
};

export async function listStudySetNotes(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(`
    SELECT n.id AS note_id, n.course_id AS course_id, n.title AS note_title,
      (SELECT COUNT(*) FROM flashcards f WHERE f.note_id = n.id) AS flashcards,
      (SELECT COUNT(*) FROM quizzes q WHERE q.note_id = n.id) AS quizzes
    FROM notes n
    WHERE EXISTS (SELECT 1 FROM flashcards f WHERE f.note_id = n.id)
       OR EXISTS (SELECT 1 FROM quizzes q WHERE q.note_id = n.id)
    ORDER BY n.updated_at DESC
  `);
  return rows.map((row): LocalStudySetRef => ({
    noteId: String(row.note_id),
    courseId: String(row.course_id),
    noteTitle: String(row.note_title),
    flashcardCount: Number(row.flashcards ?? 0),
    quizCount: Number(row.quizzes ?? 0),
  }));
}

function dayKey(iso: string) {
  // Local-day bucket (the student's reminder timezone, not UTC).
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${date.getDate()}`;
}

/** Consecutive study days ending today or yesterday, from reviews + attempts. */
export async function computeStreak(db: SQLiteDatabase) {
  const reviewRows = await db.getAllAsync<{ reviewed_at: string }>(
    "SELECT reviewed_at FROM reviews",
  );
  const attemptRows = await db.getAllAsync<{ finished_at: string }>(
    "SELECT finished_at FROM quiz_attempts WHERE state IN ('marked', 'pending_marking')",
  );
  const days = new Set<string>();
  for (const row of reviewRows) {
    const key = dayKey(row.reviewed_at);
    if (key) days.add(key);
  }
  for (const row of attemptRows) {
    const key = dayKey(row.finished_at);
    if (key) days.add(key);
  }
  let streak = 0;
  const cursor = new Date();
  // A streak survives until yesterday; today only breaks it if it passes.
  for (let index = 0; index < 365; index += 1) {
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const key = `${cursor.getFullYear()}-${month}-${String(cursor.getDate()).padStart(2, "0")}`;
    if (days.has(key)) {
      streak += 1;
    } else if (index > 0) {
      break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Last-7-days cards reviewed and recall rate (non-lapse grades / graded). */
export async function computeWeeklyProgress(db: SQLiteDatabase) {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const reviewed = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM reviews WHERE reviewed_at >= ?",
    cutoff,
  );
  const graded = await db.getFirstAsync<{ total: number; kept: number }>(
    "SELECT COUNT(*) as total, SUM(CASE WHEN grade != 'again' THEN 1 ELSE 0 END) as kept FROM reviews WHERE reviewed_at >= ?",
    cutoff,
  );
  const quizzes = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM quiz_attempts WHERE finished_at >= ?",
    cutoff,
  );
  const total = graded?.total ?? 0;
  const kept = graded?.kept ?? 0;
  return {
    cardsReviewed: reviewed?.count ?? 0,
    recallPercent: total ? Math.round((kept / total) * 100) : 0,
    quizzesTaken: quizzes?.count ?? 0,
  };
}

/**
 * Account deletion (Privacy-first): remove every trace of the signed-out
 * student from the device. Recording segments and queued uploads reference
 * their files, so those are deleted from disk first, and only then is every
 * local table emptied — a hard reset of the study data while keeping the
 * database itself (and its migrations) intact for a future login.
 */
export async function wipeLocalData(db: SQLiteDatabase) {
  const paths = new Set<string>();
  for (const row of await db.getAllAsync<{ path: string }>(
    "SELECT path FROM recording_segments",
  )) {
    if (row.path) paths.add(row.path);
  }
  for (const row of await db.getAllAsync<{ local_path: string }>(
    "SELECT local_path FROM upload_queue",
  )) {
    if (row.local_path) paths.add(row.local_path);
  }
  for (const path of paths) {
    try {
      new File(path).delete();
    } catch {
      // Already gone — nothing to clean up.
    }
  }
  await db.execAsync(`
    DELETE FROM card_queue;
    DELETE FROM reviews;
    DELETE FROM quiz_attempts;
    DELETE FROM quiz_questions;
    DELETE FROM quizzes;
    DELETE FROM flashcards;
    DELETE FROM generation_queue;
    DELETE FROM chat_messages;
    DELETE FROM upload_queue;
    DELETE FROM recording_segments;
    DELETE FROM recording_sessions;
    DELETE FROM sync_queue;
    DELETE FROM notes;
    DELETE FROM courses;
    DELETE FROM settings;
  `);
}
