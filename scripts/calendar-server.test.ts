import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { calendarDay } from "../shared/schoolCalendar.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";
function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-calendar-server-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}
async function setup() {
  const path = dbPath();
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string };
  return { app, path, headers };
}
async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("calendar API persists scoped periods and requires confirmation before removing lessons", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const [groupKey, days] = Object.entries(before.schedule).find(([, entries]) => entries.some((day) => day.slots.some((slot) => slot.length)))!;
  const groupId = groupKey.slice(0, groupKey.lastIndexOf(":"));
  const lessonDay = days.find((day) => day.slots.some((slot) => slot.length))!;
  const calendar = { weekdays: [1, 2, 3, 4, 5], periods: [{ id: "holiday-test", name: "Каникулы", kind: "holiday" as const, startDate: lessonDay.date, endDate: lessonDay.date, groupIds: [groupId] }] };
  const request = { calendar, revision: before.revision, requestId: "calendar-confirm-test-01", confirmLessonRemoval: false };
  const preview = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: request });
  assert.equal(preview.statusCode, 409, preview.body);
  assert.ok(preview.json().removedCount > 0);
  assert.equal((await state(app, headers)).revision, before.revision);
  const noAuth = await app.inject({ method: "PUT", url: "/api/calendar", headers: { origin, host: "127.0.0.1" }, payload: request });
  assert.equal(noAuth.statusCode, 401);
  const badCsrf = await app.inject({ method: "PUT", url: "/api/calendar", headers: { ...headers, "x-csrf-token": "wrong" }, payload: request });
  assert.equal(badCsrf.statusCode, 403);
  const saved = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { ...request, confirmLessonRemoval: true } });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.equal(after.calendar?.periods[0].id, "holiday-test");
  assert.equal(after.schedule[groupKey].find((day) => day.date === lessonDay.date)?.holiday, true);
  assert.equal(after.schedule[groupKey].find((day) => day.date === lessonDay.date)?.slots.flat().length, 0);
  const replay = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { ...request, confirmLessonRemoval: true } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as StateResponse).revision, after.revision, "replay does not increment revision");
  const stale = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { ...request, revision: before.revision, requestId: "calendar-stale-test-01", confirmLessonRemoval: true } });
  assert.equal(stale.statusCode, 409);
});

test("calendar API persists different regular weekdays for separate groups", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const youngerId = before.catalog.groups.find((group) => group.name === "5А")?.id;
  const olderId = before.catalog.groups.find((group) => group.name === "6А")?.id;
  assert.ok(youngerId && olderId);
  const calendar = {
    weekdays: [1, 2, 3, 4, 5],
    groupWeekdays: { [youngerId]: [1, 2, 3, 4, 5], [olderId]: [1, 2, 3, 4, 5, 6] },
    periods: [],
  };
  const saved = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: {
    calendar, revision: before.revision, requestId: "calendar-group-weekdays-01", confirmLessonRemoval: true,
  } });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.deepEqual(after.calendar?.groupWeekdays, calendar.groupWeekdays);
  assert.equal(calendarDay(after.calendar!, youngerId, "2026-09-05").kind, "weekend");
  assert.equal(calendarDay(after.calendar!, olderId, "2026-09-05").kind, "regular");
});

test("schoolwide periods apply to quarter dates and groups materialized later", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const calendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [{ id: "schoolwide-date", name: "Общий выходной", kind: "day-off" as const, startDate: "2026-11-09", endDate: "2026-11-09", groupIds: null }],
  };
  const savedCalendar = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { calendar, revision: before.revision, requestId: "calendar-global-save-01", confirmLessonRemoval: false } });
  assert.equal(savedCalendar.statusCode, 200, savedCalendar.body);
  const replay = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { calendar, revision: before.revision, requestId: "calendar-global-save-01", confirmLessonRemoval: false } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as StateResponse).revision, (savedCalendar.json() as StateResponse).revision);

  const first = savedCalendar.json() as StateResponse;
  const quarters = [...first.quarters, { id: "calendar-q2", name: "II четверть", startDate: "2026-11-02", endDate: "2026-11-30" }];
  const addedQuarter = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: { quarters, studyPlans: first.studyPlans, revision: first.revision, requestId: "calendar-quarter-add-01" } });
  assert.equal(addedQuarter.statusCode, 200, addedQuarter.body);
  const withQuarter = addedQuarter.json() as StateResponse;
  assert.equal(withQuarter.schedule["5a:5"].find((day) => day.date === "2026-11-09")?.holiday, true);

  const catalog = structuredClone(withQuarter.catalog);
  const groupId = "calendar-test-group";
  catalog.groups.push({ id: groupId, name: "Тест календаря", students: 20, leaderId: null, roomId: null, autoRoomIds: [], archived: false });
  const addedGroup = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: withQuarter.revision, requestId: "calendar-group-add-01" } });
  assert.equal(addedGroup.statusCode, 200, addedGroup.body);
  const after = addedGroup.json() as StateResponse;
  const newGroupDays = after.schedule[`${groupId}:5`];
  assert.equal(newGroupDays.length, 7);
  assert.equal(newGroupDays.find((day) => day.date === "2026-11-09")?.holiday, true);
});

