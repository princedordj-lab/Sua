import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev configuration for the Sua backend.
 *
 * The Express API stays on Vercel and only *triggers* runs; document
 * extraction, OCR and AI generation execute on Trigger.dev Cloud. The database
 * (Neon PostgreSQL) and the objects (Neon Object Storage) stay where they are —
 * a task reads them through the same backend modules the API uses.
 *
 * `project` comes from TRIGGER_PROJECT_REF. Do not hardcode a ref or a secret:
 * Vercel environment variables are NOT available here, so the secrets listed in
 * docs/trigger-dev.md must be configured in the Trigger.dev dashboard too.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_missing",
  dirs: ["src/trigger"],
  runtime: "node",
  logLevel: "info",
  // A crashed or transiently failed run retries automatically. Permanent
  // failures abort their own run (AbortTaskRunError) so they are not retried.
  retries: {
    enabled: true,
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 1_800,
  machine: "small-1x",
});
