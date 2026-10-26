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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geminiTranscribe } from "../src/lib/ai.js";
import { assembleSource, prepareMaterial, sourceFromText, writeNote } from "../src/lib/note-pipeline.js";
import { generateStudySet, validateStudySet } from "../src/lib/pipeline.js";
import { notePipeline } from "../src/config/ai-pipeline.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(dirname, "eval-samples");
const backendDir = path.join(dirname, "..");
const outDir = path.join(backendDir, ".tmp", "eval");

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

async function main() {
  const args = process.argv.slice(2);
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
      !["--kind", "--source", "--course", "--doc", "--audio", "--pages", "--minutes"].includes(
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
