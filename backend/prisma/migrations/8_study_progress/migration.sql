-- Study progress: personal review logs and quiz attempts (synced from the app),
-- plus a payload column for the quiz_marking job kind.
ALTER TABLE "jobs" ADD COLUMN "payload" TEXT;

-- CreateTable
CREATE TABLE "review_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "prevIntervalDays" DOUBLE PRECISION NOT NULL,
    "newIntervalDays" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'local',
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_logs_userId_reviewedAt_idx" ON "review_logs"("userId", "reviewedAt");

-- CreateIndex
CREATE INDEX "review_logs_cardId_idx" ON "review_logs"("cardId");

-- CreateIndex
CREATE INDEX "quiz_attempts_userId_finishedAt_idx" ON "quiz_attempts"("userId", "finishedAt");

-- CreateIndex
CREATE INDEX "quiz_attempts_quizId_idx" ON "quiz_attempts"("quizId");

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "flashcards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security mirrors 5_ai_pipeline: rows scope to the owning user's clerkId.
ALTER TABLE "review_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_attempts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "review_logs_own" ON "review_logs" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "quiz_attempts_own" ON "quiz_attempts" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
