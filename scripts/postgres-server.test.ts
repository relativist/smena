import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "../server/app.ts";
import type { AsyncDatabase } from "../server/database.ts";
import { openPostgresDatabase } from "../server/database.ts";
import { initializePostgresSchema } from "../server/postgresSchema.ts";
import { migrateSqliteToPostgres } from "./migrate-sqlite-to-postgres.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";

const baseUrl = process.env.SMENA_TEST_DATABASE_URL;
const skipReason = baseUrl
  ? false
  : "Set SMENA_TEST_DATABASE_URL to run PostgreSQL integration tests";
const origin = "http://127.0.0.1";
const starterPassword = "postgres integration test password";

function scopedUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set("options", `${existingOptions ? `${existingOptions} ` : ""}-c search_path=${schema},public`);
  return url.toString();
}

async function withOwnedSchema<T>(run: (databaseUrl: string, pool: Pool) => Promise<T>): Promise<T> {
  const connectionString = baseUrl!;
  const adminPool = new Pool({ connectionString, max: 1, application_name: "smena-postgres-test-admin" });
  const schema = `smena_verify_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  // The generated identifier contains only lowercase letters, digits, and underscores.
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const testUrl = scopedUrl(connectionString, schema);
  const pool = new Pool({ connectionString: testUrl, max: 2, application_name: "smena-postgres-test" });
  try {
    return await run(testUrl, pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

async function startApp(databaseUrl: string) {
  const app = await buildApp({ databaseUrl });
  const apps = app as unknown as { smenaDb: AsyncDatabase };
  return { app, db: apps.smenaDb };
}

async function startAdmin(app: Awaited<ReturnType<typeof buildApp>>) {
  let response = await app.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "postgres-admin", password: starterPassword },
  });
  if (response.statusCode !== 200) {
    response = await app.inject({
      method: "POST", url: "/api/auth/login",
      headers: { origin, host: "127.0.0.1" },
      payload: { username: "postgres-admin", password: starterPassword },
    });
  }
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  return { cookie, headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string } };
}

test("PostgreSQL startup seeds presets once without demo data or an administrator", { skip: skipReason }, async () => {
  await withOwnedSchema(async (databaseUrl) => {
    const first = await startApp(databaseUrl);
    const authStatus = await first.app.inject({ url: "/api/auth/status" });
    assert.equal(authStatus.statusCode, 200);
    assert.equal(authStatus.json().needsSetup, true);
    assert.equal(Number((await first.db.prepare("SELECT COUNT(*) AS count FROM admin_users").get() as { count: number }).count), 0);
    assert.equal(Number((await first.db.prepare("SELECT COUNT(*) AS count FROM catalog_subjects").get() as { count: number }).count), 25);
    const demoRows = await first.db.prepare(`SELECT
      (SELECT COUNT(*) FROM catalog_groups) AS groups,
      (SELECT COUNT(*) FROM catalog_teachers) AS teachers,
      (SELECT COUNT(*) FROM catalog_rooms) AS rooms,
      (SELECT COUNT(*) FROM schedule_days) AS schedule_days,
      (SELECT COUNT(*) FROM lessons) AS lessons`).get() as Record<string, number>;
    assert.deepEqual(Object.values(demoRows).map(Number), [0, 0, 0, 0, 0]);
    const customSubject = await first.db.prepare("SELECT id FROM catalog_subjects ORDER BY insertion_order LIMIT 1").get() as { id: string };
    await first.db.prepare("UPDATE catalog_subjects SET name=? WHERE id=?").run("Имя сохранённого предмета", customSubject.id);
    await first.app.close();

    const second = await startApp(databaseUrl);
    assert.equal(Number((await second.db.prepare("SELECT COUNT(*) AS count FROM catalog_subjects").get() as { count: number }).count), 25);
    assert.deepEqual(await second.db.prepare("SELECT name FROM catalog_subjects WHERE id=?").get(customSubject.id), { name: "Имя сохранённого предмета" });
    assert.equal((await second.app.inject({ url: "/api/auth/status" })).json().needsSetup, true);
    await second.app.close();
  });
});

test("legacy v23 SQLite import derives and verifies publication print metadata without changing source columns", { skip: skipReason }, async () => {
  await withOwnedSchema(async databaseUrl => {
    const root = mkdtempSync(join(tmpdir(), "smena-legacy-print-import-"));
    const sqlitePath = join(root, "source.sqlite");
    let sourceApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    let targetApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      sourceApp = await buildApp({ dbPath: sqlitePath });
      const auth = await startAdmin(sourceApp);
      const state = (await sourceApp.inject({ url: "/api/state", headers: auth.headers })).json() as StateResponse;
      const snapshot = createPublicationSnapshot(state, state.quarters[0]!.id);
      const sourceDb = (sourceApp as unknown as { smenaDb: AsyncDatabase }).smenaDb;
      await sourceDb.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json)
        VALUES(?,3,'2026-10-18T00:00:00.000Z',?,'publisher',?,'{}',?)`)
        .run(snapshot.quarter.id, state.revision, JSON.stringify(snapshot), JSON.stringify(createPublicationPrintIndex(snapshot)));
      const sourceStateAfterPublication = (await sourceApp.inject({ url: "/api/state", headers: auth.headers })).json() as StateResponse;
      await sourceDb.exec("ALTER TABLE published_quarters DROP COLUMN print_index_json");
      await sourceDb.prepare("DELETE FROM schema_migrations WHERE version=24").run();
      const original = await sourceDb.prepare("SELECT * FROM published_quarters").all();
      await sourceApp.close(); sourceApp = undefined;
      const targetDb = openPostgresDatabase(databaseUrl);
      try { await initializePostgresSchema(targetDb); } finally { await targetDb.close(); }
      const digests = await migrateSqliteToPostgres({ from: sqlitePath, databaseUrl });
      assert.equal(digests.get("published_quarters")!.count, 1);
      targetApp = await buildApp({ databaseUrl });
      const db = (targetApp as unknown as { smenaDb: AsyncDatabase }).smenaDb;
      assert.deepEqual(await db.prepare("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters").all(), original);
      assert.deepEqual(JSON.parse((await db.prepare("SELECT print_index_json FROM published_quarters").get()).print_index_json), createPublicationPrintIndex(snapshot));
      const targetAuth = await startAdmin(targetApp);
      const index = await targetApp.inject({ url: "/api/schedule-print/index", headers: targetAuth.headers });
      assert.equal(index.statusCode, 200, index.body);
      assert.deepEqual(index.json().published[0].groups, createPublicationPrintIndex(snapshot).groups);
      assert.deepEqual((await targetApp.inject({ url: "/api/state", headers: targetAuth.headers })).json(), sourceStateAfterPublication);
    } finally {
      await sourceApp?.close();
      await targetApp?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("SQLite migration preserves API state, publication, authentication, and atomic revision behavior", { skip: skipReason }, async () => {
  await withOwnedSchema(async (databaseUrl, pool) => {
    const root = mkdtempSync(join(tmpdir(), "smena-postgres-migration-"));
    const sqlitePath = join(root, "source.sqlite");
    let sourceApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    let targetApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      sourceApp = await buildApp({ dbPath: sqlitePath });
      const sourceAdmin = await startAdmin(sourceApp);
      const sourceDb = (sourceApp as unknown as { smenaDb: AsyncDatabase }).smenaDb;
      let stateResponse = await sourceApp.inject({ url: "/api/state", headers: sourceAdmin.headers });
      assert.equal(stateResponse.statusCode, 200, stateResponse.body);
      const initial = stateResponse.json() as StateResponse;
      const keptLesson = Object.values(initial.schedule).flat().flatMap((day) => day.slots.flat())
        .find((lesson) => lesson.teacherId && lesson.roomId);
      assert.ok(keptLesson, "SQLite fixture has a valid lesson to publish");
      await sourceDb.prepare("DELETE FROM lessons WHERE id<>?").run(keptLesson.id);
      stateResponse = await sourceApp.inject({ url: "/api/state", headers: sourceAdmin.headers });
      let sourceState = stateResponse.json() as StateResponse;
      const quarterId = sourceState.quarters[0]!.id;
      const preview = await sourceApp.inject({ url: `/api/publication-preview?quarterId=${quarterId}`, headers: sourceAdmin.headers });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().canPublish, true, preview.body);
      const publicationResponse = await sourceApp.inject({
        method: "POST", url: "/api/publications", headers: sourceAdmin.headers,
        payload: { quarterId, revision: sourceState.revision, requestId: "pg-migration-publication-01" },
      });
      assert.equal(publicationResponse.statusCode, 200, publicationResponse.body);
      const sourcePublication = await sourceApp.inject({ url: `/api/publications/${quarterId}`, headers: sourceAdmin.headers });
      assert.equal(sourcePublication.statusCode, 200, sourcePublication.body);
      const sourcePublicStudents = await sourceApp.inject({ url: "/api/public/students" });
      assert.equal(sourcePublicStudents.statusCode, 200, sourcePublicStudents.body);
      const publicTeachersBeforeMigration = await sourceApp.inject({ url: "/api/public/teachers" });
      assert.equal(publicTeachersBeforeMigration.statusCode, 200, publicTeachersBeforeMigration.body);

      // Create a visible ordering fixture with large, sparse SQLite rowids. The
      // schedule API orders lessons by rowid, so import must preserve that order.
      const emptySlot = Object.entries(sourceState.schedule).flatMap(([key, days]) => {
        const split = key.lastIndexOf(":");
        const groupId = key.slice(0, split);
        const weekOffset = Number(key.slice(split + 1));
        return days.flatMap((day) => day.slots.flatMap((lessons, slotIndex) => lessons.length === 0
          ? [{ key, groupId, weekOffset, day, slotIndex }]
          : []));
      })[0];
      assert.ok(emptySlot, "SQLite fixture has an empty slot for the rowid ordering fixture");
      const scheduleDay = await sourceDb.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?")
        .get(emptySlot.groupId, emptySlot.day.date) as { id: number };
      const scheduleSlot = await sourceDb.prepare("SELECT id FROM schedule_slots WHERE day_id=? AND slot_index=?")
        .get(scheduleDay.id, emptySlot.slotIndex) as { id: number };
      const fixtureSubject = sourceState.catalog.subjects[0]!.id;
      await sourceDb.prepare("INSERT INTO lessons(id,slot_id,subject_id,lesson_kind) VALUES(?,?,?,'regular')")
        .run("pg-rowid-first", scheduleSlot.id, fixtureSubject);
      await sourceDb.prepare("INSERT INTO lessons(id,slot_id,subject_id,lesson_kind) VALUES(?,?,?,'regular')")
        .run("pg-rowid-second", scheduleSlot.id, fixtureSubject);
      await sourceDb.prepare("UPDATE lessons SET rowid=? WHERE id=?").run(9_000_000, "pg-rowid-first");
      await sourceDb.prepare("UPDATE lessons SET rowid=? WHERE id=?").run(1_000_000, "pg-rowid-second");
      sourceState = (await sourceApp.inject({ url: "/api/state", headers: sourceAdmin.headers })).json() as StateResponse;
      const rowidSchedule = sourceState.schedule[emptySlot.key]!.find((day) => day.date === emptySlot.day.date)!;
      assert.deepEqual(rowidSchedule.slots[emptySlot.slotIndex]!.map((lesson) => lesson.id), ["pg-rowid-second", "pg-rowid-first"]);
      const editorWeekUrl = `/api/editor/week?groupId=${encodeURIComponent(emptySlot.groupId)}&quarterId=${encodeURIComponent(quarterId)}&weekOffset=${emptySlot.weekOffset}`;
      const sourceEditorWeek = await sourceApp.inject({ url: editorWeekUrl, headers: sourceAdmin.headers });
      assert.equal(sourceEditorWeek.statusCode, 200, sourceEditorWeek.body);
      const sourceCoverage = await sourceApp.inject({ url: `/api/plan-coverage?quarterId=${encodeURIComponent(quarterId)}`, headers: sourceAdmin.headers });
      assert.equal(sourceCoverage.statusCode, 200, sourceCoverage.body);
      const month = sourceState.quarters.find((quarter) => quarter.id === quarterId)!.startDate.slice(0, 7);
      const sourceTeacherLoad = await sourceApp.inject({ url: `/api/teacher-load?source=draft&month=${month}`, headers: sourceAdmin.headers });
      assert.equal(sourceTeacherLoad.statusCode, 200, sourceTeacherLoad.body);

      await sourceApp.close();
      sourceApp = undefined;
      const targetDb = openPostgresDatabase(databaseUrl);
      await initializePostgresSchema(targetDb);
      await targetDb.close();
      const migration = await migrateSqliteToPostgres({ from: sqlitePath, databaseUrl });
      assert.ok(migration.size >= 25);

      targetApp = await buildApp({ databaseUrl });
      const migratedRowIds = await (targetApp as unknown as { smenaDb: AsyncDatabase }).smenaDb
        .prepare("SELECT id,insertion_order FROM lessons WHERE id IN (?,?) ORDER BY insertion_order")
        .all("pg-rowid-first", "pg-rowid-second") as Array<{ id: string; insertion_order: number }>;
      assert.deepEqual(migratedRowIds, [
        { id: "pg-rowid-second", insertion_order: 1_000_000 },
        { id: "pg-rowid-first", insertion_order: 9_000_000 },
      ]);
      const login = await targetApp.inject({
        method: "POST", url: "/api/auth/login",
        headers: { origin, host: "127.0.0.1" },
        payload: { username: "postgres-admin", password: starterPassword },
      });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const targetHeaders = { cookie, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
      const targetStateResponse = await targetApp.inject({ url: "/api/state", headers: targetHeaders });
      assert.equal(targetStateResponse.statusCode, 200, targetStateResponse.body);
      assert.deepEqual(targetStateResponse.json(), sourceState);
      assert.deepEqual((await targetApp.inject({ url: `/api/publications/${quarterId}`, headers: targetHeaders })).json(), sourcePublication.json());
      assert.deepEqual((await targetApp.inject({ url: "/api/public/students" })).json(), sourcePublicStudents.json());
      assert.deepEqual((await targetApp.inject({ url: "/api/public/teachers" })).json(), publicTeachersBeforeMigration.json());
      assert.equal((await targetApp.inject({ url: `/api/teacher-load?source=draft&month=${month}` })).statusCode, 401,
        "teacher-load remains private after migration");
      assert.deepEqual((await targetApp.inject({ url: editorWeekUrl, headers: targetHeaders })).json(), sourceEditorWeek.json());
      assert.deepEqual((await targetApp.inject({ url: `/api/plan-coverage?quarterId=${encodeURIComponent(quarterId)}`, headers: targetHeaders })).json(), sourceCoverage.json());
      assert.deepEqual((await targetApp.inject({ url: `/api/teacher-load?source=draft&month=${month}`, headers: targetHeaders })).json(), sourceTeacherLoad.json());

      const beforeSettings = await targetApp.inject({ url: "/api/display-settings", headers: targetHeaders });
      const baseSettings = beforeSettings.json() as { settings: Record<string, unknown>; revision: number };
      const requestA = {
        settings: { ...baseSettings.settings, schoolName: "Concurrent A" },
        revision: baseSettings.revision, requestId: "pg-race-request-a-01",
      };
      const requestB = {
        settings: { ...baseSettings.settings, schoolName: "Concurrent B" },
        revision: baseSettings.revision, requestId: "pg-race-request-b-01",
      };
      const [resultA, resultB] = await Promise.all([requestA, requestB].map((payload) => targetApp!.inject({
        method: "PUT", url: "/api/display-settings", headers: targetHeaders, payload,
      })));
      const successful = [resultA, resultB].filter((response) => response.statusCode === 200);
      const conflicted = [resultA, resultB].filter((response) => response.statusCode === 409);
      assert.equal(successful.length, 1, "one same-revision update succeeds");
      assert.equal(conflicted.length, 1, "the competing same-revision update conflicts");
      const winningRequest = resultA.statusCode === 200 ? requestA : requestB;
      const winningResponse = successful[0]!.json();
      const replay = await targetApp.inject({ method: "PUT", url: "/api/display-settings", headers: targetHeaders, payload: winningRequest });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json(), winningResponse, "retry returns the original receipt");

      const stableSettings = await targetApp.inject({ url: "/api/display-settings", headers: targetHeaders });
      const invalid = await targetApp.inject({ method: "PUT", url: "/api/display-settings", headers: targetHeaders, payload: {
        settings: { ...stableSettings.json().settings, adminSubjectIcons: "invalid" },
        revision: stableSettings.json().revision, requestId: "pg-invalid-mutation-01",
      } });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual((await targetApp.inject({ url: "/api/display-settings", headers: targetHeaders })).json(), stableSettings.json());

      await pool.query(`CREATE FUNCTION fail_test_replay_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced integration failure'; END $$`);
      await pool.query("CREATE TRIGGER fail_test_replay BEFORE INSERT ON school_display_setting_replays FOR EACH ROW EXECUTE FUNCTION fail_test_replay_insert()");
      const failure = await targetApp.inject({ method: "PUT", url: "/api/display-settings", headers: targetHeaders, payload: {
        settings: { ...stableSettings.json().settings, schoolName: "Must roll back" },
        revision: stableSettings.json().revision, requestId: "pg-rollback-request-01",
      } });
      assert.equal(failure.statusCode, 500);
      assert.deepEqual((await targetApp.inject({ url: "/api/display-settings", headers: targetHeaders })).json(), stableSettings.json(),
        "a database failure after the settings update rolls the transaction back");
      await pool.query("DROP TRIGGER fail_test_replay ON school_display_setting_replays");
      await pool.query("DROP FUNCTION fail_test_replay_insert()");

      const persistedState = (await targetApp.inject({ url: "/api/state", headers: targetHeaders })).json();
      await targetApp.close();
      targetApp = undefined;
      const reopened = await buildApp({ databaseUrl });
      targetApp = reopened;
      const reopenedLogin = await reopened.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: {
        username: "postgres-admin", password: starterPassword,
      } });
      assert.equal(reopenedLogin.statusCode, 200, reopenedLogin.body);
      const reopenedCookie = String(reopenedLogin.headers["set-cookie"]).split(";")[0]!;
      const reopenedHeaders = { cookie: reopenedCookie, origin, host: "127.0.0.1", "x-csrf-token": reopenedLogin.json().csrfToken as string };
      assert.deepEqual((await reopened.inject({ url: "/api/state", headers: reopenedHeaders })).json(), persistedState);
    } finally {
      if (sourceApp) await sourceApp.close();
      if (targetApp) await targetApp.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
