/**
 * AI pipeline evaluation harness.
 *
 * Usage (from backend/):
 *   npm run eval                          # evaluates .txt/.md samples in eval-samples/
 *   npm run eval path/to/lecture.txt      # evaluates one text sample
 *   npm run eval -- --audio sample.m4a    # transcription round-trip (costs tokens)
 *
 * Expects GEMINI_API_KEY / OPENROUTER_API_KEY in backend/.env. For audio files
 * also requires REDIS_URL unused — transcription runs inline, no queue.
 *
 * Reports: parse rate, validation failures, counts (cards/quiz/summary
 * sections), latency, estimated cost, and writes the raw outputs to
 * eval-samples/out/<sample>.json for manual review.
 */
import "./src/config/env.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geminiTranscribe, bulkModel, openRouterChat } from "../src/lib/ai.js";
import { generateStudySet, validateStudySet } from "../src/lib/pipeline.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(dirname, "eval-samples");
const outDir = path.join(samplesDir, "out");

async function evaluateTextFile(file) {
  const text = await readFile(file, "utf8");
  const started = Date.now();
  try {
    const set = await generateStudySet({
      cleaned: text,
      courseContext: "Introductory course (eval sample)",
      durationMinutes: 50,
      jobId: `eval:${path.basename(file)}`,
    });
    const problem = validateStudySet(set);
    await writeFile(
      path.join(outDir, `${path.basename(file)}.json`),
      JSON.stringify(set, null, 2),
    );
    return {
      file: path.basename(file),
      ok: !problem,
      problem,
      ms: Date.now() - started,
      flashcards: set.flashcards.length,
      quiz: set.quiz.length,
      summaryHeadings: (set.summaryMarkdown.match(/^## /gm) ?? []).length,
    };
  } catch (error) {
    return { file: path.basename(file), ok: false, problem: error.message, ms: Date.now() - started };
  }
}

async function evaluateAudio(file) {
  const bytes = Buffer.from(await readFile(file));
  const mime = file.endsWith(".m4a") ? "audio/mp4" : file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
  const started = Date.now();
  try {
    const transcription = await geminiTranscribe({ bytes, mimeType: mime });
    const words = transcription.text.split(/\s+/).length;
    return {
      file: path.basename(file),
      ok: true,
      ms: Date.now() - started,
      words,
      tokens: transcription.promptTokens + transcription.completionTokens,
    };
  } catch (error) {
    return { file: path.basename(file), ok: false, problem: error.message, ms: Date.now() - started };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const audio = args.includes("--audio") ? args[args.indexOf("--audio") + 1] : null;

  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

  let results;
  if (audio) {
    console.log(`Transcribing ${audio}…`);
    results = [await evaluateAudio(path.resolve(audio))];
  } else {
    const single = args[0] ? path.resolve(args[0]) : null;
    const files = single
      ? [single]
      : readdirSync(samplesDir).filter((f) => /\.(txt|md)$/.test(f));
    if (!files.length) {
      console.log(
        `No samples. Add lecture .txt files to ${samplesDir} (5 real lectures target).`,
      );
      return;
    }
    results = [];
    for (const file of files) {
      console.log(`Evaluating ${file}…`);
      results.push(await evaluateTextFile(file));
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log("\n=== RESULTS ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.file} — ${r.ms}ms` +
        (r.flashcards ? `, ${r.flashcards} cards, ${r.quiz} quiz, ${r.summaryHeadings} sections` : "") +
        (r.problem ? `, problem: ${r.problem}` : ""),
    );
  }
  console.log(`${okCount}/${results.length} passed`);
  if (process.env.AI_DAILY_SPEND_ALERT_GHS) console.log("(cost totals visible at GET /api/jobs/spend)");
  process.exit(okCount === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
