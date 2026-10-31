/**
 * AI note-pipeline evaluation harness.
 *
 * Usage (from backend/):
 *   npm run eval                              # every sample in scripts/eval-samples/
 *   npm run eval -- scripts/eval-samples/lecture-long.txt
 *   npm run eval -- --kind reference lecture.txt
 *   npm run eval -- --kind study_set --source recording lecture.txt
 *   npm run eval -- --doc scripts/eval-samples/handout-30p.pdf
 *   npm run eval -- --audio lecture.m4a
 *
 * Uses the production prompts, splitting, fidelity check and retry, so a PASS
 * here means the same code path the worker runs. Requires XKIRO_API_KEY
 * (and GEMINI_API_KEY for --doc / --audio) in backend/.env.
 *
 * Raw outputs go to .tmp/eval/, one line per sample on the console.
 */
import "../src/config/env.js";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { geminiTranscribe, setAiMock } from "../src/lib/ai.js";
import { assembleSource, prepareMaterial, sourceFromText, writeNote } from "../src/lib/note-pipeline.js";
import { generateStudySet, validateStudySet } from "../src/lib/pipeline.js";
import { notePipeline, longDoc, isJobYield } from "../src/config/ai-pipeline.js";
import {
  buildSections,
  groupRowsIntoChunks,
  mapDigests,
  reduceDigests,
  mergeCheckpoint,
} from "../src/lib/long-doc.js";
import { digestToText } from "../src/lib/note-pipeline.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(dirname, "eval-samples");
const backendDir = path.join(dirname, "..");
const outDir = path.join(backendDir, ".tmp", "eval");

// ---------------------------------------------------------------------------
// Deterministic mock provider (--mock): no network, no cost, repeatable.
// Answers follow the production prompt families, and the pipeline's own
// validation (validateDigest / validateStudyPack) still gates every response,
// so the needle / resume / failure checks exercise the real logic.
// ---------------------------------------------------------------------------

const NEEDLE_RE = /NEEDLE-KX7[^\n]*/;
const UNREADABLE_RE = /[\u0000-\u0008\u000e-\u001f]/;

function mockJson(obj, promptText) {
  const text = JSON.stringify(obj);
  return {
    text,
    promptTokens: Math.ceil((promptText ?? "").length / 4),
    completionTokens: Math.ceil(text.length / 4),
  };
}

function mockDigest(user) {
  const body = user.split("=== SOURCE PART ===")[1] ?? user;
  // Garbage bytes: emulate an unreadable part by returning prose the strict
  // parser cannot turn into JSON, exactly like the live failure mode.
  if (UNREADABLE_RE.test(body)) {
    return { text: "I could not read this part of the source.", promptTokens: 12, completionTokens: 9 };
  }
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const range = (user.match(/=== SOURCE PART (\S+?) ===/) ?? [])[1] ?? "part";
  const needle = body.match(NEEDLE_RE)?.[0];
  const content = lines.filter((line) => !/^SECTION\s/.test(line) && !NEEDLE_RE.test(line));
  const topics = [
    {
      heading: content[0]?.slice(0, 60) || "Part content",
      points: content.slice(1, 5).length ? content.slice(1, 5) : content.slice(0, 1),
      terms: [],
      formulas: [],
      examples: [],
      emphasised: [],
      source: range,
    },
  ];
  if (needle) {
    topics.push({ heading: "Noted detail", points: [needle], terms: [], formulas: [], examples: [], emphasised: [], source: range });
  }
  return mockJson({ range: `part ${range}`, topics, unclear: [] }, user);
}

function mockMerge(user, rangeLabel) {
  const payloadText = user.split("=== DIGESTS ===")[1] ?? "[]";
  let digests = [];
  try {
    digests = JSON.parse(payloadText.trim()) ?? [];
  } catch {
    digests = [];
  }
  const keep = [];
  const needlePoints = [];
  const headings = [];
  for (const digest of digests) {
    for (const topic of digest?.topics ?? []) {
      headings.push(topic.heading);
      for (const point of topic.points ?? []) {
        (NEEDLE_RE.test(point) ? needlePoints : keep).push(point);
      }
    }
  }
  // Needle points go first so the 14-point cap can never drop them.
  const points = [...needlePoints, ...keep].slice(0, 14);
  return mockJson(
    {
      range: rangeLabel,
      topics: [
        {
          heading: headings[0]?.slice(0, 60) || rangeLabel,
          points: points.length ? points : ["No readable content."],
          terms: [],
          formulas: [],
          examples: [],
          emphasised: [],
          source: rangeLabel,
        },
      ],
      unclear: [],
    },
    user,
  );
}

