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

async function appWithAdmin(existingDbPath?: string) {
  const root = existingDbPath ? undefined : mkdtempSync(join(tmpdir(), "smena-teachers-server-"));
  if (root) roots.push(root);
  const dbPath = existingDbPath ?? join(root!, "teachers.sqlite");
  const app = await buildApp({ dbPath });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "teacher test password" } });
  if (auth.statusCode !== 200)
    auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "teacher test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  return { app, dbPath, headers, state: stateResponse.json() as StateResponse, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}

function storeSnapshot(db: Database.Database, snapshot: PublicationSnapshot, version: number, publishedAt: string) {
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(quarter_id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    draft_revision=excluded.draft_revision,published_by=excluded.published_by,snapshot_json=excluded.snapshot_json,summary_json=excluded.summary_json`)
    .run(snapshot.quarter.id, version, publishedAt, 987654, "PRIVATE_PUBLISHER_MARKER", JSON.stringify(snapshot), "{}");
}

const datePlus = (date: string, days: number) => {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("teacher shift colors can use each group's actual day start for afternoon fifth lessons", async () => {
  const { app, state, db } = await appWithAdmin();
  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const teacher = snapshot.catalog.teachers[0]!;
  const subject = snapshot.catalog.subjects[0]!;
  const room = snapshot.catalog.rooms[0]!;
  const groups = snapshot.catalog.groups.slice(0, 3);
  assert.equal(groups.length, 3);
  const starts = [495, 825, 720];
  snapshot.schedule = Object.fromEntries(groups.map((group, index) => {
    const lesson = { id: `shift-fifth-${index}`, subjectId: subject.id, teacherId: teacher.id, roomId: room.id, lessonKind: "regular" as const };
    const times = Array.from({ length: 5 }, (_, slot) => ({ start: starts[index]! + slot * 60, duration: 45 }));
    return [`${group.id}:0`, [{
      date: quarter.startDate,
      // Stored labels and profiles must not override the actual first time slot.
      start: "08:00", duration: 45, breaks: [15, 15, 15, 15],
      times, slots: [[], [], [], [], [lesson]], holiday: false,
    }]];
  }));
  storeSnapshot(db, snapshot, 1, "2026-10-13T00:00:00.000Z");
  const response = await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${teacher.id}` });
  assert.equal(response.statusCode, 200, response.body);
  const lessons = response.json().days.find((day: { date: string }) => day.date === quarter.startDate).lessons;
  assert.deepEqual(lessons.map((lesson: { start: number }) => lesson.start), [735, 960, 1065]);
  assert.ok(lessons.every((lesson: { groups: Array<{ slot: number }> }) => lesson.groups[0]!.slot === 5));
  assert.deepEqual(lessons.map((lesson: { groups: Array<{ dayStart: number }> }) => lesson.groups[0]!.dayStart), [495, 720, 825]);
});

