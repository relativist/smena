import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";

async function setup(path?: string) {
  const root = path ? undefined : mkdtempSync(join(tmpdir(), "smena-unavailability-"));
  if (root) roots.push(root);
  const dbPath = path ?? join(root!, "draft.sqlite");
  const app = await buildApp({ dbPath });
  apps.push(app);
  let response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "unavailability test password" } });
  if (response.statusCode !== 200)
    response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "unavailability test password" } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string };
  return { app, dbPath, headers, snapshot: await state(app, headers) };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveCatalog(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, snapshot: StateResponse, catalog: StateResponse["catalog"], requestId = `unavailability-catalog-${crypto.randomUUID()}`) {
  return app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: snapshot.revision, requestId } });
}

async function saveSchedule(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, snapshot: StateResponse, schedule: StateResponse["schedule"]) {
  return app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule, revision: snapshot.revision, requestId: `unavailability-schedule-${crypto.randomUUID()}` } });
}

function firstLesson(snapshot: StateResponse) {
  for (const [key, days] of Object.entries(snapshot.schedule))
    for (const [dayIndex, day] of days.entries())
      for (const [slotIndex, slot] of day.slots.entries())
        for (const lesson of slot)
          if (lesson.teacherId && lesson.roomId) return { key, dayIndex, slotIndex, day, time: day.times[slotIndex]!, lesson };
  throw new Error("Seed schedule has no fully assigned lesson");
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("migration 13 preserves the existing schedule and persists teacher and room rules across restart", async () => {
  const { app, dbPath, headers, snapshot } = await setup();
  const before = structuredClone(snapshot.schedule);
  const item = firstLesson(snapshot);
  const current = structuredClone(snapshot.catalog);
  current.teachers.find((entry) => entry.id === item.lesson.teacherId)!.unavailability = [{ id: "sick-leave", startDate: item.day.date, endDate: item.day.date, start: item.time.start + item.time.duration, end: Math.min(item.time.start + item.time.duration + 20, 1440), weekdays: [1, 2, 3, 4, 5], reason: "Больничный" }];
  current.rooms.find((entry) => entry.id === item.lesson.roomId)!.unavailability = [{ id: "repair", startDate: item.day.date, endDate: item.day.date, start: 600, end: 660, reason: "Ремонт" }];
  const saved = await saveCatalog(app, headers, snapshot, current);
  assert.equal(saved.statusCode, 200, saved.body);
  const savedState = saved.json() as StateResponse;
  assert.deepEqual(savedState.schedule, before, "adding a sick leave rule must preserve every lesson");
  assert.deepEqual(savedState.catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability, current.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability);
  assert.deepEqual(savedState.catalog.rooms.find((entry) => entry.id === item.lesson.roomId)?.unavailability, current.rooms.find((entry) => entry.id === item.lesson.roomId)?.unavailability);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await setup(dbPath);
  assert.deepEqual(reopened.snapshot.schedule, before);
  assert.deepEqual(reopened.snapshot.catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability, current.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability);
  assert.deepEqual(reopened.snapshot.catalog.rooms.find((entry) => entry.id === item.lesson.roomId)?.unavailability, current.rooms.find((entry) => entry.id === item.lesson.roomId)?.unavailability);
});

test("compact unavailability save does not rewrite plans or other catalogue projections and replays idempotently", async () => {
  const { app, headers, snapshot } = await setup();
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const item = firstLesson(snapshot);
  const teacher = snapshot.catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)!;
  const rule = { id: "leave-2026-10", startDate: "2026-10-05", endDate: "2026-10-18", start: 0, end: 1440, reason: "Недоступность" };
  const catalog = structuredClone(snapshot.catalog);
  catalog.teachers.find((entry) => entry.id === teacher.id)!.unavailability = [rule];
  const planRows = db.prepare("SELECT id,plan_id,subgroup_id,target FROM plan_assignments ORDER BY id").all();
  const studyPlanRows = db.prepare("SELECT id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind FROM study_plans ORDER BY id").all();
  const curriculumRows = db.prepare("SELECT id,curriculum_json FROM curricula ORDER BY id").all();
  const scheduleRows = db.prepare("SELECT id,slot_id,subject_id,subgroup,teacher,room,event,note FROM lessons ORDER BY id").all();
  db.exec(`
    CREATE TRIGGER reject_plan_assignment_delete BEFORE DELETE ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment DELETE'); END;
    CREATE TRIGGER reject_plan_assignment_insert BEFORE INSERT ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment INSERT'); END;
    CREATE TRIGGER reject_plan_assignment_update BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment UPDATE'); END;
    CREATE TRIGGER reject_study_plan_writes BEFORE UPDATE ON study_plans BEGIN SELECT RAISE(ABORT, 'unexpected study plan UPDATE'); END;
    CREATE TRIGGER reject_curriculum_writes BEFORE UPDATE ON curricula BEGIN SELECT RAISE(ABORT, 'unexpected curriculum UPDATE'); END;
    CREATE TRIGGER reject_curriculum_deletes BEFORE DELETE ON curricula BEGIN SELECT RAISE(ABORT, 'unexpected curriculum DELETE'); END;
    CREATE TRIGGER reject_curriculum_inserts BEFORE INSERT ON curricula BEGIN SELECT RAISE(ABORT, 'unexpected curriculum INSERT'); END;
    CREATE TRIGGER reject_schedule_lesson_updates BEFORE UPDATE ON lessons BEGIN SELECT RAISE(ABORT, 'unexpected schedule lesson UPDATE'); END;
    CREATE TRIGGER reject_group_auto_room_deletes BEFORE DELETE ON catalog_group_auto_rooms BEGIN SELECT RAISE(ABORT, 'unexpected group auto-room DELETE'); END;
    CREATE TRIGGER reject_group_auto_room_inserts BEFORE INSERT ON catalog_group_auto_rooms BEGIN SELECT RAISE(ABORT, 'unexpected group auto-room INSERT'); END;
    CREATE TRIGGER reject_teacher_subject_deletes BEFORE DELETE ON catalog_teacher_subjects BEGIN SELECT RAISE(ABORT, 'unexpected teacher-subject DELETE'); END;
    CREATE TRIGGER reject_teacher_subject_inserts BEFORE INSERT ON catalog_teacher_subjects BEGIN SELECT RAISE(ABORT, 'unexpected teacher-subject INSERT'); END;
  `);
  const requestId = `unavailability-only-${crypto.randomUUID()}`;
  const response = await app.inject({ method: "PUT", url: "/api/catalog?response=compact", headers, payload: { catalog, revision: snapshot.revision, requestId } });
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json() as StateResponse;
  assert.equal(saved.revision, snapshot.revision + 1);
  assert.deepEqual(saved.catalog.teachers.find((entry) => entry.id === teacher.id)?.unavailability, [rule]);
  assert.deepEqual((await state(app, headers)).schedule, snapshot.schedule);
  assert.deepEqual(db.prepare("SELECT id,plan_id,subgroup_id,target FROM plan_assignments ORDER BY id").all(), planRows);
  assert.deepEqual(db.prepare("SELECT id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind FROM study_plans ORDER BY id").all(), studyPlanRows);
  assert.deepEqual(db.prepare("SELECT id,curriculum_json FROM curricula ORDER BY id").all(), curriculumRows);
  assert.deepEqual(db.prepare("SELECT id,slot_id,subject_id,subgroup,teacher,room,event,note FROM lessons ORDER BY id").all(), scheduleRows);
  const replay = await app.inject({ method: "PUT", url: "/api/catalog?response=compact", headers, payload: { catalog, revision: snapshot.revision, requestId } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as StateResponse).revision, saved.revision);
});

