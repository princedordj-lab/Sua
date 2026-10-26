import JSZip from "jszip";

// Server-side text extraction for uploaded documents. Audio transcription and
// image OCR belong to the AI pipeline — everything here is pure JS, and the
// PDF path renders pages to images only when the pipeline explicitly asks for
// an OCR fallback.
//
// Failures return null instead of throwing: an upload must succeed even when
// a file turns out to be unparseable, the note simply has no source text.
export const MAX_TEXT_CHARS = 100_000;

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
 */
export async function extractDocument(input, format, kind = "document") {
  if (kind !== "document") return null;
  try {
    const buffer = await toBuffer(input);
    if (!buffer || buffer.length === 0) return null;

    const normalizedFormat = String(format ?? "").toLowerCase().replace(/^\./, "");
    let segments = [];
    let pageCount = 0;

    if (normalizedFormat === "pdf") {
      const result = await extractPdfPages(buffer);
      if (!result) return null;
      segments = result.segments;
      pageCount = result.pageCount;
    } else if (normalizedFormat === "txt" || normalizedFormat === "md") {
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
      // A blank PDF page is kept as a placeholder so the pipeline can decide to
      // OCR it; other formats have no page concept and drop blank blocks.
      if (!text && normalizedFormat !== "pdf") continue;
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

async function extractPdfPages(buffer) {
  // pdfjs-dist (pulled in by pdf-parse) evaluates `new DOMMatrix()` at module
  // scope and expects the canvas globals to exist in Node. Importing canvas
  // here with a literal specifier also gets the prebuilt .node binary into the
  // traced Vercel bundle (see AGENTS.md).
  await installCanvasGlobals();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: copyOf(buffer) });
  try {
    const result = await parser.getText({ pageJoiner: "" });
    // Every page keeps its slot, even when it has no text layer: the pipeline
    // OCRs those pages, and page numbers must stay true to the file.
    const segments = result.pages.map((page) => ({
      index: page.num,
      label: `p. ${page.num}`,
      text: page.text ?? "",
    }));
    return { segments, pageCount: result.total || result.pages.length };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

let canvasGlobals;

async function installCanvasGlobals() {
  if (!canvasGlobals) {
    canvasGlobals = import("@napi-rs/canvas").catch((error) => {
      console.warn(
        `Canvas globals unavailable (@napi-rs/canvas): ${error?.message ?? error}`,
      );
      return null;
    });
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
