import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { DisplaySettingsResponse } from "../shared/displaySettings.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];
const origin = "http://127.0.0.1";

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "smena-display-settings-"));
  dirs.push(dir);
  return join(dir, "draft.sqlite");
}

async function setup(path = dbPath()) {
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "display settings test password" } });
  if (auth.statusCode !== 200)
    auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "display settings test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  return { app, path, headers, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}

function settings(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  return app.inject({ method: "GET", url: "/api/display-settings", headers });
}

function save(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, payload: any, extraHeaders: Record<string, string> = {}) {
  return app.inject({ method: "PUT", url: "/api/display-settings", headers: { ...headers, ...extraHeaders }, payload });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("display setting flags default independently, persist across restart, and legacy migration does not reset stored preferences", async () => {
  const first = await setup();
  const initial = await settings(first.app, first.headers);
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json(), { settings: { adminSubjectIcons: true, studentSubjectIcons: true, schoolName: "" }, revision: 0 });

  const changed = await save(first.app, first.headers, {
    settings: { adminSubjectIcons: false, studentSubjectIcons: true }, revision: 0, requestId: "display-admin-icons-off",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { settings: { adminSubjectIcons: false, studentSubjectIcons: true, schoolName: "" }, revision: 1 });
  const next = await save(first.app, first.headers, {
    settings: { adminSubjectIcons: false, studentSubjectIcons: false }, revision: 1, requestId: "display-student-icons-off",
  });
  assert.equal(next.statusCode, 200, next.body);
  assert.deepEqual(next.json().settings, { adminSubjectIcons: false, studentSubjectIcons: false, schoolName: "" });

  first.db.exec("DROP TABLE school_display_setting_replays");
  first.db.prepare("DELETE FROM schema_migrations WHERE version=19").run();
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);
  const reopened = await setup(first.path);
  const persisted = await settings(reopened.app, reopened.headers);
  assert.deepEqual(persisted.json(), { settings: { adminSubjectIcons: false, studentSubjectIcons: false, schoolName: "" }, revision: 2 });
});

