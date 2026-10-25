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
import {
  generateLectureNote,
  generateReference,
  generateStudySet,
  validateStudySet,
} from "../src/lib/pipeline.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(dirname, "eval-samples");
const outDir = path.join(samplesDir, "out");

async function evaluateTextFile(file, kind = "study_set") {
  const text = await readFile(file, "utf8");
  const started = Date.now();
  const context = "Introductory course (eval sample)";
  const jobId = `eval:${path.basename(file)}`;
  try {
    if (kind === "lecture_note") {
      const body = await generateLectureNote({ cleaned: text, courseContext: context, jobId });
      await writeFile(
        path.join(outDir, `${path.basename(file)}.lecture-note.md`),
        body,
      );
      const headings = (body.match(/^## /gm) ?? []).length;
      return {
        file: path.basename(file),
        kind,
        ok: body.length >= 400 && headings >= 1,
        problem: headings < 1 ? "no sections" : undefined,
        ms: Date.now() - started,
        headings,
        chars: body.length,
      };
    }
    if (kind === "reference") {
      const markdown = await generateReference({ cleaned: text, courseContext: context, jobId });
      await writeFile(
        path.join(outDir, `${path.basename(file)}.reference.md`),
        markdown,
      );
      const terms = (markdown.match(/^- \*\*/gm) ?? []).length;
      return {
        file: path.basename(file),
        kind,
        ok: markdown.includes("## Key Terms") && terms >= 1,
        problem: terms < 1 ? "no key terms" : undefined,
        ms: Date.now() - started,
        terms,
        chars: markdown.length,
      };
    }
    const set = await generateStudySet({
      cleaned: text,
      courseContext: context,
      durationMinutes: 50,
      jobId,
    });
    const problem = validateStudySet(set);
    await writeFile(
      path.join(outDir, `${path.basename(file)}.json`),
      JSON.stringify(set, null, 2),
    );
    return {
      file: path.basename(file),
      kind,
      ok: !problem,
      problem,
      ms: Date.now() - started,
      flashcards: set.flashcards.length,
      quiz: set.quiz.length,
      summaryHeadings: (set.summaryMarkdown.match(/^## /gm) ?? []).length,
    };
  } catch (error) {
    return { file: path.basename(file), kind, ok: false, problem: error.message, ms: Date.now() - started };
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
  const kindFlag = args.includes("--kind") ? args[args.indexOf("--kind") + 1] : "study_set";
  const kind = KINDS.has(kindFlag) ? kindFlag : "study_set";

  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

  let results;
  if (audio) {
    console.log(`Transcribing ${audio}…`);
    results = [await evaluateAudio(path.resolve(audio))];
  } else {
    const single = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
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
      console.log(`Evaluating ${file} as ${kind}…`);
      results.push(await evaluateTextFile(file, kind));
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log("\n=== RESULTS ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.file} [${r.kind ?? "transcribe"}] — ${r.ms}ms` +
        (r.flashcards ? `, ${r.flashcards} cards, ${r.quiz} quiz, ${r.summaryHeadings} sections` : "") +
        (r.headings ? `, ${r.headings} sections, ${r.chars} chars` : "") +
        (r.terms ? `, ${r.terms} terms, ${r.chars} chars` : "") +
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
