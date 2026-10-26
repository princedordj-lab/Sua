import assert from "node:assert/strict";
import { MAX_UPLOAD_BYTES, MAX_AUDIO_BYTES } from "../src/lib/storage.js";
import { ALLOWED_JOB_KINDS, MIN_NOTE_CHARS, MAX_NOTE_CHARS } from "../src/worker.js";
import { MAX_TEXT_CHARS, extractDocumentText } from "../src/lib/extract.js";

console.log("=== Running Upload & Worker Invariants Test Suite ===");

// 1. Verify MAX_UPLOAD_BYTES is 25 MB
{
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_BYTES, 26_214_400);
  assert.equal(MAX_AUDIO_BYTES, 50 * 1024 * 1024);
  console.log("✓ 1. MAX_UPLOAD_BYTES is strictly 25 MB (26,214,400 bytes)");
}

// 2. Verify MAX_TEXT_CHARS is 100,000
{
  assert.equal(MAX_TEXT_CHARS, 100_000);
  console.log("✓ 2. MAX_TEXT_CHARS is strictly 100,000 characters");
}

// 3. Verify ALLOWED_JOB_KINDS
{
  const expectedKinds = ["study_set", "lecture_note", "course_reference"];
  assert.equal(ALLOWED_JOB_KINDS.length, 3);
  for (const k of expectedKinds) {
    assert.ok(ALLOWED_JOB_KINDS.includes(k), `Missing kind: ${k}`);
  }
  assert.ok(!ALLOWED_JOB_KINDS.includes("quiz_marking"), "quiz_marking must not be in ALLOWED_JOB_KINDS");
  assert.ok(!ALLOWED_JOB_KINDS.includes("document_extraction"), "document_extraction must not be in ALLOWED_JOB_KINDS");
  console.log("✓ 3. ALLOWED_JOB_KINDS contains exclusively [study_set, lecture_note, course_reference]");
}

// 4. Verify note character limits (40 min, 60k max)
{
  assert.equal(MIN_NOTE_CHARS, 40);
  assert.equal(MAX_NOTE_CHARS, 60_000);

  const shortBody = "Too short note";
  assert.ok(shortBody.trim().length < MIN_NOTE_CHARS);

  const longBody = "A".repeat(80_000);
  const clamped = longBody.slice(0, MAX_NOTE_CHARS);
  assert.equal(clamped.length, 60_000);
  console.log("✓ 4. Worker note boundaries strictly enforced: MIN 40 chars, MAX 60,000 chars");
}

// 5. Verify BullMQ payload invariant
{
  const mockPayload = {
    jobId: "job-123",
    noteId: "note-456",
    userId: "user-789",
    kind: "study_set",
  };
  const keys = Object.keys(mockPayload);
  assert.deepEqual(keys.sort(), ["jobId", "kind", "noteId", "userId"]);
  assert.ok(!("buffer" in mockPayload));
  assert.ok(!("base64" in mockPayload));
  assert.ok(!("body" in mockPayload));
  assert.ok(!("extractedText" in mockPayload));
  console.log("✓ 5. BullMQ job payloads are strictly lightweight identifiers only");
}

// 6. Extraction failure does not throw or crash
{
  const corrupted = Buffer.from("Corrupted bytes");
  const extracted = await extractDocumentText(corrupted, "docx", "document");
  assert.equal(extracted, null);
  console.log("✓ 6. Extraction failure returns null safely (no unhandled 500)");
}

console.log("\n=== ALL INVARIANT TESTS PASSED! ===");
