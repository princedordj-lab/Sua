-- Push notifications across both clients.
--
-- Mobile keeps using `push_tokens` (Expo Push). Web Push needs a second row
-- shape: the browser subscription (endpoint + p256dh/auth keys) rather than a
-- provider-issued token. Reminder preferences are per user so the daily tick
-- can decide when the web reminder is due.

-- Push tokens always carried a platform, but the API never sent one and the
-- column had no default, so every mobile registration failed. The default
-- keeps any pre-existing row valid; new rows always get the real value.
ALTER TABLE "push_tokens" ALTER COLUMN "platform" SET DEFAULT 'android';

CREATE TABLE "web_push_subscriptions" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "endpoint"       TEXT NOT NULL,
    "p256dh"         TEXT NOT NULL,
    "auth"           TEXT NOT NULL,
    "expirationTime" TIMESTAMP(3),
    "userAgent"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_settings" (
    "userId"             TEXT NOT NULL,
    "remindersEnabled"   BOOLEAN NOT NULL DEFAULT false,
    "reminderTime"       TEXT NOT NULL DEFAULT '18:00',
    "timezone"           TEXT NOT NULL DEFAULT 'UTC',
    "lastReminderSentAt" TIMESTAMP(3),
    "lastDueCount"       INTEGER NOT NULL DEFAULT 0,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "web_push_subscriptions_endpoint_key"
  ON "web_push_subscriptions"("endpoint");
CREATE INDEX "web_push_subscriptions_userId_idx"
  ON "web_push_subscriptions"("userId");

ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policy shape as push_tokens: scope through users.clerkId.
ALTER TABLE "web_push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "web_push_subscriptions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "web_push_subscriptions_own" ON "web_push_subscriptions" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "notification_settings_own" ON "notification_settings" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
