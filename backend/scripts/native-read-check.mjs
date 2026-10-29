// Native read check.
//
// Usage (from backend/, Node 20.6+ so .env is loaded):
//   node --env-file=.env scripts/native-read-check.mjs [file ...]
//
// With no arguments it reads the eval samples (30-page handout, 5-page scan,
// photo, slide deck). PDFs and photos are read by the model directly; DOCX/PPTX
// print their local text plus how many embedded pictures were found and read.
// Prints sizes, timings and token usage — never the whole document, never the
// API key.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { readDocumentNatively } from "../src/lib/native-read.js";
import { extractDocument, extractEmbeddedImages } from "../src/lib/extract.js";

const DEFAULT_SAMPLES = [
  "scripts/eval-samples/handout-30p.pdf",
  "scripts/eval-samples/scanned-5p.pdf",
  "scripts/eval-samples/notes-photo.png",
  "scripts/eval-samples/slides-10.pptx",
];

const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const samples = files.length ? files : DEFAULT_SAMPLES;

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY (run with --env-file=.env)");
  process.exit(1);
}

const rows = [];
for (const file of samples) {
  const bytes = await readFile(file);
  const format = path.extname(file).slice(1).toLowerCase();
  const started = Date.now();
  const result = await readDocumentNatively({ bytes, format });
  const elapsed = Date.now() - started;

  if (result.ok) {
    const chars = result.pages.reduce((sum, page) => sum + page.text.length, 0);
    console.log(
      `${file}: OK ${result.pageCount}p aligned=${result.aligned} chars=${chars} ` +
        `topics=${result.digest?.topics?.length ?? 0} terms=${result.digest?.keyTerms?.length ?? 0} ` +
        `in=${result.promptTokens} out=${result.completionTokens} ${elapsed}ms`,
    );
    console.log(`  first page: ${JSON.stringify(result.pages[0]?.text?.slice(0, 120) ?? "")}`);
    rows.push({
      file: path.basename(file),
      pages: result.pageCount,
      aligned: result.aligned,
      chars,
      digest: `${result.digest?.topics?.length ?? 0}t/${result.digest?.keyTerms?.length ?? 0}k`,
      tokens: `${result.promptTokens}/${result.completionTokens}`,
      ms: elapsed,
      result: "OK",
    });
    continue;
  }

  // DOCX/PPTX (and anything else) keep their local text; only their pictures
  // are read by the model.
  const extracted = await extractDocument(bytes, format, "document");
  const images =
    result.code === "DISABLED"
      ? await extractEmbeddedImages(bytes, format, { minBytes: 6000, limit: 24 })
      : [];
  const imagesRead = images.length
    ? await (await import("../src/lib/native-read.js")).readEmbeddedVisuals({
        images,
        timeoutMs: 120_000,
      })
    : null;
  const kind = extracted ? "LOCAL" : "SKIP";
  console.log(
    `${file}: ${kind} ${result.code} segments=${extracted?.segments?.length ?? 0} ` +
      `pages=${extracted?.pageCount ?? 0} chars=${extracted?.text?.length ?? 0} ` +
      `images=${images.length} read=${imagesRead?.text?.size ?? 0} ${Date.now() - started}ms`,
  );
  rows.push({
    file: path.basename(file),
    pages: extracted?.pageCount ?? "-",
    aligned: "-",
    chars: extracted?.text?.length ?? 0,
    digest: `${images.length}img/${imagesRead?.text?.size ?? 0}read`,
    tokens: "-",
    ms: Date.now() - started,
    result: kind,
  });
}

console.table(rows);
