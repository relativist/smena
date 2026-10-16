import assert from "node:assert/strict";
import Fastify from "fastify";
import { openSqliteDatabase } from "../server/database.ts";
import { registerTeacherLoadApi, type TeacherLoadApiDeps } from "../server/teacherLoadApi.ts";
import { collectTeacherLoad, summarizeTeacherLoad } from "../shared/teacherLoad.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter } from "../shared/plans.ts";
import type { SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { PublishedQuarterResponse } from "../shared/publicationTypes.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  teachers: [{ id: "t1", name: "Иванов Иван", archived: false, subjectIds: ["math"], defaultRoomId: null }, { id: "t-old", name: "Старый учитель", archived: true, subjectIds: [], defaultRoomId: null }],
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", archived: false, roomKind: null, labRoomKind: null }],
  groups: ["g1", "g2"].map((id, index) => ({ id, name: index ? "5Б" : "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] })),
  rooms: [{ id: "r1", name: "312", archived: false, capacity: 30, kind: "general" }],
  subgroups: [],
};
const quarter: Quarter = { id: "q1", name: "I четверть", startDate: "2026-10-01", endDate: "2026-10-31" };
const calendar: SchoolCalendar = { weekdays: [1, 2, 3, 4, 5], periods: [] };
const lesson = (id: string, jointId?: string) => ({ id, teacherId: "t1", subjectId: "math", roomId: "r1", ...(jointId ? { jointId } : {}) });
const day = (date: string, slots: Schedule[string][number]["slots"]): Schedule[string][number] => ({ date, start: "08:00", duration: 45, breaks: [], slots, times: slots.map((_, index) => ({ start: 480 + index * 50, duration: 45 })) });
const schedule: Schedule = {
  "g1:0": [day("2026-10-05", [[lesson("joint-a", "j1")], [lesson("single-a")]])],
  "g2:0": [day("2026-10-05", [[lesson("joint-b", "j1")]]), day("2026-11-02", [[lesson("outside")]])],
};
const published: PublishedQuarterResponse = {
  publication: { quarterId: "q1", version: 3, publishedAt: "2026-10-01T10:00:00.000Z", draftRevision: 4, publishedBy: "admin" },
  snapshot: { schedule, catalog, studyPlans: [], baseline: [], quarter, calendar },
};
const db = openSqliteDatabase(":memory:");
const deps: TeacherLoadApiDeps = {
  db,
  getSession: async request => request.headers.cookie ? { username: "admin" } : null,
  readCatalog: async () => catalog,
  readQuarters: async () => [quarter],
  readCalendar: async () => calendar,
  readSchedule: (_catalog, dates) => {
    const allowed = new Set(dates ?? []);
    return Promise.resolve(Object.fromEntries(Object.entries(schedule).flatMap(([key, days]) => {
      const filtered = days.filter(item => !dates || allowed.has(item.date));
      return filtered.length ? [[key, filtered]] : [];
    })));
  },
  readPublishedQuarter: async id => id === quarter.id ? published : null,
};
const app = Fastify();
await registerTeacherLoadApi(app, deps);

try {
  const unauthorized = await app.inject({ method: "GET", url: "/api/teacher-load?source=draft&month=2026-10" });
  assert.equal(unauthorized.statusCode, 401);
  const invalid = await app.inject({ method: "GET", url: "/api/teacher-load?source=draft&month=2026-13", headers: { cookie: "session=x" } });
  assert.equal(invalid.statusCode, 400);

  const quarterUnauthorized = await app.inject({ method: "GET", url: "/api/teacher-load/quarter?quarterId=q1" });
  assert.equal(quarterUnauthorized.statusCode, 401);
  const quarterResponse = await app.inject({ method: "GET", url: "/api/teacher-load/quarter?quarterId=q1", headers: { cookie: "session=x" } });
  assert.equal(quarterResponse.statusCode, 200);
  const quarterSummary = quarterResponse.json();
  assert.ok(Math.abs(quarterSummary.target - 79.2) < 0.001, "quarter target prorates the 18-lesson weekly norm across its 22 school days");
  assert.equal(quarterSummary.teachers.find((item: { id: string }) => item.id === "t1").lessons, 2, "quarter summary uses the shared teacher aggregation");
  assert.equal(quarterResponse.body.includes('"lessons":['), false, "quarter summary returns counts without lesson schedules");

  const draftResponse = await app.inject({ method: "GET", url: "/api/teacher-load?source=draft&month=2026-10", headers: { cookie: "session=x" } });
  assert.equal(draftResponse.statusCode, 200);
  const draft = draftResponse.json();
  const expectedRows = collectTeacherLoad({ "g1:0": schedule["g1:0"], "g2:0": [schedule["g2:0"]![0]!] }, catalog);
  const expectedTeacher = expectedRows.find(row => row.id === "t1")!;
  const expected = summarizeTeacherLoad(expectedTeacher.lessons, "2026-10-01", "2026-10-31");
  const row = draft.rows.find((item: { id: string }) => item.id === "t1");
  assert.deepEqual(row.month, expected, "draft monthly totals match existing shared aggregation and collapse joint copies");
  assert.equal(row.weeks.reduce((sum: number, item: { lessons: number }) => sum + item.lessons, 0), expected.lessons);
  assert.equal(draftResponse.body.includes('"lessons":['), false, "summary does not transfer lesson details");
  assert.equal(draftResponse.body.includes("outside"), false, "query reads only dates inside the selected month");

  const publishedResponse = await app.inject({ method: "GET", url: "/api/teacher-load?source=published&month=2026-10", headers: { cookie: "session=x" } });
  assert.equal(publishedResponse.statusCode, 200);
  const publishedSummary = publishedResponse.json();
  assert.equal(publishedSummary.rows.find((item: { id: string }) => item.id === "t1").month.lessons, expected.lessons);
  assert.deepEqual(publishedSummary.publications.map((item: { version: number }) => item.version), [3]);
  assert.deepEqual(publishedSummary.missingQuarters, []);

  const detailResponse = await app.inject({ method: "GET", url: "/api/teacher-load/details?source=draft&month=2026-10&teacherId=t1&startDate=2026-10-05&endDate=2026-10-05", headers: { cookie: "session=x" } });
  assert.equal(detailResponse.statusCode, 200);
  const detail = detailResponse.json().teacher;
  const expectedDayLessons = expectedTeacher.lessons.filter(item => item.date === "2026-10-05");
  assert.equal(detail.lessons.length, expectedDayLessons.length);
  assert.equal(detail.lessons.find((item: { id: string }) => item.id === "joint-a").participants.length, 2, "details retain cross-group joint participants");
  assert.equal(detail.lessons.some((item: { date: string }) => item.date === "2026-11-02"), false);

  const missingApp = Fastify();
  await registerTeacherLoadApi(missingApp, { ...deps, readPublishedQuarter: async (_id: string) => null });
  const missing = await missingApp.inject({ method: "GET", url: "/api/teacher-load?source=published&month=2026-10", headers: { cookie: "session=x" } });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json().missingQuarters.length, 1);
  assert.equal(missing.json().rows.length, 0, "without a publication there are no teacher rows");
  assert.equal(missing.json().periods.weeks.every((item: { incomplete: boolean }) => item.incomplete), true);
  await missingApp.close();

  console.log("teacher load server tests passed");
} finally {
  await app.close();
  await db.close();
}
