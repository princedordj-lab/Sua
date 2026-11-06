/**
 * Server-side rescue sweep — the backstop that keeps client polls from being
 * the only thing that moves stalled work.
 *
 * The recovery story used to rest entirely on "the student is looking at the
 * screen": note reads and job polls kicked extraction and re-submitted runs.
 * Correct as Mann when the app is open, but an app closed mid-upload left
 * assets parked until the student returned — and a plain upload stuck in
 * `extractState: 'running'` after a frozen pass had no rescuer at all.
 *
 * This sweep asks the same questions the poll-driven rescuers ask (the claim
 * SQL for assets, `needsResubmit` for jobs) and is safe to call from anywhere
 * the poll path calls from: the daily jobs tick, or a future tighter cron.
 * Everything funnels through the same two entry points — `extractNext` and
 * `retryProcessing` — so there is exactly one resume mechanism, not seven.
 *
 * Runs with direct prisma (cross-user infrastructure work, like the rest of
 * lib/processing) and never touches provider I/O for a job it did not claim.
 */

import { prisma } from "../../config/prisma.js";
import { extractNext, extractionDeps } from "../extraction.js";
import { longDoc } from "../../config/ai-pipeline.js";
import { PROCESSING_STATES } from "./state.js";
import { needsResubmit, processingConfigured, retryProcessing } from "./start.js";

/** Everything the sweep reaches outside itself; tests replace all of it. */
export const sweepDeps = {
  db: prisma,
  extractNext,
  needsResubmit,
  retryProcessing,
  processingConfigured,
  longDoc,
};

function depsOf(overrides = {}) {
  return { ...sweepDeps, ...overrides };
}

// Bounded by design: the sweep is a `minPhaseMs`-guarded phase of a shared
// invocation budget, so it must never be the pass that overruns the function.
const MAX_EXTRACT_ASSETS = 3;
const MAX_JOB_RETRIES = 5;
// Read a little more than we act on so needsResubmit's predicate (age, lease,
// failure category) is applied in code.
const JOB_SCAN_MULTIPLE = 3;

/**
 * One sweep pass.
 *
 * @param {object} [options]
 * @param {object} [options.db]        Prisma client (tests inject a mock).
 * @param {number|null} [options.deadline] Wall-clock ms the sweep must stop at.
 * @param {number} [options.maxAssets]
 * @param {number} [options.maxJobRetries]
 * @returns {{ extractionPasses: number, jobsRecovered: string[], scanned: number }}
 */
export async function resumeStalledWork({
  deadline = null,
  maxAssets = MAX_EXTRACT_ASSETS,
  maxJobRetries = MAX_JOB_RETRIES,
  overrides = {},
} = {}) {
  const deps = depsOf(overrides);
  const db = deps.db;
  const startedAt = Date.now();
  if (!deps.processingConfigured()) {
    return { extractionPasses: 0, jobsRecovered: [], scanned: 0 };
  }

  // 1. Extraction claims: pending / partial assets, provider parses past their
  // poll backoff, passes abandoned by a frozen instance (stale `running`).
  // The claim SQL itself decides claimability; duplicates are locked out.
  const budgetMs = Math.min(
    deps.longDoc.extractBudgetMs,
    deadline ? Math.max(30_000, deadline - startedAt) : deps.longDoc.extractBudgetMs,
  );
  const extraction = await deps
    .extractNext({ maxAssets, budgetMs, deps: { ...extractionDeps, db } })
    .catch((error) => {
      console.warn(`[sweep] extraction pass failed: ${error?.message ?? error}`);
      return { passes: 0 };
    });

  // 2. Processing rows: interrupted runs (queued/extracting/…, unlocked, idle)
  // and transient failures past their cooldown. Permanent failures never
  // re-run from here — only the student's explicit Try again does.
  const idle = new Date(startedAt - 60_000);
  const candidates = await db.job
    .findMany({
      where: {
        processingState: {
          in: [
            PROCESSING_STATES.queued,
            PROCESSING_STATES.extracting,
            PROCESSING_STATES.ocr,
            PROCESSING_STATES.generating,
            PROCESSING_STATES.failed,
          ],
        },
        updatedAt: { lt: idle },
      },
      orderBy: { updatedAt: "asc" },
      take: maxJobRetries * JOB_SCAN_MULTIPLE,
      select: {
        id: true,
        noteId: true,
        kind: true,
        processingState: true,
        triggerState: true,
        lockedUntil: true,
        errorCategory: true,
        updatedAt: true,
        createdAt: true,
      },
    })
    .catch((error) => {
      console.warn(`[sweep] job scan failed: ${error?.message ?? error}`);
      return [];
    });

  const retried = [];
  for (const job of candidates) {
    if (retried.length >= maxJobRetries) break;
    if (deadline && Date.now() >= deadline) break;
    if (!(await deps.needsResubmit(job))) continue;
    const result = await deps.retryProcessing(job.id).catch((error) => {
      console.warn(`[sweep] job ${job.id} re-submit failed: ${error?.message ?? error}`);
      return null;
    });
    if (result?.triggered) retried.push(job.id);
  }

  console.log(
    `[sweep] extractionPasses=${extraction.passes ?? 0} jobsRecovered=${retried.length} scanned=${candidates.length} ms=${Date.now() - startedAt}`,
  );
  return {
    extractionPasses: extraction.passes ?? 0,
    jobsRecovered: retried,
    scanned: candidates.length,
  };
}