test("compact room unavailability save skips curriculum assignment writes", async () => {
  const { app, headers, snapshot } = await setup();
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const roomId = firstLesson(snapshot).lesson.roomId!;
  const catalog = structuredClone(snapshot.catalog);
  catalog.rooms.find((entry) => entry.id === roomId)!.unavailability = [{ id: "room-leave", startDate: "2026-10-05", endDate: "2026-10-18", start: 0, end: 1440, reason: "Недоступность" }];
  db.exec(`
    CREATE TRIGGER reject_room_plan_assignment_delete BEFORE DELETE ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment DELETE'); END;
    CREATE TRIGGER reject_room_plan_assignment_insert BEFORE INSERT ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment INSERT'); END;
    CREATE TRIGGER reject_room_plan_assignment_update BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT, 'unexpected plan assignment UPDATE'); END;
  `);
  const response = await app.inject({ method: "PUT", url: "/api/catalog?response=compact", headers, payload: { catalog, revision: snapshot.revision, requestId: `room-unavailability-only-${crypto.randomUUID()}` } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((response.json() as StateResponse).catalog.rooms.find((entry) => entry.id === roomId)?.unavailability?.[0]?.id, "room-leave");
});

test("archiving a subgroup still removes its managed plan assignments", async () => {
  const { app, headers, snapshot } = await setup();
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const plan = snapshot.studyPlans.find((entry) => entry.mode === "subgroups" && entry.assignments.some((assignment) => assignment.subgroupId) &&
    snapshot.curricula?.some((curriculum) => curriculum.quarterId === entry.quarterId && curriculum.groupIds.includes(entry.groupId) && curriculum.rows.some((row) => row.subjectId === entry.subjectId)))!;
  assert.ok(plan);
  const subgroupId = plan.assignments.find((assignment) => assignment.subgroupId)!.subgroupId!;
  const subgroup = snapshot.catalog.subgroups.find((entry) => entry.id === subgroupId)!;
  assert.ok(subgroup);
  assert.ok(db.prepare("SELECT 1 FROM curricula").get());
  const catalog = structuredClone(snapshot.catalog);
  catalog.subgroups.find((entry) => entry.id === subgroupId)!.archived = true;
  const response = await saveCatalog(app, headers, snapshot, catalog);
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json() as StateResponse;
  assert.equal(saved.catalog.subgroups.find((entry) => entry.id === subgroupId)?.archived, true);
  const updatedPlan = saved.studyPlans.find((entry) => entry.id === plan.id)!;
  assert.ok(!updatedPlan.assignments.some((assignment) => assignment.subgroupId === subgroupId));
  assert.ok(updatedPlan.assignments.every((assignment) => assignment.subgroupId !== null));
});

test("migration from the pre-unavailability catalogue leaves existing lesson rows intact", async () => {
  const { app, dbPath, snapshot } = await setup();
  const before = structuredClone(snapshot.schedule);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const legacyDb = new Database(dbPath);
  legacyDb.exec("DELETE FROM schema_migrations WHERE version=13; ALTER TABLE catalog_teachers DROP COLUMN unavailability_json; ALTER TABLE catalog_rooms DROP COLUMN unavailability_json");
  legacyDb.close();

  const migrated = await setup(dbPath);
  assert.deepEqual(migrated.snapshot.schedule, before);
  const db = (migrated.app as unknown as { smenaDb: Database.Database }).smenaDb;
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=13").get());
  assert.ok((db.pragma("table_info(catalog_teachers)") as Array<{ name: string }>).some((column) => column.name === "unavailability_json"));
  assert.ok((db.pragma("table_info(catalog_rooms)") as Array<{ name: string }>).some((column) => column.name === "unavailability_json"));
});

test("catalog edits preserve omitted constraints, explicit empty arrays clear, and sick leave allows unchanged historical lessons", async () => {
  const { app, headers, snapshot } = await setup();
  const item = firstLesson(snapshot);
  const catalog = structuredClone(snapshot.catalog);
  const rule = { id: "sick", startDate: item.day.date, endDate: item.day.date, start: item.time.start, end: item.time.start + item.time.duration, reason: "Больничный" };
  catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)!.unavailability = [rule];
  let response = await saveCatalog(app, headers, snapshot, catalog);
  assert.equal(response.statusCode, 200, response.body);
  let current = response.json() as StateResponse;
  assert.deepEqual(current.schedule, snapshot.schedule);

  const olderClient = structuredClone(current.catalog) as StateResponse["catalog"] & { teachers: Array<Record<string, unknown>> };
  olderClient.teachers = olderClient.teachers.map(({ unavailability: _ignored, ...teacher }) => teacher);
  response = await saveCatalog(app, headers, current, olderClient as StateResponse["catalog"]);
  assert.equal(response.statusCode, 200, response.body);
  current = response.json() as StateResponse;
  assert.deepEqual(current.catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability, [rule]);

  const noteEdit = structuredClone(current.schedule);
  noteEdit[item.key]![item.dayIndex]!.slots[item.slotIndex]!.find((lesson) => lesson.id === item.lesson.id)!.note = "Проверка сохранения заметки";
  response = await saveSchedule(app, headers, current, noteEdit);
  assert.equal(response.statusCode, 200, response.body);
  current = await state(app, headers);
  assert.equal(current.schedule[item.key]![item.dayIndex]!.slots[item.slotIndex]!.find((lesson) => lesson.id === item.lesson.id)!.note, "Проверка сохранения заметки");

  const cleared = structuredClone(current.catalog);
  cleared.teachers.find((entry) => entry.id === item.lesson.teacherId)!.unavailability = [];
  response = await saveCatalog(app, headers, current, cleared);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual((response.json() as StateResponse).catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)?.unavailability, []);
});

