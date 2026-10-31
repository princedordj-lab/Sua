import assert from "node:assert/strict";
import {
  AiError,
  classifyStatus,
  isAiError,
  parseRetryAfter,
  timeoutForDeadline,
} from "../src/lib/ai.js";

console.log("=== AI error classification checks ===");

const cases = [
  [400, "bad_request", false],
  [401, "auth", false],
  [402, "quota", false],
  [403, "auth", false],
  [408, "timeout", true],
  [413, "too_large", false],
  [429, "rate_limit", true],
  [500, "transient", true],
  [503, "transient", true],
  [418, "bad_request", false],
];
for (const [status, kind, retryable] of cases) {
  const [actualKind, actualRetryable] = classifyStatus(status);
  assert.equal(actualKind, kind, `status ${status} kind`);
  assert.equal(actualRetryable, retryable, `status ${status} retryable`);
}
console.log("✓ statuses map to auth/quota/too_large/rate_limit/transient/bad_request");

assert.equal(parseRetryAfter("12"), 12_000);
assert.equal(parseRetryAfter("0"), 0);
assert.equal(parseRetryAfter(""), null);
assert.equal(parseRetryAfter(null), null);
assert.equal(parseRetryAfter("not a date"), null);
const soon = new Date(Date.now() + 30_000).toUTCString();
const retryAt = parseRetryAfter(soon);
assert.ok(retryAt != null && retryAt > 20_000 && retryAt <= 31_000, "HTTP date Retry-After");
console.log("✓ Retry-After parses seconds and HTTP dates");

assert.equal(timeoutForDeadline(null), 120_000);
assert.equal(timeoutForDeadline(Date.now() + 60_000), 50_000);
assert.equal(timeoutForDeadline(Date.now() + 2_000), 5_000, "floor");
assert.equal(timeoutForDeadline(Date.now() + 10 * 60_000), 120_000, "cap");
console.log("✓ call timeouts are clamped under the runner deadline");

const auth = new AiError("auth", "no key", { status: 401 });
assert.equal(isAiError(auth), true);
assert.equal(isAiError(auth, "auth"), true);
assert.equal(isAiError(auth, "rate_limit"), false);
assert.equal(auth.status, 401);
assert.equal(auth.retryable, false);
console.log("✓ AiError keeps kind, status and retryability");

console.log("\nAll AI error checks passed.");
