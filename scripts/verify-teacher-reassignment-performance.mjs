// Compare the pre-optimization and current reassignment APIs on isolated copies
// of the same school database. Run only after the current source is ready.
// Usage: node scripts/verify-teacher-reassignment-performance.mjs --out /tmp/EMPTY_DIR [--db BASELINE.sqlite] [--before OLD_SOURCE]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = { "--db": "/tmp/smena-replacements-review-20261015-1ekJj8/before-apply.sqlite", "--before": "/tmp/smena-replacements-opt-before" };
const args = process.argv.slice(2);
assert(args.length >= 2 && args.length % 2 === 0, "Required: --out /tmp/EMPTY_DIR [--db BASELINE.sqlite] [--before OLD_SOURCE]");
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert(["--out", "--db", "--before"].includes(args[i]), `Unknown option ${args[i]}`);
  assert(!options.has(args[i]), `Duplicate option ${args[i]}`);
  options.set(args[i], args[i + 1]);
}
assert(options.has("--out"), "Required: --out /tmp/EMPTY_DIR");
const out = resolve(options.get("--out"));
const baselineDb = resolve(options.get("--db") ?? defaults["--db"]);
const oldSource = resolve(options.get("--before") ?? defaults["--before"]);
assert(out.startsWith(`${realpathSync(tmpdir())}/`), "Output must be under /tmp");
mkdirSync(out, { recursive: true });
assert.equal(readdirSync(out).length, 0, "Output directory must be empty");
assert(realpathSync(baselineDb));
assert(realpathSync(oldSource));

const cloneDb = async (path) => {
  const source = new Database(baselineDb, { readonly: true, fileMustExist: true });
  try { await source.backup(path); } finally { source.close(); }
  chmodSync(path, 0o600);
  const db = new Database(path);
  try { db.exec("DELETE FROM sessions; DELETE FROM admin_users;"); }
  finally { db.close(); }
};
const oldDbPath = join(out, "school-old.sqlite");
const newDbPath = join(out, "school-new.sqlite");
await cloneDb(oldDbPath);
await cloneDb(newDbPath);

const baseline = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "docs/teacher-replacements-baseline-2026-10-15.json"), "utf8"));
const requests = baseline.requests.filter((r) => r.request && r.url.includes("/preview"));
const pick = (name) => {
  const action = baseline.actions.find((a) => a.name === name);
  assert(action, `Missing baseline action ${name}`);
  const found = requests.find((r) => r.start >= action.start && r.start <= action.end);
  assert(found, `Missing baseline preview request ${name}`);
  return structuredClone(found.request);
};
const caseNames = ["lesson-common109", "week-row0-teacher110", "period-first-open", "period-common-teacher109", "period-row0-teacher110", "period-row1-teacher111", "period-no-end-common109", "period-no-end-row0-teacher110"];
const cases = caseNames.map((name) => ({ name, request: pick(name) }));

const oldModule = await import(pathToFileURL(join(oldSource, "server/app.ts")));
const newModule = await import(pathToFileURL(join(root, "server/app.ts")));
const oldApp = await oldModule.buildApp({ dbPath: oldDbPath });
const newApp = await newModule.buildApp({ dbPath: newDbPath });
const apps = [oldApp, newApp];
const authFor = async (app, username) => {
  const origin = "http://127.0.0.1";
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username, password: randomUUID() } });
  assert.equal(response.statusCode, 200, response.body.slice(0, 200));
  const cookie = String(response.headers["set-cookie"]).split(";")[0];
  const headers = { origin, host: "127.0.0.1", cookie, "x-csrf-token": response.json().csrfToken };
  return { headers, csrfToken: response.json().csrfToken, cookieValue: cookie.slice(cookie.indexOf("=") + 1) };
};

