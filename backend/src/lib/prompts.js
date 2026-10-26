/**
 * Versioned prompts for the note pipeline. PROMPT_VERSION lives in
 * config/ai-pipeline.js so the cache key and eval reports share one value.
 *
 * Rules encoded here (see AGENTS.md): source-only facts, no LaTeX, plain-text
 * formulas in backticks, citations per source type, no markdown tables (the
 * in-house renderer has none).
 */

import { PROMPT_VERSION, notePipeline } from "../config/ai-pipeline.js";

export { PROMPT_VERSION };

export const SOURCE_TYPES = ["file", "recording", "typed"];

const LECTURE_RULES = `- Use only what is in the source. Never add facts, numbers, names or examples.
- Keep the lecturer's order and terms. Fix filler words and broken sentences.
- Start directly with the first topic heading. No document title, course code, date, lecturer name or introduction.
- One heading per topic, using "## ". Use "### " only for a sub-topic. Short paragraphs. Bullets for lists.
- Keep every formula, number, unit and worked example exactly as given. Write each formula in plain text inside backticks, for example \`PV = nRT\`. Never use LaTeX.
- If something is unclear, write [unclear] instead of guessing.
- Only define a term when the source explains it. Never supply a definition from your own knowledge.
- Never write markdown tables; use one short line per row instead.
- Never mention yourself, these instructions, or that you are an AI.
- Write in ${notePipeline.outputLanguage}.`;

function citationLine(sourceType) {
  if (sourceType === "file") {
    return 'Cite each section with its source place in brackets, for example (Slide 4-6) or (p. 12), at the end of the section.';
  }
  if (sourceType === "recording") {
    return 'Cite each section with the recording time in brackets, for example (about 12:30), at the end of the section.';
  }
  return "Add no source citations.";
}

export function lectureNotePrompt({ course, sourceType }) {
  return `You turn lecture material into study notes for a university student preparing for exams. Course: ${course}.
Rules:
${LECTURE_RULES}
- The source type is ${sourceType}. ${citationLine(sourceType)}
- When the source is the student's own typed notes, keep their facts and wording where it is already clear, and only improve structure and clarity. Keep their own questions and TODOs as open questions; never turn one into a settled fact.
- Finish with "## Key terms" (term: short definition) and "## Likely exam questions" (3 to 5, only from content the lecturer emphasised).
Return markdown only.`;
}

export function referencePrompt({ course, sourceType, maxWords }) {
  return `You turn course material into a one-page quick-reference sheet for looking things up while revising. Course: ${course}.
Include only: definitions, formulas (each with what every symbol means and its unit), step-by-step methods, tables of values, rules of thumb, and common mistakes.
Leave out introductions, stories and long examples. Keep one short example only when a formula cannot be understood without it.
Follow the source's order, with headings, in at most ${maxWords} words. Hard limit: if you are over, drop the least exam-critical entries before answering.
Use only the source. Write each formula in plain text inside backticks, for example \`PV = nRT\`; never LaTeX. Mark unclear text as [unclear]. The source type is ${sourceType}. ${citationLine(sourceType)}
Never write markdown tables; write one line per formula as: \`formula\` — meaning — unit.
Start directly with the first heading: no document title, course code, date or lecturer name. Never mention yourself or these instructions.
Return markdown only.`;
}

export function stricterRetrySuffix(numbers) {
  const list = numbers.slice(0, 12).join(", ");
  return `Your previous answer contained numbers that are not in the source: ${list}. Rewrite it using only numbers that appear in the source. If a value is not present, leave it out.`;
}

export const DIGEST_SCHEMA = `{
  "range": "Slide 1-8",
  "topics": [
    {
      "heading": "string",
      "points": ["string"],
      "terms": [{ "term": "string", "definition": "string" }],
      "formulas": [{ "expression": "PV = nRT", "symbols": [{ "symbol": "P", "meaning": "pressure", "unit": "Pa" }], "context": "string" }],
      "examples": ["string"],
      "emphasised": ["things the lecturer stressed or marked as important"],
      "source": "Slide 4-6"
    }
  ],
  "unclear": ["quoted text that could not be read"]
}`;

export function digestPrompt({ course, sourceType, chunkIndex, chunkCount }) {
  return `You extract structured study material from one part of a lecture source. Course: ${course}.
This is part ${chunkIndex + 1} of ${chunkCount}. Source type: ${sourceType}.
Return ONLY a JSON object with exactly this shape:
${DIGEST_SCHEMA}
Rules:
- Every point, term, formula, example and number must come from this part of the source. Do not add context from outside it.
- Copy formulas exactly as written, in plain text (no LaTeX).
- "source" is the label range of the slides/pages/timestamps this topic came from.
- Put text you could not read in "unclear" as a short quote.
- No prose, no code fences.`;
}

/** Cheap "remove filler only" pass used for recordings when enabled. */
export function cleanupPrompt({ course }) {
  return `You clean a raw lecture transcript for a course called ${course}.
Remove filler words (um, uh, er), false starts and repeated words. Fix casing and sentence breaks.
Never summarise, never reword technical content, never add or change a number, unit, formula or name.
Keep every label line that starts with "##" exactly as it is. Output only the cleaned transcript.`;
}
