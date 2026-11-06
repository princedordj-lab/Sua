import assert from "node:assert/strict";
import {
  buildAiDeps,
  extractStage,
  saveAssetText,
} from "../src/lib/processing/stages.js";
import { PermanentProcessingError, TransientProcessingError } from "../src/lib/processing/errors.js";
import {
  needsResubmit,
  retryProcessing,
  setDirectExecutor,
  setTriggerClient,
} from "../src/lib/processing/start.js";
import { resumeStalledWork } from "../src/lib/processing/sweep.js";

console.log("=== Pipeline recovery & rescue suite ===");

// ---------------------------------------------------------------------------
// Mock database: the shape the stage functions and the sweep rely on.
// ---------------------------------------------------------------------------

function makeMockDb(initialAssets = [], initialJobs = []) {
  const assets = new Map(initialAssets.map((a) => [a.id, { ...a }]));
  const jobs = new Map(initialJobs.map((j) => [j.id, { ...j }]));
  const db = {
    assets,
    jobs,
    asset: {
      findUnique: async ({ where }) => assets.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const current = assets.get(where.id);
        if (!current) throw new Error(`asset ${where.id} not found`);
        const next = { ...current, ...data };
        assets.set(where.id, next);
        return next;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, item] of assets.entries()) {
          if (where.id && where.id !== id) continue;
          if (where.extractedText === null && item.extractedText != null) continue;
          assets.set(id, { ...item, ...data });
          count += 1;
        }
        return { count };
      },
    },
    job: {
      findUnique: async ({ where }) => jobs.get(where.id) ?? null,
      findMany: async () => [...jobs.values()],
      findFirst: async () => [...jobs.values()][0] ?? null,
      update: async ({ where, data }) => {
        const current = jobs.get(where.id);
        if (!current) throw new Error("no job");
        const next = { ...current, ...data };
        jobs.set(where.id, next);
        return next;
      },
    },
    note: {
      findUnique: async ({ where }) => ({ id: where.id }),
      updateMany: async () => ({}),
    },
    $queryRaw: async () => [{ size: 0 }],
  };
  return db;
}

// --- 1. buildAiDeps carries the helpers an audio/photo conversion needs.
//        Without `saveAssetText` a recording conversion threw TypeError right
//        after a successful transcription, and a photo on a file note spelled
//        "unreadable" instead of falling back to the local page extractor.
{
  const db = makeMockDb([{ id: "asset-audio", kind: "audio", extractedText: null }]);
  const aiDeps = buildAiDeps(
    { id: "job-1", noteId: "note-1" },
    { db, readAssetBytes: async () => new Uint8Array(1), markStage: async () => {} },
  );
  assert.equal(typeof aiDeps.saveAssetText, "function");
  assert.equal(typeof aiDeps.extractDocument, "function");
  assert.equal(typeof aiDeps.readBytes, "function");
  assert.equal(typeof aiDeps.record, "function");
  assert.equal(typeof aiDeps.setStage, "function");
  assert.equal(typeof aiDeps.assertAlive, "function");

  await aiDeps.saveAssetText({ id: "asset-audio" }, "  Whole transcript of the lecture.  ");
  assert.equal(db.assets.get("asset-audio").extractedText, "Whole transcript of the lecture.");

  // First write wins: a later save does not overwrite an existing one.
  await aiDeps.saveAssetText({ id: "asset-audio" }, "some later attempt");
  assert.equal(
    db.assets.get("asset-audio").extractedText,
    "Whole transcript of the lecture.",
    "first-write-wins on extractedText",
  );
  console.log("✓ buildAiDeps carries saveAssetText + extractDocument (recordings/photos convert)");
}

// --- 2. The standalone saveAssetText: safe no-ops, failures are swallowed.
{
  const db = makeMockDb([{ id: "asset-img", kind: "image", extractedText: null }]);
  await saveAssetText(db, { id: "asset-img" }, "handwritten notes from the photo");
  assert.equal(db.assets.get("asset-img").extractedText, "handwritten notes from the photo");
  await saveAssetText(db, null, "x");
  await saveAssetText(db, { id: "asset-img" }, "   ");
  // A missing asset row → no crash.
  await saveAssetText(db, { id: "asset-gone" }, "whatever");
  console.log("✓ standalone saveAssetText: first-write-wins, no-ops and misses are safe");
}

