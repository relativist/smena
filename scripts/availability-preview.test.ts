import test from "node:test";
import assert from "node:assert/strict";
import { scopeAvailabilityPreview } from "../src/availabilityPreview.ts";
import { newRoomConflict } from "../shared/roomConflicts.ts";
import { newTeacherConflict } from "../shared/teacherConflicts.ts";
import { newUnavailabilityViolation } from "../shared/unavailability.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { RoomOccupancy } from "../shared/roomConflicts.ts";

const catalog: Catalog = {
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
  teachers: [{ id: "t1", name: "Иванов", subjectIds: ["math"], defaultRoomId: null, archived: false }],
  rooms: [{ id: "r1", name: "101", kind: "general", capacity: 30, archived: false }],
  groups: ["a", "b", "c"].map(id => ({ id, name: id, students: 20, autoRoomIds: [], leaderId: null, roomId: null, archived: false })),
  subgroups: [],
};

function occupancy(lessonId: string, groupId: string, patch: Partial<RoomOccupancy> = {}): RoomOccupancy {
  return { lessonId, groupId, date: "2026-10-12", roomId: "r1", teacherId: "t1", start: 540, end: 585, subjectId: "math", ...patch };
}

function assertPreviewMatches(
  previous: RoomOccupancy[],
  changes: Array<{ previous: RoomOccupancy; next: RoomOccupancy }>,
  kind: "teacher" | "room",
) {
  const next = previous.map(entry => changes.find(change => change.previous === entry)?.next ?? entry);
  const scoped = scopeAvailabilityPreview(previous, changes, kind);
  const fullResult = kind === "teacher" ? newTeacherConflict(next, previous) : newRoomConflict(next, previous);
  const scopedResult = kind === "teacher"
    ? newTeacherConflict(scoped.next, scoped.previous)
    : newRoomConflict(scoped.next, scoped.previous);
  assert.deepEqual(scopedResult, fullResult);
}

test("scoped teacher and room checks preserve existing conflicts that an edit does not worsen", () => {
  const first = occupancy("legacy-a", "a");
  const second = occupancy("legacy-b", "b", { start: 550, end: 580 });
  const unrelated = occupancy("other", "c", { teacherId: "t2", roomId: "r2" });
  const moved = occupancy("edited", "a", { teacherId: "t3", roomId: "r3" });
  const changes = [{ previous: moved, next: { ...moved, start: 600, end: 645 } }];
  const previous = [first, moved, second, unrelated];
  assertPreviewMatches(previous, changes, "teacher");
  assertPreviewMatches(previous, changes, "room");
});

test("scoped checks retain new conflicts caused by a candidate or a shifted following lesson", () => {
  const edited = occupancy("edited", "a");
  const following = occupancy("following", "a", { start: 595, end: 640, roomId: "r2", teacherId: "t2" });
  const peer = occupancy("peer", "b", { start: 605, end: 650, roomId: "r1", teacherId: "t1" });
  const changes = [
    { previous: edited, next: { ...edited, start: 600, end: 645 } },
    { previous: following, next: { ...following, start: 655, end: 700 } },
  ];
  const previous = [edited, following, peer];
  assertPreviewMatches(previous, changes, "teacher");
  assertPreviewMatches(previous, changes, "room");
});

test("a shifted following lesson alone still reports its new conflict", () => {
  const following = occupancy("following", "a", { start: 595, end: 640, roomId: "r1", teacherId: "t1" });
  const peer = occupancy("peer", "b", { start: 655, end: 700, roomId: "r1", teacherId: "t1" });
  const changes = [{ previous: following, next: { ...following, start: 655, end: 700 } }];
  const previous = [following, peer];
  for (const kind of ["teacher", "room"] as const) {
    const next = previous.map(entry => changes.find(change => change.previous === entry)?.next ?? entry);
    const scoped = scopeAvailabilityPreview(previous, changes, kind);
    const conflict = kind === "teacher" ? newTeacherConflict(scoped.next, scoped.previous) : newRoomConflict(scoped.next, scoped.previous);
    const fullConflict = kind === "teacher" ? newTeacherConflict(next, previous) : newRoomConflict(next, previous);
    assert.ok(conflict, `${kind} conflict from shifted lesson should remain visible`);
    assert.deepEqual(conflict, fullConflict);
  }
});

