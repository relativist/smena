import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Pool } from "pg";
import { buildApp } from "../server/app.ts";
import type { AsyncDatabase } from "../server/database.ts";
import { SchoolArchiveService } from "../server/schoolArchive.ts";
import type { ArchivePreview, ArchiveRestoreResult } from "../shared/dataTransfer.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";

const baseUrl = process.env.SMENA_TEST_DATABASE_URL;
const skipReason = baseUrl ? false : "Set SMENA_TEST_DATABASE_URL to run PostgreSQL integration tests";
const origin = "http://127.0.0.1";
const adminPassword = "data transfer integration test password";
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const roots: string[] = [];

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "smena-data-transfer-"));
  roots.push(path);
  return path;
}

function scopedUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options")?.trim();
  url.searchParams.set("options", `${options ? `${options} ` : ""}-c search_path=${schema},public`);
  return url.toString();
}

async function withOwnedSchemas<T>(run: (urls: { source: string; target: string }, root: string) => Promise<T>): Promise<T> {
  const adminPool = new Pool({ connectionString: baseUrl!, max: 1, application_name: "smena-data-transfer-test-admin" });
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const sourceSchema = `smena_transfer_source_${suffix}`;
  const targetSchema = `smena_transfer_target_${suffix}`;
  await adminPool.query(`CREATE SCHEMA "${sourceSchema}"`);
  await adminPool.query(`CREATE SCHEMA "${targetSchema}"`);
  try {
    return await run({ source: scopedUrl(baseUrl!, sourceSchema), target: scopedUrl(baseUrl!, targetSchema) }, tempRoot());
  } finally {
    for (const app of apps.splice(0)) await app.close();
    await adminPool.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
    await adminPool.query(`DROP SCHEMA "${targetSchema}" CASCADE`);
    await adminPool.end();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}

async function startApp(databaseUrl: string, root: string, options: { archiveBeforeWrite?: () => Promise<void> } = {}) {
  const app = await buildApp({ databaseUrl, archiveBackupDirectory: join(root, "backups"), ...options } as Parameters<typeof buildApp>[0]);
  apps.push(app);
  return { app, db: (app as unknown as { smenaDb: AsyncDatabase }).smenaDb };
}

async function startAdmin(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  let response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username, password: adminPassword } });
  if (response.statusCode !== 200) response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username, password: adminPassword } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  return { cookie, csrfToken: response.json().csrfToken as string, username,
    headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string } };
}

async function addGroup(db: AsyncDatabase, id: string, name: string): Promise<void> {
  await db.prepare("INSERT INTO catalog_groups(id,name,students,archived) VALUES(?,?,20,0)").run(id, name);
}

async function exportArchive(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>): Promise<Buffer> {
  const response = await app.inject({ method: "POST", url: "/api/data-transfer/export", headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["content-type"]), /application\/gzip/);
  assert.match(String(response.headers["content-disposition"]), /\.smena\.gz/);
  const bytes = Buffer.from(response.rawPayload);
  assert.equal(Number(response.headers["content-length"]), bytes.length, `content-length header must match received ${bytes.length} bytes`);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b], `export response should be gzip bytes, received ${bytes.subarray(0, 16).toString("hex")}`);
  return bytes;
}

async function inspectArchive(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, bytes: Buffer) {
  const response = await app.inject({ method: "POST", url: "/api/data-transfer/inspect", headers: { ...headers, "content-type": "application/octet-stream" }, payload: bytes });
  return response;
}

