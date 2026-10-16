import assert from "node:assert/strict";
import {
  findUnavailability,
  lessonUnavailability,
  newUnavailabilityViolation,
  scheduledUnavailability,
  validateUnavailabilityRules,
  unavailabilityViolationMessage,
  type UnavailabilityRule,
} from "../shared/unavailability.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Schedule } from "../src/editor.ts";

const rule = (id: string, startDate = "2026-10-12", endDate = startDate, start = 0, end = 1440, weekdays?: number[]): UnavailabilityRule => ({ id, startDate, endDate, start, end, ...(weekdays ? { weekdays } : {}) });
const catalog: Catalog = {
  subjects: [],
  teachers: [{ id: "t", name: "Иванов Иван", archived: false, subjectIds: [], defaultRoomId: null, unavailability: [rule("t-day", "2026-10-12", "2026-10-13", 600, 700), rule("weekly", "2026-10-12", "2026-10-30", 800, 900, [1])] }],
  rooms: [{ id: "r", name: "101", archived: false, capacity: null, kind: "general", unavailability: [rule("r-day", "2026-10-12", "2026-10-12", 650, 720)] }],
  groups: ["g1", "g2"].map(id => ({ id, name: id, archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] })),
  subgroups: [{ id: "sg", name: "А", groupId: "g1", archived: false, students: 10 }],
};

function schedule(date = "2026-10-12", start = 590, duration = 30, teacherId: string | undefined = "t", roomId: string | undefined = "r"): Schedule {
  const lesson = { id: "l1", subjectId: "s", teacherId, roomId, teacher: "Иванов", room: "101" };
  const day = { date, start: "09:50", duration, breaks: [], times: [{ start, duration }], slots: [[lesson]] };
  return { "g1:0": [day] };
}

assert.equal(validateUnavailabilityRules(undefined), null);
assert.equal(validateUnavailabilityRules([rule("x", "2026-02-30")]), "Укажите корректный период недоступности");
assert.match(validateUnavailabilityRules([rule("x"), rule("x")]) ?? "", /уникальными/);
assert.match(validateUnavailabilityRules([rule(" x")]) ?? "", /Идентификаторы/);
assert.match(validateUnavailabilityRules([rule(`${"x".repeat(101)}`)]) ?? "", /не более 100/);
assert.equal(validateUnavailabilityRules([rule("r1")]), null);
assert.equal(validateUnavailabilityRules([rule("x", "2026-10-12", "2026-10-12", 0, 1440)]), null);
assert.equal(validateUnavailabilityRules([rule("x", "2026-10-12", "2026-10-12", 1439, 1440)]), null);
assert.match(validateUnavailabilityRules([{ ...rule("x"), weekdays: [0] }]) ?? "", /день недели/);
assert.match(validateUnavailabilityRules([{ ...rule("x"), weekdays: [] }]) ?? "", /хотя бы один/);
assert.match(validateUnavailabilityRules([{ ...rule("x"), weekdays: [1, 1] }]) ?? "", /уникальный день/);
assert.equal(validateUnavailabilityRules([{ ...rule("x"), reason: "x".repeat(301) }]), "Причина недоступности не должна превышать 300 символов");
assert.equal(validateUnavailabilityRules(Array.from({ length: 201 }, (_, i) => rule(String(i)))), "Нельзя добавить больше 200 ограничений недоступности");

assert.deepEqual(findUnavailability(catalog, "teacher", "t", "2026-10-12", 550, 600), []); // touching boundary
assert.deepEqual(findUnavailability(catalog, "teacher", "t", "2026-10-12", 590, 610).map(x => [x.ruleId, x.start, x.end]), [["t-day", 600, 610]]);
assert.deepEqual(findUnavailability(catalog, "teacher", "t", "2026-10-19", 810, 820).map(x => x.ruleId), ["weekly"]);
assert.deepEqual(findUnavailability(catalog, "teacher", "t", "2026-10-20", 810, 820), []);
assert.deepEqual(findUnavailability(catalog, "teacher", "t", "2026-10-14", 1000, 1100), []);
assert.equal(lessonUnavailability(catalog, { date: "2026-10-12", start: 660, end: 680, teacherId: "t", roomId: "r" }).length, 2);
assert.equal(lessonUnavailability(catalog, { date: "2026-10-12", start: 660, end: 680, teacher: "Иванов Иван", room: "101" }).length, 2);

const oldConflict = schedule("2026-10-12", 590, 100); // overlaps both teacher and room
assert.equal(scheduledUnavailability(oldConflict, catalog).length, 2);
const shrunk = schedule("2026-10-12", 600, 10); // same overlap, still historic
assert.equal(newUnavailabilityViolation(shrunk, oldConflict, catalog), undefined);
assert.equal(newUnavailabilityViolation(schedule("2026-10-12", 580, 120), oldConflict, catalog)?.kind, "teacher");
assert.equal(newUnavailabilityViolation(schedule("2026-10-13", 590, 30), oldConflict, catalog)?.date, "2026-10-13");
assert.equal(newUnavailabilityViolation(schedule("2026-10-12", 590, 30, undefined, "r"), oldConflict, catalog), undefined); // teacher removal shrinks violations
assert.equal(newUnavailabilityViolation(schedule("2026-10-12", 590, 30, undefined, undefined), oldConflict, catalog), undefined);
const changedResource = schedule("2026-10-12", 640, 40, "unknown", "r");
changedResource["g1:0"]![0]!.slots[0]![0]!.teacher = undefined;
const priorWithoutRoom = schedule("2026-10-12", 640, 40, undefined, undefined);
priorWithoutRoom["g1:0"]![0]!.slots[0]![0]!.room = undefined;
priorWithoutRoom["g1:0"]![0]!.slots[0]![0]!.roomId = undefined;
priorWithoutRoom["g1:0"]![0]!.slots[0]![0]!.teacher = undefined;
priorWithoutRoom["g1:0"]![0]!.slots[0]![0]!.teacherId = undefined;
assert.equal(newUnavailabilityViolation(changedResource, priorWithoutRoom, catalog)?.kind, "room");
assert.match(unavailabilityViolationMessage(scheduledUnavailability(oldConflict, catalog)[0]!, catalog), /группа g1/);

const mirrors = schedule("2026-10-12", 590, 100);
const mirrorDay = structuredClone(mirrors["g1:0"]![0]!);
mirrorDay.slots[0]![0]!.jointId = "joint";
const mirroredDay = structuredClone(mirrorDay);
mirrors["g1:0"]![0] = mirrorDay;
mirrors["g2:0"] = [mirroredDay];
assert.equal(scheduledUnavailability(mirrors, catalog).length, 4); // teacher and room for each joint mirror
const subgroupMirror = structuredClone(mirrors);
subgroupMirror["g1:0"]![0]!.slots[0]![0]!.subgroupId = "sg";
assert.equal(scheduledUnavailability(subgroupMirror, catalog).length, 4);
assert.equal(newUnavailabilityViolation(subgroupMirror, mirrors, catalog), undefined);
assert.equal(newUnavailabilityViolation(mirrors, structuredClone(mirrors), catalog), undefined);

console.log("unavailability: 18 checks passed");
