import assert from "node:assert/strict";
import { chooseStudentLocation, isValidIsoDate, mondayOf, nearestLessonDate, weekDatesFor } from "../shared/studentNavigation.ts";
import type { PublicStudentQuarter } from "../shared/studentTypes.ts";

const q = (id: string, startDate: string, endDate: string, dates: string[]): PublicStudentQuarter => ({
  id, name: id, startDate, endDate, publication: { version: 1, publishedAt: "2026-01-01T00:00:00.000Z" },
  groups: [{ id: "5a", name: "5А", lessonDates: dates }],
});

const first = q("q1", "2026-09-01", "2026-10-30", ["2026-09-01", "2026-09-07", "2026-09-14", "2026-10-16", "2026-10-26"]);
const second = q("q2", "2026-11-01", "2026-12-25", ["2026-11-02", "2026-11-09"]);

assert.equal(mondayOf("2026-10-12"), "2026-10-12");
assert.deepEqual(weekDatesFor("2026-10-14"), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
assert.equal(nearestLessonDate(["2026-10-01", "2026-10-14", "2026-10-20"], "2026-10-15"), "2026-10-20");
assert.equal(nearestLessonDate(["2026-10-01", "2026-10-14"], "2026-10-15"), "2026-10-14", "when no future lessons, keep the latest past week selectable");
assert.equal(isValidIsoDate("2026-10-09"), true);
assert.equal(isValidIsoDate("2026-10-99"), false);
assert.equal(isValidIsoDate("2026-02-29"), false);

assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-14", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-14",
}, "stay on current week when it has published lessons");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-19", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-26",
}, "vacation/non-study week advances to the nearest lesson week");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-17", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-26",
}, "weekend after the final published lesson advances to the next teaching week");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-14", storedGroup: "5a", todayIsVacation: true }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-16",
}, "a calendar vacation day advances to the next published lesson date");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-31", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q2", date: "2026-11-02",
}, "when quarter ends, choose the next published quarter with lessons");
assert.deepEqual(chooseStudentLocation([first], { today: "2026-11-01", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-26",
}, "when there are no future lessons, keep the last published week navigable");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-11-20", queryQuarter: "q1", queryGroup: "5a", queryDate: "2026-09-14" }), {
  groupId: "5a", quarterId: "q1", date: "2026-09-14",
}, "a shared manual location takes precedence over automatic current-week selection");
assert.deepEqual(chooseStudentLocation([first, second], { today: "2026-10-14", queryQuarter: "q1", queryGroup: "invalid", storedGroup: "5a" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-16",
}, "an invalid URL group falls back to the remembered group");
assert.deepEqual(chooseStudentLocation([first], { today: "2026-10-14", queryQuarter: "q1", queryGroup: "5a", queryDate: "2026-10-99" }), {
  groupId: "5a", quarterId: "q1", date: "2026-10-16",
}, "invalid URL dates are ignored");
const emptyGroupQuarter = { ...first, groups: [...first.groups, { id: "5b", name: "5Б", lessonDates: [] }] };
assert.deepEqual(chooseStudentLocation([emptyGroupQuarter], { today: "2026-10-14", queryQuarter: "q1", queryGroup: "5b" }), {
  groupId: "5b", quarterId: "q1", date: "2026-10-14",
}, "keep an explicitly selected group even when it has no lessons");
assert.deepEqual(chooseStudentLocation([emptyGroupQuarter], { today: "2026-10-14", queryGroup: "5b" }), {
  groupId: "5b", quarterId: "q1", date: "2026-10-14",
}, "keep an empty class on today's date without an explicit quarter");
const futureEmpty = q("q3", "2027-01-11", "2027-03-20", []);
assert.deepEqual(chooseStudentLocation([futureEmpty], { today: "2026-12-20", queryQuarter: "q3", queryGroup: "5a" }), {
  groupId: "5a", quarterId: "q3", date: "2027-01-11",
}, "clamp an empty future quarter selection to its first date");

console.log("student navigation tests passed");
