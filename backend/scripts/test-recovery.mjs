import assert from "node:assert/strict";
import {
  PROCESSING_STATES,
  acquireProcessingLease,
  canRetryProcessing,
  extendProcessingLease,
  markMaterial,
  markStage,
  releaseProcessingLease,
} from "../src/lib/processing/state.js";
import { runDirectProcessing } from "../src/lib/processing/orchestrator.js";
import { needsResubmit, retryProcessing } from "../src/lib/processing/start.js";

console.log("=== Running Direct Processing & Recovery Test Suite ===");

function makeMockDb(initialJobs = []) {
  const jobs = new Map(initialJobs.map((j) => [j.id, { ...j }]));
  const assets = new Map();
  const notes = new Map();

  return {
    jobs,
    assets,
    notes,
    job: {
      findUnique: async ({ where }) => {
        const found = jobs.get(where.id);
        if (!found) return null;
        return {
          ...found,
          note: notes.get(found.noteId) ?? { id: found.noteId, courseId: "course-1", assets: [] },
        };
      },
      update: async ({ where, data }) => {
        const current = jobs.get(where.id);
        if (!current) throw new Error("not found");
        const next = { ...current, ...data };
        jobs.set(where.id, next);
        return next;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, item] of jobs.entries()) {
          if (!where.id || where.id === id) {
            jobs.set(id, { ...item, ...data });
            count++;
          }
        }
        return { count };
      },
    },
    asset: {
      findUnique: async ({ where }) => assets.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const current = assets.get(where.id);
        const next = { ...current, ...data };
        assets.set(where.id, next);
        return next;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, item] of assets.entries()) {
          if (!where.id || where.id === id) {
            assets.set(id, { ...item, ...data });
            count++;
          }
        }
        return { count };
      },
    },
    note: {
      findUnique: async ({ where }) => notes.get(where.id) ?? { id: where.id, courseId: "course-1" },
      updateMany: async () => ({ count: 1 }),
    },
  };
}

// 1. Two concurrent processing requests for the same job (lease collision prevention)
{
  const db = makeMockDb([
    {
      id: "job-conc",
      noteId: "note-conc",
      kind: "study_set",
      processingState: "queued",
      lockedUntil: null,
      attempts: 0,
    },
  ]);

  const lease1 = await acquireProcessingLease("job-conc", { leaseMs: 60_000, db });
  assert.equal(lease1.acquired, true, "First request acquires the lease");

  const lease2 = await acquireProcessingLease("job-conc", { leaseMs: 60_000, db });
  assert.equal(lease2.acquired, false, "Second concurrent request is refused the lease");

  await releaseProcessingLease("job-conc", { db });
  const afterRelease = await db.job.findUnique({ where: { id: "job-conc" } });
  assert.equal(afterRelease.lockedUntil, null, "Lease is released cleanly");

  console.log("✓ 1. Concurrent requests cannot claim the same job simultaneously");
}

// 2. Expired processing lease recovery
{
  const pastTime = new Date(Date.now() - 10_000);
  const db = makeMockDb([
    {
      id: "job-expired",
      noteId: "note-1",
      kind: "study_set",
      processingState: "generating",
      lockedUntil: pastTime,
      heartbeatAt: pastTime,
      attempts: 1,
    },
  ]);

  const lease = await acquireProcessingLease("job-expired", { leaseMs: 60_000, db });
  assert.equal(lease.acquired, true, "Expired lease can be acquired for recovery");

  console.log("✓ 2. Expired processing lease is successfully reclaimed");
}

// 3. Repeated status polling is safe and does not duplicate work
{
  const db = makeMockDb([
    {
      id: "job-poll",
      noteId: "note-1",
      kind: "study_set",
      processingState: "generating",
      lockedUntil: new Date(Date.now() + 60_000), // actively locked
      updatedAt: new Date(),
      triggerState: "submitted",
    },
  ]);

  const job = await db.job.findUnique({ where: { id: "job-poll" } });
  assert.equal(await needsResubmit(job), false, "Active locked job does not need resubmit during polling");

  console.log("✓ 3. Repeated status polling on active jobs does not trigger spurious resubmission");
}

