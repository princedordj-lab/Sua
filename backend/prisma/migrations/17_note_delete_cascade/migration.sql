-- Real note deletion.
--
-- Assets and quizzes used to survive their note with a NULL noteId
-- (ON DELETE SET NULL), which kept extracted source text, quiz questions and
-- attempts alive after the student deleted the note. Both now cascade, so a
-- single note delete removes every Postgres row it owns.
--
-- Storage objects live outside Postgres, so their keys are recorded here when
-- the object delete fails; the jobs tick janitor retries with backoff.

ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_noteId_fkey";
ALTER TABLE "assets" ADD CONSTRAINT "assets_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quizzes" DROP CONSTRAINT IF EXISTS "quizzes_noteId_fkey";
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "storage_deletions" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "provider"      TEXT NOT NULL DEFAULT 'cloudinary',
  "publicId"      TEXT NOT NULL,
  "resourceType"  TEXT NOT NULL DEFAULT 'raw',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "lastError"     TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "storage_deletions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "storage_deletions_nextAttemptAt_idx"
  ON "storage_deletions"("nextAttemptAt");

-- Same policy shape as the other user-owned tables: scope through users.clerkId.
ALTER TABLE "storage_deletions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_deletions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "storage_deletions_own" ON "storage_deletions" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
