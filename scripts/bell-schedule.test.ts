import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import {
  DEFAULT_BELL_PROFILE,
  applyBellSettings,
  bellBreak,
  defaultBellSettings,
  effectiveBellProfile,
  validateBellSettings,
  type BellProfile,
} from "../shared/bellSchedule.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [], teachers: [], rooms: [], subgroups: [],
  groups: ["g1", "g2", "old"].map((id) => ({
    id, name: id, archived: id === "old", students: 20, leaderId: null, roomId: null, autoRoomIds: [],
  })),
};
const profile = (start = 510, duration = 45, breaks = [10, 10, 15]): BellProfile => ({ start, duration, breaks });
function day(date = "2026-10-05", starts = [510, 565, 620], durations = [45, 45, 45], lessons: EditorDay["slots"] = [[{ id: "a", subjectId: "s" }], [], []]): EditorDay {
  return {
    date, start: "08:30", duration: 45, breaks: [10, 10], slots: lessons,
    times: starts.map((start, index) => ({ start, duration: durations[index] ?? 45 })),
  };
}
function schedule(first = day()): Schedule {
  return { "g1:0": [first], "g2:0": [day("2026-10-05", [510, 565, 620], [45, 45, 45], [[], [], []])] };
}
const options = { groupIds: ["g1"], startDate: "2026-10-05", endDate: "2026-10-05", replaceStart: false, resetBreaks: false };

test("all groups use the shared profile and returned breaks are copied", () => {
  const settings = defaultBellSettings();
  assert.deepEqual(DEFAULT_BELL_PROFILE, { start: 510, duration: 45, breaks: [10, 10, 15, 10, 10, 10] });
  assert.deepEqual(effectiveBellProfile(settings, "g1"), settings.school);
  settings.groups.g1 = profile(600); // Obsolete client data is ignored.
  assert.equal(effectiveBellProfile(settings, "g1").start, 510);
  assert.equal(effectiveBellProfile(settings, "g2").start, 510);
  effectiveBellProfile(settings, "g1").breaks[0] = 99;
  assert.equal(settings.school.breaks[0], 10);
  assert.equal(bellBreak(profile(510, 45, [7]), 2), 7);
});

test("applies shared profile, preserves the actual first start and manual breaks; reset replaces breaks", () => {
  const original = schedule(day("2026-10-05", [520, 585, 650], [45, 45, 45]));
  original["g1:0"][0].bellProfile = profile();
  original["g1:0"][0].breaks = [20, 20];
  const settings = defaultBellSettings();
  settings.school = profile(600, 40, [5, 5]);
  const applied = applyBellSettings(original, settings, options, catalog);
  assert.deepEqual(applied.schedule["g1:0"][0].times, [
    { start: 520, duration: 40 }, { start: 580, duration: 40 }, { start: 640, duration: 40 },
  ]);
  assert.equal(applied.changedDays[0].manualChanges, 2);
  const reset = applyBellSettings(original, settings, { ...options, resetBreaks: true }, catalog);
  assert.deepEqual(reset.schedule["g1:0"][0].times, [
    { start: 520, duration: 40 }, { start: 565, duration: 40 }, { start: 610, duration: 40 },
  ]);
  assert.equal(original["g1:0"][0].times[1].start, 585);
});

test("rejects a new room conflict atomically", () => {
  const original = schedule();
  original["g1:0"][0].slots[2].push({ id: "roomed", subjectId: "s", roomId: "r" });
  original["g2:0"][0].slots[1].push({ id: "other-room", subjectId: "s", roomId: "r" });
  const before = structuredClone(original);
  const settings = defaultBellSettings();
  settings.school = profile(480, 45, [10]);
  assert.throws(() => applyBellSettings(original, settings, { ...options, replaceStart: true }, catalog), /Кабинет/);
  assert.deepEqual(original, before);
});

test("rejects a new teacher conflict atomically", () => {
  const original = schedule();
  original["g1:0"][0].slots[2].push({ id: "teachered", subjectId: "s", teacherId: "t" });
  original["g2:0"][0].slots[1].push({ id: "other-teacher", subjectId: "s", teacherId: "t" });
  const before = structuredClone(original);
  const settings = defaultBellSettings();
  settings.school = profile(480);
  assert.throws(() => applyBellSettings(original, settings, { ...options, replaceStart: true }, catalog), /Преподаватель/);
  assert.deepEqual(original, before);
});

test("rejects shifting only one copy of a joint lesson atomically", () => {
  const original = schedule();
  original["g1:0"][0].slots[0][0].jointId = "joint";
  original["g2:0"][0].slots[0].push({ id: "joint-copy", subjectId: "s", jointId: "joint" });
  const before = structuredClone(original);
  const settings = defaultBellSettings();
  settings.school = profile(540);
  assert.throws(() => applyBellSettings(original, settings, { ...options, replaceStart: true }, catalog), /совместного занятия/);
  assert.deepEqual(original, before);
});

test("validates shared settings shape, profile bounds and dates while ignoring legacy group overrides", () => {
  const settings = defaultBellSettings();
  assert.equal(validateBellSettings(settings, catalog), null);
  settings.groups.old = profile();
  settings.groups.unknown = { malformed: true } as never;
  assert.equal(validateBellSettings(settings, catalog), null, "legacy overrides are ignored");
  settings.school.breaks = [];
  assert.match(validateBellSettings(settings, catalog) ?? "", /Перемены/);
  settings.school = profile(900, 80, [10]);
  assert.match(validateBellSettings(settings, catalog) ?? "", /Семь уроков.*за пределы дня/);
  assert.throws(() => applyBellSettings(schedule(), defaultBellSettings(), {
    ...options, startDate: "2026-02-30",
  }, catalog), /корректный период/);
  assert.throws(() => applyBellSettings(schedule(), defaultBellSettings(), {
    ...options, resetBreaks: "false",
  } as never, catalog), /Параметры групп/);
});

test("metadata-only updates do not count unchanged lesson intervals or manual edits", () => {
  const original = schedule();
  original["g1:0"][0].bellProfile = profile();
  original["g1:0"][0].duration = 50;
  const settings = defaultBellSettings();
  settings.school = profile();
  const result = applyBellSettings(original, settings, options, catalog);
  assert.equal(result.changedDays.length, 1);
  assert.equal(result.changedDays[0].lessonCount, 0);
  assert.equal(result.changedLessons, 0);
  assert.equal(result.manualChanges, 0);
});
