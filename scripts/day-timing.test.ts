import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { applyDayTiming, previewDayTiming, type DayTimingOptions } from "../shared/dayTiming.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";
import { appendSlot } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [], teachers: [], rooms: [], subgroups: [],
  groups: ["g1", "g2", "g3", "g4"].map((id) => ({
    id, name: id, archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [],
  })),
};
const makeDay = (date: string, starts = [480, 535], lessons: EditorDay["slots"] = [[{ id: `${date}-1`, subjectId: "s" }], []], holiday = false): EditorDay => ({
  date, start: "08:00", duration: 45, breaks: [10], holiday, times: starts.map((start) => ({ start, duration: 45 })), slots: lessons,
});
const base = (): Schedule => {
  const schedule = {
    "g1:0": [makeDay("2026-10-12", [490, 550]), makeDay("2026-10-13")],
    "g2:4": [makeDay("2026-10-12", [600, 655])],
    "g3:1": [makeDay("2026-10-12", [500, 555], undefined, true)],
  };
  for (const [groupKey, days] of Object.entries(schedule)) for (const day of days)
    for (const lesson of day.slots.flat()) lesson.id = `${groupKey}:${lesson.id}`;
  return schedule;
};
const options = (groupIds = ["g1", "g2"]): DayTimingOptions => ({
  date: "2026-10-12", groupIds, currentGroupId: "g1", start: 510, duration: 30,
  schoolProfile: { start: 480, duration: 45, breaks: [5, 12] },
});

test("preserves different shifts, finds same date across week keys, and updates only selected date", () => {
  const input = base();
  const before = structuredClone(input);
  const result = previewDayTiming(input, options(), catalog);
  assert.deepEqual(result.changedDays.map(({ groupId }) => groupId), ["g1", "g2"]);
  assert.deepEqual(result.schedule["g1:0"][0].times, [{ start: 510, duration: 30 }, { start: 545, duration: 30 }]);
  assert.deepEqual(result.schedule["g2:4"][0].times, [{ start: 600, duration: 30 }, { start: 635, duration: 30 }]);
  assert.deepEqual(result.schedule["g1:0"][1], input["g1:0"][1]);
  assert.deepEqual(input, before, "preview does not mutate its input");
});

test("supports subset/all groups, school breaks, and a uniform break override", () => {
  const input = base();
  const subset = previewDayTiming(input, options(["g1"]), catalog);
  assert.equal(subset.changedDays.length, 1);
  assert.deepEqual(subset.schedule["g2:4"][0].times, input["g2:4"][0].times);
  const all = previewDayTiming(input, { ...options(["g1", "g2"]), uniformBreak: 5 }, catalog);
  assert.deepEqual(all.schedule["g1:0"][0].times.map((time) => time.start), [510, 545]);
  assert.deepEqual(all.schedule["g2:4"][0].times.map((time) => time.start), [600, 635]);
  const school = previewDayTiming(input, { ...options(["g2"]), currentGroupId: "g1", start: Number.NaN }, catalog);
  assert.deepEqual(school.schedule["g2:4"][0].times.map((time) => time.start), [600, 635]);
});

test("reports missing and non-school days as skips", () => {
  const result = previewDayTiming(base(), options(["g1", "g3", "g4"]), catalog);
  assert.deepEqual(result.skippedGroups, [
    { groupId: "g3", reason: "В этот день занятий нет" },
    { groupId: "g4", reason: "На эту дату нет расписания группы" },
  ]);
});

test("returns joint conflict for a partial edit and permits an atomic edit of all participants", () => {
  const input = base();
  input["g2:4"][0] = makeDay("2026-10-12", [490, 545]);
  input["g1:0"][0].slots[0][0].jointId = "j";
  input["g2:4"][0].slots[0].push({ id: "joint-copy", subjectId: "s", jointId: "j" });
  const partial = previewDayTiming(input, options(["g1"]), catalog);
  assert.match(partial.conflict ?? "", /общего занятия/);
  const appliedTogether = previewDayTiming(input, { ...options(), currentGroupId: "g1", start: 490 }, catalog);
  assert.equal(appliedTogether.conflict, undefined);
  assert.throws(() => applyDayTiming(input, options(["g1"]), catalog), /общего занятия/);
});

