import { Queue } from "bullmq";
import Ioredis from "ioredis";

/**
 * BullMQ on Redis (Upstash in dev+prod). One queue handles study-set jobs.
 * Retries live at the BullMQ level: 3 attempts with exponential backoff
 * (the PRD's "retry automatically up to 3 times, then show Try again").
 */

export const STUDY_QUEUE = "sua:study-set";

let cached = null;

export function studyQueueConfigured() {
  return Boolean(process.env.REDIS_URL);
}

function connection() {
  if (!cached) {
    cached = new Ioredis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      connectTimeout: 10_000,
    });
  }
  return cached;
}

let queue = null;

export function getStudyQueue() {
  if (!studyQueueConfigured()) throw new Error("Redis is not configured");
  if (!queue) {
    queue = new Queue(STUDY_QUEUE, {
      connection: connection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }
  return queue;
}

/** Idempotent enqueue; the jobId ties the BullMQ job to the database row. */
export async function enqueueStudyJob(jobId) {
  const queue = getStudyQueue();
  await queue.add("study_set", { jobId }, { jobId: `study:${jobId}` });
}
