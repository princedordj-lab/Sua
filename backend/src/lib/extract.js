import JSZip from "jszip";
import { normalizePageText } from "./page-text.js";

// Page quality rules live in a dependency-free module so the note pipeline can
// share them without pulling the native canvas/PDF stack into its bundle.
export { classifyPageText, normalizePageText } from "./page-text.js";

// Server-side text extraction for uploaded documents. Audio transcription and
// image OCR belong to the AI pipeline — everything here is pure JS, and the
// PDF path renders pages to images only for the fallback that reads a page with
// no usable text layer (a scan). Ordinary text PDFs never render, never OCR and
// never reach a model.
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
    let headings = [];
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
      const docx = await extractDocx(buffer);
      if (!docx) return null;
      segments = [{ index: 1, label: null, text: docx.text }];
      headings = docx.blocks
        .filter((block) => block.level)
        .map((block) => ({ title: block.text, level: block.level }));
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
      // Structure hints (may be empty): DOCX heading blocks, PPTX slide
      // titles stay on their segment. Additive; legacy callers ignore it.
      headings,
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
  return normalizePageText(value);
}

// pdf-parse transfers typed arrays to its worker, so each parse gets its own
// copy of the bytes.
function copyOf(buffer) {
  return new Uint8Array(buffer);
}

