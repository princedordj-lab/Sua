// Offline checks for the Trigger.dev document-processing architecture.
//
// Runs with no Trigger.dev, no Postgres and no AI provider: the trigger client
// is replaced by `setTriggerClient`, model output is validated through the stage
// specs, and the state helpers are pure. What is asserted is the logic that used
// to break in production: invalid model output, retry classification (429/5xx vs
// permanent), duplicate upload-completion, duplicate trigger, partial retry that
// keeps completed materials, and honest status text.

import assert from "node:assert/strict";
import { MATERIAL_SPECS } from "../src/lib/processing/stages.js";
import { classifyFailure } from "../src/lib/processing/errors.js";
import {
  MATERIAL_STATES,
  resetMaterials,
  shapeProcessing,
  stageSentence,
} from "../src/lib/processing/state.js";
import {
  ensureProcessingJob,
  retryProcessing,
  setTriggerClient,
  startProcessing,
} from "../src/lib/processing/start.js";

// --- 1. Valid model output is accepted; malformed output is a controlled error
{
  assert.equal(
    MATERIAL_SPECS.summary.validate({ summary: "## Overview\n" + "x".repeat(200) }).success,
    true,
  );
  // The production crash: a missing array must never reach a `.map`.
  for (const bad of [null, {}, { flashcards: undefined }, { flashcards: "nope" }, { flashcards: [] }]) {
    const result = MATERIAL_SPECS.flashcards.validate(bad);
    assert.equal(result.success, false, `flashcards.validate(${JSON.stringify(bad)}) must fail`);
    assert.match(String(result.error), /at least 5 usable cards/);
  }
  for (const bad of [{}, { quiz: {} }, { quiz: { questions: "nope" } }, { quiz: { questions: [] } }]) {
    assert.equal(MATERIAL_SPECS.quiz.validate(bad).success, false);
  }
  const goodCards = MATERIAL_SPECS.flashcards.validate({
    flashcards: Array.from({ length: 6 }, (_, index) => ({ front: `Q${index}`, back: `A${index}` })),
  });
  assert.equal(goodCards.success, true);
  assert.equal(goodCards.data.flashcards.length, 6);
  const goodQuiz = MATERIAL_SPECS.quiz.validate({
    quiz: {
      questions: [
        { type: "mcq", prompt: "p1", options: ["a", "b"], correctIndex: 1 },
        { type: "true_false", prompt: "p2", correctAnswer: "yes" },
        { type: "short_answer", prompt: "p3", answer: "a3" },
        { type: "mcq", prompt: "bad", options: ["only-one"], correctIndex: 0 },
      ],
    },
  });
  assert.equal(goodQuiz.success, true);
  assert.equal(goodQuiz.data.quiz.questions.length, 3, "the invalid mcq is dropped, not stored");
  assert.equal(goodQuiz.data.quiz.questions[1].correctAnswer, "True");
  console.log("✓ model output is validated before use; malformed arrays never reach a .map");
}

// --- 2. Retry classification (what Trigger.dev retries and what it does not)
{
  const rate = classifyFailure(
    Object.assign(new Error("429"), { kind: "rate_limit", status: 429, retryAfterMs: 30_000 }),
  );
  assert.equal(rate.category, "transient");
  assert.equal(rate.retryAfterMs, 30_000, "Retry-After is honoured");

  assert.equal(classifyFailure(Object.assign(new Error("boom"), { status: 500 })).category, "transient");
  assert.equal(classifyFailure(Object.assign(new Error("boom"), { status: 503 })).category, "transient");
  assert.equal(classifyFailure(Object.assign(new Error("slow"), { kind: "timeout" })).category, "transient");
  assert.equal(classifyFailure(Object.assign(new Error("net"), { code: "ECONNRESET" })).category, "transient");
  assert.equal(classifyFailure(Object.assign(new Error("pool"), { code: "P2028" })).category, "transient");
  assert.equal(classifyFailure(Object.assign(new Error("bad key"), { kind: "auth" })).category, "permanent");
  assert.equal(classifyFailure(Object.assign(new Error("quota"), { kind: "quota" })).category, "permanent");
  assert.equal(classifyFailure(Object.assign(new Error("schema"), { kind: "invalid_output" })).category, "permanent");
  assert.equal(classifyFailure(Object.assign(new Error("gone"), { code: "P2025" })).category, "permanent");
  console.log("✓ 429/5xx/timeout/capacity retry; auth/quota/invalid output/deleted never do");
}

