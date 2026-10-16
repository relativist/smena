import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { defaultBellSettings, type BellSettings } from "../shared/bellSchedule.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";
function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-bell-server-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}
async function setup() {
  const path = dbPath();
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary test password" } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  return {
    app, path,
    headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string },
  };
}
async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}
function update(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, state: StateResponse, settings: BellSettings, requestId: string, apply?: unknown) {
  return app.inject({ method: "PUT", url: "/api/bell-settings", headers, payload: { settings, ...(apply === undefined ? {} : { apply }), revision: state.revision, requestId } });
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("bell settings round-trip without changing any existing lesson intervals", async () => {
  const { app, path, headers } = await setup();
  const before = await state(app, headers);
  const settings = defaultBellSettings();
  settings.school = { start: 525, duration: 40, breaks: [10, 10, 15, 10, 10, 10] };
  const saved = await update(app, headers, before, settings, "bell-settings-save-only-01");
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.deepEqual(after.bellSettings, settings);
  assert.equal(after.revision, before.revision + 1);
  for (const [key, days] of Object.entries(before.schedule)) {
    const afterDays = after.schedule[key];
    assert.equal(afterDays.length, days.length);
    days.forEach((day, index) => assert.deepEqual(afterDays[index].times, day.times));
  }
  const db = new Database(path);
  assert.equal((db.prepare("SELECT version FROM schema_migrations WHERE version=12").get() as { version: number }).version, 12);
  db.close();
});

test("version 12 migration adds profile storage without rewriting lesson times", async () => {
  const { app, path, headers } = await setup();
  const initial = await state(app, headers);
  const db = new Database(path);
  const firstSlot = db.prepare("SELECT s.id FROM schedule_slots s JOIN schedule_days d ON d.id=s.day_id ORDER BY d.date,s.slot_index LIMIT 1").get() as { id: number };
  db.prepare("UPDATE schedule_slots SET start_minute=500 WHERE id=?").run(firstSlot.id);
  db.exec("DROP TABLE bell_settings; ALTER TABLE schedule_days DROP COLUMN bell_profile_json; DELETE FROM schema_migrations WHERE version=12");
  db.close();
  await app.close();
  apps.splice(apps.indexOf(app), 1);

  const upgraded = await buildApp({ dbPath: path });
  apps.push(upgraded);
  const after = await state(upgraded, headers);
  const [key, days] = Object.entries(initial.schedule)[0];
  const date = days[0].date;
  const migrated = after.schedule[key].find((day) => day.date === date)!;
  assert.equal(migrated.times[0].start, 500, "schema migration preserves stored slot intervals");
  assert.deepEqual(migrated.bellProfile, defaultBellSettings().school, "a legacy null profile uses the default bells");
});

test("legacy group overrides are ignored on reads and new days use shared bells", async () => {
  const { app, path, headers } = await setup();
  const before = await state(app, headers);
  const groupId = "5a";
  const settings = defaultBellSettings();
  settings.school = { start: 525, duration: 40, breaks: [8, 8, 12, 8, 8, 8] };
  settings.groups[groupId] = { start: 570, duration: 35, breaks: [2] };
  const saved = await update(app, headers, before, settings, "bell-group-save-only-01");
  assert.equal(saved.statusCode, 200, saved.body);
  const savedState = saved.json() as StateResponse;
  assert.deepEqual(savedState.bellSettings?.groups, {}, "obsolete overrides should not be persisted");
  const db = new Database(path);
  db.prepare("UPDATE bell_settings SET settings_json=? WHERE id=1").run(JSON.stringify(settings));
  db.close();
  const legacyState = await state(app, headers);
  assert.deepEqual(legacyState.bellSettings?.groups, {}, "obsolete stored overrides should be normalized on read");
  const quarters = [...legacyState.quarters, { id: "bell-quarter-test", name: "Тестовая четверть", startDate: "2027-02-01", endDate: "2027-02-26" }];
  const materialized = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: {
    quarters, studyPlans: legacyState.studyPlans, revision: legacyState.revision, requestId: "bell-quarter-create-01",
  } });
  assert.equal(materialized.statusCode, 200, materialized.body);
  const after = materialized.json() as StateResponse;
  const day = after.schedule[`${groupId}:17`]?.[0];
  assert.ok(day, "new quarter should create dates for each active group");
  assert.deepEqual(day.bellProfile, settings.school);
  assert.equal(day.times[0].start, settings.school.start);
  assert.equal(day.times[0].duration, settings.school.duration);
});

test("applying bell profiles changes intervals and supports idempotent retry", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const groupId = "5a";
  const key = `${groupId}:0`;
  const day = before.schedule[key].find((entry) => !entry.holiday)!;
  const settings = defaultBellSettings();
  settings.school = { start: 510, duration: 40, breaks: [10, 10, 15, 10, 10, 10] };
  const apply = { groupIds: [groupId], startDate: day.date, endDate: day.date, replaceStart: true, resetBreaks: true };
  const saved = await update(app, headers, before, settings, "bell-apply-profile-01", apply);
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  const changed = after.schedule[key].find((entry) => entry.date === day.date)!;
  assert.equal(changed.times[0].duration, 40);
  assert.deepEqual(changed.bellProfile, settings.school);
  assert.equal(after.revision, before.revision + 1);
  const replay = await update(app, headers, before, settings, "bell-apply-profile-01", apply);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as StateResponse).revision, after.revision);
});

test("teacher collision while applying bells leaves settings and schedule unchanged", async () => {
  const { app, headers } = await setup();
  const before = await state(app, headers);
  const groupId = "6a";
  const day = before.schedule[`${groupId}:0`].find((entry) => !entry.holiday)!;
  const settings = defaultBellSettings();
  settings.school = { start: 510, duration: 45, breaks: [10, 10, 15, 10, 10, 10] };
  const apply = { groupIds: [groupId], startDate: day.date, endDate: day.date, replaceStart: true, resetBreaks: true };
  const rejected = await update(app, headers, before, settings, "bell-collision-atomic-01", apply);
  assert.equal(rejected.statusCode, 400, rejected.body);
  const after = await state(app, headers);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.bellSettings, before.bellSettings);
  assert.deepEqual(after.schedule[`${groupId}:0`], before.schedule[`${groupId}:0`]);
});