test("joint mirrors changed together to matching resources remain compatible", () => {
  const edited = occupancy("joint-a", "a", { jointId: "joint", roomId: "r2", teacherId: "t2" });
  const mirror = occupancy("joint-b", "b", { jointId: "joint", roomId: "r2", teacherId: "t2" });
  const nextEdited = { ...edited, roomId: "r1", teacherId: "t1" };
  const nextMirror = { ...mirror, roomId: "r1", teacherId: "t1" };
  const changes = [{ previous: edited, next: nextEdited }, { previous: mirror, next: nextMirror }];
  const previous = [edited, mirror];
  for (const kind of ["teacher", "room"] as const) {
    assertPreviewMatches(previous, changes, kind);
    const scoped = scopeAvailabilityPreview(previous, changes, kind);
    const conflict = kind === "teacher" ? newTeacherConflict(scoped.next, scoped.previous) : newRoomConflict(scoped.next, scoped.previous);
    assert.equal(conflict, undefined, `${kind} mirrors with matching resources are compatible`);
  }
});

test("scoped unavailability checks retain changed violations and ignore unchanged violations", () => {
  catalog.teachers[0]!.unavailability = [{ id: "leave", startDate: "2026-10-12", endDate: "2026-10-12", start: 600, end: 620 }];
  const edited = occupancy("edited", "a");
  const unchanged = occupancy("unchanged", "b", { start: 600, end: 620 });
  const changes = [{ previous: edited, next: { ...edited, start: 605, end: 650 } }];
  const previous = [edited, unchanged];
  const next = previous.map(entry => changes.find(change => change.previous === entry)?.next ?? entry);
  const scoped = scopeAvailabilityPreview(previous, changes, "teacher");
  const asTeacherOnly = (entries: RoomOccupancy[]) => entries.map(entry => ({ ...entry, roomId: undefined }));
  assert.deepEqual(
    newUnavailabilityViolation(asTeacherOnly(scoped.next), asTeacherOnly(scoped.previous), catalog),
    newUnavailabilityViolation(asTeacherOnly(next), asTeacherOnly(previous), catalog),
  );
  catalog.teachers[0]!.unavailability = [];
});

test("room unavailability scoping matches full checks for existing and newly introduced violations", () => {
  catalog.rooms[0]!.unavailability = [{ id: "repair", startDate: "2026-10-12", endDate: "2026-10-12", start: 600, end: 620 }];
  const existingViolation = occupancy("existing", "a", { start: 600, end: 620 });
  const edited = occupancy("edited", "b", { start: 540, end: 585 });
  const unrelated = occupancy("unrelated", "c", { roomId: "r2", teacherId: "t2", start: 600, end: 620 });
  const previous = [existingViolation, edited, unrelated];
  const changes = [{ previous: edited, next: { ...edited, start: 545, end: 590 } }];
  const next = previous.map(entry => changes.find(change => change.previous === entry)?.next ?? entry);
  const scoped = scopeAvailabilityPreview(previous, changes, "room");
  const roomOnly = (entries: RoomOccupancy[]) => entries.map(entry => ({ ...entry, teacherId: undefined }));
  assert.equal(newUnavailabilityViolation(roomOnly(scoped.next), roomOnly(scoped.previous), catalog), undefined);
  assert.equal(
    newUnavailabilityViolation(roomOnly(next), roomOnly(previous), catalog),
    undefined,
    "a pre-existing violation on an unchanged lesson must not create a new result",
  );
  const changedViolation = occupancy("edited", "b", { start: 605, end: 650 });
  const newlyUnavailable = [{ previous: edited, next: changedViolation }];
  const newScoped = scopeAvailabilityPreview(previous, newlyUnavailable, "room");
  const fullNext = previous.map(entry => newlyUnavailable.find(change => change.previous === entry)?.next ?? entry);
  const scopedViolation = newUnavailabilityViolation(roomOnly(newScoped.next), roomOnly(newScoped.previous), catalog);
  const fullViolation = newUnavailabilityViolation(roomOnly(fullNext), roomOnly(previous), catalog);
  assert.deepEqual(
    scopedViolation,
    fullViolation,
  );
  assert.equal(scopedViolation?.kind, "room");
  catalog.rooms[0]!.unavailability = [];
});
