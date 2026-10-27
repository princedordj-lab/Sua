import JSZip from "jszip";

// Server-side text extraction for uploaded documents. Audio transcription and
// image OCR belong to the AI pipeline — everything here is pure JS, and the
// PDF path renders pages to images only for pages that have no text layer.
//
// Failures return null instead of throwing: an upload must succeed even when
// a file turns out to be unparseable, the note simply has no source text.
//
// Large PDFs are processed page by page (see extractDocumentIncremental): the
// caller can cap pages/characters, stop on a time budget, and resume from a
// page index. Pages are never rasterised when they already carry a text layer.
export const MAX_TEXT_CHARS = 100_000;

// Sanity ceilings for untrusted files. A PDF claiming more pages than this is
// treated as damaged rather than iterated, and a long run of unparseable pages
// aborts the pass (the pages already read are kept).
const MAX_PDF_PAGES = 20_000;
const MAX_CONSECUTIVE_PAGE_FAILURES = 20;

/**
 * Normalizes input (Buffer, Uint8Array, or stream) into a Buffer.
 */
export async function toBuffer(input) {
  if (!input) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input.arrayBuffer === "function") {
    return Buffer.from(await input.arrayBuffer());
  }
  if (typeof input[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(input));
}

/**
 * Extract text with its source structure intact.
 *
 * Returns `{ segments, text, pageCount, truncated }` where each segment is
 * `{ index, label, text }` and `label` is "p. 12", "Slide 4" or null when the
 * format has no pages (DOCX/TXT). Returns null on any failure.
 *
 * Kept for callers that want one flat result (eval harness, text formats).
 * PDFs use the incremental path internally, storing an empty segment for a
 * page with no text layer so the pipeline can still choose to OCR it.
 */
export async function extractDocument(input, format, kind = "document") {
  if (kind !== "document") return null;
  try {
    const buffer = await toBuffer(input);
    if (!buffer || buffer.length === 0) return null;

    const normalizedFormat = String(format ?? "").toLowerCase().replace(/^\./, "");
    if (normalizedFormat === "pdf") {
      const result = await extractDocumentIncremental(buffer, normalizedFormat, kind, {
        maxChars: MAX_TEXT_CHARS,
        maxPages: Number.POSITIVE_INFINITY,
        budgetMs: Number.POSITIVE_INFINITY,
        keepBlankPages: true,
      });
      if (!result || !result.segments.length) return null;
      return {
        segments: result.segments,
        text: result.text.slice(0, MAX_TEXT_CHARS).trim(),
        pageCount: result.totalPages || result.segments.length,
        truncated: result.truncated,
      };
    }

    let segments = [];
    let pageCount = 0;
    if (normalizedFormat === "txt" || normalizedFormat === "md") {
      segments = [{ index: 1, label: null, text: buffer.toString("utf8") }];
      pageCount = 1;
    } else if (normalizedFormat === "docx") {
      const docxText = await extractDocx(buffer);
      if (!docxText) return null;
      segments = [{ index: 1, label: null, text: docxText }];
      pageCount = 1;
    } else if (normalizedFormat === "pptx") {
      segments = await extractPptxSlides(buffer);
      if (!segments || !segments.length) return null;
      pageCount = segments.length;
    } else if (normalizedFormat === "ppt") {
      // Legacy binary .ppt format requires system binaries not available in serverless JS.
      // Handled gracefully: return null without throwing, preserving the upload.
      console.warn("Legacy .ppt binary presentation format is unsupported for text extraction; skipping inline text.");
      return null;
    } else {
      return null;
    }

    const normalized = [];
    let size = 0;
    let truncated = false;
    for (const segment of segments) {
      const text = normalizeText(segment.text);
      // Other formats have no page concept and drop blank blocks.
      if (!text) continue;
      const room = MAX_TEXT_CHARS - size;
      if (room <= 0) {
        truncated = true;
        break;
      }
      if (text.length > room) {
        normalized.push({ ...segment, text: text.slice(0, room).trim() });
        truncated = true;
        size = MAX_TEXT_CHARS;
        break;
      }
      normalized.push({ ...segment, text });
      size += text.length;
    }

    if (!normalized.length) return null;
    return {
      segments: normalized,
      text: normalized.map((segment) => segment.text).join("\n\n").slice(0, MAX_TEXT_CHARS).trim(),
      pageCount: pageCount || normalized.length,
      truncated,
    };
  } catch (error) {
    console.warn(
      `Text extraction failed (${kind}/${format}):`,
      error?.message ?? error,
    );
    return null;
  }
}