async function countGroups(db: AsyncDatabase): Promise<number> {
  return Number((await db.prepare("SELECT count(*) AS n FROM catalog_groups").get() as { n: number }).n);
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("PostgreSQL data-transfer export and inspect are authenticated, read-only, and report archive metadata", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "transfer-source-admin");
    await addGroup(sourceApp.db, "source-group", "Источник 7А");
    const targetApp = await startApp(target, root);
    const targetAuth = await startAdmin(targetApp.app, "transfer-target-admin");
    await addGroup(targetApp.db, "target-group", "Приёмник 8Б");

    assert.equal((await sourceApp.app.inject({ url: "/api/data-transfer" })).statusCode, 401);
    assert.deepEqual((await sourceApp.app.inject({ url: "/api/data-transfer", headers: sourceAuth.headers })).json(), { supported: true });
    assert.equal((await sourceApp.app.inject({ method: "POST", url: "/api/data-transfer/export" })).statusCode, 401);
    assert.equal((await sourceApp.app.inject({ method: "POST", url: "/api/data-transfer/export", headers: { ...sourceAuth.headers, "x-csrf-token": "wrong" } })).statusCode, 403);
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    assert.ok(bytes.length > 20);

    const before = await countGroups(targetApp.db);
    const unauthenticated = await inspectArchive(targetApp.app, {}, bytes);
    assert.equal(unauthenticated.statusCode, 401);
    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;
    assert.ok(preview.token);
    assert.equal(preview.archive.format, "smena-school-archive");
    assert.equal(preview.archive.formatVersion, 1);
    assert.equal(preview.archive.applicationVersion, "0.1.0");
    assert.equal(preview.archive.postgresMajorVersion, 18);
    assert.ok(preview.archive.schemaVersions.length);
    assert.equal(preview.archive.counts.groups, 1);
    assert.equal(preview.current.counts.groups, before);
    assert.equal(preview.current.schoolName, "");
    assert.equal(preview.archive.tables.some(table => table.name === "admin_users" || table.name === "sessions"), false);
    assert.equal(await countGroups(targetApp.db), before, "inspection must leave target data unchanged");
  });
});

test("invalid archives and stale previews are rejected without changing the target", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "transfer-invalid-source");
    await addGroup(sourceApp.db, "source-group", "Источник");
    const targetApp = await startApp(target, root);
    const targetAuth = await startAdmin(targetApp.app, "transfer-invalid-target");
    await addGroup(targetApp.db, "target-group", "Данные приёмника");
    const originalCount = await countGroups(targetApp.db);
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);

    const invalidGzip = await inspectArchive(targetApp.app, targetAuth.headers, Buffer.from("not gzip"));
    assert.equal(invalidGzip.statusCode, 400, invalidGzip.body);
    for (const malformed of [gzipSync("not json\n")]) {
      const response = await inspectArchive(targetApp.app, targetAuth.headers, malformed);
      assert.ok(response.statusCode >= 400, response.body);
      assert.equal(await countGroups(targetApp.db), originalCount);
    }
    let archiveText: string;
    try { archiveText = gunzipSync(bytes).toString("utf8"); }
    catch (error) { assert.fail(`export archive is not a complete gzip stream (${bytes.length} bytes, first16=${bytes.subarray(0, 16).toString("hex")}): ${String(error)}`); }
    const lines = archiveText!.trimEnd().split("\n");
    const first = JSON.parse(lines[0]!);
    first.manifest.formatVersion = 999;
    const unsupported = await inspectArchive(targetApp.app, targetAuth.headers, gzipSync(`${JSON.stringify(first)}\n${lines.slice(1).join("\n")}\n`));
    assert.equal(unsupported.statusCode, 400, unsupported.body);
    for (const mutate of [
      (manifest: ArchivePreview["archive"]) => { manifest.schemaVersions = [1, 2, 3]; },
      (manifest: ArchivePreview["archive"]) => { manifest.schemaVersions = [1, 2, 3, 4, 5, 6]; },
      (manifest: ArchivePreview["archive"]) => { manifest.tables.find(table => table.name === "catalog_groups")!.columns.pop(); },
    ]) {
      const changed = JSON.parse(lines[0]!);
      mutate(changed.manifest);
      const incompatible = await inspectArchive(targetApp.app, targetAuth.headers, gzipSync(`${JSON.stringify(changed)}\n${lines.slice(1).join("\n")}\n`));
      assert.equal(incompatible.statusCode, 400, incompatible.body);
      assert.equal(await countGroups(targetApp.db), originalCount);
    }
    const alteredLines = [...lines];
    const end = JSON.parse(alteredLines.at(-1)!);
    end.sha256 = "0".repeat(64);
    alteredLines[alteredLines.length - 1] = JSON.stringify(end);
    const badChecksum = await inspectArchive(targetApp.app, targetAuth.headers, gzipSync(`${alteredLines.join("\n")}\n`));
    assert.equal(badChecksum.statusCode, 400, badChecksum.body);

    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;
    await targetApp.db.prepare("UPDATE draft_metadata SET revision=revision+1 WHERE id=1").run();
    const stale = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(await countGroups(targetApp.db), originalCount);
    const discarded = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/discard", headers: targetAuth.headers, payload: { token: preview.token } });
    assert.equal(discarded.statusCode, 200, discarded.body);
    assert.equal(discarded.json().discarded, true);
  });
});

