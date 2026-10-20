import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";
import type Database from "better-sqlite3";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public students day endpoint returns selected published date for every group and resolves next teaching date", async () => {
  const root = mkdtempSync(join(tmpdir(), "smena-students-day-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "day.sqlite") }); apps.push(app);
  const origin = "http://127.0.0.1";
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "students day test password" } });
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const stateResponse = await app.inject({ url: "/api/state", headers });
  const state = stateResponse.json();
  const quarter = state.quarters[0];
  const snapshot = createPublicationSnapshot(state, quarter.id) as PublicationSnapshot;
  const [a, b] = snapshot.catalog.groups;
  const subject = snapshot.catalog.subjects[0]!;
  const date = quarter.startDate;
  const jointId = "shared-day-test";
  const lesson = { id: "day-lesson", subjectId: subject.id, lessonKind: "regular" as const, jointId };
  const makeDay = (lessonValue: typeof lesson, onDate = date) => ({ date: onDate, start: "08:00", duration: 45, breaks: [], times: [{ start: 480, duration: 45 }], slots: [[lessonValue]], holiday: false });
  snapshot.schedule = { [`${a!.id}:0`]: [makeDay(lesson)], [`${b!.id}:0`]: [makeDay({ ...lesson, id: "day-lesson-b" })] };
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json) VALUES(?,?,?,?,?,?,?,?)")
    .run(quarter.id, 1, "2026-01-01T00:00:00Z", 1, "private-marker", JSON.stringify(snapshot), "{}", JSON.stringify(createPublicationPrintIndex(snapshot)));

  const invalid = await app.inject({ url: "/api/public/students/day?date=2026-02-30" });
  assert.equal(invalid.statusCode, 400);
  const exact = await app.inject({ url: `/api/public/students/day?date=${date}` });
  assert.equal(exact.statusCode, 200);
  assert.equal(exact.headers["cache-control"], "no-store");
  assert.equal(exact.json().date, date);
  assert.equal(exact.json().groups.length, snapshot.catalog.groups.filter((group) => !group.archived).length);
  assert.deepEqual(exact.json().groups.find((group: { id: string }) => group.id === a!.id).day.lessons[0].jointGroups.map((group: { id: string }) => group.id), [a!.id, b!.id]);
  assert.equal(exact.json().groups.find((group: { id: string }) => group.id === a!.id).day.lessons[0].note, undefined);
  const next = await app.inject({ url: `/api/public/students/day?date=${date}&nextStudyDay=true` });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().date, date);
  const outside = await app.inject({ url: "/api/public/students/day?date=2099-01-01" });
  assert.equal(outside.statusCode, 200);
  assert.equal(outside.json().date, "2099-01-01");
  assert.deepEqual(outside.json().groups, []);
  assert.equal((await app.inject({ method: "POST", url: "/api/public/students/day?date=" + date })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/public/students/day" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/public/students/day?date=2026-01-01&nextStudyDay=maybe" })).statusCode, 400);
  assert.equal(exact.body.includes("private-marker"), false);

  db.prepare("UPDATE quarters SET start_date=?,end_date=? WHERE id=?").run("2099-01-01", "2099-03-01", quarter.id);
  db.prepare("UPDATE published_quarters SET version=version+1 WHERE quarter_id=?").run(quarter.id);
  const immutablePublishedDate = await app.inject({ url: `/api/public/students/day?date=${date}` });
  assert.equal(immutablePublishedDate.statusCode, 200);
  assert.equal(immutablePublishedDate.json().date, date);
  assert.equal(immutablePublishedDate.json().groups.find((group: { id: string }) => group.id === a!.id).day.lessons.length, 1, "quarter edits do not move immutable published coverage dates");

  const addDays = (value: string, count: number) => { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
  const weekday = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay();
  const saturday = addDays(date, (6 - weekday(date) + 7) % 7 || 7);
  const monday = addDays(saturday, 2);
  const vacation = addDays(monday, 1);
  const afterVacation = addDays(vacation, 1);
  snapshot.calendar = { weekdays: [1, 2, 3, 4, 5], periods: [{ id: "test-vacation", name: "Каникулы", kind: "holiday", startDate: vacation, endDate: vacation, groupIds: null }] };
  snapshot.schedule = { [`${a!.id}:0`]: [makeDay(lesson, saturday), makeDay(lesson, monday), makeDay(lesson, vacation), makeDay(lesson, afterVacation)], [`${b!.id}:0`]: [makeDay({ ...lesson, id: "week-test-b" }, monday)] };
  db.prepare("UPDATE published_quarters SET snapshot_json=? WHERE quarter_id=?").run(JSON.stringify(snapshot), quarter.id);
  const saturdayResponse = await app.inject({ url: `/api/public/students/day?date=${saturday}&nextStudyDay=true` });
  assert.equal(saturdayResponse.json().date, monday, "weekend lessons are skipped in favor of Monday");
  const vacationResponse = await app.inject({ url: `/api/public/students/day?date=${vacation}&nextStudyDay=true` });
  assert.equal(vacationResponse.json().date, afterVacation, "stored lessons on a holiday do not make it a study day");

  snapshot.calendar = { weekdays: [1, 2, 3, 4, 5], groupWeekdays: { [a!.id]: [6] }, periods: [] };
  snapshot.schedule = { [`${a!.id}:0`]: [makeDay(lesson, saturday)] };
  db.prepare("UPDATE published_quarters SET snapshot_json=?,version=version+1 WHERE quarter_id=?").run(JSON.stringify(snapshot), quarter.id);
  const schoolSaturday = await app.inject({ url: `/api/public/students/day?date=${saturday}&nextStudyDay=true` });
  assert.equal(schoolSaturday.json().date, saturday, "group-specific school Saturday is a teaching day");
  assert.equal(schoolSaturday.json().groups.find((group: { id: string }) => group.id === a!.id).day.lessons.length, 1, "version change invalidates cached response");
  const laterStart = addDays(quarter.endDate, 10);
  const laterEnd = addDays(laterStart, 30);
  const laterQuarter = { ...quarter, id: "later-day-quarter", name: "Later", startDate: laterStart, endDate: laterEnd };
  db.prepare("INSERT INTO quarters(id,name,start_date,end_date,archived) VALUES(?,?,?,?,0)").run(laterQuarter.id, laterQuarter.name, laterStart, laterEnd);
  const laterSnapshot = createPublicationSnapshot(state, quarter.id) as PublicationSnapshot;
  laterSnapshot.quarter = laterQuarter;
  const laterGroup = laterSnapshot.catalog.groups[0]!;
  const laterSubject = laterSnapshot.catalog.subjects[0]!;
  const laterLesson = { id: "later-quarter-lesson", subjectId: laterSubject.id, lessonKind: "regular" as const };
  laterSnapshot.schedule = { [`${laterGroup.id}:0`]: [makeDay({ ...lesson, id: laterLesson.id, subjectId: laterLesson.subjectId }, laterStart)] };
  db.prepare("INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json) VALUES(?,?,?,?,?,?,?,?)")
    .run(laterQuarter.id, 1, "2026-02-01T00:00:00Z", 1, "private-marker", JSON.stringify(laterSnapshot), "{}", JSON.stringify(createPublicationPrintIndex(laterSnapshot)));
  const acrossQuarter = await app.inject({ url: `/api/public/students/day?date=${addDays(quarter.endDate, 1)}&nextStudyDay=true` });
  assert.equal(acrossQuarter.json().date, laterStart, "next study day search crosses publication quarters");
  const beyond = addDays(laterQuarter.endDate, 1);
  const noFuture = await app.inject({ url: `/api/public/students/day?date=${beyond}&nextStudyDay=true` });
  assert.equal(noFuture.json().date, beyond, "there is no fallback to a past teaching date");
});

test("public students day endpoint reports no publications without exposing draft data", async () => {
  const root = mkdtempSync(join(tmpdir(), "smena-students-day-empty-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "empty.sqlite") }); apps.push(app);
  const response = await app.inject({ url: "/api/public/students/day?date=2026-10-19" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { requestedDate: "2026-10-19", date: "2026-10-19", hasPublications: false, groups: [] });
});
