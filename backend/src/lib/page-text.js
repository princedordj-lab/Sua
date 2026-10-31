/**
 * Page-text normalization and quality classification.
 *
 * This module is deliberately dependency-free (no canvas, no pdf-parse): both
 * the Node extractor (lib/extract.js) and the note pipeline (which must stay
 * bundlable for environments that cannot load a native binary) classify pages
 * with exactly the same rules.
 */

// PDF typesetting uses "wide" spaces (NBSP, thin/hair spaces, ideographic
// space); they carry no meaning the student needs, so they become plain spaces.
const WIDE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Conservative whitespace normalization for one page of embedded PDF text.
 *
 * Line breaks are load-bearing — headings, bullet lists, formulas and worked
 * examples all depend on them — so they are preserved as written. Only
 * whitespace that is invisible in the rendered page is touched: trailing
 * spaces before a line break, runs of blank lines, CRLF and wide spaces.
 */
export function normalizePageText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(WIDE_SPACES, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Glyph-level junk a broken ToUnicode map produces: `(cid:123)` placeholders,
// private-use code points, replacement characters and stray control bytes.
const CID_RE = /\(\s*cid:\s*\d+\s*\)/gi;
const GARBLED_CHAR_RE = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/gu;
const LETTER_WORD_RE = /\p{L}{2,}/gu;

/**
 * Decide whether a page's locally extracted text is worth keeping.
 *
 * A page is usable when it carries real words — even a short one: a title
 * page, a section divider, a two-line worked example. It is *not* usable when
 * the text layer is missing, holds only layout noise (page numbers, bullets,
 * stray digits) or is glyph garbage; those are the only pages the model
 * fallback may read. Treating every short page as a failure is what made the
 * old extractor OCR ordinary text PDFs.
 *
 * `minChars` is the long-document OCR threshold: below it a page still counts
 * as content as long as it reads as words.
 *
 * Returns `{ text, usable, reason, chars, words }`; `text` is the normalized
 * form callers should store.
 */
export function classifyPageText(value, { minChars = 40 } = {}) {
  const text = normalizePageText(value);
  const chars = text.length;
  if (!chars) return { text, usable: false, reason: "empty", chars: 0, words: 0 };
  const cidHits = (text.match(CID_RE) ?? []).length * 4;
  const garbled = (text.match(GARBLED_CHAR_RE) ?? []).length + cidHits;
  if (garbled && garbled * 10 >= chars) {
    return { text, usable: false, reason: "garbled", chars, words: 0 };
  }
  const meaningful = (text.match(WORD_CHAR_RE) ?? []).length;
  if (!meaningful) return { text, usable: false, reason: "empty", chars, words: 0 };
  const words = (text.match(LETTER_WORD_RE) ?? []).length;
  if (meaningful < 3 || (!words && chars < minChars)) {
    return { text, usable: false, reason: "sparse", chars, words };
  }
  return { text, usable: true, reason: null, chars, words };
}
