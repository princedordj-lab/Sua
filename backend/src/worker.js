import "./config/env.js";
import { Worker } from "bullmq";
import Ioredis from "ioredis";
import { prisma } from "./config/prisma.js";
import { processJob } from "./lib/pipeline.js";
import { redisConnectionUrl, STUDY_QUEUE } from "./lib/queue.js";

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is not set — the worker cannot run.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — the worker cannot run.");
  process.exit(1);
}

// One shared Redis connection for the worker; con-neutral for BullMQ.
const connection = new Ioredis(redisConnectionUrl(), {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  connectTimeout: 10_000,
});

export const ALLOWED_JOB_KINDS = [
  "study_set",
  "lecture_note",
  "course_reference",
];

export const MIN_NOTE_CHARS = 40;
export const MAX_NOTE_CHARS = 60_000;

const worker = new Worker(
  STUDY_QUEUE,
  async (bullJob) => {
    const { jobId, noteId, userId, kind } = bullJob.data ?? {};
    if (!jobId) {
      console.warn("Worker received job without jobId; discarding.");
      return;
    }

    // 1. Validate that the job kind is allowed
    const declaredKind = kind;
    if (declaredKind && !ALLOWED_JOB_KINDS.includes(declaredKind)) {
      console.warn(`Job ${jobId} rejected: disallowed kind "${declaredKind}"`);
      await prisma.job.updateMany({
        where: { id: jobId },
        data: {
          state: "failed",
          stage: "failed",
          error: `Disallowed job kind: ${declaredKind}`,
          finishedAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    // 2. Retrieve job and note from Neon Postgres
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        note: { include: { assets: true } },
        user: { select: { id: true, clerkId: true } },
      },
    });

    if (!job) {
      console.warn(`Job ${jobId} row not found in database; skipping.`);
      return;
    }
    if (job.state === "done") return;

    if (!ALLOWED_JOB_KINDS.includes(job.kind)) {
      console.warn(`Job ${jobId} rejected from DB record: disallowed kind "${job.kind}"`);
      await prisma.job.updateMany({
        where: { id: jobId },
        data: {
          state: "failed",
          stage: "failed",
          error: `Disallowed job kind: ${job.kind}`,
          finishedAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    // 3. Confirm note ownership
    const expectedUserId = userId || job.userId;
    const expectedNoteId = noteId || job.noteId;
    if (!job.note || job.note.id !== expectedNoteId) {
      throw new Error(`Note ${expectedNoteId} not found for job ${jobId}`);
    }
    if (job.note.userId !== expectedUserId) {
      throw new Error(`Note ${expectedNoteId} does not belong to user ${expectedUserId}`);
    }

    // 4. Validate note content length before dispatching to LLM
    // For typed notes without media assets or prior transcript, check body directly.
    const hasMedia = job.note.assets && job.note.assets.some((a) => a.status === "active");
    const hasTranscript = Boolean(job.note.transcript && job.note.transcript.trim());
    if (!hasMedia && !hasTranscript) {
      const normalizedBody = String(job.note.body ?? "").trim();
      if (normalizedBody.length < MIN_NOTE_CHARS) {
        console.warn(`Job ${jobId} aborted: note body too short (${normalizedBody.length} chars)`);
        const errorMessage = "Note content is too short (minimum 40 characters required).";
        await prisma.job.updateMany({
          where: { id: jobId },
          data: {
            state: "failed",
            stage: "failed",
            error: errorMessage,
            finishedAt: new Date(),
          },
        }).catch(() => {});
        await prisma.note.updateMany({
          where: { id: job.note.id },
          data: { aiState: "failed" },
        }).catch(() => {});
        return;
      }
    }

    const started = Date.now();
    try {
      await processJob(jobId);
      console.log(`job ${jobId} completed in ${Date.now() - started}ms`);
    } catch (error) {
      console.warn(
        `job ${jobId} failed (attempt ${bullJob.attemptsMade + 1}/${bullJob.opts.attempts}): ${error?.message ?? error}`,
      );
      if (bullJob.attemptsMade + 1 >= bullJob.opts.attempts) {
        // Exhausted: keep the failure visible to the student as a final state.
        console.warn(`job ${jobId} exhausted all attempts`);
      }
      throw error;
    }
  },
  { connection, concurrency: 2 },
);

worker.on("ready", () =>
  console.log(`Sua AI worker processing ${STUDY_QUEUE} (concurrency 2)`),
);
worker.on("failed", (job, error) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    console.error(`job ${job.id} dropped after retries: ${error.message}`);
  }
});

const shutdown = async () => {
  console.log("Shutting down worker…");
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