test("explicit null unavailability is rejected instead of being treated as an omitted legacy field", async () => {
  const { app, headers, snapshot } = await setup();
  const item = firstLesson(snapshot);
  for (const kind of ["teacher", "room"] as const) {
    const catalog = structuredClone(snapshot.catalog) as unknown as Record<string, unknown>;
    const rows = catalog[kind === "teacher" ? "teachers" : "rooms"] as Array<Record<string, unknown>>;
    const resourceId = kind === "teacher" ? item.lesson.teacherId : item.lesson.roomId;
    rows.find((entry) => entry.id === resourceId)!.unavailability = null;
    const response = await saveCatalog(app, headers, snapshot, catalog as unknown as StateResponse["catalog"]);
    assert.equal(response.statusCode, 400, response.body);
  }
  const unchanged = await state(app, headers);
  assert.equal(unchanged.revision, snapshot.revision);
  assert.deepEqual(unchanged.schedule, snapshot.schedule);
});

test("new schedule overlap with a teacher sick leave is rejected atomically with a precise reason", async () => {
  const { app, headers, snapshot } = await setup();
  const item = firstLesson(snapshot);
  const catalog = structuredClone(snapshot.catalog);
  const originalRoom = catalog.rooms.find((entry) => entry.id === item.lesson.roomId)!;
  const uniqueRoomId = "room:unavailability-isolated";
  catalog.rooms.push({ ...originalRoom, id: uniqueRoomId, name: "Изолированный кабинет", unavailability: [] });
  const unavailableStart = item.time.start + item.time.duration;
  assert.ok(unavailableStart + 5 <= 1440);
  catalog.teachers.find((entry) => entry.id === item.lesson.teacherId)!.unavailability = [{ id: "sick", startDate: item.day.date, endDate: item.day.date, start: unavailableStart, end: unavailableStart + 5, reason: "Больничный" }];
  const savedCatalog = await saveCatalog(app, headers, snapshot, catalog);
  assert.equal(savedCatalog.statusCode, 200, savedCatalog.body);
  const current = savedCatalog.json() as StateResponse;
  const attempted = structuredClone(current.schedule);
  attempted[item.key]![item.dayIndex]!.slots[item.slotIndex]!.find((lesson) => lesson.id === item.lesson.id)!.roomId = uniqueRoomId;
  attempted[item.key]![item.dayIndex]!.times[item.slotIndex]!.duration += 5;
  const rejected = await saveSchedule(app, headers, current, attempted);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /Учитель.*недоступен.*Больничный/);
  const after = await state(app, headers);
  assert.equal(after.revision, current.revision);
  assert.deepEqual(after.schedule, current.schedule, "rejected interval change must be atomic");
});

