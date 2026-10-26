/**
 * Number and formula check for generated notes.
 *
 * The AI must not invent values. We compare every number in the output against
 * the raw source (never the cleaned copy, so a cleaner that drops a value does
 * not make the output "wrong"), after normalising the differences that carry no
 * meaning: whitespace, thousands separators, unicode minus/dashes and
 * superscript digits.
 *
 * Ignored on both sides: source citations like (Slide 4-6) or (p. 12),
 * timestamps like 12:30 and ordered-list markers.
 */

import { notePipeline } from "../config/ai-pipeline.js";

const SUPERSCRIPT = {
  "\u2070": "0",
  "\u00b9": "1",
  "\u00b2": "2",
  "\u00b3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9",
  "\u207b": "-",
};

const CITATION = /\((?:slides?|pp?\.|about)\s*[^)]*\)/gi;
const TIMESTAMP = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const LIST_MARKER = /^[ \t]*\d+[.)][ \t]+/gm;
const NUMBER = /-?\d+(?:\.\d+)?/g;

export function normaliseForCompare(text) {
  return String(text ?? "")
    .replace(/[\u2070\u00b9\u00b2\u00b3\u2074-\u2079\u207b]/g, (digit) => SUPERSCRIPT[digit] ?? digit)
    .replace(/[\u2212\u2013\u2014]/g, "-")
    // 1,250 -> 1250 (only true thousands groups)
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutIgnored(text) {
  return normaliseForCompare(text)
    .replace(CITATION, " ")
    .replace(TIMESTAMP, " ")
    .replace(LIST_MARKER, " ");
}

export function canonicalNumber(raw) {
  const value = String(raw).replace(/,/g, "");
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return value;
  const [, sign, whole, fraction] = match;
  const wholeClean = whole.replace(/^0+(?=\d)/, "");
  const fractionClean = fraction ? fraction.replace(/0+$/, "") : "";
  return `${sign}${wholeClean}${fractionClean ? `.${fractionClean}` : ""}`;
}

function numberSet(text) {
  const set = new Set();
  for (const match of withoutIgnored(text).matchAll(NUMBER)) {
    set.add(canonicalNumber(match[0]));
  }
  return set;
}

function inlineFormulas(text) {
  const formulas = [];
  for (const match of String(text ?? "").matchAll(/`([^`\n]+)`/g)) {
    const body = match[1].trim();
    if (!body || body.length < 3) continue;
    // Prose in backticks (a term, a file name) is not a formula.
    if (!/[=+×÷^]/.test(body) && !/\d/.test(body)) continue;
    formulas.push(body);
  }
  return formulas;
}

function compact(text) {
  return normaliseForCompare(text).replace(/\s+/g, "").toLowerCase();
}

/**
 * A formula counts as supported when it appears in the source, or when the
 * right-hand side does. Models rename the subject symbol between runs ("W" for
 * the "work = ..." in the student's notes), and the right-hand side is what
 * carries the content; the left side is a label, not a value.
 */
function formulaSupported(formula, sourceCompact) {
  const whole = compact(formula);
  if (sourceCompact.includes(whole)) return true;
  const [, ...rest] = String(formula).split("=");
  if (!rest.length) return false;
  const right = compact(rest.join("="));
  return right.length >= 4 && sourceCompact.includes(right);
}

/**
 * @returns {{ unsupportedNumbers: string[], unsupportedFormulas: string[],
 *             totalNumbers: number, failed: boolean, ratio: number }}
 * `allow` is extra text that may legitimately appear in the output without
 * appearing in the source — the course name/code we put in the prompt, which
 * the model may put in a heading.
 */
export function checkSourceFidelity({
  source,
  output,
  allow = "",
  maxUnsupported = notePipeline.maxUnsupportedNumbers,
}) {
  const sourceNumbers = numberSet(`${source}\n${allow}`);
  const outputNumbers = numberSet(output);
  const unsupportedNumbers = [];
  for (const value of outputNumbers) {
    if (!sourceNumbers.has(value)) unsupportedNumbers.push(value);
  }

  const sourceCompact = compact(source);
  const unsupportedFormulas = inlineFormulas(output).filter(
    (formula) => !formulaSupported(formula, sourceCompact),
  );

  const totalNumbers = outputNumbers.size;
  const ratio = totalNumbers ? unsupportedNumbers.length / totalNumbers : 0;
  const failed =
    unsupportedNumbers.length > maxUnsupported ||
    (totalNumbers >= 10 && ratio > 0.1);

  return {
    unsupportedNumbers: unsupportedNumbers.slice(0, 50),
    unsupportedFormulas: unsupportedFormulas.slice(0, 10),
    totalNumbers,
    failed,
    ratio,
  };
}