test("restore replaces school data, preserves the local administrator, rotates sessions, and supports retry/status", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "archive-source-admin");
    await addGroup(sourceApp.db, "source-group", "Группа из архива");
    const targetApp = await startApp(target, root);
    const targetAuth = await startAdmin(targetApp.app, "local-target-admin");
    const secondSession = await startAdmin(targetApp.app, "local-target-admin");
    await addGroup(targetApp.db, "target-group", "Старая локальная группа");
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;

    const missingConfirm = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: false } });
    assert.equal(missingConfirm.statusCode, 400, missingConfirm.body);
    const noCsrf = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: { ...targetAuth.headers, "x-csrf-token": "bad" }, payload: { token: preview.token, confirm: true } });
    assert.equal(noCsrf.statusCode, 403, noCsrf.body);

    const restored = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
    assert.equal(restored.statusCode, 200, restored.body);
    const result = restored.json() as ArchiveRestoreResult;
    assert.equal(result.restored, true);
    assert.match(result.backupFilename, /\.smena\.gz$/);
    assert.equal(result.counts.groups, 1);
    assert.equal(await countGroups(targetApp.db), 1);
    assert.deepEqual(await targetApp.db.prepare("SELECT id,name FROM catalog_groups").all(), [{ id: "source-group", name: "Группа из архива" }]);

    const lostResponseStatus = await targetApp.app.inject({ url: `/api/data-transfer/status/${preview.token}`, headers: { cookie: targetAuth.cookie, origin, host: "127.0.0.1" } });
    assert.equal(lostResponseStatus.statusCode, 200, lostResponseStatus.body);
    assert.equal(lostResponseStatus.json().state, "complete");
    const newCookie = String(lostResponseStatus.headers["set-cookie"]).split(";")[0]!;
    assert.ok(newCookie);
    const newAuthStatus = await targetApp.app.inject({ url: "/api/auth/status", headers: { cookie: newCookie } });
    assert.equal(newAuthStatus.statusCode, 200, newAuthStatus.body);
    const csrfToken = newAuthStatus.json().csrfToken as string;
    assert.ok(csrfToken);
    assert.equal((await targetApp.app.inject({ url: "/api/state", headers: { cookie: newCookie } })).statusCode, 200);
    assert.equal((await targetApp.app.inject({ url: "/api/state", headers: { cookie: targetAuth.cookie } })).statusCode, 401);
    assert.equal((await targetApp.app.inject({ url: "/api/state", headers: { cookie: secondSession.cookie } })).statusCode, 401);
    const staleCsrf = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/discard", headers: { cookie: newCookie, origin, host: "127.0.0.1", "x-csrf-token": targetAuth.csrfToken }, payload: { token: preview.token } });
    assert.equal(staleCsrf.statusCode, 403);

    const status = await targetApp.app.inject({ url: `/api/data-transfer/status/${preview.token}`, headers: { cookie: newCookie } });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().state, "complete");
    assert.deepEqual(status.json().result, result);
    const retryHeaders = { cookie: newCookie, origin, host: "127.0.0.1", "x-csrf-token": csrfToken };
    const retry = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: retryHeaders, payload: { token: preview.token, confirm: true } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), restored.json());
    const backupDirectory = join(root, "backups");
    const backups = readdirSync(backupDirectory);
    assert.equal(backups.length, 1, "retry should not create a second backup");
    assert.equal(statSync(join(backupDirectory, backups[0]!)).mode & 0o777, 0o600);

    await targetApp.app.close();
    apps.splice(apps.indexOf(targetApp.app), 1);
    const restarted = await startApp(target, root);
    const login = await restarted.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "local-target-admin", password: adminPassword } });
    assert.equal(login.statusCode, 200, login.body);
    const restartedCookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const restartedHeaders = { cookie: restartedCookie, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
    const durableStatus = await restarted.app.inject({ url: `/api/data-transfer/status/${preview.token}`, headers: restartedHeaders });
    assert.equal(durableStatus.statusCode, 200, durableStatus.body);
    assert.equal(durableStatus.json().state, "complete");
    assert.deepEqual(durableStatus.json().result, result);
    const durableRetry = await restarted.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: restartedHeaders, payload: { token: preview.token, confirm: true } });
    assert.equal(durableRetry.statusCode, 200, durableRetry.body);
    assert.deepEqual(durableRetry.json(), result);
    assert.equal(await countGroups(restarted.db), 1);
    assert.equal(readdirSync(backupDirectory).length, 1, "durable receipt retry must not create another backup");
  });
});

