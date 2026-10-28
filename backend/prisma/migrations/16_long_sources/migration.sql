-- Long-file pipeline: resumable page-wise extraction into source_chunks,
-- split-mode note provenance on notes, SRS-friendly card retirement and
-- client progress counters on jobs. All additive; no existing column changes.

-- Extract-state columns on assets -----------------------------------------
ALTER TABLE "assets" ADD COLUMN "extractState" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "assets" ADD COLUMN "pagesDone" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "pagesTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "nextPage" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "assets" ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN "ocrPages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "extractErrorCode" TEXT;
CREATE INDEX "assets_extractState_idx" ON "assets"("extractState");

-- Source chunks: one row per extracted page/slide/segment ------------------
CREATE TABLE "source_chunks" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "sectionId" TEXT,
    "label" TEXT,
    "startPage" INTEGER,
    "endPage" INTEGER,
    "text" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "digest" JSONB,
    "digestPromptVersion" TEXT,
    "digestModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "source_chunks_assetId_index_idx" ON "source_chunks"("assetId", "index");
CREATE INDEX "source_chunks_assetId_status_idx" ON "source_chunks"("assetId", "status");
CREATE INDEX "source_chunks_hash_idx" ON "source_chunks"("hash");
CREATE INDEX "source_chunks_userId_idx" ON "source_chunks"("userId");

ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_chunks" FORCE ROW LEVEL SECURITY;

CREATE POLICY "source_chunks_select_own" ON "source_chunks"
  FOR SELECT USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "source_chunks_insert_own" ON "source_chunks"
  FOR INSERT WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "source_chunks_update_own" ON "source_chunks"
  FOR UPDATE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  ) WITH CHECK (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
CREATE POLICY "source_chunks_delete_own" ON "source_chunks"
  FOR DELETE USING (
    "userId" IN (SELECT "id" FROM "users"
      WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

-- Split-mode provenance on notes -------------------------------------------
ALTER TABLE "notes" ADD COLUMN "sourceAssetId" TEXT;
ALTER TABLE "notes" ADD COLUMN "groupId" TEXT;
ALTER TABLE "notes" ADD COLUMN "partIndex" INTEGER;
CREATE INDEX "notes_groupId_idx" ON "notes"("groupId");
ALTER TABLE "notes" ADD CONSTRAINT "notes_sourceAssetId_fkey"
  FOREIGN KEY ("sourceAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SRS-preserving card retirement -------------------------------------------
ALTER TABLE "flashcards" ADD COLUMN "retiredAt" TIMESTAMP(3);

-- Client progress counters on jobs ------------------------------------------
ALTER TABLE "jobs" ADD COLUMN "progressDone" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "progressTotal" INTEGER NOT NULL DEFAULT 0;
