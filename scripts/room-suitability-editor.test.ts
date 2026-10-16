import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import {
  canPlace,
  editLesson,
  moveLesson,
  placeLesson,
  swapLessons,
  transferTeacherLesson,
  type EditorDay,
  type EditorLesson,
  type Location,
  type Schedule,
} from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [
    { id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: "general", labRoomKind: "physics-lab", archived: false },
    { id: "english", name: "Английский", shortName: "Англ.", color: "green", roomKind: "general", labRoomKind: null, archived: false },
  ],
  teachers: [{ id: "teacher", name: "Иванов", archived: false, subjectIds: ["math", "english"], defaultRoomId: null }],
  rooms: [
    { id: "small", name: "Малый кабинет", kind: "general", capacity: 15, archived: false },
    { id: "lab", name: "Лаборатория", kind: "physics-lab", capacity: 40, archived: false },
    { id: "large", name: "Большой кабинет", kind: "general", capacity: 50, archived: false },
  ],
  groups: ["5a", "5b"].map((id) => ({ id, name: id.toUpperCase(), students: 20, autoRoomIds: [], leaderId: null, roomId: null, archived: false })),
  subgroups: [{ id: "5a-1", groupId: "5a", name: "1", students: 10, archived: false }],
};

function day(date: string, slots: EditorLesson[][] = [[], []]): EditorDay {
  return { date, start: "09:00", duration: 45, breaks: [10], slots, times: [{ start: 540, duration: 45 }, { start: 595, duration: 45 }] };
}
function schedule(entries: Array<[string, EditorDay[]]>): Schedule {
  return Object.fromEntries(entries.map(([group, days]) => [`${group}:0`, days]));
}
function location(groupId: string, date = "2026-10-12", slot = 0): Location { return { groupId, weekOffset: 0, date, slot }; }
function lesson(id: string, patch: Partial<EditorLesson> = {}): EditorLesson {
  return { id, subjectId: "math", lessonKind: "regular", teacher: "Иванов", teacherId: "teacher", room: "Большой кабинет", roomId: "large", ...patch };
}
test("placement preview and placement reject a room with the wrong lesson type", () => {
  const empty = schedule([["5a", [day("2026-10-12")]]]);
  const loc = location("5a");
  const candidate = { subjectId: "math", lessonKind: "regular" as const, teacher: "Иванов", teacherId: "teacher", room: "Лаборатория", roomId: "lab" };
  assert.match(canPlace(empty, loc, candidate, undefined, catalog)!, /тип/);
  assert.throws(() => placeLesson(empty, loc, candidate, catalog), /тип/);
  assert.equal(empty["5a:0"][0].slots[0].length, 0);
});

test("capacity is checked against whole group and subgroup sizes", () => {
  const empty = schedule([["5a", [day("2026-10-12")]]]);
  const whole = { subjectId: "english", teacher: "Иванов", teacherId: "teacher", room: "Малый кабинет", roomId: "small" };
  assert.match(canPlace(empty, location("5a"), whole, undefined, catalog)!, /участников: 20/);
  assert.equal(canPlace(empty, location("5a"), { ...whole, subgroupId: "5a-1", subgroup: "5A/1" }, undefined, catalog), null);
});

test("a move may retain a legacy mismatch, while a room change in an edit is blocked", () => {
  const old = lesson("legacy", { subjectId: "english", room: "Малый кабинет", roomId: "small" });
  const previous = schedule([["5a", [day("2026-10-12", [[old], []])]]]);
  assert.doesNotThrow(() => moveLesson(previous, location("5a"), old.id, location("5a", "2026-10-12", 1), catalog));
  assert.throws(() => editLesson(previous, location("5a"), old.id, { teacher: "Иванов", teacherId: "teacher", room: "Лаборатория", roomId: "lab", note: "" }, undefined, catalog), /тип/);
});

test("swap preserves a legacy mismatch using the original schedule as its baseline", () => {
  const first = lesson("first", { subjectId: "math", room: "Малый кабинет", roomId: "small" });
  const second = lesson("second", { subjectId: "english", room: "Большой кабинет", roomId: "large" });
  const previous = schedule([["5a", [day("2026-10-12", [[first], []]), day("2026-10-13", [[], [second]])]]]);
  const swapped = swapLessons(previous, location("5a"), first.id, location("5a", "2026-10-13", 1), catalog);
  assert.equal(swapped["5a:0"][1].slots[1][0].id, first.id);
  assert.equal(previous["5a:0"][0].slots[0][0].id, "first");
});

test("teacher transfer rejects an unsuitable destination without removing conflicts", () => {
  const previous = schedule([["5a", [day("2026-10-12")]], ["5b", [day("2026-10-12", [[lesson("busy")], []])]]]);
  const candidate = { subjectId: "math", teacher: "Иванов", teacherId: "teacher", room: "Лаборатория", roomId: "lab" };
  assert.throws(() => transferTeacherLesson(previous, location("5a"), candidate, catalog), /тип/);
  assert.equal(previous["5b:0"][0].slots[0][0].id, "busy");
});

test("changing a joint lesson room checks the combined participant count", () => {
  const a = lesson("joint-a", { subjectId: "english", room: "Неизвестен", roomId: undefined, jointId: "shared" });
  const b = lesson("joint-b", { subjectId: "english", room: "Неизвестен", roomId: undefined, jointId: "shared" });
  const previous = schedule([["5a", [day("2026-10-12", [[a], []])]], ["5b", [day("2026-10-12", [[b], []])]]]);
  assert.throws(() => editLesson(previous, location("5a"), a.id, { teacher: "Иванов", teacherId: "teacher", room: "Малый кабинет", roomId: "small", note: "" }, undefined, catalog), /участников: 40/);
  assert.equal(previous["5a:0"][0].slots[0][0].roomId, undefined);
});
