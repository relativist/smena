import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorDay, Schedule } from "../src/editor.ts";
import { clearScheduleRange } from "../shared/scheduleMaintenance.ts";

function day(date: string, subjectId: string): EditorDay {
  return {
    date,
    start: "08:30",
    duration: 45,
    breaks: [10],
    slots: [[{ id: `${date}-${subjectId}`, subjectId, event: "preserve metadata" }]],
    times: [{ start: 510, duration: 45 }],
  };
}

test("clearScheduleRange clears selected groups only within inclusive date bounds", () => {
  const schedule: Schedule = {
    "g1:0": [day("2026-10-04", "before"), day("2026-10-05", "first"), day("2026-10-07", "last"), day("2026-10-08", "after")],
    "g2:0": [day("2026-10-05", "other-group")],
  };
  const original = structuredClone(schedule);

  const result = clearScheduleRange(schedule, ["g1"], "2026-10-05", "2026-10-07");

  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.schedule["g1:0"].map((item) => item.slots), [
    schedule["g1:0"].map((item) => item.slots)[0], [[]], [[]], schedule["g1:0"].map((item) => item.slots)[3],
  ]);
  assert.deepEqual(result.schedule["g2:0"], schedule["g2:0"]);
  assert.deepEqual(schedule, original, "the input remains unchanged");
  assert.deepEqual(result.schedule["g1:0"][1].times, schedule["g1:0"][1].times);
  assert.equal(result.schedule["g1:0"][1].start, schedule["g1:0"][1].start);
  assert.equal(result.schedule["g1:0"][1].date, schedule["g1:0"][1].date);
  assert.equal(result.schedule["g1:0"][1].slots[0].length, 0);
});

test("clearScheduleRange returns a copied schedule and handles empty selection or reversed dates", () => {
  const schedule: Schedule = { "g1:0": [day("2026-10-05", "lesson")] };
  const noGroups = clearScheduleRange(schedule, [], "2026-10-01", "2026-10-31");
  const reversed = clearScheduleRange(schedule, ["g1"], "2026-10-31", "2026-10-01");

  assert.notEqual(noGroups.schedule, schedule);
  assert.equal(noGroups.removedCount, 0);
  assert.equal(reversed.removedCount, 0);
  assert.deepEqual(noGroups.schedule, schedule);
});
