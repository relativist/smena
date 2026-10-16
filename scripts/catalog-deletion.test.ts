import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Catalog } from "../shared/catalog.ts";
import { buildApp } from "../server/app.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];
const origin = "http://127.0.0.1";
function dbPath() { const dir = mkdtempSync(join(tmpdir(), "smena-catalog-delete-")); dirs.push(dir); return join(dir, "draft.sqlite"); }
async function start(path = dbPath()) {
  const app = await buildApp({ dbPath: path }); apps.push(app);
  return { app, path, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  let response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "catalog deletion password" } });
  if (response.statusCode !== 200) response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "catalog deletion password" } });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  assert.ok(cookie);
  return { cookie, csrf: response.json().csrfToken as string };
}
function headers(auth: { cookie: string; csrf: string }) { return { cookie: auth.cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.csrf }; }
async function state(app: Awaited<ReturnType<typeof buildApp>>, auth: { cookie: string }) {
  const response = await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } }); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function save(app: Awaited<ReturnType<typeof buildApp>>, auth: { cookie: string; csrf: string }, revision: number, catalog: Catalog, requestId: string = crypto.randomUUID()) {
  return app.inject({ method: "PUT", url: "/api/catalog", headers: headers(auth), payload: { catalog, revision, requestId } });
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("unused active and archived entries delete transactionally and replay after restart", async () => {
  const first = await start(); const auth = await login(first.app); const initial = await state(first.app, auth);
  const catalog = structuredClone(initial.catalog) as Catalog;
  const subject = { ...catalog.subjects[0]!, id: "delete:subject", name: "Временный предмет", shortName: "Врем.", archived: true };
  const teacher = { id: "delete:teacher", name: "Временный преподаватель", archived: false, subjectIds: [], defaultRoomId: null, preferredGroupIds: [], unavailability: [] };
  const room = { id: "delete:room", name: "Временный кабинет", archived: false, capacity: null, kind: "other" as const };
  const group = { id: "delete:group", name: "9Я", archived: false, students: 0, leaderId: null, roomId: null, autoRoomIds: [] };
  catalog.subjects.push(subject); catalog.teachers.push(teacher); catalog.rooms.push(room); catalog.groups.push(group);
  const added = await save(first.app, auth, initial.revision, catalog); assert.equal(added.statusCode, 200, added.body);
  const blockers = added.json().catalogDeletionBlockers;
  for (const [kind, id] of [["subjects", subject.id], ["teachers", teacher.id], ["rooms", room.id], ["groups", group.id]] as const) assert.deepEqual(blockers[kind][id], []);
  const dayCount = (first.db.prepare("SELECT COUNT(*) AS count FROM schedule_days WHERE group_id=?").get(group.id) as { count: number }).count;
  assert.ok(dayCount > 0);
  const afterAdd = added.json(); const nextCatalog = structuredClone(afterAdd.catalog) as Catalog;
  nextCatalog.subjects = nextCatalog.subjects.filter((item) => item.id !== subject.id);
  nextCatalog.teachers = nextCatalog.teachers.filter((item) => item.id !== teacher.id);
  nextCatalog.rooms = nextCatalog.rooms.filter((item) => item.id !== room.id);
  nextCatalog.groups = nextCatalog.groups.filter((item) => item.id !== group.id);
  const requestId = "delete-unused-entry-0001";
  const deleted = await save(first.app, auth, afterAdd.revision, nextCatalog, requestId);
  assert.equal(deleted.statusCode, 200, deleted.body); assert.equal(deleted.json().catalog.groups.some((item: any) => item.id === group.id), false);
  const beforeDeleteSchedule = Object.fromEntries(Object.entries(afterAdd.schedule).filter(([key]) => !key.startsWith(`${group.id}:`)));
  assert.deepEqual(deleted.json().schedule, beforeDeleteSchedule);
  assert.deepEqual(deleted.json().studyPlans, afterAdd.studyPlans);
  assert.deepEqual(deleted.json().curricula, afterAdd.curricula);
  assert.deepEqual(deleted.json().baseline, afterAdd.baseline);
  assert.equal((first.db.prepare("SELECT COUNT(*) AS count FROM schedule_days WHERE group_id=?").get(group.id) as { count: number }).count, 0);
  const replay = await save(first.app, auth, afterAdd.revision, nextCatalog, requestId); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().revision, deleted.json().revision);
  await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
  const reopened = await start(first.path); const reopenedAuth = await login(reopened.app); const persisted = await state(reopened.app, reopenedAuth);
  assert.equal(persisted.catalog.subjects.some((item: any) => item.id === subject.id), false);
  assert.equal(persisted.catalog.teachers.some((item: any) => item.id === teacher.id), false);
  assert.equal(persisted.catalog.rooms.some((item: any) => item.id === room.id), false);
  assert.equal(persisted.catalog.groups.some((item: any) => item.id === group.id), false);
});

