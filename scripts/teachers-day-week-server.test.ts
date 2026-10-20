import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";
import type Database from "better-sqlite3";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-teachers-day-week-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "test.sqlite") });
  apps.push(app);
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "teacher test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  return { app, state, db };
}

function save(db: Database.Database, snapshot: PublicationSnapshot, version: number, publishedAt: string) {
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(quarter_id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    draft_revision=excluded.draft_revision,published_by=excluded.published_by,snapshot_json=excluded.snapshot_json,summary_json=excluded.summary_json`)
    .run(snapshot.quarter.id, version, publishedAt, 9, "PRIVATE_MARKER", JSON.stringify(snapshot), "{}");
}

const addDays = (value: string, amount: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

const dateRange = (start: string, end: string) => {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("teacher day/week endpoints match the published quarter projection and refresh on publication changes", async () => {
  const { app, state, db } = await setup();
  assert.deepEqual((await app.inject({ url: "/api/public/teachers/day?date=2026-10-01" })).json(), {
    requestedDate: "2026-10-01", date: "2026-10-01", hasPublications: false, teachers: [],
  });
  for (const url of [
    "/api/public/teachers/day", "/api/public/teachers/day?date=2026-02-30",
    "/api/public/teachers/day?date=2026-10-01&nextStudyDay=yes",
    "/api/public/teachers/week", "/api/public/teachers/week?quarterId=q&weekStart=2026-10-06",
    "/api/public/teachers/week?quarterId=q&weekStart=2026-02-30",
    "/api/public/teachers/week?quarterId=q&weekStart=9999-12-27",
  ]) assert.equal((await app.inject({ url })).statusCode, 400, url);

  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const initialQuarterStart = quarter.startDate;
  const quarterStartWeekday = new Date(`${initialQuarterStart}T00:00:00Z`).getUTCDay();
  const beforeStartMonday = addDays(initialQuarterStart, -((quarterStartWeekday + 6) % 7));
  const lessonMonday = Array.from({ length: 8 }, (_, offset) => addDays(initialQuarterStart, offset))
    .find((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1)!;
  assert.ok(lessonMonday, "fixture quarter should include a Monday");
  const quarterEnd = addDays(lessonMonday, 10);
  const [groupA, groupB, groupC] = snapshot.catalog.groups.slice(0, 3).map((item) => structuredClone(item));
  assert.ok(groupA && groupB && groupC, "fixture needs three groups");
  snapshot.catalog.groups = [groupA, groupB, groupC];
  const sourceTeacher = structuredClone(snapshot.catalog.teachers[0]!);
  const idle = { ...sourceTeacher, id: "active-idle", name: "Активный без занятий", archived: false };
  const archived = { ...sourceTeacher, id: "archived-with-later-lesson", name: "Архивный преподаватель", archived: true };
  snapshot.catalog.teachers = [idle, archived];
  const subject = structuredClone(snapshot.catalog.subjects[0]!);
  const room = structuredClone(snapshot.catalog.rooms[0]!);
  snapshot.catalog.subjects = [subject];
  snapshot.catalog.rooms = [room];
  snapshot.catalog.subgroups = [
    { id: "fixture-sub-one", name: "1 подгруппа", archived: false, groupId: groupA.id, students: 10 },
    { id: "fixture-sub-two", name: "2 подгруппа", archived: false, groupId: groupA.id, students: 10 },
  ];
  snapshot.quarter.startDate = initialQuarterStart;
  snapshot.quarter.endDate = quarterEnd;
  const lesson = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, subjectId: subject.id, teacherId: archived.id, roomId: room.id, lessonKind: "regular" as const, note: "PRIVATE_LESSON_NOTE", ...overrides,
  });
  const makeDay = (date: string, times: number[], slots: Array<Array<Record<string, unknown>>>, holiday = false) => ({
    date, start: "08:00", duration: 45, breaks: times.slice(1).map(() => 15),
    times: times.map((start) => ({ start, duration: 45 })), slots, holiday,
  });
  const aMonday = makeDay(lessonMonday, [480], [
    [lesson("ordinary"), lesson("subgroup-one", { subgroupId: "fixture-sub-one" }), lesson("subgroup-two", { subgroupId: "fixture-sub-two" })],
  ], true);
  const bMonday = makeDay(lessonMonday, [720, 780], [[], [lesson("joint-b", { jointId: "joint-fixture" })]]);
  const cMonday = makeDay(lessonMonday, [780], [[lesson("joint-c", { jointId: "joint-fixture" })]]);
  const bNextMonday = makeDay(addDays(lessonMonday, 7), [720], [[lesson("outside-week")]]);
  const bQuarterStart = makeDay(initialQuarterStart, [480], [[]]);
  snapshot.schedule = {
    [`${groupA.id}:0`]: [aMonday],
    [`${groupB.id}:0`]: [bQuarterStart, bMonday, bNextMonday],
    [`${groupC.id}:0`]: [cMonday],
  } as unknown as PublicationSnapshot["schedule"];
  snapshot.calendar = { weekdays: [1, 2, 3, 4, 5], periods: [
    { id: "fixture-holiday", name: "Праздник для группы A", kind: "holiday", startDate: lessonMonday, endDate: lessonMonday, groupIds: [groupA.id] },
    { id: "fixture-global-holiday", name: "Общий праздник", kind: "holiday", startDate: lessonMonday, endDate: lessonMonday, groupIds: null },
    { id: "fixture-study-override", name: "Учебный день группы A", kind: "study", startDate: lessonMonday, endDate: lessonMonday, groupIds: [groupA.id] },
    { id: "fixture-start-global-holiday", name: "Выходной в начале четверти", kind: "holiday", startDate: initialQuarterStart, endDate: initialQuarterStart, groupIds: null },
    { id: "fixture-start-study-override", name: "Учебный день группы B", kind: "study", startDate: initialQuarterStart, endDate: initialQuarterStart, groupIds: [groupB.id] },
  ] };
  save(db, snapshot, 1, "2026-10-13T00:00:00.000Z");

  const fullResponse = await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${archived.id}` });
  assert.equal(fullResponse.statusCode, 200, fullResponse.body);
  const full = fullResponse.json();
  const targetDay = full.days.find((item: { date: string }) => item.date === lessonMonday);
  assert.equal(targetDay.holiday, false, "quarter-wide assignment in group B prevents a false holiday when group A is closed");
  assert.equal(targetDay.lessons.length, 4, "ordinary, two subgroups, and a mirrored joint lesson are projected separately");
  const joint = targetDay.lessons.find((item: { id: string }) => item.id === "joint-b");
  assert.deepEqual(joint.groups.map((item: { id: string; slot: number; dayStart: number }) => [item.id, item.slot, item.dayStart]), [
    [groupB.id, 2, 720], [groupC.id, 1, 780],
  ]);
  assert.ok(targetDay.gaps?.length, "the long interval should be represented as a gap");

  const dayResponse = await app.inject({ url: `/api/public/teachers/day?date=${lessonMonday}` });
  assert.equal(dayResponse.statusCode, 200, dayResponse.body);
  const dayValue = dayResponse.json();
  const teachers = dayValue.teachers as Array<{ id: string; name: string; day?: unknown }>;
  assert.deepEqual(teachers.map((item) => item.id), [idle.id, archived.id]);
  assert.equal(JSON.stringify(teachers.find((item) => item.id === archived.id)?.day), JSON.stringify(targetDay));
  assert.equal(teachers.find((item) => item.id === idle.id)?.day && (teachers.find((item) => item.id === idle.id)!.day as { lessons: unknown[] }).lessons.length, 0);

  const mondayBeforeQuarter = await app.inject({ url: `/api/public/teachers/week?quarterId=${quarter.id}&weekStart=${beforeStartMonday}` });
  assert.equal(mondayBeforeQuarter.statusCode, 200, mondayBeforeQuarter.body);
  const partialWeek = mondayBeforeQuarter.json();
  const clippedDates = dateRange(initialQuarterStart, addDays(beforeStartMonday, 6));
  assert.deepEqual(partialWeek.teachers.find((item: { id: string }) => item.id === archived.id).days.map((item: { date: string }) => item.date), clippedDates);
  assert.equal(partialWeek.teachers.find((item: { id: string }) => item.id === archived.id).days[0].holiday, false,
    "a study override in group B keeps the teacher workday open although the override group's lesson is outside the slice");
  assert.ok(partialWeek.teachers.some((item: { id: string }) => item.id === archived.id), "archived teacher remains included because of a quarter lesson outside the selected week");
  const lessonWeek = await app.inject({ url: `/api/public/teachers/week?quarterId=${quarter.id}&weekStart=${lessonMonday}` });
  assert.equal(lessonWeek.statusCode, 200, lessonWeek.body);
  const weekValue = lessonWeek.json();
  const archivedWeek = weekValue.teachers.find((item: { id: string }) => item.id === archived.id);
  const expectedWeek = full.days.filter((item: { date: string }) => item.date >= lessonMonday && item.date <= addDays(lessonMonday, 6));
  assert.deepEqual(archivedWeek.days, expectedWeek, "week slice must match the published quarter projection");
  assert.equal(archivedWeek.days.at(-1).date, addDays(lessonMonday, 6));
  assert.equal(weekValue.teachers.find((item: { id: string }) => item.id === idle.id).days.length, 7);
  assert.ok(weekValue.teachers.find((item: { id: string }) => item.id === idle.id).days.every((item: { lessons: unknown[] }) => item.lessons.length === 0));
  assert.equal(JSON.stringify({ dayValue, partialWeek, weekValue }).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify({ dayValue, partialWeek, weekValue }).includes("publishedBy"), false);
  assert.equal((await app.inject({ url: `/api/public/teachers/week?quarterId=${quarter.id}&weekStart=${addDays(lessonMonday, 14)}` })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/public/teachers/week?quarterId=unknown&weekStart=${lessonMonday}` })).statusCode, 404);

  const noFuture = await app.inject({ url: `/api/public/teachers/day?date=${addDays(lessonMonday, 8)}&nextStudyDay=true` });
  assert.equal(noFuture.json().date, addDays(lessonMonday, 8), "no future teaching date falls back to the requested in-quarter date");
  assert.equal(noFuture.json().requestedDate, addDays(lessonMonday, 8));
  const studentsNoFuture = await app.inject({ url: `/api/public/students/day?date=${addDays(lessonMonday, 8)}&nextStudyDay=true` });
  assert.equal(noFuture.json().date, studentsNoFuture.json().date, "teacher and student day navigation share the no-future fallback");

  const updated = structuredClone(snapshot);
  updated.catalog.teachers.find((teacher) => teacher.id === archived.id)!.name = "Архивный после публикации";
  const updatedDay = updated.schedule[`${groupA.id}:0`]!.find((item) => item.date === lessonMonday)!;
  updatedDay.slots[0]![0] = lesson("after-publish");
  save(db, updated, 2, "2026-10-14T00:00:00.000Z");
  const refreshedDay = await app.inject({ url: `/api/public/teachers/day?date=${lessonMonday}` });
  assert.equal(refreshedDay.json().teachers.find((item: { id: string }) => item.id === archived.id).name, "Архивный после публикации");
  assert.equal(refreshedDay.json().teachers.find((item: { id: string }) => item.id === archived.id).day.lessons[0].id, "after-publish");
  const refreshedWeek = await app.inject({ url: `/api/public/teachers/week?quarterId=${quarter.id}&weekStart=${lessonMonday}` });
  assert.equal(refreshedWeek.json().publication.version, 2);
  assert.equal(refreshedWeek.json().teachers.find((item: { id: string }) => item.id === archived.id).name, "Архивный после публикации");
  assert.equal(refreshedWeek.json().teachers.find((item: { id: string }) => item.id === archived.id).days[0].lessons[0].id, "after-publish");

  db.prepare("DELETE FROM published_quarters WHERE quarter_id=?").run(quarter.id);
  const deleted = await app.inject({ url: `/api/public/teachers/day?date=${lessonMonday}` });
  assert.deepEqual(deleted.json(), { requestedDate: lessonMonday, date: lessonMonday, hasPublications: false, teachers: [] });
  assert.equal((await app.inject({ url: `/api/public/teachers/week?quarterId=${quarter.id}&weekStart=${lessonMonday}` })).statusCode, 404);
});
