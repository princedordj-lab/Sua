import * as Crypto from "expo-crypto";
import type { SQLiteDatabase } from "expo-sqlite";
import { notesApi } from "./api";
import type { ServerNote, SyncResult } from "./types";

export type NoteSyncState = "pending" | "synced" | "error";

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
  },
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO notes (id, course_id, title, body, source_type, source_ref, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body,
       source_ref = COALESCE(excluded.source_ref, notes.source_ref),
       updated_at = excluded.updated_at, sync_state = 'pending'`,
    input.id,
    input.courseId,
    input.title,
    input.body,
    input.sourceType,
    input.sourceRef ?? null,
    now,
    now,
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
      updatedAt: now,
    }),
    now,
  );
  return getNote(db, input.id);
}

export async function deleteNote(db: SQLiteDatabase, id: string) {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM notes WHERE id = ?", id);
    // Files queued for upload would sync into an orphaned note; drop them too.
    await db.runAsync("DELETE FROM upload_queue WHERE note_id = ?", id);
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
    `INSERT INTO notes (id, course_id, title, body, source_type, transcript, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body, source_type = excluded.source_type,
       updated_at = excluded.updated_at, sync_state = 'synced'`,
    note.id,
    note.courseId,
    note.title,
    note.body,
    note.sourceType,
    // Server notes carry no transcript: keep whatever was extracted locally.
    local?.transcript ?? null,
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
    archived: Boolean(row.archived),
    updatedAt: String(row.updated_at),
  };
}

export async function replaceLocalCourses(
  db: SQLiteDatabase,
  courses: Array<Omit<LocalCourse, "updatedAt">>,
) {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM courses");
    for (const course of courses) {
      await db.runAsync(
        "INSERT INTO courses (id, name, code, colour, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        course.id,
        course.name,
        course.code,
        course.colour,
        course.archived ? 1 : 0,
        now,
      );
    }
  });
}

export async function upsertLocalCourse(db: SQLiteDatabase, course: Omit<LocalCourse, "updatedAt">) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO courses (id, name, code, colour, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code,
       colour = excluded.colour, archived = excluded.archived, updated_at = excluded.updated_at`,
    course.id,
    course.name,
    course.code,
    course.colour,
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
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function enqueueUpload(
  db: SQLiteDatabase,
  input: { noteId: string; kind: UploadKind; localPath: string; format: string; bytes: number },
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
    "INSERT INTO upload_queue (note_id, kind, local_path, format, bytes, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
    input.noteId,
    input.kind,
    input.localPath,
    input.format,
    input.bytes,
    now,
    now,
  );
  return Number(result.lastInsertRowId);
}

// Everything not yet uploaded — including rows stuck in 'uploading' from a
// crash, which are reset by the flusher.
export async function listUploadQueue(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "SELECT * FROM upload_queue WHERE state != 'uploaded' ORDER BY id ASC",
  );
  return rows.map(rowToUpload);
}

export async function updateUploadState(
  db: SQLiteDatabase,
  id: number,
  patch: { state: UploadState; assetId?: string | null; error?: string | null; bumpAttempts?: boolean },
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE upload_queue SET state = ?, asset_id = COALESCE(?, asset_id), error = ?,
       attempts = attempts + ?, updated_at = ? WHERE id = ?`,
    patch.state,
    patch.assetId ?? null,
    patch.error ?? null,
    patch.bumpAttempts ? 1 : 0,
    now,
    id,
  );
}
