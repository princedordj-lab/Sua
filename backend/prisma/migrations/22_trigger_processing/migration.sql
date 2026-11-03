-- Trigger.dev document processing state.
--
-- The custom Postgres job queue (FOR UPDATE SKIP LOCKED + Vercel cron) is gone:
-- Trigger.dev Cloud owns scheduling, retries and concurrency. These columns keep
-- the processing state on the existing `jobs` row so the API contract
-- (GET /api/jobs/:id) and every client keep working, and so a duplicate
-- upload-completion or trigger request can never create a second run.
ALTER TABLE "jobs"
  -- Pipeline revision a run was produced with; part of the idempotency key.
  ADD COLUMN IF NOT EXISTS "processingVersion" TEXT NOT NULL DEFAULT 'v1',
  -- uploaded | queued | extracting | ocr_processing | generating | completed | failed | cancelled
  ADD COLUMN IF NOT EXISTS "processingState" TEXT NOT NULL DEFAULT 'queued',
  -- none | submitting | submitted | failed  (the DB-write / trigger-API boundary)
  ADD COLUMN IF NOT EXISTS "triggerState" TEXT NOT NULL DEFAULT 'none',
  -- Stable key for this processing version; unique so concurrent /complete calls
  -- collapse onto one row instead of two jobs.
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  -- Trigger.dev run id (saved after the trigger call returns).
  ADD COLUMN IF NOT EXISTS "runId" TEXT,
  -- Per-material state: { notes: { state, error, at }, summary: {...}, ... }
  ADD COLUMN IF NOT EXISTS "materials" JSONB,
  -- transient | permanent — how the last failure should be handled.
  ADD COLUMN IF NOT EXISTS "errorCategory" TEXT,
  -- AI-ready source text (extracted + normalized + condensed) saved once so every
  -- material stage reads it from Postgres: no re-extraction, no repeated digests,
  -- and no document text in a Trigger.dev payload.
  ADD COLUMN IF NOT EXISTS "sourceText" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceMeta" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "jobs_idempotencyKey_key" ON "jobs" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS "jobs_runId_idx" ON "jobs" ("runId");
CREATE INDEX IF NOT EXISTS "jobs_processingState_idx" ON "jobs" ("processingState", "updatedAt");
