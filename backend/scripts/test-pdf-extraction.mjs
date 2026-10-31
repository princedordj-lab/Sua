/**
 * Focused checks for the local-first PDF extraction pipeline.
 *
 *   cd backend && npm run test:pdf
 *
 * These run the real extraction driver (src/lib/extraction.js) end to end —
 * chunk persistence, caps, resume, fallback ordering — against real PDF bytes
 * parsed by the real pdf-parse/canvas stack, with only the database and the
 * model provider replaced by in-memory fakes. "Zero model calls" here is a
 * counted fact, not an assumption.
 *
 * Nothing touches Postgres, Gemini or the network.
 */

import assert from "node:assert/strict";
import {
  classifyPageText,
  extractPdfPages,
  isRenderedPageBlank,
  normalizePageText,
  renderPdfPage,
} from "../src/lib/extract.js";
import {
  extractionDeps,
  readLocalPdfPages,
  runExtractionPass,
} from "../src/lib/extraction.js";
import { longDoc } from "../src/config/ai-pipeline.js";

console.log("=== PDF extraction (local-first) test suite ===");

// ---------------------------------------------------------------------------
// PDF fixture builder: text pages, blank pages and image-only (scanned) pages
// ---------------------------------------------------------------------------

function escapePdf(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

let canvasPromise;
async function canvas() {
  if (!canvasPromise) canvasPromise = import("@napi-rs/canvas");
  return canvasPromise;
}

/** A page-sized JPEG of dark text on paper — the shape of a scan. */
async function scannedPageJpeg(label) {
  const { createCanvas } = await canvas();
  const width = 800;
  const height = 1000;
  const board = createCanvas(width, height);
  const context = board.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111111";
  context.font = "bold 40px Arial";
  context.fillText(label, 60, 90);
  context.font = "26px Arial";
  for (let i = 0; i < 12; i += 1) {
    context.fillText(`Scanned line ${i + 1}: a = v^2 / r and F = m a`, 60, 170 + i * 46);
  }
  return { bytes: board.toBuffer("image/jpeg"), width, height };
}
/**
 * Minimal but valid PDF. Each page is either `{ lines: [...] }` (a text layer,
 * written with Helvetica), `{ image: { bytes, width, height } }` (one image
 * XObject and no text at all, exactly like a scan) or `{}` (a blank page).
 */
function buildPdf(pages) {
  const objects = new Map();
  let next = 4; // 1 catalog, 2 pages, 3 font
  const fontNumber = 3;
  const entries = pages.map((page, position) => {
    const pageNumber = next++;
    const contentNumber = next++;
    const imageName = page.image ? `Im${position + 1}` : null;
    const imageNumber = page.image ? next++ : null;
    return { ...page, pageNumber, contentNumber, imageName, imageNumber };
  });

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${entries.map((entry) => `${entry.pageNumber} 0 R`).join(" ")}] /Count ${entries.length} >>`,
  );
  objects.set(
    fontNumber,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  for (const entry of entries) {
    let stream = "";
    let resources = `<< /Font << /F1 ${fontNumber} 0 R >> >>`;
    if (entry.image) {
      // Fill the media box with the picture; no text operators at all.
      stream = `q 595 0 0 842 0 0 cm /${entry.imageName} Do Q`;
      resources = `<< /XObject << /${entry.imageName} ${entry.imageNumber} 0 R >> >>`;
      objects.set(
        entry.imageNumber,
        `<< /Type /XObject /Subtype /Image /Width ${entry.image.width} /Height ${entry.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${entry.image.bytes.length} >>\nstream\n%BIN%\nendstream`,
      );
    } else if (entry.lines?.length) {
      stream = entry.lines
        .map(
          (line, index) =>
            `BT /F1 11 Tf 50 ${790 - index * 16} Td (${escapePdf(line)}) Tj ET`,
        )
        .join("\n");
    }
    objects.set(
      entry.pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${entry.contentNumber} 0 R >>`,
    );
    objects.set(
      entry.contentNumber,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }

  // Image streams are binary, so they are spliced in at the right offsets
  // instead of going through the latin1 text pass.
  const binaries = new Map();
  for (const entry of entries) {
    if (entry.image) binaries.set(entry.imageNumber, entry.image.bytes);
  }

  const chunks = [];
  const offsets = new Map();
  let position = 0;
  const append = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1");
    chunks.push(buffer);
    position += buffer.length;
  };

  append("%PDF-1.4\n");
  for (const number of [...objects.keys()].sort((a, b) => a - b)) {
    offsets.set(number, position);
    const body = objects.get(number);
    if (!body.includes("%BIN%")) {
      append(`${number} 0 obj\n${body}\nendobj\n`);
      continue;
    }
    const [head, tail] = body.split("%BIN%");
    append(`${number} 0 obj\n${head}`);
    append(binaries.get(number));
    append(`${tail}\nendobj\n`);
  }
  const xrefOffset = position;
  const size = Math.max(...objects.keys()) + 1;
  append(`xref\n0 ${size}\n`);
  append("0000000000 65535 f \n");
  for (let number = 1; number < size; number += 1) {
    const offset = offsets.get(number);
    append(
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`,
    );
  }
  append(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function textPage(title, index = 1) {
  return {
    lines: [
      `PHYS 201 -- ${title}`,
      `Section ${index}.1: Centripetal acceleration`,
      "a = v^2 / r",
      "F = m v^2 / r",
      "A 0.5 kg mass on a 2 m string at 4 m/s needs 4 N inward.",
      "Worked example: omega = 2 pi / T = 2 pi / 0.5 = 12.6 rad/s.",
      "Remember to keep the units consistent before substituting.",
      "The examiner marks the direction of the force strictly.",
      "Practice the tutorial sheet questions 3 to 9 before the test.",
      "Every term in the equation carries the same dimensions.",
    ],
  };
}
// ---------------------------------------------------------------------------
// In-memory stand-in for the Prisma client surface extraction.js uses
// ---------------------------------------------------------------------------

function createFakeDb(asset) {
  const chunkRows = new Map();
  const state = {
    asset: {
      id: "asset-1",
      userId: "user-1",
      kind: "document",
      status: "active",
      format: "pdf",
      bytes: 1024,
      extractedText: null,
      extractState: "running",
      pagesDone: 0,
      pagesTotal: 0,
      nextPage: 1,
      truncated: false,
      ocrPages: 0,
      extractErrorCode: null,
      ...asset,
    },
  };
  const indexKey = (row) => `${row.assetId}:${row.index}`;

  const matches = (where = {}) => (row) => {
    if (where.assetId !== undefined && row.assetId !== where.assetId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.index !== undefined) {
      if (where.index && typeof where.index === "object") {
        if (where.index.gt !== undefined && !(row.index > where.index.gt)) return false;
      } else if (row.index !== where.index) {
        return false;
      }
    }
    return true;
  };
  const query = (where) =>
    [...chunkRows.values()].filter(matches(where)).sort((a, b) => a.index - b.index);

  const db = {
    asset: {
      findUnique: async ({ where }) => (state.asset.id === where.id ? { ...state.asset } : null),
      findFirst: async ({ where }) => (state.asset.id === where.id ? { ...state.asset } : null),
      update: async ({ where, data }) => {
        if (state.asset.id !== where.id) throw new Error("asset not found");
        Object.assign(state.asset, data);
        return { ...state.asset };
      },
      updateMany: async ({ where, data }) => {
        if (state.asset.id !== where.id) return { count: 0 };
        if (where.extractState && state.asset.extractState !== where.extractState) return { count: 0 };
        Object.assign(state.asset, data);
        return { count: 1 };
      },
    },
    sourceChunk: {
      findMany: async ({ where } = {}) => query(where),
      findFirst: async ({ where } = {}) => query(where)[0] ?? null,
      create: async ({ data }) => {
        const row = { id: indexKey(data), ...data };
        chunkRows.set(indexKey(row), row);
        return row;
      },
      createMany: async ({ data }) => {
        for (const entry of data) {
          const row = { id: indexKey(entry), ...entry };
          chunkRows.set(indexKey(row), row);
        }
        return { count: data.length };
      },
      update: async ({ where, data }) => {
        const key = where.assetId_index
          ? `${where.assetId_index.assetId}:${where.assetId_index.index}`
          : null;
        const row = chunkRows.get(key);
        if (!row) throw new Error("chunk not found");
        Object.assign(row, data);
        return row;
      },
      count: async ({ where } = {}) => query(where).length,
      deleteMany: async ({ where } = {}) => {
        const doomed = query(where);
        for (const row of doomed) chunkRows.delete(indexKey(row));
        return { count: doomed.length };
      },
    },
    $transaction: async (fn) => fn(db),
    $queryRaw: async () => [
      { size: [...chunkRows.values()].reduce((sum, row) => sum + (row.text ?? "").length, 0) },
    ],
  };

  return { db, state, rows: () => [...chunkRows.values()].sort((a, b) => a.index - b.index) };
}
// ---------------------------------------------------------------------------
// Fake providers: every model call and page render is counted
// ---------------------------------------------------------------------------

function createProviders({ native = null, ocr = null } = {}) {
  const calls = { nativeRead: 0, ocrBatch: 0, ocrSingle: 0, renders: 0 };
  const deps = {
    ...extractionDeps,
    nativeReadEnabled: () => true,
    readDocumentNatively: async ({ format }) => {
      calls.nativeRead += 1;
      if (typeof native === "function") return native({ format });
      if (native) return native;
      return { ok: false, code: "DISABLED" };
    },
    geminiOcrBatch: async ({ pages }) => {
      calls.ocrBatch += 1;
      if (typeof ocr === "function") return ocr({ pages });
      return pages.map((page) => ({ text: `OCR text for page ${page.index}` }));
    },
    geminiImageText: async ({ bytes }) => {
      calls.ocrSingle += 1;
      if (typeof ocr === "function") throw new Error("batch was expected");
      return { text: `OCR single-page text (${bytes.length} bytes)` };
    },
    renderPdfPage: async (bytes, page, scale) => {
      calls.renders += 1;
      return renderPdfPage(bytes, page, scale);
    },
  };
  return { deps, calls };
}

async function runPass({ pdf, providers, budgetMs = longDoc.extractBudgetMs, format = "pdf" }) {
  const fake = createFakeDb({ format });
  const deps = {
    ...providers.deps,
    db: fake.db,
    readAssetBytes: async () => pdf,
  };
  const outcome = await runExtractionPass(fake.state.asset.id, budgetMs, deps);
  return { ...fake, rows: fake.rows(), outcome, deps };
}
// ---------------------------------------------------------------------------
// 1. Classification rules: the "is this page a failure?" decision
// ---------------------------------------------------------------------------
{
  assert.equal(classifyPageText("Chapter 4: Work and energy").usable, true,
    "a short title page is content, not a failure");
  const formula = classifyPageText("F = m a\nv = u + at");
  assert.equal(formula.usable, true, "formula lines are usable");
  assert.ok(formula.text.includes("\n"), "line breaks survive normalization");
  assert.equal(classifyPageText("   \n\n ").reason, "empty");
  assert.equal(classifyPageText("12").reason, "sparse", "a bare page number is layout noise");
  assert.equal(
    classifyPageText("(cid:12)(cid:145)(cid:88)(cid:2)(cid:17)(cid:99)").reason,
    "garbled",
    "a broken font map is detected as garbage",
  );
  assert.equal(
    normalizePageText("Heading  \r\n\r\n\r\n\r\nBody\u00a0text"),
    "Heading\n\nBody text",
    "whitespace normalization is conservative",
  );
  console.log("✓ 1. Page classification keeps short real pages, flags only unusable ones");
}

// ---------------------------------------------------------------------------
// 2. Ordinary text PDF: local extraction, zero model calls
// ---------------------------------------------------------------------------
{
  const pdf = buildPdf([textPage("Circular motion"), textPage("Momentum", 2), textPage("Energy", 3)]);
  const providers = createProviders();
  const { rows, state, outcome, deps } = await runPass({ pdf, providers });

  assert.equal(outcome.state, "done");
  assert.equal(state.asset.extractState, "done");
  assert.equal(state.asset.pagesTotal, 3);
  assert.equal(rows.length, 3, "one chunk per page");
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3], "original page numbers are preserved");
  assert.deepEqual(rows.map((row) => row.label), ["p. 1", "p. 2", "p. 3"]);
  assert.ok(rows[0].text.includes("a = v^2 / r"), "formulas survive normalization");
  assert.ok(rows[0].text.includes("\nF = m v^2 / r"), "meaningful line breaks are kept");
  assert.ok(rows.every((row) => row.status === "done"));
  assert.equal(providers.calls.nativeRead, 0, "no document-reading call");
  assert.equal(providers.calls.ocrBatch, 0, "no OCR batch call");
  assert.equal(providers.calls.ocrSingle, 0, "no single-page OCR call");
  assert.equal(providers.calls.renders, 0, "no page rendering either");

  const local = await readLocalPdfPages(state.asset, pdf, deps);
  assert.equal(local.usablePages, 3);
  assert.equal(local.fallbackPages.length, 0);
  assert.equal(local.pagesTotal, 3);
  assert.ok(local.segments.every((segment) => segment.usable));
  console.log("✓ 2. Text PDF: 3 pages stored locally, zero model calls and zero renders");
}

// ---------------------------------------------------------------------------
// 3. Text PDF with a blank page: the blank page costs nothing
// ---------------------------------------------------------------------------
{
  const pdf = buildPdf([textPage("Circular motion"), {}, textPage("Energy", 3)]);
  const providers = createProviders();
  const { rows, state, outcome } = await runPass({ pdf, providers });

  assert.equal(outcome.state, "done");
  assert.equal(state.asset.extractState, "done", "a blank page never leaves the asset stuck");
  assert.equal(rows.length, 3, "the blank page keeps its slot so page numbers stay true");
  const blank = rows.find((row) => row.index === 2);
  assert.equal(blank.text, "");
  assert.equal(blank.status, "pending", "blank pages stay out of the source rows");
  assert.equal(providers.calls.ocrBatch, 0);
  assert.equal(providers.calls.ocrSingle, 0);
  assert.equal(providers.calls.nativeRead, 0);
  assert.equal(providers.calls.renders, 1, "the blank page is rendered locally to prove it is blank");
  assert.equal(state.asset.truncated, false, "a blank page is not reported as missing content");
  console.log("✓ 3. Blank page: proved blank locally, no model call, extraction still settles");
}
// ---------------------------------------------------------------------------
// 4. Fully scanned PDF: one whole-file model read, pages aligned
// ---------------------------------------------------------------------------
{
  const pdf = buildPdf([
    { image: await scannedPageJpeg("Circular motion") },
    { image: await scannedPageJpeg("Momentum") },
  ]);
  const providers = createProviders({
    native: {
      ok: true,
      model: "fake-reader",
      pageCount: 2,
      aligned: true,
      pages: [
        { page: 1, label: "p. 1", text: "Scanned page one about circular motion." },
        { page: 2, label: "p. 2", text: "Scanned page two about momentum." },
      ],
      digest: { topics: [{ title: "Circular motion" }] },
      ms: 12,
    },
  });
  const { rows, state, outcome } = await runPass({ pdf, providers });

  assert.equal(providers.calls.nativeRead, 1, "one document read for a pure scan");
  assert.equal(providers.calls.ocrBatch, 0);
  assert.equal(state.asset.extractState, "done");
  assert.equal(outcome.state, "done");
  const textRows = rows.filter((row) => row.index > 0);
  assert.deepEqual(textRows.map((row) => row.index), [1, 2]);
  assert.ok(textRows[0].text.includes("circular motion"));
  assert.ok(textRows[1].text.includes("momentum"));
  console.log("✓ 4. Scanned PDF: no local text, single model read, pages in order");
}

// ---------------------------------------------------------------------------
// 5. Mixed PDF: text pages local, the scanned page read page-wise
// ---------------------------------------------------------------------------
{
  const pdf = buildPdf([
    textPage("Circular motion"),
    { image: await scannedPageJpeg("Handwritten derivation") },
    textPage("Energy", 3),
  ]);
  const providers = createProviders({
    ocr: ({ pages }) => pages.map((page) => ({ text: `Recovered scan text for page ${page.index}` })),
  });
  const { rows, state, outcome } = await runPass({ pdf, providers });

  assert.equal(providers.calls.nativeRead, 0, "a mixed PDF never needs the whole-document read");
  assert.equal(providers.calls.ocrBatch, 1, "only the scanned page is sent, in one batch");
  assert.equal(providers.calls.ocrSingle, 0);
  assert.equal(state.asset.extractState, "done");
  assert.equal(outcome.state, "done");
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3], "combined in page order, no gaps");
  assert.ok(rows[0].text.includes("a = v^2 / r"), "local page 1 text kept");
  assert.ok(rows[1].text.includes("Recovered scan text for page 2"), "page 2 recovered by the fallback");
  assert.ok(rows[2].text.includes("a = v^2 / r"), "local page 3 text kept");
  assert.ok(rows.every((row) => row.status === "done"));
  console.log("✓ 5. Mixed PDF: page-level fallback, correct order, no duplicate content");
}

// ---------------------------------------------------------------------------
// 6. Model quota failure: local text survives, nothing stays stuck
// ---------------------------------------------------------------------------
{
  const pdf = buildPdf([
    textPage("Circular motion"),
    { image: await scannedPageJpeg("Handwritten derivation") },
  ]);
  const providers = createProviders({
    native: { ok: false, code: "QUOTA" },
    ocr: () => {
      throw new Error("429 quota exceeded");
    },
  });
  const { rows, state, outcome } = await runPass({ pdf, providers });

  assert.equal(state.asset.extractState, "done", "the asset reaches a terminal state, not stuck running");
  assert.equal(outcome.state, "done");
  assert.ok(rows[0].text.includes("a = v^2 / r"), "valid local text is preserved on quota failure");
  assert.equal(rows[0].status, "done");
  assert.equal(rows[1].status, "failed", "the unrecoverable page is marked failed, not dropped");
  assert.equal(rows[1].errorCode, "OCR_FAILED");
  assert.equal(providers.calls.nativeRead, 0, "local text was usable, so no document read was attempted");
  console.log("✓ 6. Quota failure: local chunks preserved, extraction settles instead of hanging");
}
// ---------------------------------------------------------------------------
// 7. Interrupted pass + retry: resumable and idempotent
// ---------------------------------------------------------------------------
{
  const pages = Array.from({ length: 12 }, (_, index) => textPage(`Topic ${index + 1}`, index + 1));
  pages[5] = { image: await scannedPageJpeg("Scanned mid-document") };
  const pdf = buildPdf(pages);

  const fake = createFakeDb({ format: "pdf" });
  const providers = createProviders({
    ocr: ({ pages: batch }) => batch.map((page) => ({ text: `Recovered page ${page.index}` })),
  });
  const deps = { ...providers.deps, db: fake.db, readAssetBytes: async () => pdf };

  // First pass: the budget is already spent, so it stops mid-file. A negative
  // budget guarantees the deadline is in the past on the first page.
  const first = await runExtractionPass(fake.state.asset.id, -1, deps);
  assert.equal(first.state, "partial", "an out-of-budget pass stays resumable");
  const afterFirst = fake.rows().length;
  assert.ok(afterFirst >= 1 && afterFirst < 12, "partial work is checkpointed");

  // Second pass: finishes the file without duplicating or losing pages.
  const second = await runExtractionPass(fake.state.asset.id, longDoc.extractBudgetMs, deps);
  assert.equal(second.state, "done");
  const rows = fake.rows().filter((row) => row.index > 0);
  assert.equal(rows.length, 12, "one chunk per page after the resume");
  assert.deepEqual(rows.map((row) => row.index), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(rows[5].text.includes("Recovered page 6"), "the scanned page was recovered");
  assert.ok(rows[0].text.includes("a = v^2 / r"), "local text from the first pass survived");

  // Third pass on a finished asset: nothing stored twice, no new model calls.
  const callsBefore = { ...providers.calls };
  const third = await runExtractionPass(fake.state.asset.id, longDoc.extractBudgetMs, deps);
  assert.equal(third.state, "done");
  assert.equal(fake.rows().filter((row) => row.index > 0).length, 12, "retry is idempotent");
  assert.equal(providers.calls.ocrBatch, callsBefore.ocrBatch, "no OCR call on a finished asset");
  assert.equal(providers.calls.nativeRead, callsBefore.nativeRead);
  console.log("✓ 7. Interrupted extraction: resumes, no duplicates, idempotent retry");
}

// ---------------------------------------------------------------------------
// 8. Large PDF: every page local, zero model calls
// ---------------------------------------------------------------------------
{
  const pages = Array.from({ length: 60 }, (_, index) => textPage(`Topic ${index + 1}`, index + 1));
  const pdf = buildPdf(pages);
  const providers = createProviders();
  const { rows, state, outcome } = await runPass({ pdf, providers });

  assert.equal(outcome.state, "done");
  assert.equal(state.asset.pagesTotal, 60);
  assert.equal(rows.filter((row) => row.index > 0).length, 60);
  assert.equal(providers.calls.nativeRead, 0);
  assert.equal(providers.calls.ocrBatch, 0);
  assert.equal(providers.calls.ocrSingle, 0);
  assert.equal(state.asset.ocrPages, 0);
  console.log("✓ 8. Large text PDF (60 pages): all local, zero model calls");
}

// ---------------------------------------------------------------------------
// 9. Corrupt PDF: failed state, upload behaviour unchanged
// ---------------------------------------------------------------------------
{
  const corrupt = Buffer.from("%PDF-1.4\nthis is not a pdf at all\n", "latin1");
  const providers = createProviders();
  const { state, outcome } = await runPass({ pdf: corrupt, providers });

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.errorCode, "UNREADABLE_FILE");
  assert.equal(state.asset.extractState, "failed");
  assert.equal(state.asset.extractErrorCode, "UNREADABLE_FILE");
  assert.equal(providers.calls.nativeRead, 0, "a corrupt file never burns a model call");
  assert.equal(providers.calls.ocrBatch, 0);

  // pdf-parse throws on unparseable bytes; the extraction wrapper turns that
  // into "no local pages" so the pass can fail the asset instead of the upload.
  const local = await readLocalPdfPages({ id: "corrupt-asset" }, corrupt, providers.deps);
  assert.equal(local.ok, false);
  await assert.rejects(() => extractPdfPages(corrupt), "pdf-parse still reports the bad file");
  console.log("✓ 9. Corrupt PDF: honest failed state, no model call, no crash");
}

// ---------------------------------------------------------------------------
// 10. Blank-page probe on real rendered bytes
// ---------------------------------------------------------------------------
{
  const fixture = buildPdf([{}, textPage("Circular motion")]);
  const blankRender = await renderPdfPage(fixture, 1, 2);
  const textRender = await renderPdfPage(fixture, 2, 2);
  assert.ok(blankRender?.length, "a page renders even when it is empty");
  assert.equal(await isRenderedPageBlank(blankRender), true);
  assert.equal(await isRenderedPageBlank(textRender), false);
  const scan = await scannedPageJpeg("scan");
  assert.equal(await isRenderedPageBlank(scan.bytes), false, "a scan is never blank");
  assert.equal(await isRenderedPageBlank(null), false, "unknown input never cancels a fallback");
  console.log("✓ 10. Rendered-page blank probe: blank page true, text/scan pages false");
}


// ---------------------------------------------------------------------------
// 11. Non-PDF documents keep their old behaviour (no regression)
// ---------------------------------------------------------------------------
{
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Chapter 1: Hardware Abstraction Layer</w:t></w:r></w:p>
<w:p><w:r><w:t>The kernel schedules threads and maps virtual memory to physical frames.</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  const providers = createProviders();
  const { rows, state, outcome } = await runPass({ pdf: docx, providers, format: "docx" });

  assert.equal(outcome.state, "done");
  assert.equal(state.asset.extractState, "done");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].text.includes("Hardware Abstraction Layer"));
  assert.equal(rows[0].status, "pending", "non-PDF rows keep the legacy pending status");
  assert.equal(providers.calls.nativeRead, 0);
  assert.equal(providers.calls.ocrBatch, 0);
  console.log("✓ 11. DOCX still extracted locally with its original chunk status");
}

// ---------------------------------------------------------------------------
// 12. A resumed scan finishes page-wise instead of re-reading the whole file
// ---------------------------------------------------------------------------
{
  const scan = await scannedPageJpeg("Scanned lecture 1");
  const pdf = buildPdf(Array.from({ length: 6 }, () => ({ image: scan })));

  // A resumed pass: page 1 already has its (empty) row from an earlier pass.
  const fake = createFakeDb({ format: "pdf", nextPage: 2, pagesDone: 1 });
  await fake.db.sourceChunk.create({
    data: {
      assetId: "asset-1",
      userId: "user-1",
      index: 1,
      label: "p. 1",
      startPage: 1,
      endPage: 1,
      text: "",
      hash: "sha1-empty",
      status: "pending",
    },
  });
  const providers = createProviders({
    native: {
      ok: true,
      model: "fake-reader",
      pageCount: 6,
      aligned: true,
      pages: [{ page: 1, label: "p. 1", text: "whole-file read" }],
      digest: null,
      ms: 5,
    },
    ocr: ({ pages }) => pages.map((page) => ({ text: `Recovered scan page ${page.index}` })),
  });
  const deps = { ...providers.deps, db: fake.db, readAssetBytes: async () => pdf };

  const outcome = await runExtractionPass(fake.state.asset.id, longDoc.extractBudgetMs, deps);
  assert.equal(outcome.state, "done");
  assert.equal(providers.calls.nativeRead, 0, "a resumed scan is not re-read as a whole file");
  assert.ok(providers.calls.ocrBatch >= 1, "the page-wise fallback did the recovery");
  const rows = fake.rows().filter((row) => row.index > 0);
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(rows.every((row) => row.status === "done" && row.text.length));
  assert.equal(fake.state.asset.truncated, false);
  console.log("✓ 12. Resumed scan: page-wise recovery, whole-file read not repeated");
}

console.log("\nAll PDF extraction checks passed.");
