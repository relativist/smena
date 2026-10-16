import test from "node:test";
import assert from "node:assert/strict";
import {
  findRoomConflict,
  newRoomConflict,
  roomConflictMessage,
  type RoomOccupancy,
} from "../shared/roomConflicts.ts";
import type { Catalog } from "../shared/catalog.ts";

const a: RoomOccupancy = {
  lessonId: "a",
  groupId: "5a",
  date: "2026-10-05",
  roomId: "r1",
  start: 510,
  end: 555,
};
const b: RoomOccupancy = {
  ...a,
  lessonId: "b",
  groupId: "5b",
  start: 555,
  end: 600,
};

test("room occupancy uses half-open intervals and separates dates and rooms", () => {
  assert.equal(findRoomConflict([b], a), undefined);
  assert.equal(findRoomConflict([{ ...b, date: "2026-10-06" }], a), undefined);
  assert.equal(findRoomConflict([{ ...b, roomId: "r2" }], a), undefined);
  assert.deepEqual(findRoomConflict([{ ...b, start: 550 }], a), {
    a,
    b: { ...b, start: 550 },
  });
});

test("only exact resource-matching mirrors of a joint lesson share a room", () => {
  const joint = {
    ...a,
    jointId: "joint:1",
    subjectId: "math",
    lessonKind: "regular" as const,
    teacherId: "teacher-1",
  };
  const mirror = { ...joint, lessonId: "b", groupId: "5b" };
  assert.equal(findRoomConflict([mirror], joint), undefined);
  assert.ok(findRoomConflict([{ ...mirror, teacherId: "teacher-2" }], joint));
  assert.ok(findRoomConflict([{ ...mirror, end: mirror.end + 1 }], joint));
  assert.ok(findRoomConflict([{ ...mirror, jointId: "joint:2" }], joint));
  assert.ok(findRoomConflict([
    mirror,
    { ...mirror, lessonId: "third", groupId: "6a", jointId: undefined },
  ], joint));
});

test("new room conflict detection exempts only the matching joint pair", () => {
  const first = {
    ...a,
    jointId: "joint:1",
    subjectId: "math",
    lessonKind: "regular" as const,
    teacherId: "teacher-1",
  };
  const mirror = { ...first, lessonId: "b", groupId: "5b" };
  assert.equal(newRoomConflict([first, mirror], []), undefined);
  assert.ok(newRoomConflict([
    first,
    mirror,
    { ...mirror, lessonId: "c", groupId: "6a", jointId: undefined },
  ], []));
});

test("all groups conflict even when the colliding lessons are subgroups", () => {
  const first = { ...a, groupId: "5a:1", start: 510, end: 555 };
  const second = { ...b, groupId: "5a:2", start: 530, end: 575 };
  assert.ok(findRoomConflict([first], second));
  assert.ok(findRoomConflict([first, second], second, "b"));
});

test("legacy collisions can remain or shrink but new or expanded ones fail", () => {
  const oldA = { ...a, start: 510, end: 570 };
  const oldB = { ...b, start: 540, end: 600 };
  assert.equal(newRoomConflict([oldA, oldB], [oldA, oldB]), undefined);
  const reduced = [{ ...oldA, end: 555 }, oldB];
  assert.equal(newRoomConflict(reduced, [oldA, oldB]), undefined);
  const expanded = [{ ...oldA, end: 580 }, oldB];
  assert.ok(newRoomConflict(expanded, [oldA, oldB]));
  assert.ok(newRoomConflict([oldA, { ...oldB, lessonId: "new" }], [oldA]));
});

test("room conflict message names the room, date, and other group", () => {
  const catalog = {
    subjects: [],
    teachers: [],
    subgroups: [],
    groups: [
      {
        id: "5a",
        name: "5А",
        students: 20,
        autoRoomIds: [],
        leaderId: null,
        roomId: null,
        archived: false,
      },
      {
        id: "5b",
        name: "5Б",
        students: 20,
        autoRoomIds: [],
        leaderId: null,
        roomId: null,
        archived: false,
      },
    ],
    rooms: [
      {
        id: "r1",
        name: "Кабинет 12",
        capacity: null,
        kind: "general" as const,
        archived: false,
      },
    ],
  } satisfies Catalog;
  const conflict = findRoomConflict([{ ...b, start: 550 }], a)!;
  const message = roomConflictMessage(conflict, catalog);
  assert.match(message, /Кабинет 12/);
  assert.match(message, /5Б/);
  assert.match(message, /2026-10-05/);
});
