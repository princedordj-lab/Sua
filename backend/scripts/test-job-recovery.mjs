import assert from "node:assert/strict";
import {
  clampDelay,
  errorCodeFor,
  isBudgetYield,
  nextYieldState,
  progressSignal,
  shouldContinueInInvocation,
  yieldDelayMs,
  YIELD_DEFAULTS,
} from "../src/lib/job-recovery.js";
import { JobYieldError, UserFacingError } from "../src/config/ai-pipeline.js";

console.log("=== Job recovery checks ===");

const advancing = nextYieldState(
  { runtimeMs: 10_000, yields: 1, stalled: 1, signal: 5 },
  { signal: 9, elapsedMs: 30_000 },
);
assert.equal(advancing.runtimeMs, 40_000);
assert.equal(advancing.yields, 2);
assert.equal(advancing.stalled, 0, "new work clears the stall counter");
assert.equal(advancing.fail, null);
console.log("✓ progress clears the stall counter");

let state = { signal: 7 };
for (let index = 0; index < 3; index += 1) {
  state = nextYieldState(state, { signal: 7, elapsedMs: 1_000 });
}
assert.equal(state.stalled, 3);
assert.equal(state.fail, "stalled", "three silent yields fail the job");
console.log("✓ repeated no-progress yields stop the loop");

const runtime = nextYieldState(
  { runtimeMs: YIELD_DEFAULTS.maxRuntimeMs - 1_000, yields: 2, stalled: 0, signal: 1 },
  { signal: 2, elapsedMs: 5_000 },
);
assert.equal(runtime.fail, "runtime");
console.log("✓ active-time cap is cumulative across passes");

const yields = nextYieldState(
  { runtimeMs: 0, yields: YIELD_DEFAULTS.maxYields - 1, stalled: 0, signal: 1 },
  { signal: 2, elapsedMs: 1 },
);
assert.equal(yields.fail, "yields");
console.log("✓ total-yield cap is enforced");

assert.equal(progressSignal({ progressDone: 4, checkpoint: { digests: { a: 1, b: 2 }, reduce: { c: 3 } } }), 7);
assert.equal(progressSignal({}), 0);
console.log("✓ progress signal counts digests and reduce waves");

assert.equal(clampDelay(5_000), YIELD_DEFAULTS.minRateLimitDelayMs);
assert.equal(clampDelay(20 * 60_000), YIELD_DEFAULTS.maxRateLimitDelayMs);
assert.equal(yieldDelayMs({ reason: "rate_limit", retryAfterMs: 60_000 }, () => 0), 60_000);
assert.equal(yieldDelayMs({ stage: "merging" }, () => 0), 2_000);
console.log("✓ rate-limit delays are bounded and normal yields resume quickly");

// --- A budget yield may continue in the same invocation -------------------
assert.equal(isBudgetYield(new JobYieldError("merging")), true);
assert.equal(
  isBudgetYield(new JobYieldError("writing", { reason: "rate_limit", retryAfterMs: 60_000 })),
  false,
  "a provider delay must keep its wait even with budget left",
);
console.log("✓ only a budget yield is re-claimable immediately");

assert.equal(shouldContinueInInvocation({ remainingMs: 120_000, passes: 0 }), true);
assert.equal(
  shouldContinueInInvocation({ remainingMs: 10_000, passes: 0 }),
  false,
  "a pass started with 10 s left cannot finish a model call",
);
assert.equal(
  shouldContinueInInvocation({ remainingMs: 120_000, passes: 6 }),
  false,
  "one job cannot monopolise the invocation",
);
assert.equal(shouldContinueInInvocation({ remainingMs: 120_000, passes: 5 }), true);
assert.equal(
  shouldContinueInInvocation({ remainingMs: Number.POSITIVE_INFINITY, passes: 0 }),
  false,
  "an unknown deadline never reports budget left",
);
assert.equal(shouldContinueInInvocation({ remainingMs: 20_000, passes: 1, maxPasses: 1 }), false);
assert.equal(shouldContinueInInvocation({ remainingMs: 20_000, passes: 1, minContinueMs: 30_000 }), false);
console.log("✓ continuation needs remaining budget and an unused pass");

// --- Failure codes are stable strings the diagnostics can group ----------
assert.equal(errorCodeFor(null), null);
assert.equal(errorCodeFor(new UserFacingError("nope")), "USER_FACING");
assert.equal(errorCodeFor(Object.assign(new Error("gone"), { code: "P2025" })), "NOTE_DELETED");
assert.equal(errorCodeFor(Object.assign(new Error("x"), { kind: "rate_limit" })), "RATE_LIMIT");
assert.equal(errorCodeFor(Object.assign(new Error("x"), { kind: "timeout" })), "TIMEOUT");
assert.equal(errorCodeFor(Object.assign(new Error("x"), { kind: "checkpoint_write" })), "CHECKPOINT_WRITE");
assert.equal(errorCodeFor(Object.assign(new Error("x"), { status: 429 })), "RATE_LIMIT");
assert.equal(errorCodeFor(new Error("Request timed out")), "TIMEOUT");
assert.equal(errorCodeFor(new Error("invalid JSON output")), "PARSE_ERROR");
assert.equal(errorCodeFor(new Error("schema validation failed")), "SCHEMA_INVALID");
assert.equal(errorCodeFor(new Error("boom")), "INTERNAL_ERROR");
console.log("✓ every failure maps to one recorded code");

console.log("\nAll job recovery checks passed.");
