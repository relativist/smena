import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import { createDatabaseBackup, restoreDatabaseBackup } from "./database-backup.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "smena-db-backup-"));
  roots.push(path);
  return path;
}

async function newApp(path: string) {
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  return { app, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("backup captures uncheckpointed WAL and restores authentication, settings, and publication data", async () => {
  const root = tempRoot();
  const source = join(root, "active.sqlite");
  const backup = join(root, "school-backup.sqlite");
  const restored = join(root, "restored.sqlite");
  const { app, db } = await newApp(source);
  const setup = await app.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "backup-admin", password: "backup test password" },
  });
  assert.equal(setup.statusCode, 200, setup.body);

  db.pragma("wal_autocheckpoint = 0");
  const state = (await app.inject({ url: "/api/state", headers: {
    cookie: String(setup.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1",
  } })).json();
  const quarter = state.quarters[0];
  db.prepare("UPDATE school_display_settings SET settings_json=?,revision=? WHERE id=1")
    .run(JSON.stringify({ adminSubjectIcons: false, studentSubjectIcons: true }), 4);
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json)
    VALUES(?,?,?,?,?,?,?)`).run(quarter.id, 3, "2026-10-14T12:00:00Z", 7, "backup-admin", JSON.stringify(createPublicationSnapshot(state, quarter.id)), "{\"lessons\":1}");
  const sourceBefore = db.prepare("SELECT version,snapshot_json FROM published_quarters WHERE quarter_id=?").get(quarter.id);
  assert.ok(existsSync(`${source}-wal`), "fixture writes remain in the WAL before backup");

  assert.equal(await createDatabaseBackup({ db: source, to: backup }), backup);
  await restoreDatabaseBackup({ from: backup, to: restored });

  const reopened = await newApp(restored);
  const login = await reopened.app.inject({
    method: "POST", url: "/api/auth/login",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "backup-admin", password: "backup test password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const restoredPublication = reopened.db.prepare("SELECT version,snapshot_json FROM published_quarters WHERE quarter_id=?").get(quarter.id);
  assert.deepEqual(restoredPublication, sourceBefore);
  assert.deepEqual(reopened.db.prepare("SELECT settings_json,revision FROM school_display_settings WHERE id=1").get(), {
    settings_json: JSON.stringify({ adminSubjectIcons: false, studentSubjectIcons: true }), revision: 4,
  });
  assert.deepEqual(db.prepare("SELECT version,snapshot_json FROM published_quarters WHERE quarter_id=?").get(quarter.id), sourceBefore,
    "backup leaves the active source data available unchanged");
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(statSync(restored).mode & 0o777, 0o600);
});

test("backup and restore refuse missing, invalid, identical, and existing destinations", async () => {
  const root = tempRoot();
  const source = join(root, "source.sqlite");
  const db = new Database(source);
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('kept')");
  db.close();
  const invalid = join(root, "not-sqlite.sqlite");
  writeFileSync(invalid, "not a database");

  await assert.rejects(createDatabaseBackup({ db: join(root, "missing.sqlite"), to: join(root, "missing-output.sqlite") }));
  await assert.rejects(createDatabaseBackup({ db: invalid, to: join(root, "invalid-output.sqlite") }));
  await assert.rejects(createDatabaseBackup({ db: source, to: source }), /different files|already exists/);
  await assert.rejects(restoreDatabaseBackup({ from: invalid, to: join(root, "restore-invalid.sqlite") }));

  const existing = join(root, "existing.sqlite");
  writeFileSync(existing, "keep this exact file");
  await assert.rejects(createDatabaseBackup({ db: source, to: existing }), /already exists/);
  assert.equal(readFileSync(existing, "utf8"), "keep this exact file");

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const destination = join(root, `orphan${suffix}.sqlite`);
    const sidecar = `${destination}${suffix}`;
    const sidecarContents = `preserve orphan ${suffix}`;
    writeFileSync(sidecar, sidecarContents);
    await assert.rejects(createDatabaseBackup({ db: source, to: destination }), /sidecar already exists/);
    assert.equal(existsSync(destination), false, "a main database is not published beside an orphan sidecar");
    assert.equal(readFileSync(sidecar, "utf8"), sidecarContents);
    rmSync(sidecar);
  }

  const check = new Database(source, { readonly: true });
  assert.equal(check.prepare("SELECT value FROM proof").pluck().get(), "kept");
  check.close();
});

test("failed output paths leave no partial destination or temporary directory", async () => {
  const root = tempRoot();
  const source = join(root, "source.sqlite");
  const db = new Database(source);
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('safe')");
  db.close();
  const missingDirectory = join(root, "missing", "backup.sqlite");
  await assert.rejects(createDatabaseBackup({ db: source, to: missingDirectory }));
  assert.equal(existsSync(missingDirectory), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp-")), []);
  const check = new Database(source, { readonly: true });
  assert.equal(check.prepare("SELECT value FROM proof").pluck().get(), "safe");
  check.close();
});
