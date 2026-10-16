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
  const root = existingDbPath ? undefined : mkdtempSync(join(tmpdir(), "smena-students-server-"));
  if (root) roots.push(root);
  const dbPath = existingDbPath ?? join(root!, "students.sqlite");
  const app = await buildApp({ dbPath });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "student test password" } });
  if (auth.statusCode !== 200)
    auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "student test password" } });
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public student routes are anonymous read-only and handle empty or invalid requests", async () => {
  const { app } = await appWithAdmin();
  assert.deepEqual((await app.inject({ url: "/api/public/students" })).json(), { quarters: [] });
  assert.equal((await app.inject({ url: "/api/public/students/schedule" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/public/students/schedule?quarterId=q&groupId=g" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/publications/anything" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/publication-preview?quarterId=q" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/publications", headers: { origin, host: "127.0.0.1" }, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/state", headers: { origin, host: "127.0.0.1" }, payload: {} })).statusCode, 401);
});

test("student projection exposes only published group data and refreshes on publication version changes", async () => {
  const { app, state, db, dbPath, headers } = await appWithAdmin();
  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const groups = snapshot.catalog.groups.slice(0, 2);
  assert.equal(groups.length, 2);
  const [first, second] = groups as [typeof groups[number], typeof groups[number]];
  first.archived = false;
  second.archived = false;
  for (const group of snapshot.catalog.groups) if (group.id !== first.id && group.id !== second.id) group.archived = true;
  snapshot.catalog.groups = [first, second];
  snapshot.catalog.subgroups = [{ id: "public-subgroup", name: "1 подгруппа", archived: false, groupId: first.id, students: 11 }];
  const subject = snapshot.catalog.subjects[0]!;
  const teacher = snapshot.catalog.teachers[0]!;
  const room = snapshot.catalog.rooms[0]!;
  const lessonForFreshPublish = Object.entries(state.schedule).flatMap(([key, days]) =>
    days.filter((day) => day.date >= quarter.startDate && day.date <= quarter.endDate)
      .flatMap((day) => day.slots.flatMap((slot) => slot.filter((lesson) => lesson.teacherId && lesson.roomId).map((lesson) => ({ groupId: key.slice(0, key.lastIndexOf(":")), lesson })))),
  )[0];
  assert.ok(lessonForFreshPublish, "fixture must contain a publishable lesson");
  teacher.name = "Учитель из снимка";
  teacher.unavailability = [{ id: "private-unavailability", startDate: quarter.startDate, endDate: quarter.endDate, start: 0, end: 30, reason: "PRIVATE_UNAVAILABILITY_MARKER" }];
  first.leaderId = "PRIVATE_LEADER_MARKER";
  first.students = 33;
  const date = quarter.startDate;
  const baseDay = structuredClone(Object.values(state.schedule).flat().find((day) => day.date >= quarter.startDate && day.date <= quarter.endDate)!);
  baseDay.date = date;
  baseDay.note = "PRIVATE_DAY_NOTE_MARKER";
  baseDay.holiday = false;
  baseDay.slots = [[], [], [], [], []];
  baseDay.times = [{ start: 600, duration: 45 }, { start: 650, duration: 45 }, { start: 700, duration: 45 }, { start: 750, duration: 45 }, { start: 800, duration: 45 }];
  const makeLesson = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    subjectId: subject.id,
    teacherId: teacher.id,
    roomId: room.id,
    teacher: teacher.name,
    room: room.name,
    lessonKind: "regular" as const,
    note: "PRIVATE_LESSON_NOTE_MARKER",
    ...overrides,
  });
  baseDay.slots[0]!.push(makeLesson("student-normal"));
  baseDay.slots[1]!.push(makeLesson("student-joint-a", { jointId: "shared-lesson" }));
  baseDay.slots[3]!.push(makeLesson("student-subgroup-one", { subgroupId: "public-subgroup" }));
  snapshot.catalog.subgroups.push(
    { id: "public-subgroup-two", name: "Подгруппа2", archived: false, groupId: first.id, students: 12 },
    { id: "public-subgroup-three", name: "Практикум", archived: false, groupId: first.id, students: 10 },
  );
  baseDay.slots[3]!.push(makeLesson("student-subgroup-two", { subgroupId: "public-subgroup-two" }));
  baseDay.slots[3]!.push(makeLesson("student-subgroup-three", { subgroupId: "public-subgroup-three" }));
  const secondDay = structuredClone(baseDay);
  secondDay.slots = [[], [], [], [], []];
  secondDay.times[0] = { start: 650, duration: 45 };
  secondDay.slots[0]!.push(makeLesson("student-joint-b", { jointId: "shared-lesson" }));
  const holidayDate = new Date(`${date}T00:00:00.000Z`);
  holidayDate.setUTCDate(holidayDate.getUTCDate() + 1);
  const holidayIsoDate = holidayDate.toISOString().slice(0, 10);
  const nonStudyDate = new Date(holidayDate);
  nonStudyDate.setUTCDate(nonStudyDate.getUTCDate() + 1);
  const nonStudyIsoDate = nonStudyDate.toISOString().slice(0, 10);
  const calendarDay = (dayDate: string) => ({ ...structuredClone(baseDay), date: dayDate, holiday: true, note: "PRIVATE_DAY_NOTE_MARKER", slots: [[], [], [], [], []] });
  const vacationDay = calendarDay(holidayIsoDate);
  const nonStudyDay = calendarDay(nonStudyIsoDate);
  snapshot.calendar ??= { weekdays: [1, 2, 3, 4, 5], periods: [] };
  snapshot.calendar.periods.push(
    { id: "public-vacation", name: "Осенние каникулы", kind: "holiday", startDate: holidayIsoDate, endDate: holidayIsoDate, groupIds: [first.id] },
    { id: "public-day-off", name: "Школьный выходной", kind: "day-off", startDate: nonStudyIsoDate, endDate: nonStudyIsoDate, groupIds: [first.id] },
  );
  snapshot.schedule = {
    [`${first.id}:0`]: [baseDay, vacationDay, nonStudyDay],
    [`${second.id}:0`]: [secondDay],
  };
  snapshot.studyPlans = [];
  snapshot.curricula = [{ id: "PRIVATE_CURRICULUM_MARKER", quarterId: quarter.id, groupId: first.id, subjectId: subject.id, hours: 1 } as never];
  snapshot.baseline = [{ groupId: first.id, subjectId: subject.id, value: "PRIVATE_BASELINE_MARKER" } as never];
  snapshot.bellSettings = { PRIVATE_BELL_SETTINGS_MARKER: true } as never;
  storeSnapshot(db, snapshot, 1, "2026-10-12T00:00:00.000Z");

  const indexResponse = await app.inject({ url: "/api/public/students" });
  assert.equal(indexResponse.statusCode, 200, indexResponse.body);
  const index = indexResponse.json();
  assert.equal(index.quarters.length, 1);
  assert.equal(index.quarters[0].publication.version, 1);
  assert.deepEqual(index.quarters[0].groups.find((group: { id: string }) => group.id === first.id).lessonDates, [date]);
  assert.ok(index.quarters[0].groups.some((group: { id: string }) => group.id === second.id));
  const scheduleResponse = await app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${first.id}` });
  assert.equal(scheduleResponse.statusCode, 200, scheduleResponse.body);
  const schedule = scheduleResponse.json();
  assert.deepEqual(schedule.group, { id: first.id, name: first.name });
  assert.equal(schedule.days[0].slotCount, 5, "slot count includes the trailing empty slot");
  assert.deepEqual(schedule.days[0].lessons.map((lesson: { slot: number }) => lesson.slot), [1, 2, 4, 4, 4]);
  assert.ok(schedule.days[0].lessons.slice(2).every((lesson: { start: number }) => lesson.start === schedule.days[0].lessons[2].start), "all parallel subgroups must share the cell");
  assert.equal(schedule.days[0].lessons[0].start, 600);
  assert.deepEqual(schedule.days[0].lessons[1].jointGroups, [
    { id: first.id, name: first.name },
    { id: second.id, name: second.name },
  ]);
  assert.deepEqual(schedule.days[0].lessons.slice(2).map((lesson: { subgroup: { id: string; name: string; number: number } }) => lesson.subgroup), [
    { id: "public-subgroup", name: "1 подгруппа", number: 1 },
    { id: "public-subgroup-two", name: "Подгруппа2", number: 2 },
    { id: "public-subgroup-three", name: "Практикум", number: 3 },
  ]);
  assert.equal(schedule.days[0].lessons[0].teacher.name, "Учитель из снимка");
  assert.deepEqual(schedule.days[1], { date: holidayIsoDate, slotCount: 5, holiday: true, calendarLabel: "Осенние каникулы", holidayKind: "vacation", lessons: [] });
  assert.deepEqual(schedule.days[2], { date: nonStudyIsoDate, slotCount: 5, holiday: true, calendarLabel: "Школьный выходной", holidayKind: "non-study", lessons: [] });
  assert.equal(JSON.stringify({ index, schedule }).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(schedule).includes("student-joint-b"), false, "response must not include the other group's lessons");
  for (const key of ["note", "leaderId", "students", "unavailability", "studyPlans", "curricula", "baseline", "bellSettings", "publishedBy", "draftRevision"])
    assert.equal(JSON.stringify({ index, schedule }).includes(`\"${key}\"`), false, `public response leaked ${key}`);

  assert.equal((await app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=unknown` })).statusCode, 404);

  const publicSnapshot = async () => ({
    index: (await app.inject({ url: "/api/public/students" })).json(),
    schedule: (await app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${first.id}` })).json(),
  });
  const beforeDraftEdit = await publicSnapshot();
  const draftState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const editedCatalog = structuredClone(draftState.catalog);
  const draftTeacher = editedCatalog.teachers.find((item) => item.id === lessonForFreshPublish.lesson.teacherId)!;
  draftTeacher.name = "Учитель изменён только в черновике";
  const saved = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: editedCatalog, revision: draftState.revision, requestId: "student-public-draft-edit" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(await publicSnapshot(), beforeDraftEdit, "draft edits must not change anonymous published reads");

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await appWithAdmin(dbPath);
  assert.deepEqual(await (async () => ({
    index: (await reopened.app.inject({ url: "/api/public/students" })).json(),
    schedule: (await reopened.app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${first.id}` })).json(),
  }))(), beforeDraftEdit, "published student schedule must survive restart");

  reopened.db.prepare("DELETE FROM lessons WHERE id<>?").run(lessonForFreshPublish.lesson.id);
  const latestDraft = (await reopened.app.inject({ url: "/api/state", headers: reopened.headers })).json() as StateResponse;
  const published = await reopened.app.inject({ method: "POST", url: "/api/publications", headers: reopened.headers, payload: {
    quarterId: quarter.id,
    revision: latestDraft.revision,
    requestId: "student-public-new-publish",
  } });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().publication.version, 2);
  const refreshed = await reopened.app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${lessonForFreshPublish.groupId}` });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(refreshed.json().publication.version, 2);
  assert.equal(refreshed.json().days.flatMap((day: { lessons: Array<{ id: string; teacher?: { name: string } }> }) => day.lessons).find((lesson: { id: string }) => lesson.id === lessonForFreshPublish.lesson.id)?.teacher?.name, draftTeacher.name);
});