/** Back-compat wrapper: the flat string `/complete` stores on the asset. */
export async function extractDocumentText(input, format, kind = "document") {
  try {
    const result = await extractDocument(input, format, kind);
    // A scanned PDF extracts to "" (placeholders only). The asset keeps a null
    // text so the pipeline knows it still has to OCR the pages.
    const text = result?.text?.trim() ? result.text : null;
    return text ? text.slice(0, MAX_TEXT_CHARS).trim() : null;
  } catch (error) {
    console.warn(
      `Text extraction wrapper failed (${kind}/${format}):`,
      error?.message ?? error,
    );
    return null;
  }
}

/**
 * Incremental extraction used by the background upload worker.
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {string} format
 * @param {"document"|"image"|"audio"} kind
 * @param {object} [options]
 * @param {number} [options.startPage=1]   1-based page to resume from (PDF).
 * @param {number} [options.maxPages]      stop after this many pages.
 * @param {number} [options.maxChars]      stop once this much text is stored.
 * @param {number} [options.budgetMs]      stop when the time budget runs out.
 * @param {boolean} [options.keepBlankPages] keep an empty PDF page segment.
 * @param {(progress: object) => void|Promise<void>} [options.onPage]
 * @param {{ minChars?: number, concurrency?: number, timeoutMs?: number,
 *           ocrPage?: (pageNumber: number) => Promise<string|null> }} [options.ocr]
 *
 * Returns `{ segments, text, pagesUsed, totalPages, nextPage, truncated,
 * partial, ocrPages, timings }`. `nextPage` is null when there is nothing
 * left to read; it points at the first unprocessed page when the budget ran
 * out. Failures return null.
 */
