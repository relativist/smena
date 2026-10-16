import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { fromGroupPlan, projectCurricula, replacementGroups, validateCurricula, type Curriculum } from "../shared/curricula.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";
function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-curricula-")); roots.push(root); return join(root, "draft.sqlite");
}
async function appWithAdmin(path = dbPath()) {
  const app = await buildApp({ dbPath: path }); apps.push(app);
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"], cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0]; assert.ok(cookie);
  return { app, path, headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string } };
}
async function getState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers }); assert.equal(response.statusCode, 200, response.body); return response.json() as StateResponse;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("one subgroup hour value fans out to every active subgroup and forged old fields are rejected", async () => {
  const { app, headers } = await appWithAdmin(), before = await getState(app, headers);
  const seed = before.studyPlans.find(p => p.mode === "whole")!;
  const additions = structuredClone(before.catalog);
  additions.subgroups.push({ id: "subgroup:5a:new", groupId: "5a", name: "5А/Новая", students: 0, archived: false });
  const catalogSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: additions, revision: before.revision, requestId: "curr-catalog-add-001" } });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  const expandedState = catalogSave.json() as StateResponse;
  assert.ok(expandedState.studyPlans.some(p => p.groupId === "5a" && p.mode === "subgroups" && p.assignments.some(a => a.subgroupId === "subgroup:5a:new")));
  const row = { id: "row-one", subjectId: seed.subjectId, lessonKind: seed.lessonKind, mode: "subgroups" as const, hours: 4 };
  const curriculum: Curriculum = { id: "single-curriculum", name: "Общий", quarterId: seed.quarterId, groupIds: ["5a"], rows: [row] };
  assert.equal(validateCurricula([curriculum], expandedState.catalog, expandedState.quarters), null);
  const projected = projectCurricula([curriculum], expandedState.studyPlans, expandedState.catalog);
  const plan = projected.find(p => p.groupId === "5a" && p.subjectId === row.subjectId)!;
  assert.equal(plan.assignments.length, 3);
  assert.deepEqual(new Set(plan.assignments.map(a => a.subgroupId)), new Set(expandedState.catalog.subgroups.filter(s => s.groupId === "5a" && !s.archived).map(s => s.id)));
  assert.deepEqual(new Set(plan.assignments.map(a => a.target)), new Set([4]));
  const forged = { ...curriculum, bindings: { "5a": {} }, rows: [{ ...row, hours: [4, 4] }] };
  assert.ok(validateCurricula([forged], expandedState.catalog, expandedState.quarters));
  const noSubgroups = structuredClone(expandedState.catalog); noSubgroups.subgroups = noSubgroups.subgroups.filter(s => s.groupId !== "5a");
  assert.match(validateCurricula([curriculum], noSubgroups, expandedState.quarters)!, /5А/);
  assert.ok(before.catalog.subgroups.some(s => s.groupId === "5a"));
});

test("subgroup rows can target a different subset in each assigned group", async () => {
  const { app, headers } = await appWithAdmin(), state = await getState(app, headers);
  const source = state.studyPlans.find(p => p.groupId === "5a")!;
  const subgroups = state.catalog.subgroups.filter(s => s.groupId === "5a" && !s.archived);
  assert.ok(subgroups.length >= 2);
  const row: Curriculum["rows"][number] = {
    id: "subset-row", subjectId: source.subjectId, lessonKind: source.lessonKind, mode: "subgroups", hours: 4,
    subgroupIdsByGroup: { "5a": [subgroups[0]!.id] },
  };
  const curriculum: Curriculum = { id: "subset-curriculum", name: "Подгруппы", quarterId: source.quarterId, groupIds: ["5a"], rows: [row] };
  assert.equal(validateCurricula([curriculum], state.catalog, state.quarters), null);
  const projected = projectCurricula([curriculum], state.studyPlans, state.catalog);
  const result = projected.find(p => p.groupId === "5a" && p.subjectId === row.subjectId)!;
  assert.deepEqual(result.assignments.map(a => a.subgroupId), [subgroups[0]!.id]);
  const sparse = structuredClone(curriculum); sparse.groupIds.push("5b");
  assert.equal(validateCurricula([sparse], state.catalog, state.quarters), null);
  const projectedSparse = projectCurricula([sparse], state.studyPlans, state.catalog);
  assert.equal(projectedSparse.find(p => p.groupId === "5b" && p.subjectId === row.subjectId)!.assignments.length, state.catalog.subgroups.filter(s => s.groupId === "5b" && !s.archived).length);
  const extra = structuredClone(curriculum); extra.rows[0]!.subgroupIdsByGroup!["5b"] = ["subgroup:unknown"];
  assert.match(validateCurricula([extra], state.catalog, state.quarters)!, /подгрупп/);
  const duplicate = structuredClone(curriculum); duplicate.rows[0]!.subgroupIdsByGroup!["5a"] = [subgroups[0]!.id, subgroups[0]!.id];
  assert.match(validateCurricula([duplicate], state.catalog, state.quarters)!, /подгруппа/);
  const legacy = structuredClone(curriculum); delete legacy.rows[0]!.subgroupIdsByGroup;
  assert.equal(validateCurricula([legacy], state.catalog, state.quarters), null);
  assert.equal(projectCurricula([legacy], state.studyPlans, state.catalog).find(p => p.groupId === "5a" && p.subjectId === row.subjectId)!.assignments.length, subgroups.length);
});

