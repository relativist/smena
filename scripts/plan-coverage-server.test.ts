import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify from "fastify";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import { registerPlanCoverageApi } from "../server/planCoverageApi.ts";
import { openSqliteDatabase, type AsyncDatabase } from "../server/database.ts";
import { planCoverageSummary } from "../shared/planCoverage.ts";

const apps: ReturnType<typeof Fastify>[] = [];
const databases: AsyncDatabase[] = [];
const quarter: Quarter = { id: "q1", name: "I четверть", startDate: "2026-09-01", endDate: "2026-10-30" };
const catalog = {
  groups: [
    { id: "g1", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "5Б", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g3", name: "4А архив", archived: true, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  subgroups: [
    { id: "a", name: "Первая", groupId: "g1", students: 10, archived: false },
    { id: "b", name: "Вторая", groupId: "g1", students: 10, archived: false },
  ],
  subjects: [
    { id: "math", name: "Математика", shortName: "Матем.", archived: false, color: "blue", roomKind: null, labRoomKind: null },
    { id: "science", name: "Физика", shortName: "Физ.", archived: false, color: "blue", roomKind: null, labRoomKind: null },
  ],
  teachers: [], rooms: [],
} as Catalog;
const plans: StudyPlan[] = [
  { id: "p1", groupId: "g1", quarterId: "q1", subjectId: "math", mode: "subgroups", lessonKind: "regular", assignments: [
    { id: "a1", subgroupId: "a", target: 3 }, { id: "a2", subgroupId: "b", target: 1 },
  ] },
  { id: "p2", groupId: "g1", quarterId: "q1", subjectId: "science", mode: "whole", lessonKind: "lab", assignments: [
    { id: "a3", subgroupId: null, target: 1 },
  ] },
  { id: "p3", groupId: "g3", quarterId: "q1", subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [
    { id: "a4", subgroupId: null, target: 1 },
  ] },
];

async function setup() {
  const app = Fastify();
  const asyncDb = openSqliteDatabase(":memory:");
  const db = asyncDb.native!;
  apps.push(app);
  databases.push(asyncDb);
  db.exec(`
    CREATE TABLE schedule_days(id INTEGER PRIMARY KEY, group_id TEXT, date TEXT);
    CREATE TABLE schedule_slots(id INTEGER PRIMARY KEY, day_id INTEGER);
    CREATE TABLE lessons(id TEXT PRIMARY KEY, slot_id INTEGER, subject_id TEXT, lesson_kind TEXT, subgroup_ref TEXT, subgroup TEXT, event TEXT);
  `);
  const add = db.prepare(`INSERT INTO lessons(id,slot_id,subject_id,lesson_kind,subgroup_ref,subgroup,event)
    VALUES(?,(SELECT id FROM schedule_slots WHERE id=?),?,?,?,?,?)`);
  const addLesson = (id: string, groupId: string, date: string, subject: string, kind: string, subgroupId: string | null, subgroup: string | null, event: string | null = null) => {
    const dayId = Number(db.prepare("INSERT INTO schedule_days(group_id,date) VALUES(?,?)").run(groupId, date).lastInsertRowid);
    const slotId = Number(db.prepare("INSERT INTO schedule_slots(day_id) VALUES(?)").run(dayId).lastInsertRowid);
    add.run(id, slotId, subject, kind, subgroupId, subgroup, event);
  };
  addLesson("whole", "g1", quarter.startDate, "math", "regular", null, null);
  addLesson("a-ref", "g1", "2026-09-10", "math", "regular", "a", "Первая");
  addLesson("a-legacy", "g1", "2026-09-11", "math", "regular", null, "Первая");
  addLesson("b-1", "g1", "2026-10-20", "math", "regular", "b", "Вторая");
  addLesson("b-2", "g1", quarter.endDate, "math", "regular", "b", "Вторая");
  addLesson("event", "g1", "2026-09-12", "math", "regular", null, null, "Праздник");
  addLesson("lab-not-regular", "g1", "2026-09-12", "science", "regular", null, null);
  addLesson("outside", "g1", "2026-10-31", "math", "regular", null, null);
  addLesson("archived", "g3", "2026-09-01", "math", "regular", null, null);
  let authenticated = true;
  await registerPlanCoverageApi(app, {
    db: asyncDb,
    getSession: async () => authenticated ? {} : null,
    readCatalog: async () => catalog,
    readQuarters: async () => [quarter],
    readStudyPlans: async quarterId => plans.filter(plan => plan.quarterId === quarterId),
  });
  return { app, db: asyncDb, unauthenticate: () => { authenticated = false; }, authenticate: () => { authenticated = true; } };
}

test("a last missing hour never displays 100%, and a plan with no lessons displays zero", () => {
  const quarterPlans: StudyPlan[] = [
    { id: "nearly", groupId: "g1", quarterId: quarter.id, subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "near", subgroupId: null, target: 2000 }] },
    { id: "empty", groupId: "g2", quarterId: quarter.id, subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "empty", subgroupId: null, target: 10 }] },
    { id: "other-quarter", groupId: "g1", quarterId: "another", subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "other", subgroupId: null, target: 50 }] },
  ];
  const result = planCoverageSummary(quarter, catalog.groups, quarterPlans, [
    { groupId: "g1", subjectId: "math", lessonKind: "regular", subgroupId: null, subgroupLabel: null, count: 1999 },
    { groupId: "g2", subjectId: "math", lessonKind: "regular", subgroupId: null, subgroupLabel: " ", count: 3 },
  ]);
  assert.equal(result.groups[0]!.percent, 99.9);
  assert.equal(result.groups[0]!.status, "partial");
  assert.equal(result.groups[0]!.target, 2000, "other quarters do not contribute targets");
  assert.equal(result.groups[1]!.percent, 0);
  assert.equal(result.groups[1]!.status, "empty");
  assert.equal(result.groups.length, 2, "archived group without a plan for this quarter is hidden");
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const db of databases.splice(0)) await db.close();
});

