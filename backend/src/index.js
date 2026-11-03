import "./config/env.js";
import express from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import { authenticate } from "./middleware/auth.js";
import { meRouter } from "./routes/me.js";
import { coursesRouter } from "./routes/courses.js";
import { clerkWebhookRouter } from "./routes/webhooks.js";
import { notesRouter } from "./routes/notes.js";
import { assetsRouter, uploadsRouter } from "./routes/uploads.js";
import { jobsRouter } from "./routes/jobs.js";
import { chatRouter } from "./routes/chat.js";
import { timingSafeEqual } from "node:crypto";
import { pruneNoteTombstones, retryStorageDeletions } from "./lib/note-deletion.js";
import { sendDueReminders } from "./lib/reminders.js";
import { sendStreakNotices } from "./lib/streak.js";
import {
  budgetReport,
  minPhaseMs,
  processingBudgetMs,
  remainingMs,
  tickBudgetPlan,
} from "./lib/budget.js";
import { maxPassesPerInvocation } from "./lib/queue.js";
import { prisma } from "./config/prisma.js";
import { studyRouter } from "./routes/study.js";

const app = express();

const port = process.env.PORT || 4000;

// Clerk webhooks need the raw body for svix signature verification, so this
// mount must come before express.json().
app.use(
  "/api/webhooks/clerk",
  express.raw({ type: "application/json" }),
  clerkWebhookRouter,
);

// Voice questions arrive two ways: base64 JSON from mobile (React Native
// cannot build a Blob from raw bytes) and raw audio from the web app. This
// parser has to be mounted before the global JSON parser below, whose 100 kB
// default would reject a clip with a 413.
app.use("/api/chat/speech", express.json({ limit: "8mb" }));

app.use(express.json());


const origins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);



app.use(
  cors({
    origin: origins.length === 0 || origins.includes("*") ? true : origins,
  })
);

// Neons free plan auto-suspends an idle compute; the next query then pays the
// wake-up (~5s+). /api/health is the cheapest recurring touch point (connectivity
// checks, the client's keep-warm ping), so ping the database here: whatever
// calls "is Sua up?" also pre-warms the one resource /api/me is about to need.
// Shape is unchanged and the response stays instant if the DB is unreachable —
// health is about the HTTP service, not the database.
app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
  void prisma
    .$queryRaw`SELECT 1`
    .catch(() => {});
});

// Root stub. Without it, opening the deployment URL shows Express's plain
// "Cannot GET /", which reads like an outage; nothing else is served outside
// /api, so there is nothing to expose here.
app.get("/", (_req, res) => {
  res.json({ service: "Sua API", status: "ok", health: "/api/health" });
});

function checkCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.VERCEL) return false;
    return true;
  }

  const authHeader = req.headers["authorization"] || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearerToken = match ? match[1].trim() : "";
  const customHeader = (req.headers["x-cron-secret"] || "").toString().trim();
  const provided = bearerToken || customHeader;

  if (!provided) return false;

  const expectedBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

