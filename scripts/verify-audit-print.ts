import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { buildApp } from "../server/app.ts";
import type { AsyncDatabase } from "../server/database.ts";

// This runner deliberately accepts only clones made for this audit repair.
const databaseUrl = process.env.SMENA_DATABASE_URL!;
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/smena_pg_verify");
assert.match(url.searchParams.get("options") ?? "", /^-c search_path=qa_fixes_20261018(?:_(?:p1_after|p2_before|p2_after|browser_before|browser_after))?$/);
const mode = process.argv[2];
assert.ok(mode === "contention" || mode === "index");
const output = process.argv[3];
assert.ok(output);
type Metrics = { ms: number; queries: number; rows: number; lockMs: number; snapshotBytes: number; sql: Record<string, number> };
const context = new AsyncLocalStorage<Metrics>();
const measurements = new Map<string, Metrics>();
const original = Client.prototype.query;
// pg's pool uses callback queries; transactions use promise queries.
(Client.prototype as any).query = function (...args: any[]) {
  const m = context.getStore();
  const started = performance.now();
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
  const record = (result: any) => {
    if (!m) return;
    m.queries++;
    m.rows += result?.rowCount ?? 0;
    if (sql.includes("pg_advisory_xact_lock")) m.lockMs += performance.now() - started;
    m.sql[sql.replace(/\s+/g, " ")] = (m.sql[sql.replace(/\s+/g, " ")] ?? 0) + 1;
    for (const row of result?.rows ?? [])
      if (typeof row.snapshot_json === "string") m.snapshotBytes += Buffer.byteLength(row.snapshot_json);
  };
  const callback = args.at(-1);
  if (typeof callback === "function") {
    args[args.length - 1] = (error: unknown, result: any) => { record(result); callback(error, result); };
    return original.apply(this, args as any);
  }
  return (original.apply(this, args as any) as any).then((result: any) => { record(result); return result; });
};
const audit = new Client({ connectionString: databaseUrl });
await audit.connect();
async function integrity() {
  await audit.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const tables = (await audit.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
    const hashes: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z_]+$/);
      hashes[tablename] = (await audit.query(`SELECT count(*)::int count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) hash FROM "${tablename}" t`)).rows[0];
    }
    const originalPublications = (await audit.query(`SELECT md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY quarter_id)) hash
      FROM (SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters) t`)).rows[0].hash;
    return { hashes, originalPublications };
  } finally { await audit.query("COMMIT"); }
}
const beforeMigration = mode === "index" ? await integrity() : undefined;
const startup: Metrics = { ms: 0, queries: 0, rows: 0, lockMs: 0, snapshotBytes: 0, sql: {} };
const startupStarted = performance.now();
const app = await context.run(startup, () => buildApp({ databaseUrl }));
startup.ms = performance.now() - startupStarted;
const afterMigration = beforeMigration ? await integrity() : undefined;
let migrationIntegrity: unknown;
if (beforeMigration && afterMigration) {
  assert.equal(beforeMigration.originalPublications, afterMigration.originalPublications, "all seven original publication columns survive migration byte-for-byte");
  const changedTables = Object.keys(beforeMigration.hashes).filter(table => JSON.stringify(beforeMigration.hashes[table]) !== JSON.stringify(afterMigration.hashes[table]));
  assert.ok(changedTables.every(table => table === "published_quarters" || table === "postgres_schema_migrations"), "migration must preserve every unrelated table");
  migrationIntegrity = { changedTables, originalPublicationColumnsPreserved: true, unrelatedTablesPreserved: true, tablesChecked: Object.keys(beforeMigration.hashes).length };
}
app.addHook("onRequest", (request, _reply, done) => {
  const key = request.headers["x-audit-measurement"] as string;
  const m = measurements.get(key);
  if (m) context.run(m, done); else done();
});
const db = (app as unknown as { smenaDb: AsyncDatabase }).smenaDb;
const origin = "http://127.0.0.1";
let release: (() => void) | undefined;
let writer: Promise<any> | undefined;
const tx = db.transaction.bind(db);
try {
  const auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "qa-audit", password: "Audit-only-2026!" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { origin, host: "127.0.0.1", cookie: String(auth.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": auth.json().csrfToken };
  const call = async (label: string, path: string, payload?: unknown, method: "GET" | "POST" | "PUT" = payload ? "POST" : "GET") => {
    const m: Metrics = { ms: 0, queries: 0, rows: 0, lockMs: 0, snapshotBytes: 0, sql: {} };
    measurements.set(label, m);
    const start = performance.now();
    const response = await app.inject({ method, url: path, headers: { ...headers, "x-audit-measurement": label }, ...(payload ? { payload } : {}) });
    m.ms = performance.now() - start;
    return { ...m, status: response.statusCode, bytes: Buffer.byteLength(response.body), response };
  };
  const summarize = ({ response, ...rest }: Awaited<ReturnType<typeof call>>) => rest;
  const result: any = { mode, at: new Date().toISOString(), schema: url.searchParams.get("options"), startup, ...(migrationIntegrity ? { migrationIntegrity } : {}) };
  if (mode === "index") {
    const cold = await call("cold", "/api/schedule-print/index");
    const warm = await call("warm", "/api/schedule-print/index");
    assert.equal(cold.status, 200, cold.response.body);
    assert.equal(warm.status, 200, warm.response.body);
    assert.deepEqual(cold.response.json(), warm.response.json());
    result.cold = summarize(cold);
    result.warm = summarize(warm);
    const index = cold.response.json();
    result.indexContentSha256 = createHash("sha256").update(JSON.stringify({ published: index.published, draft: index.draft })).digest("hex");
  } else {
    const row = await db.prepare("SELECT quarter_id,version FROM published_quarters WHERE quarter_id='quarter-2026-1'").get();
    assert.ok(row);
    const print = { source: "published", quarterId: row.quarter_id, version: row.version, weekStart: "2026-10-12", groupIds: ["grade-1-А"] };
    const baseline = await call("baseline", "/api/schedule-print/preview", print);
    assert.equal(baseline.status, 200, baseline.response.body);
    const state = (await app.inject({ url: "/api/admin/state?view=catalog", headers })).json();
    const catalog = structuredClone(state.catalog);
    const teacher = catalog.teachers[0];
    teacher.name += " print-contention";
    let acquired!: () => void;
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = true;
    db.transaction = fn => tx(async (...args: any[]) => {
      if (armed) { armed = false; acquired(); await gate; }
      return await fn(...args);
    });
    writer = call("rename", "/api/catalog?response=compact", { catalog, revision: state.revision, requestId: crypto.randomUUID() }, "PUT");
    await entered;
    const timer = setTimeout(() => release!(), 750);
    let during: Awaited<ReturnType<typeof call>>;
    let index: Awaited<ReturnType<typeof call>>;
    try {
      [during, index] = await Promise.all([
        call("during", "/api/schedule-print/preview", print),
        call("index", "/api/schedule-print/index"),
      ]);
    } finally { clearTimeout(timer); release!(); }
    const renamed = await writer;
    assert.equal(renamed.status, 200, renamed.response.body);
    assert.equal(during.status, 200, during.response.body);
    assert.equal(index.status, 200, index.response.body);
    assert.equal(during.response.body, baseline.response.body, "published response stays byte-identical");
    const stale = await call("stale", "/api/schedule-print/preview", { ...print, version: print.version + 1 });
    assert.equal(stale.status, 409);
    result.baseline = summarize(baseline);
    result.rename = summarize(renamed);
    result.during = summarize(during);
    result.index = summarize(index);
    result.controlledWriterHoldMs = 750;
    result.publishedByteIdentical = true;
    result.staleVersionStatus = stale.status;
  }
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ mode, output, ...(mode === "index" ? { cold: { ...result.cold, sql: undefined }, warm: { ...result.warm, sql: undefined } } : { baselineMs: result.baseline.ms, duringMs: result.during.ms, lockMs: result.during.lockMs, byteIdentical: true }) }));
} finally {
  release?.();
  await writer;
  db.transaction = tx;
  await app.close();
  await audit.end();
  Client.prototype.query = original;
}