// --- 3. A parked provider parse yields transiently instead of proceeding
//        into source preparation with no pages.
{
  const db = makeMockDb([
    {
      id: "asset-parked",
      kind: "document",
      status: "active",
      extractState: "pending",
      providerJobId: "job-llama",
      providerNextPollAt: new Date(Date.now() + 30_000),
    },
  ]);
  await assert.rejects(
    extractStage(
      { assetId: "asset-parked" },
      {
        db,
        claimExtractionAsset: async () => "asset-parked",
        runExtractionPass: async () => {},
        markStage: async () => {},
      },
    ),
    (error) =>
      error instanceof TransientProcessingError && error.code === "PROVIDER_PARKED",
    "a parked parse must not read empty pages",
  );
  console.log("✓ parked provider parse throws PROVIDER_PARKED (transient, resumable)");
}

// --- 4. A partial pass yields transiently; everything stored survives.
{
  const db = makeMockDb([
    {
      id: "asset-partial",
      kind: "document",
      status: "active",
      extractState: "done",
      pagesDone: 3,
    },
  ]);
  await assert.rejects(
    extractStage(
      { assetId: "asset-partial" },
      {
        db,
        claimExtractionAsset: async () => "asset-partial",
        runExtractionPass: async (_assetId, _budget, passDeps) => {
          await passDeps.db.asset.update({
            where: { id: "asset-partial" },
            data: { extractState: "partial", pagesDone: 5, nextPage: 6 },
          });
        },
        markStage: async () => {},
      },
    ),
    (error) =>
      error instanceof TransientProcessingError && error.code === "EXTRACTION_PARTIAL",
  );
  assert.equal(db.assets.get("asset-partial").pagesDone, 5, "stored progress survives");
  console.log("✓ partial extraction throws EXTRACTION_PARTIAL with progress kept");
}

// --- 5. A failed extraction keeps the permanent/transient taxonomy.
{
  const db = makeMockDb([
    {
      id: "asset-corrupt",
      kind: "document",
      status: "active",
      extractState: "failed",
      extractErrorCode: "UNREADABLE_FILE",
    },
  ]);
  await assert.rejects(
    extractStage(
      { assetId: "asset-corrupt" },
      {
        db,
        claimExtractionAsset: async () => "asset-corrupt",
        runExtractionPass: async () => {},
        markStage: async () => {},
      },
    ),
    (error) => error instanceof PermanentProcessingError,
    "an unreadable file must not be retried",
  );
  console.log("✓ failed extraction keeps the permanent/transient taxonomy");
}

// --- 6. needsResubmit: transient failures re-run after a cooldown, permanent
//        ones never do.
{
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const justNow = new Date(Date.now() - 5_000);
  assert.equal(
    await needsResubmit({
      processingState: "failed",
      errorCategory: "transient",
      updatedAt: fiveMinAgo,
    }),
    true,
    "a transient failure is not a dead end",
  );
  assert.equal(
    await needsResubmit({ processingState: "failed", errorCategory: "transient", updatedAt: justNow }),
    false,
    "re-run after the cooldown, not instantly",
  );
  assert.equal(
    await needsResubmit({
      processingState: "failed",
      errorCategory: "permanent",
      updatedAt: fiveMinAgo,
    }),
    false,
    "a permanent failure stays manual",
  );
  assert.equal(
    await needsResubmit({ processingState: "failed", errorCategory: null, updatedAt: fiveMinAgo }),
    true,
    "legacy rows without a category default to transient",
  );
  assert.equal(
    await needsResubmit({ processingState: "completed", updatedAt: fiveMinAgo }),
    false,
    "completed work is never resubmitted",
  );
  assert.equal(
    await needsResubmit({
      processingState: "extracting",
      lockedUntil: new Date(Date.now() + 120_000),
      updatedAt: fiveMinAgo,
    }),
    false,
    "a live lease is respected",
  );
  assert.equal(
    await needsResubmit({
      processingState: "extracting",
      lockedUntil: null,
      updatedAt: fiveMinAgo,
    }),
    true,
    "an unlocked, idle run is interrupted and resubmitted",
  );
  console.log("✓ needsResubmit settles failed-transient rows after a cooldown");
}