export async function extractDocumentIncremental(input, format, kind = "document", options = {}) {
  if (kind !== "document") return null;
  const startedAt = Date.now();
  const maxChars = positive(options.maxChars, MAX_TEXT_CHARS);
  const maxPages = positive(options.maxPages, Number.POSITIVE_INFINITY);
  const budgetMs = positive(options.budgetMs, Number.POSITIVE_INFINITY);
  const startPage = Math.max(1, Math.round(options.startPage ?? 1));
  const normalizedFormat = String(format ?? "").toLowerCase().replace(/^\./, "");

  const result = {
    segments: [],
    text: "",
    pagesUsed: 0,
    totalPages: 0,
    nextPage: null,
    truncated: false,
    partial: false,
    ocrPages: 0,
    timings: { parseMs: 0, ocrMs: 0 },
  };

  try {
    const buffer = await toBuffer(input);
    if (!buffer || buffer.length === 0) return null;

    if (normalizedFormat !== "pdf") {
      const legacy = await extractDocument(buffer, normalizedFormat, kind);
      if (!legacy) return null;
      Object.assign(result, {
        segments: legacy.segments.map((segment) => ({
          ...segment,
          text: segment.text.slice(0, maxChars),
        })),
        text: legacy.text.slice(0, maxChars),
        pagesUsed: legacy.segments.length,
        totalPages: legacy.pageCount,
        truncated: legacy.truncated || legacy.text.length > maxChars,
      });
      result.text = result.segments.map((segment) => segment.text).join("\n\n").slice(0, maxChars);
      return result;
    }

    const ocr = options.ocr && typeof options.ocr.ocrPage === "function" ? options.ocr : null;
    const ocrMinChars = Math.max(1, Math.round(ocr?.minChars ?? 40));
    const ocrConcurrency = Math.max(1, Math.round(ocr?.concurrency ?? 3));
    const keepBlankPages = Boolean(options.keepBlankPages);
    const overBudget = () => Date.now() - startedAt >= budgetMs;
    let size = 0;
    let capHit = false;
    let budgetHit = false;
    let unreadable = false;

    await withPdfParser(buffer, async (parser) => {
      // The page count is the loop bound. When pdf-parse cannot read the
      // document structure it throws here (and every per-page call afterwards
      // fails too). Without this guard `totalPages` would be 0, `lastPage`
      // would fall back to `maxPages` (Infinity for the legacy caller) and the
      // loop would walk an unbounded number of non-existent pages.
      const info = await parser.getInfo().catch(() => null);
      const totalPages = Math.min(
        MAX_PDF_PAGES,
        Math.max(0, Math.round(info?.total ?? 0)),
      );
      if (!totalPages) {
        unreadable = true;
        return;
      }
      result.totalPages = totalPages;
      const lastPage = Math.min(totalPages, startPage + maxPages - 1);
      let consecutiveFailures = 0;

      for (let batchStart = startPage; batchStart <= lastPage; batchStart += ocrConcurrency) {
        if (overBudget()) {
          budgetHit = true;
          break;
        }
        const batchEnd = Math.min(lastPage, batchStart + ocrConcurrency - 1);
        const batch = [];

        // 1. Parse each page in the batch (never rasterise a page with text).
        for (let page = batchStart; page <= batchEnd; page += 1) {
          if (overBudget()) {
            budgetHit = true;
            break;
          }
          const parseStart = Date.now();
          let raw = "";
          try {
            const pageResult = await parser.getText({ partial: [page], pageJoiner: "" });
            raw = pageResult?.pages?.[0]?.text ?? "";
            consecutiveFailures = 0;
          } catch (error) {
            consecutiveFailures += 1;
            console.warn(`PDF page parse failed (page ${page}):`, error?.message ?? error);
          }
          result.timings.parseMs += Date.now() - parseStart;
          batch.push({ page, text: normalizeText(raw), scored: false });
        }

        // A run of broken pages means the rest of the file is unusable: keep
        // what has already been read and stop instead of failing 600k times.
        if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
          unreadable = true;
          break;
        }

        // 2. OCR only pages below the text threshold, with a concurrency cap
        //    and a per-page timeout. A timeout leaves the page as parsed.
        const needsOcr = ocr
          ? batch.filter((entry) => entry.text.length < ocrMinChars)
          : [];
        if (needsOcr.length) {
          await mapWithLimit(needsOcr, ocrConcurrency, async (entry) => {
            if (overBudget()) return;
            const ocrStart = Date.now();
            const scanned = await withTimeout(
              Promise.resolve().then(() => ocr.ocrPage(entry.page)),
              Math.max(1_000, Math.round(ocr.timeoutMs ?? 45_000)),
            ).catch((error) => {
              console.warn(`PDF page OCR failed (page ${entry.page}):`, error?.message ?? error);
              return null;
            });
            result.timings.ocrMs += Date.now() - ocrStart;
            const text = normalizeText(scanned);
            if (text.length > entry.text.length) {
              entry.text = text;
              entry.scored = true;
            }
          });
          result.ocrPages += needsOcr.filter((entry) => entry.scored).length;
        }

        // 3. Append in page order, stopping at the character cap. Pages that
        //    were parsed but not appended stay unread for the next pass.
        let appended = 0;
        for (const entry of batch) {
          const room = maxChars - size;
          if (room <= 0) {
            capHit = true;
            break;
          }
          const trimmed = entry.text.length > room ? entry.text.slice(0, room).trim() : entry.text;
          if (trimmed) {
            result.segments.push({ index: entry.page, label: `p. ${entry.page}`, text: trimmed });
            size += trimmed.length;
          } else if (keepBlankPages) {
            result.segments.push({ index: entry.page, label: `p. ${entry.page}`, text: "" });
          }
          result.pagesUsed += 1;
          appended += 1;
          if (trimmed.length < entry.text.length) {
            capHit = true;
            break;
          }
        }
        await options.onPage?.({
          page: batch[appended - 1]?.page ?? batchStart,
          pagesUsed: result.pagesUsed,
          totalPages,
          truncated: capHit,
          // Computed lazily: the runner flushes a checkpoint only every few
          // pages, so this join does not run per page.
          get text() {
            return result.segments
              .map((segment) => segment.text)
              .filter(Boolean)
              .join("\n\n");
          },
        });
        if (capHit) break;
        if (appended < batch.length) {
          // Budget expired mid-batch; resume at the first unappended page.
          budgetHit = true;
          break;
        }
      }

      // A document larger than the page cap is deliberately left unfinished:
      // there is no resume, the student is told to upload the rest by chapter.
      const pageCapHit = totalPages > 0 && lastPage < totalPages;
      result.truncated = capHit || pageCapHit || budgetHit || unreadable;
    });

    // Nothing readable at all (corrupt/encrypted/zero-page PDF): report a
    // failure so the asset lands in `failed`, not in a blank `done` state.
    if (unreadable && !result.segments.length) return null;

    result.text = result.segments
      .map((segment) => segment.text)
      .join("\n\n")
      .slice(0, maxChars)
      .trim();
    result.partial = budgetHit;
    result.nextPage = budgetHit ? startPage + result.pagesUsed : null;
    if (result.nextPage !== null && result.totalPages > 0 && result.nextPage > result.totalPages) {
      result.nextPage = null;
      result.partial = false;
    }
    return result;
  } catch (error) {
    console.warn(
      `Incremental extraction failed (${kind}/${format}):`,
      error?.message ?? error,
    );
    return null;
  }
}

