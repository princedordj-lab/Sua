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

app.use((err, _req, res, _next) => {
  const status = Number(err.status ?? err.statusCode ?? 500);
  if (status >= 500) {
    console.error("Internal server error:", err);
    return res
      .status(status)
      .json({ error: "Something went wrong. Please try again in a moment." });
  }
  res.status(status).json({ error: err.message ?? "Request failed" });
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
