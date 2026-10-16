import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { editorSubjects, teacherChoices, preferredRoomIds } from "../src/catalogAdapter.ts";
import { choosePlacementRoom } from "../src/roomChoice.ts";
import type { Schedule } from "../src/editor.ts";

function fixture() {
  const catalog: Catalog = {
    subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: "physics-lab", archived: false }],
    teachers: [{ id: "t", name: "Иванов Иван", subjectIds: ["math"], defaultRoomId: "default", archived: false }],
    groups: [{ id: "g", name: "5А", students: 20, roomId: "small", autoRoomIds: ["free"], leaderId: null, archived: false }],
    rooms: [
      { id: "default", name: "101", kind: "general", capacity: 30, archived: false },
      { id: "small", name: "102", kind: "general", capacity: 15, archived: false },
      { id: "free", name: "103", kind: "general", capacity: null, archived: false },
      { id: "lab", name: "104", kind: "physics-lab", capacity: 25, archived: false },
    ],
    subgroups: [{ id: "sg", name: "1", groupId: "g", students: 10, archived: false }],
  };
  const subjects = (kind: "regular" | "lab" = "regular", subgroupId: string | null = null) => editorSubjects(catalog, "g", "q", [{
    id: "plan", quarterId: "q", groupId: "g", subjectId: "math", lessonKind: kind,
    mode: subgroupId ? "subgroups" : "whole", assignments: [{ id: "assignment", subgroupId, target: 10 }],
  }])[0];
  return { catalog, subjects };
}

test("automatic room choice retains valid teacher preference and skips undersized or wrong-type defaults", () => {
  const { catalog, subjects } = fixture();
  assert.equal(teacherChoices(catalog, subjects())[0].roomId, "default");
  assert.equal(teacherChoices(catalog, subjects("lab"))[0].roomId, "lab");
  catalog.teachers[0].defaultRoomId = "small";
  assert.equal(teacherChoices(catalog, subjects())[0].roomId, "free");
  assert.equal(teacherChoices(catalog, subjects("regular", "sg"))[0].roomId, "small");
});

test("an explicit unsuitable room remains visible with a reason instead of being silently replaced", () => {
  const { catalog, subjects } = fixture();
  const choice = teacherChoices(catalog, subjects(), "small")[0];
  assert.equal(choice.roomId, "small");
  assert.equal(choice.unavailable, true);
  assert.match(choice.reason, /15.*20/);
  assert.equal(teacherChoices(catalog, subjects("regular", "sg"), "small")[0].unavailable, false);
  assert.match(teacherChoices(catalog, subjects("lab"), "default")[0].reason, /Лаборатория физики/);
});

test("automatic placement chooses a suitable free room using real destination time", () => {
  const { catalog } = fixture();
  const schedule: Schedule = {
    "g:0": [{ date: "2026-10-12", start: "09:00", duration: 45, breaks: [], slots: [[]], times: [{ start: 540, duration: 45 }] }],
    "peer:0": [{ date: "2026-10-12", start: "09:00", duration: 45, breaks: [], slots: [[{ id: "busy", subjectId: "math", roomId: "default" }]], times: [{ start: 540, duration: 45 }] }],
  };
  const lesson = { subjectId: "math", teacherId: "t", roomId: "default" };
  const before = structuredClone(schedule);
  const placed = choosePlacementRoom(schedule, { groupId: "g", weekOffset: 0, date: "2026-10-12", slot: 0 }, lesson, catalog);
  assert.equal(placed.roomId, "free");
  assert.deepEqual(schedule, before);
  assert.equal(lesson.roomId, "default");
  schedule["peer:0"][0].times[0].start = 585;
  assert.equal(choosePlacementRoom(schedule, { groupId: "g", weekOffset: 0, date: "2026-10-12", slot: 0 }, lesson, catalog).roomId, "default");
});

test("no compatible room disables candidates with a visible explanation", () => {
  const { catalog, subjects } = fixture();
  catalog.rooms.find((room) => room.id === "lab")!.archived = true;
  const choice = teacherChoices(catalog, subjects("lab"))[0];
  assert.equal(choice.unavailable, true);
  assert.match(choice.reason, /Нет подходящего кабинета/);
});

test("room preference order is teacher, group, marked rooms, then the remaining active rooms", () => {
  const { catalog } = fixture();
  catalog.rooms.push({ id: "other", name: "105", kind: "general", capacity: 30, archived: false });
  assert.deepEqual(preferredRoomIds(catalog, "g", "t"), ["default", "small", "free", "lab", "other"]);
  catalog.groups[0].roomId = null;
  assert.equal(preferredRoomIds(catalog, "g", "t")[0], "default");
  catalog.teachers[0].defaultRoomId = null;
  assert.equal(preferredRoomIds(catalog, "g", "t")[0], "free");
  catalog.groups[0].roomId = "default";
  catalog.groups[0].autoRoomIds = ["default", "free"];
  catalog.teachers[0].defaultRoomId = "default";
  assert.equal(preferredRoomIds(catalog, "g", "t").filter(id => id === "default").length, 1);
});

test("manual room choice falls through each preference when preceding rooms are unavailable", () => {
  const { catalog } = fixture();
  catalog.rooms.find(room => room.id === "small")!.capacity = 30;
  catalog.rooms.push({ id: "other", name: "105", kind: "general", capacity: 30, archived: false });
  const date = "2026-10-12";
  const schedule: Schedule = { "g:0": [{ date, start: "09:00", duration: 45, breaks: [], slots: [[]], times: [{ start: 540, duration: 45 }] }] };
  const location = { groupId: "g", weekOffset: 0, date, slot: 0 };
  const lesson = { subjectId: "math", teacherId: "t" };
  const chosen = () => choosePlacementRoom(schedule, location, lesson, catalog).roomId;
  assert.equal(chosen(), "default");
  for (const [id, expected] of [["default", "small"], ["small", "free"], ["free", "other"]]) {
    catalog.rooms.find(room => room.id === id)!.unavailability = [{ id: `closed-${id}`, startDate: date, endDate: date, start: 0, end: 1440 }];
    assert.equal(chosen(), expected);
  }
});

test("class leader's gym does not influence another teacher's ordinary lessons", () => {
  const { catalog, subjects } = fixture();
  catalog.rooms.push({ id: "gym", name: "Спортзал", kind: "gym", capacity: 40, archived: false });
  catalog.teachers.push({ id: "pe", name: "Физрук", archived: false, defaultRoomId: "gym", subjectIds: [] });
  catalog.groups[0].leaderId = "pe";
  assert.equal(teacherChoices(catalog, subjects())[0].roomId, "default");
  catalog.teachers[0].defaultRoomId = "gym";
  catalog.rooms.find(room => room.id === "small")!.capacity = 30;
  assert.equal(teacherChoices(catalog, subjects())[0].roomId, "small", "an unsuitable teacher default also falls through to the group room");
});
