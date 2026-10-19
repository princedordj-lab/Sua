-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceNoteIds" TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_messages_userId_courseId_createdAt_idx" ON "chat_messages"("userId", "courseId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security mirrors 1_rls: rows scope through the owning user's clerkId.
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY "chat_messages_own" ON "chat_messages" FOR ALL
  USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
