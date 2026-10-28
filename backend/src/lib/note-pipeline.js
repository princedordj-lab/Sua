/**
 * Note pipeline: Extract -> Clean -> Split -> Digest -> Write -> Check -> Save.
 *
 * One attempt writes the note body for `lecture_note` (which the caller then
 * turns into summary/cards/quiz) or the single reference page for
 * `course_reference`. Every stage works from the same segment list, so files
 * (per page/slide), recordings (per 2-minute segment) and typed notes (one
 * unlabelled block) share one code path.
 *
 * External I/O (storage reads, OCR, transcription, model calls) happens here,
 * outside withUser; the database writes are short callbacks supplied by
 * pipeline.js.
 */

import {
  bulkModel,
  geminiImageText,
  geminiTranscribe,
  chatCompletion,
  strongModel,
} from "./ai.js";
// extract.js pulls in @napi-rs/canvas (a native .node binary) and pdf-parse,
// neither of which can be bundled into a Cloudflare Worker. Both functions are
// imported lazily inside documentSegments() so this module can be required in
// CF Workers environments where the extract path is never reached.
// import { extractDocument, renderPdfPage } from "./extract.js"; // lazy — see below
import { checkSourceFidelity } from "./numbers.js";
import {
  PROMPT_VERSION,
  cleanupPrompt,
  digestPrompt,
  lectureNotePrompt,
  referencePrompt,
  stricterRetrySuffix,
} from "./prompts.js";
import {
  USER_MESSAGES,
  UserFacingError,
  notePipeline,
} from "../config/ai-pipeline.js";

const MIME_BY_FORMAT = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

const ACTIVE_ASSET = (asset) =>
  asset.status === "active" && asset.publicId !== "pending";

function mimeFor(asset) {
  const format = String(asset.format ?? "").toLowerCase();
  if (asset.kind === "audio") return MIME_BY_FORMAT[format] ?? "audio/mp4";
  if (asset.kind === "image") return MIME_BY_FORMAT[format] ?? "image/jpeg";
  return "application/octet-stream";
}

function text(value) {
  return String(value ?? "").trim();
}

