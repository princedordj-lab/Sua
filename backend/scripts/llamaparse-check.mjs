// LlamaParse smoke check against the real API.
//
//   cd backend && npm run llamaparse:check -- scripts/eval-samples/handout-30p.pdf
//   ... --save-pages .tmp/llamaparse-pages
//
// Uploads one local file, starts a parse job, polls in this process (a CLI may
// poll; a request may not) and prints per-page success, credits and timing.
// Never prints the API key or a signed URL.

import "../src/config/env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { llamaParse } from "../src/config/ai-pipeline.js";
import {
  createParseJob,
  getParseJob,
  getParseResult,
  llamaParseEnabled,
  llamaparseMimeType,
  uploadToLlamaCloud,
} from "../src/lib/llamaparse.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const saveIndex = args.indexOf("--save-pages");
const saveDir = saveIndex >= 0 ? args[saveIndex + 1] : null;

if (!file) {
  console.error("Usage: npm run llamaparse:check -- <file.pdf|docx|pptx> [--save-pages <dir>]");
  process.exit(1);
}
if (!llamaParseEnabled()) {
  console.error("Missing LLAMA_CLOUD_API_KEY (set it in backend/.env or .env.local)");
  process.exit(1);
}

const format = path.extname(file).slice(1).toLowerCase();
if (!llamaParse.formats.includes(format)) {
  console.error(`Unsupported format: ${format}. Expected pdf, docx or pptx.`);
  process.exit(1);
}

const bytes = await readFile(file);
const started = Date.now();
console.log(
  `file=${file} bytes=${bytes.length} format=${format} tier=${llamaParse.tier} version=${llamaParse.version}`,
);

const { fileId } = await uploadToLlamaCloud({
  bytes,
  filename: path.basename(file),
  mimeType: llamaparseMimeType(format),
});
console.log(`uploaded file=${fileId} ms=${Date.now() - started}`);

const job = await createParseJob({ fileId });
console.log(`parse job=${job.jobId} status=${job.status}`);

let polls = 0;
while (true) {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  polls += 1;
  const status = await getParseJob({ jobId: job.jobId });
  console.log(
    `poll ${polls}: ${status.status}${status.credits != null ? ` credits=${status.credits}` : ""}`,
  );
  if (status.status === "COMPLETED") break;
  if (status.status === "FAILED" || status.status === "CANCELLED") {
    console.error(`parse ended ${status.status}: ${status.errorMessage ?? "no detail"}`);
    process.exit(1);
  }
  if (Date.now() - started > llamaParse.timeoutMs) {
    console.error(`parse did not complete within ${llamaParse.timeoutMs}ms`);
    process.exit(1);
  }
}

const result = await getParseResult({ jobId: job.jobId });
const usable = result.pages.filter((page) => page.success && page.markdown.trim());
const chars = usable.reduce((sum, page) => sum + page.markdown.length, 0);
console.log(
  `pages=${result.pages.length} usable=${usable.length} failed=${result.pagesFailed} chars=${chars} credits=${result.credits ?? "unknown"} ms=${Date.now() - started}`,
);
for (const page of result.pages) {
  console.log(
    `p.${page.pageNumber} success=${page.success} chars=${page.markdown.length}${page.error ? ` error=${page.error}` : ""}`,
  );
}

if (saveDir) {
  await mkdir(saveDir, { recursive: true });
  for (const page of result.pages) {
    await writeFile(path.join(saveDir, `page-${page.pageNumber}.md`), page.markdown, "utf8");
  }
  console.log(`saved ${result.pages.length} page(s) to ${saveDir}`);
}