// One parse over the whole file returning every page's slot (kept even when
// blank so page numbers stay true to the file). Exported for the resumable
// extraction driver in lib/extraction.js.
export async function extractPdfPages(buffer) {
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

/**
 * Best-effort PDF outline/bookmarks for the structure stage. pdf-parse exposes
 * table-of-contents data optionally; any shape mismatch, missing method or
 * parse hiccup degrades to null and the outline falls back to headings/windows.
 * Never throws — an outline is a nice-to-have, not a requirement.
 */
export async function pdfOutline(buffer) {
  try {
    await installCanvasGlobals();
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: copyOf(buffer) });
    try {
      const result = await parser.getToc?.();
      const items = Array.isArray(result?.toc)
        ? result.toc
        : Array.isArray(result)
          ? result
          : null;
      if (!items?.length) return null;
      const outline = items
        .map((item) => ({
          title: String(item?.title ?? item?.text ?? "").trim(),
          page: Number.isFinite(item?.page)
            ? Math.round(item.page)
            : Number.isFinite(item?.pageNumber)
              ? Math.round(item.pageNumber)
              : null,
        }))
        .filter((item) => item.title && item.page && item.page > 0);
      return outline.length ? outline : null;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch {
    return null;
  }
}

let canvasModule;
let canvasGlobals;

// Literal specifier so Vercel's Node File Trace (NFT) traces the prebuilt
// `.node` binary into the deployment bundle. Lazy on purpose: a missing binary
// must degrade PDF work to null, never crash the API at import time.
async function loadCanvas() {
  if (!canvasModule) {
    canvasModule = import("@napi-rs/canvas").catch((error) => {
      console.warn(
        `Canvas unavailable (@napi-rs/canvas): ${error?.message ?? error}`,
      );
      return null;
    });
  }
  return canvasModule;
}

async function installCanvasGlobals() {
  if (!canvasGlobals) {
    canvasGlobals = Promise.all([
      loadCanvas(),
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

// Below this share of non-white pixels a rendered page is treated as blank. A
// scanned page — the case the fallback exists for — is an order of magnitude
// above it, while a lone page number or a hairline rule stays far below.
const BLANK_PAGE_INK_RATIO = Number(process.env.PDF_BLANK_INK_RATIO ?? 0.001);
// A pixel darker than this is ink rather than paper (or a white margin).
const INK_LUMA = 235;
// Blankness is a coarse property: sampling ~100k pixels is plenty for A4 at
// OCR scale and keeps a 300-page probe cheap.
const BLANK_PROBE_SAMPLES = 100_000;

/**
 * True when a rendered page carries no visible content.
 *
 * This is what keeps the blank pages of an ordinary PDF from spending a model
 * OCR call — a page with nothing on it has nothing to read — while a page that
 * is only a photograph of paper (a scan) is not blank and still gets read.
 *
 * Returns false when the pixels cannot be inspected: "unknown" must never
 * cancel a legitimate fallback.
 */
export async function isRenderedPageBlank(imageBytes) {
  const bytes =
    Buffer.isBuffer(imageBytes) || imageBytes instanceof Uint8Array ? imageBytes : null;
  // Unknown input is not evidence of a blank page: never cancel a fallback.
  if (!bytes) return false;
  if (!bytes.length) return true;
  try {
    const canvas = await loadCanvas();
    if (!canvas) return false;
    const image = await canvas.loadImage(bytes);
    const width = image.width ?? 0;
    const height = image.height ?? 0;
    if (!width || !height) return false;
    const probe = canvas.createCanvas(width, height);
    const context = probe.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    const step = Math.max(
      1,
      Math.floor(Math.sqrt((width * height) / BLANK_PROBE_SAMPLES)),
    );
    let sampled = 0;
    let ink = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const offset = (y * width + x) * 4;
        sampled += 1;
        if (data[offset + 3] === 0) continue;
        const luma =
          0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
        if (luma < INK_LUMA) ink += 1;
      }
    }
    if (!sampled) return false;
    return ink / sampled < BLANK_PAGE_INK_RATIO;
  } catch (error) {
    console.warn(`Blank-page probe failed: ${error?.message ?? error}`);
    return false;
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
  return { text: decodeEntities(stripTags(withBreaks)), blocks: docxBlocks(xml) };
}

/**
 * DOCX paragraphs with heading levels for the structure stage. Heading level
 * comes from `w:outlineLvl` (Word, LibreOffice and Google Docs all write it)
 * with a fallback to English-style Heading style names. Returns
 * `[{ text, level }]` where level is 1-6 or null for body text. Empty
 * paragraphs are dropped — chunking re-adds blank lines between blocks.
 */
export function docxBlocks(xml) {
  const blocks = [];
  for (const raw of xml.split(/<\/w:p>/)) {
    const outlineMatch = raw.match(/<w:outlineLvl\b[^>]*w:val="([0-5])"/);
    const headingMatch = raw.match(/w:val="Heading(\d)"/);
    const rawLevel = outlineMatch ? Number(outlineMatch[1]) + 1 : headingMatch ? Number(headingMatch[1]) : null;
    const text = decodeEntities(stripTags(raw))
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .trim();
    if (!text) continue;
    blocks.push({
      text,
      level: rawLevel && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : null,
    });
  }
  return blocks;
}

// One segment per slide, number kept from the file name so labels match the
// deck the student is looking at even when slides are reordered in the XML.
// The slide's title (if any) is carried separately in `title` — it feeds the
// structure stage's outline — and speaker notes are appended when their text
// adds anything beyond the slide body.
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
    const title = slideTitle(xml);
    const withBreaks = xml
      .replace(/<\/a:p>/g, "\n")
      .replace(/<a:br\s*\/>/g, "\n");
    let text = decodeEntities(stripTags(withBreaks)).trim();
    if (title) {
      // The title is usually the first paragraph of the body text; keep it in
      // `title` only, so the structure stage never double-reports it.
      text = text
        .split("\n")
        .filter((line) => line.trim() !== title)
        .join("\n")
        .trim();
    }
    const notes = await slideNotes(zip, number, text);
    if (notes) text = text ? `${text}\n\n[Speaker notes] ${notes}` : `[Speaker notes] ${notes}`;
    if (text || title) {
      segments.push({
        index: number,
        label: `Slide ${number}`,
        text: text || title || "",
        title: title || null,
      });
    }
  }
  return segments;
}

/** Title placeholder text of a slide, without the surrounding XML noise. */
function slideTitle(slideXml) {
  // Title placeholders carry `type="title"` (or "ctrTitle" on title slides) on
  // their placeholder shape; layouts set the text inside <a:t> runs.
  const shapeBlocks = slideXml.split(/<p:sp>/).slice(1);
  for (const block of shapeBlocks) {
    const shape = block.split("</p:sp>")[0];
    if (!/<p:ph\b[^>]*type="(?:ctr)?title"/.test(shape)) continue;
    const runs = [...shape.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((run) => decodeEntities(run[1]).trim())
      .filter(Boolean);
    if (runs.length) return runs.join("").trim();
  }
  return null;
}

/** Speaker notes for slide N minus lines the slide body already repeats. */
async function slideNotes(zip, slideNumber, slideText) {
  const entry = zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
  if (!entry) return null;
  try {
    const xml = await entry.async("string");
    const withBreaks = xml
      .replace(/<\/a:p>/g, "\n")
      .replace(/<a:br\s*\/>/g, "\n");
    const lines = decodeEntities(stripTags(withBreaks))
      .split("\n")
      .map((line) => line.trim())
      // The notes slide starts with a slide-number placeholder run; drop it.
      .filter((line) => line && line !== String(slideNumber) && !/^ slidenum $/.test(line));
    const body = slideText || "";
    const fresh = lines.filter((line) => !body.includes(line));
    return fresh.join(" ").trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embedded pictures (DOCX/PPTX)
// ---------------------------------------------------------------------------

// Gemini reads these image types; anything else inside an Office file (EMF,
// WMF, SVG, TIFF) stays untouched rather than being sent and rejected.
const READABLE_IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

/** Zip paths are POSIX-relative; resolve `../media/x.png` against its folder. */
function resolveZipPath(baseDir, target) {
  const parts = target.startsWith("/")
    ? target.slice(1).split("/")
    : `${baseDir}/${target}`.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** `<Relationship Id Target>` pairs from a `.rels` part. */
function relationshipTargets(xml) {
  const targets = new Map();
  for (const match of String(xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targets.set(id, target);
  }
  return targets;
}

function mediaName(path) {
  return path.split("/").pop() ?? path;
}

function imageMimeOf(path) {
  const extension = String(path).split(".").pop()?.toLowerCase() ?? "";
  return READABLE_IMAGE_MIME[extension] ?? null;
}

/**
 * Pictures embedded in a DOCX/PPTX, in document order, for native reading.
 *
 * Gemini cannot open OOXML, so the text comes from the local extractor above;
 * this is what makes a deck of screenshots or a Word file of pasted scans
 * readable at all. Each entry is `{ id, name, page, bytes, mimeType }` where
 * `page` is the slide number (PPTX) or null (DOCX), `id` is stable per media
 * file so a repeated picture is only read once, and unreadable types, tiny
 * icons and anything past `limit` are dropped.
 *
 * Returns [] rather than throwing: a file with no usable pictures is normal.
 */
export async function extractEmbeddedImages(input, format, { minBytes = 0, limit = 24 } = {}) {
  try {
    const normalizedFormat = String(format ?? "").toLowerCase().replace(/^\./, "");
    if (normalizedFormat !== "docx" && normalizedFormat !== "pptx") return [];
    const buffer = await toBuffer(input);
    if (!buffer?.length) return [];
    const zip = await JSZip.loadAsync(buffer);

    /** @type {{ id: string, name: string, page: number|null, path: string }[]} */
    const occurrences = [];

    if (normalizedFormat === "pptx") {
      const slides = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort(
          (a, b) =>
            Number.parseInt(a.match(/slide(\d+)\.xml/)[1], 10) -
            Number.parseInt(b.match(/slide(\d+)\.xml/)[1], 10),
        );
      for (const slidePath of slides) {
        const page = Number.parseInt(slidePath.match(/slide(\d+)\.xml/)[1], 10);
        const relsPath = `ppt/slides/_rels/${mediaName(slidePath)}.rels`;
        const relsEntry = zip.file(relsPath);
        if (!relsEntry) continue;
        const targets = relationshipTargets(await relsEntry.async("string"));
        for (const target of targets.values()) {
          const path = resolveZipPath("ppt/slides", target);
          if (!path.startsWith("ppt/media/")) continue;
          // One entry per slide a picture appears on: the same scan used twice
          // is read once but belongs to both slides.
          occurrences.push({ id: mediaName(path), name: mediaName(path), page, path });
        }
      }
    } else {
      const documentEntry = zip.file("word/document.xml");
      const relsEntry = zip.file("word/_rels/document.xml.rels");
      if (documentEntry && relsEntry) {
        const targets = relationshipTargets(await relsEntry.async("string"));
        const xml = await documentEntry.async("string");
        for (const match of xml.matchAll(/r:(?:embed|link)="([^"]+)"/g)) {
          const target = targets.get(match[1]);
          if (!target) continue;
          const path = resolveZipPath("word", target);
          if (!path.startsWith("word/media/")) continue;
          occurrences.push({ id: mediaName(path), name: mediaName(path), page: null, path });
        }
      }
    }

    // `limit` counts distinct pictures (that is what costs a model read); the
    // occurrence list keeps every place a picture is used.
    const selected = new Set();
    for (const occurrence of occurrences) {
      if (selected.size >= limit) break;
      if (!imageMimeOf(occurrence.path)) continue;
      selected.add(occurrence.path);
    }
    if (!selected.size) return [];

    const bytesByPath = new Map();
    for (const path of selected) {
      const entry = zip.file(path);
      if (!entry) continue;
      const bytes = await entry.async("uint8array");
      if (!bytes?.length || bytes.length < minBytes) continue;
      bytesByPath.set(path, Buffer.from(bytes));
    }

    const images = [];
    for (const occurrence of occurrences) {
      const bytes = bytesByPath.get(occurrence.path);
      if (!bytes) continue;
      images.push({
        id: occurrence.id,
        name: occurrence.name,
        page: occurrence.page,
        mimeType: imageMimeOf(occurrence.path),
        bytes,
      });
    }
    return images;
  } catch (error) {
    console.warn(
      `Embedded image extraction failed (${format}):`,
      error?.message ?? error,
    );
    return [];
  }
}
