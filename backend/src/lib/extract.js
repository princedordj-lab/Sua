import JSZip from "jszip";

// Server-side text extraction for uploaded documents. Audio transcription and
// image OCR belong to the AI pipeline (Milestone 3) — everything here is pure
// JS, runs inline when an upload completes, and never calls a model.
//
// Failures return null instead of throwing: an upload must succeed even when
// a file turns out to be unparseable, the note simply has no source text.
const MAX_TEXT_CHARS = 100_000;

export async function extractDocumentText(buffer, format, kind) {
  if (kind !== "document") return null;
  try {
    let text = null;
    if (format === "pdf") text = await extractPdf(buffer);
    else if (format === "txt") text = buffer.toString("utf8");
    else if (format === "docx") text = await extractDocx(buffer);
    else if (format === "pptx") text = await extractPptx(buffer);
    if (!text) return null;
    const normalized = text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!normalized) return null;
    return normalized.slice(0, MAX_TEXT_CHARS);
  } catch (error) {
    console.warn(
      `Text extraction failed (${kind}/${format}):`,
      error?.message ?? error,
    );
    return null;
  }
}

async function extractPdf(buffer) {
  // pdfjs-dist (pulled in by pdf-parse) evaluates `new DOMMatrix()` at module
  // scope and expects the canvas globals to exist in Node. It does try to
  // require "@napi-rs/canvas" itself, but not in a form Vercel's file tracer
  // can follow, so the package was absent from the deployed function and the
  // app died on import. Importing it here with a literal specifier gets the
  // package (including its prebuilt .node binary) into the traced bundle, and
  // installing the globals before pdf-parse is loaded means pdfjs no longer
  // needs its own polyfill attempt.
  //
  // Both imports stay lazy on purpose: the API should not pay for pdfjs on
  // cold starts that never touch a PDF, and if the native binary is missing
  // for the current platform only PDF extraction degrades to null instead of
  // crashing every route at import time.
  await installCanvasGlobals();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text ?? null;
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

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) =>
        Number.parseInt(a.match(/slide(\d+)\.xml/)[1], 10) -
        Number.parseInt(b.match(/slide(\d+)\.xml/)[1], 10),
    );
  const parts = [];
  for (const name of slides) {
    const xml = await zip.files[name].async("string");
    const withBreaks = xml
      .replace(/<\/a:p>/g, "\n")
      .replace(/<a:br\s*\/>/g, "\n");
    const text = decodeEntities(stripTags(withBreaks)).trim();
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n\n") : null;
}
