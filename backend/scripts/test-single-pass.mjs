/**
 * Single-pass routing checks.
 *
 *   cd backend && npm run test:single-pass
 *
 * No database, no network: these are the two places where a source used to be
 * quietly shortened before the AI saw it.
 *
 *   1. singlePassSource — the shortcut a document takes when its whole text
 *      fits one generation call. It must carry the student's typed context, and
 *      it must step aside (return null) once the combined source is too big for
 *      the shortcut.
 *   2. condenseMaterial — the study-set input. Above the cap every chunk must be
 *      digested (nothing dropped); below it the text must be passed through
 *      untouched with no model call at all.
 */

import assert from "node:assert/strict";
import { singlePassSource } from "../src/lib/pipeline.js";
import { condenseMaterial } from "../src/lib/note-pipeline.js";
import { notePipeline } from "../src/config/ai-pipeline.js";

const cap = notePipeline.shortSourceChars;
const studyCap = notePipeline.studySetSourceChars;

console.log("=== Single-pass routing checks ===");

function documentNote(extra = {}) {
  return {
    id: "note-1",
    body: "",
    transcript: "",
    assets: [
      {
        id: "asset-1",
        kind: "document",
        status: "active",
        publicId: "file-1",
        truncated: false,
      },
    ],
    ...extra,
  };
}

const row = (index, text) => ({
  index,
  label: `p. ${index}`,
  text,
  startPage: index,
  endPage: index,
  status: "done",
});

// ---------------------------------------------------------------------------
// 1. A plain document: rows become the source, nothing else
// ---------------------------------------------------------------------------
{
  const source = singlePassSource(documentNote(), {
    rows: [row(1, "Thermodynamics is the study of energy."), row(2, "The first law: dU = Q - W.")],
  });
  assert.ok(source, "a small document qualifies");
  assert.equal(source.sourceType, "file");
  assert.equal(source.pageCount, 2);
  assert.ok(source.rawText.includes("Thermodynamics is the study of energy."));
  assert.ok(source.rawText.includes("The first law: dU = Q - W."));
  console.log("✓ 1. Document rows become the single-pass source");
}

// ---------------------------------------------------------------------------
// 2. Typed context around an upload is part of the source
// ---------------------------------------------------------------------------
{
  const source = singlePassSource(
    documentNote({ body: "My tutor said the exam always asks about the first law." }),
    { rows: [row(1, "The first law: dU = Q - W.")] },
  );
  assert.ok(source, "still one pass");
  assert.ok(
    source.rawText.includes("My tutor said the exam always asks about the first law."),
    "the typed body must reach the writer",
  );
  assert.ok(source.rawText.includes("The first law: dU = Q - W."));
  assert.equal(source.pageCount, 1, "the typed block is not a page");
  console.log("✓ 2. A file note's typed context is not dropped from the single pass");
}

// ---------------------------------------------------------------------------
// 3. Once the pipeline has written a body, the body is not source material
// ---------------------------------------------------------------------------
{
  const source = singlePassSource(
    documentNote({ body: "AI-written summary of the upload.", transcript: "The first law: dU = Q - W." }),
    { rows: [row(1, "The first law: dU = Q - W.")] },
  );
  assert.ok(source);
  assert.ok(
    !source.rawText.includes("AI-written summary of the upload."),
    "a generated body must never feed the next run",
  );
  console.log("✓ 3. An AI-written body is never re-read as source");
}

// ---------------------------------------------------------------------------
// 4. Typed context that pushes the source over the cap steps aside
// ---------------------------------------------------------------------------
{
  const half = "x".repeat(Math.floor(cap * 0.6));
  const source = singlePassSource(documentNote({ body: half }), {
    rows: [row(1, "y".repeat(Math.floor(cap * 0.6)))],
  });
  assert.equal(source, null, "over the cap the long-file path must run instead");
  console.log("✓ 4. A source over SHORT_SOURCE_CHARS returns null");
}

// ---------------------------------------------------------------------------
// 5. Shapes that are never a single pass
// ---------------------------------------------------------------------------
{
  assert.equal(singlePassSource(documentNote(), { rows: [] }), null, "no rows");
  const withImage = documentNote({
    assets: [
      { kind: "document", status: "active", publicId: "file-1", truncated: false },
      { kind: "image", status: "active", publicId: "img-1", truncated: false },
    ],
  });
  assert.equal(singlePassSource(withImage, { rows: [row(1, "text")] }), null, "photos need assembly");
  const pending = documentNote({
    assets: [{ kind: "document", status: "active", publicId: "pending", truncated: false }],
  });
  assert.equal(singlePassSource(pending, { rows: [row(1, "text")] }), null, "a pending upload is not a source");
  console.log("✓ 5. Mixed, pending and empty sources still use the full path");
}

// ---------------------------------------------------------------------------
// 6. Study-set material under the cap: untouched, zero model calls
// ---------------------------------------------------------------------------
{
  let calls = 0;
  const result = await condenseMaterial("A short note about circular motion.", {
    digest: () => {
      calls += 1;
      throw new Error("no digest should run for a short note");
    },
  });
  assert.equal(result.condensed, false);
  assert.equal(result.text, "A short note about circular motion.");
  assert.equal(calls, 0);
  console.log("✓ 6. Short study-set material passes through with no model call");
}

// ---------------------------------------------------------------------------
// 7. Study-set material over the cap: every chunk is digested, nothing dropp
// ---------------------------------------------------------------------------
{
  assert.ok(studyCap > 0, "STUDY_SET_SOURCE_CHARS must be a positive number");
  const sentence = "The examiner marks the direction of the force strictly. ";
  const body = sentence.repeat(Math.ceil((studyCap * 1.3) / sentence.length));
  const tail = "FINAL SENTENCE THAT MUST SURVIVE";
  const material = `${body}${tail}`;
  const seen = [];

  const result = await condenseMaterial(material, {
    sourceType: "file",
    digest: async (chunk, context) => {
      seen.push(chunk.text);
      assert.equal(context.chunkCount > 1, true, "a big material spans several chunks");
      return {
        range: `part ${chunk.index}`,
        topics: [
          {
            heading: `Topic ${chunk.index}`,
            points: [`${chunk.text.length} characters read`],
            terms: [],
            formulas: [],
            examples: [],
            emphasised: [],
          },
        ],
        unclear: [],
      };
    },
  });

  assert.equal(result.condensed, true);
  assert.equal(seen.length, result.chunks, "one digest per chunk");
  assert.ok(seen.length > 1, "the material really was split");
  assert.ok(
    seen.join("").includes(tail),
    "the end of the material reaches a digest — nothing was sliced off",
  );
  assert.ok(result.text.includes("part 1"), "digest output is what the study set reads");
  console.log(`✓ 7. Over the cap: ${seen.length} digests cover the whole material`);
}

console.log("\nAll single-pass routing checks passed.");
