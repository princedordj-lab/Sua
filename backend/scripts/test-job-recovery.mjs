import assert from "node:assert/strict";
import {
  clampDelay,
  nextYieldState,
  progressSignal,
  yieldDelayMs,
  YIELD_DEFAULTS,
} from "../src/lib/job-recovery.js";

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

console.log("\nAll job recovery checks passed.");