test("past and future lessons, plan references, and same-request link clearing block deletion", async () => {
  const { app, db } = await start(); const auth = await login(app); const initial = await state(app, auth);
  const lesson = Object.values(initial.schedule as Record<string, any[]>).flatMap((days) => days.flatMap((day: any) => day.slots.flatMap((slot: any[]) => slot)))[0];
  assert.ok(lesson);
  const teacherDays = db.prepare("SELECT DISTINCT d.id FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.teacher_ref=? LIMIT 2").all(lesson.teacherId) as Array<{ id: number }>;
  assert.equal(teacherDays.length, 2);
  db.prepare("UPDATE schedule_days SET date='2001-01-01' WHERE id=?").run(teacherDays[0]!.id);
  db.prepare("UPDATE schedule_days SET date='2099-01-01' WHERE id=?").run(teacherDays[1]!.id);
  const blockerMap = initial.catalogDeletionBlockers;
  assert.ok(blockerMap.subjects[lesson.subjectId].length > 0);
  assert.ok(blockerMap.subjects[lesson.subjectId].includes("учебные планы"));
  assert.ok(blockerMap.teachers[lesson.teacherId].includes("занятия"));
  const catalog = structuredClone(initial.catalog) as Catalog;
  const subject = catalog.subjects.find((entry) => entry.id === lesson.subjectId)!;
  for (const teacher of catalog.teachers) teacher.subjectIds = teacher.subjectIds.filter((id) => id !== subject.id);
  catalog.subjects = catalog.subjects.filter((entry) => entry.id !== subject.id);
  const response = await save(app, auth, initial.revision, catalog);
  assert.equal(response.statusCode, 400); assert.match(response.json().error, /используется/);
  const stale = await save(app, auth, initial.revision - 1, catalog);
  assert.equal(stale.statusCode, 409);
  const csrf = await app.inject({ method: "PUT", url: "/api/catalog", headers: { ...headers(auth), "x-csrf-token": "wrong" }, payload: { catalog, revision: initial.revision, requestId: crypto.randomUUID() } });
  assert.equal(csrf.statusCode, 403);
  const malformed = await save(app, auth, initial.revision, {} as Catalog);
  assert.equal(malformed.statusCode, 400);
});

