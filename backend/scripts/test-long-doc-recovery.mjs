// Offline checks for the hierarchical reduce: single-item skips, split on a
// size/output failure, and resume from the checkpoint with zero new calls.
// No database, no network, no model cost.

import assert from "node:assert/strict";
import { AiError, bulkModel, setAiMock } from "../src/lib/ai.js";
import { PROMPT_VERSION } from "../src/lib/prompts.js";
import { reduceDigests } from "../src/lib/long-doc.js";

const topic = (heading, range) => ({
  heading,
  points: [`Point about ${heading}.`],
  terms: [],
  formulas: [],
  examples: [],
  emphasised: [],
  source: range,
});

const digest = (heading, range) => ({ range, topics: [topic(heading, range)], unclear: [] });

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

const response = (text) => ({
  text,
  promptTokens: text.length,
  completionTokens: Math.ceil(text.length / 4),
});

function mergeMock(items) {
  const headings = new Map();
  for (const item of items) {
    for (const value of item?.topics ?? []) {
      if (value?.heading && !headings.has(value.heading)) headings.set(value.heading, value);
    }
  }
  const topics = [...headings.values()].slice(0, 40);
  return response(
    JSON.stringify({
      range: "merged",
      topics: topics.length ? topics : [topic("Empty", "p. 0")],
      unclear: [],
    }),
  );
}

const groupKey = (hash) => `${hash}:${PROMPT_VERSION}:${bulkModel()}`;

function buildSource({ sections, groupsPerSection }) {
  const sectionsOut = [];
  const groupsOut = [];
  const digestsOut = {};
  for (const section of sections) {
    sectionsOut.push({
      id: section.id,
      title: section.title,
      startPage: section.start,
      endPage: section.end,
    });
    for (let index = 0; index < groupsPerSection; index += 1) {
      const hash = `${section.id}-g${index}`;
      groupsOut.push({
        hash,
        labelRange: `p. ${section.start + index}`,
        sectionId: section.id,
        index: index + 1,
      });
      digestsOut[groupKey(hash)] = digest(`${section.id}-${index}`, `p. ${section.start + index}`);
    }
  }
  return { sections: sectionsOut, groups: groupsOut, digests: digestsOut };
}

function makeDeps(store, calls) {
  return {
    record: async () => {},
    recordFailure: async () => {},
    setStage: async (stage, progress) => {
      if (stage === "merging" && progress) calls.progress.push(`${progress.done}/${progress.total}`);
    },
    deadline: null,
    saveReduceEntry: async (key, value) => {
      store[key] = value;
    },
  };
}

const baseJob = { id: "reduce-test", checkpoint: {} };

// 1. A section with one digest must not call the model; only the overview of
//    several sections does.
{
  setAiMock(() => {
    throw new Error("no model call expected");
  });
  const { sections, groups, digests } = buildSource({
    sections: [
      { id: "s1", title: "One", start: 1, end: 2 },
      { id: "s2", title: "Two", start: 3, end: 4 },
      { id: "s3", title: "Three", start: 5, end: 6 },
    ],
    groupsPerSection: 1,
  });
  const calls = { progress: [] };
  let modelCalls = 0;
  setAiMock(({ user }) => {
    modelCalls += 1;
    return mergeMock(parseItems(user));
  });
  const result = await reduceDigests({
    job: baseJob,
    digests,
    groups,
    sections,
    sourceType: "file",
    courseContext: "TEST 101",
    deps: makeDeps({}, calls),
  });
  assert.equal(modelCalls, 1, "three single-digest sections need only the overview merge");
  assert.equal(result.summaryList.length, 3);
  assert.equal(result.overview.topics.length, 3, "overview keeps every section heading");
  assert.ok(calls.progress.length >= 1);
  console.log("✓ single-digest sections skip the merge call");
}

// 2. A wave rejected with too_large splits, caches children and completes.
{
  const { sections, groups, digests } = buildSource({
    sections: [{ id: "s1", title: "Big", start: 1, end: 6 }],
    groupsPerSection: 3,
  });
  let failed = 1;
  let modelCalls = 0;
  const store = {};
  setAiMock(({ user }) => {
    modelCalls += 1;
    const items = parseItems(user);
    if (failed && items.length >= 3) {
      failed -= 1;
      throw new AiError("too_large", "request exceeds the context window", { status: 413 });
    }
    return mergeMock(items);
  });
  const result = await reduceDigests({
    job: baseJob,
    digests,
    groups,
    sections,
    sourceType: "file",
    courseContext: "TEST 101",
    deps: makeDeps(store, { progress: [] }),
  });
  assert.equal(failed, 0, "the oversized wave was attempted");
  assert.equal(result.summaryList.length, 1);
  const headings = result.overview.topics.map((item) => item.heading).sort();
  assert.deepEqual(headings, ["s1-0", "s1-1", "s1-2"], "no content lost across the split");
  assert.ok(modelCalls >= 3, "split children and their parent were merged");
  assert.ok(Object.keys(store).length >= 2, "child and parent results were checkpointed");
  console.log("✓ an oversized wave splits and completes without losing topics");
}

// 3. Resume from the captured reduce store makes no model calls.
{
  const { sections, groups, digests } = buildSource({
    sections: [{ id: "s1", title: "Big", start: 1, end: 6 }],
    groupsPerSection: 3,
  });
  const store = {};
  let failed = 1;
  setAiMock(({ user }) => {
    const items = parseItems(user);
    if (failed && items.length >= 3) {
      failed -= 1;
      throw new AiError("too_large", "request exceeds the context window", { status: 413 });
    }
    return mergeMock(items);
  });
  const first = await reduceDigests({
    job: baseJob,
    digests,
    groups,
    sections,
    sourceType: "file",
    courseContext: "TEST 101",
    deps: makeDeps(store, { progress: [] }),
  });

  let resumeCalls = 0;
  setAiMock(() => {
    resumeCalls += 1;
    throw new Error("resume must not call the model");
  });
  const second = await reduceDigests({
    job: { ...baseJob, checkpoint: { reduce: store } },
    digests,
    groups,
    sections,
    sourceType: "file",
    courseContext: "TEST 101",
    deps: makeDeps({}, { progress: [] }),
  });
  assert.equal(resumeCalls, 0, "every finished wave was reused");
  assert.deepEqual(
    second.overview.topics.map((item) => item.heading).sort(),
    first.overview.topics.map((item) => item.heading).sort(),
    "resumed overview matches the first run",
  );
  console.log("✓ a resumed reduce calls the model zero times");
}

console.log("\nAll long-doc recovery checks passed.");