test("publication print metadata restores current and v4 archives from exact snapshots and clears warm caches", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "print-source-admin");
    const targetApp = await startApp(target, root);
    let targetAuth = await startAdmin(targetApp.app, "print-target-admin");
    const quarter = { id: "print-quarter", name: "Опубликованная четверть", startDate: "2026-09-01", endDate: "2026-10-23" };
    for (const { db } of [sourceApp, targetApp]) {
      await db.prepare("INSERT INTO quarters(id,name,start_date,end_date) VALUES(?,?,?,?)").run(quarter.id, quarter.name, quarter.startDate, quarter.endDate);
      await addGroup(db, "print-group", "Текущее название класса");
    }
    const state = (await sourceApp.app.inject({ url: "/api/state", headers: sourceAuth.headers })).json() as StateResponse;
    const snapshot = createPublicationSnapshot(state, quarter.id);
    snapshot.catalog.groups[0]!.name = "Название класса в снимке";
    snapshot.catalog.groups.push({ ...snapshot.catalog.groups[0]!, id: "archived-print-group", name: "Архивный класс", archived: true });
    const snapshotJson = JSON.stringify(snapshot);
    const compact = JSON.stringify(createPublicationPrintIndex(snapshot));
    const put = async (db: AsyncDatabase, json: string, metadata: string) => db.prepare(`
      INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json)
      VALUES(?,7,'2026-10-18T00:00:00.000Z',0,'publisher',?,'{}',?) ON CONFLICT(quarter_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,print_index_json=excluded.print_index_json
    `).run(quarter.id, json, metadata);
    // Even current archives must derive metadata from snapshot, not trust a
    // stale or forged compact payload supplied alongside it.
    await put(sourceApp.db, snapshotJson, JSON.stringify({ ...createPublicationPrintIndex(snapshot), groups: [] }));
    const currentBytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    const adminBefore = await targetApp.db.prepare("SELECT * FROM admin_users").all();

    const legacyLines = gunzipSync(currentBytes).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const manifest = legacyLines[0].manifest;
    assert.deepEqual(manifest.schemaVersions, [1, 2, 3, 4, 5]);
    manifest.schemaVersions = [1, 2, 3, 4];
    const table = manifest.tables.find((item: { name: string }) => item.name === "published_quarters");
    const compactColumn = table.columns.indexOf("print_index_json");
    assert.ok(compactColumn >= 0);
    table.columns.splice(compactColumn, 1);
    for (const line of legacyLines) if (line.type === "row" && line.table === "published_quarters") line.values.splice(compactColumn, 1);
    const content = legacyLines.slice(0, -1).map(line => `${JSON.stringify(line)}\n`).join("");
    const legacyBytes = gzipSync(content + JSON.stringify({ type: "end", sha256: createHash("sha256").update(content).digest("hex") }) + "\n");

    for (const [label, bytes] of [["current", currentBytes], ["legacy-v4", legacyBytes]] as const) {
      const other = structuredClone(snapshot);
      other.catalog.groups[0]!.name = `Локальный снимок ${label}`;
      await put(targetApp.db, JSON.stringify(other), JSON.stringify(createPublicationPrintIndex(other)));
      const warm = await targetApp.app.inject({ url: "/api/schedule-print/index", headers: targetAuth.headers });
      assert.equal(warm.statusCode, 200, warm.body);
      assert.equal(warm.json().published[0].groups[0].name, `Локальный снимок ${label}`);
      const preview = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
      assert.equal(preview.statusCode, 200, `${label}: ${preview.body}`);
      const restored = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.json().token, confirm: true } });
      assert.equal(restored.statusCode, 200, `${label}: ${restored.body}`);
      targetAuth = await startAdmin(targetApp.app, "print-target-admin");
      assert.deepEqual(await targetApp.db.prepare("SELECT snapshot_json,print_index_json FROM published_quarters").all(), [{ snapshot_json: snapshotJson, print_index_json: compact }]);
      assert.deepEqual(await targetApp.db.prepare("SELECT * FROM admin_users").all(), adminBefore, "local administrator is unchanged");
      const printed = await targetApp.app.inject({ url: "/api/schedule-print/index", headers: targetAuth.headers });
      assert.equal(printed.statusCode, 200, printed.body);
      assert.deepEqual(printed.json().published[0].groups, createPublicationPrintIndex(snapshot).groups);
      assert.equal(printed.json().published[0].publication.version, 7);
      assert.equal(printed.json().draft[0].groups[0].name, "Текущее название класса");
    }
  });
});

