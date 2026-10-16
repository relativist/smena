import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import {
  teacherPlacementConflicts,
  transferTeacherLesson,
  type EditorDay,
  type EditorLesson,
  type Location,
  type Schedule,
} from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", archived: false, color: "blue", roomKind: null, labRoomKind: null }],
  teachers: [{ id: "teacher", name: "Иванов Иван", archived: false, subjectIds: ["math"], defaultRoomId: null }],
  rooms: ["r1", "r2", "r3"].map((id) => ({ id, name: id, archived: false, kind: "general" as const, capacity: null })),
  groups: ["5a", "5b", "6a"].map((id) => ({ id, name: id, archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] })),
  subgroups: [],
};

function day(date: string, lessons: EditorLesson[] = []): EditorDay {
  return {
    date,
    start: "09:00",
    duration: 45,
    breaks: [],
    slots: [lessons],
    times: [{ start: 540, duration: 45 }],
  };
}

function schedule(entries: Array<[string, EditorLesson[]]>): Schedule {
  return Object.fromEntries(entries.map(([group, lessons]) => [`${group}:0`, [day("2026-10-12", lessons)]]));
}

const location = (groupId: string): Location => ({ groupId, weekOffset: 0, date: "2026-10-12", slot: 0 });
const lesson = (id: string, roomId = "r1", teacherId = "teacher"): EditorLesson => ({
  id,
  subjectId: "math",
  teacherId,
  roomId,
  teacher: "Иванов",
  room: roomId,
});

test("teacher preview returns every overlapping lesson and permits touching intervals", () => {
  const occupiedA = { ...lesson("a", "r2"), id: "a" };
  const occupiedB = { ...lesson("b", "r3"), id: "b" };
  const current = schedule([["5a", []], ["5b", [occupiedA]], ["6a", [occupiedB]]]);
  assert.deepEqual(teacherPlacementConflicts(current, location("5a"), lesson("new" )).map((conflict) => conflict.b.lessonId), ["a", "b"]);
  assert.equal(teacherPlacementConflicts(current, location("5a"), { ...lesson("no-room"), roomId: undefined }).length, 2);

  const adjacent: Schedule = {
    "5a:0": [day("2026-10-12")],
    "5b:0": [{ ...day("2026-10-12", [occupiedA]), times: [{ start: 585, duration: 45 }] }],
  };
  assert.deepEqual(teacherPlacementConflicts(adjacent, location("5a"), lesson("new")), []);
});

test("transfer removes an ordinary conflicting lesson from another group and places the candidate", () => {
  const previous = schedule([["5b", [lesson("conflict", "r2")]], ["5a", []]]);
  const next = transferTeacherLesson(previous, location("5a"), lesson("new"), catalog);
  assert.equal(next["5b:0"][0].slots[0].length, 0);
  assert.ok(next["5a:0"][0].slots[0][0].id);
  assert.equal(previous["5b:0"][0].slots[0][0].id, "conflict");
});

test("moving through a transfer keeps the source lesson id", () => {
  const previous = schedule([["5a", [lesson("source")]], ["5b", [lesson("conflict", "r2")]]]);
  const next = transferTeacherLesson(previous, { ...location("5a"), slot: 0 }, lesson("source"), catalog, {
    location: location("5a"),
    id: "source",
  });
  assert.equal(next["5a:0"][0].slots[0][0].id, "source");
  assert.equal(next["5b:0"][0].slots[0].length, 0);
});

test("a move uses the current source lesson and cannot cross groups", () => {
  const first = day("2026-10-12", [lesson("source")]);
  const second = day("2026-10-13");
  const previous: Schedule = { "5a:0": [first, second], "5b:0": [day("2026-10-13")] };
  const next = transferTeacherLesson(
    previous,
    { ...location("5a"), date: "2026-10-13" },
    lesson("source", "r2", "stale-teacher"),
    catalog,
    { location: location("5a"), id: "source" },
  );
  const moved = next["5a:0"][1].slots[0][0];
  assert.equal(moved.id, "source");
  assert.equal(moved.teacherId, "teacher");
  assert.equal(moved.roomId, "r1");
  assert.throws(
    () => transferTeacherLesson(
      previous,
      { ...location("5b"), date: "2026-10-13" },
      lesson("source"),
      catalog,
      { location: location("5a"), id: "source" },
    ),
    /другую группу/,
  );
});

test("a later room validation failure leaves the original schedule untouched", () => {
  const previous = schedule([
    ["5b", [lesson("teacher-conflict", "r2")]],
    ["6a", [lesson("room-conflict", "r1", "other-teacher")]],
    ["5a", []],
  ]);
  const snapshot = structuredClone(previous);
  assert.throws(() => transferTeacherLesson(previous, location("5a"), lesson("new"), catalog), /Кабинет/);
  assert.deepEqual(previous, snapshot);
});

test("transfer refuses to remove shared or event lessons, including a singleton joint id", () => {
  for (const protectedLesson of [
    { ...lesson("joint"), jointId: "joint-one" },
    { ...lesson("event"), event: "Линейка", subjectId: "event" },
  ]) {
    const previous = schedule([["5b", [protectedLesson]], ["5a", []]]);
    assert.throws(() => transferTeacherLesson(previous, location("5a"), lesson("new"), catalog), /Преподаватель/);
    assert.equal(previous["5b:0"][0].slots[0][0].id, protectedLesson.id);
  }
  assert.throws(() => transferTeacherLesson(schedule([["5a", []]]), location("5a"), { ...lesson("new"), jointId: "singleton" }, catalog), /совместное занятие/);
});