test("public teacher endpoints are anonymous, read-only, and return an empty index before publication", async () => {
  const { app } = await appWithAdmin();
  assert.deepEqual((await app.inject({ url: "/api/public/teachers" })).json(), { quarters: [] });
  assert.equal((await app.inject({ url: "/api/public/teachers/schedule" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/public/teachers/schedule?quarterId=q&teacherId=t" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/publications/q" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/publication-preview?quarterId=q" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/publications", headers: { origin, host: "127.0.0.1" }, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/state", headers: { origin, host: "127.0.0.1" }, payload: {} })).statusCode, 401);
});

test("teacher schedules use exact IDs, combine only matching joint mirrors, preserve calendar scope, and refresh from new publications", async () => {
  const { app, state, db, dbPath, headers } = await appWithAdmin();
  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const publishableLesson = Object.entries(state.schedule).flatMap(([key, days]) =>
    days.filter((day) => day.date >= quarter.startDate && day.date <= quarter.endDate)
      .flatMap((day) => day.slots.flatMap((slot) => slot.filter((lesson) => lesson.teacherId && lesson.roomId).map((lesson) => ({ groupId: key.slice(0, key.lastIndexOf(":")), lesson })))),
  )[0];
  assert.ok(publishableLesson, "fixture must contain a publishable lesson");
  const originalTeacher = snapshot.catalog.teachers.find((teacher) => teacher.id === publishableLesson.lesson.teacherId)!;
  const first = structuredClone(snapshot.catalog.groups[0]!);
  const second = structuredClone(snapshot.catalog.groups[1]!);
  first.archived = false;
  second.archived = false;
  snapshot.catalog.groups = [first, second];
  const target = { ...structuredClone(originalTeacher), name: "Однофамилец", archived: true, unavailability: [{ id: "private-rule", startDate: quarter.startDate, endDate: quarter.endDate, start: 0, end: 30, reason: "PRIVATE_AVAILABILITY_MARKER" }] };
  const homonym = { ...structuredClone(originalTeacher), id: "homonym-teacher", name: target.name, archived: false };
  const archived = { ...structuredClone(originalTeacher), id: "archived-teacher", name: "Архивный преподаватель", archived: true };
  const idle = { ...structuredClone(originalTeacher), id: "idle-teacher", name: "Без занятий", archived: false };
  snapshot.catalog.teachers = [target, homonym, archived, idle];
  const subject = snapshot.catalog.subjects[0]!;
  const room = snapshot.catalog.rooms[0]!;
  snapshot.catalog.subjects = [subject];
  snapshot.catalog.rooms = [room];
  snapshot.catalog.subgroups = [
    { id: "sub-one", name: "1 подгруппа", archived: false, groupId: first.id, students: 10 },
    { id: "sub-two", name: "Подгруппа2", archived: false, groupId: first.id, students: 11 },
  ];
  first.leaderId = "PRIVATE_LEADER_MARKER";
  first.students = 50;
  const date1 = quarter.startDate;
  const date2 = datePlus(date1, 1);
  const date3 = datePlus(date1, 2);
  const date4 = datePlus(date1, 3);
  const makeDay = (date: string, starts: number[]) => ({
    date,
    start: 480,
    duration: 45,
    breaks: [10, 10, 10, 10, 10],
    times: starts.map((start) => ({ start, duration: 45 })),
    slots: starts.map(() => [] as Array<Record<string, unknown>>),
    holiday: false,
    note: "PRIVATE_DAY_NOTE_MARKER",
  });
  const startsA = [480, 540, 600, 660, 720, 780];
  const startsB = [480, 550, 600, 660, 720, 780];
  const dayA1 = makeDay(date1, startsA);
  const dayB1 = makeDay(date1, startsB);
  const dayA2 = makeDay(date2, startsA);
  const dayB2 = makeDay(date2, startsB);
  const dayA3 = makeDay(date3, startsA);
  const dayB3 = makeDay(date3, startsB);
  const lesson = (id: string, teacherId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    subjectId: subject.id,
    teacherId,
    roomId: room.id,
    note: "PRIVATE_LESSON_NOTE_MARKER",
    lessonKind: "regular",
    ...overrides,
  });
  dayA1.slots[0]!.push(lesson("ordinary-a", target.id));
  dayB1.slots[0]!.push(lesson("ordinary-b", target.id));
  dayA1.slots[2]!.push(lesson("subgroup-one", target.id, { subgroupId: "sub-one" }));
  dayA1.slots[2]!.push(lesson("subgroup-two", target.id, { subgroupId: "sub-two" }));
  dayA1.slots[2]!.push(lesson("homonym-lesson", homonym.id, { subgroupId: "sub-one" }));
  dayB1.times[4] = { start: 600, duration: 45 };
  dayA1.slots[2]!.push(lesson("joint-day-one-a", target.id, { jointId: "repeat-joint" }));
  dayB1.slots[4]!.push(lesson("joint-day-one-b", target.id, { jointId: "repeat-joint" }));
  dayA1.slots[3]!.push(lesson("joint-event-a", target.id, { subjectId: "event", event: "Общий классный час", jointId: "shared-event" }));
  dayB1.times[5] = { start: 660, duration: 45 };
  dayB1.slots[5]!.push(lesson("joint-event-b", target.id, { subjectId: "event", event: "Общий классный час", jointId: "shared-event" }));
  dayA2.times[1] = { start: 600, duration: 45 };
  dayB2.times[3] = { start: 600, duration: 45 };
  dayA2.slots[1]!.push(lesson("joint-day-two-a", target.id, { jointId: "repeat-joint" }));
  dayB2.slots[3]!.push(lesson("joint-day-two-b", target.id, { jointId: "repeat-joint" }));
  dayB2.times[5] = { start: 720, duration: 45 };
  dayA2.slots[4]!.push(lesson("joint-day-two-second-a", target.id, { jointId: "repeat-joint" }));
  dayB2.slots[5]!.push(lesson("joint-day-two-second-b", target.id, { jointId: "repeat-joint" }));
  dayA2.slots[4]!.push(lesson("archived-teacher-lesson", archived.id));
  snapshot.schedule = {
    [`${first.id}:0`]: [dayA1, dayA2, dayA3],
    [`${second.id}:0`]: [dayB1, dayB2, dayB3],
  } as unknown as PublicationSnapshot["schedule"];
  snapshot.calendar ??= { weekdays: [1, 2, 3, 4, 5], periods: [] };
  snapshot.calendar.periods.push(
    { id: "one-group-vacation", name: "Каникулы только 5А", kind: "holiday", startDate: date1, endDate: date1, groupIds: [first.id] },
    { id: "all-groups-vacation", name: "Общие каникулы", kind: "holiday", startDate: date2, endDate: date2, groupIds: [first.id, second.id] },
    { id: "all-groups-day-off", name: "Общий выходной", kind: "day-off", startDate: date3, endDate: date3, groupIds: [first.id, second.id] },
    { id: "school-vacation", name: "Каникулы школы", kind: "holiday", startDate: date4, endDate: date4, groupIds: null },
  );
  storeSnapshot(db, snapshot, 1, "2026-10-13T00:00:00.000Z");

  const indexResponse = await app.inject({ url: "/api/public/teachers" });
  assert.equal(indexResponse.statusCode, 200, indexResponse.body);
  const index = indexResponse.json();
  const teachers = index.quarters[0].teachers as Array<{ id: string; name: string; lessonDates: string[] }>;
  assert.ok(teachers.some((item) => item.id === target.id), "archived teacher with published lessons must be listed");
  assert.ok(teachers.some((item) => item.id === idle.id), "active teacher without lessons must be listed");
  assert.ok(teachers.some((item) => item.id === archived.id));
  assert.equal(teachers.filter((item) => item.name === target.name).length, 2, "homonyms remain separate catalog IDs");
  const targetResponse = await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${target.id}` });
  assert.equal(targetResponse.statusCode, 200, targetResponse.body);
  const schedule = targetResponse.json();
  assert.deepEqual(schedule.teacher, { id: target.id, name: target.name });
  assert.equal(schedule.days.length, Math.round((Date.parse(`${quarter.endDate}T00:00:00Z`) - Date.parse(`${quarter.startDate}T00:00:00Z`)) / 86400000) + 1);
  const lessons1 = schedule.days.find((day: { date: string }) => day.date === date1).lessons as Array<Record<string, unknown>>;
  assert.equal(lessons1.filter((item) => item.start === 480).length, 2, "ordinary lessons remain separate even at the same time");
  assert.equal(lessons1.some((item) => item.id === "homonym-lesson"), false, "lesson assignment uses exact teacher ID");
  assert.equal(lessons1.filter((item) => item.id === "joint-day-one-a").length, 1);
  const joint1 = lessons1.find((item) => item.id === "joint-day-one-a") as { groups: Array<{ id: string; slot: number }> };
  assert.deepEqual(joint1.groups.map((group) => [group.id, group.slot]), [[first.id, 3], [second.id, 5]]);
  assert.equal(lessons1.filter((item) => item.event === "Общий классный час").length, 1, "a mirrored joint event appears once");
  assert.equal(schedule.days.find((day: { date: string }) => day.date === date1).holiday, false, "one group's vacation cannot close the teacher schedule");
  const lessons2 = schedule.days.find((day: { date: string }) => day.date === date2).lessons as Array<{ id: string; start: number; groups: unknown[] }>;
  assert.equal(lessons2.length, 2, "same joint ID at different intervals must remain two lessons");
  assert.deepEqual(lessons2.map((item) => item.start), [600, 720]);
  assert.ok(lessons2.every((item) => item.groups.length === 2));
  const teacherDay2 = schedule.days.find((day: { date: string }) => day.date === date2);
  assert.equal(teacherDay2.holiday, true);
  assert.equal(teacherDay2.holidayKind, "vacation");
  assert.equal(teacherDay2.calendarLabel, "Общие каникулы");
  assert.equal(schedule.days.find((day: { date: string }) => day.date === date3).holidayKind, "non-study");
  assert.ok(schedule.days.some((day: { date: string; lessons: unknown[] }) => day.date !== date1 && day.lessons.length === 0), "quarter includes no-lesson days");
  const idleSchedule = (await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${idle.id}` })).json();
  assert.equal(idleSchedule.days.find((day: { date: string }) => day.date === date4).holiday, true, "unassigned teacher uses the school-wide calendar");
  assert.equal(JSON.stringify({ index, schedule, idleSchedule }).includes("PRIVATE_"), false);
  for (const key of ["note", "leaderId", "students", "unavailability", "studyPlans", "curricula", "baseline", "bellSettings", "publishedBy", "draftRevision"])
    assert.equal(JSON.stringify({ index, schedule, idleSchedule }).includes(`\"${key}\"`), false, `public response leaked ${key}`);
  assert.equal((await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=unknown` })).statusCode, 404);

  const beforeEdit = { index: indexResponse.json(), schedule };
  const draftState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const editedCatalog = structuredClone(draftState.catalog);
  editedCatalog.teachers.find((item) => item.id === target.id)!.name = "Изменено только в черновике";
  const saved = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: editedCatalog, revision: draftState.revision, requestId: "teacher-public-draft-edit" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual({ index: (await app.inject({ url: "/api/public/teachers" })).json(), schedule: (await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${target.id}` })).json() }, beforeEdit);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await appWithAdmin(dbPath);
  assert.deepEqual({ index: (await reopened.app.inject({ url: "/api/public/teachers" })).json(), schedule: (await reopened.app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${target.id}` })).json() }, beforeEdit);
  reopened.db.prepare("DELETE FROM lessons WHERE id<>?").run(publishableLesson.lesson.id);
  const latestDraft = (await reopened.app.inject({ url: "/api/state", headers: reopened.headers })).json() as StateResponse;
  const published = await reopened.app.inject({ method: "POST", url: "/api/publications", headers: reopened.headers, payload: {
    quarterId: quarter.id,
    revision: latestDraft.revision,
    requestId: "teacher-public-new-publish",
  } });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().publication.version, 2);
  const refreshed = await reopened.app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${target.id}` });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().publication.version, 2);
  assert.equal(refreshed.json().teacher.name, "Изменено только в черновике");
});