test("failed restore rolls back target rows and leaves its safety archive available", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "rollback-source-admin");
    await addGroup(sourceApp.db, "source-group", "Источник для отката");
    let fail = true;
    const targetApp = await startApp(target, root, { archiveBeforeWrite: async () => {
      if (fail) { fail = false; throw new Error("injected restore failure after target deletes"); }
    } });
    const targetAuth = await startAdmin(targetApp.app, "rollback-target-admin");
    await addGroup(targetApp.db, "target-group", "Данные для сохранения");
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;
    const failedRestore = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
    assert.equal(failedRestore.statusCode, 503, failedRestore.body);
    assert.equal(await countGroups(targetApp.db), 1);
    assert.deepEqual(await targetApp.db.prepare("SELECT id,name FROM catalog_groups").all(), [{ id: "target-group", name: "Данные для сохранения" }]);
    const backups = readdirSync(join(root, "backups"));
    assert.equal(backups.length, 1);
    const backupPath = join(root, "backups", backups[0]!);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const savedBackup = await inspectArchive(targetApp.app, targetAuth.headers, readFileSync(backupPath));
    assert.equal(savedBackup.statusCode, 200, savedBackup.body);
    assert.equal((savedBackup.json() as ArchivePreview).archive.counts.groups, 1, "the retained safety archive can be inspected");
  });
});

