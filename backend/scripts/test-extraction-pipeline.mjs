import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  MAX_TEXT_CHARS,
  extractDocument,
  extractDocumentText,
  toBuffer,
} from "../src/lib/extract.js";

console.log("=== Running Document Extraction Test Suite ===");

// 1. TXT extraction with UTF-8 and BOM
{
  const textWithBom = "\uFEFFHello World, this is a plain text file for university students.";
  const buf = Buffer.from(textWithBom, "utf8");
  const result = await extractDocumentText(buf, "txt", "document");
  assert.equal(result, "Hello World, this is a plain text file for university students.");
  console.log("✓ 1. TXT extraction strips BOM and extracts UTF-8 text correctly");
}

// 2. Markdown extraction
{
  const mdText = "# Biology 101\n\n## Cellular Respiration\n- Glycolysis\n- Krebs Cycle\n- ETC";
  const buf = Buffer.from(mdText, "utf8");
  const result = await extractDocumentText(buf, "md", "document");
  assert.ok(result.includes("Cellular Respiration"));
  assert.ok(result.includes("Glycolysis"));
  console.log("✓ 2. Markdown extraction preserves document text correctly");
}

// 3. DOCX extraction
{
  const zip = new JSZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Introduction to Computer Systems</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chapter 1: Hardware Abstraction Layer</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  zip.file("word/document.xml", documentXml);
  const docxBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const result = await extractDocumentText(docxBuffer, "docx", "document");
  assert.ok(result.includes("Introduction to Computer Systems"));
  assert.ok(result.includes("Hardware Abstraction Layer"));
  console.log("✓ 3. DOCX extraction reads paragraphs and text correctly");
}

// 4. PPTX extraction
{
  const zip = new JSZip();
  const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Lecture 1: Microeconomics Principles</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
  const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Supply and Demand Curves</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
  zip.file("ppt/slides/slide1.xml", slide1Xml);
  zip.file("ppt/slides/slide2.xml", slide2Xml);
  const pptxBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const doc = await extractDocument(pptxBuffer, "pptx", "document");
  assert.equal(doc.pageCount, 2);
  assert.ok(doc.text.includes("Microeconomics Principles"));
  assert.ok(doc.text.includes("Supply and Demand Curves"));
  console.log("✓ 4. PPTX extraction preserves slide numbering and text correctly");
}

// 5. Legacy PPT files handled as unsupported without crashing
{
  const fakePptBuffer = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01]);
  const result = await extractDocumentText(fakePptBuffer, "ppt", "document");
  assert.equal(result, null);
  console.log("✓ 5. Legacy .ppt returns null gracefully without crashing");
}

// 6. Extraction results clamped to 100,000 characters
{
  const longContent = "A".repeat(120_000);
  const buf = Buffer.from(longContent, "utf8");
  const result = await extractDocumentText(buf, "txt", "document");
  assert.equal(result.length, MAX_TEXT_CHARS);
  assert.equal(result.length, 100_000);

  const doc = await extractDocument(buf, "txt", "document");
  assert.equal(doc.truncated, true);
  assert.equal(doc.text.length, 100_000);
  console.log("✓ 6. Extraction result is strictly clamped to 100,000 characters with truncated=true");
}

// 7. Empty or whitespace-only extraction results return null
{
  const emptyBuf = Buffer.alloc(0);
  const emptyResult = await extractDocumentText(emptyBuf, "txt", "document");
  assert.equal(emptyResult, null);

  const whitespaceBuf = Buffer.from("   \n\n\t  \r\n   ", "utf8");
  const whitespaceResult = await extractDocumentText(whitespaceBuf, "txt", "document");
  assert.equal(whitespaceResult, null);
  console.log("✓ 7. Empty and whitespace-only content safely return null");
}

// 8. Corrupted documents return null rather than throwing
{
  const garbageBuf = Buffer.from("Not a real docx or zip file header", "utf8");
  const docxCorrupted = await extractDocumentText(garbageBuf, "docx", "document");
  assert.equal(docxCorrupted, null);

  const pptxCorrupted = await extractDocumentText(garbageBuf, "pptx", "document");
  assert.equal(pptxCorrupted, null);

  const pdfCorrupted = Buffer.from("%PDF-1.4\ncorrupted stream content without xref", "utf8");
  const pdfResult = await extractDocumentText(pdfCorrupted, "pdf", "document");
  assert.equal(pdfResult, null);
  console.log("✓ 8. Corrupted documents return null without throwing unhandled exceptions");
}

// 9. toBuffer helper accepts Buffer, Uint8Array, and Streams
{
  const b = Buffer.from("Stream test", "utf8");
  const fromBuf = await toBuffer(b);
  assert.ok(Buffer.isBuffer(fromBuf));
  assert.equal(fromBuf.toString("utf8"), "Stream test");

  const u8 = new Uint8Array([72, 105]); // "Hi"
  const fromU8 = await toBuffer(u8);
  assert.equal(fromU8.toString("utf8"), "Hi");

  async function* makeStream() {
    yield Buffer.from("Hello ");
    yield Buffer.from("World");
  }
  const fromStream = await toBuffer(makeStream());
  assert.equal(fromStream.toString("utf8"), "Hello World");
  console.log("✓ 9. toBuffer handles Buffer, Uint8Array, and AsyncIterable streams");
}

// 10. Non-document kind returns null
{
  const buf = Buffer.from("This is an image placeholder", "utf8");
  const result = await extractDocument(buf, "png", "image");
  assert.equal(result, null);
  console.log("✓ 10. Non-document kinds return null from extractDocument");
}

console.log("\n=== ALL EXTRACTION TESTS PASSED! ===");
