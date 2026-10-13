-- Row-level security: users can only access their own records.
-- The app sets app.current_user_id (the Clerk user id) per request inside a
-- transaction via set_config(..., true). Unset/NULL means no rows are visible.

-- Users: scoped to the signed-in Clerk id stored in clerkId.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own" ON "users"
  FOR SELECT USING ("clerkId" = current_setting('app.current_user_id', true));

CREATE POLICY "users_insert_own" ON "users"
  FOR INSERT WITH CHECK ("clerkId" = current_setting('app.current_user_id', true));

CREATE POLICY "users_update_own" ON "users"
  FOR UPDATE USING ("clerkId" = current_setting('app.current_user_id', true))
  WITH CHECK ("clerkId" = current_setting('app.current_user_id', true));

CREATE POLICY "users_delete_own" ON "users"
  FOR DELETE USING ("clerkId" = current_setting('app.current_user_id', true));

-- Courses: scoped through the owning user's clerkId.
ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courses" FORCE ROW LEVEL SECURITY;

CREATE POLICY "courses_select_own" ON "courses"
  FOR SELECT USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "courses_insert_own" ON "courses"
  FOR INSERT WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "courses_update_own" ON "courses"
  FOR UPDATE USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );

CREATE POLICY "courses_delete_own" ON "courses"
  FOR DELETE USING (
    "userId" IN (SELECT "id" FROM "users" WHERE "clerkId" = current_setting('app.current_user_id', true))
  );
