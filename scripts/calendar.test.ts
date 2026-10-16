import assert from "node:assert/strict";
import test from "node:test";
import type { Catalog } from "../shared/catalog.ts";
import {
  applyCalendar,
  calendarDay,
  calendarFromSchedule,
  defaultSchoolCalendar,
  studyWeekdays,
  validateCalendar,
} from "../shared/schoolCalendar.ts";
import type { Schedule } from "../src/editor.ts";
import { weekDates } from "../shared/plans.ts";

const catalog: Catalog = {
  groups: [
    { id: "5a", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "5b", name: "5Б", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  subjects: [], teachers: [], rooms: [], subgroups: [],
};
const period = (id: string, kind: "holiday" | "day-off" | "study", groupIds: string[] | null = null, date = "2026-10-05") => ({
  id, name: id, kind, startDate: date, endDate: date, groupIds,
});
const day = (date: string, holiday = false, slots = [[{ id: `${date}-lesson`, subjectId: "math", jointId: "joint-1" }]]) => ({
  date, start: "08:30", duration: 45, breaks: [10], slots, times: [{ start: 510, duration: 45 }], holiday, note: "legacy note",
});

test("materialized date axis returns a complete seven-day week", () => {
  const dates = weekDates(0);
  assert.equal(dates.length, 7);
  assert.equal(dates[0], "2026-10-05");
  assert.equal(dates[6], "2026-10-11");
});

test("calendar validates weekdays, date ranges, unique IDs and selected groups", () => {
  const calendar = defaultSchoolCalendar();
  assert.equal(validateCalendar(calendar, catalog), null);
  assert.match(validateCalendar({ ...calendar, weekdays: [] }, catalog) ?? "", /хотя бы один/);
  assert.match(validateCalendar({ ...calendar, periods: [period("x", "holiday"), period("x", "study")] }, catalog) ?? "", /уникальны/);
  assert.match(validateCalendar({ ...calendar, periods: [{ ...period("x", "holiday"), startDate: "2026-02-30" }] }, catalog) ?? "", /реальные даты/);
  assert.match(validateCalendar({ ...calendar, periods: [{ ...period("x", "holiday"), groupIds: [] }] }, catalog) ?? "", /хотя бы одну/);
  assert.match(validateCalendar({ ...calendar, periods: [{ ...period("x", "holiday"), groupIds: ["missing"] }] }, catalog) ?? "", /неизвестную/);
  assert.match(validateCalendar({ ...calendar, groupWeekdays: { missing: [1, 2] } }, catalog) ?? "", /неизвестную группу/);
  assert.match(validateCalendar({ ...calendar, groupWeekdays: { "5a": [] } }, catalog) ?? "", /выберите уникальные/);
  assert.match(validateCalendar({ ...calendar, groupWeekdays: { "5a": [1, 1] } }, catalog) ?? "", /уникальные/);
});

test("calendar precedence is scoped first and explicit study overrides weekends", () => {
  const calendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [period("global-study", "study"), period("global-holiday", "holiday"), period("group-study", "study", ["5a"]), period("group-day-off", "day-off", ["5a"])],
  };
  assert.equal(calendarDay(calendar, "5a", "2026-10-05").kind, "study");
  const weekend = { weekdays: [1, 2, 3, 4, 5], periods: [period("sat-study", "study", null, "2026-10-10")] };
  const saturday = calendarDay(weekend, "5b", "2026-10-10");
  assert.equal(saturday.kind, "study");
  assert.equal(saturday.holiday, false);
  assert.equal(calendarDay(defaultSchoolCalendar(), "5b", "2026-10-10").kind, "weekend");
});

test("groups can have different regular weekdays while explicit date periods still take priority", () => {
  const calendar = {
    weekdays: [1, 2, 3, 4, 5],
    groupWeekdays: { "5a": [1, 2, 3, 4, 5], "5b": [1, 2, 3, 4, 5, 6] },
    periods: [period("group-holiday", "holiday", ["5b"], "2026-10-10")],
  };
  assert.deepEqual(studyWeekdays(calendar, "5a"), [1, 2, 3, 4, 5]);
  assert.deepEqual(studyWeekdays(calendar, "5b"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(studyWeekdays(calendar, "unknown"), [1, 2, 3, 4, 5]);
  assert.equal(calendarDay(calendar, "5a", "2026-10-10").kind, "weekend");
  assert.equal(calendarDay(calendar, "5b", "2026-10-10").kind, "holiday");
  assert.equal(calendarDay(calendar, "5b", "2026-10-17").kind, "regular");
});

test("legacy holidays are merged by consecutive date per group and keep a stable label", () => {
  const schedule: Schedule = { "5a:0": [day("2026-10-05", true), day("2026-10-06", true), day("2026-10-08", true)] };
  const migrated = calendarFromSchedule(schedule);
  assert.equal(migrated.periods.length, 2);
  assert.deepEqual(migrated.periods[0], {
    id: "legacy:5a:2026-10-05:2026-10-06", name: "legacy note", kind: "holiday",
    startDate: "2026-10-05", endDate: "2026-10-06", groupIds: ["5a"],
  });
  assert.deepEqual(calendarFromSchedule(schedule).periods.map((item) => item.id), migrated.periods.map((item) => item.id));
});

test("applying non-study period clears only scoped lessons and preserves joint mirrors and day geometry", () => {
  const schedule: Schedule = {
    "5a:0": [day("2026-10-05", false)],
    "5b:0": [day("2026-10-05", false)],
  };
  const calendar = { weekdays: [1, 2, 3, 4, 5], periods: [{ ...period("holiday", "holiday"), groupIds: ["5a"] }] };
  const result = applyCalendar(schedule, calendar);
  assert.equal(result.removedCount, 1);
  assert.equal(result.changedDays[0].groupId, "5a");
  assert.equal(result.schedule["5a:0"][0].slots[0].length, 0);
  assert.equal(result.schedule["5b:0"][0].slots[0].length, 1);
  assert.equal(result.schedule["5a:0"][0].times[0].start, 510);
  assert.equal(result.schedule["5a:0"][0].note, "legacy note");
  assert.deepEqual(result.jointChanges, [{ jointId: "joint-1", removedGroupIds: ["5a"], remainingGroupIds: ["5b"] }]);
  assert.equal(schedule["5a:0"][0].slots[0].length, 1, "input schedule is not mutated");
});

test("regular weekday without a legacy holiday flag is not reported as changed", () => {
  const { holiday: _holiday, ...regular } = day("2026-10-05", false, [[]]);
  const result = applyCalendar({ "5a:0": [regular] }, defaultSchoolCalendar());
  assert.equal(result.schedule["5a:0"][0].holiday, false);
  assert.deepEqual(result.changedDays, []);
  assert.equal(result.removedCount, 0);
});

test("study exception clears holiday marker and counts an explicit override", () => {
  const schedule: Schedule = { "5a:0": [day("2026-10-10", true, [[]])] };
  const result = applyCalendar(schedule, { weekdays: [1, 2, 3, 4, 5], periods: [period("study", "study", null, "2026-10-10")] });
  assert.equal(result.studyOverrideCount, 1);
  assert.equal(result.schedule["5a:0"][0].holiday, false);
  assert.equal(result.schedule["5a:0"][0].slots.length, 1);
});
