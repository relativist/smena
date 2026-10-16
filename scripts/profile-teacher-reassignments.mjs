// Diagnostic only: copies the database and instruments a temporary source snapshot.
// Usage: node scripts/profile-teacher-reassignments.mjs --db COPY.sqlite --out /tmp/EMPTY_DIR [--step 8.1.4]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert(args.length === 4 || args.length === 6, "Required: --db COPY.sqlite --out /tmp/EMPTY_DIR [--step 8.1.4]");
const flags = new Map(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]));
assert(flags.has("--db") && flags.has("--out"));
const step = flags.get("--step") ?? "8.1.2";
assert(["8.1.2", "8.1.4"].includes(step));
const source = realpathSync(flags.get("--db"));
const out = resolve(flags.get("--out"));
assert(out.startsWith(`${realpathSync(tmpdir())}/`), "Diagnostic output must be in a temporary directory");
mkdirSync(out, { recursive: true });
assert.equal(readdirSync(out).length, 0, "Output directory must be empty");
const snapshot = join(out, "source");
mkdirSync(snapshot);
for (const dir of ["server", "shared", "src"]) cpSync(join(root, dir), join(snapshot, dir), { recursive: true });
cpSync(join(root, "package.json"), join(snapshot, "package.json"));
symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
const hashes = {};
const wanted = {
  "server/app.ts": new Set(["readCatalog", "readQuarters", "readSchedule", "readStudyPlans", "readReassignmentState", "reassignmentDates", "adminState", "validateSchedule", "roomResolvedSchedule", "persistScheduleDelta", "replaceEditorDays", "replaceSelectedLessons", "locatedLessons", "stableJson", "readTeacherTeachingAssignments", "readTeacherLessonOrigins"]),
  "shared/teacherReassignment.ts": new Set(["locate", "buildUnits", "buildUnitsFromLocated", "createIndex", "requestIndex", "validateTeacherReassignmentRequest", "cloneSchedule", "updateLessons", "updateIndexedLessons", "policyFor", "unitMatchesStream", "unitsForStream", "roomReason", "mainReason", "applyTeacher", "assignPreview", "previewTeacherReassignment"]),
  "shared/teacherConflicts.ts": new Set(["findTeacherConflicts", "newTeacherConflict"]),
  "shared/roomConflicts.ts": new Set(["newRoomConflict"]),
  "shared/roomSuitability.ts": new Set(["roomSuitabilityReason", "newRoomSuitabilityViolation"]),
  "shared/unavailability.ts": new Set(["newUnavailabilityViolation"]),
};
const instrumented = [];
for (const [file, names] of Object.entries(wanted)) {
  const original = readFileSync(join(root, file), "utf8");
  hashes[file] = createHash("sha256").update(original).digest("hex");
  const ast = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body && names.has(node.name?.text)) {
      assert(!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
      const label = `${file}:${node.name.text}`;
      instrumented.push(label);
      edits.push([node.body.getStart(ast) + 1, `\nconst __smenaProfileToken = globalThis.__smenaProfile.enter(${JSON.stringify(label)}); try {\n`]);
      edits.push([node.body.end - 1, "\n} finally { globalThis.__smenaProfile.leave(__smenaProfileToken); }\n"]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let changed = original;
  for (const [at, text] of edits.sort((a, b) => b[0] - a[0])) changed = changed.slice(0, at) + text + changed.slice(at);
  writeFileSync(join(snapshot, file), changed);
}
let active = false, stack = [], functions = new Map(), sql = new Map(), serializations = [];
const profiler = {
  enter(name) {
    if (!active) return undefined;
    const token = { name, start: performance.now(), children: 0 };
    stack.push(token); return token;
  },
  leave(token) {
    if (!token) return;
    assert.equal(stack.pop(), token);
    const ms = performance.now() - token.start;
    const record = functions.get(token.name) ?? { calls: 0, inclusiveMs: 0, exclusiveMs: 0, maxMs: 0 };
    record.calls++; record.inclusiveMs += ms; record.exclusiveMs += ms - token.children; record.maxMs = Math.max(record.maxMs, ms);
    functions.set(token.name, record);
    if (stack.length) stack.at(-1).children += ms;
  },
};
globalThis.__smenaProfile = profiler;
const temp = new Database(":memory:");
const statementPrototype = Object.getPrototypeOf(temp.prepare("SELECT 1")); temp.close();
for (const method of ["all", "get", "run"]) {
  const original = statementPrototype[method];
  statementPrototype[method] = function (...values) {
    if (!active) return original.apply(this, values);
    const sqlText = this.source.replace(/\s+/g, " ").trim().replace(/\?(?:,\?)+/g, "?…");
    const key = `${method}: ${sqlText}`;
    const start = performance.now(), token = profiler.enter(`sqlite.${method}`);
    let rows;
    try { rows = original.apply(this, values); return rows; }
    finally {
      profiler.leave(token);
      const ms = performance.now() - start;
      const r = sql.get(key) ?? { calls: 0, ms: 0, rows: 0, changedRows: 0, maxRows: 0 };
      const count = method === "all" ? rows?.length ?? 0 : method === "get" && rows ? 1 : 0;
      r.calls++; r.ms += ms; r.rows += count; r.maxRows = Math.max(r.maxRows, count); r.changedRows += method === "run" ? rows?.changes ?? 0 : 0;
      sql.set(key, r);
    }
  };
}
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (...values) {
  const token = profiler.enter("sqlite.prepare");
  try { return prepare.apply(this, values); } finally { profiler.leave(token); }
};
const stringify = JSON.stringify;
JSON.stringify = function (...values) {
  if (!active || !values[0] || typeof values[0] !== "object") return stringify.apply(this, values);
  const token = profiler.enter("JSON.stringify.object"), start = performance.now();
  let result;
  try { result = stringify.apply(this, values); return result; }
  finally { profiler.leave(token); if (result?.length > 100_000) serializations.push({ chars: result.length, ms: performance.now() - start }); }
};
const dbPath = join(out, "school.sqlite");
const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
await sourceDb.backup(dbPath); sourceDb.close();
chmodSync(dbPath, 0o600);
const copy = new Database(dbPath);
copy.exec("DELETE FROM sessions; DELETE FROM admin_users;");
const initialRevision = copy.prepare("SELECT revision FROM draft_metadata WHERE id=1").get().revision;
const initialCount = copy.prepare("SELECT COUNT(*) n FROM lessons").get().n;
copy.close();
const { buildApp } = await import(pathToFileURL(join(root, "server/app.ts")));
const { buildApp: buildProfileApp } = await import(pathToFileURL(join(snapshot, "server/app.ts")));
const plain = await buildApp({ dbPath }), profiled = await buildProfileApp({ dbPath });
const apps = [plain, profiled];
try {
  const origin = "http://127.0.0.1";
  const auth = await plain.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "profile-qa", password: randomUUID() } });
  assert.equal(auth.statusCode, 200);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0];
  const headers = { origin, host: "127.0.0.1", cookie, "x-csrf-token": auth.json().csrfToken };
  const cookieValue = cookie.slice(cookie.indexOf("=") + 1);
  writeFileSync(join(out, "browser-state.json"), stringify({ cookies: [{ name: "smena_session", value: cookieValue, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }], origins: [] }), { mode: 0o600 });
  const baseline = JSON.parse(readFileSync(join(root, "docs/teacher-replacements-baseline-2026-10-15.json"), "utf8"));
  const requests = baseline.requests.filter(r => r.request && r.url.includes("/preview"));
  const pick = (name) => {
    const action = baseline.actions.find(a => a.name === name); assert(action, name);
    const r = requests.find(r => r.start >= action.start && r.start <= action.end); assert(r, name); return structuredClone(r.request);
  };
  const cases = ["lesson-common109", "week-row0-teacher110", "period-first-open", "period-common-teacher109", "period-row0-teacher110", "period-row1-teacher111", "period-no-end-common109", "period-no-end-row0-teacher110"].map(name => ({ name, request: pick(name) }));
  const runs = [], responses = new Map();
  function start() { stack = []; functions = new Map(); sql = new Map(); serializations = []; active = true; }
  function finish() {
    active = false; assert.equal(stack.length, 0);
    return { functions: Object.fromEntries(functions), sql: [...sql].map(([query, r]) => ({ query, ...r })).sort((a, b) => b.ms - a.ms), serializations };
  }
  async function request(app, name, requestValue, instrument, url = "/api/teacher-reassignments/preview?response=compact", extra = {}) {
    if (instrument) start();
    const begin = performance.now();
    const response = await app.inject({ method: "POST", url, headers, payload: { revision: initialRevision, request: requestValue, ...extra } });
    const totalMs = performance.now() - begin;
    const counters = instrument ? finish() : undefined;
    assert.equal(response.statusCode, 200, `${name}: ${response.body.slice(0, 200)}`);
    const json = response.json();
    const r = { name, instrumented: instrument, totalMs, responseBytes: Buffer.byteLength(response.body), responseHash: createHash("sha256").update(response.body).digest("hex"), units: json.preview?.units.length, candidates: json.preview?.candidates.length, ...counters };
    runs.push(r); responses.set(`${instrument}:${name}`, json);
    console.log(`${instrument ? "profile" : "plain"} ${name}: ${Math.round(totalMs)} ms`);
    return json;
  }
  for (const c of cases) await request(plain, c.name, c.request, false);
  for (const c of cases) {
    await request(profiled, c.name, c.request, true);
    const a = runs.find(r => !r.instrumented && r.name === c.name), b = runs.at(-1);
    assert.equal(a.responseHash, b.responseHash, `Instrumentation changed ${c.name}`);
    b.equivalentToPlain = true;
  }
  // Real API page loading, measured separately from candidate evaluation.
  start(); const pageStart = performance.now();
  const page = await profiled.inject({ url: "/api/admin/reassignments?quarterId=quarter-2026-1&subjectId=english", headers });
  const pageMs = performance.now() - pageStart, pageMetrics = finish(); assert.equal(page.statusCode, 200);
  runs.push({ name: "page-english-quarter", instrumented: true, totalMs: pageMs, responseBytes: Buffer.byteLength(page.body), ...pageMetrics });
  // CPU sampling is separate: instrumented timers are disabled for this request.
  const inspector = new Session(); inspector.connect();
  const post = (method, params = {}) => new Promise((ok, fail) => inspector.post(method, params, (e, result) => e ? fail(e) : ok(result)));
  await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 1000 }); await post("Profiler.start");
  const cpuStart = performance.now();
  const cpuResponse = await plain.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initialRevision, request: pick("period-no-end-row0-teacher110") } });
  const cpuTotalMs = performance.now() - cpuStart; assert.equal(cpuResponse.statusCode, 200);
  const { profile } = await post("Profiler.stop"); inspector.disconnect();
  writeFileSync(join(out, "row47.cpuprofile"), stringify(profile));
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const sampled = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const n = nodes.get(profile.samples[i]), f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url ? relative(root, fileURLToPath(f.url.startsWith("file:") ? f.url : pathToFileURL(f.url))) : ""}:${f.lineNumber + 1}`;
    sampled.set(key, (sampled.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const cpuSummary = { totalMs: cpuTotalMs, topSelfTime: [...sampled].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([functionLocation, ms]) => ({ functionLocation, ms })) };
  const assign = pick("period-row1-teacher111");
  const proposed = responses.get("true:period-row1-teacher111").preview;
  const expectedUnits = proposed.units.filter(u => u.teacherId && !u.reason).map(u => ({ unitId: u.id, teacherId: u.teacherId }));
  const responseMode = step === "8.1.4" ? "receipt" : "compact";
  const applied = await request(profiled, "apply23", assign, true, `/api/teacher-reassignments/apply?response=${responseMode}`, { requestId: `profile-${randomUUID()}`, expectedUnits });
  const undone = await request(profiled, "undo23", undefined, true, `/api/teacher-reassignments/${applied.operationId}/undo?response=${responseMode}`, { revision: applied.revision ?? applied.state.revision, requestId: `undo-${randomUUID()}` });
  assert.equal(undone.revision ?? undone.state.revision, initialRevision + 2);
  const result = { date: new Date().toISOString(), step, source, dbPath, sourceFileHashes: hashes, instrumentedFunctions: instrumented, initialRevision, initialLessonCount: initialCount, cases, runs, cpuSummary, methodology: { transport: "Fastify.inject, real auth/CSRF/API/database; no TCP overhead", sql: "better-sqlite3 all/get/run native call time including result materialization; bound parameters never logged", functions: "Temporary AST-instrumented source snapshot; inclusive and exclusive times; original application sources unchanged", equivalence: "All eight preview responses hash-equal to uninstrumented requests", caveat: "Timings include probe overhead and JIT/cache differences; percentages describe each measured request, not universal guarantees" } };
  writeFileSync(join(out, "profile.json"), stringify(result, null, 2));
  console.log(`Saved ${join(out, "profile.json")}`);
} finally {
  active = false; await Promise.all(apps.map(app => app.close()));
  for (const [file, hash] of Object.entries(hashes)) assert.equal(createHash("sha256").update(readFileSync(join(root, file))).digest("hex"), hash, `Original changed: ${file}`);
}
