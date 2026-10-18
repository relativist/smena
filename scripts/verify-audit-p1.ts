import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { buildApp } from "../server/app.ts";

const databaseUrl = process.env.SMENA_DATABASE_URL;
assert.ok(databaseUrl, "Set SMENA_DATABASE_URL to the isolated QA clone URL");
const parsed = new URL(databaseUrl);
assert.equal(parsed.hostname, "127.0.0.1", "database host guard");
assert.equal(parsed.pathname, "/smena_pg_verify", "database name guard");
const schemaMatch = /(?:^|\s)search_path=([a-z0-9_]+)/i.exec(parsed.searchParams.get("options") ?? "");
assert.ok(schemaMatch, "search_path schema guard");
const schema = schemaMatch[1]!;
assert.ok(["qa_fixes_20261018", "qa_fixes_20261018_p1_after"].includes(schema), `unexpected QA schema: ${schema}`);
const origin = "http://127.0.0.1";
const activity = new AsyncLocalStorage<{ queries: number; rows: number; sqlMs: number; advisoryMs: number; advisoryWaitStart?: number } | undefined>();
const measurements = new Map<string, { queries: number; rows: number; sqlMs: number; advisoryMs: number; advisoryWaitStart?: number }>();
const clientPrototype = Client.prototype as unknown as { query: (...args: any[]) => any };
const originalQuery = clientPrototype.query;
clientPrototype.query = function (...args: any[]) {
  const ctx = activity.getStore();
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
  const start = performance.now();
  const callbackIndex = args.findIndex((value) => typeof value === "function");
  if (callbackIndex >= 0) {
    const cb = args[callbackIndex];
    args[callbackIndex] = (error: unknown, result: any) => {
      if (ctx) record(ctx, sql, start, result);
      cb(error, result);
    };
    return originalQuery.apply(this, args);
  }
  return originalQuery.apply(this, args).then((result: any) => {
    if (ctx) record(ctx, sql, start, result);
    return result;
  });
};
function record(ctx: { queries: number; rows: number; sqlMs: number; advisoryMs: number }, sql: string, start: number, result: any) {
    if (ctx) {
      ctx.queries++;
      ctx.rows += result?.rowCount ?? 0;
      ctx.sqlMs += performance.now() - start;
      if (/pg_advisory_xact_lock/i.test(sql)) ctx.advisoryMs += performance.now() - start;
    }
}

const admin = new Pool({ connectionString: databaseUrl, max: 1, application_name: "smena-audit-hash" });
const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map((r: any) => r.tablename as string);
async function hashes() {
  const out: Record<string, { count: number; hash: string }> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    const r = await admin.query(`SELECT count(*)::int count, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)),'')) hash FROM "${table}" t`);
    out[table] = r.rows[0];
  }
  return out;
}
function diff(before: Record<string, any>, after: Record<string, any>) {
  return Object.fromEntries(tables.filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t])).map((t) => [t, { before: before[t], after: after[t] }]));
}

