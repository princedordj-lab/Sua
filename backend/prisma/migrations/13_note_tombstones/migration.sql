-- Deletion tombstones.
--
-- Notes are deleted by the device and pushed as a "delete" change. Without a
-- record of the deletion a late (or concurrently-sent) upsert for the same id
-- recreates the row, and the note reappears on the next pull. One row per
-- deleted note id makes that impossible: /notes/sync refuses to create a
-- tombstoned id and answers "deleted" so the device can drop it too.

CREATE TABLE "note_tombstones" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "note_tombstones_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "note_tombstones_userId_deletedAt_idx"
  ON "note_tombstones"("userId", "deletedAt");

ALTER TABLE "note_tombstones"
  ADD CONSTRAINT "note_tombstones_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policy shape as the other user-owned tables: scope through users.clerkId.
ALTER TABLE "note_tombstones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_tombstones" FORCE ROW LEVEL SECURITY;

CREATE POLICY "note_tombstones_select_own" ON "note_tombstones"
  FOR SELECT USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "note_tombstones_insert_own" ON "note_tombstones"
  FOR INSERT WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "note_tombstones_update_own" ON "note_tombstones"
  FOR UPDATE USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "note_tombstones_delete_own" ON "note_tombstones"
  FOR DELETE USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