// 4. Processing interrupted during extraction resumes cleanly
{
  const db = makeMockDb([
    {
      id: "job-interrupted-extract",
      noteId: "note-1",
      kind: "lecture_note",
      processingState: "extracting",
      lockedUntil: null,
      materials: {},
    },
  ]);
  db.assets.set("asset-1", { id: "asset-1", extractState: "partial" });

  let extractionCalls = 0;
  let sourceCalls = 0;
  let materialCalls = 0;

  const overrides = {
    extractStage: async () => {
      extractionCalls++;
      return { state: "done" };
    },
    sourceStage: async () => {
      sourceCalls++;
      db.jobs.get("job-interrupted-extract").sourceText = "Extracted and prepared source text for testing.";
      return { chars: 50 };
    },
    materialStage: async () => {
      materialCalls++;
      return { state: "done" };
    },
    finalizeStage: async () => ({ state: "completed" }),
  };

  const outcome = await runDirectProcessing("job-interrupted-extract", {
    assetId: "asset-1",
    overrides: { ...overrides, db },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(extractionCalls, 1, "Extraction was resumed and completed");
  assert.equal(sourceCalls, 1, "Source was prepared");
  assert.ok(materialCalls > 0, "Materials were generated");

  console.log("✓ 4. Processing interrupted during extraction resumes and runs to completion");
}

// 5. Processing interrupted during AI generation preserves finished materials
{
  const db = makeMockDb([
    {
      id: "job-interrupted-gen",
      noteId: "note-1",
      kind: "study_set",
      processingState: "generating",
      lockedUntil: null,
      sourceText: "Valid source text already condensed and persisted.",
      materials: {
        summary: { state: "done" },
        flashcards: { state: "pending" },
        quiz: { state: "pending" },
      },
    },
  ]);

  const generatedMaterials = [];
  const overrides = {
    materialStage: async (_jobId, mat) => {
      generatedMaterials.push(mat);
      return { state: "done" };
    },
    finalizeStage: async () => ({ state: "completed" }),
  };

  const outcome = await runDirectProcessing("job-interrupted-gen", {
    overrides: { ...overrides, db },
  });

  assert.equal(outcome.status, "completed");
  assert.ok(generatedMaterials.includes("flashcards"), "Flashcards were generated");
  assert.ok(generatedMaterials.includes("quiz"), "Quiz was generated");

  console.log("✓ 5. Processing interrupted during AI generation resumes and preserves completed materials");
}

// 6. Yielding before function budget ceiling
{
  const db = makeMockDb([
    {
      id: "job-yield",
      noteId: "note-1",
      kind: "lecture_note",
      processingState: "generating",
      lockedUntil: null,
      sourceText: "Prepared text with enough length to be considered ready (40+ chars).",
      materials: {},
    },
  ]);

  const overrides = {
    budgetMs: () => 30_000,
    minCallMs: () => 50_000, // minCallMs > budgetMs => forces immediate yield before material
    materialStage: async () => {
      throw new Error("Should not be called when yielding");
    },
  };

  const outcome = await runDirectProcessing("job-yield", {
    overrides: { ...overrides, db },
  });

  assert.equal(outcome.status, "yielded", "Orchestrator yielded before budget ran out");
  const jobAfter = await db.job.findUnique({ where: { id: "job-yield" } });
  assert.equal(jobAfter.lockedUntil, null, "Lease released on yield for next resumption");

  console.log("✓ 6. Orchestrator yields cleanly when execution budget window is low");
}

// 7. Retry after provider rate limiting (transient vs permanent)
{
  const db = makeMockDb([
    {
      id: "job-ratelimit",
      noteId: "note-1",
      kind: "study_set",
      processingState: "generating",
      lockedUntil: null,
      sourceText: "Prepared text with enough length to be considered ready (40+ chars).",
      materials: {
        summary: { state: "done" },
        flashcards: { state: "pending" },
        quiz: { state: "pending" },
      },
    },
  ]);

  const overrides = {
    materialStage: async (_id, mat) => {
      if (mat === "flashcards") {
        const err = new Error("429 Too Many Requests");
        err.status = 429;
        throw err;
      }
      return { state: "done" };
    },
  };

  await assert.rejects(
    () => runDirectProcessing("job-ratelimit", { overrides: { ...overrides, db } }),
    /429/,
  );

  const jobAfter = await db.job.findUnique({ where: { id: "job-ratelimit" } });
  assert.equal(jobAfter.lockedUntil, null, "Lease is released on transient error");
  assert.equal(jobAfter.errorCategory, "transient", "Failure categorized as transient");
  assert.equal(jobAfter.materials.summary.state, "done", "Summary is still intact");

  console.log("✓ 7. Rate-limited model calls preserve finished materials and release the lease for retry");
}

console.log("\n=== ALL DIRECT PROCESSING & RECOVERY CHECKS PASSED! ===");
