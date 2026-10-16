import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { canPlace, editLesson, moveLesson, placeLesson, swapLessons, transferTeacherLesson, roomOccupancies, type Schedule, type Location } from "../src/editor.ts";
import { choosePlacementRoom } from "../src/roomChoice.ts";
import { applyDayTiming } from "../shared/dayTiming.ts";
import { applyBellSettings, defaultBellSettings } from "../shared/bellSchedule.ts";
import { applyServiceEvent } from "../shared/serviceEvents.ts";
import { newUnavailabilityViolation } from "../shared/unavailability.ts";

const date = "2026-10-12";
const rule = { id: "sick", startDate: date, endDate: date, start: 600, end: 1440, reason: "Больничный" };
const catalog: Catalog = {
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
  teachers: ["absent", "free"].map(id => ({ id, name: id, subjectIds: ["math"], defaultRoomId: "closed", archived: false, unavailability: id === "absent" ? [rule] : [] })),
  rooms: ["closed", "open"].map(id => ({ id, name: id, kind: "general" as const, capacity: 30, archived: false, unavailability: id === "closed" ? [{ ...rule, id: "repair", reason: "Ремонт" }] : [] })),
  groups: [{ id: "g", name: "5А", students: 20, archived: false, roomId: "open", leaderId: null, autoRoomIds: [] }], subgroups: [],
};
const loc = (slot = 1): Location => ({ groupId: "g", weekOffset: 0, date, slot });
const lesson = (id = "saved", teacherId = "absent", roomId = "open") => ({ id, subjectId: "math", teacherId, teacher: teacherId, roomId, room: roomId });
function empty(): Schedule { return { "g:0": [{ date, start: "09:00", duration: 45, breaks: [15], times: [{ start: 540, duration: 45 }, { start: 600, duration: 45 }], slots: [[], []] }] }; }

test("manual placement rejects absent teachers and closed rooms; touching boundaries is allowed", () => {
  const previous = empty();
  assert.match(canPlace(previous, loc(), lesson(), undefined, catalog)!, /Больничный/);
  assert.throws(() => placeLesson(previous, loc(), lesson(), catalog), /Больничный/);
  assert.throws(() => placeLesson(previous, loc(), lesson("room", "free", "closed"), catalog), /Ремонт/);
  assert.equal(canPlace(previous, loc(0), lesson(), undefined, catalog), null);
  assert.deepEqual(previous, empty());
});

test("saved sick leave lesson can retain notes/time but cannot be extended or restored after replacement", () => {
  const previous = empty(); previous["g:0"][0].slots[1] = [lesson()];
  const fields = { teacherId: "absent", teacher: "absent", roomId: "open", room: "open", note: "Замену ищем" };
  assert.equal(editLesson(previous, loc(), "saved", fields, undefined, catalog)["g:0"][0].slots[1][0].note, fields.note);
  assert.throws(() => editLesson(previous, loc(), "saved", fields, { start: 600, duration: 50, shiftFollowing: false }, catalog), /Больничный/);
  const replacement = editLesson(previous, loc(), "saved", { ...fields, teacherId: "free", teacher: "free" }, undefined, catalog);
  assert.match(newUnavailabilityViolation(previous, replacement, catalog)!.message, /Больничный/);
  assert.equal(newUnavailabilityViolation(roomOccupancies(previous), roomOccupancies(previous), catalog), undefined);
});

test("move, swap and teacher transfer cannot introduce unavailable assignments", () => {
  const previous = empty(); previous["g:0"][0].slots[0] = [lesson()];
  assert.throws(() => moveLesson(previous, loc(0), "saved", loc(), catalog), /Больничный/);
  previous["g:0"][0].slots[1] = [lesson("other", "free")];
  assert.throws(() => swapLessons(previous, loc(0), "saved", loc(), catalog), /Больничный/);
  assert.throws(() => transferTeacherLesson(empty(), loc(), lesson(), catalog), /Больничный/);
});

test("automatic room placement skips a closed preferred room", () => {
  assert.equal(choosePlacementRoom(empty(), loc(), lesson("new", "free", "closed"), catalog).roomId, "open");
});

test("daily and global timings reject new sick leave intersections", () => {
  const previous = empty(); previous["g:0"][0].slots[0] = [lesson()];
  assert.throws(() => applyDayTiming(previous, { date, groupIds: ["g"], currentGroupId: "g", start: 600, duration: 45, schoolProfile: { start: 540, duration: 45, breaks: [15] } }, catalog), /Больничный/);
  const settings = defaultBellSettings(); settings.school.start = 600;
  assert.throws(() => applyBellSettings(previous, settings, { groupIds: ["g"], startDate: date, endDate: date, replaceStart: true, resetBreaks: true }, catalog), /Больничный/);
});

test("new service events check responsible teachers and rooms", () => {
  const input = { date, groupIds: ["g"], event: "Линейка", start: 600, duration: 45 };
  assert.throws(() => applyServiceEvent(empty(), catalog, { ...input, teacherId: "absent", roomId: "open" }), /Больничный/);
  assert.throws(() => applyServiceEvent(empty(), catalog, { ...input, teacherId: "free", roomId: "closed" }), /Ремонт/);
});
