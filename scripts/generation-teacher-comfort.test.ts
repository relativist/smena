import assert from "node:assert/strict";
import { test } from "node:test";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";
import { weekOffsetFor } from "../shared/plans.ts";

const date = "2026-10-05";
const makeDay = (dayDate: string, starts: number[], slots?: Schedule[string][number]["slots"], durations?: number[], breaks?: number[]) => ({
  date: dayDate,
  start: "08:00",
  duration: 45,
  breaks: breaks ?? Array.from({ length: Math.max(0, starts.length - 1) }, () => 10),
  times: starts.map((start, index) => ({ start, duration: durations?.[index] ?? 45 })),
  slots: slots ?? starts.map(() => []),
  holiday: false,
});
const lesson = (id: string, teacherId: string) => ({
  id, subjectId: "math", teacherId, teacher: teacherId, roomId: "r1", room: "Room",
});
function catalog(teachers: Catalog["teachers"], groupIds: string[]): Catalog {
  return {
    groups: groupIds.map((id) => ({ id, name: id, students: 20, leaderId: null, roomId: null, autoRoomIds: [], archived: false })),
    subgroups: [],
    subjects: [{ id: "math", name: "Math", shortName: "Math", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
    teachers,
    rooms: ["r1", "r2"].map((id) => ({ id, name: id, kind: "general" as const, capacity: 100, archived: false })),
  };
}
function plan(groupId: string): StudyPlan {
  return { id: "p", quarterId: "q", groupId, subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "a", subgroupId: null, target: 1 }] };
}
function run(teachers: Catalog["teachers"], days: Record<string, ReturnType<typeof makeDay>[]>, groupIds: string[]) {
  const schedule: Schedule = {};
  for (const [groupId, groupDays] of Object.entries(days)) for (const day of groupDays) {
    const key = `${groupId}:${weekOffsetFor(day.date)}`;
    (schedule[key] ??= []).push(day);
  }
  const dates = Object.values(days).flat().map((day) => day.date).sort();
  const quarter: Quarter = { id: "q", name: "Q", startDate: dates[0] ?? date, endDate: dates.at(-1) ?? date };
  const result = generateQuarter({ catalog: catalog(teachers, groupIds), schedule, quarters: [quarter], studyPlans: [plan("target")] }, "q", groupIds);
  const placement = result.added.find((entry) => entry.groupId === "target");
  assert.ok(placement, `target lesson is generated: ${JSON.stringify(result.remaining)}`);
  return { result, placement: placement!, schedule };
}
const teacher = (id: string, preferredShift?: "morning" | "afternoon") => ({
  id, name: id, subjectIds: ["math"], defaultRoomId: null, archived: false,
  ...(preferredShift ? { preferredShift } : {}),
});

test("teacher gap comfort puts a lesson inside an existing long gap and preserves saved lessons", () => {
  const rows = Array.from({ length: 6 }, () => [] as ReturnType<typeof lesson>[]);
  rows[0]!.push(lesson("keep-first", "t1"));
  rows[5]!.push(lesson("keep-last", "t1"));
  const { result, placement, schedule } = run(
    [teacher("t1")],
    { existing: [makeDay(date, [480, 535, 590, 645, 700, 755], rows)], target: [makeDay(date, [480, 535, 590, 645, 700, 755])] },
    ["existing", "target"],
  );
  assert.ok(placement.slot > 0 && placement.slot < 5, "the generated lesson falls within the teacher's occupied-day span");
  const inputDay = schedule[`existing:${weekOffsetFor(date)}`]?.[0];
  const outputDay = result.schedule[`existing:${weekOffsetFor(date)}`]?.[0];
  assert.deepEqual(outputDay?.slots[0], inputDay?.slots[0], "saved first lesson is unchanged");
  assert.deepEqual(outputDay?.slots[5], inputDay?.slots[5], "saved last lesson is unchanged");
  assert.deepEqual(outputDay?.times, inputDay?.times, "saved lesson times are unchanged");
  assert.equal(result.remaining.length, 0);
});

test("preferred shift follows the group's first lesson time, even when the candidate is after noon", () => {
  const teachers = [teacher("morning", "morning"), teacher("afternoon", "afternoon")];
  const events = [0, 1, 2, 3].map((index) => ({ id: `event-${index}`, subjectId: "math", event: "Событие" }));
  const { placement } = run(teachers, {
    target: [makeDay(date, [690, 745, 800, 855, 910], [...events.map((entry) => [entry]), []])],
    load: [makeDay("2026-10-06", [500, 555], [[lesson("m-load", "morning")], [lesson("m-load-2", "morning")]])],
    load2: [makeDay("2026-10-06", [500, 555], [[lesson("a-load", "afternoon")], [lesson("a-load-2", "afternoon")]])],
  }, ["target", "load", "load2"]);
  assert.equal(placement.slot, 4, "the placement is a late lesson in the morning-start group day");
  assert.equal(placement.teacherId, "morning");
});

test("closer slot wins when both choices leave a long teacher gap", () => {
  const rows = Array.from({ length: 2 }, () => [] as ReturnType<typeof lesson>[]);
  rows[0]!.push(lesson("early", "t1"));
  rows[1]!.push(lesson("late", "t1"));
  const { placement } = run([teacher("t1")], {
    existing: [makeDay(date, [480, 855], rows)],
    target: [makeDay(date, [730, 535], undefined, [120, 45])],
  }, ["existing", "target"]);
  assert.equal(placement.slot, 0, "the nearer choice leaves 205 minutes; the farther choice leaves 275, both above a normal break");
});

test("gap ranking uses actual adjacent group times instead of stale break labels", () => {
  const t1Rows = [[], [lesson("t1-late", "t1")]];
  const t2Rows = [[], [lesson("t2-late", "t2")]];
  const { placement } = run([teacher("t1"), teacher("t2")], {
    target: [makeDay(date, [535, 585], undefined, undefined, [50])],
    t1: [makeDay(date, [555, 610], t1Rows)],
    t2: [makeDay(date, [530, 585], t2Rows)],
  }, ["target", "t1", "t2"]);
  assert.equal(placement.slot, 0);
  assert.equal(placement.teacherId, "t2", "actual 5-minute adjacency avoids a long gap; stale 50-minute label would incorrectly hide t1's 30-minute wait");
});

test("preferred-shift teacher busy at the only slot falls back to a feasible teacher", () => {
  const { placement } = run([teacher("morning", "morning"), teacher("afternoon", "afternoon")], {
    target: [makeDay(date, [690, 745], [[{ id: "event", subjectId: "math", event: "Событие" }], []])],
    busy: [makeDay(date, [745], [[lesson("busy", "morning")]])],
  }, ["target", "busy"]);
  assert.equal(placement.teacherId, "afternoon");
});

test("one qualified teacher with a mismatching shift preference still receives the lesson", () => {
  const { result, placement } = run([teacher("afternoon", "afternoon")], {
    target: [makeDay(date, [690])],
  }, ["target"]);
  assert.equal(placement.teacherId, "afternoon");
  assert.equal(result.remaining.length, 0);
});

test("shift preference favors the existing shift on a day without banning mixed shifts", () => {
  const { placement } = run([teacher("morning"), teacher("afternoon")], {
    target: [makeDay(date, [800, 855])],
    morningLoad: [makeDay(date, [500], [[lesson("morning-existing", "morning")]])],
    afternoonLoad: [makeDay(date, [800], [[lesson("afternoon-existing", "afternoon")]])],
  }, ["target", "morningLoad", "afternoonLoad"]);
  assert.equal(placement.teacherId, "afternoon");
});
