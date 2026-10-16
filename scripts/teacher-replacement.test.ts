import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { previewTeacherReplacement } from "../shared/teacherReplacement.ts";
import { newUnavailabilityViolation } from "../shared/unavailability.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: ["math", "english"].map(id => ({ id, name: id, shortName: id, archived: false, color: "blue" as const, roomKind: null, labRoomKind: null })),
  teachers: [
    { id: "old", name: "Старый Иван", archived: false, subjectIds: ["math", "english"], defaultRoomId: null },
    { id: "new", name: "Новый Пётр", archived: false, subjectIds: ["math", "english"], defaultRoomId: null },
    { id: "math-only", name: "Математик", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "busy", name: "Занятый", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "away", name: "Отсутствует", archived: false, subjectIds: ["math"], defaultRoomId: null, unavailability: [{ id: "sick", startDate: "2026-10-12", endDate: "2026-10-12", start: 540, end: 600, reason: "Больничный" }] },
  ],
  rooms: [{ id: "room", name: "101", archived: false, kind: "general", capacity: null, unavailability: [{ id: "repair", startDate: "2026-10-12", endDate: "2026-10-12", start: 540, end: 600, reason: "Ремонт" }] }],
  groups: ["g1", "g2", "g3"].map(id => ({ id, name: id, archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] })),
  subgroups: [],
};

function day(date: string, lessons: EditorLesson[], start = 540): EditorDay {
  return { date, start: "09:00", duration: 45, breaks: [], slots: [lessons], times: [{ start, duration: 45 }] };
}
function lesson(id: string, subjectId = "math", teacherId = "old", extra: Partial<EditorLesson> = {}): EditorLesson {
  return { id, subjectId, teacherId, teacher: "Старый", roomId: "room", room: "101", note: "note-" + id, lessonKind: "lab", subgroupId: "sg", ...extra };
}
function sch(entries: Record<string, EditorDay[]>): Schedule { return entries; }

test("replaces a qualified available teacher while preserving every other lesson field and input", () => {
  const original = sch({ "g1:0": [day("2026-10-12", [lesson("a")])] });
  const before = structuredClone(original);
  const result = previewTeacherReplacement(original, catalog, ["a"], "new");
  const updated = result.schedule["g1:0"]![0]!.slots[0]![0]!;
  assert.deepEqual(result.changedLessonIds, ["a"]);
  assert.equal(updated.teacherId, "new");
  assert.equal(updated.teacher, "Новый");
  assert.equal(updated.id, "a");
  assert.equal(updated.subjectId, "math");
  assert.equal(updated.roomId, "room");
  assert.equal(updated.note, "note-a");
  assert.equal(updated.lessonKind, "lab");
  assert.equal(updated.subgroupId, "sg");
  assert.deepEqual(original, before);
  assert.notEqual(result.schedule, original);
});

test("skips unqualified, unavailable, event and missing lessons with reasons", () => {
  const original = sch({ "g1:0": [day("2026-10-12", [
    lesson("english", "english"), lesson("away"), lesson("event", "event", "old", { event: "Собрание" }),
  ])] });
  const result = previewTeacherReplacement(original, catalog, ["english", "away", "event", "missing"], "math-only");
  assert.deepEqual(result.changedLessonIds, ["away"]);
  assert.match(result.skipped.find(item => item.lessonId === "english")!.reason, /не ведёт предмет/);
  assert.ok(result.changedLessonIds.includes("away"));
  assert.match(result.skipped.find(item => item.lessonId === "event")!.reason, /ответственного/);
  assert.match(result.skipped.find(item => item.lessonId === "missing")!.reason, /не найден/);
  const unavailable = previewTeacherReplacement(original, catalog, ["away"], "away");
  assert.match(unavailable.skipped[0]!.reason, /Больничный/);
});

test("changes all joint mirrors atomically and leaves room-side legacy unavailability alone", () => {
  const first = lesson("joint-a", "math", "old", { jointId: "j" });
  const second = lesson("joint-b", "math", "old", { jointId: "j" });
  const original = sch({ "g1:0": [day("2026-10-12", [first])], "g2:0": [day("2026-10-12", [second])] });
  const result = previewTeacherReplacement(original, catalog, ["joint-a"], "new");
  assert.deepEqual(new Set(result.changedLessonIds), new Set(["joint-a", "joint-b"]));
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "new");
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId, "new");
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.roomId, "room");
});

test("bulk preview applies nonconflicting units and skips the next lesson that conflicts with the first replacement", () => {
  const original = sch({
    "g1:0": [day("2026-10-12", [lesson("first")])],
    "g2:0": [day("2026-10-12", [lesson("second")])],
    "g3:0": [day("2026-10-13", [lesson("occupied", "math", "busy")])],
  });
  const result = previewTeacherReplacement(original, catalog, ["first", "second"], "new");
  assert.deepEqual(result.changedLessonIds, ["first"]);
  assert.match(result.skipped[0]!.reason, /g1/);
  assert.equal(original["g1:0"]![0]!.slots[0]![0]!.teacherId, "old");
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId, "old");
});

test("checks replacement unavailability and never rewrites an unchanged room conflict", () => {
  const original = sch({ "g1:0": [day("2026-10-12", [lesson("a")])] });
  const changed = previewTeacherReplacement(original, catalog, ["a"], "new").schedule;
  assert.equal(changed["g1:0"]![0]!.slots[0]![0]!.roomId, "room");
  const unavailable = previewTeacherReplacement(original, catalog, ["a"], "away");
  assert.equal(unavailable.changedLessonIds.length, 0);
  assert.match(unavailable.skipped[0]!.reason, /Больничный/);
});

test("reports that undo would restore a teacher who is unavailable", () => {
  const original = sch({ "g1:0": [day("2026-10-12", [lesson("sick", "math", "away")])] });
  const replacement = previewTeacherReplacement(original, catalog, ["sick"], "new");
  assert.deepEqual(replacement.changedLessonIds, ["sick"]);
  assert.equal(newUnavailabilityViolation(original, replacement.schedule, catalog)?.kind, "teacher");
});

console.log("teacher replacement: 6 checks passed");
