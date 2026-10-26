import { Queue } from "bullmq";
import Ioredis from "ioredis";

/**
 * BullMQ on Redis (Upstash in dev+prod). One queue handles study-set jobs.
 * Retries live at the BullMQ level: 3 attempts with exponential backoff
 * (the PRD's "retry automatically up to 3 times, then show Try again").
 */

// BullMQ 6 reserves ":" for its Redis key namespacing and throws on
// construction ("Queue name cannot contain :"). This name was "sua:study-set",
// which made both the Worker and every enqueue crash, so no job was ever
// consumed. Keep this colon-free.
export const STUDY_QUEUE = "sua-study-set";

// A job that was queued and never picked up for this long is dead (worker or
// Redis down). Shared by the read-time reaper, the submit path and the
// upload-conversion dedupe so all three agree on what "active" means.
export const STALE_QUEUED_MS = 10 * 60_000;
// A run that started and never settled: longer than any real pipeline pass
// (transcription + digest + write + cards), so it is safe to call it dead.
export const STALE_RUNNING_MS = 90 * 60_000;

let cached = null;

export function studyQueueConfigured() {
  return Boolean(process.env.CLOUDFLARE_WORKER_URL || process.env.REDIS_URL);
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
  if (!process.env.REDIS_URL) throw new Error("Redis is not configured");
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

/**
 * Idempotent enqueue with lightweight payload: { jobId, noteId, userId, kind }.
 * Supports Cloudflare Queues via CLOUDFLARE_WORKER_URL, or BullMQ on Redis.
 * Never passes file buffers, base64 strings, or document text in job data.
 */
export async function enqueueStudyJob(payload) {
  const data =
    typeof payload === "object" && payload !== null
      ? {
          jobId: payload.jobId ?? payload.id,
          noteId: payload.noteId,
          userId: payload.userId,
          kind: payload.kind ?? "study_set",
        }
      : { jobId: String(payload) };

  // 1. Cloudflare Workers + Queues bridge
  if (process.env.CLOUDFLARE_WORKER_URL) {
    const url = `${process.env.CLOUDFLARE_WORKER_URL.replace(/\/+$/, "")}/enqueue`;
    const headers = { "Content-Type": "application/json" };
    if (process.env.CLOUDFLARE_WORKER_SECRET) {
      headers["Authorization"] = `Bearer ${process.env.CLOUDFLARE_WORKER_SECRET}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Cloudflare enqueue failed (${response.status}): ${errorText.slice(0, 160)}`);
    }
    return;
  }

  // 2. BullMQ / Redis fallback
  const queue = getStudyQueue();
  const jobKind = data.kind || "study_set";
  await queue.add(jobKind, data, { jobId: `study-${data.jobId}` });
}