const app = await buildApp({ databaseUrl });
app.addHook("onRequest", (request, _reply, done) => {
  const key = request.headers["x-audit-measurement"];
  activity.run(typeof key === "string" ? measurements.get(key) : undefined, done);
});
try {
  let auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: process.env.AUDIT_LOGIN ?? "qa-audit", password: process.env.AUDIT_PASSWORD ?? "Audit-only-2026!" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const result: any = { database: parsed.pathname.slice(1), schema, createdAt: new Date().toISOString(), operations: {} };
  const op = process.argv[2];
  assert.ok(["p1-1", "p1-2", "p1-2-reset"].includes(op!), "Usage: node scripts/verify-audit-p1.ts p1-1|p1-2|p1-2-reset [output.json] [checks]");

  if (op === "p1-1") {
    const stateResponse = await app.inject({ url: "/api/admin/state?view=catalog", headers });
    assert.equal(stateResponse.statusCode, 200, stateResponse.body);
    const state = stateResponse.json();
    const lessonTeacherIds = new Set((await admin.query("SELECT DISTINCT teacher_ref FROM lessons WHERE teacher_ref IS NOT NULL")).rows.map((r: any) => r.teacher_ref));
    const teacher = state.catalog.teachers.find((t: any) => lessonTeacherIds.has(t.id));
    assert.ok(teacher, "QA snapshot must include a teacher used by lessons");
    const before = await hashes();
    const changed = structuredClone(state.catalog);
    const target = changed.teachers.find((t: any) => t.id === teacher.id);
    target.name = `${target.name} QA rename`;
    const ctx = { queries: 0, rows: 0, sqlMs: 0, advisoryMs: 0 };
    const key = `p1-1-${Date.now()}`; measurements.set(key, ctx);
    const started = performance.now();
    const response = await app.inject({ method: "PUT", url: "/api/catalog?response=compact", headers: { ...headers, "x-audit-measurement": key }, payload: { catalog: changed, revision: state.revision, requestId: `audit-rename-${Date.now()}` } });
    measurements.delete(key);
    const elapsedMs = performance.now() - started;
    assert.equal(response.statusCode, 200, response.body);
    const after = await hashes();
    result.operations[op] = { elapsedMs, ...ctx, targetTeacherId: teacher.id, changes: diff(before, after), responseBytes: Buffer.byteLength(response.body) };
  }

  if (op === "p1-2" || op === "p1-2-reset") {
    const stateResponse = await app.inject({ url: "/api/admin/state?view=plans&quarterId=quarter-2026-1", headers });
    assert.equal(stateResponse.statusCode, 200, stateResponse.body);
    const state = stateResponse.json();
    const quarterId = "quarter-2026-1";
    const curricula = structuredClone(state.curricula);
    const target = curricula.find((c: any) => c.quarterId === quarterId && c.groupIds.length === 9 && c.groupIds.every((id: string) => /^grade-1-/.test(id)) && c.rows.some((r: any) => r.subjectId === "school:visual-arts"));
    assert.ok(target, "expected first-grade, nine-group curriculum with art row");
    const groups = [...target.groupIds].sort();
    const art = target.rows.find((r: any) => r.subjectId === "school:visual-arts");
    const fromHours = art.hours;
    const targetHours = op === "p1-2-reset" ? 8 : 9;
    assert.ok(fromHours === 8 || fromHours === 9, `expected audited 8/9 baseline, found ${fromHours}`);
    const before = await hashes();
    const coverageBeforeResponse = await app.inject({ url: `/api/plan-coverage?quarterId=${quarterId}`, headers });
    assert.equal(coverageBeforeResponse.statusCode, 200, coverageBeforeResponse.body);
    const coverageBefore = coverageBeforeResponse.json().groups.filter((g: any) => groups.includes(g.id));
    assert.deepEqual(coverageBefore.map((g: any) => g.id).sort(), groups, "all nine group coverage rows must exist before save");
    const targetPlanIds = (await admin.query("SELECT id FROM study_plans WHERE quarter_id=$1 AND group_id=ANY($2) AND subject_id='school:visual-arts' ORDER BY id", [quarterId, groups])).rows.map((row: any) => row.id);
    const unaffectedPlansBefore = (await admin.query("SELECT row_to_json(p)::text row FROM study_plans p WHERE NOT (quarter_id=$1 AND group_id=ANY($2) AND subject_id='school:visual-arts') ORDER BY id", [quarterId, groups])).rows;
    const unaffectedAssignmentsBefore = (await admin.query("SELECT row_to_json(a)::text row FROM plan_assignments a WHERE plan_id<>ALL($1::text[]) ORDER BY id", [targetPlanIds])).rows;
    const outsidePlansBefore = (await admin.query("SELECT id,quarter_id,group_id FROM study_plans WHERE quarter_id<>$1 ORDER BY id", [quarterId])).rows;
    const requestId = `audit-hours-${Date.now()}`;
    art.hours = targetHours;
    const ctx = { queries: 0, rows: 0, sqlMs: 0, advisoryMs: 0 };
    const key = `p1-2-${Date.now()}`; measurements.set(key, ctx);
    const started = performance.now();
    const payload = { curricula, scopeQuarterId: quarterId, revision: state.revision, requestId, confirmGroupReplacement: true };
    const response = await app.inject({ method: "PUT", url: "/api/curricula?response=compact", headers: { ...headers, "x-audit-measurement": key }, payload });
    measurements.delete(key);
    const elapsedMs = performance.now() - started;
    assert.equal(response.statusCode, 200, response.body);
    const after = await hashes();
    const outsidePlansAfter = (await admin.query("SELECT id,quarter_id,group_id FROM study_plans WHERE quarter_id<>$1 ORDER BY id", [quarterId])).rows;
    const unaffectedPlansAfter = (await admin.query("SELECT row_to_json(p)::text row FROM study_plans p WHERE NOT (quarter_id=$1 AND group_id=ANY($2) AND subject_id='school:visual-arts') ORDER BY id", [quarterId, groups])).rows;
    const unaffectedAssignmentsAfter = (await admin.query("SELECT row_to_json(a)::text row FROM plan_assignments a WHERE plan_id<>ALL($1::text[]) ORDER BY id", [targetPlanIds])).rows;
    const reloaded = await app.inject({ url: `/api/admin/state?view=plans&quarterId=${quarterId}`, headers });
    assert.equal(reloaded.statusCode, 200, reloaded.body);
    const reloadedTarget = reloaded.json().curricula.find((c: any) => c.id === target.id);
    assert.deepEqual([...reloadedTarget.groupIds].sort(), groups);
    assert.equal(reloadedTarget.rows.find((r: any) => r.id === art.id).hours, targetHours);
    const coverageAfterResponse = await app.inject({ url: `/api/plan-coverage?quarterId=${quarterId}`, headers });
    assert.equal(coverageAfterResponse.statusCode, 200, coverageAfterResponse.body);
    const coverageAfter = coverageAfterResponse.json().groups.filter((g: any) => groups.includes(g.id));
    assert.deepEqual(coverageAfter.map((g: any) => g.id).sort(), groups, "all nine group coverage rows must survive reload");
    const artTargets: Record<string, number> = {};
    for (const groupId of groups) {
      const detail = await app.inject({ url: `/api/plan-coverage/details?quarterId=${quarterId}&groupId=${encodeURIComponent(groupId)}`, headers });
      assert.equal(detail.statusCode, 200, detail.body);
      const artCoverage = detail.json().rows.filter((row: any) => row.subjectId === "school:visual-arts");
      assert.equal(artCoverage.length, 1, `expected one visual-arts target for ${groupId}`);
      assert.equal(artCoverage[0].target, targetHours, `wrong visual-arts target for ${groupId}`);
      artTargets[groupId] = artCoverage[0].target;
    }
    result.operations[op] = { elapsedMs, ...ctx, curriculumId: target.id, groups, groupCoverage: reloadedTarget.groupIds.length, targetPlanCount: targetPlanIds.length, artTargets, previousHours: fromHours, changedHours: targetHours, outsideQuarterPlansPreserved: JSON.stringify(outsidePlansBefore) === JSON.stringify(outsidePlansAfter), unaffectedPlanRowsPreserved: JSON.stringify(unaffectedPlansBefore) === JSON.stringify(unaffectedPlansAfter), unaffectedAssignmentRowsPreserved: JSON.stringify(unaffectedAssignmentsBefore) === JSON.stringify(unaffectedAssignmentsAfter), changes: diff(before, after), responseBytes: Buffer.byteLength(response.body) };
    assert.equal(result.operations[op].outsideQuarterPlansPreserved, true);
    if (process.argv[4] === "checks") {
      assert.equal(result.operations[op].unaffectedPlanRowsPreserved, true);
      assert.equal(result.operations[op].unaffectedAssignmentRowsPreserved, true);
    }
    if (op === "p1-2" && process.argv[4] === "checks") {
      const replay = await app.inject({ method: "PUT", url: "/api/curricula?response=compact", headers, payload });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.body, response.body, "same request ID and payload must replay the identical response");
      const stale = await app.inject({ method: "PUT", url: "/api/curricula?response=compact", headers, payload: { ...payload, requestId: `${requestId}-stale`, revision: state.revision } });
      assert.equal(stale.statusCode, 409, stale.body);
      await admin.query("CREATE FUNCTION audit_reject_revision_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit rollback'; END $$");
      await admin.query("CREATE TRIGGER audit_reject_revision BEFORE UPDATE ON draft_metadata FOR EACH ROW EXECUTE FUNCTION audit_reject_revision_fn()");
      const rollbackBefore = await hashes();
      const rollbackCurricula = structuredClone(curricula);
      const rollbackTarget = rollbackCurricula.find((c: any) => c.id === target.id)!;
      rollbackTarget.rows.find((r: any) => r.id === art.id).hours = fromHours;
      const rollback = await app.inject({ method: "PUT", url: "/api/curricula?response=compact", headers, payload: { ...payload, curricula: rollbackCurricula, requestId: `${requestId}-rollback`, revision: state.revision + 1 } });
      await admin.query("DROP TRIGGER audit_reject_revision ON draft_metadata");
      await admin.query("DROP FUNCTION audit_reject_revision_fn()");
      assert.equal(rollback.statusCode, 500, rollback.body);
      assert.deepEqual(await hashes(), rollbackBefore, "failed transaction must leave every table byte-equivalent");
      result.operations[op].idempotentReplay = true;
      result.operations[op].staleRevisionStatus = stale.statusCode;
      result.operations[op].rollbackStatus = rollback.statusCode;
      result.operations[op].rollbackPreservedAllTables = true;
    }
  }

  const output = process.argv[3];
  if (output) writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
  await admin.end();
  clientPrototype.query = originalQuery;
}