test("public display setting exposes only student flag, updates without republishing, and stays outside publication cache", async () => {
  const { app, headers, db } = await setup();
  const initialState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const quarter = initialState.quarters[0]!;
  const snapshot = createPublicationSnapshot(initialState, quarter.id);
  const publishedAt = "2026-10-14T00:00:00.000Z";
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json)
    VALUES(?,?,?,?,?,?,?)`).run(quarter.id, 1, publishedAt, initialState.revision, "test", JSON.stringify(snapshot), "{}");

  const publicationBefore = (await app.inject({ url: "/api/public/students" })).json();
  const publicBefore = await app.inject({ url: "/api/public/display-settings" });
  assert.equal(publicBefore.statusCode, 200);
  assert.equal(publicBefore.headers["cache-control"], "no-store");
  assert.deepEqual(publicBefore.json(), { schoolName: "", studentSubjectIcons: true });
  assert.deepEqual(Object.keys(publicBefore.json()).sort(), ["schoolName", "studentSubjectIcons"]);
  assert.equal((await app.inject({ url: "/api/display-settings" })).statusCode, 401);

  const changed = await save(app, headers, {
    settings: { adminSubjectIcons: false, studentSubjectIcons: false, schoolName: "Школа № 7" }, revision: 0, requestId: "display-public-off",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const publicAfter = await app.inject({ url: "/api/public/display-settings" });
  assert.deepEqual(publicAfter.json(), { schoolName: "Школа № 7", studentSubjectIcons: false });
  assert.deepEqual((await app.inject({ url: "/api/public/students" })).json(), publicationBefore);
  assert.deepEqual(db.prepare("SELECT version,published_at,draft_revision,snapshot_json,summary_json FROM published_quarters WHERE quarter_id=?").get(quarter.id), {
    version: 1, published_at: publishedAt, draft_revision: initialState.revision,
    snapshot_json: JSON.stringify(snapshot), summary_json: "{}",
  });
  const currentState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  assert.equal(currentState.revision, initialState.revision);
  assert.deepEqual(currentState.schedule, initialState.schedule);
  assert.deepEqual(currentState.studyPlans, initialState.studyPlans);
});

test("display settings enforce origin, CSRF, strict booleans, stale revision and exact request replay", async () => {
  const { app, headers } = await setup();
  const initial = (await settings(app, headers)).json() as DisplaySettingsResponse;
  const valid = { settings: { adminSubjectIcons: false, studentSubjectIcons: true }, revision: initial.revision, requestId: "display-settings-valid-request" };
  assert.equal((await save(app, { cookie: headers.cookie, origin, host: headers.host }, valid)).statusCode, 403);
  assert.equal((await save(app, headers, valid, { origin: "http://evil.example" })).statusCode, 403);
  assert.equal((await save(app, headers, { ...valid, settings: { adminSubjectIcons: 0, studentSubjectIcons: true }, requestId: "display-settings-bad-boolean" })).statusCode, 400);
  assert.equal((await save(app, headers, { ...valid, settings: { adminSubjectIcons: false }, requestId: "display-settings-missing-boolean" })).statusCode, 400);
  assert.equal((await save(app, headers, { ...valid, requestId: "short" })).statusCode, 400);

  const first = await save(app, headers, valid);
  assert.equal(first.statusCode, 200, first.body);
  const replay = await save(app, headers, valid);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
  assert.equal((await save(app, headers, { ...valid, settings: { adminSubjectIcons: true, studentSubjectIcons: true } })).statusCode, 409);
  const later = await save(app, headers, {
    settings: { adminSubjectIcons: true, studentSubjectIcons: false }, revision: first.json().revision,
    requestId: "display-settings-later-request",
  });
  assert.equal(later.statusCode, 200, later.body);
  const replayAfterLaterSave = await save(app, headers, valid);
  assert.equal(replayAfterLaterSave.statusCode, 200, replayAfterLaterSave.body);
  assert.deepEqual(replayAfterLaterSave.json(), later.json(), "an exact retry returns current preferences without replaying the old value");
  assert.equal((await save(app, headers, { ...valid, requestId: "display-settings-stale-request" })).statusCode, 409);
  const after = await settings(app, headers);
  assert.deepEqual(after.json(), later.json());
});

test("school name is normalized, public, clearable, and preserved by legacy display-settings clients", async () => {
  const { app, headers, db } = await setup();
  const initial = (await settings(app, headers)).json() as DisplaySettingsResponse;
  const named = await save(app, headers, {
    settings: { adminSubjectIcons: true, studentSubjectIcons: false, schoolName: "  Школа № 12  " },
    revision: initial.revision, requestId: "display-school-name-set",
  });
  assert.equal(named.statusCode, 200, named.body);
  assert.equal(named.json().settings.schoolName, "Школа № 12");
  assert.deepEqual((await app.inject({ url: "/api/public/display-settings" })).json(), {
    schoolName: "Школа № 12", studentSubjectIcons: false,
  });

  const legacySettings = { adminSubjectIcons: false, studentSubjectIcons: true };
  const legacyPayload = { settings: legacySettings, revision: named.json().revision, requestId: "legacy-display-settings-request" };
  const legacyFingerprint = createHash("sha256").update(JSON.stringify({
    revision: legacyPayload.revision, settings: legacySettings,
  })).digest("hex");
  db.prepare("INSERT INTO school_display_setting_replays(request_id,fingerprint,response_json) VALUES(?,?,?)")
    .run(legacyPayload.requestId, legacyFingerprint, JSON.stringify({ settings: legacySettings, revision: legacyPayload.revision + 1 }));
  const legacyReplay = await save(app, headers, legacyPayload);
  assert.equal(legacyReplay.statusCode, 200, legacyReplay.body);
  assert.equal(legacyReplay.json().settings.schoolName, "Школа № 12");

  const legacySave = await save(app, headers, {
    settings: legacySettings, revision: legacyReplay.json().revision, requestId: "legacy-display-settings-save",
  });
  assert.equal(legacySave.statusCode, 200, legacySave.body);
  assert.equal(legacySave.json().settings.schoolName, "Школа № 12");
  assert.equal((await save(app, headers, {
    settings: { ...legacySettings, schoolName: "x".repeat(201) }, revision: legacySave.json().revision,
    requestId: "display-school-name-too-long",
  })).statusCode, 400);
  assert.equal((await save(app, headers, {
    settings: { ...legacySettings, schoolName: 12 }, revision: legacySave.json().revision,
    requestId: "display-school-name-wrong-type",
  })).statusCode, 400);

  const cleared = await save(app, headers, {
    settings: { ...legacySettings, schoolName: "   " }, revision: legacySave.json().revision,
    requestId: "display-school-name-clear",
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().settings.schoolName, "");

  db.prepare("UPDATE school_display_settings SET settings_json=? WHERE id=1")
    .run(JSON.stringify({ adminSubjectIcons: false, studentSubjectIcons: true }));
  assert.deepEqual((await settings(app, headers)).json().settings, {
    adminSubjectIcons: false, studentSubjectIcons: true, schoolName: "",
  });
  db.prepare("UPDATE school_display_settings SET settings_json=? WHERE id=1")
    .run(JSON.stringify({ adminSubjectIcons: false, studentSubjectIcons: true, schoolName: 12 }));
  assert.deepEqual((await settings(app, headers)).json().settings, {
    adminSubjectIcons: false, studentSubjectIcons: true, schoolName: "",
  });
});

test("malformed optional display preferences fall back without blocking schedules or mutating the database", async () => {
  const { app, headers, db } = await setup();
  db.prepare("UPDATE school_display_settings SET settings_json=?,revision=? WHERE id=1").run("{invalid json", 7);
  const rawBefore = db.prepare("SELECT settings_json,revision FROM school_display_settings WHERE id=1").get();

  const state = await app.inject({ method: "GET", url: "/api/state", headers });
  assert.equal(state.statusCode, 200, state.body);
  const body = state.json() as StateResponse;
  assert.ok(body.schedule);
  assert.deepEqual(body.displaySettings, { settings: { adminSubjectIcons: true, studentSubjectIcons: true, schoolName: "" }, revision: 7 });

  const publicSettings = await app.inject({ method: "GET", url: "/api/public/display-settings" });
  assert.equal(publicSettings.statusCode, 200, publicSettings.body);
  assert.deepEqual(publicSettings.json(), { schoolName: "", studentSubjectIcons: true });
  assert.deepEqual(db.prepare("SELECT settings_json,revision FROM school_display_settings WHERE id=1").get(), rawBefore);
});