// --- 3. Status text is specific, never a generic "Pulling out the important parts"
{
  assert.equal(stageSentence({ kind: "lecture_note", processingState: "extracting", materials: {} }), "Extracting document");
  assert.equal(stageSentence({ kind: "lecture_note", processingState: "ocr_processing", materials: {} }), "Processing scanned pages");
  const cardsRunning = {
    kind: "lecture_note",
    processingState: "generating",
    materials: {
      notes: { state: "done" },
      summary: { state: "done" },
      flashcards: { state: "running" },
      quiz: { state: "pending" },
    },
  };
  assert.equal(stageSentence(cardsRunning), "Generating flashcards (3 of 4)");
  assert.ok(!/Pulling out/i.test(stageSentence(cardsRunning)));

  const shaped = shapeProcessing({
    id: "job-1",
    noteId: "note-1",
    kind: "lecture_note",
    processingState: "generating",
    stage: "writing",
    materials: { notes: { state: "done" }, summary: { state: "failed", error: "AI_QUOTA" } },
  });
  assert.deepEqual(shaped.completedMaterials, ["notes"], "a failed material is reported, not dropped");
  assert.equal(shaped.materials.summary.error, "AI_QUOTA");
  // A study set has no notes material at all.
  assert.deepEqual(
    Object.keys(shapeProcessing({ kind: "study_set", materials: {} }).materials).sort(),
    ["flashcards", "quiz", "summary"],
  );
  console.log("✓ every stage has specific, honest client-facing copy");
}

// --- 4. A retry keeps completed materials and re-runs only the incomplete ones
{
  const job = {
    kind: "lecture_note",
    materials: {
      notes: { state: "done" },
      summary: { state: "done" },
      flashcards: { state: "failed", error: "AI_RATE_LIMIT" },
      quiz: { state: "pending" },
    },
  };
  const reset = resetMaterials(job);
  assert.equal(reset.notes.state, "done", "finished notes survive a retry");
  assert.equal(reset.summary.state, "done", "a finished summary survives a retry");
  assert.equal(reset.flashcards.state, MATERIAL_STATES.pending);
  const onlyCards = resetMaterials(job, { only: "flashcards" });
  assert.equal(onlyCards.flashcards.state, "pending");
  console.log("✓ a retry resumes at the earliest incomplete material");
}

// --- 5. Duplicate upload-completion and duplicate trigger start exactly one run
function makeDb() {
  const jobs = new Map();
  return {
    jobs,
    job: {
      findUnique: async ({ where }) =>
        where.id
          ? jobs.get(where.id)
          : [...jobs.values()].find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }) => {
        const row = { id: `job-${jobs.size + 1}`, ...data, updatedAt: new Date(), createdAt: new Date() };
        jobs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = jobs.get(where.id);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = jobs.get(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    note: {
      findUnique: async () => ({ id: "note-1", assets: [{ id: "asset-1" }] }),
      updateMany: async () => ({ count: 1 }),
    },
  };
}

{
  const db = makeDb();
  const calls = [];
  setTriggerClient({
    trigger: async (taskId, payload, options) => {
      calls.push({ taskId, payload, options });
      return { id: "run-1" };
    },
    cancel: async () => true,
  });

  const first = await ensureProcessingJob({ noteId: "note-1", userId: "user-1", kind: "lecture_note" }, db);
  const second = await ensureProcessingJob({ noteId: "note-1", userId: "user-1", kind: "lecture_note" }, db);
  assert.equal(first.created, true);
  assert.equal(second.created, false, "a repeated /complete finds the existing row");
  assert.equal(first.job.id, second.job.id);

  const started = await startProcessing(
    { noteId: "note-1", userId: "user-1", kind: "lecture_note", assetId: "asset-1" },
    db,
  );
  assert.equal(started.triggered, true);
  assert.equal(calls.length, 1, "exactly one run is triggered");
  assert.equal(calls[0].taskId, "process-document");
  assert.deepEqual(Object.keys(calls[0].payload).sort(), [
    "assetId",
    "jobId",
    "noteId",
    "processingVersion",
    "userId",
  ]);
  assert.ok(
    !Object.keys(calls[0].payload).some((key) => /bytes|text|base64/i.test(key)),
    "no file bytes or extracted text in the payload",
  );
  assert.match(String(calls[0].options.idempotencyKey), /sua:process:note-1:lecture_note:v1/);

  const again = await startProcessing(
    { noteId: "note-1", userId: "user-1", kind: "lecture_note", assetId: "asset-1" },
    db,
  );
  assert.equal(again.reused, true);
  assert.equal(calls.length, 1, "a duplicate completion creates no second run");

  // Trigger failure: the row survives, marked failed, with a retry path.
  setTriggerClient({
    trigger: async () => {
      throw Object.assign(new Error("down"), { status: 503 });
    },
  });
  const failedDb = makeDb();
  const failed = await startProcessing({ noteId: "note-2", userId: "user-1", kind: "study_set" }, failedDb);
  assert.equal(failed.triggered, false);
  const row = [...failedDb.jobs.values()][0];
  assert.equal(row.triggerState, "failed", "the document row is kept for a retry");
  assert.ok(row.error, "a safe message is stored instead of a provider error");

  setTriggerClient({ trigger: async () => ({ id: "run-2" }) });
  const retried = await retryProcessing(row.id, {}, failedDb);
  assert.equal(retried.triggered, true);
  assert.equal(failedDb.jobs.size, 1, "retry reuses the row, never a second document");
  console.log("✓ duplicate completion / duplicate trigger / failed trigger all behave");
  setTriggerClient(null);
}

console.log("\nAll processing-architecture checks passed.");

