import "./config/env.js";
import { prisma } from "./config/prisma.js";
import { runJobs } from "./lib/runner.js";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — the worker cannot run.");
  process.exit(1);
}

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 3000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
let running = true;

console.log(`Sua AI local worker started (polling Postgres queue every ${POLL_INTERVAL_MS}ms, batch size ${CONCURRENCY})`);

async function poll() {
  while (running) {
    try {
      await runJobs({ maxJobs: CONCURRENCY, budgetMs: 30_000 });
    } catch (err) {
      console.warn("Worker poll iteration error:", err?.message ?? err);
    }
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

poll();

const shutdown = async () => {
  console.log("Shutting down worker…");
  running = false;
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
