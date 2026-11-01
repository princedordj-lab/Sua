-- Server-authoritative daily app-open streak.
--
-- `user_active_days` stores one row per user per local day the app was opened;
-- it is the source of truth. The columns on `users` cache the recomputed run
-- length for cheap reads and drive the inactivity sweep.

ALTER TABLE "users" ADD COLUMN "streakDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lastActiveDay" TEXT;
ALTER TABLE "users" ADD COLUMN "streakTimezone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "users" ADD COLUMN "streakWarningSentFor" TEXT;

CREATE TABLE "user_active_days" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_active_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_active_days_userId_day_key" ON "user_active_days"("userId", "day");

ALTER TABLE "user_active_days" ADD CONSTRAINT "user_active_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS mirrors 8_study_progress: rows scope to the owning user's clerkId.
ALTER TABLE "user_active_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_active_days" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_active_days_own" ON "user_active_days" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
