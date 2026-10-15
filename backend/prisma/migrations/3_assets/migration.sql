CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secureUrl" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "format" TEXT,
    "resourceType" TEXT NOT NULL DEFAULT 'raw',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "noteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assets_userId_idx" ON "assets"("userId");

ALTER TABLE "assets" ADD CONSTRAINT "assets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assets" FORCE ROW LEVEL SECURITY;

CREATE POLICY "assets_select_own" ON "assets"
  FOR SELECT USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "assets_insert_own" ON "assets"
  FOR INSERT WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "assets_update_own" ON "assets"
  FOR UPDATE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  ) WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "assets_delete_own" ON "assets"
  FOR DELETE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