test("reports newly introduced room and teacher conflicts while apply rejects them", () => {
  const input = base();
  input["g1:0"][0].slots[1].push({ id: "room", subjectId: "s", roomId: "r", teacherId: "t" });
  input["g2:4"][0].slots[0].push({ id: "peer", subjectId: "s", roomId: "r", teacherId: "t" });
  // Move g1 lesson 2 onto the unchanged g2 lesson 1 interval.
  const moveToOverlap = { ...options(["g1"]), start: 575, duration: 45, schoolProfile: { start: 480, duration: 45, breaks: [0] } };
  const result = previewDayTiming(input, moveToOverlap, catalog);
  assert.match(result.conflict ?? "", /Кабинет/);
  assert.throws(() => applyDayTiming(input, moveToOverlap, catalog), /Кабинет/);
  const teacherOnly = structuredClone(input);
  teacherOnly["g1:0"][0].slots[1][0].roomId = undefined;
  teacherOnly["g2:4"][0].slots[0][0].roomId = undefined;
  const teacherResult = previewDayTiming(teacherOnly, moveToOverlap, catalog);
  assert.match(teacherResult.conflict ?? "", /Преподаватель/);
});

test("validates selection and timing inputs", () => {
  assert.throws(() => previewDayTiming(base(), { ...options(), groupIds: ["g1", "g1"] }, catalog), /без повторов/);
  assert.throws(() => previewDayTiming(base(), { ...options(), groupIds: ["unknown"] }, catalog), /не найдена/);
  assert.throws(() => previewDayTiming(base(), { ...options(), date: "2026-02-30" }, catalog), /корректную дату/);
  assert.throws(() => previewDayTiming(base(), { ...options(), duration: 181 }, catalog), /Длительность урока/);
  assert.throws(() => previewDayTiming(base(), { ...options(), uniformBreak: 241 }, catalog), /Длительность перемены/);
});

test("shortening preserves the bell snapshot and appended slots use the shorter duration and breaks", () => {
  const input = base();
  input["g1:0"][0].slots.at(-1)!.push({ id: "tail-lesson", subjectId: "math" });
  input["g1:0"][0].bellProfile = { start: 480, duration: 45, breaks: [10, 15] };
  const next = applyDayTiming(input, { ...options(["g1"]), uniformBreak: 5 }, catalog);
  assert.deepEqual(next["g1:0"][0].bellProfile, input["g1:0"][0].bellProfile);
  const appended = appendSlot(next, { groupId: "g1", weekOffset: 0, date: "2026-10-12", slot: 0 });
  assert.deepEqual(appended["g1:0"][0].times.at(-1), { start: 580, duration: 30 });
  const oneSlot = base();
  oneSlot["g1:0"][0].times = [{ start: 490, duration: 45 }];
  oneSlot["g1:0"][0].slots = [oneSlot["g1:0"][0].slots[0]];
  oneSlot["g1:0"][0].breaks = [];
  const late = applyDayTiming(oneSlot, { ...options(["g1"]), start: 1380 }, catalog);
  assert.deepEqual(late["g1:0"][0].times, [{ start: 1380, duration: 30 }]);
  assert.equal(late["g1:0"][0].bellProfile, undefined);
});

test("uses unequal school breaks for every group and normalizes nominal day duration", () => {
  const input = base();
  for (const groupKey of ["g1:0", "g2:4"]) {
    input[groupKey][0].slots.push([]);
    input[groupKey][0].times.push({ start: input[groupKey][0].times[1].start + 55, duration: 45 });
    input[groupKey][0].breaks.push(10);
  }
  const next = applyDayTiming(input, options(), catalog);
  assert.deepEqual(next["g1:0"][0].times.map((time) => time.start), [510, 545, 587]);
  assert.deepEqual(next["g2:4"][0].breaks, [5, 12]);
  next["g1:0"][0].duration = 45;
  const normalized = applyDayTiming(next, options(["g1"]), catalog);
  assert.equal(normalized["g1:0"][0].duration, 30);
});

test("unchanged historical overlaps remain allowed and a sole surviving joint mirror can change", () => {
  const input = base();
  input["g2:4"][0].times = structuredClone(input["g1:0"][0].times);
  input["g1:0"][0].slots[0][0].roomId = "r";
  input["g2:4"][0].slots[0][0].roomId = "r";
  const same = { ...options(), start: 490, duration: 45, uniformBreak: 15 };
  assert.equal(previewDayTiming(input, same, catalog).conflict, undefined);
  const resolving = previewDayTiming(input, { ...same, start: 420, groupIds: ["g1"] }, catalog);
  assert.equal(resolving.conflict, undefined);
  assert.match(resolving.undoConflict ?? "", /Кабинет/);
  assert.equal(previewDayTiming(base(), options(), catalog).undoConflict, undefined);
  const singleton = base();
  singleton["g1:0"][0].slots[0][0].jointId = "remaining";
  assert.equal(previewDayTiming(singleton, options(["g1"]), catalog).conflict, undefined);
  const joint = base();
  joint["g1:0"][0].slots[0][0].jointId = "joint";
  joint["g2:4"][0].slots[0][0].jointId = "joint";
  assert.match(previewDayTiming(joint, options(), catalog).conflict ?? "", /общего занятия/);
});
