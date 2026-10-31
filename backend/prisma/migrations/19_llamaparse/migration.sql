-- LlamaParse provider state. Additive only: existing extraction columns and
-- the local-first pipeline continue to work when the provider is disabled.

ALTER TABLE "assets" ADD COLUMN "extractProvider" TEXT;
ALTER TABLE "assets" ADD COLUMN "providerFileId" TEXT;
ALTER TABLE "assets" ADD COLUMN "providerJobId" TEXT;
ALTER TABLE "assets" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "assets" ADD COLUMN "providerTier" TEXT;
ALTER TABLE "assets" ADD COLUMN "providerCredits" DOUBLE PRECISION;
ALTER TABLE "assets" ADD COLUMN "providerPagesFailed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "providerPolls" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "providerAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assets" ADD COLUMN "providerSubmittedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "providerNextPollAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "providerError" TEXT;

CREATE INDEX "assets_providerNextPollAt_idx" ON "assets"("providerNextPollAt");
CREATE INDEX "assets_providerJobId_idx" ON "assets"("providerJobId");
