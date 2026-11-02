// Offline checks for the durable, resumable merge (reduce) stage:
//
//  - a finished wave is only "finished" once the checkpoint row holds it
//  - a checkpoint write failure is an error, not a warning
//  - budget exhaustion yields at a safe boundary and the next pass resumes
//  - completed merge operations are skipped on resume
//  - provider timeout / rate limit / 5xx / invalid output each follow their rule
//  - a many-section document finishes with every heading intact
//  - two concurrent attempts cannot double-pay or overwrite newer state
//
// No database, no network, no model cost: `setAiMock` replaces the provider and
// `setCheckpointStore` replaces Postgres.

import assert from "node:assert/strict";
import { AiError, bulkModel, setAiMock } from "../src/lib/ai.js";
import { PROMPT_VERSION } from "../src/lib/prompts.js";
import {
  partitionWaves,
  reduceDigests,
  shrinkMergedDigest,
  stableBatchId,
} from "../src/lib/long-doc.js";
import {
  CheckpointWriteError,
  mergeCheckpointKeys,
  setCheckpointStore,
  writeCheckpointEntry,
} from "../src/lib/job-checkpoint.js";
import { longDoc } from "../src/config/ai-pipeline.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const point = (heading, n) => `Point ${n} about ${heading}, written the way a study note states it.`;
const topic = (heading, points = 3) => ({
  heading,
  points: Array.from({ length: points }, (_, index) => point(heading, index)),
  terms: [{ term: `term-${heading}`, definition: "a definition that must survive a merge" }],
  formulas: [],
  examples: ["an example that may be dropped when the result is too big"],
  emphasised: ["emphasis that may be dropped"],
  source: "p. 1",
});
const digest = (heading, topics = 1, points = 3) => ({
  range: "p. 1",
  topics: Array.from({ length: topics }, (_, index) => topic(`${heading}-${index}`, points)),
  unclear: [],
});
const response = (text) => ({
  text,
  promptTokens: text.length,
  completionTokens: Math.ceil(text.length / 4),
});

function parseItems(user) {
  const marker = "=== DIGESTS ===\n";
  const index = user.indexOf(marker);
  if (index < 0) return [];
  try {
    return JSON.parse(user.slice(index + marker.length));
  } catch {
    return [];
  }
}

/** A merge that keeps every heading of its inputs, like the real prompt asks. */
function mergeMock(items) {
  const headings = new Map();
  for (const item of items) {
    for (const value of item?.topics ?? []) {
      if (value?.heading && !headings.has(value.heading)) headings.set(value.heading, value);
    }
  }
  return response(JSON.stringify({ range: "merged", topics: [...headings.values()], unclear: [] }));
}

const groupKey = (hash) => `${hash}:${PROMPT_VERSION}:${bulkModel()}`;

function buildSource({ sections, groupsPerSection, topics = 1, points = 3 }) {
  const sectionsOut = [];
  const groupsOut = [];
  const digestsOut = {};
  for (const section of sections) {
    sectionsOut.push({ id: section.id, title: section.title, startPage: 1, endPage: 9 });
    for (let index = 0; index < groupsPerSection; index += 1) {
      const hash = `${section.id}-g${index}`;
      groupsOut.push({
        hash,
        labelRange: `p. ${index + 1}`,
        sectionId: section.id,
        index: index + 1,
      });
      digestsOut[groupKey(hash)] = digest(`${section.id}-${index}`, topics, points);
    }
  }
  return { sections: sectionsOut, groups: groupsOut, digests: digestsOut };
}

/**
 * In-memory stand-in for the `jobs.checkpoint` column. `failWrites` makes the
 * next N writes throw (a connection blip); `firstWriteWins` mirrors the guarded
 * `WHERE path IS NULL` update the production SQL performs.
 */
function makeStore({ failWrites = 0, firstWriteWins = true } = {}) {
  const state = { checkpoint: {}, writes: 0, skipped: 0 };
  const fail = () => {
    if (failWrites > 0) {
      failWrites -= 1;
      const error = new Error("terminating connection due to administrator command");
      error.code = "08006";
      throw error;
    }
  };
  return {
    state,
    async merge(jobId, patch) {
      fail();
      state.writes += 1;
      state.checkpoint = { ...state.checkpoint, ...patch };
    },
    async writeEntry(jobId, parent, key, value) {
      fail();
      state.writes += 1;
      const parentValue = { ...(state.checkpoint[parent] ?? {}) };
      if (firstWriteWins && parentValue[key] != null) {
        state.skipped += 1;
        return { stored: false, value: parentValue[key] };
      }
      parentValue[key] = value;
      state.checkpoint = { ...state.checkpoint, [parent]: parentValue };
      return { stored: true, value };
    },
    async read() {
      return state.checkpoint;
    },
  };
}

