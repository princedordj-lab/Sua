import assert from "node:assert/strict";
import { extractStage } from "../src/lib/processing/stages.js";
import {
  PermanentProcessingError,
  TransientProcessingError,
} from "../src/lib/processing/errors.js";

function fakeDb(asset) {
  return {
    asset: {
      findUnique: async () => ({ ...asset }),
    },
  };
}

// A partial extraction has persisted its SourceChunks and must resume in the
// same task instead of being reported as ready for source preparation.
{
  const asset = {
    id: "asset-partial",
    kind: "document",
    status: "active",
    extractState: "pending",
    pagesDone: 0,
    pagesTotal: 3,
  };
  let passes = 0;
  const result = await extractStage(
    { assetId: asset.id },
    {
      db: fakeDb(asset),
      claimExtractionAsset: async () => asset.id,
      runExtractionPass: async () => {
        passes += 1;
        asset.extractState = passes === 1 ? "partial" : "done";
        asset.pagesDone = passes === 1 ? 2 : 3;
      },
    },
  );
  assert.equal(passes, 2, "partial extraction is resumed");
  assert.equal(result.state, "done", "the stage only returns a settled asset");
  console.log("✓ partial extraction resumes before the stage returns");
}

// A provider parse parked for its backoff is a retryable wait, not a successful
// extraction result that the orchestrator can pass to source preparation.
{
  const nextPollAt = new Date(Date.now() + 30_000);
  const asset = {
    id: "asset-provider",
    kind: "document",
    status: "active",
    extractState: "pending",
    providerNextPollAt: nextPollAt,
  };
  await assert.rejects(
    () =>
      extractStage(
        { assetId: asset.id },
        {
          db: fakeDb(asset),
          claimExtractionAsset: async () => asset.id,
          runExtractionPass: async () => {},
        },
      ),
    (error) =>
      error instanceof TransientProcessingError &&
      error.code === "EXTRACTION_PROVIDER_PENDING" &&
      error.retryAfterMs > 0,
  );
  console.log("✓ parked provider extraction waits for its next poll");
}

// If another extraction run owns the asset, or it is not yet claimable, this
// run must retry instead of treating a partial text field as complete.
{
  const asset = {
    id: "asset-busy",
    kind: "document",
    status: "active",
    extractState: "partial",
    extractedText: "Some extracted text that is not the whole document.",
  };
  await assert.rejects(
    () =>
      extractStage(
        { assetId: asset.id },
        {
          db: fakeDb(asset),
          claimExtractionAsset: async () => null,
          runExtractionPass: async () => {},
        },
      ),
    (error) =>
      error instanceof TransientProcessingError &&
      error.code === "EXTRACTION_BUSY",
  );
  console.log("✓ a partial asset cannot pass merely because it has some text");
}

// A permanently unreadable asset is surfaced as a controlled permanent error.
{
  const asset = {
    id: "asset-failed",
    kind: "document",
    status: "active",
    extractState: "failed",
    extractErrorCode: "UNREADABLE_FILE",
  };
  await assert.rejects(
    () =>
      extractStage(
        { assetId: asset.id },
        {
          db: fakeDb(asset),
          claimExtractionAsset: async () => null,
          runExtractionPass: async () => {},
        },
      ),
    (error) =>
      error instanceof PermanentProcessingError &&
      error.code === "UNREADABLE_FILE",
  );
  console.log("✓ failed extraction is not mistaken for a usable source");
}

console.log("\nAll extraction-settlement checks passed.");
