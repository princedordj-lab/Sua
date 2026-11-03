import assert from "node:assert/strict";
import {
  ACTIVE_JOB_STATES,
  DEFAULT_STALE_QUEUED_MS,
  decideJobCreation,
  hasSettledKind,
  jobIsAlive,
} from "../src/lib/job-dedupe.js";

console.log("=== Job dedupe checks ===");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms);
const MINUTE = 60_000;

assert.deepEqual(ACTIVE_JOB_STATES, ["queued", "running"]);
assert.equal(DEFAULT_STALE_QUEUED_MS, 10 * MINUTE);

// --- Null / terminal states ------------------------------------------------
assert.equal(jobIsAlive(null, { now: NOW }), false);
for (const state of ["completed", "failed", "cancelled"]) {
  assert.equal(
    jobIsAlive({ state, createdAt: ago(0) }, { now: NOW }),
    false,
    `${state} is never alive`,
  );
}
console.log("✓ only queued and running jobs can be alive");

// --- running --------------------------------------------------------------
assert.equal(
  jobIsAlive({ state: "running", startedAt: ago(2 * MINUTE), heartbeatAt: ago(30_000) }, { now: NOW }),
  true,
  "a pass that just wrote a stage is alive",
);
assert.equal(
  jobIsAlive({ state: "running", startedAt: ago(20 * MINUTE), heartbeatAt: ago(16 * MINUTE) }, { now: NOW }),
  false,
  "a running row with no heartbeat for the interruption window is dead",
);
assert.equal(
  jobIsAlive({ state: "running", startedAt: ago(4 * MINUTE) }, { now: NOW }),
  true,
  "no heartbeat yet falls back to startedAt",
);
assert.equal(
  jobIsAlive(
    { state: "running", startedAt: ago(4 * MINUTE), heartbeatAt: ago(2 * MINUTE) },
    { now: NOW, staleRunningMs: MINUTE },
  ),
  false,
  "the running window is configurable",
);
console.log("✓ a running job is alive only while its heartbeat is recent");

// --- queued, never picked up ---------------------------------------------
assert.equal(jobIsAlive({ state: "queued", createdAt: ago(1 * MINUTE) }, { now: NOW }), true);
assert.equal(
  jobIsAlive({ state: "queued", createdAt: ago(11 * MINUTE) }, { now: NOW }),
  false,
  "a queued job nobody claimed is dead after the stale window",
);
assert.equal(
  jobIsAlive({ state: "queued", createdAt: ago(11 * MINUTE) }, { now: NOW, staleQueuedMs: 30 * MINUTE }),
  true,
);
console.log("✓ a queued job that never ran dies when its window expires");

// --- queued after a pass (yielded / extraction gate) ---------------------
assert.equal(
  jobIsAlive({ state: "queued", createdAt: ago(60 * MINUTE), startedAt: ago(1 * MINUTE) }, { now: NOW }),
  true,
  "a yielded job is alive even though it was created long ago",
);
assert.equal(
  jobIsAlive(
    {
      state: "queued",
      createdAt: ago(60 * MINUTE),
      startedAt: ago(40 * MINUTE),
      heartbeatAt: ago(30_000),
    },
    { now: NOW },
  ),
  true,
  "the heartbeat, not createdAt, decides for a resumed job",
);
assert.equal(
  jobIsAlive({ state: "queued", createdAt: ago(60 * MINUTE), startedAt: ago(30 * MINUTE) }, { now: NOW }),
  false,
  "a yielded job whose worker vanished is dead",
);
console.log("✓ a yielded job is judged by its own retry clock, not its creation time");

// --- decideJobCreation ---------------------------------------------------
assert.equal(decideJobCreation(null, { now: NOW }), "create");
assert.equal(decideJobCreation({ state: "failed", createdAt: ago(0) }, { now: NOW }), "create");
assert.equal(
  decideJobCreation({ state: "running", startedAt: ago(MINUTE), heartbeatAt: ago(MINUTE) }, { now: NOW }),
  "reuse",
  "duplicate taps must not create a second job",
);
assert.equal(
  decideJobCreation({ state: "running", startedAt: ago(30 * MINUTE), heartbeatAt: ago(30 * MINUTE) }, { now: NOW }),
  "create",
  "a dead run must not block the retry the student asked for",
);
console.log("✓ check-then-create resolves to reuse only for a live job");

// --- hasSettledKind -----------------------------------------------------
assert.equal(hasSettledKind([], "lecture_note"), false);
assert.equal(hasSettledKind(null, "lecture_note"), false);
assert.equal(
  hasSettledKind([{ kind: "lecture_note", state: "failed" }], "lecture_note"),
  false,
  "a failed run is not a produced destination",
);
assert.equal(hasSettledKind([{ kind: "lecture_note", state: "queued" }], "lecture_note"), true);
assert.equal(hasSettledKind([{ kind: "lecture_note", state: "completed" }], "lecture_note"), true);
assert.equal(
  hasSettledKind([{ kind: "study_set", state: "completed" }], "lecture_note"),
  false,
  "a finished study set does not block a lecture-note conversion",
);
assert.equal(
  hasSettledKind([{ kind: "lecture_note", state: "failed" }], "course_reference"),
  false,
);
console.log("✓ a destination is produced once, and a failed run may be retried");

console.log("\nAll job dedupe checks passed.");
