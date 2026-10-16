import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { Catalog } from "../shared/catalog.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-large-school-limits-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}

async function appWithAdmin() {
  const path = dbPath();
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  return {
    app,
    path,
    headers: {
      cookie,
      origin,
      host: "127.0.0.1",
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}

function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("large plan snapshots are accepted above the old cap and bounded above the new cap", async () => {
  const { app, path, headers } = await appWithAdmin();
  const stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  const state = stateResponse.json() as StateResponse;
  const subjects = state.catalog.subjects.filter((subject) => !subject.archived);
  assert.ok(subjects.length > 0);

  const db = new Database(path);
  const groupCount = 80;
  const insertGroup = db.prepare(
    "INSERT INTO catalog_groups(id,name,students,leader_id,room_id,archived) VALUES(?,?,25,NULL,NULL,0)",
  );
  for (let i = 0; i < groupCount; i += 1)
    insertGroup.run(`scale-group-${i}`, `Тестовая группа ${i}`);
  db.close();

  const quarterCount = Math.ceil(5_010 / (groupCount * subjects.length));
  assert.ok(quarterCount <= 11, "the fixture must fit the supported 12-quarter snapshot");
  const existingQuarters = state.quarters;
  let end = new Date(`${existingQuarters[0].startDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const addedQuarters = [];
  for (let i = quarterCount - 1; i >= 0; i -= 1) {
    const quarterEnd = new Date(end);
    const start = new Date(quarterEnd);
    start.setUTCDate(start.getUTCDate() - 89);
    addedQuarters.push({
      id: `scale-quarter-${i}`,
      name: `Тестовая четверть ${i}`,
      startDate: iso(start),
      endDate: iso(quarterEnd),
    });
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() - 1);
  }

  const quarters = [...addedQuarters, ...existingQuarters];
  const plans = [...state.studyPlans];
  let sequence = 0;
  for (const quarter of addedQuarters) {
    for (let group = 0; group < groupCount; group += 1) {
      for (const subject of subjects) {
        plans.push({
          id: `scale-plan-${sequence}`,
          quarterId: quarter.id,
          groupId: `scale-group-${group}`,
          subjectId: subject.id,
          mode: "whole",
          lessonKind: "regular",
          assignments: [{ id: `scale-assignment-${sequence}`, subgroupId: null, target: 1 }],
        });
        sequence += 1;
      }
    }
  }
  assert.ok(plans.length > 5_000 && plans.length <= 20_000);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      revision: state.revision,
      requestId: "large-plan-snapshot-001",
      quarters,
      studyPlans: plans,
    },
  });
  assert.equal(saved.statusCode, 200, saved.body.slice(0, 500));
  assert.equal(saved.json().studyPlans.length, plans.length);

  const overLimit = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      revision: saved.json().revision,
      requestId: "large-plan-snapshot-002",
      quarters,
      studyPlans: Array.from({ length: 20_001 }, () => null),
    },
  });
  assert.equal(overLimit.statusCode, 400);
});

test("authenticated schedule saves accept request bodies above the default 10 MiB cap", async () => {
  const { app, headers } = await appWithAdmin();
  const stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200);
  const state = stateResponse.json() as StateResponse;
  const response = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      revision: state.revision,
      requestId: "large-state-body-001",
      schedule: {},
      padding: "x".repeat(11 * 1024 * 1024),
    },
  });
  assert.equal(response.statusCode, 400, "the body should parse, then fail schedule validation");
  assert.notEqual(response.statusCode, 413);
});

test("large-school catalogs accept hundreds of entries and more than 120 subgroups", async () => {
  const { app, headers } = await appWithAdmin();
  const initialResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(initialResponse.statusCode, 200, initialResponse.body);
  const state = initialResponse.json() as StateResponse;
  const catalog: Catalog = structuredClone(state.catalog);

  const newGroups = Array.from({ length: 65 }, (_, index) => ({
    id: `scale-catalog-group-${index}`,
    name: `Тестовый класс ${index}`,
    students: 30,
    leaderId: null,
    roomId: null,
    autoRoomIds: [],
    archived: false,
  }));
  catalog.groups.push(...newGroups);
  for (let index = 0; index < 130; index += 1) {
    const group = newGroups[Math.floor(index / 2)];
    catalog.subgroups.push({
      id: `scale-catalog-subgroup-${index}`,
      name: `Подгруппа ${index}`,
      groupId: group.id,
      students: 10,
      archived: false,
    });
  }
  for (let index = 0; index < 200; index += 1) {
    catalog.rooms.push({
      id: `scale-catalog-room-${index}`,
      name: `Кабинет ${index}`,
      capacity: null,
      kind: "general",
      archived: false,
      unavailability: [],
    });
    catalog.teachers.push({
      id: `scale-catalog-teacher-${index}`,
      name: `Преподаватель теста ${index}`,
      subjectIds: [],
      preferredGroupIds: [],
      defaultRoomId: null,
      archived: false,
      unavailability: [],
    });
  }
  const headersWithCsrf = {
    ...headers,
    "x-csrf-token": headers["x-csrf-token"],
  };
  const accepted = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers: headersWithCsrf,
    payload: {
      revision: state.revision,
      requestId: "large-school-catalog-001",
      catalog,
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body.slice(0, 500));
  assert.equal(accepted.json().catalog.subgroups.length, state.catalog.subgroups.length + 130);
  assert.equal(accepted.json().catalog.teachers.length, state.catalog.teachers.length + 200);
  assert.equal(accepted.json().catalog.rooms.length, state.catalog.rooms.length + 200);

  const overLimit: Catalog = structuredClone(accepted.json().catalog);
  while (overLimit.teachers.length < 501) {
    const index = overLimit.teachers.length;
    overLimit.teachers.push({
      id: `scale-over-limit-teacher-${index}`,
      name: `Дополнительный преподаватель ${index}`,
      subjectIds: [],
      preferredGroupIds: [],
      defaultRoomId: null,
      archived: false,
      unavailability: [],
    });
  }
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers: headersWithCsrf,
    payload: {
      revision: accepted.json().revision,
      requestId: "large-school-catalog-002",
      catalog: overLimit,
    },
  });
  assert.equal(rejected.statusCode, 400);
});

test("bulk state reads preserve legacy data and SQLite uses the lesson slot index", async () => {
  const { app, path, headers } = await appWithAdmin();
  const initialResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(initialResponse.statusCode, 200, initialResponse.body);
  const initial = initialResponse.json() as StateResponse;
  const db = new Database(path);
  const groupId = "bulk-read-group";
  db.prepare("INSERT INTO catalog_groups(id,name,students,leader_id,room_id,archived) VALUES(?,?,30,NULL,NULL,0)")
    .run(groupId, "Группа чтения пакетом");
  const subgroup = { id: "bulk-read-subgroup", name: "Подгруппа чтения" };
  db.prepare("INSERT INTO catalog_subgroups(id,group_id,name,students,archived) VALUES(?,?,?,10,0)")
    .run(subgroup.id, groupId, subgroup.name);
  const teacherId = initial.catalog.teachers[0].id;
  const roomId = initial.catalog.rooms[0].id;
  const planSubjects = initial.catalog.subjects.slice(0, 3);
  assert.equal(planSubjects.length, 3, "seed catalog has three subjects for the fixture");

  const dayResult = db.prepare(`
    INSERT INTO schedule_days(group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note,bell_profile_json)
    VALUES(?,?,?,?,?,?,?,?,NULL)
  `).run(groupId, "2039-12-30", 999_999, 0, "08:00", 45, 0, "Fixture day note");
  const dayId = Number(dayResult.lastInsertRowid);
  const insertSlot = db.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,?,?,?)");
  const slots = [0, 1, 2].map((slotIndex) => Number(insertSlot.run(dayId, slotIndex, 480 + slotIndex * 50, 45).lastInsertRowid));
  const insertLesson = db.prepare(`
    INSERT INTO lessons(id,slot_id,subject_id,subgroup,teacher,room,event,note,teacher_ref,room_ref,subgroup_ref,lesson_kind,joint_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `);
  insertLesson.run("bulk-read-lesson-second", slots[0], planSubjects[0].id, subgroup?.name ?? null, initial.catalog.teachers[0].name, null, null, null, teacherId, null, subgroup?.id ?? null, "regular");
  insertLesson.run("bulk-read-lesson-first", slots[0], planSubjects[1].id, null, null, initial.catalog.rooms[0].name, null, "Lesson note", null, roomId, null, "lab");
  insertLesson.run("bulk-read-legacy-lesson", slots[2], planSubjects[2].id, "Старая подгруппа", "Старый преподаватель", "Старый кабинет", null, null, null, null, null, "regular");

  const quarterId = initial.quarters[0].id;
  const insertPlan = db.prepare("INSERT INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind) VALUES(?,?,?,?,?,?,NULL)");
  insertPlan.run("bulk-read-plan-a", quarterId, groupId, planSubjects[0].id, "whole", "regular");
  insertPlan.run("bulk-read-plan-b", quarterId, groupId, planSubjects[1].id, "whole", "regular");
  insertPlan.run("bulk-read-plan-empty", quarterId, groupId, planSubjects[2].id, "whole", "regular");
  const insertAssignment = db.prepare("INSERT INTO plan_assignments(id,plan_id,subgroup_id,target) VALUES(?,?,NULL,?)");
  insertAssignment.run("bulk-read-a-one", "bulk-read-plan-a", 2);
  insertAssignment.run("bulk-read-b-one", "bulk-read-plan-b", 3);
  insertAssignment.run("bulk-read-a-two", "bulk-read-plan-a", 4);
  const slotLookupPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM lessons WHERE slot_id = ?").all(slots[0]) as Array<{ detail: string }>;
  assert.ok(slotLookupPlan.some(({ detail }) => detail.includes("lessons_slot_id")), "SQLite should use the slot foreign-key index");
  db.close();

  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
  const state = response.json() as StateResponse;
  const day = state.schedule[`${groupId}:999999`]?.find((entry) => entry.date === "2039-12-30");
  assert.ok(day);
  assert.equal(day.note, "Fixture day note");
  assert.equal(day.slots.length, 3);
  assert.deepEqual(day.slots[0].map((lesson) => lesson.id), ["bulk-read-lesson-second", "bulk-read-lesson-first"]);
  assert.deepEqual(day.slots[1], []);
  assert.equal(day.slots[2][0].teacher, "Старый преподаватель");
  assert.equal(day.slots[2][0].room, "Старый кабинет");
  assert.equal(day.slots[2][0].subgroup, "Старая подгруппа");
  assert.equal(day.slots[0][0].subgroupId, subgroup?.id);
  assert.equal(day.slots[0][1].note, "Lesson note");

  const plans = new Map(state.studyPlans.map((plan) => [plan.id, plan]));
  assert.deepEqual(plans.get("bulk-read-plan-a")?.assignments.map(({ id, target }) => ({ id, target })), [
    { id: "bulk-read-a-one", target: 2 },
    { id: "bulk-read-a-two", target: 4 },
  ]);
  assert.deepEqual(plans.get("bulk-read-plan-b")?.assignments.map(({ id, target }) => ({ id, target })), [
    { id: "bulk-read-b-one", target: 3 },
  ]);
  assert.deepEqual(plans.get("bulk-read-plan-empty")?.assignments, []);

});
