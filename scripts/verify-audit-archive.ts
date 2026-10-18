import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { Client } from "pg";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../server/app.ts";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";

// This runner intentionally replaces school data. It can run only in the
// dedicated disposable archive clone, after the performance runs are complete.
const databaseUrl = process.env.SMENA_DATABASE_URL;
assert.ok(databaseUrl, "Use the isolated archive clone env file");
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/smena_pg_verify");
assert.equal(url.searchParams.get("options"), "-c search_path=qa_fixes_20261018_archive");
const artifactDirectory = resolve("artifacts/audit-fixes-20261018");
const output = resolve(process.argv[2] ?? `${artifactDirectory}/p2-4-archive.json`);
assert.equal(resolve(output, ".."), artifactDirectory);
assert.match(basename(output), /^p2-4-archive[\w.-]*\.json$/);
mkdirSync(artifactDirectory, { recursive: true });
const currentPath = `${artifactDirectory}/p2-4-current.smena.gz`;
const legacyPath = `${artifactDirectory}/p2-4-legacy-v4.smena.gz`;

async function makeLegacyArchive(): Promise<number> {
  const source = createReadStream(currentPath);
  const input = createGunzip();
  source.on("error", error => input.destroy(error));
  source.pipe(input);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const gzip = createGzip({ level: 6 });
  const pump = pipeline(gzip, createWriteStream(legacyPath, { mode: 0o600 }));
  void pump.catch(() => {});
  const hash = createHash("sha256");
  let compactColumn = -1;
  let publications = 0;
  let endSeen = false;
  const write = async (line: string, hashed: boolean) => {
    const bytes = Buffer.from(`${line}\n`);
    if (hashed) hash.update(bytes);
    if (!gzip.write(bytes)) await Promise.race([once(gzip, "drain"), pump]);
  };
  try {
    for await (const line of lines) {
      assert.equal(endSeen, false);
      if (compactColumn < 0) {
        const item = JSON.parse(line);
        assert.equal(item.type, "manifest");
        assert.deepEqual(item.manifest.schemaVersions, [1, 2, 3, 4, 5]);
        item.manifest.schemaVersions = [1, 2, 3, 4];
        const table = item.manifest.tables.find((entry: { name: string }) => entry.name === "published_quarters");
        compactColumn = table.columns.indexOf("print_index_json");
        assert.equal(compactColumn, table.columns.length - 1);
        assert.ok(compactColumn > 0);
        table.columns.splice(compactColumn, 1);
        await write(JSON.stringify(item), true);
      } else if (line.startsWith('{"type":"row","table":"published_quarters",')) {
        const item = JSON.parse(line);
        item.values.splice(compactColumn, 1);
        publications++;
        await write(JSON.stringify(item), true);
      } else if (line.startsWith('{"type":"end",')) {
        endSeen = true;
        await write(JSON.stringify({ type: "end", sha256: hash.digest("hex") }), false);
      } else await write(line, true);
    }
    assert.equal(endSeen, true);
    gzip.end();
    await pump;
    return publications;
  } catch (error) {
    gzip.destroy();
    await pump.catch(() => {});
    throw error;
  } finally { lines.close(); source.destroy(); input.destroy(); }
}

const client = new Client({ connectionString: databaseUrl, application_name: "smena-audit-archive-runner" });
await client.connect();
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const origin = "http://127.0.0.1";
const start = () => buildApp({ databaseUrl, archiveBackupDirectory: `${artifactDirectory}/archive-safety-backups` });
const login = async () => {
  const response = await app!.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: {
    username: process.env.AUDIT_LOGIN ?? "qa-audit", password: process.env.AUDIT_PASSWORD ?? "Audit-only-2026!",
  } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: String(response.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string };
};
const tableHashes = async () => {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
    const hashes: Record<string, { count: number; hash: string }> = {};
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
      hashes[tablename] = (await client.query(`SELECT count(*)::int count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) hash FROM "${tablename}" t`)).rows[0];
    }
    const publicationColumnsHash = (await client.query(`SELECT md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY quarter_id)) hash
      FROM (SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters) t`)).rows[0].hash;
    return { hashes, publicationColumnsHash };
  } finally { await client.query("COMMIT"); }
};