test("importing a group plan keeps its selected subgroup IDs", async () => {
  const { app, headers } = await appWithAdmin(), state = await getState(app, headers);
  const source = structuredClone(state.studyPlans.find(p => p.groupId === "5a" && p.mode === "subgroups")!);
  const selected = source.assignments.find(assignment => assignment.subgroupId)!
  source.assignments = [selected];
  const imported = fromGroupPlan("Импорт", "5a", source.quarterId, [source], state.catalog);
  assert.deepEqual(imported.rows[0]!.subgroupIdsByGroup, { "5a": [selected.subgroupId] });
});

test("curriculum endpoint keeps auth, replay, revisions and schedule protections; detached plans remain named", async () => {
  const { app, headers } = await appWithAdmin(), before = await getState(app, headers);
  const schedule = structuredClone(before.schedule), source = before.studyPlans.find(p => p.groupId === "5a" && p.mode === "whole")!;
  const curriculum: Curriculum = { id: "curriculum-transaction", name: "План параллели", quarterId: source.quarterId, groupIds: ["5a", "5b"], rows: [
    { id: "row-math", subjectId: source.subjectId, lessonKind: source.lessonKind, mode: "whole", hours: 2 },
  ] };
  const missingAuth = await app.inject({ method: "PUT", url: "/api/curricula", headers: { origin, host: "127.0.0.1" }, payload: { curricula: [curriculum], revision: before.revision, requestId: "curr-no-auth-0001" } });
  assert.equal(missingAuth.statusCode, 401);
  const save = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: { curricula: [curriculum], revision: before.revision, requestId: "curr-save-row-0001", confirmGroupReplacement: true } });
  assert.equal(save.statusCode, 200, save.body);
  let state = save.json() as StateResponse;
  assert.deepEqual(state.schedule, schedule);
  for (const id of curriculum.groupIds) assert.equal(state.studyPlans.find(p => p.groupId === id && p.subjectId === source.subjectId)?.assignments[0]?.target, 2);
  const replay = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: { curricula: [curriculum], revision: before.revision, requestId: "curr-save-row-0001", confirmGroupReplacement: true } });
  assert.equal(replay.statusCode, 200); assert.equal((replay.json() as StateResponse).revision, state.revision);
  const edited = structuredClone(curriculum); edited.rows[0]!.hours = 9;
  const edit = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: { curricula: [edited], revision: state.revision, requestId: "curr-edit-row-0001" } });
  assert.equal(edit.statusCode, 200, edit.body); state = edit.json() as StateResponse;
  const detached = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: { curricula: [], revision: state.revision, requestId: "curr-detach-0001" } });
  assert.equal(detached.statusCode, 200, detached.body); state = detached.json() as StateResponse;
  assert.deepEqual(state.schedule, schedule);
  assert.ok(state.curricula?.some(c => c.name.startsWith("План 5А") && c.groupIds.length === 1));
  assert.ok(state.studyPlans.some(p => p.groupId === "5a" && p.subjectId === source.subjectId && p.assignments[0]?.target === 9));
});

test("schema 11 wraps orphan group plans without changing their assignments or schedule", async () => {
  const { app, path, headers } = await appWithAdmin(), before = await getState(app, headers);
  const plans = structuredClone(before.studyPlans), originalSchedule = structuredClone(before.schedule);
  await app.close(); apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  db.prepare("DELETE FROM curricula").run();
  const source = plans.find(p => p.groupId === "5a" && p.mode === "subgroups")!;
  source.assignments[0]!.target = 17; source.assignments.at(-1)!.target = 19;
  for (const plan of plans) {
    db.prepare("UPDATE plan_assignments SET target=? WHERE id=?").run(plan.assignments[0]!.target, plan.assignments[0]!.id);
    for (const assignment of plan.assignments.slice(1)) db.prepare("UPDATE plan_assignments SET target=? WHERE id=?").run(assignment.target, assignment.id);
  }
  db.prepare("INSERT INTO curricula(id,curriculum_json) VALUES(?,?)").run("old-named", JSON.stringify({
    id: "old-named", name: "Старый именованный", quarterId: source.quarterId, groupIds: ["5a"], bindings: {},
    rows: [{ id: "old-row", subjectId: source.subjectId, lessonKind: source.lessonKind, mode: "subgroups", hours: [17, 19] }],
  }));
  db.prepare("DELETE FROM schema_migrations WHERE version=11").run(); db.close();
  const reopened = await buildApp({ dbPath: path }); apps.push(reopened);
  const state = await getState(reopened, headers);
  assert.deepEqual(state.schedule, originalSchedule);
  assert.deepEqual(state.studyPlans, plans);
  const migrated = state.curricula!.find(c => c.id === "old-named")!;
  assert.equal(migrated.groupIds[0], "5a"); assert.equal(migrated.rows[0]!.hours, 19);
  assert.ok(state.curricula!.some(c => c.groupIds.includes("5b") && c.name.startsWith("План")));
});

test("plan ownership and replacement keys use group-quarter pairs", () => {
  const curriculum = { id: "one", name: "Plan", quarterId: "q:x", groupIds: ["g:x"], rows: [] } satisfies Curriculum;
  const result = replacementGroups([curriculum], [], [{ id: "old", quarterId: "q:x", groupId: "g:x", subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "a", subgroupId: null, target: 1 }] }]);
  assert.deepEqual(result, ["g:x"]);
});
