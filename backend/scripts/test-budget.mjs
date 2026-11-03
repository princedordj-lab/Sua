import assert from "node:assert/strict";
import {
  budgetReport,
  extractionBudgetMs,
  interruptedAfterMs,
  leaseMsFor,
  minCallWindowMs,
  minPhaseMs,
  platformMaxMs,
  processingBudgetMs,
  processingSafetyMs,
  remainingMs,
  tickBudgetPlan,
} from "../src/lib/budget.js";

console.log("=== Invocation budget checks ===");

const ENV_KEYS = [
  "PLATFORM_MAX_DURATION_MS",
  "PROCESSING_SAFETY_MS",
  "INTERRUPTED_RUNNING_MS",
  "MIN_AI_CALL_WINDOW_MS",
  "MAX_PASSES_PER_INVOCATION",
];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restore() {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

try {
  // --- Defaults: the 300 s ceiling Vercel documents for Hobby and Pro -------
  clearEnv();
  assert.equal(platformMaxMs(), 300_000);
  assert.equal(processingSafetyMs(), 12_000);
  assert.equal(processingBudgetMs(), 288_000, "a pass keeps headroom under the ceiling");
  console.log("✓ the default platform ceiling is 300 s with 12 s of headroom");

  // --- Lease outlives the pass it protects, and stays recoverable -----------
  assert.equal(leaseMsFor(288_000), 348_000, "budget + 60 s");
  assert.ok(leaseMsFor(288_000) > processingBudgetMs(), "a live pass cannot lose its lease");
  assert.equal(leaseMsFor(10_000_000), 420_000, "capped at platform + 120 s so a dead lease frees up");
  assert.equal(leaseMsFor(1), 120_000, "never shorter than two minutes");
  console.log("✓ the lease always outlives its pass and is capped for recovery");

  // --- Interruption window: never less than a lease, never an hour of silence
  assert.equal(interruptedAfterMs(348_000), 696_000, "twice the lease");
  assert.equal(interruptedAfterMs(60_000), 300_000, "floored at five minutes");
  assert.ok(interruptedAfterMs(348_000) >= 348_000);
  process.env.INTERRUPTED_RUNNING_MS = "90000";
  assert.equal(interruptedAfterMs(348_000), 348_000, "a too-short override is raised to the lease");
  delete process.env.INTERRUPTED_RUNNING_MS;
  console.log("✓ a running row is declared interrupted after a bounded silence");

  // --- A 60 s project (Hobby without Fluid compute) -------------------------
  process.env.PLATFORM_MAX_DURATION_MS = "60000";
  assert.equal(platformMaxMs(), 60_000);
  assert.equal(processingBudgetMs(), 48_000);
  assert.equal(leaseMsFor(), 120_000, "a 48 s pass is protected by the 2 minute floor");
  assert.equal(interruptedAfterMs(), 300_000);
  assert.ok(extractionBudgetMs() <= processingBudgetMs());
  console.log("✓ a 60 s project gets a 48 s pass instead of being killed at 60 s");

  // --- A nonsense ceiling cannot produce a zero-length pass ----------------
  process.env.PLATFORM_MAX_DURATION_MS = "8000";
  process.env.PROCESSING_SAFETY_MS = "12000";
  assert.equal(processingBudgetMs(), 15_000, "clamped to a usable minimum");
  assert.ok(extractionBudgetMs() > 0);
  console.log("✓ a misconfigured ceiling still leaves a usable budget");

  // --- Non-numeric and negative values fall back, they do not crash --------
  process.env.PLATFORM_MAX_DURATION_MS = "not-a-number";
  delete process.env.PROCESSING_SAFETY_MS;
  assert.equal(platformMaxMs(), 300_000);
  process.env.PLATFORM_MAX_DURATION_MS = "-5";
  assert.equal(platformMaxMs(), 300_000);
  clearEnv();
  console.log("✓ a bad env value falls back instead of zeroing the budget");

  // --- The tick's phases must fit in one function --------------------------
  const plan = tickBudgetPlan(288_000);
  assert.equal(
    plan.generationMs + plan.extractionMs + plan.maintenanceMs,
    plan.totalMs,
    "phases share one ceiling instead of carrying three",
  );
  assert.equal(plan.totalMs, 288_000);
  assert.ok(plan.generationMs > plan.extractionMs, "generation is the student-facing phase");
  const tight = tickBudgetPlan(15_000);
  assert.equal(tight.generationMs + tight.extractionMs + tight.maintenanceMs, 15_000);
  assert.ok(tight.maintenanceMs >= 0);
  console.log("✓ the tick splits one budget, so three phases cannot overrun the function");

  // --- Deadline arithmetic ------------------------------------------------
  const now = 1_000_000;
  assert.equal(remainingMs(now + 5_000, now), 5_000);
  assert.equal(remainingMs(now - 5_000, now), 0, "an expired deadline never goes negative");
  assert.equal(remainingMs(null, now), 0);
  assert.equal(remainingMs(undefined, now), 0);
  assert.equal(minPhaseMs(), 10_000);
  console.log("✓ an expired deadline reports zero and phases stop starting");

  // --- Model-call window ---------------------------------------------------
  assert.equal(minCallWindowMs(), 25_000);
  process.env.MIN_AI_CALL_WINDOW_MS = "40000";
  assert.equal(minCallWindowMs(), 40_000);
  delete process.env.MIN_AI_CALL_WINDOW_MS;
  console.log("✓ the minimum model-call window is configurable");

  // --- Boot report --------------------------------------------------------
  process.env.PLATFORM_MAX_DURATION_MS = "60000";
  const report = budgetReport();
  assert.equal(report.platformMaxMs, 60_000);
  assert.equal(report.budgetMs, 48_000);
  assert.equal(report.leaseMs, 120_000);
  assert.equal(report.source, "env");
  assert.equal(report.tick.totalMs, 48_000);
  clearEnv();
  assert.equal(budgetReport().source, "default");
  console.log("✓ the boot report states the ceiling and where it came from");
} finally {
  restore();
}

console.log("\nAll invocation budget checks passed.");