try {
  app = await start();
  let headers = await login();
  const index = await app.inject({ url: "/api/schedule-print/index", headers });
  assert.equal(index.statusCode, 200, index.body);
  assert.equal(index.json().revision, 477, "archive runner requires the pristine current source snapshot, before QA scenario edits");
  const indexBody = index.body;
  const target = index.json().published.find((quarter: { groups: unknown[] }) => quarter.groups.length);
  assert.ok(target, "clone must have published groups");
  const baseline = await tableHashes();
  assert.equal(baseline.hashes.lessons!.count, 181329);
  assert.equal(baseline.hashes.catalog_groups!.count, 74);
  assert.equal(baseline.hashes.published_quarters!.count, 10);
  const exported = await app.inject({ method: "POST", url: "/api/data-transfer/export", headers });
  assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
  writeFileSync(currentPath, exported.rawPayload, { mode: 0o600 });
  const transformedPublications = await makeLegacyArchive();
  assert.equal(transformedPublications, baseline.hashes.published_quarters!.count);
  const results: unknown[] = [];
  for (const [format, path] of [["current-v5", currentPath], ["legacy-v4", legacyPath]]) {
    const original = (await client.query("SELECT version,published_at,print_index_json FROM published_quarters WHERE quarter_id=$1", [target.id])).rows[0];
    const alteredIndex = JSON.parse(original.print_index_json);
    alteredIndex.groups[0].name = `QA CACHE PROBE ${format}`;
    await client.query("UPDATE published_quarters SET print_index_json=$1 WHERE quarter_id=$2", [JSON.stringify(alteredIndex), target.id]);
    const warm: LightMyRequestResponse = await app.inject({ url: "/api/schedule-print/index", headers });
    assert.equal(warm.statusCode, 200, warm.body);
    assert.ok(warm.body.includes(`QA CACHE PROBE ${format}`), "target cache must contain deliberately different derived metadata");
    const inspectionStarted = performance.now();
    const preview: LightMyRequestResponse = await app.inject({ method: "POST", url: "/api/data-transfer/inspect", headers: { ...headers, "content-type": "application/octet-stream" }, payload: readFileSync(path) });
    const inspectMs = performance.now() - inspectionStarted;
    assert.equal(preview.statusCode, 200, `${format}: ${preview.body}`);
    const restoreStarted = performance.now();
    const restored: LightMyRequestResponse = await app.inject({ method: "POST", url: "/api/data-transfer/restore", headers, payload: { token: preview.json().token, confirm: true } });
    const restoreMs = performance.now() - restoreStarted;
    assert.equal(restored.statusCode, 200, `${format}: ${restored.body}`);
    headers = await login();
    const after = await tableHashes();
    const changedTables = Object.keys(baseline.hashes).filter(table => JSON.stringify(baseline.hashes[table]) !== JSON.stringify(after.hashes[table]));
    assert.ok(changedTables.every(table => table === "sessions" || table === "data_transfer_receipts"), `unexpected changes after ${format}: ${changedTables.join(",")}`);
    assert.equal(after.publicationColumnsHash, baseline.publicationColumnsHash);
    assert.deepEqual(after.hashes.admin_users, baseline.hashes.admin_users);
    const rows = (await client.query("SELECT snapshot_json,print_index_json FROM published_quarters ORDER BY quarter_id")).rows;
    for (const row of rows) assert.deepEqual(JSON.parse(row.print_index_json), createPublicationPrintIndex(JSON.parse(row.snapshot_json) as PublicationSnapshot));
    const unchangedVersion = (await client.query("SELECT version,published_at FROM published_quarters WHERE quarter_id=$1", [target.id])).rows[0];
    assert.deepEqual(unchangedVersion, { version: original.version, published_at: original.published_at });
    const afterIndex: LightMyRequestResponse = await app.inject({ url: "/api/schedule-print/index", headers });
    assert.equal(afterIndex.statusCode, 200, afterIndex.body);
    assert.equal(afterIndex.body, indexBody, "warm process cache must match restored publication exactly");
    await app.close();
    app = await start();
    headers = await login();
    const coldIndex = await app.inject({ url: "/api/schedule-print/index", headers });
    assert.equal(coldIndex.statusCode, 200, coldIndex.body);
    assert.equal(coldIndex.body, indexBody, "cold process index must match full school archive baseline exactly");
    results.push({ format, archiveBytes: statSync(path).size, inspectMs, restoreMs, tablesChecked: Object.keys(baseline.hashes).length,
      changedTables, publicationCount: rows.length, originalPublicationColumnsPreserved: true, compactIndexCanonical: true,
      adminPreserved: true, samePublicationVersionAndTimestamp: true, cacheInvalidated: true, coldIndexByteIdentical: true });
  }
  const result = { at: new Date().toISOString(), schema: "qa_fixes_20261018_archive", indexBytes: Buffer.byteLength(indexBody),
    baselineTableHashes: baseline.hashes, originalPublicationColumnsHash: baseline.publicationColumnsHash, results };
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, indexBytes: result.indexBytes, results }));
} finally { await app?.close(); await client.end(); }