test("quarter coverage counts inclusive dates, subgroup IDs, lesson kinds, and deficits per assignment", async () => {
  const { app } = await setup();
  const response = await app.inject({ url: "/api/plan-coverage?quarterId=q1" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json();
  assert.deepEqual(body.quarter, quarter);
  assert.deepEqual(body.groups.map((group: any) => group.id), ["g1", "g2", "g3"]);
  assert.deepEqual(body.groups[0], {
    id: "g1", name: "5А", archived: false, hasPlan: true,
    target: 5, scheduled: 5, covered: 3, missing: 2, extra: 2,
    percent: 60, status: "partial",
  });
  assert.deepEqual(body.groups[1], {
    id: "g2", name: "5Б", archived: false, hasPlan: false,
    target: 0, scheduled: 0, covered: 0, missing: 0, extra: 0,
    percent: null, status: "no-plan",
  });
  assert.equal(body.groups[2].archived, true);
  assert.equal(body.groups[2].status, "complete");
  assert.equal("assignments" in body.groups[0], false);
});

test("coverage route requires authentication and validates quarter selection", async () => {
  const fixture = await setup();
  fixture.unauthenticate();
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage?quarterId=q1" })).statusCode, 401);
  fixture.authenticate();
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage" })).statusCode, 400);
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage?quarterId=" })).statusCode, 400);
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage?quarterId=missing" })).statusCode, 404);
});

test("coverage details requires authentication and validates quarter and group", async () => {
  const fixture = await setup();
  fixture.unauthenticate();
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage/details?quarterId=q1&groupId=g1" })).statusCode, 401);
  fixture.authenticate();
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage/details?quarterId=q1" })).statusCode, 400);
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage/details?quarterId=missing&groupId=g1" })).statusCode, 404);
  assert.equal((await fixture.app.inject({ url: "/api/plan-coverage/details?quarterId=q1&groupId=missing" })).statusCode, 404);
});

test("coverage details uses summary counting semantics and returns empty rows for groups without a plan", async () => {
  const { app } = await setup();
  const response = await app.inject({ url: "/api/plan-coverage/details?quarterId=q1&groupId=g1" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json();
  assert.deepEqual(body.group, { id: "g1", name: "5А", archived: false });
  assert.deepEqual(body.rows.map((row: any) => [row.subjectName, row.subgroupName, row.lessonKind, row.target, row.scheduled]), [
    ["Математика", "Вторая", "regular", 1, 3],
    ["Математика", "Первая", "regular", 3, 2],
    ["Физика", null, "lab", 1, 0],
  ]);
  const summary = (await app.inject({ url: "/api/plan-coverage?quarterId=q1" })).json();
  assert.equal(body.rows.reduce((sum: number, row: any) => sum + row.target, 0), summary.groups[0].target);
  assert.equal(body.rows.reduce((sum: number, row: any) => sum + row.scheduled, 0), summary.groups[0].scheduled);
  const empty = await app.inject({ url: "/api/plan-coverage/details?quarterId=q1&groupId=g2" });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().rows, []);
});
