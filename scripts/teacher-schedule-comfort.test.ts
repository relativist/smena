import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "../shared/catalog.ts";
import { summarizeTeacherScheduleComfort } from "../shared/teacherScheduleComfort.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  groups: ["a", "b", "c", "holiday"].map((id) => ({
    id, name: id.toUpperCase(), archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [],
  })),
  subjects: [], rooms: [], subgroups: [],
  teachers: [
    { id: "t", name: "Иванов", archived: false, subjectIds: [], defaultRoomId: null },
    { id: "h", name: "Петров", archived: true, subjectIds: [], defaultRoomId: null },
  ],
};
const quarter = { id: "q", name: "Q", startDate: "2026-10-05", endDate: "2026-10-06" };
const lesson = (id: string, teacherId = "t", extra: Record<string, unknown> = {}) => ({ id, subjectId: "math", teacherId, ...extra });
const day = (date: string, starts: number[], slots: Array<Array<ReturnType<typeof lesson>>>, breaks = starts.slice(1).map((start, i) => start - (starts[i]! + 45)), holiday = false) => ({
  date, start: "08:00", duration: 45, breaks, holiday,
  times: starts.map((start) => ({ start, duration: 45 })), slots,
});

test("summarizes actual-time waits and recognizes separate shifts from each group's first bell", () => {
  const schedule: Schedule = {
    "a:0": [day("2026-10-05", [480, 550], [[lesson("a1")], [lesson("a2")]], [5])],
    // The teacher's fifth lesson is late in this group's day, but shift is based on day start.
    "b:0": [day("2026-10-05", [720, 1020], [[], [lesson("b-fifth")]], [255])],
  };
  const result = summarizeTeacherScheduleComfort({ schedule, catalog, quarter });
  assert.deepEqual(result.teachers, [{ teacherId: "t", name: "Иванов", gapMinutes: 425, gapCount: 1, bothShiftDays: 1 }]);
  assert.deepEqual(result.total, { gapMinutes: 425, gapCount: 1, bothShiftDays: 1 });
});

test("uses actual adjacent long breaks, unions subgroup/joint overlaps, and treats events as occupied", () => {
  const schedule: Schedule = {
    "a:0": [day("2026-10-05", [480, 575, 640], [
      [lesson("first", "t", { jointId: "j", subgroupId: "a1" })],
      [lesson("second", "t", { jointId: "j", subgroupId: "a2" })],
      [lesson("event", "t", { event: "Собрание" })],
    ], [50, 20])],
    "b:0": [day("2026-10-05", [480, 575], [
      [lesson("mirror", "t", { jointId: "j", subgroupId: "b1" })],
      [lesson("mirror2", "t", { jointId: "j", subgroupId: "b2" })],
    ], [50])],
  };
  const result = summarizeTeacherScheduleComfort({ schedule, catalog, quarter });
  // 50-minute bell break is normal; the 20-minute gap before the event is also normal.
  assert.deepEqual(result.teachers[0], { teacherId: "t", name: "Иванов", gapMinutes: 0, gapCount: 0, bothShiftDays: 0 });
});

test("excludes holiday and out-of-quarter waits and teacher filter keeps cross-group occupancy", () => {
  const schedule: Schedule = {
    "a:0": [
      day("2026-10-05", [480, 600], [[lesson("a1")], [lesson("a2")]]),
      day("2026-10-06", [480, 600], [[lesson("holiday1")], [lesson("holiday2")]], [10], true),
      day("2026-10-07", [480, 600], [[lesson("outside1")], [lesson("outside2")]]),
    ],
    // This activity fills the apparent wait from group a; teacherIds must not act as a group filter.
    "b:0": [
      day("2026-10-05", [530, 575], [[lesson("filler1")], [lesson("filler2")]]),
      day("2026-10-06", [480], [[]], [10], true),
    ],
    "holiday:0": [day("2026-10-06", [480, 600], [[lesson("archived1", "h")], [lesson("archived2", "h")]], [10], true)],
  };
  const selected = summarizeTeacherScheduleComfort({ schedule, catalog, quarter, teacherIds: ["t"] });
  assert.deepEqual(selected.teachers, [{ teacherId: "t", name: "Иванов", gapMinutes: 0, gapCount: 0, bothShiftDays: 0 }]);
  const all = summarizeTeacherScheduleComfort({ schedule, catalog, quarter });
  assert.equal(all.teachers.some((entry) => entry.teacherId === "h"), true, "archived teacher with assigned lessons is included");
  assert.equal(all.teachers.find((entry) => entry.teacherId === "h")!.gapCount, 0, "holiday activity contributes no comfort counts");
});

test("empty selection and teachers without assigned lessons return clean zero totals", () => {
  const result = summarizeTeacherScheduleComfort({ schedule: {}, catalog, quarter, teacherIds: ["t"] });
  assert.deepEqual(result, { total: { gapMinutes: 0, gapCount: 0, bothShiftDays: 0 }, teachers: [] });
});
