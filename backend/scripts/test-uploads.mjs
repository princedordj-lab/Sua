import assert from "node:assert/strict";
import {
  MAX_AUDIO_BYTES,
  MAX_BYTES,
  MAX_UPLOAD_BYTES,
} from "../src/lib/storage.js";
import {
  checkCompletion,
  needsExtraction,
  needsVerification,
} from "../src/lib/upload-intake.js";

console.log("=== Upload intake checks ===");

// --- Size limits are defined once and shared -------------------------------
assert.equal(MAX_BYTES.document, MAX_UPLOAD_BYTES);
assert.equal(MAX_BYTES.image, MAX_UPLOAD_BYTES);
assert.equal(MAX_BYTES.audio, MAX_AUDIO_BYTES);
assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
assert.equal(MAX_AUDIO_BYTES, 50 * 1024 * 1024);
console.log("✓ one set of size limits serves signing, verification and intake");

const asset = (overrides = {}) => ({
  id: "asset-1",
  kind: "document",
  status: "pending",
  publicId: "sua/user-1/asset-1",
  storageProvider: "neon",
  extractedText: null,
  extractState: "none",
  ...overrides,
});

// --- needsVerification ----------------------------------------------------
assert.equal(needsVerification(asset()), true, "an unactivated upload is verified");
assert.equal(needsVerification(asset({ status: "active" })), false, "a completed upload is not re-verified");
assert.equal(needsVerification(null), false);
console.log("✓ storage is verified once, before activation only");

// --- needsExtraction -----------------------------------------------------
assert.equal(needsExtraction(asset()), true, "a fresh document is parsed");
assert.equal(
  needsExtraction(asset({ extractState: "pending" })),
  false,
  "a document already queued for a pass is not re-marked",
);
assert.equal(
  needsExtraction(asset({ extractState: "partial" })),
  false,
  "a half-read document resumes from its page cursor, it is not reset",
);
assert.equal(
  needsExtraction(asset({ extractState: "done" })),
  false,
  "a parsed document is not parsed again",
);
assert.equal(
  needsExtraction(asset({ extractState: "failed" })),
  false,
  "a corrupt file is not retried on every completion",
);
assert.equal(
  needsExtraction(asset({ extractedText: "already here" })),
  false,
  "legacy inline text is never replaced by a parse",
);
assert.equal(needsExtraction(asset({ kind: "image" })), false, "a photo is read by the job, not by page extraction");
assert.equal(needsExtraction(asset({ kind: "audio" })), false, "audio has no page model");
assert.equal(needsExtraction(null), false);
console.log("✓ only a document with no text and no state starts extraction");

// --- checkCompletion: a retried completion is not an error ---------------
const pending = asset();
assert.deepEqual(
  checkCompletion(pending, { claimedPublicId: pending.publicId, provider: "neon" }),
  { ok: true },
);
const secondTry = checkCompletion(pending, { claimedPublicId: pending.publicId });
assert.equal(secondTry.ok, true, "provider match is only checked when a provider is supplied");
console.log("✓ a matching completion is accepted");

assert.deepEqual(
  checkCompletion(asset({ status: "active" }), { claimedPublicId: "anything", provider: "neon" }),
  { ok: true },
  "repeating /complete after the response was lost must not fail",
);
assert.equal(
  checkCompletion(asset({ status: "active" }), { claimedPublicId: "" }).ok,
  true,
  "an active asset ignores an empty publicId too, so a retry always settles",
);
console.log("✓ completion is idempotent once the asset is active");

const mismatch = checkCompletion(pending, { claimedPublicId: "sua/user-1/other" });
assert.equal(mismatch.ok, false);
assert.equal(mismatch.status, 400);
assert.equal(mismatch.error, "publicId does not match this upload");
assert.equal(
  checkCompletion(pending, { claimedPublicId: "" }).status,
  400,
  "an empty publicId cannot activate an upload",
);
console.log("✓ a wrong publicId is refused instead of activating unverified bytes");

const switched = checkCompletion(pending, {
  claimedPublicId: pending.publicId,
  provider: "cloudinary",
});
assert.equal(switched.ok, false);
assert.equal(switched.status, 409, "the row moved to another provider while the PUT was in flight");
assert.equal(switched.error, "Asset changed during upload; retry completion");
console.log("✓ a provider switch mid-upload is a conflict, not a silent activation");

const missing = checkCompletion(null, { claimedPublicId: "x" });
assert.equal(missing.ok, false);
assert.equal(missing.status, 404);
console.log("✓ a missing asset answers 404");

// A note deleted while the bytes were in flight must not resurrect the upload:
// the route checks the parent before it ever reaches this decision.
assert.equal(
  checkCompletion(asset({ noteId: null }), { claimedPublicId: pending.publicId }).ok,
  true,
  "a detached asset still completes; the route refuses it earlier on the note check",
);
console.log("✓ intake decisions stay independent of the deleted-note check");

console.log("\nAll upload intake checks passed.");
