import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";
import type Database from "better-sqlite3";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const addDays = (date: string, count: number) => {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
};

test("public students week returns all published groups, only selected week, and refreshes on publication changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "smena-students-week-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "week.sqlite") }); apps.push(app);
  const origin = "http://127.0.0.1";
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "students week test password" } });
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const state = (await app.inject({ url: "/api/state", headers })).json();
  const quarter = state.quarters[0];
  const snapshot = createPublicationSnapshot(state, quarter.id) as PublicationSnapshot;
  const groups = snapshot.catalog.groups.slice(0, 2);
  assert.equal(groups.length, 2);
  const [first, second] = groups as [typeof groups[number], typeof groups[number]];
  const archivedWithOutsideLesson = snapshot.catalog.groups[2]!;
  for (const group of snapshot.catalog.groups) group.archived = group.id !== first.id && group.id !== second.id;
  first.name = "Опубликованный класс A";
  const weekStartDate = new Date(`${quarter.startDate}T00:00:00Z`);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() + ((8 - weekStartDate.getUTCDay()) % 7));
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const weekEnd = addDays(weekStart, 6);
  const outside = addDays(weekStart, 7);
  const subject = snapshot.catalog.subjects[0]!;
  const makeDay = (date: string, lessons: PublicationSnapshot["schedule"][string][number]["slots"][number] = [], holiday = false) => ({
    date, start: "08:00", duration: 45, breaks: [], times: [{ start: 480, duration: 45 }], slots: [lessons], holiday,
    note: "PRIVATE_DAY_MARKER",
  });
  const jointId = "week-joint";
  subject.iconId = "math";
  const makeLesson = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, subjectId: subject.id, lessonKind: "regular" as const, note: "PRIVATE_LESSON_MARKER", ...overrides,
  });
  const tuesday = addDays(weekStart, 1);
  const sunday = weekEnd;
  snapshot.calendar = { weekdays: [1, 2, 3, 4, 5], periods: [{ id: "week-vacation", name: "Каникулы недели", kind: "holiday", startDate: tuesday, endDate: tuesday, groupIds: [first.id] }] };
  snapshot.schedule = {
    [`${first.id}:0`]: [makeDay(weekStart, [makeLesson("week-joint-a", { jointId })]), makeDay(tuesday, [], true), makeDay(sunday, [makeLesson("week-sunday")]), makeDay(outside, [makeLesson("other-week")])],
    [`${second.id}:0`]: [makeDay(weekStart, [makeLesson("week-joint-b", { jointId })])],
    [`${archivedWithOutsideLesson.id}:0`]: [makeDay(outside, [makeLesson("archived-other-week")])],
  } as PublicationSnapshot["schedule"];
  snapshot.quarter.name = "Имя из публикации";
  snapshot.quarter.startDate = quarter.startDate;
  snapshot.quarter.endDate = quarter.endDate;
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const store = (version: number) => db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(quarter_id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    draft_revision=excluded.draft_revision,published_by=excluded.published_by,snapshot_json=excluded.snapshot_json,summary_json=excluded.summary_json`)
    .run(quarter.id, version, `2026-10-${12 + version}T00:00:00.000Z`, 987654, "PRIVATE_PUBLISHER_MARKER", JSON.stringify(snapshot), "{}");
  store(1);
  db.prepare("UPDATE quarters SET start_date=?,end_date=? WHERE id=?").run("2099-01-01", "2099-03-01", quarter.id);

  for (const url of ["/api/public/students/week", "/api/public/students/week?quarterId=x", `/api/public/students/week?quarterId=${quarter.id}&weekStart=2026-02-30`, `/api/public/students/week?quarterId=${quarter.id}&weekStart=${addDays(weekStart, 1)}`])
    assert.equal((await app.inject({ url })).statusCode, 400, url);
  assert.equal((await app.inject({ url: `/api/public/students/week?quarterId=unknown&weekStart=${weekStart}` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/public/students/week?quarterId=${quarter.id}&weekStart=2099-01-05` })).statusCode, 400);

  const revisionBefore = (await app.inject({ url: "/api/state", headers })).json().revision;
  const response = await app.inject({ url: `/api/public/students/week?quarterId=${quarter.id}&weekStart=${weekStart}` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const value = response.json();
  assert.equal(value.quarter.name, "Имя из публикации");
  assert.deepEqual(value.publication, { version: 1, publishedAt: "2026-10-13T00:00:00.000Z" });
  assert.equal(value.weekStart, weekStart);
  assert.equal(value.weekEnd, weekEnd);
  assert.equal(value.groups.length, 3, "include public groups even when an archived group's lessons fall outside this week");
  const publishedFirst = value.groups.find((group: { id: string }) => group.id === first.id);
  assert.equal(publishedFirst.name, "Опубликованный класс A");
  assert.deepEqual(publishedFirst.days.map((day: { date: string }) => day.date), [weekStart, tuesday, sunday]);
  assert.equal(publishedFirst.days[0].lessons[0].subject.iconId, "math", "subject icon metadata is preserved");
  assert.deepEqual(publishedFirst.days[0].lessons[0].jointGroups.map((group: { id: string }) => group.id), [first.id, second.id]);
  assert.deepEqual(publishedFirst.days[1], { date: tuesday, slotCount: 1, holiday: true, calendarLabel: "Каникулы недели", holidayKind: "vacation", lessons: [] });
  assert.equal(publishedFirst.days[2].date, sunday, "Sunday remains inside the selected week");
  const archivedRow = value.groups.find((group: { id: string }) => group.id === archivedWithOutsideLesson.id);
  assert.ok(archivedRow, "archived group with published lessons elsewhere in the quarter stays in the list");
  assert.deepEqual(archivedRow.days, []);
  assert.equal("groups" in value.quarter, false, "quarter contains only quarter metadata");
  assert.equal("publication" in value.quarter, false, "publication metadata is returned only at the response root");
  assert.equal(value.groups.flatMap((group: { days: Array<{ lessons: unknown[] }> }) => group.days).flatMap((day: { lessons: unknown[] }) => day.lessons).some((lesson: { id: string }) => lesson.id === "other-week"), false);
  assert.equal(JSON.stringify(value).includes("PRIVATE_"), false);
  for (const key of ["note", "publishedBy", "draftRevision", "studyPlans", "curricula", "baseline", "bellSettings"])
    assert.equal(JSON.stringify(value).includes(`\"${key}\"`), false, `public response leaked ${key}`);
  assert.equal((await app.inject({ url: "/api/state", headers })).json().revision, revisionBefore, "anonymous read must not change the draft revision");

  snapshot.quarter.name = "Имя новой публикации";
  store(2);
  const refreshed = await app.inject({ url: `/api/public/students/week?quarterId=${quarter.id}&weekStart=${weekStart}` });
  assert.equal(refreshed.json().publication.version, 2, "changed publication key invalidates the one-entry cache");
  assert.equal(refreshed.json().quarter.name, "Имя новой публикации");
});