/**
 * Rasterise one PDF page for the OCR fallback. Lazy like every PDF import: a
 * missing native canvas binary degrades OCR to null, never crashes the route.
 */
export async function renderPdfPage(buffer, pageNumber, scale = 2) {
  try {
    await installCanvasGlobals();
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: copyOf(buffer) });
    try {
      const result = await parser.getScreenshot({
        partial: [pageNumber],
        scale,
        imageBuffer: true,
        imageDataUrl: false,
      });
      const page = result.pages[0];
      return page?.data ? Buffer.from(page.data) : null;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (error) {
    console.warn(
      `PDF page render failed (page ${pageNumber}):`,
      error?.message ?? error,
    );
    return null;
  }
}

function positive(value, fallback) {
  const number = Number(value);
  if (Number.isNaN(number)) return fallback;
  if (number === Number.POSITIVE_INFINITY) return number;
  return number > 0 ? number : fallback;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapWithLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// pdf-parse transfers typed arrays to its worker, so each parse gets its own
// copy of the bytes.
function copyOf(buffer) {
  return new Uint8Array(buffer);
}

async function withPdfParser(buffer, run) {
  // pdfjs-dist (pulled in by pdf-parse) evaluates `new DOMMatrix()` at module
  // scope and expects the canvas globals to exist in Node. Importing canvas
  // here with a literal specifier also gets the prebuilt .node binary into the
  // traced Vercel bundle (see AGENTS.md). Both imports stay lazy so a missing
  // native binary degrades PDF text instead of crashing every route on import.
  await installCanvasGlobals();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: copyOf(buffer) });
  try {
    return await run(parser);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export async function extractPdfPagesIncremental(buffer, options = {}) {
  return extractDocumentIncremental(buffer, "pdf", "document", options);
}

let canvasGlobals;

async function installCanvasGlobals() {
  if (!canvasGlobals) {
    canvasGlobals = Promise.all([
      import("@napi-rs/canvas").catch((error) => {
        console.warn(
          `Canvas globals unavailable (@napi-rs/canvas): ${error?.message ?? error}`,
        );
        return null;
      }),
      // Literal specifier so Vercel's Node File Trace (NFT) traces pdf.worker.mjs into the deployment bundle
      import("pdfjs-dist/legacy/build/pdf.worker.mjs").catch(() => null),
    ]).then(([canvas]) => canvas);
  }
  const canvas = await canvasGlobals;
  if (!canvas) return;
  for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
    if (!globalThis[name] && canvas[name]) globalThis[name] = canvas[name];
  }
}

function decodeEntities(xml) {
  return xml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&amp;/g, "&");
}

function stripTags(xml) {
  return xml.replace(/<[^>]+>/g, "");
}

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return null;
  const xml = await entry.async("string");
  const withBreaks = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<w:tab\b[^>]*\/>/g, "\t");
  return decodeEntities(stripTags(withBreaks));
}

// One segment per slide, number kept from the file name so labels match the
// deck the student is looking at even when slides are reordered in the XML.
async function extractPptxSlides(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) =>
        Number.parseInt(a.match(/slide(\d+)\.xml/)[1], 10) -
        Number.parseInt(b.match(/slide(\d+)\.xml/)[1], 10),
    );
  const segments = [];
  for (const name of slides) {
    const number = Number.parseInt(name.match(/slide(\d+)\.xml/)[1], 10);
    const xml = await zip.files[name].async("string");
    const withBreaks = xml
      .replace(/<\/a:p>/g, "\n")
      .replace(/<a:br\s*\/>/g, "\n");
    const text = decodeEntities(stripTags(withBreaks)).trim();
    if (text) segments.push({ index: number, label: `Slide ${number}`, text });
  }
  return segments;
}
