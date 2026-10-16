import assert from "node:assert/strict";
import test from "node:test";
import { findTeacherConflicts, newTeacherConflict, teacherConflictMessage, type TeacherOccupancy } from "../shared/teacherConflicts.ts";
import type { Catalog } from "../shared/catalog.ts";
import { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const ORIGIN = "http://127.0.0.1";
const first: TeacherOccupancy = {
  lessonId: "lesson-a", groupId: "5a", date: "2026-10-05", roomId: "room-a",
  start: 510, end: 555, teacherId: "teacher-a", subjectId: "math",
};
const second: TeacherOccupancy = {
  ...first, lessonId: "lesson-b", groupId: "5b", roomId: "room-b", start: 555,
};

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "smena-teachers-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("teacher overlap uses half-open intervals, dates and resource-compatible joint mirrors", () => {
  assert.deepEqual(findTeacherConflicts([second], first), []);
  assert.deepEqual(findTeacherConflicts([{ ...second, start: 550 }], first), [
    { a: first, b: { ...second, start: 550 } },
  ]);
  assert.deepEqual(findTeacherConflicts([{ ...second, date: "2026-10-06", start: 530 }], first), []);
  const joint = { ...first, jointId: "joint-1" };
  const mirror = { ...joint, lessonId: "lesson-b", groupId: "5b" };
  assert.deepEqual(findTeacherConflicts([mirror], joint), []);
  assert.equal(findTeacherConflicts([{ ...mirror, roomId: "room-b" }], joint).length, 1);
});

test("legacy teacher conflicts may remain or shrink; new or enlarged overlaps fail", () => {
  const oldA = { ...first, start: 510, end: 570 };
  const oldB = { ...second, start: 540, end: 600 };
  assert.equal(newTeacherConflict([oldA, oldB], [oldA, oldB]), undefined);
  assert.equal(newTeacherConflict([{ ...oldA, end: 555 }, oldB], [oldA, oldB]), undefined);
  assert.ok(newTeacherConflict([{ ...oldA, end: 580 }, oldB], [oldA, oldB]));
  assert.ok(newTeacherConflict([first, { ...second, lessonId: "new", start: 530 }], [first]));
});

test("an atomic transfer can remove the old assignment and add a new one", () => {
  const occupied = { ...second, lessonId: "old", start: 530, end: 575 };
  const replacement = { ...occupied, groupId: "6a" };
  assert.equal(newTeacherConflict([first, replacement], [first, occupied]), undefined);
});

test("teacher conflict message describes the other scheduled lesson", () => {
  const catalog = {
    subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
    teachers: [{ id: "teacher-a", name: "Иванов И.И.", archived: false, subjectIds: ["math"], defaultRoomId: null }],
    groups: [
      { id: "5a", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
      { id: "5b", name: "5Б", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    ], rooms: [], subgroups: [],
  } satisfies Catalog;
  const message = teacherConflictMessage({ a: first, b: { ...second, start: 530 } }, catalog);
  assert.match(message, /Иванов И\.И\./);
  assert.match(message, /5Б/);
  assert.match(message, /Математика/);
  assert.match(message, /2026-10-05/);
  assert.match(message, /08:50–09:15/);
});

test("PUT /api/state rejects a new teacher overlap and leaves the saved schedule intact", async () => {
  const app = await buildApp({ dbPath: tempDb() });
  apps.push(app);
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin: ORIGIN, host: "127.0.0.1" }, payload: { username: "admin", password: "correct horse battery" } });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = String(setup.headers["set-cookie"]).split(";")[0];
  const csrfToken = setup.json().csrfToken as string;
  const headers = { cookie, origin: ORIGIN, host: "127.0.0.1", "x-csrf-token": csrfToken };
  const original = (await app.inject({ url: "/api/state", headers: { cookie } })).json();
  const schedule = structuredClone(original.schedule);
  const candidates: Array<{ groupId: string; date: string; start: number; subjectId: string; lesson: any; day: any; slotIndex: number }> = [];
  for (const [key, days] of Object.entries(schedule) as Array<[string, any[]]>) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days) day.slots.forEach((slot: any[], index: number) => {
      for (const lesson of slot) if (lesson.subjectId !== "event") candidates.push({ groupId, date: day.date, start: day.times[index].start, subjectId: lesson.subjectId, lesson, day, slotIndex: index });
    });
  }
  let pair: typeof candidates | undefined;
  outer: for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i], b = candidates[j];
    const time = b.day.times[b.slotIndex];
    const lower = b.slotIndex === 0 ? 0 : b.day.times[b.slotIndex - 1].start + b.day.times[b.slotIndex - 1].duration + b.day.breaks[b.slotIndex - 1];
    const upper = b.slotIndex === b.day.times.length - 1 ? 1439 : b.day.times[b.slotIndex + 1].start - time.duration - b.day.breaks[b.slotIndex];
    if (a.groupId !== b.groupId && a.date === b.date &&
      a.lesson.id !== b.lesson.id && !a.lesson.jointId && !b.lesson.jointId &&
      a.start >= lower && a.start <= upper) { pair = [a, b]; break outer; }
  }
  assert.ok(pair, "seed schedule should provide parallel lessons in different groups");
  const [a, b] = pair;
  b.day.times[b.slotIndex].start = a.start;
  const conflictStart = a.start;
  const conflictEnd = conflictStart + b.day.times[b.slotIndex].duration;
  const teacher = original.catalog.teachers[0];
  assert.ok(teacher);
  const db = (app as unknown as { smenaDb: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).smenaDb;
  const addQualification = db.prepare("INSERT OR IGNORE INTO catalog_teacher_subjects(teacher_id,subject_id) VALUES(?,?)");
  addQualification.run(teacher.id, a.subjectId);
  addQualification.run(teacher.id, b.subjectId);
  const freeRoom = original.catalog.rooms.find((room: any) => room.id !== a.lesson.roomId &&
    !Object.values(schedule).some((days) => (days as any[]).some((day) => day.date === b.date &&
      day.slots.some((slot: any[], index: number) => slot.some((lesson) => lesson.id !== a.lesson.id && lesson.id !== b.lesson.id &&
        lesson.roomId === room.id && day.times[index].start < conflictEnd &&
        conflictStart < day.times[index].start + day.times[index].duration)))));
  assert.ok(freeRoom, "seed should provide a free room to isolate the teacher conflict");
  a.lesson.teacherId = teacher.id;
  a.lesson.teacher = teacher.name;
  b.lesson.teacherId = teacher.id;
  b.lesson.teacher = teacher.name;
  delete b.lesson.jointId;
  b.lesson.roomId = freeRoom.id;
  b.lesson.room = freeRoom.name;
  const response = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule, revision: original.revision, requestId: "teacher-overlap-001" } });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /Преподаватель/);
  const after = (await app.inject({ url: "/api/state", headers: { cookie } })).json();
  assert.equal(after.revision, original.revision);
  assert.deepEqual(after.schedule, original.schedule);
});
