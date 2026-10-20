import assert from "node:assert/strict";
import { test } from "node:test";
import { groupGrade, matchesSchoolStage, shiftStudentDate, sortDayGroups } from "../shared/studentDayNavigation.ts";
import type { PublicStudentDay } from "../shared/studentTypes.ts";

test("school filters include all grades at each boundary and preserve non-class groups in all", () => {
  const names = ["1А", "4Б", "5А", "9В", "10А", "11Б", "12А", "Хор"];
  assert.deepEqual(names.filter(name => matchesSchoolStage(name, "primary")), ["1А", "4Б"]);
  assert.deepEqual(names.filter(name => matchesSchoolStage(name, "middle")), ["5А", "9В"]);
  assert.deepEqual(names.filter(name => matchesSchoolStage(name, "high")), ["10А", "11Б"]);
  assert.deepEqual(names.filter(name => matchesSchoolStage(name, "all")), names);
  assert.equal(groupGrade(" 11 В"), 11);
  assert.equal(groupGrade("Хор"), undefined);
});

test("groups sort by grade and Russian letter, grouping joint lessons only within their grade", () => {
  const group = (name: string, participants: string[] = [], holiday = false) => ({ id: name, name, day: {
    date: "2026-10-19", slotCount: 1, holiday,
    lessons: participants.length ? [{ id: name, slot: 1, start: 480, duration: 45, lessonKind: "regular", jointGroups: participants.map(name => ({ id: name, name })) }] : [],
  } as PublicStudentDay });
  const groups = [group("10А"), group("1В", ["1А"]), group("2А"), group("1Б"), group("1А", ["1В", "2А"]), group("Хор")];
  assert.deepEqual(sortDayGroups(groups).map(group => group.name), ["1А", "1В", "1Б", "2А", "10А", "Хор"]);
  assert.deepEqual(groups.map(group => group.name), ["10А", "1В", "2А", "1Б", "1А", "Хор"], "do not mutate input");
  assert.deepEqual(sortDayGroups([group("1В"), group("1Б"), group("1А")]).map(group => group.name), ["1А", "1Б", "1В"]);
  assert.deepEqual(sortDayGroups([group("1В", ["1А"], true), group("1Б"), group("1А")]).map(group => group.name), ["1А", "1Б", "1В"], "holiday lessons do not change the order");
});

test("joint components remain deterministic through cycles and absent filtered participants", () => {
  const groups = ["1Г", "1Б", "1В", "1А"].map(name => ({ id: name, name, day: {
    date: "2026-10-19", slotCount: 1, holiday: false,
    lessons: [{ id: name, slot: 1, start: 480, duration: 45, lessonKind: "regular", jointGroups: ["1А", "1В", "1Г", "missing"].map(name => ({ id: name, name })) }],
  } as PublicStudentDay }));
  assert.deepEqual(sortDayGroups(groups).map(group => group.name), ["1А", "1Б", "1В", "1Г"]);
  assert.deepEqual(sortDayGroups([...groups].reverse()), sortDayGroups(groups));
});

test("day arrows cross month, year and leap-day boundaries without timezone shifts", () => {
  assert.equal(shiftStudentDate("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftStudentDate("2027-01-01", -1), "2026-12-31");
  assert.equal(shiftStudentDate("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftStudentDate("2028-03-01", -1), "2028-02-29");
});
