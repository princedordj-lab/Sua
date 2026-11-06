/**
 * Dedicated Document Normalization Layer.
 *
 * Normalizes output from all extractors (PDF, DOCX, PPTX, TXT, MD, images, audio).
 * Enforces predictable structures, safe defaults, defensive array processing,
 * structure preservation (headings, page/slide references), clean whitespace,
 * word/character counting, content limit enforcement, and explicit validation errors.
 */

export class ExtractionValidationError extends Error {
  constructor(message, { code = "INVALID_EXTRACT_OUTPUT", safeMessage = null } = {}) {
    super(message);
    this.name = "ExtractionValidationError";
    this.code = code;
    this.safeMessage = safeMessage ?? "There isn't enough readable text in this file to study.";
  }
}

/**
 * Defensive array wrapper: guarantees an array is returned.
 * Prevents "Cannot read properties of undefined (reading 'map')".
 */
export function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Accurately counts whitespace-delimited words in text.
 */
export function countWords(text) {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Strips non-printable ASCII control characters while preserving newlines and tabs.
 */
function stripControlCharacters(text) {
  if (typeof text !== "string") return "";
  // Keep \t (0x09), \n (0x0A), \r (0x0D); strip others in 0x00-0x1F and 0x7F
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Normalizes unicode whitespace (non-breaking spaces, zero-width spaces, special line breaks).
 */
function normalizeUnicodeWhitespace(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "") // zero-width
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * Collapses multiple consecutive blank lines down to a maximum of two newlines (single blank line),
 * and trims trailing whitespace on individual lines while preserving indentations for code/lists.
 */
export function cleanWhitespace(text) {
  if (typeof text !== "string") return "";
  const cleaned = normalizeUnicodeWhitespace(stripControlCharacters(text));
  return cleaned
    .split("\n")
    .map((line) => {
      // Trim trailing spaces
      const noTrailing = line.replace(/[ \t]+$/, "");
      // Collapse multiple consecutive spaces/tabs within line body while preserving leading indentation
      const match = noTrailing.match(/^([ \t]*)(.*)$/);
      if (match) {
        const indent = match[1];
        const body = match[2].replace(/[ \t]{2,}/g, " ");
        return indent + body;
      }
      return noTrailing;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ newlines to 2
    .trim();
}

/**
 * Validates raw extractor output.
 * Throws ExtractionValidationError if output is null, undefined, or lacks content.
 */
export function validateExtractorOutput(raw) {
  if (raw === null || raw === undefined) {
    throw new ExtractionValidationError("Extractor output is null or undefined", {
      code: "UNDEFINED_OUTPUT",
    });
  }
  if (typeof raw !== "object") {
    throw new ExtractionValidationError("Extractor output must be an object", {
      code: "MALFORMED_OUTPUT",
    });
  }

  const rawSegments = asArray(raw.segments ?? raw.pages ?? raw.sections ?? raw.blocks);
  const rawText = typeof raw.text === "string" ? raw.text.trim() : "";

  // Check if any segment has usable text
  const hasSegmentText = rawSegments.some((s) => {
    if (!s || typeof s !== "object") return false;
    const txt = typeof s.text === "string" ? s.text.trim() : (typeof s.markdown === "string" ? s.markdown.trim() : "");
    return txt.length > 0;
  });

  if (!hasSegmentText && !rawText) {
    throw new ExtractionValidationError("Extracted document has no readable text", {
      code: "EMPTY_DOCUMENT",
    });
  }

  return { rawSegments, rawText };
}

/**
 * Normalizes a single segment/page/slide/section.
 */
export function normalizeSegment(segment, fallbackIndex = 1) {
  if (!segment || typeof segment !== "object") {
    return null;
  }

  const index = Number.isInteger(segment.index) ? segment.index : fallbackIndex;
  const rawText = typeof segment.text === "string" ? segment.text : (typeof segment.markdown === "string" ? segment.markdown : "");
  const text = cleanWhitespace(rawText);

  // Preserve meaningful label ("p. 4", "Slide 2", "Section 1")
  let label = null;
  if (typeof segment.label === "string" && segment.label.trim()) {
    label = segment.label.trim();
  } else if (Number.isInteger(segment.page)) {
    label = `p. ${segment.page}`;
  } else if (Number.isInteger(segment.slide)) {
    label = `Slide ${segment.slide}`;
  }

  // Preserve headings if specified
  const heading = typeof segment.heading === "string" ? segment.heading.trim() : null;

  const charCount = text.length;
  const wordCount = countWords(text);

  return {
    index,
    label,
    heading,
    startPage: segment.startPage ?? (Number.isInteger(segment.page) ? segment.page : null),
    endPage: segment.endPage ?? (Number.isInteger(segment.page) ? segment.page : null),
    text,
    charCount,
    wordCount,
  };
}

/**
 * Filters out running headers and footers that repeat across 3 or more segments,
 * avoiding destructive removal of real content with a safety floor.
 */
export function cleanRunningHeadersAndFooters(segments, { headerFooterRatio = 0.6, minCharsFloor = 30 } = {}) {
  const safeSegments = asArray(segments).filter(Boolean);
  if (safeSegments.length < 3) return safeSegments;

  const lineCounts = new Map();
  for (const segment of safeSegments) {
    const seenOnThisSegment = new Set();
    const lines = segment.text.split("\n");
    for (const line of lines) {
      const key = line.trim().toLowerCase();
      // Only check candidate lines between 3 and 120 chars that aren't markdown headings or list markers
      if (key.length < 3 || key.length > 120 || key.startsWith("#") || key.startsWith("-") || key.startsWith("*")) {
        continue;
      }
      if (seenOnThisSegment.has(key)) continue;
      seenOnThisSegment.add(key);
      lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
    }
  }

  const threshold = safeSegments.length * headerFooterRatio;
  const repeatedLines = new Set(
    [...lineCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([line]) => line),
  );

  if (!repeatedLines.size) return safeSegments;

  return safeSegments.map((segment) => {
    const originalText = segment.text;
    const filteredLines = originalText
      .split("\n")
      .filter((line) => !repeatedLines.has(line.trim().toLowerCase()))
      .join("\n")
      .trim();

    // Do not destructively remove content below minCharsFloor if the original had content
    const floor = Math.min(minCharsFloor, originalText.length);
    const text = filteredLines.length >= floor ? filteredLines : originalText;

    return {
      ...segment,
      text,
      charCount: text.length,
      wordCount: countWords(text),
    };
  });
}

/**
 * Assembles normalized segments into consistent, AI-ready Markdown text
 * with clear segment references (e.g. `[p. 1]` or `[Slide 2]`).
 */
export function formatAiReadyText(segments) {
  const safeSegments = asArray(segments).filter((s) => s && s.text);
  if (!safeSegments.length) return "";

  return safeSegments
    .map((seg) => {
      const parts = [];
      if (seg.label) {
        parts.push(`[${seg.label}]`);
      }
      if (seg.heading) {
        parts.push(`## ${seg.heading}`);
      }
      parts.push(seg.text);
      return parts.join("\n\n");
    })
    .join("\n\n");
}

/**
 * Main normalization pipeline entry point:
 * Validates, normalizes, removes running artifacts, enforces max character limit cleanly,
 * and formats AI-ready content.
 */
export function normalizeDocument(raw, options = {}) {
  const {
    maxChars = 120_000,
    filterHeadersFooters = true,
    headerFooterRatio = 0.6,
    minCharsFloor = 30,
  } = options;

  // 1. Validate
  const { rawSegments, rawText } = validateExtractorOutput(raw);

  // 2. Normalize segments
  let segments = [];
  if (rawSegments.length > 0) {
    segments = rawSegments
      .map((seg, idx) => normalizeSegment(seg, idx + 1))
      .filter((s) => s !== null && s.charCount > 0);
  } else if (rawText) {
    const cleaned = cleanWhitespace(rawText);
    if (cleaned.length > 0) {
      segments = [
        {
          index: 1,
          label: null,
          heading: null,
          startPage: 1,
          endPage: 1,
          text: cleaned,
          charCount: cleaned.length,
          wordCount: countWords(cleaned),
        },
      ];
    }
  }

  if (!segments.length) {
    throw new ExtractionValidationError("No readable text remained after normalization", {
      code: "EMPTY_DOCUMENT",
    });
  }

  // 3. Filter running headers & footers
  if (filterHeadersFooters && segments.length >= 3) {
    segments = cleanRunningHeadersAndFooters(segments, { headerFooterRatio, minCharsFloor });
  }

  // 4. Calculate metrics and enforce content limits
  let totalChars = 0;
  let totalWords = 0;
  let truncated = false;
  const boundedSegments = [];

  for (const seg of segments) {
    if (totalChars + seg.charCount <= maxChars) {
      boundedSegments.push(seg);
      totalChars += seg.charCount;
      totalWords += seg.wordCount;
    } else {
      truncated = true;
      const room = maxChars - totalChars;
      if (room > 50) {
        // Truncate cleanly at a sentence or word boundary if possible
        let partialText = seg.text.slice(0, room);
        const lastPeriod = partialText.lastIndexOf(". ");
        const lastNewline = partialText.lastIndexOf("\n");
        const cutPoint = Math.max(lastPeriod, lastNewline);
        if (cutPoint > room * 0.7) {
          partialText = partialText.slice(0, cutPoint + 1);
        }
        partialText = partialText.trim();
        if (partialText) {
          const partialWordCount = countWords(partialText);
          boundedSegments.push({
            ...seg,
            text: partialText,
            charCount: partialText.length,
            wordCount: partialWordCount,
          });
          totalChars += partialText.length;
          totalWords += partialWordCount;
        }
      }
      break;
    }
  }

  const aiReadyText = formatAiReadyText(boundedSegments);

  return {
    ok: true,
    segments: boundedSegments,
    aiReadyText,
    pageCount: segments.length,
    totalWords,
    totalChars,
    truncated,
  };
}
