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

app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN === "*" ? true : process.env.CORS_ORIGIN,
  }),
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
  console.error(`[api-error] method=${req.method} path=${safePath} name=${name} prismaCode=${prismaCode}${constraint}`);
  if (err?.status === 409 && err?.code === "ACCOUNT_CONFLICT") {
    return res.status(409).json({ error: "ACCOUNT_CONFLICT", message: err.message });
  }
  res.status(500).json({ error: "INTERNAL", message: "Something went wrong" });
});

// Export for Vercel serverless function
export default app;

// Start server locally if not running on Vercel
if (!process.env.VERCEL) {
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
