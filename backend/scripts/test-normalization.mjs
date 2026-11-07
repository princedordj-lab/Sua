import assert from "node:assert/strict";
import {
  ExtractionValidationError,
  asArray,
  cleanRunningHeadersAndFooters,
  cleanWhitespace,
  countWords,
  formatAiReadyText,
  normalizeDocument,
  normalizeSegment,
  validateExtractorOutput,
} from "../src/lib/normalization.js";
import { prepareMaterial } from "../src/lib/note-pipeline.js";
import { classifyFailure } from "../src/lib/processing/errors.js";

console.log("=== Running Normalization Test Suite ===");

// 1. Undefined and null extractor output
{
  assert.throws(
    () => validateExtractorOutput(undefined),
    (err) => err instanceof ExtractionValidationError && err.code === "UNDEFINED_OUTPUT",
  );
  assert.throws(
    () => validateExtractorOutput(null),
    (err) => err instanceof ExtractionValidationError && err.code === "UNDEFINED_OUTPUT",
  );
  assert.throws(
    () => normalizeDocument(null),
    (err) => err instanceof ExtractionValidationError && err.code === "UNDEFINED_OUTPUT",
  );
  console.log("✓ 1. Undefined and null extractor outputs produce ExtractionValidationError");
}

// 2. Missing sections/segments array and empty structures
{
  assert.throws(
    () => normalizeDocument({}),
    (err) => err instanceof ExtractionValidationError && err.code === "EMPTY_DOCUMENT",
  );
  assert.throws(
    () => normalizeDocument({ segments: [] }),
    (err) => err instanceof ExtractionValidationError && err.code === "EMPTY_DOCUMENT",
  );
  assert.throws(
    () => normalizeDocument({ sections: [], pages: [], blocks: [] }),
    (err) => err instanceof ExtractionValidationError && err.code === "EMPTY_DOCUMENT",
  );
  console.log("✓ 2. Missing or empty sections arrays produce explicit EMPTY_DOCUMENT error");
}

// 2b. An empty preferred field must not hide a populated fallback field
{
  const result = normalizeDocument({
    segments: [],
    pages: [
      { page: 7, text: "A populated fallback page with enough readable lecture content." },
    ],
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].label, "p. 7");
  console.log("✓ 2b. Empty segments fall back to populated pages");
}

// 3. Null or malformed section content handling
{
  const input = {
    segments: [
      null,
      undefined,
      { text: null },
      { text: "" },
      { text: "   " },
      { text: "Valid first section with actual university study material." },
      { markdown: "Valid second section from native reader." },
    ],
  };

  const result = normalizeDocument(input);
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 2, "Null and empty segments are cleanly filtered out");
  assert.equal(result.segments[0].text, "Valid first section with actual university study material.");
  assert.equal(result.segments[1].text, "Valid second section from native reader.");
  console.log("✓ 3. Null, undefined, and empty segment contents are safely handled without throwing");
}

// 4. Duplicate whitespace and control characters removal
{
  const messyText = "Introduction\r\n\r\n\r\n\r\n\t\tto   Computer\u00A0Science\x00\x07.\n\n\nNext paragraph with normal spacing.";
  const cleaned = cleanWhitespace(messyText);
  assert.ok(!cleaned.includes("\r"), "Carriage returns converted");
  assert.ok(!cleaned.includes("\x00"), "Null byte stripped");
  assert.ok(!cleaned.includes("\n\n\n"), "Excessive newlines collapsed");
  assert.ok(!cleaned.includes("\u00A0"), "NBSP converted to standard space");
  assert.match(cleaned, /Introduction\n\n\s*to Computer Science\./);
  console.log("✓ 4. Duplicate whitespace, unicode spaces, and control characters cleanly stripped");
}

// 5. Preservation of page and slide references
{
  const input = {
    segments: [
      { page: 1, text: "Lecture title and syllabus outline." },
      { label: "p. 2", text: "Chapter 1: Definitions and core concepts." },
      { slide: 3, text: "Slide 3: Architectural diagrams and formulas." },
      { label: "Custom Section A", text: "Summary notes on computational complexity." },
    ],
  };

  const result = normalizeDocument(input);
  assert.equal(result.segments[0].label, "p. 1");
  assert.equal(result.segments[1].label, "p. 2");
  assert.equal(result.segments[2].label, "Slide 3");
  assert.equal(result.segments[3].label, "Custom Section A");

  assert.ok(result.aiReadyText.includes("[p. 1]"));
  assert.ok(result.aiReadyText.includes("[p. 2]"));
  assert.ok(result.aiReadyText.includes("[Slide 3]"));
  assert.ok(result.aiReadyText.includes("[Custom Section A]"));
  console.log("✓ 5. Page, slide, and custom section references are preserved accurately");
}

