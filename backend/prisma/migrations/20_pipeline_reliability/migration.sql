ALTER TABLE "jobs" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "ai_calls" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "ai_calls" ADD COLUMN "status" INTEGER;
ALTER TABLE "ai_calls" ADD COLUMN "errorCode" TEXT;
CREATE INDEX "jobs_state_heartbeatAt_idx" ON "jobs"("state", "heartbeatAt");
