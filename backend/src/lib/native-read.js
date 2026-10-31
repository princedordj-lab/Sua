/**
 * Native document reading.
 *
 * The model is the *fallback* reader, not the default one: PDFs are read
 * locally first (lib/extract.js → embedded text layer), and this module is only
 * reached for content no local parser can recover — a scanned PDF, or a single
 * picture. When it is used, the file itself is handed to Gemini, which reads
 * text, scans, tables, formulas, diagrams and charts in one pass:
 *
 * - PDF   → the document is the input; pages come back page-tagged, with a
 *           compact digest to seed the writer. Callers only get here when the
 *           local text layer had no usable page at all.
 * - image → one picture (whiteboard, handout, slide photo) is the input; the
 *           transcription plus a short description of any figure is the page.
 * - DOCX/PPTX → Gemini cannot open OOXML, so the text stays with the local
 *           extractor and the *pictures* inside the file are read here (see
 *           readEmbeddedVisuals); a deck of screenshots still becomes text.
 * - TXT/MD    → the bytes are the text already; no model call is needed.
 *
 * This module is pure I/O: it never touches the database, never throws when the
 * provider is unavailable, and never invents content. Callers persist what comes
 * back and fall back to the deterministic extractor on any `ok: false`.
 *
 * Free-tier behaviour: one request per file, thinking disabled, page and image
 * counts capped. A 429/quota error opens a cooldown window so a batch of
 * uploads does not keep knocking on a closed quota.
 */

import { documentRead } from "../config/ai-pipeline.js";
import {
  geminiDeleteFile,
  geminiReadDocument,
  geminiReadImages,
  geminiUploadFile,
} from "./ai.js";
import { extractPdfPages } from "./extract.js";

const IMAGE_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

const PDF_MIME = "application/pdf";
const QUOTA_RE = /\b429\b|quota|rate.?limit|resource_exhausted/i;

// Module-level (per serverless instance) quota gate. Not shared state: the
// worst case is one extra failed request on another instance.
let quotaBlockedUntil = 0;

export function nativeReadEnabled() {
  return Boolean(documentRead.enabled && process.env.GEMINI_API_KEY);
}

/** Formats the model reads directly: the file itself is the input. */
export function nativeReadEligible(format) {
  const normalised = String(format ?? "").toLowerCase().replace(/^\./, "");
  return normalised === "pdf" || Boolean(IMAGE_MIME[normalised]);
}

export function nativeReadBlocked() {
  return Date.now() < quotaBlockedUntil;
}

function noteFailure(error) {
  if (QUOTA_RE.test(String(error?.message ?? error))) {
    quotaBlockedUntil = Date.now() + documentRead.quotaCooldownMs;
    return "QUOTA";
  }
  return "READ_FAILED";
}

function mimeFor(format) {
  const normalised = String(format ?? "").toLowerCase().replace(/^\./, "");
  return IMAGE_MIME[normalised] ?? PDF_MIME;
}

const READ_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    language: { type: "STRING" },
    pages: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          page: { type: "INTEGER" },
          markdown: { type: "STRING" },
        },
        required: ["page", "markdown"],
      },
    },
    digest: {
      type: "OBJECT",
      properties: {
        topics: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              summary: { type: "STRING" },
              keyPoints: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["title", "summary"],
          },
        },
        keyTerms: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              term: { type: "STRING" },
              definition: { type: "STRING" },
            },
            required: ["term", "definition"],
          },
        },
        formulas: { type: "ARRAY", items: { type: "STRING" } },
        figures: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["topics"],
    },
  },
  required: ["pages", "digest"],
};

const VISUALS_SCHEMA = {
  type: "OBJECT",
  properties: {
    images: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          text: { type: "STRING" },
          description: { type: "STRING" },
        },
        required: ["id"],
      },
    },
  },
  required: ["images"],
};