// 6. Preservation of Markdown headings and structure
{
  const markdownContent = {
    segments: [
      {
        page: 1,
        text: "# Advanced Algorithms\n\n## Dynamic Programming\n\nKey recurrence relation:\n- `OPT(i) = max(...)`\n\n```python\ndef solve():\n    return 42\n```",
      },
    ],
  };

  const result = normalizeDocument(markdownContent);
  assert.ok(result.aiReadyText.includes("# Advanced Algorithms"));
  assert.ok(result.aiReadyText.includes("## Dynamic Programming"));
  assert.ok(result.aiReadyText.includes("```python\ndef solve():"));
  console.log("✓ 6. Markdown headings, code blocks, and list formatting are preserved");
}

// 7. Repeated headers/footers removal without destructive content loss
{
  const multiPageDoc = {
    segments: [
      { page: 1, text: "University of Ghana - Department of CS\nLecture 1: Introduction\nThis is unique content on page 1." },
      { page: 2, text: "University of Ghana - Department of CS\nLecture 1: Introduction\nThis is unique content on page 2." },
      { page: 3, text: "University of Ghana - Department of CS\nLecture 1: Introduction\nThis is unique content on page 3." },
      { page: 4, text: "University of Ghana - Department of CS\nLecture 1: Introduction\nThis is unique content on page 4." },
    ],
  };

  const result = normalizeDocument(multiPageDoc);
  for (const seg of result.segments) {
    assert.ok(!seg.text.includes("University of Ghana - Department of CS"), "Running header removed");
    assert.ok(!seg.text.includes("Lecture 1: Introduction"), "Repeated course header removed");
    assert.ok(seg.text.includes("This is unique content on page"), "Unique content preserved");
  }
  console.log("✓ 7. Repeated headers/footers across pages are filtered out while preserving real content");
}

// 8. Large extracted documents and character-limit enforcement
{
  const longParagraph = "The quick brown fox jumps over the lazy dog in this extensive university lecture. ".repeat(50);
  const segments = Array.from({ length: 50 }, (_, i) => ({
    page: i + 1,
    text: `Page ${i + 1} content: ${longParagraph}`,
  }));

  const maxChars = 5_000;
  const result = normalizeDocument({ segments }, { maxChars });
  assert.equal(result.truncated, true, "Truncation flag set");
  assert.ok(result.totalChars <= maxChars, `Total characters (${result.totalChars}) must not exceed maxChars (${maxChars})`);
  assert.ok(result.segments.length > 0 && result.segments.length < 50, "Only segments within budget are included");
  assert.ok(result.totalWords > 0, "Word count is computed");
  console.log("✓ 8. Character limit is strictly enforced with truncated=true and clean bounds");
}

// 9. Defensive asArray helper prevents unchecked .map crashes
{
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray([]), []);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray("single item"), ["single item"]);
  console.log("✓ 9. asArray guarantees safe array iterations without unchecked .map exceptions");
}

// 10. Accurate word counting
{
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords("One two three four five"), 5);
  assert.equal(countWords("  Leading   and   trailing   spaces  with\nnewlines  "), 6);
  console.log("✓ 10. Word counting accurately calculates words across arbitrary whitespace");
}

// 11. The real note-preparation path uses the shared normalizer
{
  const pages = Array.from({ length: 4 }, (_, index) => ({
    index: index + 1,
    label: `p. ${index + 1}`,
    text:
      "University of Ghana - Department of Engineering\n" +
      `Unique lecture content for page ${index + 1}, including definitions and worked examples.\n` +
      "This is enough meaningful content to survive the header filter.",
  }));
  const prepared = await prepareMaterial({
    note: { assets: [], body: "", transcript: "" },
    kind: "lecture_note",
    courseContext: "Engineering",
    deps: {},
    source: {
      sourceType: "file",
      segments: pages,
      pageCount: 4,
      truncated: false,
      minutes: 0,
    },
  });

  assert.equal(prepared.source.segments.length, 4);
  assert.ok(!prepared.source.rawText.includes("University of Ghana - Department of Engineering"));
  assert.ok(prepared.material.includes("## p. 1"));
  assert.ok(prepared.meta.sourceWords > 0);
  console.log("✓ 11. prepareMaterial uses shared normalization and preserves page labels");
}

// 12. Malformed extractor structures become a permanent, student-safe failure
{
  await assert.rejects(
    () =>
      prepareMaterial({
        note: { assets: [], body: "", transcript: "" },
        kind: "lecture_note",
        courseContext: "",
        deps: {},
        source: { sourceType: "file", segments: [null], pageCount: 1 },
      }),
    (error) =>
      error.userFacing === true &&
      classifyFailure(error).category === "permanent" &&
      classifyFailure(error).code === "UNUSABLE_SOURCE",
  );
  console.log("✓ 12. malformed normalized source is surfaced as a permanent safe failure");
}

console.log("\n=== ALL NORMALIZATION TESTS PASSED! ===");
