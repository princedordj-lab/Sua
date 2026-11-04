// Offline checks for the Trigger.dev document-processing architecture.
//
// Runs with no Trigger.dev, no Postgres and no AI provider: the trigger client
// is replaced by `setTriggerClient`, model output is validated through the stage
// specs, and the state helpers are pure. What is asserted is the logic that used
// to break in production: invalid model output, retry classification (429/5xx vs
// permanent), duplicate upload-completion, duplicate trigger, partial retry that
// keeps completed materials, honest status text, an honest completion verdict,
// the completion push, a retry affordance for a run that stopped reporting, and
// the notes stage choosing between one write call and map/reduce.

import assert from "node:assert/strict";
import { MATERIAL_SPECS, finalizeStage, materialStage } from "../src/lib/processing/stages.js";
import { classifyFailure } from "../src/lib/processing/errors.js";
import { notePipeline } from "../src/config/ai-pipeline.js";
import {
  MATERIAL_STATES,
  STALE_ACTIVE_RUN_MS,
  canRetryProcessing,
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

// --- 6. The completion verdict is honest, and only then does the push fire
function makeFinishDb(materials, kind = "lecture_note") {
  const job = {
    id: "job-1",
    kind,
    noteId: "note-1",
    userId: "user-1",
    materials,
    sourceText: "x".repeat(500),
    heartbeatAt: new Date(),
    note: { id: "note-1", title: "Cell division", course: null, assets: [] },
    user: { id: "user-1", clerkId: "user-public-1" },
  };
  const noteUpdates = [];
  return {
    noteUpdates,
    job: {
      findUnique: async () => job,
      update: async ({ data }) => Object.assign(job, data),
      updateMany: async ({ data }) => {
        Object.assign(job, data);
        return { count: 1 };
      },
    },
    note: {
      updateMany: async (args) => {
        noteUpdates.push(args);
        return { count: 1 };
      },
    },
    usage: { upsert: async () => ({}) },
  };
}

{
  const allDone = {
    notes: { state: "done" },
    summary: { state: "done" },
    flashcards: { state: "done" },
    quiz: { state: "done" },
  };
  const marks = [];
  const pushes = [];
  const dbA = makeFinishDb(allDone);
  await finalizeStage(
    { jobId: "job-1" },
    {
      db: dbA,
      markStage: async (jobId, data) => marks.push(data),
      notifyUser: async (userId, payload) => pushes.push({ userId, payload }),
    },
  );
  assert.equal(marks[0].processingState, "completed");
  assert.equal(pushes.length, 1, "a finished study set tells the student");
  assert.equal(pushes[0].payload.mobilePath, "/note/note-1");
  assert.equal(pushes[0].payload.webPath, "/app/note/note-1");
  assert.equal(dbA.noteUpdates.at(-1).data.aiState, "ready");
  assert.equal(dbA.noteUpdates.at(-1).data.noteKind, undefined, "a lecture note is not relabelled");

  // An upload converted to a reference is stored as a reference.
  const dbRef = makeFinishDb(
    { notes: { state: "done" }, summary: { state: "done" }, flashcards: { state: "pending" }, quiz: { state: "pending" } },
    "course_reference",
  );
  const asReference = await finalizeStage(
    { jobId: "job-1" },
    { db: dbRef, markStage: async () => {}, notifyUser: async () => {} },
  );
  assert.equal(asReference.state, "completed", "a reference needs its sheet and summary, not cards");
  assert.equal(dbRef.noteUpdates.at(-1).data.noteKind, "reference");

  // A material with no verdict (its run died before writing one) is not success.
  const marks2 = [];
  const pushes2 = [];
  const second = await finalizeStage(
    { jobId: "job-1" },
    {
      db: makeFinishDb({ ...allDone, quiz: { state: "running" } }),
      markStage: async (jobId, data) => marks2.push(data),
      notifyUser: async (userId, payload) => pushes2.push(payload),
    },
  );
  assert.equal(second.state, "failed", "an unfinished material cannot report the note as ready");
  assert.equal(pushes2.length, 0, "a run that did not finish sends no completion push");

  // Delivery trouble is never a failed run.
  const third = await finalizeStage(
    { jobId: "job-1" },
    {
      db: makeFinishDb(allDone),
      markStage: async () => {},
      notifyUser: async () => {
        throw new Error("expo down");
      },
    },
  );
  assert.equal(third.state, "completed");
  console.log("✓ the completion verdict is honest and the push only fires with it");
}

// --- 7. A row whose run stopped reporting is recoverable, a live one is not
{
  const now = Date.now();
  assert.equal(
    canRetryProcessing(
      { processingState: "generating", triggerState: "submitted", heartbeatAt: new Date(now - 60_000) },
      { now },
    ),
    false,
    "a run that is still writing heartbeats is never interrupted",
  );
  assert.equal(
    canRetryProcessing(
      {
        processingState: "generating",
        triggerState: "submitted",
        heartbeatAt: new Date(now - STALE_ACTIVE_RUN_MS - 1_000),
      },
      { now },
    ),
    true,
    "a run killed at its platform ceiling can be retried",
  );
  assert.equal(
    canRetryProcessing(
      {
        processingState: "completed",
        triggerState: "submitted",
        heartbeatAt: new Date(now - 9 * 3_600_000),
      },
      { now },
    ),
    false,
    "a finished note is never offered a retry",
  );
  assert.equal(canRetryProcessing({ processingState: "queued", triggerState: "failed" }, { now }), true);
  assert.equal(
    shapeProcessing({
      kind: "study_set",
      materials: {},
      processingState: "queued",
      triggerState: "failed",
    }).canRetry,
    true,
    "the retry affordance reaches the client",
  );
  console.log("✓ a stalled row offers a retry instead of showing progress forever");
}

// --- 8. The notes stage routes by size: one write when it fits, map/reduce when not
{
  const cap = notePipeline.shortSourceChars;
  const pageRow = (index, value) => ({
    index,
    label: `p. ${index}`,
    text: value,
    startPage: index,
    endPage: index,
    status: "done",
  });

  function notesJob(assets, overrides = {}) {
    return {
      id: "job-1",
      noteId: "note-1",
      kind: "lecture_note",
      checkpoint: {},
      materials: {},
      sourceText: "Thermodynamics is the study of energy transfer in a system.",
      user: { id: "user-1", clerkId: "user_test" },
      note: {
        id: "note-1",
        body: "My tutor said the exam always asks about the first law.",
        transcript: "",
        noteKind: "note",
        course: { name: "Thermodynamics", code: "ME 201" },
        assets,
      },
      ...overrides,
    };
  }

  const documentAssets = [
    { id: "a1", kind: "document", status: "active", publicId: "file-1", truncated: false },
  ];
  const mixedAssets = [
    { id: "a1", kind: "document", status: "active", publicId: "file-1", truncated: false },
    { id: "a2", kind: "image", status: "active", publicId: "file-2", truncated: false },
  ];

  async function runNotesStage(job, chunks) {
    const marked = [];
    const calls = { prepare: [], longDoc: [], bytes: 0 };
    const result = await materialStage(job.id, "notes", {
      db: {
        job: { findUnique: async () => job },
        note: { findUnique: async () => ({ id: job.noteId }) },
      },
      loadChunkedSource: async () => chunks,
      readAssetBytes: async () => {
        calls.bytes += 1;
        throw new Error("a picture must not be read for a source that cannot fit one call");
      },
      prepareMaterial: async (args) => {
        calls.prepare.push(args);
        return { material: args.source?.rawText ?? "typed material", source: args.source ?? null };
      },
      runLongDocJob: async (args) => {
        calls.longDoc.push(args);
        return { parts: [{ id: "s1" }] };
      },
      writeNote: async () => ({ body: "## Overview\nwritten body", transcript: "captured text" }),
      withUser: async (_clerkId, cb) => cb({ note: { update: async () => ({}) } }),
      markStage: async () => {},
      markMaterial: async (_jobId, material, state) => {
        marked.push(`${material}:${state}`);
      },
    });
    return { result, marked, calls };
  }

  // A document that fits one call: no digests, and the typed context travels.
  {
    const { result, marked, calls } = await runNotesStage(
      notesJob(documentAssets),
      { rows: [pageRow(1, "The first law: dU = Q - W.")] },
    );
    assert.equal(calls.longDoc.length, 0, "a small document is not map/reduced");
    assert.equal(calls.prepare.length, 1);
    const args = calls.prepare[0];
    assert.ok(args.source, "the stage hands the writer the source it selected");
    assert.equal(args.source.sourceType, "file");
    assert.ok(args.source.rawText.includes("The first law: dU = Q - W."));
    assert.ok(
      args.source.rawText.includes("My tutor said the exam always asks about the first law."),
      "a file note's typed context reaches the writer",
    );
    assert.equal(result.mode, "single");
    assert.deepEqual(marked, ["notes:running", "notes:done"], "the other materials still have to run");
  }

  // Over the cap: the sectioned writer owns the note and the study set with it.
  {
    const { result, marked, calls } = await runNotesStage(
      notesJob(documentAssets),
      { rows: [pageRow(1, "y".repeat(cap + 1))] },
    );
    assert.equal(calls.prepare.length, 0, "a long document is not written in one call");
    assert.equal(calls.longDoc.length, 1);
    assert.equal(calls.longDoc[0].source.rows.length, 1, "the loaded chunks are not re-read");
    assert.equal(result.mode, "long-doc");
    for (const material of ["summary", "flashcards", "quiz"]) {
      assert.ok(marked.includes(`${material}:done`), `${material} is done by the sectioned writer`);
    }
  }

  // A big document plus photos: the pictures are not read just to be rejected.
  {
    const { result, calls } = await runNotesStage(
      notesJob(mixedAssets),
      { rows: [pageRow(1, "y".repeat(cap + 1))] },
    );
    assert.equal(result.mode, "long-doc");
    assert.equal(calls.bytes, 0, "no asset bytes were read");
  }

  // A typed note has no chunk rows at all: the ordinary assembly route stands.
  {
    const { result, calls } = await runNotesStage(notesJob([]), null);
    assert.equal(calls.longDoc.length, 0);
    assert.equal(calls.prepare.length, 1);
    assert.equal("source" in calls.prepare[0], false, "nothing is pre-selected — assembleSource decides");
    assert.equal(result.mode, "single");
  }

  console.log("✓ a short document takes one write call, a long one takes map/reduce");
}

console.log("\nAll processing-architecture checks passed.");

