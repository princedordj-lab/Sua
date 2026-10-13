CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'typed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notes_userId_updatedAt_idx" ON "notes"("userId", "updatedAt");
CREATE INDEX "notes_courseId_updatedAt_idx" ON "notes"("courseId", "updatedAt");

ALTER TABLE "notes" ADD CONSTRAINT "notes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "notes_select_own" ON "notes"
  FOR SELECT USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "notes_insert_own" ON "notes"
  FOR INSERT WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "notes_update_own" ON "notes"
  FOR UPDATE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  ) WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "notes_delete_own" ON "notes"
  FOR DELETE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