function mockStudySet(user) {
  const material = user.split("=== LECTURE MATERIAL ===")[1] ?? user;
  const needle = material.match(NEEDLE_RE)?.[0] ?? "the half-life of dubnium-268 is 28 hours";
  const firstLine = material.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "the lecture material";
  const needleBare = needle.replace(/^NEEDLE-KX7:\s*/i, "");
  return mockJson(
    {
      shortSummary: `This source covers ${firstLine.slice(0, 60)} and the reported values around it. ${needleBare[0].toUpperCase()}${needleBare.slice(1)} The sections repeat the mechanism overview with chapter summaries for revision. Use the key terms and cards below for exam preparation.`,
      keyTerms: [
        { term: "Dubnium-268 half-life", definition: `${needleBare} (p. 48)` },
        { term: "Reaction mechanism", definition: "How the section mechanism operates at the reported degrees and yield." },
        { term: "First-order reaction", definition: "The reaction stays first-order while the catalyst surface is stable." },
        { term: "Reported values", definition: "kPa, mol and duration values listed per section." },
        { term: "Chapter summary", definition: "Revision pointers to tables and worked examples per section." },
        { term: "Catalyst surface", definition: "The stable surface that keeps the reaction first-order." },
      ],
      formulas: [],
      examQuestions: [
        "Explain the mechanism described in the source and its reported yield. (p. 1)",
        "State the half-life of dubnium-268 as given in the source. (p. 48)",
        "Why does the reaction stay first-order in the source's model? (p. 1)",
      ],
      flashcards: [
        { front: "What is the half-life of dubnium-268?", back: `${needleBare} (p. 48)` },
        { front: "What keeps the reaction first-order?", back: "A stable catalyst surface." },
        { front: "What values are reported per section?", back: "Pressure in kPa, amount in mol, duration in minutes." },
        { front: "What should you revise per the chapter summaries?", back: "The pressure table and the worked example." },
        { front: "At what temperature does the mechanism operate?", back: "At the degrees reported in the section text." },
        { front: "What does the source say about the reaction order?", back: "It stays first-order while the catalyst surface is stable." },
      ],
      quiz: [
        { type: "mcq", prompt: "What is the half-life of dubnium-268 according to the source?", options: ["28 hours", "29 hours", "48 hours", "7 hours"], answer: "28 hours", explanation: "The source states the half-life of dubnium-268 is 28 hours." },
        { type: "mcq", prompt: "While the catalyst surface is stable, the reaction stays:", options: ["first-order", "second-order", "zero-order", "spontaneous"], answer: "first-order", explanation: "The source says the reaction stays first-order while the catalyst surface is stable." },
        { type: "mcq", prompt: "Which values does the source report for each section?", options: ["kPa, mol, minutes", "volts, amps, hours", "grams, litres, days", "newtons, metres, seconds"], answer: "kPa, mol, minutes", explanation: "Reported values are pressure, amount and duration." },
        { type: "mcq", prompt: "The chapter summaries point back to:", options: ["the pressure table and worked example", "the appendix", "the glossary", "the index"], answer: "the pressure table and worked example", explanation: "Each summary says to revise the table on pressure and the worked example." },
        { type: "mcq", prompt: "The mechanism in the source operates at:", options: ["the degrees reported per section", "absolute zero", "room temperature only", "unspecified conditions"], answer: "the degrees reported per section", explanation: "Each section reports its own operating degrees." },
      ],
    },
    user,
  );
}

