import assert from "node:assert/strict";
import {
  computeRunStreak,
  dayDiff,
  dayKeyForOffset,
  dayKeyInTimeZone,
  isDayKey,
  isValidTimezone,
  streakView,
} from "../src/lib/streak-rules.js";

console.log("=== Daily streak checks ===");

assert.deepEqual(computeRunStreak([]), { streakDays: 0, lastActiveDay: null });
assert.deepEqual(computeRunStreak(null), { streakDays: 0, lastActiveDay: null });
console.log("✓ no history is a zero streak");

assert.deepEqual(computeRunStreak(["2026-10-30", "2026-10-30", "2026-10-30"]), {
  streakDays: 1,
  lastActiveDay: "2026-10-30",
});
console.log("✓ same-day opens count once");

assert.equal(
  computeRunStreak(["2026-10-28", "2026-10-29", "2026-10-30"]).streakDays,
  3,
  "consecutive days add one each",
);
console.log("✓ consecutive days accumulate");

assert.equal(
  computeRunStreak(["2026-10-26", "2026-10-28", "2026-10-30"]).streakDays,
  3,
  "a one-day gap continues the run",
);
assert.equal(
  computeRunStreak(["2026-10-25", "2026-10-27", "2026-10-29"]).streakDays,
  3,
  "a two-day gap continues the run",
);
console.log("✓ one- and two-day gaps stay inside the grace window");

assert.deepEqual(computeRunStreak(["2026-10-20", "2026-10-21", "2026-10-24", "2026-10-25"]), {
  streakDays: 2,
  lastActiveDay: "2026-10-25",
});
assert.equal(
  computeRunStreak(["2026-10-20", "2026-10-21", "2026-10-24"]).streakDays,
  1,
  "only the run after the three-day gap survives",
);
console.log("✓ a three-day gap restarts the run");

assert.deepEqual(
  computeRunStreak(["2026-10-29", "2026-10-24", "2026-10-25", "2026-10-27"]),
  { streakDays: 4, lastActiveDay: "2026-10-29" },
);
console.log("✓ out-of-order days are sorted before counting");

assert.deepEqual(
  computeRunStreak(["2026-10-30", "not-a-day", "2026-13-01", "2026-02-30", ""]),
  { streakDays: 1, lastActiveDay: "2026-10-30" },
);
console.log("✓ invalid day keys are ignored");

const noonUtc = new Date("2026-10-31T12:00:00Z");
assert.equal(dayKeyInTimeZone(noonUtc, "UTC"), "2026-10-31");
assert.equal(dayKeyInTimeZone(noonUtc, "Pacific/Kiritimati"), "2026-11-01");
assert.equal(dayKeyInTimeZone(noonUtc, "America/Los_Angeles"), "2026-10-31");
assert.equal(dayKeyInTimeZone(new Date("2026-10-31T06:00:00Z"), "America/Los_Angeles"), "2026-10-30");
console.log("✓ day keys follow the device timezone");

assert.equal(dayKeyInTimeZone(new Date("2026-10-31T12:00:00Z"), "Not/AZone"), "2026-10-31");
console.log("✓ an unknown timezone falls back to UTC");

assert.equal(dayKeyForOffset(new Date("2026-10-31T23:30:00Z"), 60), "2026-11-01");
assert.equal(dayKeyForOffset(new Date("2026-10-31T23:30:00Z"), 840), "2026-11-01");
assert.equal(dayKeyForOffset(new Date("2026-10-31T03:00:00Z"), -420), "2026-10-30");
assert.equal(dayKeyForOffset(new Date("2026-10-31T10:00:00Z"), 99_999), "2026-10-31");
assert.equal(dayKeyForOffset(new Date("2026-10-31T10:00:00Z"), "junk"), "2026-10-31");
console.log("✓ a raw UTC offset files the local day when the zone name is unusable");

assert.equal(isValidTimezone("Europe/Lagos"), false);
assert.equal(isValidTimezone("Africa/Lagos"), true);
assert.equal(isValidTimezone(""), false);
assert.equal(isDayKey("2026-10-31"), true);
assert.equal(isDayKey("2026-02-29"), false, "non-leap February 29 is not a day");
assert.equal(isDayKey("2024-02-29"), true);
console.log("✓ timezone and day-key validation reject junk");

assert.equal(dayDiff("2026-10-31", "2026-10-29"), 2);
assert.equal(dayDiff("2026-11-01", "2026-10-31"), 1);
assert.equal(dayDiff("2026-10-31", "2026-10-31"), 0);
assert.equal(dayDiff("2026-10-31", "2026-10-31T00:00:00Z"), 0, "malformed input reads as same-day");
console.log("✓ day differences count whole calendar days");

const today = "2026-10-31";
assert.deepEqual(
  streakView({ streakDays: 4, lastActiveDay: today, streakTimezone: "UTC" }, new Date("2026-10-31T10:00:00Z")),
  { streakDays: 4, activeToday: true, lastActiveDay: today },
);
assert.deepEqual(
  streakView({ streakDays: 4, lastActiveDay: "2026-10-30", streakTimezone: "UTC" }, new Date("2026-10-31T10:00:00Z")),
  { streakDays: 4, activeToday: false, lastActiveDay: "2026-10-30" },
);
assert.deepEqual(
  streakView({ streakDays: 4, lastActiveDay: "2026-10-28", streakTimezone: "UTC" }, new Date("2026-10-31T10:00:00Z")),
  { streakDays: 0, activeToday: false, lastActiveDay: "2026-10-28" },
  "a missed sweep still reads as reset",
);
assert.deepEqual(
  streakView({ streakDays: 0, lastActiveDay: null, streakTimezone: "UTC" }, new Date("2026-10-31T10:00:00Z")),
  { streakDays: 0, activeToday: false, lastActiveDay: null },
);
console.log("✓ the display view respects the reset guard and the grace window");

assert.deepEqual(
  streakView(
    { streakDays: 2, lastActiveDay: "2026-11-01", streakTimezone: "Pacific/Kiritimati" },
    new Date("2026-10-31T12:00:00Z"),
  ),
  { streakDays: 2, activeToday: true, lastActiveDay: "2026-11-01" },
);
console.log("✓ the display view uses the stored reporting timezone");

console.log("\nAll daily streak checks passed.");
