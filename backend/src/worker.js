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

const worker = new Worker(
  STUDY_QUEUE,
  async (bullJob) => {
    const { jobId } = bullJob.data;
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