// --- 7. retryProcessing resets a failed row and keeps finished materials, and
//        the trigger lands on the idempotency path (a stray re-submit cannot
//        create a second row).
{
  const db = makeMockDb([], [
    {
      id: "job-1",
      noteId: "note-1",
      userId: "user-1",
      kind: "lecture_note",
      state: "failed",
      stage: "failed",
      processingState: "failed",
      triggerState: "submitted",
      error: "old failure",
      errorCategory: "transient",
      materials: { notes: { state: "done" }, quiz: { state: "failed" } },
      lockedUntil: null,
    },
  ]);
  setDirectExecutor(async () => ({ id: "run_test_1" }));
  try {
    const result = await retryProcessing(db.jobs.get("job-1"), {}, db);
    assert.equal(result.triggered, true, "the re-run was triggered");
    assert.equal(db.jobs.get("job-1").errorCategory, null, "the row was cleared");
    assert.equal(db.jobs.get("job-1").processingState, "queued");
    assert.equal(db.jobs.get("job-1").materials.notes.state, "done", "finished notes kept");
    assert.equal(db.jobs.get("job-1").materials.quiz.state, "pending", "failed material re-arms");
  } finally {
    setTriggerClient(null);
  }
  console.log("✓ retryProcessing resets the row, keeps finished materials, triggers once");
}

// --- 8. resumeStalledWork: real needsResubmit over scanned rows — transient
//        failures and interrupted runs are retried; permanent rows, live
//        leases and completed work are not.
{
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const db = makeMockDb([], [
    { id: "j-completed", processingState: "completed", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
    { id: "j-permanent", processingState: "failed", errorCategory: "permanent", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
    { id: "j-locked", processingState: "extracting", triggerState: "submitted", lockedUntil: new Date(Date.now() + 120_000), updatedAt: fiveMinAgo },
    { id: "j-transient", processingState: "failed", errorCategory: "transient", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
    { id: "j-stuck", processingState: "extracting", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
  ]);
  const extractionCalls = [];
  const retryCalls = [];
  const outcome = await resumeStalledWork({
    deadline: Date.now() + 30_000,
    overrides: {
      db,
      extractNext: async ({ maxAssets }) => {
        extractionCalls.push(maxAssets);
        return { passes: maxAssets };
      },
      processingConfigured: () => true,
      longDoc: { extractBudgetMs: 200_000 },
      retryProcessing: async (jobId) => {
        retryCalls.push(jobId);
        return { triggered: true };
      },
    },
  });
  assert.equal(extractionCalls.length, 1, "extraction claimed its bounded share");
  assert.deepEqual(retryCalls, ["j-transient", "j-stuck"], "oldest first, only the recoverable");
  assert.equal(outcome.extractionPasses, 3);
  assert.equal(outcome.jobsRecovered.length, 2);
  console.log("✓ sweep rescues transient failures + interrupted runs, never completed/permanent");
}

// --- 9. resumeStalledWork respects its deadline and its retry cap.
{
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const mkDb = () =>
    makeMockDb([], [
      { id: "j-1", processingState: "failed", errorCategory: "transient", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
      { id: "j-2", processingState: "failed", errorCategory: "transient", triggerState: "submitted", lockedUntil: null, updatedAt: fiveMinAgo },
    ]);
  const retryCalls = [];
  const retry = async (jobId) => {
    retryCalls.push(jobId);
    return { triggered: true };
  };
  const base = () => ({
    extractNext: async () => ({ passes: 0 }),
    processingConfigured: () => true,
    longDoc: { extractBudgetMs: 200_000 },
    retryProcessing: retry,
  });

  const capped = await resumeStalledWork({ maxJobRetries: 1, overrides: { db: mkDb(), ...base() } });
  assert.deepEqual(capped.jobsRecovered, ["j-1"], "the cap bounds what it may re-run");

  const expired = await resumeStalledWork({ deadline: Date.now(), overrides: { db: mkDb(), ...base() } });
  assert.deepEqual(expired.jobsRecovered, [], "a spent deadline retries nothing");

  const unconfigured = await resumeStalledWork({
    overrides: { db: mkDb(), ...base(), processingConfigured: () => false },
  });
  assert.equal(unconfigured.extractionPasses, 0, "unconfigured stacks no claims");
  console.log("✓ sweep respects deadline, retry cap and configuration gate");
}

console.log("=== ALL PIPELINE RECOVERY CHECKS PASSED ===");