function readPrompt(pageCount) {
  return `Read this uploaded university document (${pageCount} page${pageCount === 1 ? "" : "s"}) and return its content faithfully.

Rules:
- Transcribe every page in order. Preserve headings, bullet and numbered lists, tables (as markdown), formulas, labels and captions.
- For diagrams, charts and figures, describe what they show in one or two sentences next to the surrounding text.
- Do NOT summarise, shorten, skip pages, or add commentary. Keep technical terms, symbols and numbers exactly as written.
- Page numbers start at 1 and must match the file.
- Then produce a compact digest: topics in document order, key terms, formulas, and figures/charts worth studying.
- Return JSON only, with no text outside the JSON object.`;
}

function imagePrompt() {
  return `Read this photo of university lecture material (whiteboard, printed handout, slide or page) and return what it shows.

Rules:
- Transcribe all visible text exactly as written, in reading order, keeping headings, lists, formulas and symbols.
- If the image contains a diagram, graph, table or figure, add one or two sentences describing what it shows.
- Do NOT summarise away content, guess at illegible words, or add commentary about the photo itself.
- Return JSON only, with no text outside the JSON object.`;
}

function visualsPrompt(count) {
  return `You are given ${count} image${count === 1 ? "" : "s"} taken from a university lecture document, in document order. Each image is preceded by its id.

For every image, in the order given:
- Transcribe all visible text exactly as written, in reading order. Keep headings, lists, formulas, labels and numbers. Markdown is fine.
- Then describe any diagram, graph, table, photo or chart in one or two sentences.
- If an image has no readable text, leave "text" empty and describe it.
- Never invent content, never skip an image, and never merge two images into one entry.
- Return JSON only, with no text outside the JSON object.`;
}

function parseJson(text) {
  const raw = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  return JSON.parse(raw);
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function shapeDigest(value) {
  if (!value || typeof value !== "object") return null;
  const topics = (Array.isArray(value.topics) ? value.topics : [])
    .map((topic) => ({
      title: clean(topic?.title, 200),
      summary: clean(topic?.summary, 1200),
      keyPoints: (Array.isArray(topic?.keyPoints) ? topic.keyPoints : [])
        .map((point) => clean(point, 500))
        .filter(Boolean)
        .slice(0, 12),
    }))
    .filter((topic) => topic.title || topic.summary)
    .slice(0, 80);
  const keyTerms = (Array.isArray(value.keyTerms) ? value.keyTerms : [])
    .map((term) => ({
      term: clean(term?.term, 120),
      definition: clean(term?.definition, 600),
    }))
    .filter((term) => term.term && term.definition)
    .slice(0, 120);
  const formulas = (Array.isArray(value.formulas) ? value.formulas : [])
    .map((formula) => clean(formula, 400))
    .filter(Boolean)
    .slice(0, 80);
  const figures = (Array.isArray(value.figures) ? value.figures : [])
    .map((figure) => clean(figure, 600))
    .filter(Boolean)
    .slice(0, 80);
  const digest = { topics, keyTerms, formulas, figures };
  return topics.length || keyTerms.length || formulas.length || figures.length
    ? digest
    : null;
}

/**
 * Page alignment is all-or-nothing: a missing or duplicated page would put the
 * wrong text under a page label (and citations), which is worse than a blob.
 */
function shapePages(value, expectedPages) {
  const entries = (Array.isArray(value) ? value : [])
    .map((entry) => ({
      page: Number(entry?.page),
      text: clean(entry?.markdown, 200_000),
    }))
    .filter((entry) => Number.isInteger(entry.page) && entry.page >= 1 && entry.text);

  const unique = new Map();
  for (const entry of entries) {
    if (!unique.has(entry.page)) unique.set(entry.page, entry.text);
  }
  const complete =
    expectedPages > 0 &&
    unique.size === expectedPages &&
    [...unique.keys()].every((page) => page >= 1 && page <= expectedPages);

  if (complete) {
    return {
      aligned: true,
      pages: [...unique.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, text]) => ({ page, label: `p. ${page}`, text })),
    };
  }

  const blob = entries
    .sort((a, b) => a.page - b.page)
    .map((entry) => entry.text)
    .join("\n\n")
    .trim();
  return {
    aligned: false,
    pages: blob ? [{ page: 1, label: null, text: blob }] : [],
  };
}

