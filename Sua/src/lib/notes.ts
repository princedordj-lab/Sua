import type { SQLiteDatabase } from "expo-sqlite";
import { notesApi } from "./api";
import type { ServerNote } from "./types";

export type Note = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: "typed" | "audio" | "file";
  createdAt: string;
  updatedAt: string;
  syncState: "pending" | "synced";
};

export type SyncQueueItem = {
  id: number;
  entity: "note";
  entityId: string;
  operation: "upsert" | "delete";
  payload: string;
  createdAt: string;
};

export async function migrateDb(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
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
}

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    title: String(row.title),
    body: String(row.body),
    sourceType: row.source_type as Note["sourceType"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: row.sync_state as Note["syncState"],
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
  input: Pick<Note, "id" | "courseId" | "title" | "body" | "sourceType">,
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO notes (id, course_id, title, body, source_type, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body,
       updated_at = excluded.updated_at, sync_state = 'pending'`,
    input.id,
    input.courseId,
    input.title,
    input.body,
    input.sourceType,
    now,
    now,
  );
  await db.runAsync(
    "INSERT INTO sync_queue (entity, entity_id, operation, payload, created_at) VALUES ('note', ?, 'upsert', ?, ?)",
    input.id,
    JSON.stringify({ ...input, updatedAt: now }),
    now,
  );
  return getNote(db, input.id);
}

export async function deleteNote(db: SQLiteDatabase, id: string) {
  const now = new Date().toISOString();
  await db.runAsync("DELETE FROM notes WHERE id = ?", id);
  await db.runAsync(
    "INSERT INTO sync_queue (entity, entity_id, operation, payload, created_at) VALUES ('note', ?, 'delete', '{}', ?)",
    id,
    now,
  );
}

export async function pendingSyncCount(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM sync_queue",
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
    await db.runAsync("DELETE FROM notes WHERE course_id = ?", courseId);
  });
}

export async function syncPendingNotes(db: SQLiteDatabase, token: string) {
  const queue = await db.getAllAsync<SyncQueueItem>(
    "SELECT * FROM sync_queue ORDER BY id ASC LIMIT 100",
  );
  if (!queue.length) return 0;
  const changes = queue.map((item) => ({
    operation: item.operation,
    id: item.entityId,
    ...(item.operation === "upsert" ? JSON.parse(item.payload) : {}),
  }));
  const response = await notesApi.sync(token, changes);
  await db.withTransactionAsync(async () => {
    for (const item of queue) {
      if (item.operation === "upsert") {
        await db.runAsync("UPDATE notes SET sync_state = 'synced' WHERE id = ?", item.entityId);
      }
      await db.runAsync("DELETE FROM sync_queue WHERE id = ?", item.id);
    }
  });
  for (const note of response.notes) await upsertSyncedNote(db, note);
  return queue.length;
}

export async function upsertSyncedNote(db: SQLiteDatabase, note: ServerNote) {
  await db.runAsync(
    `INSERT INTO notes (id, course_id, title, body, source_type, created_at, updated_at, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id,
       title = excluded.title, body = excluded.body, source_type = excluded.source_type,
       updated_at = excluded.updated_at, sync_state = 'synced'`,
    note.id,
    note.courseId,
    note.title,
    note.body,
    note.sourceType,
    note.createdAt,
    note.updatedAt,
  );
}

export async function pullCourseNotes(db: SQLiteDatabase, token: string, courseId: string) {
  const notes = await notesApi.listForCourse(token, courseId);
  for (const note of notes) await upsertSyncedNote(db, note);
}
