/**
 * Offline checks for the LlamaCloud REST client.
 *
 *   cd backend && npm run test:llamaparse
 *
 * Every request is served by an injected fetch implementation: no API key is
 * used, no network call is made. The tests cover the multipart upload shape,
 * the parse-job payload, response mapping (including failed pages and lagging
 * credits) and the full HTTP error taxonomy.
 */

import assert from "node:assert/strict";
import {
  LlamaParseError,
  createParseJob,
  getParseJob,
  getParseResult,
  uploadToLlamaCloud,
} from "../src/lib/llamaparse.js";

process.env.LLAMA_CLOUD_API_KEY = "test-key";
console.log("=== LlamaParse REST client test suite ===");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return typeof response === "function" ? response(url, options) : response;
  };
  return { calls, fetchImpl };
}

async function expectError(promise, code, retryable) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof LlamaParseError, `expected LlamaParseError, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
}

// 1. Stage A: multipart upload, boundary left to fetch, key in the header.
{
  const { calls, fetchImpl } = recorder(json({ id: "file-1", purpose: "parse" }));
  const result = await uploadToLlamaCloud({
    bytes: Buffer.from("%PDF-1.4"),
    filename: "lecture.pdf",
    mimeType: "application/pdf",
    fetchImpl,
  });

  assert.deepEqual(result, { fileId: "file-1" });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.match(url, /\/api\/v1\/beta\/files$/);
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer test-key");
  assert.equal(options.headers["Content-Type"], undefined, "multipart boundary must be generated");
  assert.ok(options.body instanceof FormData);
  assert.equal(options.body.get("purpose"), "parse");
  const file = options.body.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.name, "lecture.pdf");
  assert.equal(file.type, "application/pdf");
  console.log("✓ 1. Upload sends purpose=parse with a Blob and no manual Content-Type");
}

// 2. Stage B: the v2 parse payload carries tier/version/page cap/table/OCR options.
{
  const { calls, fetchImpl } = recorder(json({ id: "job-1", status: "PENDING" }));
  const result = await createParseJob({
    fileId: "file-1",
    languages: ["en"],
    maxPages: 300,
    fetchImpl,
  });

  assert.deepEqual(result, { jobId: "job-1", status: "PENDING" });
  const { url, options } = calls[0];
  assert.match(url, /\/api\/v2\/parse$/);
  assert.equal(options.headers["Content-Type"], "application/json");
  const payload = JSON.parse(options.body);
  assert.equal(payload.file_id, "file-1");
  assert.equal(payload.tier, "cost_effective");
  assert.equal(payload.version, "latest");
  assert.deepEqual(payload.page_ranges, { max_pages: 300 });
  assert.equal(payload.output_options.markdown.tables.output_tables_as_markdown, true);
  assert.deepEqual(payload.processing_options.ocr_parameters.languages, ["en"]);
  console.log("✓ 2. Create job sends cost_effective + markdown tables + page cap");
}

// 3. Status polling reads job.status and tolerates missing billing data.
{
  const { calls, fetchImpl } = recorder(json({ job: { id: "job-1", status: "RUNNING" } }));
  const result = await getParseJob({ jobId: "job-1", fetchImpl });
  assert.deepEqual(result, {
    jobId: "job-1",
    status: "RUNNING",
    errorMessage: null,
    credits: null,
  });
  assert.match(calls[0].url, /\/api\/v2\/parse\/job-1$/);
  console.log("✓ 3. Poll reads job.status and treats missing credits as null");
}

// 4. Completed result maps page numbers, success flags and billed credits.
{
  const { calls, fetchImpl } = recorder(
    json({
      job: { id: "job-1", status: "COMPLETED", usage: { credits: 8.5 } },
      markdown: {
        pages: [
          { page_number: 1, success: true, markdown: "# Page one" },
          { page_number: 2, success: false, error: "render failed" },
          { page_number: 3, success: true, markdown: "Page three" },
        ],
      },
    }),
  );
  const result = await getParseResult({ jobId: "job-1", fetchImpl });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.credits, 8.5);
  assert.equal(result.pagesFailed, 1);
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.success, page.markdown]),
    [
      [1, true, "# Page one"],
      [2, false, ""],
      [3, true, "Page three"],
    ],
  );
  assert.match(calls[0].url, /expand=markdown,usage/);
  console.log("✓ 4. Result maps pages, failed pages and job.usage.credits");
}

// 5. A non-COMPLETED result returns no pages instead of inventing content.
{
  const { fetchImpl } = recorder(json({ job: { status: "RUNNING" }, markdown: null }));
  const result = await getParseResult({ jobId: "job-1", fetchImpl });
  assert.equal(result.status, "RUNNING");
  assert.deepEqual(result.pages, []);
  assert.equal(result.pagesFailed, 0);
  console.log("✓ 5. Result for a non-terminal job carries no pages");
}

// 6. HTTP error taxonomy: terminal vs retryable.
{
  const cases = [
    [401, "LLAMA_AUTH", false],
    [403, "LLAMA_AUTH", false],
    [402, "LLAMA_QUOTA", false],
    [413, "LLAMA_TOO_LARGE", false],
    [429, "LLAMA_TRANSIENT", true],
    [500, "LLAMA_TRANSIENT", true],
    [400, "LLAMA_BAD_REQUEST", false],
  ];
  for (const [status, code, retryable] of cases) {
    const { fetchImpl } = recorder(new Response("denied", { status }));
    await expectError(getParseJob({ jobId: "job-1", fetchImpl }), code, retryable);
  }
  console.log("✓ 6. 401/402/413/429/5xx/4xx map to the expected codes");
}

// 7. Timeout, network failure, invalid JSON and unknown status.
{
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  await expectError(getParseJob({ jobId: "job-1", fetchImpl: async () => Promise.reject(timeout) }), "LLAMA_TIMEOUT", true);

  const offline = new Error("fetch failed");
  await expectError(getParseJob({ jobId: "job-1", fetchImpl: async () => Promise.reject(offline) }), "LLAMA_TRANSIENT", true);

  await expectError(
    getParseJob({ jobId: "job-1", fetchImpl: async () => new Response("not json", { status: 200 }) }),
    "LLAMA_INVALID_RESPONSE",
    false,
  );

  await expectError(
    getParseJob({ jobId: "job-1", fetchImpl: async () => json({ job: { status: "WHAT" } }) }),
    "LLAMA_INVALID_RESPONSE",
    false,
  );
  console.log("✓ 7. Timeouts, network errors, bad JSON and unknown statuses are classified");
}

console.log("\nAll LlamaParse client checks passed.");