test("calendar migration imports old holiday flags and preserves lesson, day times, and notes", async () => {
  const { app, path, headers } = await setup();
  const before = await state(app, headers);
  const [scheduleKey, days] = Object.entries(before.schedule).find(([, entries]) => entries.some((day) => day.slots.some((slot) => slot.length)))!;
  const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
  const oldDay = days.find((day) => day.slots.some((slot) => slot.length))!;
  const lesson = oldDay.slots.flat()[0];
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  const dayRow = db.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get(groupId, oldDay.date) as { id: number };
  db.prepare("UPDATE schedule_days SET holiday=1,note='Старые каникулы' WHERE id=?").run(dayRow.id);
  db.prepare("DELETE FROM schedule_days WHERE day_index>=5").run();
  db.exec("DROP TABLE school_calendar; DELETE FROM schema_migrations WHERE version=9");
  db.close();
  const upgraded = await buildApp({ dbPath: path });
  apps.push(upgraded);
  const login = await upgraded.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const after = await state(upgraded, { cookie, origin, host: "127.0.0.1" });
  const migrated = after.schedule[scheduleKey].find((day) => day.date === oldDay.date)!;
  assert.ok(after.calendar?.periods.some((period) => period.name === "Старые каникулы" && period.groupIds?.includes(groupId)));
  assert.equal(migrated.holiday, true);
  assert.equal(migrated.note, "Старые каникулы");
  assert.deepEqual(migrated.times, oldDay.times);
  assert.ok(migrated.slots.flat().some((entry) => entry.id === lesson.id), "migration keeps legacy lessons on flagged days");
  assert.equal(after.schedule[scheduleKey].length, 7);
});

test("schema 9 startup restores missing week days without changing existing rows", async () => {
  const { app, path, headers } = await setup();
  const initial = await state(app, headers);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  const daysBefore = db.prepare("SELECT * FROM schedule_days WHERE day_index<5 ORDER BY group_id,date").all();
  const slotsBefore = db.prepare("SELECT d.group_id,d.date,s.* FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id WHERE d.day_index<5 ORDER BY d.group_id,d.date,s.slot_index").all();
  const lessonsBefore = db.prepare("SELECT d.group_id,d.date,s.slot_index,l.* FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id JOIN lessons l ON l.slot_id=s.id WHERE d.day_index<5 ORDER BY d.group_id,d.date,s.slot_index,l.id").all();
  db.prepare("DELETE FROM schedule_days WHERE day_index>=5").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schedule_days").get() as { count: number }).count, daysBefore.length);
  db.close();

  const recoveredApp = await buildApp({ dbPath: path });
  apps.push(recoveredApp);
  const login = await recoveredApp.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const recovered = await state(recoveredApp, { cookie, origin, host: "127.0.0.1" });
  assert.equal(recovered.revision, initial.revision + 1);
  const restoredDb = new Database(path, { readonly: true });
  assert.deepEqual(restoredDb.prepare("SELECT * FROM schedule_days WHERE day_index<5 ORDER BY group_id,date").all(), daysBefore);
  assert.deepEqual(restoredDb.prepare("SELECT d.group_id,d.date,s.* FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id WHERE d.day_index<5 ORDER BY d.group_id,d.date,s.slot_index").all(), slotsBefore);
  assert.deepEqual(restoredDb.prepare("SELECT d.group_id,d.date,s.slot_index,l.* FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id JOIN lessons l ON l.slot_id=s.id WHERE d.day_index<5 ORDER BY d.group_id,d.date,s.slot_index,l.id").all(), lessonsBefore);
  assert.ok(Object.values(recovered.schedule).every((days) => days.length === 7));
  restoredDb.close();
  await recoveredApp.close();
  apps.splice(apps.indexOf(recoveredApp), 1);

  const stableApp = await buildApp({ dbPath: path });
  apps.push(stableApp);
  const secondLogin = await stableApp.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(secondLogin.statusCode, 200, secondLogin.body);
  const secondRaw = secondLogin.headers["set-cookie"];
  const secondCookie = (Array.isArray(secondRaw) ? secondRaw[0] : secondRaw)?.split(";")[0];
  assert.ok(secondCookie);
  const stable = await state(stableApp, { cookie: secondCookie, origin, host: "127.0.0.1" });
  assert.equal(stable.revision, recovered.revision, "an already complete calendar does not bump revision again");
});

test("ordinary schedule endpoint cannot change calendar holiday status or add lessons on non-study dates", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const schedule = structuredClone(before.schedule);
  const [, days] = Object.entries(schedule).find(([, entries]) => entries.length)!;
  const day = days[0];
  day.holiday = true;
  const changedFlag = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule, revision: before.revision, requestId: "calendar-flag-bypass-01" } });
  assert.equal(changedFlag.statusCode, 400);
  const [lessonGroupKey, lessonDays] = Object.entries(before.schedule).find(([, entries]) => entries.some((entry) => entry.slots.some((slot) => slot.length)))!;
  const lessonGroupId = lessonGroupKey.slice(0, lessonGroupKey.lastIndexOf(":"));
  const occupiedDay = lessonDays.find((entry) => entry.slots.some((slot) => slot.length))!;
  const savedCalendar = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: {
    calendar: { weekdays: [1, 2, 3, 4, 5], periods: [{ id: "bypass-test", name: "Выходной", kind: "day-off", startDate: occupiedDay.date, endDate: occupiedDay.date, groupIds: [lessonGroupId] }] },
    revision: before.revision, requestId: "calendar-bypass-period-01", confirmLessonRemoval: true,
  } });
  assert.equal(savedCalendar.statusCode, 200, savedCalendar.body);
  const holidayState = savedCalendar.json() as StateResponse;
  const holidaySchedule = structuredClone(holidayState.schedule);
  const holiday = holidaySchedule[lessonGroupKey].find((entry) => entry.date === occupiedDay.date)!;
  const emptySlot = holiday.slots.find((slot) => slot.length === 0)!;
  emptySlot.push({ id: "new-holiday-lesson-test", subjectId: "event", event: "Линейка" });
  const added = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: holidaySchedule, revision: holidayState.revision, requestId: "calendar-lesson-bypass-01" } });
  assert.equal(added.statusCode, 400);
});
