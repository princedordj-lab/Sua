-- Background document extraction state (see lib/extract-runner.js).
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "extractState" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "extractedPages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "totalPages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "extractNextPage" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "extractTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "extractErrorCode" TEXT;

CREATE INDEX IF NOT EXISTS "assets_extractState_idx" ON "assets"("extractState");
