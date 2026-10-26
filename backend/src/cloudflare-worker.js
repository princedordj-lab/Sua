import { processJob } from "./lib/pipeline.js";
import { prisma } from "./config/prisma.js";

const ALLOWED_JOB_KINDS = ["study_set", "lecture_note", "course_reference"];
const MIN_NOTE_CHARS = 40;

function syncEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

export default {
  /**
   * HTTP Endpoint: Vercel calls this to enqueue study jobs into Cloudflare Queues.
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "Sua Cloudflare AI Worker",
          queue: "sua-study-set",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/enqueue" && request.method === "POST") {
      if (env.WORKER_SECRET) {
        const auth = request.headers.get("Authorization") ?? "";
        if (auth !== `Bearer ${env.WORKER_SECRET}`) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { jobId, noteId, userId, kind = "study_set" } = payload ?? {};
      if (!jobId) {
        return new Response(JSON.stringify({ error: "jobId is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (kind && !ALLOWED_JOB_KINDS.includes(kind)) {
        return new Response(
          JSON.stringify({ error: `Disallowed job kind: ${kind}` }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      if (!env.STUDY_QUEUE) {
        return new Response(
          JSON.stringify({ error: "STUDY_QUEUE binding is not configured" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      await env.STUDY_QUEUE.send({
        jobId,
        noteId,
        userId,
        kind,
      });

      return new Response(
        JSON.stringify({ ok: true, jobId, kind }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },

  /**
   * Queue Consumer: Wakes up when a message is queued and processes the AI job.
   * Runs in the standard Cloudflare Unbound invocation window (up to 15 minutes).
   */
  async queue(batch, env, _ctx) {
    syncEnv(env);

    for (const message of batch.messages) {
      const { jobId, noteId, userId, kind } = message.body ?? {};
      if (!jobId) {
        console.warn("Queue message missing jobId; acknowledging and skipping.");
        message.ack();
        continue;
      }

      const declaredKind = kind;
      if (declaredKind && !ALLOWED_JOB_KINDS.includes(declaredKind)) {
        console.warn(`Job ${jobId} rejected: disallowed kind "${declaredKind}"`);
        await prisma.job
          .updateMany({
            where: { id: jobId },
            data: {
              state: "failed",
              stage: "failed",
              error: `Disallowed job kind: ${declaredKind}`,
              finishedAt: new Date(),
            },
          })
          .catch(() => {});
        message.ack();
        continue;
      }

      // Check note ownership and guard minimum characters
      try {
        const job = await prisma.job.findUnique({
          where: { id: jobId },
          include: {
            note: { include: { assets: true } },
            user: { select: { id: true } },
          },
        });

        if (!job) {
          console.warn(`Job ${jobId} row not found in database; acknowledging.`);
          message.ack();
          continue;
        }

        if (job.state === "done") {
          message.ack();
          continue;
        }

        const expectedUserId = userId || job.userId;
        const expectedNoteId = noteId || job.noteId;
        if (!job.note || job.note.id !== expectedNoteId) {
          throw new Error(`Note ${expectedNoteId} not found for job ${jobId}`);
        }
        if (job.note.userId !== expectedUserId) {
          throw new Error(`Note ${expectedNoteId} does not belong to user ${expectedUserId}`);
        }

        // Validate note length for typed notes without media assets or prior transcript
        const hasMedia = job.note.assets && job.note.assets.some((a) => a.status === "active");
        const hasTranscript = Boolean(job.note.transcript && job.note.transcript.trim());
        if (!hasMedia && !hasTranscript) {
          const normalizedBody = String(job.note.body ?? "").trim();
          if (normalizedBody.length < MIN_NOTE_CHARS) {
            console.warn(`Job ${jobId} aborted: note body too short (${normalizedBody.length} chars)`);
            const errorMessage = "Note content is too short (minimum 40 characters required).";
            await prisma.job
              .updateMany({
                where: { id: jobId },
                data: {
                  state: "failed",
                  stage: "failed",
                  error: errorMessage,
                  finishedAt: new Date(),
                },
              })
              .catch(() => {});
            await prisma.note
              .updateMany({
                where: { id: job.note.id },
                data: { aiState: "failed" },
              })
              .catch(() => {});
            message.ack();
            continue;
          }
        }

        const started = Date.now();
        await processJob(jobId);
        console.log(`Cloudflare Worker processed job ${jobId} in ${Date.now() - started}ms`);
        message.ack();
      } catch (error) {
        console.error(
          `Cloudflare Worker failed job ${jobId} (attempt ${message.attempts}): ${error?.message ?? error}`,
        );
        // Let Cloudflare Queues retry according to max_retries
        message.retry();
      }
    }
  },
};