export function mockHandler({ system = "", user = "" }) {
  if (system.startsWith("You extract structured study material")) return mockDigest(user);
  if (system.startsWith("You merge structured study material")) return mockMerge(user, "Merged sections");
  if (system.startsWith("You build a document-level overview")) return mockMerge(user, "Overview");
  if (system.startsWith("You are Sua")) return mockStudySet(user);
  throw new Error(`mock provider: unrecognised prompt family — ${system.slice(0, 60)}`);
}

const KIND_ALIASES = new Map([
  ["lecture_note", "lecture_note"],
  ["notes", "lecture_note"],
  ["reference", "course_reference"],
  ["course_reference", "course_reference"],
  ["study_set", "study_set"],
]);

const SOURCE_TYPES = new Set(["typed", "file", "recording"]);

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

/** No-op sink: eval must never write AiCall rows (there is no job to attach). */
const evalDeps = {
  record: async () => {},
  setStage: async () => {},
  assertAlive: async () => {},
  saveAssetText: async () => {},
  readBytes: async () => {
    throw new Error("readBytes was not provided for this sample");
  },
  // documentSegments only parses a file itself when the runner supplied these;
  // without them a --doc sample has no text and every kind reports "unreadable".
  extractDocument: async (bytes, format, kind) => {
    const { extractDocument } = await import("../src/lib/extract.js");
    return extractDocument(bytes, format, kind);
  },
  renderPdfPage: async (bytes, page, scale) => {
    const { renderPdfPage } = await import("../src/lib/extract.js");
    return renderPdfPage(bytes, page, scale);
  },
  isRenderedPageBlank: async (image) => {
    const { isRenderedPageBlank } = await import("../src/lib/extract.js");
    return isRenderedPageBlank(image);
  },
};

function depsFor(bytes) {
  return { ...evalDeps, readBytes: async () => bytes };
}

/**
 * A text sample has no pages and no audio, so its "length" comes from the file
 * name or an explicit --source. Long samples must exercise Split + Digest.
 */
function sourceForText(text, sourceType) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (sourceType === "file") {
    return sourceFromText(text, {
      sourceType,
      pageCount: Math.max(1, Math.ceil(words / 450)),
    });
  }
  if (sourceType === "recording") {
    return sourceFromText(text, {
      sourceType,
      minutes: Math.max(1, Math.ceil(words / 110)),
    });
  }
  return sourceFromText(text, { sourceType: "typed" });
}

function sizeOverride(source, { pages, minutes }) {
  if (pages) return { ...source, pageCount: pages };
  if (minutes) return { ...source, minutes };
  return source;
}