test("replacing a lesson with a teacher unavailable at that date and time is rejected", async () => {
  const { app, headers, snapshot } = await setup();
  const item = firstLesson(snapshot);
  const catalog = structuredClone(snapshot.catalog);
  const replacementId = "teacher:unavailable-replacement";
  catalog.teachers.push({
    id: replacementId,
    name: "Временный заместитель",
    archived: false,
    subjectIds: [item.lesson.subjectId],
    defaultRoomId: null,
    preferredGroupIds: [],
    unavailability: [{ id: "leave", startDate: item.day.date, endDate: item.day.date, start: item.time.start, end: item.time.start + item.time.duration, reason: "Больничный" }],
  });
  const savedCatalog = await saveCatalog(app, headers, snapshot, catalog);
  assert.equal(savedCatalog.statusCode, 200, savedCatalog.body);
  const current = savedCatalog.json() as StateResponse;
  const attempted = structuredClone(current.schedule);
  const replacement = attempted[item.key]![item.dayIndex]!.slots[item.slotIndex]!.find((lesson) => lesson.id === item.lesson.id)!;
  replacement.teacherId = replacementId;
  replacement.teacher = "Временный заместитель";
  const rejected = await saveSchedule(app, headers, current, attempted);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /Учитель «Временный заместитель» недоступен.*Больничный/);
  const after = await state(app, headers);
  assert.equal(after.revision, current.revision);
  assert.deepEqual(after.schedule, current.schedule);
});

test("room recurrence uses the configured weekday and permits a lesson ending at the unavailable boundary", async () => {
  const { app, headers, snapshot } = await setup();
  const item = firstLesson(snapshot);
  const weekday = new Date(`${item.day.date}T00:00:00.000Z`).getUTCDay() || 7;
  const catalog = structuredClone(snapshot.catalog);
  catalog.rooms.find((entry) => entry.id === item.lesson.roomId)!.unavailability = [{
    id: "weekly-maintenance",
    startDate: item.day.date,
    endDate: item.day.date,
    start: item.time.start + item.time.duration,
    end: item.time.start + item.time.duration + 5,
    weekdays: [weekday],
    reason: "Обслуживание",
  }];
  const saved = await saveCatalog(app, headers, snapshot, catalog);
  assert.equal(saved.statusCode, 200, saved.body);
  const current = saved.json() as StateResponse;
  assert.deepEqual(current.schedule, snapshot.schedule, "end touching the rule start does not overlap");
  const attempted = structuredClone(current.schedule);
  attempted[item.key]![item.dayIndex]!.times[item.slotIndex]!.duration += 5;
  const rejected = await saveSchedule(app, headers, current, attempted);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /Кабинет.*недоступен.*Обслуживание/);
  const unchanged = await state(app, headers);
  assert.equal(unchanged.revision, current.revision);
  assert.deepEqual(unchanged.schedule, current.schedule);
});