test("restore refuses to start while a generation job is queued or running", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "generation-guard-source");
    await addGroup(sourceApp.db, "source-group", "Группа в архиве");
    const targetApp = await startApp(target, root);
    const targetAuth = await startAdmin(targetApp.app, "generation-guard-target");
    await addGroup(targetApp.db, "target-group", "Локальная группа");
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);

    for (const status of ["queued", "running"]) {
      const id = `transfer-guard-${status}`;
      await targetApp.db.prepare(`INSERT INTO generation_jobs
        (id,owner_username,status,revision,quarter_id,group_ids_json,options_json,progress_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, targetAuth.username, status, 0, "test-quarter", "[]", "{}", "{}", new Date().toISOString(), new Date().toISOString());
      const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
      assert.equal(previewResponse.statusCode, 200, previewResponse.body);
      const preview = previewResponse.json() as ArchivePreview;
      const response = await targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
      assert.equal(response.statusCode, 409, `${status} job must block restore: ${response.body}`);
      assert.equal(await countGroups(targetApp.db), 1);
      await targetApp.db.prepare("DELETE FROM generation_jobs WHERE id=?").run(id);
    }
    assert.equal(existsSync(join(root, "backups")), false, "rejected restores should not create a safety backup");
  });
});

test("maintenance gate blocks school requests during restore while status remains available", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "maintenance-source-admin");
    await addGroup(sourceApp.db, "source-group", "Группа из архива");
    let notifyEntered!: () => void;
    const entered = new Promise<void>(resolve => { notifyEntered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const targetApp = await startApp(target, root, { archiveBeforeWrite: async () => { notifyEntered(); await blocked; } });
    const targetAuth = await startAdmin(targetApp.app, "maintenance-target-admin");
    await addGroup(targetApp.db, "target-group", "Старая локальная группа");
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;

    const restoring = targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
    try {
      await entered;
      const blockedState = await targetApp.app.inject({ url: "/api/state", headers: targetAuth.headers });
      assert.equal(blockedState.statusCode, 503, blockedState.body);
      assert.ok(blockedState.headers["retry-after"]);
      const status = await targetApp.app.inject({ url: `/api/data-transfer/status/${preview.token}`, headers: { cookie: targetAuth.cookie } });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().state, "restoring");
    } finally {
      release();
    }
    const restored = await restoring;
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(await countGroups(targetApp.db), 1);
    assert.deepEqual(await targetApp.db.prepare("SELECT id,name FROM catalog_groups").all(), [{ id: "source-group", name: "Группа из архива" }]);
  });
});

test("aborted HTTP handlers keep the maintenance gate until their asynchronous work finishes", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ source, target }, root) => {
    const sourceApp = await startApp(source, root);
    const sourceAuth = await startAdmin(sourceApp.app, "aborted-handler-source");
    await addGroup(sourceApp.db, "source-group", "Группа из архива");
    let notifyBeforeWrite!: () => void;
    const beforeWriteEntered = new Promise<void>(resolve => { notifyBeforeWrite = resolve; });
    let beforeWriteStarted = false;
    const targetApp = await startApp(target, root, { archiveBeforeWrite: async () => { beforeWriteStarted = true; notifyBeforeWrite(); } });
    let notifyHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>(resolve => { notifyHandlerStarted = resolve; });
    let notifyHandlerFinished!: () => void;
    const handlerFinished = new Promise<void>(resolve => { notifyHandlerFinished = resolve; });
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>(resolve => { releaseHandler = resolve; });
    targetApp.app.route({ method: "GET", url: "/api/test/held-work", handler: async (_request, reply) => {
      notifyHandlerStarted();
      await handlerRelease;
      notifyHandlerFinished();
      return reply.send({ finished: true });
    } });

    const targetAuth = await startAdmin(targetApp.app, "aborted-handler-target");
    await addGroup(targetApp.db, "target-group", "Школа приёмника");
    const bytes = await exportArchive(sourceApp.app, sourceAuth.headers);
    const previewResponse = await inspectArchive(targetApp.app, targetAuth.headers, bytes);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json() as ArchivePreview;

    const base = await targetApp.app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const heldRequest = fetch(new URL("/api/test/held-work", base), { signal: controller.signal });
    let restoreRequest: Promise<Awaited<ReturnType<typeof targetApp.app.inject>>> | undefined;
    try {
      await handlerStarted;
      controller.abort();
      await heldRequest.catch(() => undefined);

      restoreRequest = targetApp.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: targetAuth.headers, payload: { token: preview.token, confirm: true } });
      let restoreWaiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await targetApp.app.inject({ url: `/api/data-transfer/status/${preview.token}`, headers: { cookie: targetAuth.cookie } });
        assert.equal(status.statusCode, 200, status.body);
        if (status.json().state === "restoring") { restoreWaiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(restoreWaiting, true, "restore should enter its gate while the aborted handler is still active");
      const earlyCallback = await Promise.race([beforeWriteEntered.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150))]);
      assert.equal(earlyCallback, false, "the database replacement must wait for the aborted handler to finish");

      releaseHandler();
      await handlerFinished;
      await beforeWriteEntered;
      const restored = await restoreRequest;
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(beforeWriteStarted, true);
      assert.deepEqual(await targetApp.db.prepare("SELECT id,name FROM catalog_groups").all(), [{ id: "source-group", name: "Группа из архива" }]);
    } finally {
      releaseHandler();
      controller.abort();
      await heldRequest.catch(() => undefined);
      if (restoreRequest) await restoreRequest.catch(() => undefined);
      await targetApp.app.close();
      apps.splice(apps.indexOf(targetApp.app), 1);
    }
  });
});

test("failed streaming export removes its partial file and preserves an existing destination", { skip: skipReason }, async () => {
  await withOwnedSchemas(async ({ target }, root) => {
    const targetApp = await startApp(target, root);
    const service = new SchoolArchiveService(target, { backupDirectory: join(root, "service-backups") });
    const clientPool = new Pool({ connectionString: target, max: 1, application_name: "smena-export-error-test" });
    const client = await clientPool.connect();
    try {
      const partialPath = join(root, "partial-export.smena.gz");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const realQuery = client.query.bind(client);
      const failingClient = new Proxy(client, {
        get(targetClient, property, receiver) {
          if (property === "query") return async (query: unknown, ...args: unknown[]) => {
            if (typeof query === "string" && /^FETCH\b/i.test(query)) throw new Error("forced cursor read failure");
            return await (realQuery as (...queryArgs: unknown[]) => Promise<unknown>)(query, ...args);
          };
          return Reflect.get(targetClient, property, receiver);
        },
      });
      await assert.rejects(service.exportArchive(partialPath, failingClient as typeof client));
      await client.query("ROLLBACK");
      assert.equal(existsSync(partialPath), false, "a failed stream must leave no partial archive at its destination");

      const existingPath = join(root, "existing-export.smena.gz");
      const existingBytes = Buffer.from("keep existing archive destination");
      writeFileSync(existingPath, existingBytes);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assert.rejects(service.exportArchive(existingPath, client));
      await client.query("ROLLBACK");
      assert.deepEqual(readFileSync(existingPath), existingBytes, "EEXIST must not overwrite a pre-existing destination");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await clientPool.end();
      await service.close();
      await targetApp.app.close();
      apps.splice(apps.indexOf(targetApp.app), 1);
    }
  });
});
