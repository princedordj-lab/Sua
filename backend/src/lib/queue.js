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

/**
 * Accept a Redis URI directly, or an Upstash CLI connection command copied
 * from its dashboard (for example: redis-cli --tls -u redis://...).
 * The latter's --tls flag must become rediss:// for ioredis to use TLS.
 */
export function redisConnectionUrl(raw = process.env.REDIS_URL) {
  if (!raw) throw new Error("REDIS_URL is not set");
  let value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  let candidate = value;
  let tlsRequested = false;
  if (/^redis-cli(?:\s|$)/i.test(value)) {
    const urlArg = value.match(/(?:^|\s)(?:-u|--url)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    candidate = urlArg?.[1] ?? urlArg?.[2] ?? urlArg?.[3];
    tlsRequested = /(?:^|\s)--tls(?:\s|$)/i.test(value);
    if (!candidate) {
      throw new Error("REDIS_URL contains a redis-cli command without a -u Redis URL");
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("REDIS_URL must be a redis:// or rediss:// URL (or an Upstash redis-cli command with -u)");
  }
  if (!parsed.hostname || !["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error("REDIS_URL must use redis:// or rediss:// and include a host");
  }
  if (tlsRequested && parsed.protocol === "redis:") parsed.protocol = "rediss:";
  return parsed.toString();
}

function connection() {
  if (!cached) {
    cached = new Ioredis(redisConnectionUrl(), {
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
