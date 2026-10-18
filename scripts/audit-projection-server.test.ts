import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const roots: string[] = [];
const origin = "http://127.0.0.1";

async function start() {
  const root = mkdtempSync(join(tmpdir(), "smena-audit-projection-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") });
  apps.push(app);
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "audit test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const raw = auth.headers["set-cookie"], cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  return {
    app,
    db: (app as unknown as { smenaDb: Database.Database }).smenaDb,
    headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string },
  };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveCatalog(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, catalog: StateResponse["catalog"], revision: number, requestId: string) {
  return app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision, requestId } });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("renaming one teacher preserves every plan assignment and teacher-subject row identity", async () => {
  const { app, db, headers } = await start();
  const before = await state(app, headers);
  assert.ok(before.studyPlans.length > 0);
  const assignments = db.prepare("SELECT rowid,* FROM plan_assignments ORDER BY rowid").all();
  const teacherSubjects = db.prepare("SELECT rowid,* FROM catalog_teacher_subjects ORDER BY rowid").all();
  const catalog = structuredClone(before.catalog);
  const teacher = catalog.teachers[0]!;
  teacher.name += " audit";

  const saved = await saveCatalog(app, headers, catalog, before.revision, "audit-teacher-rename-001");
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.deepEqual(db.prepare("SELECT rowid,* FROM plan_assignments ORDER BY rowid").all(), assignments);
  assert.deepEqual(db.prepare("SELECT rowid,* FROM catalog_teacher_subjects ORDER BY rowid").all(), teacherSubjects);
  assert.deepEqual(after.studyPlans, before.studyPlans);
  const expectedSchedule = structuredClone(before.schedule);
  for (const days of Object.values(expectedSchedule))
    for (const day of days)
      for (const slot of day.slots)
        for (const lesson of slot)
          if (lesson.teacherId === teacher.id) lesson.teacher = teacher.name;
  assert.deepEqual(after.schedule, expectedSchedule);
});

test("archiving one subgroup changes its managed plan assignments without rewriting other groups", async () => {
  const { app, db, headers } = await start();
  const before = await state(app, headers);
  const subgroup = before.catalog.subgroups.find(item => !item.archived)!;
  const targetPlans = before.studyPlans.filter(plan => plan.groupId === subgroup.groupId && plan.mode === "subgroups" && plan.assignments.some(assignment => assignment.subgroupId === subgroup.id));
  assert.ok(targetPlans.length > 0);
  const otherGroupRows = db.prepare("SELECT rowid,* FROM plan_assignments WHERE plan_id IN (SELECT id FROM study_plans WHERE group_id<>?) ORDER BY rowid").all(subgroup.groupId);
  const catalog = structuredClone(before.catalog);
  catalog.subgroups.find(item => item.id === subgroup.id)!.archived = true;

  const saved = await saveCatalog(app, headers, catalog, before.revision, "audit-subgroup-archive-001");
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.deepEqual(db.prepare("SELECT rowid,* FROM plan_assignments WHERE plan_id IN (SELECT id FROM study_plans WHERE group_id<>?) ORDER BY rowid").all(subgroup.groupId), otherGroupRows);
  for (const plan of targetPlans)
    assert.ok(!after.studyPlans.find(item => item.id === plan.id)?.assignments.some(assignment => assignment.subgroupId === subgroup.id));
});