test("published catalogue membership alone does not block; operation origins preserve teacher history", async () => {
  const { app, db } = await start(); const auth = await login(app); const initial = await state(app, auth);
  const catalog = structuredClone(initial.catalog) as Catalog;
  const subject = { ...catalog.subjects[0]!, id: "history-only:subject", name: "Предмет только в каталоге", shortName: "Кат.", archived: false };
  const teacher = { id: "history-only:teacher", name: "Преподаватель с историей", archived: false, subjectIds: [], defaultRoomId: null, preferredGroupIds: [], unavailability: [] };
  catalog.subjects.push(subject); catalog.teachers.push(teacher);
  const added = await save(app, auth, initial.revision, catalog); assert.equal(added.statusCode, 200, added.body);
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json) VALUES('membership-only',1,'2026-01-01T00:00:00Z',0,'admin',?,'{}')").run(JSON.stringify({ catalog: added.json().catalog, schedule: {}, studyPlans: [], curricula: [], baseline: [], calendar: { weekdays: [1], periods: [] } }));
  const snapshotState = await state(app, auth);
  assert.deepEqual(snapshotState.catalogDeletionBlockers.subjects[subject.id], []);
  const removeSubject = structuredClone(snapshotState.catalog) as Catalog; removeSubject.subjects = removeSubject.subjects.filter((entry) => entry.id !== subject.id);
  const subjectDeleted = await save(app, auth, snapshotState.revision, removeSubject); assert.equal(subjectDeleted.statusCode, 200, subjectDeleted.body);

  db.prepare(`INSERT INTO teacher_replacement_operations(operation_id,apply_request_id,apply_fingerprint,apply_response_json,applied_revision,previous_schedule_json,previous_policies_json,previous_origins_json,previous_assignments_json)
    VALUES('history-operation','history-request','fingerprint','{"state":{}}',0,'{}','[]',?,'[]')`).run(JSON.stringify([{ id: "origin", lessonId: "gone", groupId: "5a", date: "2020-01-01", sourceTeacherId: teacher.id, substituteTeacherId: "replacement", kind: "transfer", startDate: "2020-01-01", endDate: "2020-01-01", expected: "x", status: "returned" }]));
  const historyState = await state(app, auth);
  assert.ok(historyState.catalogDeletionBlockers.teachers[teacher.id].includes("история операций"));
  const removeTeacher = structuredClone(historyState.catalog) as Catalog; removeTeacher.teachers = removeTeacher.teachers.filter((entry) => entry.id !== teacher.id);
  const blocked = await save(app, auth, historyState.revision, removeTeacher);
  assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /история операций/);
});

