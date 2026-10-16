import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { AsyncDatabase } from "../server/database.ts";
import { openPostgresDatabase } from "../server/database.ts";
import { initializePostgresSchema } from "../server/postgresSchema.ts";
import { migrateSqliteToPostgres } from "./migrate-sqlite-to-postgres.ts";

const baseUrl = process.env.SMENA_TEST_DATABASE_URL;
const skipReason = baseUrl ? false : "Set SMENA_TEST_DATABASE_URL to run PostgreSQL integration tests";
const origin = "http://127.0.0.1";
const password = "postgres concurrency test password";

function scopedUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options")?.trim();
  url.searchParams.set("options", `${options ? `${options} ` : ""}-c search_path=${schema},public`);
  return url.toString();
}

async function withOwnedSchema<T>(run: (databaseUrl: string) => Promise<T>): Promise<T> {
  const adminPool = new Pool({ connectionString: baseUrl!, max: 1, application_name: "smena-concurrency-test-admin" });
  const schema = `smena_concurrency_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    return await run(scopedUrl(baseUrl!, schema));
  } finally {
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

async function setup(databaseUrl: string) {
  const root = mkdtempSync(join(tmpdir(), "smena-postgres-concurrency-"));
  let source: Awaited<ReturnType<typeof buildApp>> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const sqlitePath = join(root, "source.sqlite");
    source = await buildApp({ dbPath: sqlitePath });
    const setupResponse = await source.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password } });
    assert.equal(setupResponse.statusCode, 200, setupResponse.body);
    await source.close(); source = undefined;

    const schemaDb = openPostgresDatabase(databaseUrl);
    await initializePostgresSchema(schemaDb);
    await schemaDb.close();
    await migrateSqliteToPostgres({ from: sqlitePath, databaseUrl });

    app = await buildApp({ databaseUrl });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
    return { app, headers, db: (app as unknown as { smenaDb: AsyncDatabase }).smenaDb, cleanup: async () => { await app!.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) {
    await source?.close();
    await app?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function readState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

function gateTransactions(db: AsyncDatabase, participants: number) {
  const original = db.transaction.bind(db);
  let arrivals = 0;
  let open!: () => void;
  const barrier = new Promise<void>(resolve => { open = resolve; });
  let armed = true;
  let reached!: () => void;
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  db.transaction = (fn: (...args: any[]) => any) => {
    const run = original(fn);
    return async (...args: any[]) => {
      if (armed) {
        arrivals++;
        if (arrivals === participants) { armed = false; reached(); open(); }
        else await barrier;
      }
      return await run(...args);
    };
  };
  return { arrived, restore: () => { armed = false; open(); db.transaction = original; } };
}

function gateNextTransaction(db: AsyncDatabase) {
  const original = db.transaction.bind(db);
  let release!: () => void;
  let reached!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  let armed = true;
  db.transaction = (fn: (...args: any[]) => any) => {
    const run = original(fn);
    return async (...args: any[]) => {
      if (armed) { armed = false; reached(); await wait; }
      return await run(...args);
    };
  };
  return { arrived, release, restore: () => { armed = false; release(); db.transaction = original; } };
}

test("PostgreSQL serializes competing curriculum reuse requests at one revision", { skip: skipReason }, async () => {
  await withOwnedSchema(async databaseUrl => {
    const { app, headers, cleanup, db } = await setup(databaseUrl);
    try {
      const initial = await readState(app, headers);
      const source = initial.curricula?.find(item => item.groupIds.length > 0 && item.rows.length > 0);
      assert.ok(source, "migrated fixture has a reusable curriculum");
      const groupId = source.groupIds[0]!;
      const quarter = { id: "race-quarter-2030", name: "2030 · гонка", startDate: "2030-09-01", endDate: "2030-10-15" };
      const added = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: {
        quarters: [...initial.quarters, quarter], studyPlans: initial.studyPlans, metadataOnly: true,
        responseQuarterId: quarter.id, revision: initial.revision, requestId: `race-quarter-${randomUUID()}`,
      } });
      assert.equal(added.statusCode, 200, added.body);
      const revision = (added.json() as StateResponse).revision;
      const request = (suffix: string) => ({ curriculumId: source.id, quarterId: quarter.id, groupIds: [groupId], revision, requestId: `race-reuse-${suffix}-${randomUUID()}` });
      const gate = gateTransactions(db, 2);
      const first = app.inject({ method: "POST", url: "/api/curricula/reuse", headers, payload: request("a") });
      const second = app.inject({ method: "POST", url: "/api/curricula/reuse", headers, payload: request("b") });
      await gate.arrived;
      gate.restore();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      const after = await readState(app, headers);
      assert.equal(after.revision, revision + 1, "only the winner may advance the revision");
      const copies = after.curricula!.filter(item => item.quarterId === quarter.id && item.groupIds.includes(groupId));
      assert.equal(copies.length, 1, "the losing request must not overwrite or duplicate the winning plan");
      assert.ok(after.studyPlans.some(plan => plan.quarterId === quarter.id && plan.groupId === groupId), "winner's projected study plan remains stored");
    } finally { await cleanup(); }
  });
});

test("PostgreSQL rejects an undo if a newer write commits after undo pre-read", { skip: skipReason }, async () => {
  await withOwnedSchema(async databaseUrl => {
    const { app, headers, cleanup, db } = await setup(databaseUrl);
    try {
      const initial = await readState(app, headers);
      let picked: { key: string; date: string; lesson: StateResponse["schedule"][string][number]["slots"][number][number]; targetId: string; quarterId: string } | undefined;
      for (const [key, days] of Object.entries(initial.schedule)) for (const day of days) for (const slot of day.slots) for (const lesson of slot) {
        const quarter = initial.quarters.find(item => item.startDate <= day.date && item.endDate >= day.date);
        const target = initial.catalog.teachers.find(teacher => teacher.id !== lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(lesson.subjectId));
        if (quarter && lesson.teacherId && target) { picked = { key, date: day.date, lesson, targetId: target.id, quarterId: quarter.id }; break; }
      }
      assert.ok(picked, "migrated fixture has a lesson with an eligible substitute");
      const groupId = picked.key.slice(0, picked.key.lastIndexOf(":"));
      const sparse = structuredClone(initial.schedule);
      for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
      const originalDay = initial.schedule[picked.key]!.find(day => day.date === picked.date)!;
      const sourceSlot = originalDay.slots.findIndex(slot => slot.some(lesson => lesson.id === picked!.lesson.id));
      sparse[picked.key]!.find(day => day.date === picked!.date)!.slots[sourceSlot] = [picked.lesson];
      const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `race-sparse-${randomUUID()}` } });
      assert.equal(saved.statusCode, 200, saved.body);
      const state = await readState(app, headers);
      const request = { mode: "assign", quarterId: picked.quarterId, subjectId: picked.lesson.subjectId, sourceTeacherId: picked.lesson.teacherId, groupIds: [groupId], scope: "lesson", lessonId: picked.lesson.id, targetTeacherId: picked.targetId, persist: false };
      const preview = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request } });
      assert.equal(preview.statusCode, 200, preview.body);
      const unit = preview.json().preview.units.find((item: { lessonIds: string[] }) => item.lessonIds.includes(picked!.lesson.id));
      assert.ok(unit);
      const applied = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: {
        revision: state.revision, requestId: `race-apply-${randomUUID()}`, request,
        expectedUnits: [{ unitId: unit.id, teacherId: picked.targetId }],
      } });
      assert.equal(applied.statusCode, 200, applied.body);
      const operationId = applied.json().operationId as string;
      const undoBody = { revision: applied.json().revision as number, requestId: `race-undo-${randomUUID()}` };
      const gate = gateNextTransaction(db);
      const undo = app.inject({ method: "POST", url: `/api/teacher-reassignments/${operationId}/undo?response=receipt`, headers, payload: undoBody });
      await gate.arrived; // all undo pre-reads have completed; it is waiting to acquire the transaction lock
      const beforeNewerWrite = await readState(app, headers);
      const changedCatalog = structuredClone(beforeNewerWrite.catalog);
      changedCatalog.subjects[0]!.name = `${changedCatalog.subjects[0]!.name} · новая версия`;
      const newerWrite = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: {
        catalog: changedCatalog, revision: undoBody.revision, requestId: `race-catalog-${randomUUID()}`,
      } });
      assert.equal(newerWrite.statusCode, 200, newerWrite.body);
      gate.release();
      const undoResponse = await undo;
      gate.restore();
      assert.equal(undoResponse.statusCode, 409, undoResponse.body);
      const after = await readState(app, headers);
      assert.equal(after.revision, undoBody.revision + 1, "undo must not overwrite the newer revision");
      assert.equal(after.catalog.subjects[0]!.name, `${beforeNewerWrite.catalog.subjects[0]!.name} · новая версия`);
      const located = after.schedule[picked.key]!.find(day => day.date === picked!.date)!.slots.flat().find(lesson => lesson.id === picked!.lesson.id);
      assert.equal(located?.teacherId, picked.targetId, "the rejected undo must leave the applied reassignment intact");
    } finally { await cleanup(); }
  });
});