function makeDeps({ deadline = null, mergeRetryDelayMs = 0 } = {}) {
  const stats = { failures: 0, progress: [], stages: [] };
  return {
    stats,
    deps: {
      record: async () => {},
      recordFailure: async () => {
        stats.failures += 1;
      },
      setStage: async (stage, progress) => {
        stats.stages.push(stage);
        if (stage === "merging" && progress) stats.progress.push(`${progress.done}/${progress.total}`);
      },
      deadline,
      mergeRetryDelayMs,
    },
  };
}

const callReduce = (job, source, deps) =>
  reduceDigests({
    job,
    digests: source.digests,
    groups: source.groups,
    sections: source.sections,
    sourceType: "file",
    courseContext: "TEST 101",
    deps,
  });

const headingsOf = (summary) => (summary?.topics ?? []).map((item) => item.heading).sort();

// ---------------------------------------------------------------------------
// 1. A successful merge is persisted before it counts as finished
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const source = buildSource({
    sections: [
      { id: "s1", title: "One" },
      { id: "s2", title: "Two" },
    ],
    groupsPerSection: 3,
    topics: 2,
    points: 4,
  });
  let modelCalls = 0;
  setAiMock(({ user }) => {
    modelCalls += 1;
    return mergeMock(parseItems(user));
  });
  const { deps } = makeDeps();
  const result = await callReduce({ id: "job-1", checkpoint: {} }, source, deps);

  assert.equal(result.summaryList.length, 2);
  const reduceKeys = Object.keys(store.state.checkpoint.reduce ?? {});
  assert.ok(reduceKeys.length >= 2, "the section summaries and the overview are all on the row");
  assert.ok(
    reduceKeys.some((key) => key.startsWith("sectionDone:s1:")),
    "the finished section has a stable, content-derived key",
  );
  assert.ok(reduceKeys.some((key) => key.startsWith("overview:")), "the overview is checkpointed");
  assert.equal(store.state.writes, reduceKeys.length, "every stored entry went through the checkpoint");
  assert.equal(result.degraded.length, 0);
  assert.equal(modelCalls, 3, "two section merges plus the overview merge");
  console.log(`✓ a finished merge is durable before it is treated as finished (${modelCalls} calls)`);
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 2. A checkpoint write that fails is an error, never a silent success
// ---------------------------------------------------------------------------
{
  const store = makeStore({ failWrites: 1000 });
  setCheckpointStore(store);
  const source = buildSource({ sections: [{ id: "s1", title: "One" }], groupsPerSection: 3 });
  let modelCalls = 0;
  setAiMock(({ user }) => {
    modelCalls += 1;
    return mergeMock(parseItems(user));
  });
  const { deps } = makeDeps();
  let thrown = null;
  try {
    await callReduce({ id: "job-2", checkpoint: {} }, source, deps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a merge whose result could not be saved must not report success");
  assert.equal(thrown.name, "CheckpointWriteError");
  assert.equal(thrown.kind, "checkpoint_write");
  assert.equal(store.state.writes, 0, "nothing was persisted");
  assert.equal(Object.keys(store.state.checkpoint).length, 0, "the row holds no reduce map");
  assert.ok(thrown.attempts >= 2, "the write was retried before giving up");
  assert.equal(modelCalls, 1, "the failure stops the pass instead of spending more calls");
  console.log("✓ a failed checkpoint write throws instead of pretending the merge finished");
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 3. Budget exhaustion yields at a safe boundary; the next pass resumes
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const sections = Array.from({ length: 4 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Section ${index + 1}`,
  }));
  const source = buildSource({ sections, groupsPerSection: 3 });
  // Reference cost: the same document, one uninterrupted pass.
  const reference = makeStore();
  setCheckpointStore(reference);
  let referenceCalls = 0;
  setAiMock(({ user }) => {
    referenceCalls += 1;
    return mergeMock(parseItems(user));
  });
  await callReduce({ id: "job-3-ref", checkpoint: {} }, source, makeDeps().deps);

  // Now the same document with a model slow enough that one request eats the
  // whole window, so the pass has to yield.
  setCheckpointStore(store);
  let calls = 0;
  const slow = () => {
    const until = Date.now() + 60;
    while (Date.now() < until) {
      // burn a little wall clock
    }
  };
  setAiMock(({ user }) => {
    calls += 1;
    slow();
    return mergeMock(parseItems(user));
  });
  const firstDeadline = Date.now() + longDoc.reduceMinWindowMs + longDoc.reduceReserveMs + 30;
  const first = makeDeps({ deadline: firstDeadline });
  let yieldError = null;
  try {
    await callReduce({ id: "job-3", checkpoint: {} }, source, first.deps);
  } catch (error) {
    yieldError = error;
  }
  assert.ok(yieldError, "the pass must stop when the window is gone");
  assert.equal(yieldError.yield, true);
  assert.equal(yieldError.stage, "merging");
  assert.match(String(yieldError.detail), /level=0/);
  assert.match(String(yieldError.detail), /batch=[0-9a-f]{16}/);
  assert.ok(
    !/Point \d+ about/.test(String(yieldError.detail)),
    "the yield detail carries ids, never source text",
  );
  const callsInFirstPass = calls;
  const storedAfterFirstPass = Object.keys(store.state.checkpoint.reduce ?? {}).length;
  assert.ok(storedAfterFirstPass >= 1, "work finished before the yield is on the row");
  assert.ok(callsInFirstPass < referenceCalls, "the pass really did stop early");

  // Second pass: fresh budget, same row. It reuses what pass one saved.
  setAiMock(({ user }) => {
    calls += 1;
    return mergeMock(parseItems(user));
  });
  const second = makeDeps();
  const resumed = await callReduce({ id: "job-3", checkpoint: {} }, source, second.deps);
  assert.equal(resumed.summaryList.length, sections.length, "every section survived the yield");
  assert.equal(resumed.degraded.length, 0);
  assert.equal(
    calls,
    referenceCalls,
    `yield + resume costs the same as one uninterrupted pass (${calls} vs ${referenceCalls} calls)`,
  );
  console.log(
    `✓ budget yield resumes without redoing finished waves (pass1=${callsInFirstPass}, pass2=${calls - callsInFirstPass}, uninterrupted=${referenceCalls})`,
  );
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 4. Completed merge operations are skipped on a resume
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const sections = Array.from({ length: 3 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Section ${index + 1}`,
  }));
  const source = buildSource({ sections, groupsPerSection: 4, topics: 2 });
  let firstCalls = 0;
  setAiMock(({ user }) => {
    firstCalls += 1;
    return mergeMock(parseItems(user));
  });
  const first = await callReduce({ id: "job-4", checkpoint: {} }, source, makeDeps().deps);

  let resumeCalls = 0;
  setAiMock(() => {
    resumeCalls += 1;
    throw new Error("a resumed pass must not call the model");
  });
  const second = await callReduce(
    { id: "job-4", checkpoint: { reduce: store.state.checkpoint.reduce } },
    source,
    makeDeps().deps,
  );
  assert.equal(resumeCalls, 0, "every section summary and the overview came from the row");
  assert.equal(second.summaryList.length, first.summaryList.length);
  assert.deepEqual(headingsOf(second.overview), headingsOf(first.overview));
  console.log(`✓ a resumed pass with a complete checkpoint makes zero calls (first pass: ${firstCalls})`);
  setCheckpointStore(null);
}


// ---------------------------------------------------------------------------
// 5. Provider errors: timeout and 5xx retried once; rate limit and auth never
// ---------------------------------------------------------------------------
{
  const source = buildSource({ sections: [{ id: "s1", title: "One" }], groupsPerSection: 3 });

  // 5a. A timeout is retried once, then the call succeeds.
  setCheckpointStore(makeStore());
  let attempts = 0;
  setAiMock(({ user }) => {
    attempts += 1;
    if (attempts === 1) {
      throw new AiError("timeout", "provider timed out after 120000ms", { retryable: true });
    }
    return mergeMock(parseItems(user));
  });
  const timeoutRun = makeDeps();
  const timedOut = await callReduce({ id: "job-5a", checkpoint: {} }, source, timeoutRun.deps);
  assert.equal(timedOut.summaryList.length, 1, "the retry completed the section wave");
  assert.equal(attempts, 2, "the timed-out section wave was retried once, then succeeded");
  assert.equal(timeoutRun.stats.failures, 1, "the timeout was recorded as a failed AI call");

  // 5b. Two timeouts in a row are a bounded failure, not an infinite retry.
  setCheckpointStore(makeStore());
  let timeoutCalls = 0;
  setAiMock(() => {
    timeoutCalls += 1;
    throw new AiError("timeout", "provider timed out after 120000ms", { retryable: true });
  });
  let timeoutError = null;
  try {
    await callReduce({ id: "job-5b", checkpoint: {} }, source, makeDeps().deps);
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError, "a repeated timeout must surface");
  assert.equal(timeoutError.kind, "timeout");
  assert.equal(timeoutCalls, Math.max(1, longDoc.mergeAttempts), "attempts are capped");

  // 5c. A 503 (transient) is retried once.
  setCheckpointStore(makeStore());
  let flakyCalls = 0;
  setAiMock(({ user }) => {
    flakyCalls += 1;
    if (flakyCalls === 1) {
      throw new AiError("transient", "Xkiro call failed (503)", { status: 503, retryable: true });
    }
    return mergeMock(parseItems(user));
  });
  const flaky = await callReduce({ id: "job-5c", checkpoint: {} }, source, makeDeps().deps);
  assert.equal(flaky.summaryList.length, 1);
  assert.equal(flakyCalls, 2, "a 503 is retried once and then succeeds");

  // 5d. A rate limit is not retried at the merge layer: the pipeline parks the
  //     job on the provider's Retry-After instead.
  setCheckpointStore(makeStore());
  let rateCalls = 0;
  setAiMock(() => {
    rateCalls += 1;
    throw new AiError("rate_limit", "Xkiro call failed (429)", {
      status: 429,
      retryAfterMs: 30_000,
      retryable: true,
    });
  });
  let rateError = null;
  try {
    await callReduce({ id: "job-5d", checkpoint: {} }, source, makeDeps().deps);
  } catch (error) {
    rateError = error;
  }
  assert.ok(rateError, "the rate limit reaches the pipeline");
  assert.equal(rateError.kind, "rate_limit");
  assert.equal(rateCalls, 1, "no immediate retry of a project-wide rate limit");

  // 5e. Authentication is permanent: one attempt, no retry, no degradation.
  setCheckpointStore(makeStore());
  let authCalls = 0;
  setAiMock(() => {
    authCalls += 1;
    throw new AiError("auth", "Xkiro call failed (401)", { status: 401 });
  });
  let authError = null;
  try {
    await callReduce({ id: "job-5e", checkpoint: {} }, source, makeDeps().deps);
  } catch (error) {
    authError = error;
  }
  assert.ok(authError, "an auth failure fails the job");
  assert.equal(authError.kind, "auth");
  assert.equal(authCalls, 1, "a permanent configuration error is never retried");
  console.log("✓ timeout/5xx retried once, rate limit and auth never retried");
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 6. Invalid structured output: bounded repair, then a split that keeps content
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const source = buildSource({ sections: [{ id: "s1", title: "One" }], groupsPerSection: 4 });
  let calls = 0;
  setAiMock(({ user }) => {
    calls += 1;
    const items = parseItems(user);
    if (items.length > 2) return response("Here are your notes! I hope this helps.");
    return mergeMock(items);
  });
  const result = await callReduce({ id: "job-6", checkpoint: {} }, source, makeDeps().deps);
  assert.equal(result.summaryList.length, 1);
  assert.deepEqual(
    headingsOf(result.overview),
    ["s1-0-0", "s1-1-0", "s1-2-0", "s1-3-0"],
    "an unusable response for a 4-item wave splits instead of losing topics",
  );
  assert.ok(calls > 2, "the repair pass and the split children were attempted");
  console.log(`✓ invalid structured output is repaired then split without loss (${calls} calls)`);
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 7. Many sections: every heading survives and the payload stays bounded
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const sections = Array.from({ length: 30 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Section ${index + 1}`,
  }));
  const source = buildSource({ sections, groupsPerSection: 3, topics: 3, points: 6 });
  let calls = 0;
  let totalChars = 0;
  let maxChars = 0;
  let maxItems = 0;
  setAiMock(({ user }) => {
    calls += 1;
    totalChars += user.length;
    maxChars = Math.max(maxChars, user.length);
    const items = parseItems(user);
    maxItems = Math.max(maxItems, items.length);
    return mergeMock(items);
  });
  const result = await callReduce({ id: "job-7", checkpoint: {} }, source, makeDeps().deps);

  assert.equal(result.summaryList.length, 30, "every section produced a summary");
  assert.deepEqual(result.degraded, []);
  // Section boundaries: each section summary keeps exactly its own headings.
  for (const section of sections) {
    const expected = [];
    for (let group = 0; group < 3; group += 1) {
      for (let index = 0; index < 3; index += 1) expected.push(`${section.id}-${group}-${index}`);
    }
    assert.deepEqual(
      headingsOf(result.summariesFor[section.id].summary),
      expected.sort(),
      `section ${section.id} keeps its own material`,
    );
  }
  const expectedHeadings = [];
  for (const section of sections) {
    for (let group = 0; group < 3; group += 1) {
      for (let index = 0; index < 3; index += 1) {
        expectedHeadings.push(`${section.id}-${group}-${index}`);
      }
    }
  }
  assert.deepEqual(headingsOf(result.overview), expectedHeadings.sort(), "no section or topic was lost");
  assert.ok(
    maxItems <= longDoc.reduceBatchItems,
    `one merge carried at most ${longDoc.reduceBatchItems} items (saw ${maxItems})`,
  );
  const overviewChars = JSON.stringify(result.overview).length;
  assert.ok(
    overviewChars < totalChars / 4,
    `the overview (${overviewChars}) is far smaller than what was sent (${totalChars})`,
  );
  assert.ok(calls < 200, `a 90-group document stays inside a sane call count (${calls})`);
  console.log(
    `✓ 30 sections / 90 groups: ${calls} calls, max prompt ${maxChars} chars, most items per wave ${maxItems}, overview ${overviewChars} chars`,
  );
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 8. Concurrent attempts: one write wins, nothing is overwritten or double-paid
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const source = buildSource({
    sections: [
      { id: "s1", title: "One" },
      { id: "s2", title: "Two" },
    ],
    groupsPerSection: 3,
    topics: 2,
  });
  setAiMock(async ({ user }) => {
    // Two runners really do overlap: hold the request open so both passes race.
    await new Promise((resolve) => setTimeout(resolve, 2));
    return mergeMock(parseItems(user));
  });
  const results = await Promise.all([
    callReduce({ id: "job-8", checkpoint: {} }, source, makeDeps().deps),
    callReduce({ id: "job-8", checkpoint: {} }, source, makeDeps().deps),
  ]);
  for (const result of results) {
    assert.equal(result.summaryList.length, 2, "both attempts produced a complete hierarchy");
    assert.deepEqual(result.degraded, []);
  }
  const stored = Object.keys(store.state.checkpoint.reduce ?? {});
  assert.ok(stored.length >= 3, "section summaries and the overview are on the row");
  assert.ok(store.state.skipped >= 1, "a duplicate write adopted the value already stored");
  assert.deepEqual(
    headingsOf(results[0].overview),
    headingsOf(results[1].overview),
    "both attempts agree on the document",
  );

  // A write of an older value must not replace a newer one.
  const key = "sectionDone:s1:Bdeadbeefdeadbeef";
  const firstWrite = await writeCheckpointEntry("job-8", "reduce", key, {
    topics: [{ heading: "new" }],
  });
  const secondWrite = await writeCheckpointEntry("job-8", "reduce", key, {
    topics: [{ heading: "old" }],
  });
  assert.equal(firstWrite.stored, true);
  assert.equal(secondWrite.stored, false);
  assert.equal(secondWrite.value.topics[0].heading, "new", "the newer stored value is kept");
  console.log("✓ concurrent attempts share one checkpoint without overwriting newer state");
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 9. Section-level fallback keeps processed sections, and says so
// ---------------------------------------------------------------------------
{
  const store = makeStore();
  setCheckpointStore(store);
  const sections = [
    { id: "s1", title: "Works" },
    { id: "s2", title: "Fails" },
  ];
  const source = buildSource({ sections, groupsPerSection: 2, topics: 2, points: 3 });
  setAiMock(({ user }) => {
    const items = parseItems(user);
    if (items.some((item) => String(item?.topics?.[0]?.heading ?? "").startsWith("s2"))) {
      throw new AiError("transient", "Xkiro call failed (503)", { status: 503, retryable: true });
    }
    return mergeMock(items);
  });
  const result = await callReduce({ id: "job-9", checkpoint: {} }, source, makeDeps().deps);
  assert.equal(result.summaryList.length, 2, "the healthy section kept its model summary");
  assert.deepEqual(
    result.degraded,
    ["Fails", "Overview"],
    "the failed section fell back locally, and so did the overview that included it",
  );
  const failedSection = result.summariesFor.s2.summary;
  assert.deepEqual(
    (failedSection.topics ?? []).map((item) => item.heading),
    ["s2-0-0", "s2-0-1", "s2-1-0", "s2-1-1"],
    "the local fallback keeps every topic of the failed section",
  );
  assert.ok(
    Object.keys(store.state.checkpoint.reduce ?? {}).some((key) => key.startsWith("sectionDone:s1:")),
    "the healthy section is checkpointed",
  );
  console.log("✓ a failing section degrades locally without losing the healthy ones");
  setCheckpointStore(null);
}

// ---------------------------------------------------------------------------
// 9b. A mostly-degraded document fails instead of shipping as complete
// ---------------------------------------------------------------------------
{
  setCheckpointStore(makeStore());
  const sections = Array.from({ length: 4 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Section ${index + 1}`,
  }));
  const source = buildSource({ sections, groupsPerSection: 2 });
  setAiMock(() => {
    throw new AiError("transient", "Xkiro call failed (503)", { status: 503, retryable: true });
  });
  let failure = null;
  try {
    await callReduce({ id: "job-9b", checkpoint: {} }, source, makeDeps().deps);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "a document the model could not merge at all must not report ready");
  assert.equal(failure.kind, "transient");
  setCheckpointStore(null);
  console.log("✓ a wholly degraded document fails the job instead of shipping as complete");
}