test("legacy text-only publication links and unreadable history fail closed while archive remains available", async () => {
  const { app, db } = await start(); const auth = await login(app); const initial = await state(app, auth);
  const catalog = structuredClone(initial.catalog) as Catalog;
  const groupId = catalog.groups[0]!.id;
  const teacher = { id: "legacy-history:teacher", name: "Неиспользуемый старый учитель", archived: false, subjectIds: [], defaultRoomId: null, preferredGroupIds: [], unavailability: [] };
  const room = { id: "legacy-history:room", name: "Неиспользуемый старый кабинет", archived: false, capacity: null, kind: "other" as const };
  const subgroup = { id: "legacy-history:subgroup", groupId, name: "Редкая подгруппа", students: 0, archived: false };
  const subject = { ...catalog.subjects[0]!, id: "legacy-history:unused-subject", name: "Нет ссылок на предмет", shortName: "Нет.", archived: false };
  catalog.teachers.push(teacher); catalog.rooms.push(room); catalog.subgroups.push(subgroup); catalog.subjects.push(subject);
  const added = await save(app, auth, initial.revision, catalog); assert.equal(added.statusCode, 200, added.body);
  const legacySnapshot = {
    catalog: added.json().catalog,
    schedule: { [`${groupId}:0`]: [{ slots: [[{ id: "legacy-text-lesson", teacher: teacher.name, room: room.name, subgroup: subgroup.name }]] }] },
    studyPlans: [], curricula: [], baseline: [], calendar: { weekdays: [1], periods: [] },
  };
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json) VALUES('legacy-text',1,'2026-01-01T00:00:00Z',0,'admin',?,'{}')").run(JSON.stringify(legacySnapshot));
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json) VALUES('broken-history',1,'2026-01-01T00:00:00Z',0,'admin','{broken','{}')").run();
  const inspected = await state(app, auth);
  assert.ok(inspected.catalogDeletionBlockers.teachers[teacher.id].includes("опубликованное расписание"));
  assert.ok(inspected.catalogDeletionBlockers.rooms[room.id].includes("опубликованное расписание"));
  assert.ok(inspected.catalogDeletionBlockers.subgroups[subgroup.id].includes("опубликованное расписание"));
  assert.ok(inspected.catalogDeletionBlockers.subjects[subject.id].some((reason: string) => reason.includes("не удалось проверить")));

  const archivedCatalog = structuredClone(inspected.catalog) as Catalog;
  archivedCatalog.teachers.find((entry) => entry.id === teacher.id)!.archived = true;
  const archived = await save(app, auth, inspected.revision, archivedCatalog); assert.equal(archived.statusCode, 200, archived.body);

  const latest = await state(app, auth);
  const removeTeacher = structuredClone(latest.catalog) as Catalog; removeTeacher.teachers = removeTeacher.teachers.filter((entry) => entry.id !== teacher.id);
  const teacherBlocked = await save(app, auth, latest.revision, removeTeacher); assert.equal(teacherBlocked.statusCode, 400); assert.match(teacherBlocked.json().error, /опубликованное расписание/);
  const removeSubgroup = structuredClone(latest.catalog) as Catalog; removeSubgroup.subgroups = removeSubgroup.subgroups.filter((entry) => entry.id !== subgroup.id);
  const subgroupBlocked = await save(app, auth, latest.revision, removeSubgroup); assert.equal(subgroupBlocked.statusCode, 400); assert.match(subgroupBlocked.json().error, /опубликованное расписание/);
  const removeSubject = structuredClone(latest.catalog) as Catalog; removeSubject.subjects = removeSubject.subjects.filter((entry) => entry.id !== subject.id);
  const subjectBlocked = await save(app, auth, latest.revision, removeSubject); assert.equal(subjectBlocked.statusCode, 400); assert.match(subjectBlocked.json().error, /не удалось проверить/);
});

test("published schedules preserve catalog references and the last active group cannot be deleted", async () => {
  const { app, db } = await start(); const auth = await login(app); const initial = await state(app, auth);
  const subject = initial.catalog.subjects[0]; const group = initial.catalog.groups.find((entry: any) => !entry.archived);
  assert.ok(subject && group);
  const publishedSnapshot = { schedule: { [`${group.id}:0`]: [{ slots: [[{ id: "history-lesson", subjectId: subject.id }]] } ] } };
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json) VALUES('history-test',1,'2026-01-01T00:00:00Z',0,'admin',?,'{}')").run(JSON.stringify(publishedSnapshot));
  const current = await state(app, auth); assert.ok(current.catalogDeletionBlockers.subjects[subject.id].includes("опубликованное расписание"));
  const catalog = structuredClone(current.catalog) as Catalog; catalog.subjects = catalog.subjects.filter((entry) => entry.id !== subject.id);
  const blocked = await save(app, auth, current.revision, catalog); assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /опубликованное расписание/);
  const keepGroup = current.catalog.groups.find((entry: any) => !entry.archived)!;
  const archivedOthers = structuredClone(current.catalog) as Catalog; archivedOthers.groups = archivedOthers.groups.map((entry) => ({ ...entry, archived: entry.id !== keepGroup.id }));
  const oneActive = await save(app, auth, current.revision, archivedOthers); assert.equal(oneActive.statusCode, 200, oneActive.body);
  assert.ok(oneActive.json().catalogDeletionBlockers.groups[keepGroup.id].includes("последняя действующая группа"));
  const removeLast = structuredClone(oneActive.json().catalog) as Catalog; removeLast.groups = removeLast.groups.filter((entry) => entry.id !== keepGroup.id);
  const lastGroup = await save(app, auth, oneActive.json().revision, removeLast); assert.equal(lastGroup.statusCode, 400); assert.match(lastGroup.json().error, /последнюю действующую группу/);
});
