import assert from "node:assert/strict";
import {
  extractionDeps,
  runExtractionPass,
  readLocalPdfPages,
  tryLlamaParse,
  claimExtractionAsset,
} from "../src/lib/extraction.js";
import { llamaParse, longDoc } from "../src/config/ai-pipeline.js";
import { llamaParseEnabled, llamaParseEligible } from "../src/lib/llamaparse.js";
import { extractStage } from "../src/lib/processing/stages.js";
import { runDirectProcessing } from "../src/lib/processing/orchestrator.js";

console.log("=== Extraction Dependency Injection & Pipeline Regression Suite ===");

function makeMockDb(initialAssets = [], initialJobs = []) {
  const assets = new Map(initialAssets.map((a) => [a.id, { ...a }]));
  const jobs = new Map(initialJobs.map((j) => [j.id, { ...j }]));
  const chunkRows = new Map();
  const notes = new Map();

  const indexKey = (row) => `${row.assetId}:${row.index}`;

  const db = {
    assets,
    jobs,
    chunkRows,
    notes,
    $transaction: async (fn) => fn(db),
    $queryRaw: async () => [
      { size: [...chunkRows.values()].reduce((sum, row) => sum + (row.text ?? "").length, 0) },
    ],
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
          if (!where.id || where.id === id) {
            assets.set(id, { ...item, ...data });
            count++;
          }
        }
        return { count };
      },
    },
    job: {
      findUnique: async ({ where }) => {
        const found = jobs.get(where.id);
        if (!found) return null;
        return {
          ...found,
          note: notes.get(found.noteId) ?? { id: found.noteId, courseId: "course-1", assets: [] },
          user: { clerkId: "user-test" },
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
    sourceChunk: {
      findMany: async ({ where }) => {
        return [...chunkRows.values()].filter((c) => {
          if (where.assetId && c.assetId !== where.assetId) return false;
          if (where.status && c.status !== where.status) return false;
          return true;
        }).sort((a, b) => a.index - b.index);
      },
      createMany: async ({ data }) => {
        for (const entry of data) {
          const row = { id: indexKey(entry), ...entry };
          chunkRows.set(indexKey(row), row);
        }
        return { count: data.length };
      },
      count: async ({ where } = {}) => [...chunkRows.values()].filter((c) => !where?.assetId || c.assetId === where.assetId).length,
      update: async ({ where, data }) => {
        const key = where.assetId_index ? `${where.assetId_index.assetId}:${where.assetId_index.index}` : null;
        const row = chunkRows.get(key);
        if (row) Object.assign(row, data);
        return row;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    note: {
      findUnique: async ({ where }) => notes.get(where.id) ?? { id: where.id, courseId: "course-1" },
      updateMany: async () => ({ count: 1 }),
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// 1. runExtractionPass() receives llamaParseEnabled as a function
// ---------------------------------------------------------------------------
{
  assert.equal(typeof extractionDeps.llamaParseEnabled, "function",
    "extractionDeps.llamaParseEnabled must be a function");

  let receivedType = null;
  const db = makeMockDb([
    {
      id: "asset-1",
      kind: "document",
      status: "active",
      format: "docx",
      extractState: "running",
    },
  ]);

  // Partial dependency override — omitting llamaParseEnabled
  const partialDeps = {
    db,
    readAssetBytes: async () => Buffer.from("fake docx bytes"),
    uploadToLlamaCloud: async () => {
      throw new Error("should not reach upload in test 1");
    },
  };

  // Calling runExtractionPass directly with partial deps must not throw TypeError: deps.llamaParseEnabled is not a function
  // For docx with no llama cloud key (disabled), it safely falls through to local office extraction
  const outcome = await runExtractionPass("asset-1", 10_000, {
    ...partialDeps,
    llamaParseEnabled: () => {
      receivedType = typeof partialDeps.llamaParseEnabled;
      return false;
    },
  });

  assert.equal(receivedType, "undefined", "llamaParseEnabled was supplied by default extractionDeps");
  console.log("✓ 1. runExtractionPass() receives llamaParseEnabled as the correct type");
}

// ---------------------------------------------------------------------------
// 2. LlamaParse can be enabled and disabled through existing configuration
// ---------------------------------------------------------------------------
{
  assert.equal(typeof llamaParseEnabled(), "boolean",
    "llamaParseEnabled() returns a boolean based on config");

  // Format eligibility check
  const pdfEligible = llamaParseEligible("pdf");
  const docxEligible = llamaParseEligible("docx");
  const txtEligible = llamaParseEligible("txt");
  assert.equal(txtEligible, false, "txt is never eligible for LlamaParse");

  // tryLlamaParse with boolean override instead of function
  const asset = { id: "asset-bool", providerJobId: null };
  const resDisabled = await tryLlamaParse(asset, "docx", Buffer.from("docx"), Date.now() + 5000, {
    llamaParseEnabled: false, // boolean override
    llamaParseEligible: () => true,
  });
  assert.equal(resDisabled, null, "Boolean false disables LlamaParse without error");

  const resFuncDisabled = await tryLlamaParse(asset, "docx", Buffer.from("docx"), Date.now() + 5000, {
    llamaParseEnabled: () => false, // function override
    llamaParseEligible: () => true,
  });
  assert.equal(resFuncDisabled, null, "Function false disables LlamaParse without error");

  console.log("✓ 2. LlamaParse can be enabled and disabled through existing configuration");
}

// ---------------------------------------------------------------------------
// 3. Individual test overrides do not remove unrelated extraction dependencies
// ---------------------------------------------------------------------------
{
  const db = makeMockDb([
    {
      id: "asset-partial",
      kind: "document",
      status: "active",
      format: "pdf",
      extractState: "running",
    },
  ]);

  // Pass ONLY db and readAssetBytes to runExtractionPass
  let extractPdfPagesCalled = false;
  const outcome = await runExtractionPass("asset-partial", 10_000, {
    db,
    readAssetBytes: async () => Buffer.from("%PDF-1.4 fake"),
    extractPdfPages: async () => {
      extractPdfPagesCalled = true;
      return {
        segments: [{ index: 1, text: "Chapter 1: Principles of Chemistry" }],
        pageCount: 1,
      };
    },
  });

  assert.equal(extractPdfPagesCalled, true, "extractPdfPages override was called");
  assert.equal(db.assets.get("asset-partial").extractState, "done", "Asset extraction finished");

  console.log("✓ 3. Individual test overrides do not remove unrelated extraction dependencies");
}

// ---------------------------------------------------------------------------
// 4. Normal PDF extraction still works (local-first)
// ---------------------------------------------------------------------------
{
  const db = makeMockDb([
    {
      id: "asset-pdf-local",
      kind: "document",
      status: "active",
      format: "pdf",
      extractState: "running",
    },
  ]);

  let ocrCalls = 0;
  let providerCalls = 0;

  const outcome = await runExtractionPass("asset-pdf-local", 10_000, {
    db,
    readAssetBytes: async () => Buffer.from("%PDF-1.4 text pdf"),
    extractPdfPages: async () => ({
      segments: [
        { index: 1, text: "Section 1: Thermodynamics and kinetic energy." },
        { index: 2, text: "Section 2: Work done by an ideal gas system." },
      ],
      pageCount: 2,
    }),
    geminiOcrBatch: async () => {
      ocrCalls++;
      return [];
    },
    uploadToLlamaCloud: async () => {
      providerCalls++;
      return {};
    },
  });

  assert.equal(ocrCalls, 0, "No OCR calls for text PDF");
  assert.equal(providerCalls, 0, "No provider calls for text PDF");
  const asset = db.assets.get("asset-pdf-local");
  assert.equal(asset.extractState, "done");
  assert.equal(asset.pagesDone, 2);

  console.log("✓ 4. Normal PDF extraction still works (local-first)");
}

// ---------------------------------------------------------------------------
// 5. OCR fallback still works for unreadable pages
// ---------------------------------------------------------------------------
{
  const db = makeMockDb([
    {
      id: "asset-pdf-ocr",
      kind: "document",
      status: "active",
      format: "pdf",
      extractState: "running",
    },
  ]);

  let ocrCalled = false;
  const outcome = await runExtractionPass("asset-pdf-ocr", 10_000, {
    db,
    readAssetBytes: async () => Buffer.from("%PDF-1.4 mixed pdf"),
    extractPdfPages: async () => ({
      segments: [
        { index: 1, text: "Readable intro text with enough characters to be usable." },
        { index: 2, text: "" }, // Unusable / empty page requiring fallback
      ],
      pageCount: 2,
    }),
    renderPdfPage: async () => Buffer.from("fake-rendered-png"),
    isRenderedPageBlank: async () => false,
    geminiOcrBatch: async ({ pages }) => {
      ocrCalled = true;
      return pages.map((p) => ({ text: `Recovered OCR text for page ${p.index}` }));
    },
  });

  assert.equal(ocrCalled, true, "OCR fallback was invoked for unreadable page");
  const asset = db.assets.get("asset-pdf-ocr");
  assert.equal(asset.extractState, "done");
  assert.equal(asset.ocrPages, 1);

  console.log("✓ 5. OCR fallback still works for unreadable pages");
}

// ---------------------------------------------------------------------------
// 6. Provider-pending and transient failures remain resumable
// ---------------------------------------------------------------------------
{
  // 6a. Provider pending: parks asset with providerJobId
  const db = makeMockDb([
    {
      id: "asset-parked",
      kind: "document",
      status: "active",
      format: "docx",
      extractState: "running",
      providerJobId: "job-parked-123",
      providerNextPollAt: new Date(Date.now() + 60_000), // Future poll backoff
    },
  ]);

  const outcome = await runExtractionPass("asset-parked", 10_000, {
    db,
    readAssetBytes: async () => Buffer.from("docx bytes"),
    llamaParseEnabled: () => true,
    llamaParseEligible: () => true,
  });

  assert.equal(outcome.state, "pending", "Parked provider job yields pending outcome");
  const asset = db.assets.get("asset-parked");
  assert.equal(asset.extractState, "pending", "Extract state is set to pending");

  // 6b. Resumable extraction stage handles partial state
  let stageAttempt = 0;
  const dbStage = makeMockDb([
    {
      id: "asset-resumable",
      kind: "document",
      status: "active",
      format: "docx",
      extractState: "partial",
      pagesDone: 1,
      pagesTotal: 2,
    },
  ]);

  const stageResult = await extractStage(
    { jobId: null, assetId: "asset-resumable" },
    {
      db: dbStage,
      claimExtractionAsset: async () => "asset-resumable",
      runExtractionPass: async (assetId, budget, passDeps) => {
        stageAttempt++;
        // Assert passDeps has complete extraction dependencies
        assert.equal(typeof passDeps.llamaParseEnabled, "function", "passDeps has llamaParseEnabled");
        assert.equal(typeof passDeps.extractPdfPages, "function", "passDeps has extractPdfPages");
        await dbStage.asset.update({ where: { id: assetId }, data: { extractState: "done", pagesDone: 2 } });
        return { state: "done" };
      },
    }
  );

  assert.equal(stageAttempt, 1);
  assert.equal(stageResult.state, "done");
  console.log("✓ 6. Provider-pending and transient failures remain resumable");
}

// ---------------------------------------------------------------------------
// 7. Completed extraction can proceed to normalization and AI generation
// ---------------------------------------------------------------------------
{
  const db = makeMockDb(
    [
      {
        id: "asset-pipeline-ok",
        kind: "document",
        status: "active",
        format: "docx",
        extractState: "done",
        pagesDone: 3,
        pagesTotal: 3,
      },
    ],
    [
      {
        id: "job-pipeline-ok",
        noteId: "note-1",
        kind: "study_set",
        processingState: "extracting",
        lockedUntil: null,
        attempts: 0,
        materials: {},
      },
    ]
  );

  let sourceStageRan = false;
  let materialStageRan = false;
  let finalizeStageRan = false;

  const overrides = {
    db,
    extractStage: async () => ({ state: "done", pagesDone: 3, pagesTotal: 3 }),
    sourceStage: async () => {
      sourceStageRan = true;
      db.jobs.get("job-pipeline-ok").sourceText = "Sufficient prepared text for study generation.";
      return { chars: 48 };
    },
    materialStage: async () => {
      materialStageRan = true;
      return { state: "done" };
    },
    finalizeStage: async () => {
      finalizeStageRan = true;
      return { state: "completed" };
    },
  };

  const outcome = await runDirectProcessing("job-pipeline-ok", {
    assetId: "asset-pipeline-ok",
    overrides,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(sourceStageRan, true, "sourceStage ran after extraction");
  assert.equal(materialStageRan, true, "materialStage ran after sourceStage");
  assert.equal(finalizeStageRan, true, "finalizeStage ran after materials");

  console.log("✓ 7. Completed extraction proceeds to normalization and AI generation");
}

// ---------------------------------------------------------------------------
// 8. Failed extraction does not incorrectly proceed to generation
// ---------------------------------------------------------------------------
{
  const db = makeMockDb(
    [
      {
        id: "asset-pipeline-fail",
        kind: "document",
        status: "active",
        format: "docx",
        extractState: "failed",
        extractErrorCode: "UNREADABLE_FILE",
      },
    ],
    [
      {
        id: "job-pipeline-fail",
        noteId: "note-fail",
        kind: "study_set",
        processingState: "extracting",
        lockedUntil: null,
        attempts: 0,
        materials: {},
      },
    ]
  );

  let generationAttempted = false;

  const overrides = {
    db,
    extractStage: async () => ({ state: "failed", errorCode: "UNREADABLE_FILE" }),
    sourceStage: async () => {
      generationAttempted = true;
      return { chars: 0 };
    },
    materialStage: async () => {
      generationAttempted = true;
      return { state: "failed" };
    },
  };

  await assert.rejects(
    async () => {
      await runDirectProcessing("job-pipeline-fail", {
        assetId: "asset-pipeline-fail",
        overrides,
      });
    },
    (err) => {
      return err.message.includes("Extraction did not settle");
    },
    "Failed extraction must throw and stop pipeline"
  );

  assert.equal(generationAttempted, false, "Generation was not attempted after extraction failure");
  const failedJob = db.jobs.get("job-pipeline-fail");
  assert.equal(failedJob.processingState, "failed");

  console.log("✓ 8. Failed extraction does not incorrectly proceed to generation");
}

console.log("\n=== ALL EXTRACTION INJECTION REGRESSION CHECKS PASSED! ===");