/**
 * Read one PDF or image natively. Returns:
 *   { ok: true, model, promptTokens, completionTokens, pageCount, aligned,
 *     pages: [{ page, label, text }], digest, ms }
 *   { ok: false, code, pageCount? }
 * Never throws: every failure is a fallback, not a broken upload.
 */
export async function readDocumentNatively({ bytes, format, timeoutMs }) {
  if (!nativeReadEnabled() || !nativeReadEligible(format)) {
    return { ok: false, code: "DISABLED" };
  }
  if (nativeReadBlocked()) return { ok: false, code: "QUOTA_COOLDOWN" };
  if (!bytes?.length) return { ok: false, code: "UNREADABLE_FILE" };
  if (bytes.length > documentRead.maxBytes) {
    return { ok: false, code: "TOO_LARGE" };
  }

  const normalised = String(format ?? "").toLowerCase().replace(/^\./, "");
  const isImage = Boolean(IMAGE_MIME[normalised]);
  const started = Date.now();
  let pageCount = 0;

  if (!isImage) {
    try {
      const parsed = await extractPdfPages(bytes);
      pageCount = parsed?.pageCount || parsed?.segments?.length || 0;
    } catch (error) {
      console.warn(
        `[native-read] PAGE_COUNT_FAILED: ${error?.message ?? error}`,
      );
      return { ok: false, code: "PAGE_COUNT_FAILED" };
    }
    if (!pageCount) return { ok: false, code: "UNREADABLE_FILE" };
    if (pageCount > documentRead.maxPages) {
      return { ok: false, code: "TOO_MANY_PAGES", pageCount };
    }
  }

  const mimeType = mimeFor(normalised);
  let upload = null;
  try {
    if (bytes.length > documentRead.inlineMaxBytes) {
      upload = await geminiUploadFile({
        bytes,
        mimeType,
        displayName: isImage ? `image.${normalised}` : "document.pdf",
      });
    }
    const result = await geminiReadDocument({
      bytes,
      fileUri: upload?.uri ?? null,
      mimeType,
      prompt: isImage ? imagePrompt() : readPrompt(pageCount),
      schema: READ_SCHEMA,
      maxOutputTokens: documentRead.maxOutputTokens,
      timeoutMs: timeoutMs ?? documentRead.timeoutMs,
    });

    let parsed;
    try {
      parsed = parseJson(result.text);
    } catch {
      return { ok: false, code: "INVALID_JSON", pageCount };
    }
    // One image is one page: there is no page numbering to align, so the read
    // succeeds as long as text came back.
    const shaped = isImage
      ? shapeImagePage(parsed?.pages, parsed?.digest)
      : shapePages(parsed?.pages, pageCount);
    if (!shaped.pages.length) return { ok: false, code: "EMPTY_READ", pageCount };

    return {
      ok: true,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      pageCount: isImage ? 1 : pageCount,
      aligned: shaped.aligned,
      pages: shaped.pages,
      title: clean(parsed?.title, 300) || null,
      language: clean(parsed?.language, 60) || null,
      digest: shapeDigest(parsed?.digest),
      ms: Date.now() - started,
    };
  } catch (error) {
    console.warn(
      `[native-read] FAILED: ${error?.message ?? error}`,
    );
    return {
      ok: false,
      code: noteFailure(error),
      pageCount,
    };
  } finally {
    if (upload?.name) await geminiDeleteFile(upload.name);
  }
}

/** An image has no page structure: join whatever the model transcribed. */
function shapeImagePage(value, digest) {
  const text = (Array.isArray(value) ? value : [])
    .map((entry) => clean(entry?.markdown, 200_000))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (text) return { aligned: true, pages: [{ page: 1, label: null, text }] };
  // A figure-only photo: the description is the only content there is.
  const figures = (Array.isArray(digest?.figures) ? digest.figures : [])
    .map((figure) => clean(figure, 600))
    .filter(Boolean)
    .slice(0, 6);
  return figures.length
    ? { aligned: false, pages: [{ page: 1, label: null, text: figures.join("\n") }] }
    : { aligned: false, pages: [] };
}

