import type { SQLiteDatabase } from "expo-sqlite";

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
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body,
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
