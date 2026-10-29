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
import { runJobs } from "./lib/runner.js";
import { extractNext } from "./lib/extraction.js";
import { pruneNoteTombstones, retryStorageDeletions } from "./lib/note-deletion.js";
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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
async function handleTick(req, res) {
  if (!checkCronAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const maxJobs = Math.min(10, Math.max(1, Number(req.query?.maxJobs ?? 5)));
    const budgetMs = Math.min(270_000, Math.max(10_000, Number(req.query?.budgetMs ?? 240_000)));
    const result = await runJobs({ maxJobs, budgetMs });
    // Extraction is separate from generation jobs: pending/partial assets
    // resume here with their own (smaller) time budget per pass.
    const maxAssets = Math.min(5, Math.max(1, Number(req.query?.maxAssets ?? 2)));
    const extractBudgetMs = Math.min(
      200_000,
      Math.max(15_000, Number(req.query?.extractBudgetMs ?? 120_000)),
    );
    const extraction = await extractNext({ maxAssets, budgetMs: extractBudgetMs });
    // Deletion housekeeping: retry object deletes that failed with their note,
    // and drop tombstones no device can still need. Neither may fail the tick.
    const storage = await retryStorageDeletions({ limit: 10 }).catch((error) => {
      console.warn("Storage deletion retry failed:", error?.message ?? error);
      return null;
    });
    const tombstones = await pruneNoteTombstones()
      .then((count) => ({ pruned: count }))
      .catch((error) => {
        console.warn("Tombstone prune failed:", error?.message ?? error);
        return null;
      });
    res.json({ ok: true, ...result, extraction, janitor: { storage, tombstones } });
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