/**
 * Read a single image (a note's photo asset). Same shape as a one-page
 * document read, but without the page-count probe a PDF needs.
 * Returns { ok, text, model, ms } or { ok: false, code }.
 */
export async function readImageNatively({ bytes, format, timeoutMs }) {
  const result = await readDocumentNatively({ bytes, format, timeoutMs });
  if (!result.ok) return { ok: false, code: result.code };
  return {
    ok: true,
    text: result.pages[0]?.text ?? "",
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    ms: result.ms,
  };
}

/**
 * Read the pictures embedded in a DOCX/PPTX in batches, one model call per
 * batch instead of per image (the free tier's quota is daily and per project).
 * Returns { ok, text: Map<id, string>, model, calls, ms } where each value is
 * the transcription plus a one-line description. Never throws: a partial map is
 * still useful, and an empty map means "use the local text only".
 */
export async function readEmbeddedVisuals({ images, timeoutMs }) {
  if (!documentRead.embeddedImages) return { ok: false, code: "DISABLED" };
  if (!images?.length) return { ok: false, code: "NO_IMAGES" };
  if (!nativeReadEnabled()) return { ok: false, code: "DISABLED" };
  if (nativeReadBlocked()) return { ok: false, code: "QUOTA_COOLDOWN" };

  const started = Date.now();
  const texts = new Map();
  let model = null;
  let calls = 0;

  // Base64 inflates by ~4/3 and the request cap is on the encoded body, so
  // batches stay well under the inline limit; an oversized picture is skipped
  // rather than failing the whole batch.
  const byteBudget = Math.floor(documentRead.inlineMaxBytes * 0.6);
  const usable = images.filter((image) => image.bytes.length <= byteBudget);
  if (!usable.length) return { ok: false, code: "TOO_LARGE" };

  const batches = [];
  let batch = [];
  let bytesInBatch = 0;
  for (const image of usable) {
    if (
      batch.length >= documentRead.imageBatchSize ||
      (batch.length && bytesInBatch + image.bytes.length > byteBudget)
    ) {
      batches.push(batch);
      batch = [];
      bytesInBatch = 0;
    }
    batch.push(image);
    bytesInBatch += image.bytes.length;
  }
  if (batch.length) batches.push(batch);

  for (const group of batches) {
    const remaining = timeoutMs ? timeoutMs - (Date.now() - started) : documentRead.timeoutMs;
    if (remaining < 20_000) break;
    try {
      const result = await geminiReadImages({
        images: group.map((image) => ({
          id: image.id,
          bytes: image.bytes,
          mimeType: image.mimeType,
        })),
        prompt: visualsPrompt(group.length),
        schema: VISUALS_SCHEMA,
        maxOutputTokens: Math.min(
          documentRead.maxOutputTokens,
          documentRead.maxOutputTokensPerImage * group.length,
        ),
        timeoutMs: remaining,
      });
      calls += 1;
      model = result.model;
      let parsed;
      try {
        parsed = parseJson(result.text);
      } catch {
        continue;
      }
      for (const entry of Array.isArray(parsed?.images) ? parsed.images : []) {
        const id = clean(entry?.id, 200);
        if (!id) continue;
        const text = clean(entry?.text, 20_000);
        const description = clean(entry?.description, 800);
        const combined = [text, description && description !== text ? `_${description}_` : ""]
          .filter(Boolean)
          .join("\n\n");
        if (combined) texts.set(id, combined);
      }
    } catch (error) {
      console.warn(`[native-read] VISUALS_FAILED: ${error?.message ?? error}`);
      noteFailure(error);
      // A quota error will fail every remaining batch too: stop here.
      if (nativeReadBlocked()) break;
    }
  }

  return {
    ok: texts.size > 0,
    code: texts.size ? null : "NO_VISUAL_TEXT",
    text: texts,
    model,
    calls,
    ms: Date.now() - started,
  };
}