// ---------------------------------------------------------------------------
// 10. Pure helpers: batch identity, wave caps, output shrink, durable patches
// ---------------------------------------------------------------------------
{
  const pairA = [digest("a"), digest("b")];
  const pairB = [digest("a"), digest("b")];
  const pairC = [digest("b"), digest("a")];
  assert.equal(
    stableBatchId("section:s1", 0, pairA),
    stableBatchId("section:s1", 0, pairB),
    "the same batch always gets the same id",
  );
  assert.notEqual(
    stableBatchId("section:s1", 0, pairA),
    stableBatchId("section:s1", 0, pairC),
    "a different member order is a different merge",
  );
  assert.notEqual(
    stableBatchId("section:s1", 0, pairA),
    stableBatchId("section:s2", 0, pairA),
    "the same items in another section are another merge",
  );

  const many = Array.from({ length: 40 }, (_, index) => digest(`many-${index}`));
  const waves = partitionWaves(many, 400_000);
  assert.ok(
    waves.every((wave) => wave.length <= longDoc.reduceBatchItems),
    `item-capped waves (${waves.map((wave) => wave.length).join(",")})`,
  );

  const huge = {
    range: "p. 1",
    topics: Array.from({ length: 8 }, (_, index) => topic(`huge-${index}`, 12)),
    unclear: ["an open question"],
  };
  const shrunk = shrinkMergedDigest(huge, JSON.stringify(huge).length);
  assert.equal(shrunk.topics.length, huge.topics.length, "compaction never drops a heading");
  assert.ok(
    shrunk.topics.every((item) => item.terms.length > 0),
    "technical terms survive compaction",
  );
  assert.ok(
    JSON.stringify(shrunk).length < JSON.stringify(huge).length,
    "a verbose merge result is compacted",
  );

  // The whole-key patch path is durable too.
  setCheckpointStore(makeStore({ failWrites: 1000 }));
  let patchError = null;
  try {
    await mergeCheckpointKeys("job-10", { digests: { a: { topics: [] } } });
  } catch (error) {
    patchError = error;
  }
  assert.ok(patchError instanceof CheckpointWriteError, "a whole-key patch failure throws");
  setCheckpointStore(null);
  console.log("✓ batch ids, wave caps, compaction and durable whole-key patches behave");
}

console.log("\nAll merge resume/checkpoint checks passed.");