export function activeAssets(note) {
  return (note.assets ?? [])
    .filter(ACTIVE_ASSET)
    .sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

/**
 * The three source types the prompts know about, derived from the assets that
 * actually exist. "audio" is the stored value for a recording; no schema change.
 */
export function sourceTypeOf(note) {
  const assets = activeAssets(note);
  if (assets.some((asset) => asset.kind === "audio")) return "recording";
  if (assets.some((asset) => asset.kind === "document" || asset.kind === "image")) {
    return "file";
  }
  if (note.sourceType === "audio") return "recording";
  if (note.sourceType === "file") return "file";
  return "typed";
}

/**
 * The student's own words. After the first lecture_note run the AI body lives
 * in `body` and the original capture in `transcript`; regeneration must read
 * the original, never the rewritten body.
 */
export function typedSourceOf(note) {
  const transcript = text(note.transcript);
  const body = text(note.body);
  if (transcript && transcript !== body) return transcript;
  return body || transcript;
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function labelOf(segment) {
  return segment.label ? `## ${segment.label}\n\n${segment.text}` : segment.text;
}

export function buildTranscript(segments) {
  return segments.map(labelOf).join("\n\n");
}

/** Parse a previously persisted labelled transcript back into segments. */
export function parseTranscript(value) {
  const input = String(value ?? "").trim();
  if (!input) return [];
  if (!/^##\s/m.test(input)) {
    return [{ index: 1, label: null, text: input }];
  }
  const segments = [];
  const parts = input.split(/^##\s+/m).filter(Boolean);
  for (const part of parts) {
    const [first, ...rest] = part.split("\n");
    segments.push({
      index: segments.length + 1,
      label: first.trim(),
      text: rest.join("\n").trim(),
    });
  }
  return segments.filter((segment) => segment.text);
}

/**
 * Build the shape prepareMaterial expects from an already-extracted source.
 * Used by the eval harness and any caller that brings its own segmentation.
 */
export function sourceFromSegments(
  segments,
  { sourceType = "typed", pageCount = 1, minutes = 0, truncated = false } = {},
) {
  const usable = segments.filter((segment) => text(segment.text));
  const rawText = buildTranscript(usable);
  return {
    sourceType,
    segments: usable,
    rawText,
    transcript: rawText,
    truncated,
    pageCount: pageCount || usable.length || 1,
    minutes,
  };
}

/** One unlabelled segment, for plain-text samples and tests. */
export function sourceFromText(value, options = {}) {
  return sourceFromSegments(
    [{ index: 1, label: null, text: String(value ?? "") }],
    options,
  );
}

// ---------------------------------------------------------------------------
// 1. Extract
// ---------------------------------------------------------------------------

async function audioText(asset, deps) {
  if (text(asset.extractedText)) return text(asset.extractedText);
  const bytes = await deps.readBytes(asset);
  const result = await geminiTranscribe({
    bytes,
    mimeType: mimeFor(asset),
    languageHint: "English (may include a Ghanaian university accent)",
  });
  await deps.record("transcribe", result);
  const transcript = text(result.text);
  if (transcript) await deps.saveAssetText(asset, transcript);
  return transcript;
}

async function imageText(asset, deps) {
  if (text(asset.extractedText)) return text(asset.extractedText);
  const bytes = await deps.readBytes(asset);
  const result = await geminiImageText({ bytes, mimeType: mimeFor(asset) });
  await deps.record("ocr", result);
  const ocr = text(result.text);
  if (ocr) await deps.saveAssetText(asset, ocr);
  return ocr;
}

async function documentSegments(asset, deps, onScan) {
  if (!asset.bytes || asset.bytes <= 0) {
    return { segments: [], truncated: false, pageCount: 0 };
  }
  // Upload completion has already extracted document text in the Node API. Reuse
  // it for every format (including PDFs) so a Cloudflare Worker never needs to
  // load the native canvas/PDF stack merely to process an ordinary upload.
  if (text(asset.extractedText)) {
    return {
      segments: [{ index: 1, label: null, text: text(asset.extractedText) }],
      truncated: false,
      pageCount: 1,
    };
  }
  // The tick runner supplies these native-PDF helpers. They are omitted
  // from the Cloudflare Worker dependency graph because Workers cannot load a
  // platform-specific `.node` addon such as @napi-rs/canvas.
  if (!deps.extractDocument) {
    return { segments: [], truncated: false, pageCount: 0 };
  }
  let bytes;
  try {
    bytes = await deps.readBytes(asset);
  } catch (error) {
    console.warn(
      `Asset ${asset.id} could not be read: ${error?.message ?? error}`,
    );
    return {
      segments: asset.extractedText
        ? [{ index: 1, label: null, text: text(asset.extractedText) }]
        : [],
      truncated: false,
      pageCount: 1,
    };
  }
  const extracted = await deps.extractDocument(bytes, asset.format, asset.kind);
  if (!extracted) {
    return {
      segments: asset.extractedText
        ? [{ index: 1, label: null, text: text(asset.extractedText) }]
        : [],
      truncated: false,
      pageCount: 1,
    };
  }
  if (asset.format !== "pdf") {
    return {
      segments: extracted.segments,
      truncated: extracted.truncated,
      pageCount: extracted.pageCount,
    };
  }

  // Scanned pages carry no text layer; OCR just the pages that look empty, up
  // to a hard cap so one huge scan cannot burn the whole AI budget.
  const segments = [];
  let scans = 0;
  for (const segment of extracted.segments) {
    const existing = text(segment.text);
    if (existing.length >= notePipeline.ocrMinChars) {
      segments.push({ ...segment, text: existing });
      continue;
    }
    if (scans >= notePipeline.maxOcrPages) {
      if (existing) segments.push({ ...segment, text: existing });
      continue;
    }
    scans += 1;
    await onScan();
    if (!deps.renderPdfPage) {
      if (existing) segments.push({ ...segment, text: existing });
      continue;
    }
    const image = await deps.renderPdfPage(
      bytes,
      segment.index,
      notePipeline.ocrScale,
    );
    if (!image) {
      if (existing) segments.push({ ...segment, text: existing });
      continue;
    }
    const result = await geminiImageText({
      bytes: image,
      mimeType: "image/png",
    });
    await deps.record("ocr_page", result);
    const ocr = text(result.text);
    if (ocr.length > existing.length) {
      segments.push({ ...segment, text: ocr });
    } else if (existing) {
      segments.push({ ...segment, text: existing });
    }
  }
  return {
    segments,
    truncated: extracted.truncated || scans >= notePipeline.maxOcrPages,
    pageCount: extracted.pageCount,
  };
}

/**
 * Build the source segments and the metadata the rest of the run needs.
 */
export async function assembleSource(note, deps) {
  const assets = activeAssets(note);
  const sourceType = sourceTypeOf(note);
  const segments = [];
  let truncated = false;
  let pageCount = 0;

  if (sourceType === "typed") {
    const typed = typedSourceOf(note);
    if (typed) {
      segments.push({ index: 1, label: null, text: typed });
      pageCount = 1;
    }
  } else if (sourceType === "recording") {
    const audio = assets.filter((asset) => asset.kind === "audio");
    for (const [index, asset] of audio.entries()) {
      const transcript = await audioText(asset, deps);
      if (!transcript) continue;
      segments.push({
        index: segments.length + 1,
        label: `about ${clock(index * notePipeline.segmentSeconds)}`,
        text: transcript,
      });
    }
    pageCount = segments.length;
    // No audio left (assets pruned): fall back to the labelled transcript.
    if (!segments.length) {
      for (const segment of parseTranscript(note.transcript)) segments.push(segment);
      pageCount = segments.length;
    }
  } else {
    for (const asset of assets) {
      if (asset.kind === "image") {
        const ocr = await imageText(asset, deps);
        if (ocr) {
          segments.push({
            index: segments.length + 1,
            label: `Image ${segments.length + 1}`,
            text: ocr,
          });
        }
        pageCount += 1;
        continue;
      }
      if (asset.kind !== "document") continue;
      const pages = await documentSegments(asset, deps, () =>
        deps.setStage("reading_scans"),
      );
      for (const page of pages.segments) {
        segments.push({
          index: segments.length + 1,
          label: page.label,
          text: page.text,
        });
      }
      pageCount += pages.pageCount || pages.segments.length || 1;
      if (pages.truncated) truncated = true;
    }
    if (!segments.length) {
      for (const segment of parseTranscript(note.transcript)) segments.push(segment);
      pageCount = pageCount || segments.length;
    }
    // A file note may also carry typed context; never an AI-written body.
    const typed = text(note.body);
    if (typed && !text(note.transcript)) {
      segments.unshift({ index: 0, label: null, text: typed });
    }
  }

  if (!segments.length) throw new UserFacingError(USER_MESSAGES.unreadable);

  const rawText = buildTranscript(segments);
  // Extraction can succeed and still yield nothing usable (a blank scan, an
  // image-only PDF with no OCR pages left, a one-word note). Stop here so the
  // student sees an honest message instead of a note made of [unclear].
  if (rawText.replace(/\s+/g, "").length < notePipeline.minSourceChars) {
    throw new UserFacingError(
      sourceType === "typed" ? USER_MESSAGES.tooShort : USER_MESSAGES.unreadable,
    );
  }
  return {
    sourceType,
    segments,
    rawText,
    transcript: rawText,
    truncated,
    pageCount: pageCount || segments.length,
    minutes:
      sourceType === "recording"
        ? Math.max(
            notePipeline.minutesPerAudioAsset,
            segments.length * notePipeline.minutesPerAudioAsset,
          )
        : 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Clean
// ---------------------------------------------------------------------------

const PAGE_NUMBER_LINE = /^[ \t]*(?:page[ \t]*)?\d{1,4}(?:[ \t]*(?:of|\/)[ \t]*\d{1,4})?[ \t]*$/gim;
const FILLER = [
  [/\b(um+|uh+|erm+|ah+)\b[,\s]*/gi, " "],
  [/\b(\w+)\s+\1\b/gi, "$1"],
  [/\s+([,.;:!?])/g, "$1"],
];

function cleanPageLines(segments) {
  if (segments.length < 3) return segments;
  const counts = new Map();
  for (const segment of segments) {
    const seen = new Set();
    for (const line of segment.text.split("\n")) {
      const key = line.trim().toLowerCase();
      if (key.length < 3 || key.length > 120 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = segments.length * notePipeline.headerFooterPageRatio;
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > threshold)
      .map(([line]) => line),
  );
  if (!repeated.size) return segments;
  return segments.map((segment) => {
    const original = segment.text;
    const filtered = original
      .split("\n")
      .filter((line) => !repeated.has(line.trim().toLowerCase()))
      .join("\n")
      .trim();
    // A repeated line is normally a running header/footer, but a short deck or
    // handout can repeat real content on every page. Never let the filter eat a
    // page down to nothing (or to just its page label) — that turns a readable
    // upload into an empty note.
    const floor = Math.min(notePipeline.ocrMinChars, original.trim().length);
    return { ...segment, text: filtered.length >= floor ? filtered : original.trim() };
  });
}

function cleanSegmentText(value, sourceType) {
  if (sourceType === "typed") return value.trim();
  let output = value.replace(PAGE_NUMBER_LINE, "");
  for (const [pattern, replacement] of FILLER) {
    output = output.replace(pattern, replacement);
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line || lines[index - 1] !== "")
    .join("\n")
    .trim();
}

export function cleanSegments(segments, sourceType) {
  const withoutRunning = sourceType === "file" ? cleanPageLines(segments) : segments;
  return withoutRunning
    .map((segment) => ({
      ...segment,
      text: cleanSegmentText(segment.text, sourceType),
    }))
    .filter((segment) => segment.text);
}

async function aiCleanup(segments, courseContext, deps) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const segment of segments) {
    const length = segment.text.length + (segment.label?.length ?? 0) + 8;
    if (current.length && size + length > 30_000) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
  }
  if (current.length) chunks.push(current);

  const cleaned = [];
  for (const chunk of chunks) {
    const input = chunk.map(labelOf).join("\n\n");
    const result = await chatCompletion({
      system: cleanupPrompt({ course: courseContext }),
      user: input,
      model: bulkModel(),
      temperature: 0,
    });
    await deps.record("cleanup", result);
    const parsed = parseTranscript(result.text);
    if (parsed.length === chunk.length) {
      cleaned.push(...parsed);
      continue;
    }
    // The model reshaped the labels; drop the AI pass for this chunk rather
    // than risk attaching the wrong page to the wrong text.
    cleaned.push(...chunk);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// 3. Split
// ---------------------------------------------------------------------------

function paragraphsOf(value) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * Group segments into ~`maxWords` chunks. A chunk never splits a paragraph,
 * which keeps formulas and table rows on one line.
 */
export function splitChunks(segments, maxWords = notePipeline.chunkWords) {
  const chunks = [];
  let current = { labels: [], texts: [], words: 0 };
  const push = () => {
    if (!current.texts.length) return;
    chunks.push({
      index: chunks.length + 1,
      labels: current.labels,
      text: current.texts.join("\n\n"),
      words: current.words,
    });
    current = { labels: [], texts: [], words: 0 };
  };

  for (const segment of segments) {
    const paragraphs = paragraphsOf(segment.text);
    const segmentWords = segment.text.split(/\s+/).filter(Boolean).length;
    if (current.words && current.words + segmentWords > maxWords) push();
    if (segmentWords <= maxWords) {
      current.texts.push(segment.text);
      current.words += segmentWords;
      if (segment.label) current.labels.push(segment.label);
      continue;
    }
    for (const paragraph of paragraphs) {
      const words = paragraph.split(/\s+/).filter(Boolean).length;
      if (current.words && current.words + words > maxWords) push();
      current.texts.push(paragraph);
      current.words += words;
      if (segment.label) current.labels.push(segment.label);
    }
  }
  push();
  return chunks;
}

function rangeLabel(chunk) {
  if (!chunk.labels.length) return "";
  const first = chunk.labels[0];
  const last = chunk.labels[chunk.labels.length - 1];
  return first === last ? first : `${first} - ${last}`;
}

// ---------------------------------------------------------------------------
// 4. Digest
// ---------------------------------------------------------------------------

function parseJsonObject(value) {
  const trimmed = String(value ?? "")
    .replace(/```json|```/g, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function shapeTopic(topic) {
  return {
    heading: text(topic?.heading) || "Untitled topic",
    points: asStringArray(topic?.points),
    terms: Array.isArray(topic?.terms)
      ? topic.terms
          .map((term) => ({
            term: text(term?.term),
            definition: text(term?.definition),
          }))
          .filter((term) => term.term && term.definition)
      : [],
    formulas: Array.isArray(topic?.formulas)
      ? topic.formulas
          .map((formula) => ({
            expression: text(formula?.expression),
            context: text(formula?.context),
            symbols: Array.isArray(formula?.symbols)
              ? formula.symbols
                  .map((symbol) => ({
                    symbol: text(symbol?.symbol),
                    meaning: text(symbol?.meaning),
                    unit: text(symbol?.unit),
                  }))
                  .filter((symbol) => symbol.symbol)
              : [],
          }))
          .filter((formula) => formula.expression)
      : [],
    examples: asStringArray(topic?.examples),
    emphasised: asStringArray(topic?.emphasised),
    source: text(topic?.source),
  };
}

export function validateDigest(digest) {
  if (!digest || typeof digest !== "object") return "not an object";
  if (!Array.isArray(digest.topics) || !digest.topics.length) return "no topics";
  for (const topic of digest.topics) {
    if (!text(topic?.heading)) return "topic without a heading";
    const hasContent =
      asStringArray(topic?.points).length ||
      (Array.isArray(topic?.terms) && topic.terms.length) ||
      (Array.isArray(topic?.formulas) && topic.formulas.length) ||
      asStringArray(topic?.examples).length;
    if (!hasContent) return `topic "${topic?.heading}" has no content`;
  }
  return null;
}

// Exported for the long-file pipeline (lib/long-doc.js), which shares the
// digest call, its validation and its concurrency pool verbatim.
export { digestChunk, digestToText, rangeLabel, mapWithLimit, parseJsonObject };

async function digestChunk(chunk, context, deps) {
  const attempt = async (suffix) => {
    const result = await chatCompletion({
      system: digestPrompt({
        course: context.courseContext,
        sourceType: context.sourceType,
        chunkIndex: chunk.index - 1,
        chunkCount: context.chunkCount,
      }),
      user: `${suffix ? `${suffix}\n\n` : ""}=== SOURCE PART ${chunk.index}/${context.chunkCount} ===\n${chunk.text}`,
      model: bulkModel(),
      json: true,
      temperature: 0,
      maxTokens: notePipeline.digestMaxTokens,
    });
    await deps.record(suffix ? "digest_retry" : "digest", result);
    const parsed = parseJsonObject(result.text);
    const problem = parsed ? validateDigest(parsed) : "unparseable JSON";
    // A response that stops mid-object was cut off by the output budget; asking
    // for the same size again just fails the same way.
    const cutOff = !/\}\s*$/.test(text(result.text));
    return { parsed, problem, cutOff };
  };

  let outcome = await attempt("");
  if (outcome.problem) {
    const hint = outcome.cutOff
      ? " Your previous answer was cut off. Return a shorter JSON object: at most 6 topics, at most 5 points per topic."
      : "";
    outcome = await attempt(
      `Your previous JSON was invalid: ${outcome.problem}. Return only the JSON object.${hint}`,
    );
  }
  if (outcome.problem) {
    throw new Error(`Digest failed validation (${outcome.problem})`);
  }
  return {
    range: text(outcome.parsed.range) || rangeLabel(chunk),
    topics: outcome.parsed.topics.map(shapeTopic),
    unclear: asStringArray(outcome.parsed.unclear).slice(0, 20),
  };
}

// Small worker pool: keeps digest calls parallel without hammering the provider.
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function digestToText(digest) {
  const lines = [`Range: ${digest.range}`];
  for (const topic of digest.topics) {
    lines.push(`\n### ${topic.heading}`);
    for (const point of topic.points) lines.push(`- ${point}`);
    for (const term of topic.terms) lines.push(`- ${term.term}: ${term.definition}`);
    for (const formula of topic.formulas) {
      const symbols = formula.symbols
        .map(
          (symbol) =>
            `${symbol.symbol} = ${symbol.meaning}${symbol.unit ? ` (${symbol.unit})` : ""}`,
        )
        .join("; ");
      lines.push(
        `- Formula: ${formula.expression}${symbols ? ` => ${symbols}` : ""}${formula.context ? ` (${formula.context})` : ""}`,
      );
    }
    for (const example of topic.examples) lines.push(`- Example: ${example}`);
    for (const emphasis of topic.emphasised) lines.push(`- Emphasised: ${emphasis}`);
    if (topic.source) lines.push(`- Source: ${topic.source}`);
  }
  if (digest.unclear.length) {
    lines.push(`\nUnclear: ${digest.unclear.join(" | ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Write
// ---------------------------------------------------------------------------

const WRITE_MAX_CHARS = 40_000;

function splitMaterial(material) {
  if (material.length <= WRITE_MAX_CHARS) return [material];
  const paragraphs = material.split(/\n{2,}/);
  const parts = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > WRITE_MAX_CHARS) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function writeParts({ system, material, context, deps, step }) {
  const parts = splitMaterial(material);
  const written = [];
  for (const [index, part] of parts.entries()) {
    const tail = written.length
      ? written[written.length - 1].slice(-900).trim()
      : "";
    const continuation =
      parts.length > 1
        ? `This is part ${index + 1}/${parts.length} of one long material. Continue the note seamlessly: ` +
          "keep one coherent heading structure and do not repeat a heading." +
          (tail ? `\nThe previous part ended with:\n"""\n${tail}\n"""\nContinue from there.` : "")
        : "";
    const result = await chatCompletion({
      system,
      user: `${context}\n${continuation}\n\n=== MATERIAL ===\n${part}`,
      model: strongModel(),
      temperature: 0.2,
      maxTokens: notePipeline.writeMaxTokens,
    });
    await deps.record(index === 0 ? step : `${step}_part`, result);
    const body = text(result.text);
    if (body) written.push(body);
  }
  return written.join("\n\n");
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})(\s+.*)$/;

/**
 * The reader and the markdown renderer treat "## " as a section start, so a
 * body whose top-level heading is "#" (or "###") renders as one giant heading
 * or as no sections at all, and the note falls apart. Models drift between
 * heading levels for the same prompt, so shift every heading until the
 * top-level heading is exactly "##". Fenced code blocks are left alone (a
 * "# comment" is not a heading). Text without headings is returned untouched.
 */
export function normaliseHeadings(body) {
  const source = String(body ?? "");
  const lines = source.split("\n");
  let fenced = false;
  let minimum = Infinity;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(HEADING);
    if (match) minimum = Math.min(minimum, match[1].length);
  }
  if (!Number.isFinite(minimum) || minimum === 2) return source;
  const shift = 2 - minimum;

  fenced = false;
  return lines
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const match = line.match(HEADING);
      if (!match) return line;
      const level = Math.min(Math.max(match[1].length + shift, 1), 6);
      return `${"#".repeat(level)}${match[2]}`;
    })
    .join("\n");
}

function structureProblems(body, kind) {
  const problems = [];
  if (!/^##\s/m.test(body)) problems.push("no ## sections");
  if (/^\s*\|.*\|\s*$/m.test(body)) problems.push("markdown tables");
  if (/\$\$|\\frac|\\times|\\cdot/.test(body)) problems.push("LaTeX");
  if (!/[A-Za-z]/.test(body)) problems.push("no readable text");
  const words = body.split(/\s+/).filter(Boolean).length;
  if (kind === "course_reference" && words > Math.round(notePipeline.referenceMaxWords * 1.15)) {
    problems.push(`over ${notePipeline.referenceMaxWords} words`);
  }
  return { problems, words };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Extract -> Clean -> Split -> Digest.
 *
 * Shared by every job kind so a study set reads exactly the same material a
 * lecture note does. Returns the written material (digest text for long
 * sources, labelled source text for short ones) plus the metadata the caller
 * stores on the job.
 */
export async function prepareMaterial({ note, kind, courseContext, deps, source: presetSource }) {
  const meta = {
    promptVersion: PROMPT_VERSION,
    sourceType: null,
    stageReached: "reading",
    truncated: false,
    pagesUsed: 0,
    pageCount: 0,
    minutes: 0,
    digests: 0,
    writeRetries: 0,
    unsupportedNumbers: [],
    unsupportedFormulas: [],
    words: 0,
    modelCalls: 0,
    checkPassed: null,
    fidelityFailed: false,
    structureProblems: [],
  };
  const countedDeps = {
    ...deps,
    record: async (step, result) => {
      meta.modelCalls += 1;
      await deps.record?.(step, result);
    },
    setStage: async (stage) => {
      meta.stageReached = stage;
      await deps.setStage?.(stage);
    },
  };

  await countedDeps.setStage("reading");
  await countedDeps.assertAlive?.();
  const source = presetSource ?? (await assembleSource(note, countedDeps));
  meta.sourceType = source.sourceType;
  meta.truncated = source.truncated;
  meta.pageCount = source.pageCount;
  meta.minutes = source.minutes;

  if (
    kind === "course_reference" &&
    source.sourceType === "file" &&
    source.pageCount > notePipeline.maxReferencePages
  ) {
    throw new UserFacingError(USER_MESSAGES.tooLong);
  }

  const cleanedSegments = cleanSegments(source.segments, source.sourceType);
  if (!cleanedSegments.length) throw new UserFacingError(USER_MESSAGES.unreadable);
  const cleaned =
    source.sourceType === "recording" && notePipeline.aiCleanupRecordings
      ? cleanSegments(
          await aiCleanup(cleanedSegments, courseContext, countedDeps),
          "recording",
        )
      : cleanedSegments;

  const short =
    (source.sourceType === "file" &&
      source.pageCount <= notePipeline.shortSourcePages) ||
    (source.sourceType === "recording" &&
      source.minutes <= notePipeline.shortSourceMinutes) ||
    source.sourceType === "typed";
  const chunks = short ? [] : splitChunks(cleaned);

  await countedDeps.setStage("digesting");
  const digests = chunks.length
    ? await mapWithLimit(chunks, notePipeline.digestConcurrency, (chunk) =>
        digestChunk(
          chunk,
          {
            courseContext,
            sourceType: source.sourceType,
            chunkCount: chunks.length,
          },
          countedDeps,
        ),
      )
    : [];
  meta.digests = digests.length;
  meta.pagesUsed = source.sourceType === "typed" ? 1 : cleaned.length;

  const material = digests.length
    ? digests.map(digestToText).join("\n\n")
    : cleaned.map(labelOf).join("\n\n");

  return {
    meta,
    deps: countedDeps,
    source,
    cleaned,
    material,
    sourceHashInput: `${source.rawText}\n\n${PROMPT_VERSION}\n${kind}`,
  };
}

/**
 * Write + Check for one prepared source. Exported separately so the caller can
 * cache-check on the source hash before paying for the strong model.
 *
 * @param {object} options
 * @param {object} options.prepared  result of prepareMaterial
 * @param {string} options.kind      lecture_note | course_reference
 * @param {string} options.courseContext
 */
export async function writeNote({ prepared, kind, courseContext }) {
  const { meta, source, material } = prepared;
  const countedDeps = prepared.deps;

  await countedDeps.setStage("writing");
  const system =
    kind === "course_reference"
      ? referencePrompt({
          course: courseContext,
          sourceType: source.sourceType,
          maxWords: notePipeline.referenceMaxWords,
        })
      : lectureNotePrompt({
          course: courseContext,
          sourceType: source.sourceType,
        });
  const context =
    kind === "course_reference"
      ? "Write the reference sheet from this material."
      : "Write the complete, well-structured study note from this material.";

  let body = normaliseHeadings(
    await writeParts({
      system,
      material,
      context,
      deps: countedDeps,
      step: kind === "course_reference" ? "reference_write" : "note_write",
    }),
  );
  if (body.length < Math.min(notePipeline.noteMinChars, source.rawText.length / 2)) {
    throw new Error("Generated note was too short");
  }

  await countedDeps.setStage("checking");
  let fidelity = checkSourceFidelity({
    source: source.rawText,
    output: body,
    allow: courseContext,
  });
  let structure = structureProblems(body, kind);
  const needsRetry = fidelity.failed || structure.problems.length > 0;
  if (needsRetry) {
    meta.writeRetries += 1;
    const suffix = [
      fidelity.failed ? stricterRetrySuffix(fidelity.unsupportedNumbers) : "",
      structure.problems.length
        ? `Your previous answer had these problems: ${structure.problems.join(", ")}. Fix them.`
        : "",
      // Over-length needs a number, not a restatement of the rule: free models
      // routinely ignore "at most N words" the second time as well.
      kind === "course_reference" &&
      structure.words > notePipeline.referenceMaxWords
        ? `Your previous sheet was ${structure.words} words. Rewrite it in at most ${Math.round(
            notePipeline.referenceMaxWords * 0.85,
          )} words by keeping only the most exam-critical formulas, definitions and methods.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    body = normaliseHeadings(
      await writeParts({
        system,
        material: `${suffix}\n\n${material}`,
        context,
        deps: countedDeps,
        step: "write_retry",
      }),
    );
    fidelity = checkSourceFidelity({
      source: source.rawText,
      output: body,
      allow: courseContext,
    });
    structure = structureProblems(body, kind);
  }
  meta.unsupportedNumbers = fidelity.unsupportedNumbers;
  meta.unsupportedFormulas = fidelity.unsupportedFormulas;
  meta.fidelityFailed = fidelity.failed;
  meta.structureProblems = structure.problems;
  meta.checkPassed = !fidelity.failed && structure.problems.length === 0;
  meta.words = structure.words;

  const notices = [];
  if (source.truncated) {
    const unit =
      source.sourceType === "file" && meta.pagesUsed === 1 ? "page" : "pages";
    notices.push(`> Only the first ${meta.pagesUsed} ${unit} were used.`);
  }
  // Only a number/formula mismatch needs the "check against the file" warning.
  // A structural miss (heading level, stray table) is fixed or harmless and
  // must not tell the student their notes are untrustworthy.
  if (meta.fidelityFailed) {
    notices.push(
      "> Some numbers could not be matched to your original. Check against the file.",
    );
  }
  const withNotices = notices.length ? `${notices.join("\n\n")}\n\n${body}` : body;

  meta.stageReached = "ready";
  return {
    body: withNotices.slice(0, notePipeline.bodyMaxChars),
    transcript: source.transcript,
    meta,
  };
}

/**
 * Convenience wrapper used by the eval harness and any caller that wants the
 * whole run in one call.
 */
export async function runNotePipeline({ note, kind, courseContext, deps, onPrepared }) {
  const prepared = await prepareMaterial({ note, kind, courseContext, deps });
  if (onPrepared && (await onPrepared(prepared))) return null;
  const written = await writeNote({ prepared, kind, courseContext });
  return { ...written, sourceHashInput: prepared.sourceHashInput };
}
