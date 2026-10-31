// Read-only pipeline diagnosis: which stage a job is on, which checkpoint
// work exists, and where its model calls went. Never prints note text.
//
//   cd backend && npm run diagnose:jobs
//   cd backend && npm run diagnose:jobs -- --days 7
//   cd backend && npm run diagnose:jobs -- --job <jobId>

import "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const days = Math.max(1, Number(valueOf("--days", 30)) || 30);
const targetJob = valueOf("--job", null);
const since = new Date(Date.now() - days * 864e5);

const jobs = await prisma.job.findMany({
  where: targetJob ? { id: targetJob } : { createdAt: { gte: since } },
  orderBy: { createdAt: "desc" },
  take: targetJob ? 1 : 60,
  select: {
    id: true,
    kind: true,
    state: true,
    stage: true,
    attempts: true,
    maxAttempts: true,
    progressDone: true,
    progressTotal: true,
    error: true,
    errorCode: true,
    createdAt: true,
    updatedAt: true,
    startedAt: true,
    heartbeatAt: true,
    runAfter: true,
    lockedUntil: true,
    checkpoint: true,
    note: {
      select: {
        title: true,
        aiState: true,
        assets: {
          select: {
            kind: true,
            format: true,
            extractState: true,
            pagesDone: true,
            pagesTotal: true,
            truncated: true,
            extractProvider: true,
            bytes: true,
          },
        },
      },
    },
  },
});

const now = Date.now();
for (const job of jobs) {
  const cp = job.checkpoint ?? {};
  const reduce = Object.keys(cp.reduce ?? {});
  const calls = await prisma.aiCall.groupBy({
    by: ["step"],
    where: { jobId: job.id },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true, durationMs: true },
  });
  console.log(
    JSON.stringify({
      job: job.id,
      kind: job.kind,
      state: job.state,
      stage: job.stage,
      attempts: `${job.attempts}/${job.maxAttempts}`,
      progress: `${job.progressDone}/${job.progressTotal}`,
      ageMin: Math.round((now - new Date(job.createdAt).getTime()) / 60000),
      heartbeatAgeSec: job.heartbeatAt
        ? Math.round((now - new Date(job.heartbeatAt).getTime()) / 1000)
        : null,
      runAfterInSec: Math.round((new Date(job.runAfter).getTime() - now) / 1000),
      lockedInSec: job.lockedUntil
        ? Math.round((new Date(job.lockedUntil).getTime() - now) / 1000)
        : null,
      error: job.error ? String(job.error).slice(0, 140) : null,
      errorCode: job.errorCode,
      digests: Object.keys(cp.digests ?? {}).length,
      digestFailures: Object.keys(cp.digestFailures ?? {}).length,
      reduceWaves: reduce.filter((key) => !key.startsWith("overview")).length,
      overviewWaves: reduce.filter((key) => key.startsWith("overview")).length,
      recovery: cp.recovery ?? null,
      rateLimitPasses: cp.rateLimitPasses ?? 0,
      calls: calls.map((call) => ({
        step: call.step,
        count: call._count._all,
        promptTokens: call._sum.promptTokens ?? 0,
        completionTokens: call._sum.completionTokens ?? 0,
        avgMs: call._count._all
          ? Math.round((call._sum.durationMs ?? 0) / call._count._all)
          : null,
      })),
      note: {
        title: (job.note?.title ?? "").slice(0, 50),
        aiState: job.note?.aiState,
        assets: (job.note?.assets ?? []).map(
          (asset) =>
            `${asset.kind}/${asset.format}/${asset.extractState}/${asset.pagesDone}of${asset.pagesTotal}` +
            `${asset.truncated ? "/trunc" : ""}/${asset.extractProvider ?? "-"}/${asset.bytes}b`,
        ),
      },
    }),
  );
}

await prisma.$disconnect();