try {
  const oldAuth = await authFor(oldApp, "reassign-old-qa");
  const newAuth = await authFor(newApp, "reassign-new-qa");
  const newMeta = new Database(newDbPath, { readonly: true });
  const initialRevision = newMeta.prepare("SELECT revision FROM draft_metadata WHERE id=1").get().revision;
  const initialLessons = newMeta.prepare("SELECT COUNT(*) n FROM lessons").get().n;
  newMeta.close();
  const storageState = {
    cookies: [{ name: "smena_session", value: newAuth.cookieValue, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }],
    origins: [{ origin: "http://127.0.0.1:3184", localStorage: [{ name: "smena_csrf", value: newAuth.csrfToken }] }],
  };
  writeFileSync(join(out, "browser-state.json"), JSON.stringify(storageState), { mode: 0o600 });
  chmodSync(join(out, "browser-state.json"), 0o600);

  const measurements = [];
  const jsonResults = new Map();
  const call = async (branch, app, auth, name, url, payload) => {
    const started = performance.now();
    const response = await app.inject({ method: "POST", url, headers: auth.headers, payload });
    const totalMs = performance.now() - started;
    assert.equal(response.statusCode, 200, `${branch}/${name}: HTTP ${response.statusCode} ${response.body.slice(0, 250)}`);
    const body = response.json();
    measurements.push({ branch, name, totalMs, responseBytes: Buffer.byteLength(response.body), responseHash: createHash("sha256").update(response.body).digest("hex") });
    jsonResults.set(`${branch}/${name}`, body);
    return body;
  };
  // Exercise the same common-teacher then per-row sequence users trigger.
  for (const c of cases) {
    const old = await call("old", oldApp, oldAuth, c.name, "/api/teacher-reassignments/preview?response=compact", { revision: initialRevision, request: c.request });
    const current = await call("new", newApp, newAuth, c.name, "/api/teacher-reassignments/preview?response=compact", { revision: initialRevision, request: c.request });
    assert.deepEqual(current, old, `Preview semantics changed: ${c.name}`);
  }
  for (const [branch, app, auth] of [["old", oldApp, oldAuth], ["new", newApp, newAuth]]) {
    const request = cases.find((c) => c.name === "period-row0-teacher110").request;
    const first = await call(branch, app, auth, "identical-request-1", "/api/teacher-reassignments/preview?response=compact", { revision: initialRevision, request });
    const second = await call(branch, app, auth, "identical-request-2", "/api/teacher-reassignments/preview?response=compact", { revision: initialRevision, request });
    assert.deepEqual(second, first);
  }

  const applyCase = cases.find((c) => c.name === "period-row1-teacher111");
  const preview = jsonResults.get(`new/${applyCase.name}`).preview;
  const expectedUnits = preview.units.filter((unit) => unit.teacherId && !unit.reason).map((unit) => ({ unitId: unit.id, teacherId: unit.teacherId }));
  assert(expectedUnits.length > 0, "Apply fixture has no eligible units");
  const selectedIds = new Set(preview.units.filter((unit) => expectedUnits.some((item) => item.unitId === unit.id)).flatMap((unit) => unit.lessonIds));
  const rawSnapshot = (path) => {
    const db = new Database(path, { readonly: true });
    try {
      const snapshot = {};
      for (const table of ["schedule_days", "schedule_slots", "lessons", "teacher_lesson_origins", "teacher_teaching_assignments", "temporary_teacher_replacements"]) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!exists) continue;
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${cols.map((c) => `\"${c}\"`).join(",")}`).all();
      }
      const publicationTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%publication%' OR name LIKE 'published_%') ORDER BY name").all().map((r) => r.name);
      snapshot.publications = {};
      for (const table of publicationTables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        snapshot.publications[table] = db.prepare(`SELECT * FROM \"${table}\" ORDER BY ${cols.map((c) => `\"${c}\"`).join(",")}`).all();
      }
      return snapshot;
    } finally { db.close(); }
  };
  const beforeOld = rawSnapshot(oldDbPath), beforeNew = rawSnapshot(newDbPath);
  assert.deepEqual(beforeNew, beforeOld, "Starting clones differ");
  const canonicalRead = async (branch, app, auth, name) => {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: "/api/admin/reassignments?quarterId=quarter-2026-1&subjectId=english", headers: auth.headers });
    const totalMs = performance.now() - started;
    assert.equal(response.statusCode, 200, `${branch}/${name}: HTTP ${response.statusCode}`);
    measurements.push({ branch, name, totalMs, responseBytes: Buffer.byteLength(response.body), responseHash: createHash("sha256").update(response.body).digest("hex") });
    return response.json();
  };
  const readBeforeOld = await canonicalRead("old", oldApp, oldAuth, "canonical-read-before-apply");
  const readBeforeNew = await canonicalRead("new", newApp, newAuth, "canonical-read-before-apply");
  const withoutReadMetadata = ({ revision: _revision, updatedAt: _updatedAt, ...state }) => state;
  assert.deepEqual(withoutReadMetadata(readBeforeNew), withoutReadMetadata(readBeforeOld), "Initial canonical schedule reads differ");
  const applyIds = { old: `verify-${randomUUID()}`, new: `verify-${randomUUID()}` };
  const oldApply = await call("old", oldApp, oldAuth, "apply", "/api/teacher-reassignments/apply?response=compact", { revision: initialRevision, requestId: applyIds.old, request: applyCase.request, expectedUnits });
  const newApply = await call("new", newApp, newAuth, "apply", "/api/teacher-reassignments/apply?response=receipt", { revision: initialRevision, requestId: applyIds.new, request: applyCase.request, expectedUnits });
  assert.equal(typeof newApply.operationId, "string");
  assert.equal(newApply.revision, initialRevision + 1);
  const afterOld = rawSnapshot(oldDbPath), afterNew = rawSnapshot(newDbPath);
  const beforeLessons = new Map(beforeNew.lessons.map((lesson) => [lesson.id, lesson]));
  const afterLessons = new Map(afterNew.lessons.map((lesson) => [lesson.id, lesson]));
  assert.equal(afterLessons.size, beforeLessons.size, "Apply changed raw lesson count");
  const mutableTeacherFields = new Set(["teacher", "teacher_ref"]);
  for (const [id, before] of beforeLessons) {
    const after = afterLessons.get(id);
    assert(after, `Lesson disappeared during apply: ${id}`);
    if (!selectedIds.has(id)) assert.deepEqual(after, before, `Apply rewrote unrelated raw lesson ${id}`);
    else {
      assert.equal(after.slot_id, before.slot_id, `Apply changed slot ID for selected lesson ${id}`);
      const normalized = { ...after };
      for (const field of mutableTeacherFields) normalized[field] = before[field];
      assert.deepEqual(normalized, before, `Apply changed a non-teacher field for selected lesson ${id}`);
    }
  }
  const readAfterOld = await canonicalRead("old", oldApp, oldAuth, "canonical-read-after-apply");
  const readAfterNew = await canonicalRead("new", newApp, newAuth, "canonical-read-after-apply");
  assert.deepEqual(withoutReadMetadata(readAfterNew), withoutReadMetadata(readAfterOld), "Canonical schedule after apply differs between old and new");
  const flattenLessons = (schedule) => Object.values(schedule).flat().flatMap((day) => day.slots.flat());
  const beforeCanonicalLessons = new Map(flattenLessons(readBeforeNew.schedule).map((lesson) => [lesson.id, lesson]));
  const afterCanonicalLessons = new Map(flattenLessons(readAfterNew.schedule).map((lesson) => [lesson.id, lesson]));
  assert.equal(afterCanonicalLessons.size, beforeCanonicalLessons.size, "Apply changed canonical lesson count");
  assert.deepEqual([...afterCanonicalLessons].filter(([id]) => !selectedIds.has(id)), [...beforeCanonicalLessons].filter(([id]) => !selectedIds.has(id)), "Apply changed unrelated canonical lessons");
  for (const unit of preview.units.filter((item) => expectedUnits.some((entry) => entry.unitId === item.id))) {
    for (const id of unit.lessonIds) assert.equal(afterCanonicalLessons.get(id)?.teacherId, unit.teacherId, `Wrong canonical teacher for ${id}`);
  }
  const publicationsUnchanged = JSON.stringify(afterOld.publications) === JSON.stringify(beforeOld.publications)
    && JSON.stringify(afterNew.publications) === JSON.stringify(beforeNew.publications);
  assert(publicationsUnchanged, "Apply modified published schedule data");

  const replayOld = await call("old", oldApp, oldAuth, "apply-replay", "/api/teacher-reassignments/apply?response=compact", { revision: initialRevision, requestId: applyIds.old, request: applyCase.request, expectedUnits });
  const replayNew = await call("new", newApp, newAuth, "apply-replay", "/api/teacher-reassignments/apply?response=receipt", { revision: initialRevision, requestId: applyIds.new, request: applyCase.request, expectedUnits });
  assert.deepEqual(replayOld, oldApply);
  assert.deepEqual(replayNew, newApply);
  for (const [branch, app, auth] of [["old", oldApp, oldAuth], ["new", newApp, newAuth]]) {
    const stale = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers: auth.headers, payload: { revision: initialRevision, request: applyCase.request } });
    assert.equal(stale.statusCode, 409, `${branch} stale preview status`);
  }

  const undoIds = { old: `undo-${randomUUID()}`, new: `undo-${randomUUID()}` };
  const oldUndo = await call("old", oldApp, oldAuth, "undo", `/api/teacher-reassignments/${oldApply.operationId}/undo?response=compact`, { revision: oldApply.state.revision, requestId: undoIds.old });
  const newUndo = await call("new", newApp, newAuth, "undo", `/api/teacher-reassignments/${newApply.operationId}/undo?response=receipt`, { revision: newApply.revision, requestId: undoIds.new });
  assert.equal(newUndo.revision, initialRevision + 2);
  assert.deepEqual(rawSnapshot(newDbPath), beforeNew, "New undo failed to restore exact selected database rows");
  const readAfterUndoOld = await canonicalRead("old", oldApp, oldAuth, "canonical-read-after-undo");
  const readAfterUndoNew = await canonicalRead("new", newApp, newAuth, "canonical-read-after-undo");
  assert.deepEqual(withoutReadMetadata(readAfterUndoOld), withoutReadMetadata(readBeforeOld), "Old undo failed to restore canonical schedule");
  assert.deepEqual(withoutReadMetadata(readAfterUndoNew), withoutReadMetadata(readBeforeNew), "New undo failed to restore canonical schedule");
  const undoReplayOld = await call("old", oldApp, oldAuth, "undo-replay", `/api/teacher-reassignments/${oldApply.operationId}/undo?response=compact`, { revision: oldApply.state.revision, requestId: undoIds.old });
  const undoReplayNew = await call("new", newApp, newAuth, "undo-replay", `/api/teacher-reassignments/${newApply.operationId}/undo?response=receipt`, { revision: newApply.revision, requestId: undoIds.new });
  assert.deepEqual(undoReplayOld, oldUndo);
  assert.deepEqual(undoReplayNew, newUndo);

  const operationBytes = (path) => {
    const db = new Database(path, { readonly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(teacher_reassignment_operations)").all().map((item) => item.name).filter((name) => name.endsWith("_json"));
      const row = db.prepare("SELECT * FROM teacher_reassignment_operations ORDER BY rowid DESC LIMIT 1").get();
      return Object.fromEntries(columns.map((column) => [column, Buffer.byteLength(row[column] ?? "")]));
    } finally { db.close(); }
  };
  const result = {
    generatedAt: new Date().toISOString(), step: "8.1.4", dataset: { baseline: baseline.dataset.copy, initialRevision, lessonCount: initialLessons },
    cases: caseNames, measurements,
    apply: { selectedUnits: expectedUnits.length, oldResponseBytes: Buffer.byteLength(JSON.stringify(oldApply)), newReceiptBytes: Buffer.byteLength(JSON.stringify(newApply)), oldStoredBytes: operationBytes(oldDbPath), newStoredBytes: operationBytes(newDbPath), canonicalScheduleEqual: true, publishedDataUnchanged: publicationsUnchanged, oldUndoRestoredCanonicalSchedule: true, newUndoRestoredExactRows: true },
    checks: { previewsDeepEqual: true, identicalRequestDeepEqual: true, replayDeepEqual: true, staleRevisionRejected: true },
    method: "Fastify.inject on separate online SQLite backups; same eight captured requests and revision; separate fresh QA auth; high-resolution wall time; JSON byte length; persisted operation column lengths. Timings are one-run observations and should be compared by workload, not treated as guarantees.",
  };
  writeFileSync(join(out, "performance.json"), JSON.stringify(result, null, 2));
  console.log(`Saved ${join(out, "performance.json")}`);
} finally {
  await Promise.all(apps.map((app) => app.close()));
}