// Background cron tick for scheduled job draining in serverless environments.
// Also drives long-file extraction passes: assets stuck in pending/partial
// get another bounded pass here even when no client is polling. Mounted
// before clerkMiddleware so it does not require student session auth.
// Accepts both GET and POST: Vercel cron always sends GET.
//
// One deadline for the whole tick. The phases used to carry three independent
// budgets (240 s + 120 s + the sweeps), so the function could be terminated
// partway through extraction — leaving a claimed lease and a row that looked
// like it was still being read. Now the tick divides a single budget
// (lib/budget.js) and each phase only starts while a useful amount of it is
// left.
async function handleTick(req, res) {
  if (!checkCronAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const startedAt = Date.now();
  const requested = Number(req.query?.budgetMs);
  const totalBudgetMs = Math.min(
    processingBudgetMs(),
    Math.max(minPhaseMs(), Number.isFinite(requested) ? requested : processingBudgetMs()),
  );
  const plan = tickBudgetPlan(totalBudgetMs);
  const deadline = startedAt + totalBudgetMs;
  const left = () => remainingMs(deadline, Date.now());
  const skipped = [];

  try {
    const maxJobs = Math.min(10, Math.max(1, Number(req.query?.maxJobs ?? 5)));

    // Generation first: it is what the student is waiting on, and a pass that
    // runs out mid-stage yields its job back with the checkpoint intact.
    let result = { processed: 0, passes: 0, errors: 0, durationMs: 0 };
    if (left() >= minPhaseMs()) {
      result = await runJobs({
        maxJobs,
        // Untargeted, so one job's passes must not use up the row budget.
        maxPasses: Math.max(maxPassesPerInvocation(), maxJobs),
        budgetMs: Math.min(plan.generationMs, left()),
      });
    } else {
      skipped.push("generation");
    }

    // Extraction is separate from generation jobs: pending/partial assets
    // resume here with the extraction share of the same deadline.
    let extraction = { passes: 0, skipped: true };
    if (left() >= minPhaseMs()) {
      const maxAssets = Math.min(5, Math.max(1, Number(req.query?.maxAssets ?? 2)));
      extraction = await extractNext({
        maxAssets,
        budgetMs: Math.min(plan.extractionMs, left()),
      });
    } else {
      skipped.push("extraction");
    }

    // Deletion housekeeping: retry object deletes that failed with their note,
    // and drop tombstones no device can still need. Neither may fail the tick.
    let storage = null;
    let tombstones = null;
    if (left() >= minPhaseMs()) {
      storage = await retryStorageDeletions({ limit: 10 }).catch((error) => {
        console.warn("Storage deletion retry failed:", error?.message ?? error);
        return null;
      });
      tombstones = await pruneNoteTombstones()
        .then((count) => ({ pruned: count }))
        .catch((error) => {
          console.warn("Tombstone prune failed:", error?.message ?? error);
          return null;
        });
    } else {
      skipped.push("janitor");
    }

    // Web-only daily reminder; mobile schedules its own locally. Never fails
    // the tick, and no-ops when VAPID is unset. Skipped when the deadline is
    // spent: the next tick is a day away, but a killed invocation sends nothing
    // either and also leaves a claimed lease behind.
    let reminders = null;
    if (left() >= minPhaseMs()) {
      reminders =
        process.env.REMINDERS_ENABLED === "0"
          ? null
          : await sendDueReminders().catch((error) => {
              console.warn("Reminder sweep failed:", error?.message ?? error);
              return null;
            });
    } else {
      skipped.push("reminders");
    }
    // Streak sweep: warn after two quiet days, reset after three. The count
    // the app shows is computed on read, so a missed sweep cannot show stale
    // numbers — this only drives the two notifications and the cached row.
    let streakNotices = null;
    if (left() >= minPhaseMs()) {
      streakNotices =
        process.env.STREAK_NOTICES === "0"
          ? null
          : await sendStreakNotices().catch((error) => {
              console.warn("Streak notice sweep failed:", error?.message ?? error);
              return null;
            });
    } else {
      skipped.push("streakNotices");
    }

    res.json({
      ok: true,
      janitor: { storage, tombstones },
      reminders,
      streakNotices,
      budget: { totalMs: totalBudgetMs, plan, usedMs: Date.now() - startedAt, skipped },
    });
  } catch (err) {
    console.error("Tick error:", err);
    res.status(500).json({ error: "Tick failed", message: err?.message ?? String(err) });
  }
}

app.post("/api/internal/jobs/tick", handleTick);
app.get("/api/internal/jobs/tick", handleTick);

app.use(
  clerkMiddleware({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  }),
);

app.use("/api/me", authenticate, meRouter);
app.use("/api/courses", authenticate, coursesRouter);
app.use("/api/notes", authenticate, notesRouter);
app.use("/api/uploads", authenticate, uploadsRouter);
app.use("/api/assets", authenticate, assetsRouter);
app.use("/api/jobs", authenticate, jobsRouter);
app.use("/api/study", authenticate, studyRouter);
// Voice clips post raw audio bodies; express.json ignores non-JSON content.
app.use("/api/chat/speech", express.raw({ type: "audio/*", limit: "8mb" }));
app.use("/api/chat", authenticate, chatRouter);

// Unknown /api paths answer in the same { error } shape as every other
// failure, so a mistyped route never returns Express's HTML page. Mounted
// after all routers and before the error handler.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, _next) => {
  const prismaCode = typeof err?.code === "string" ? err.code : "-";
  const name = String(err?.name ?? "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
  const safePath = String(req.path).replace(/[\r\n\s]/g, "_").slice(0, 160);
  const target = err?.meta?.target;
  const adapter = err?.meta?.driverAdapterError;
  const constraintFields = [];
  if (Array.isArray(target)) constraintFields.push(...target.filter((v) => typeof v === "string"));
  else if (typeof target === "string") constraintFields.push(target);
  for (const value of [adapter?.cause?.constraint, adapter?.constraint]) {
    if (typeof value === "string") constraintFields.push(value);
  }
  for (const values of [adapter?.cause?.fields, adapter?.fields]) {
    if (Array.isArray(values)) constraintFields.push(...values.filter((v) => typeof v === "string"));
  }
  const constraint = prismaCode === "P2002" && constraintFields.length
    ? ` constraint=${[...new Set(constraintFields)].map((v) => v.replace(/[^A-Za-z0-9_.,-]/g, "").slice(0, 100)).join(",")}`
    : "";
  console.error(`[api-error] method=${req.method} path=${safePath} name=${name} prismaCode=${prismaCode}${constraint}:`, err?.message || err);
  // body-parser rejects a body over the mounted limit; answering 413 keeps that
  // a client problem instead of a mystery 500.
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "That file is too large to upload" });
  }
  if (err?.status === 409 && err?.code === "ACCOUNT_CONFLICT") {
    return res.status(409).json({ error: "ACCOUNT_CONFLICT", message: err.message });
  }
  // A transaction that expired before committing, or a connection that never
  // arrived, is this API being out of database capacity — not a defect in the
  // request and not the student's network. Answering a generic 500 made the
  // client's transport-error path claim "check your connection" while the phone
  // was online, so the one failure a retry actually fixes was reported as the
  // one failure a retry can't fix.
  //
  // Both P2028 flavours plus the driver's own acquire timeout, which arrives as
  // a `PrismaClientKnownRequestError`-shaped failure without a P2028 code because
  // pg reported it before a transaction ever started.
  const message = String(err?.message ?? "");
  const capacityLimited =
    err?.code === "P2028" ||
    message.includes("Unable to start a transaction") ||
    message.includes("expired transaction") ||
    message.includes("timeout exceeded when trying to connect");
  if (capacityLimited) {
    res.set("Retry-After", "5");
    return res.status(503).json({
      error: "SERVER_BUSY",
      message: "Sua is busy finishing some database work. Please try again.",
    });
  }
  res.status(500).json({ error: "INTERNAL", message: "Something went wrong" });
});

// Export for Vercel serverless function
export default app;

// Start server locally if not running on Vercel
if (!process.env.VERCEL) {
  // Local development background runner loop
  const devInterval = setInterval(() => {
    runJobs({ maxJobs: 2, budgetMs: 15_000 }).catch((err) => {
      console.warn("[dev-runner] loop error:", err?.message ?? err);
    });
  }, 3000);
  devInterval.unref?.();

  app.listen(port, () => {
    // One line that makes a plan/limit mismatch visible: if this says
    // platformMaxMs=300000 on a project capped at 60 s, every long pass will be
    // killed and the lease has to expire before the work resumes.
    console.log("[budget]", JSON.stringify(budgetReport()));
    if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
      console.warn(
        "CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY not set — authenticated routes will fail.",
      );
    }
    if (
      !process.env.NEON_API_KEY ||
      !process.env.NEON_PROJECT_ID ||
      !process.env.NEON_BRANCH_ID
    ) {
      console.warn(
        "NEON_API_KEY / NEON_PROJECT_ID / NEON_BRANCH_ID not set — Neon upload routes return 503.",
      );
    }
    console.log(`Sua API listening on port ${port}`);
  });
}