async function writeOutput(name, kind, payload) {
  const extension = kind === "study_set" ? "json" : "md";
  const file = path.join(outDir, `${name}.${kind}.${extension}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(file, typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  return file;
}

function languageCheck(body) {
  // Cheap guard against a prompt regression switching output language. Formulas
  // live in backticks and headings are labels, so neither says anything about
  // the prose language — a formula-heavy note is still English.
  const expected = notePipeline.outputLanguage.toLowerCase();
  if (expected !== "english") return null;
  const prose = body
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^#{1,6}\s.*$/gm, " ");
  const words = prose.split(/\s+/).filter((word) => /[a-z]{2}/i.test(word));
  if (words.length < 25) return null;
  const ascii = words.filter((word) => /^[a-z'’-]+$/i.test(word)).length;
  if (ascii / words.length < 0.6) return "output is not English";
  return null;
}

async function evaluateSource({ name, source, kind, courseContext }) {
  const started = Date.now();
  try {
    const prepared = await prepareMaterial({
      note: null,
      kind,
      courseContext,
      deps: evalDeps,
      source,
    });

    if (kind === "study_set") {
      const set = await generateStudySet({
        cleaned: prepared.material,
        courseContext,
        durationMinutes: Math.max(1, source.minutes || 50),
        jobId: "eval",
        record: async () => {},
      });
      const problem = validateStudySet(set);
      await writeOutput(name, kind, set);
      return {
        name,
        kind,
        ok: !problem,
        problem,
        ms: Date.now() - started,
        cards: set.flashcards?.length ?? 0,
        quiz: set.quiz?.length ?? 0,
        sections: (set.summaryMarkdown?.match(/^## /gm) ?? []).length,
        meta: prepared.meta,
      };
    }

    const written = await writeNote({ prepared, kind, courseContext });
    await writeOutput(name, kind, written.body);
    const headings = (written.body.match(/^## /gm) ?? []).length;
    const problems = [];
    if (headings < 1) problems.push("no ## sections");
    if (
      written.body.length <
      Math.min(notePipeline.noteMinChars, prepared.source.rawText.length / 2)
    ) {
      problems.push("too short");
    }
    if (written.meta.fidelityFailed) problems.push("fidelity check failed");
    for (const problem of written.meta.structureProblems ?? []) {
      problems.push(`structure: ${problem}`);
    }
    if (written.meta.truncated) problems.push("source truncated");
    const language = languageCheck(written.body);
    if (language) problems.push(language);
    return {
      name,
      kind,
      ok: problems.length === 0,
      problem: problems.join(", ") || undefined,
      ms: Date.now() - started,
      headings,
      words: written.meta.words,
      check: written.meta.checkPassed ? "pass" : "fail",
      unsupported: written.meta.unsupportedNumbers?.slice(0, 6) ?? [],
      digests: written.meta.digests,
      pages: written.meta.pagesUsed,
      meta: written.meta,
    };
  } catch (error) {
    return {
      name,
      kind,
      ok: false,
      problem: error?.message ?? String(error),
      ms: Date.now() - started,
    };
  }
}

async function evaluateDocument(file, kind, courseContext) {
  const bytes = Buffer.from(await readFile(file));
  const format = path.extname(file).slice(1).toLowerCase();
  const kindOfAsset = ["png", "jpg", "jpeg", "webp", "heic", "heif"].includes(format)
    ? "image"
    : ["m4a", "mp3", "wav", "ogg", "aac"].includes(format)
      ? "audio"
      : "document";
  if (kindOfAsset === "audio") {
    const started = Date.now();
    try {
      const result = await geminiTranscribe({ bytes, mimeType: "audio/mp4" });
      return {
        name: path.basename(file),
        kind: "transcribe",
        ok: Boolean(result.text?.trim()),
        ms: Date.now() - started,
        words: result.text.split(/\s+/).filter(Boolean).length,
      };
    } catch (error) {
      return { name: path.basename(file), kind: "transcribe", ok: false, problem: error.message };
    }
  }

  const note = {
    id: "eval",
    body: "",
    transcript: null,
    sourceType: "file",
    assets: [
      {
        id: "eval-asset",
        kind: kindOfAsset,
        status: "active",
        publicId: "eval",
        bytes: bytes.length,
        format,
        extractedText: null,
        createdAt: new Date(),
      },
    ],
  };
  const started = Date.now();
  let source;
  try {
    source = await assembleSource(note, depsFor(bytes));
  } catch (error) {
    return {
      name: path.basename(file),
      kind,
      ok: false,
      problem: error?.message ?? String(error),
      ms: Date.now() - started,
    };
  }
  return evaluateSource({
    name: path.basename(file),
    source,
    kind,
    courseContext,
  });
}

function describe(result) {
  const head = `${result.ok ? "PASS" : "FAIL"} ${result.name} [${result.kind}] — ${result.ms}ms`;
  const details = [];
  if (result.cards !== undefined) {
    details.push(`${result.cards} cards`, `${result.quiz} quiz`, `${result.sections} sections`);
  }
  if (result.headings !== undefined) {
    details.push(`${result.headings} sections`, `${result.words} words`, `check ${result.check}`);
    if (result.digests) details.push(`${result.digests} digests`);
    if (result.pages) details.push(`${result.pages} segments`);
  }
  if (result.unsupported?.length) details.push(`unsupported ${result.unsupported.join(",")}`);
  if (result.words !== undefined && result.headings === undefined) details.push(`${result.words} words`);
  if (result.problem) details.push(`problem: ${result.problem}`);
  return details.length ? `${head} (${details.join(", ")})` : head;
}

// ---------------------------------------------------------------------------
// --long: needle / resume / failure / cost tests over the real long-file
// pipeline pieces (structure → map → reduce → generate) with a stub job row,
// so the eval never touches the database but still runs production code.
// ---------------------------------------------------------------------------

const NEEDLE_TEXT = "NEEDLE-KX7: the half-life of dubnium-268 is 28 hours.";

export function syntheticPages({ sections, pagesPerSection, needlePage }) {
  const rows = [];
  let page = 0;
  for (let s = 1; s <= sections; s += 1) {
    for (let p = 1; p <= pagesPerSection; p += 1) {
      page += 1;
      const lines =
        p === 1
          ? [
              // Only the section's first page carries an ALL-CAPS heading, the
              // way a real textbook does — otherwise every page anchors a
              // "section" and the run balloons (12 sections became 60).
              `SECTION ${s} TOPIC`,
              `The mechanism in section ${s} operates at ${40 + s * 3} degrees with a yield of ${70 + s}.`,
              `Values reported: ${s * 11} kPa, ${s * 2}.5 mol, duration ${10 + s} minutes.`,
              "Key concept: the reaction stays first-order while the catalyst surface is stable.",
              `Chapter summary ${s}.${p}: revise the table on pressure and the worked example.`,
            ]
          : [
              `The mechanism in section ${s} continues at ${40 + s * 3} degrees with a yield of ${70 + s}.`,
              `Values reported: ${s * 11} kPa, ${s * 2}.5 mol, duration ${10 + s} minutes.`,
              "Key concept: the reaction stays first-order while the catalyst surface is stable.",
              `Chapter summary ${s}.${p}: revise the table on pressure and the worked example.`,
            ];
      if (page === needlePage) lines.push(NEEDLE_TEXT);
      rows.push({
        index: page,
        startPage: page,
        endPage: page,
        label: `p. ${page}`,
        text: lines.join("\n"),
        hash: `syn-${page}`,
        status: "done",
      });
    }
  }
  return rows;
}

async function longEval(sectionsArg, courseContext, mock = false) {
  const started = Date.now();
  const sections = Math.max(3, Number(sectionsArg) || 12);
  const pagesPerSection = 5;
  const needlePage = Math.round(sections * pagesPerSection * 0.8);
  const rows = syntheticPages({ sections, pagesPerSection, needlePage });

  const structure = buildSections({ rows, structureHints: {}, pageCount: rows.length });
  const groups = groupRowsIntoChunks({ rows, sections: structure });

  // record() doubles as the cost meter: every model call lands here.
  // onCheckpoint captures the state production would persist, so the resume
  // test can seed a second run the way a retried job really resumes.
  let capturedCheckpoint = {};
  const calls = [];
  const deps = {
    ...evalDeps,
    record: async (step, result) => {
      calls.push({ step, promptTokens: result?.promptTokens ?? 0, completionTokens: result?.completionTokens ?? 0 });
    },
    onCheckpoint: async (checkpoint) => {
      capturedCheckpoint = checkpoint;
    },
  };
  const job = {
    id: "eval-long",
    kind: "study_set",
    userId: "eval",
    createdAt: new Date(),
    startedAt: new Date(),
    checkpoint: {},
  };

  // 1. Needle + cost: map and reduce the whole source. A provider outage
  // (500s on every model call) surfaces as a reported problem, not a crash.
  let map = null;
  let reduce = null;
  let mainFailure = null;
  try {
    map = await mapDigests({ job, groups, courseContext, sourceType: "file", deps });
    reduce = await reduceDigests({
      job,
      digests: map.digests,
      groups,
      sections: structure,
      sourceType: "file",
      courseContext,
      deps,
    });
  } catch (error) {
    mainFailure = error?.message ?? String(error);
  }
  const summariesText = reduce
    ? (reduce.summaryList ?? []).map((item) => digestToText(item.summary)).join("\n")
    : "";
  const overviewText = reduce?.overview ? digestToText(reduce.overview) : "";
  const needleInSummaries = /28 hours|dubnium/i.test(summariesText);
  const needleInOverview = /28 hours|dubnium/i.test(overviewText);

  // 2. Generation from the reduced material (single-mode simulation, scaled).
  let set = null;
  let setProblem = null;
  let needleInSet = false;
  if (reduce) {
    try {
      const material = `${overviewText}\n\n${summariesText}`.slice(0, longDoc.reduceMaxChars);
      set = await generateStudySet({
        cleaned: material,
        courseContext,
        durationMinutes: 90,
        jobId: "eval-long",
        record: async () => {},
      });
      setProblem = validateStudySet(set);
      needleInSet = /28 hours|dubnium/i.test(JSON.stringify(set));
    } catch (error) {
      setProblem = error?.message ?? String(error);
    }
  }

  // 3. Resume: a second map run over the checkpoint must make ZERO new calls.
  const resumeCalls = [];
  try {
    await mapDigests({
      job: { ...job, checkpoint: { ...job.checkpoint, ...capturedCheckpoint } },
      groups,
      courseContext,
      sourceType: "file",
      deps: { ...deps, record: async (step) => resumeCalls.push(step) },
    });
  } catch (error) {
    resumeCalls.push(`resume run failed: ${error?.message ?? String(error)}`);
  }

  // 4. Failure injection: one group is unreadable garbage — the map must
  // survive it (lost range reported) as long as the ratio stays under cap.
  const broken = [...groups];
  broken[broken.length - 1] = { ...broken[broken.length - 1], text: "\u0000\u0001\u0002".repeat(500) };
  const failureJob = { id: "eval-long-failure", kind: "study_set", userId: "eval", createdAt: new Date(), startedAt: new Date(), checkpoint: {} };
  let failureLost = null;
  let failureProblem = null;
  try {
    const failureMap = await mapDigests({
      job: failureJob,
      groups: broken,
      courseContext,
      sourceType: "file",
      deps,
    });
    failureLost = failureMap.lost;
  } catch (error) {
    failureProblem = error?.message ?? String(error);
  }

  const resumeRunFailed = resumeCalls.some((entry) => String(entry).startsWith("resume run failed"));
  const resumeCallCount = resumeCalls.length - (resumeRunFailed ? 1 : 0);
  const resumeClean = !resumeRunFailed && resumeCallCount === 0;

  // 5. Checkpoint ownership: stages share one JSON column, so each must merge
  // only its own keys. Reduce used to write the whole column from a stale
  // snapshot and dropped the digest map — an interrupted run then redid the
  // entire map and could never get past the digest stage.
  const afterMap = mergeCheckpoint({}, { digests: { a: "x" }, digestFailures: {}, mapCalls: 1 });
  const afterReduce = mergeCheckpoint(afterMap, { reduce: { wave: "y" } });
  const checkpointKeepsStages =
    Object.keys(afterReduce.digests ?? {}).length === 1 &&
    Object.keys(afterReduce.reduce ?? {}).length === 1 &&
    afterReduce.mapCalls === 1;
  // A later map patch (complete digest map) must still leave reduce in place.
  const afterNextMap = mergeCheckpoint(afterReduce, {
    digests: { ...afterReduce.digests, b: "z" },
  });
  const checkpointMergesDigests =
    Object.keys(afterNextMap.digests).length === 2 &&
    Object.keys(afterNextMap.reduce).length === 1;

  // 6. Invocation budget: past the deadline no new model call starts and the
  // stage reports a yield (re-queued, never a student-visible failure).
  const mapYieldCalls = [];
  let mapYield = false;
  let mapYieldUserFacing = true;
  try {
    await mapDigests({
      job: { ...job, id: "eval-long-yield-map", checkpoint: {} },
      groups,
      courseContext,
      sourceType: "file",
      deps: { ...deps, deadline: Date.now() - 1, record: async (step) => mapYieldCalls.push(step) },
    });
  } catch (error) {
    mapYield = isJobYield(error);
    mapYieldUserFacing = !isJobYield(error) && Boolean(error?.userFacing);
  }
  const reduceYieldCalls = [];
  let reduceYield = false;
  if (map) {
    try {
      await reduceDigests({
        job: { ...job, id: "eval-long-yield-reduce", checkpoint: {} },
        digests: map.digests,
        groups,
        sections: structure,
        sourceType: "file",
        courseContext,
        deps: { ...deps, deadline: Date.now() - 1, record: async (step) => reduceYieldCalls.push(step) },
      });
    } catch (error) {
      reduceYield = isJobYield(error);
    }
  }

  // 7. Partial map + resume: the budget runs out after three digests, the
  // stage yields, and the next pass continues from the emitted checkpoint.
  // Across both passes every group is attempted exactly once — finished
  // digests are never paid for twice.
  const budget = { deadline: Date.now() + 60_000 };
  const partialCalls = [];
  let partialCheckpoint = {};
  let partialYielded = false;
  try {
    await mapDigests({
      job: { ...job, id: "eval-long-partial", checkpoint: {} },
      groups,
      courseContext,
      sourceType: "file",
      deps: {
        ...deps,
        get deadline() {
          return budget.deadline;
        },
        record: async (step) => {
          partialCalls.push(step);
          if (partialCalls.length === 3) budget.deadline = Date.now() - 1;
        },
        onCheckpoint: async (checkpoint) => {
          partialCheckpoint = checkpoint;
        },
      },
    });
  } catch (error) {
    partialYielded = isJobYield(error);
  }
  let resumeAfterYieldCalls = 0;
  if (partialYielded) {
    await mapDigests({
      job: { ...job, id: "eval-long-partial-resume", checkpoint: partialCheckpoint },
      groups,
      courseContext,
      sourceType: "file",
      deps: {
        ...deps,
        record: async () => {
          resumeAfterYieldCalls += 1;
        },
      },
    }).catch(() => {
      resumeAfterYieldCalls = -1;
    });
  }
  const resumeAfterYieldClean =
    partialYielded && resumeAfterYieldCalls >= 0 && partialCalls.length + resumeAfterYieldCalls === groups.length;

  const report = {
    mode: mock ? "mock" : "live",
    sections: structure.length,
    groups: groups.length,
    digests: Object.keys(map?.digests ?? {}).length,
    lost: map?.lost ?? [],
    needleInSummaries,
    needleInOverview,
    needleInSet,
    setProblem,
    resumeClean,
    resumeCalls,
    checkpointKeepsStages,
    checkpointMergesDigests,
    mapYield,
    mapYieldCalls: mapYieldCalls.length,
    mapYieldUserFacing,
    reduceYield,
    reduceYieldCalls: reduceYieldCalls.length,
    partialYielded,
    partialCalls: partialCalls.length,
    resumeAfterYieldCalls,
    resumeAfterYieldClean,
    modelCalls: calls.length,
    promptTokens: calls.reduce((sum, call) => sum + call.promptTokens, 0),
    completionTokens: calls.reduce((sum, call) => sum + call.completionTokens, 0),
    failureReported: Boolean(failureLost?.length) || Boolean(failureProblem),
    failureLost,
    failureProblem,
    mainFailure,
    cards: set?.flashcards?.length ?? 0,
    quiz: set?.quiz?.length ?? 0,
  };
  const problems = [];
  if (mainFailure) {
    // Provider/model outage or a pipeline error — report the cause verbatim
    // instead of pretending the needle checks ran.
    problems.push(`map/reduce failed: ${mainFailure}`);
  } else {
    if (!needleInSummaries) problems.push("needle lost in summaries");
    if (!needleInSet) problems.push("needle lost in study set");
    if (setProblem) problems.push(`study set invalid: ${setProblem}`);
  }
  if (!resumeClean) {
    problems.push(resumeRunFailed ? "resume run failed" : `resume made ${resumeCallCount} extra calls`);
  }
  if (!report.failureReported) problems.push("injected failure was silently swallowed");
  if (!checkpointKeepsStages || !checkpointMergesDigests) {
    problems.push("checkpoint stages clobber each other's keys");
  }
  if (!mapYield || mapYieldCalls.length !== 0) problems.push("map ignored the invocation deadline");
  if (!reduceYield || reduceYieldCalls.length !== 0) problems.push("reduce ignored the invocation deadline");
  if (mapYieldUserFacing) problems.push("a yield was reported as a student-visible failure");
  if (!partialYielded) {
    problems.push("a partial map did not yield");
  } else if (!resumeAfterYieldClean) {
    problems.push(
      `yield/resume repeated work: ${partialCalls.length}+${resumeAfterYieldCalls} calls for ${groups.length} groups`,
    );
  }

  await writeOutput("long-doc", "study_set", report);
  return {
    name: `long-doc (${sections} sections / ${rows.length} pages)`,
    kind: "long",
    ok: problems.length === 0,
    problem: problems.join(", ") || undefined,
    ms: Date.now() - started,
    ...report,
  };
}

async function main() {
  const args = process.argv.slice(2);
  // --mock: answer every model call with the deterministic mock provider
  // (offline, free, repeatable) instead of the live endpoint.
  const mock = args.includes("--mock");
  if (mock) setAiMock(mockHandler);

  // --long [N]: long-file pipeline tests (needle / resume / failure / cost)
  // over synthetic pages — no database needed, production prompts and models.
  if (args.includes("--long")) {
    await mkdir(outDir, { recursive: true });
    const courseContext = argValue(args, "--course") ?? "PHYS 201, Introductory Physics";
    const result = await longEval(Number(argValue(args, "--sections")) || 0, courseContext, mock);
    console.log(describe(result));
    await writeFile(
      path.join(outDir, "report.json"),
      JSON.stringify({ kind: "long", results: [result] }, null, 2),
    );
    process.exit(result.ok ? 0 : 1);
  }

  const kindFlag = argValue(args, "--kind") ?? "lecture_note";
  const kind = KIND_ALIASES.get(kindFlag);
  if (!kind) {
    console.error(`--kind must be one of: ${[...KIND_ALIASES.keys()].join(", ")}`);
    process.exit(2);
  }
  const sourceFlag = argValue(args, "--source") ?? "typed";
  if (!SOURCE_TYPES.has(sourceFlag)) {
    console.error(`--source must be one of: ${[...SOURCE_TYPES].join(", ")}`);
    process.exit(2);
  }
  const courseContext = argValue(args, "--course") ?? "PHYS 201, Introductory Physics";
  // Override the derived size so one text file can stand in for a 30-page
  // handout or a 45-minute recording.
  const pagesOverride = Number(argValue(args, "--pages")) || 0;
  const minutesOverride = Number(argValue(args, "--minutes")) || 0;
  const docFile = argValue(args, "--doc");
  const audioFile = argValue(args, "--audio");
  const single = args.find(
    (arg, index) =>
      !arg.startsWith("--") &&
      !["--kind", "--source", "--course", "--doc", "--audio", "--pages", "--minutes", "--sections"].includes(
        args[index - 1],
      ),
  );

  await mkdir(outDir, { recursive: true });

  const results = [];
  if (docFile) {
    results.push(await evaluateDocument(path.resolve(docFile), kind, courseContext));
  } else if (audioFile) {
    results.push(await evaluateDocument(path.resolve(audioFile), kind, courseContext));
  } else {
    if (!existsSync(samplesDir)) {
      console.log(`No samples directory at ${samplesDir}. Run: node scripts/make-eval-fixtures.mjs`);
      return;
    }
    const files = single
      ? [path.resolve(single)]
      : readdirSync(samplesDir)
          .filter((file) => /\.(txt|md)$/.test(file))
          .map((file) => path.join(samplesDir, file))
          .sort();
    if (!files.length) {
      console.log(`No .txt/.md samples in ${samplesDir}.`);
      return;
    }
    for (const file of files) {
      const text = await readFile(file, "utf8");
      console.log(`Evaluating ${path.basename(file)} as ${kind} (${sourceFlag})…`);
      results.push(
        await evaluateSource({
          name: path.basename(file),
          source: sizeOverride(sourceForText(text, sourceFlag), {
            pages: pagesOverride,
            minutes: minutesOverride,
          }),
          kind,
          courseContext,
        }),
      );
    }
  }

  console.log("\n=== RESULTS ===");
  for (const result of results) console.log(describe(result));
  const passed = results.filter((result) => result.ok).length;
  console.log(`${passed}/${results.length} passed — outputs in ${outDir}`);
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ kind, sourceFlag, results }, null, 2),
  );
  process.exit(passed === results.length ? 0 : 1);
}

// Only run the CLI when executed directly — importing this module (tests,
// probes) must stay side-effect free.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
