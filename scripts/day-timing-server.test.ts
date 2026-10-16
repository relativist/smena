import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { DEFAULT_BELL_PROFILE } from "../shared/bellSchedule.ts";
import { previewDayTiming, type DayTimingOptions } from "../shared/dayTiming.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";

async function start(dbPath?: string) {
  let path = dbPath;
  if (!path) {
    const root = mkdtempSync(join(tmpdir(), "smena-day-timing-"));
    roots.push(root);
    path = join(root, "draft.sqlite");
  }
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  return { app, path };
}

async function authenticate(app: Awaited<ReturnType<typeof buildApp>>, first = false) {
  const response = first
    ? await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary timing test password" } })
    : await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary timing test password" } });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  return { cookie, origin, host: "127.0.0.1", "x-csrf-token": response.json().csrfToken as string };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

function save(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, snapshot: StateResponse, requestId: string) {
  return app.inject({ method: "PUT", url: "/api/state", headers, payload: {
    schedule: snapshot.schedule, revision: snapshot.revision, requestId,
  } });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("one-day timing persists selected groups and unchanged days through API restart", async () => {
  const { app, path } = await start();
  const headers = await authenticate(app, true);
  const before = await state(app, headers);
  const activeGroups = before.catalog.groups.filter((group) => !group.archived);
  let chosen: ReturnType<typeof previewDayTiming> | undefined;
  let chosenOptions: DayTimingOptions | undefined;
  let chosenGroupIds: string[] = [];

  // Find a real scheduled date where two groups have independent lessons and
  // the shortened, 15-minute-break preview introduces no existing-resource conflict.
  outer: for (const [key, days] of Object.entries(before.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    if (!activeGroups.some((group) => group.id === groupId)) continue;
    for (const day of days) {
      if (day.holiday || !day.slots.length || day.slots.some((slot) => slot.some((lesson) => lesson.jointId))) continue;
      const peer = activeGroups.find((group) => group.id !== groupId &&
        Object.entries(before.schedule).some(([peerKey, peerDays]) => peerKey.slice(0, peerKey.lastIndexOf(":")) === group.id &&
          peerDays.some((peerDay) => peerDay.date === day.date && peerDay.slots.length > 0 && !peerDay.holiday &&
            !peerDay.slots.some((slot) => slot.some((lesson) => lesson.jointId)))));
      if (!peer) continue;
      const options: DayTimingOptions = {
        date: day.date, groupIds: [groupId, peer.id], currentGroupId: groupId,
        start: day.times[0]?.start ?? DEFAULT_BELL_PROFILE.start,
        duration: 40, uniformBreak: 15, schoolProfile: day.bellProfile ?? DEFAULT_BELL_PROFILE,
      };
      const preview = previewDayTiming(before.schedule, options, before.catalog);
      if (preview.conflict || preview.changedDays.length !== 2) continue;
      chosen = preview;
      chosenOptions = options;
      chosenGroupIds = [groupId, peer.id];
      break outer;
    }
  }
  assert.ok(chosen && chosenOptions, "fixture should contain a conflict-free real date for two groups");
  const expectedSchedule = chosen.schedule;
  const expectedIds = Object.fromEntries(Object.entries(before.schedule).map(([key, days]) => [key,
    days.map((day) => day.slots.flat().map((lesson) => lesson.id).sort()),
  ]));
  const persisted = { ...before, schedule: expectedSchedule };
  const response = await save(app, headers, persisted, "day-timing-save-001");
  assert.equal(response.statusCode, 200, response.body);
  const after = await state(app, headers);
  assert.equal(after.revision, before.revision + 1);
  for (const groupId of chosenGroupIds) {
    const day = Object.values(after.schedule).flat().find((entry) => entry.date === chosenOptions.date &&
      Object.entries(after.schedule).some(([key, entries]) => key.startsWith(`${groupId}:`) && entries.includes(entry)))!;
    assert.ok(day);
    assert.ok(day.times.every((time) => time.duration === 40));
    assert.ok(day.breaks.every((gap) => gap === 15));
  }
  for (const [key, days] of Object.entries(after.schedule)) {
    assert.deepEqual(days.map((day) => day.slots.flat().map((lesson) => lesson.id).sort()), expectedIds[key], `lesson IDs preserved for ${key}`);
    days.forEach((day, index) => {
      if (day.date !== chosenOptions.date || !chosenGroupIds.includes(key.slice(0, key.lastIndexOf(":"))))
        assert.deepEqual(day.times, before.schedule[key][index].times, `unselected date/group unchanged: ${key} ${day.date}`);
    });
  }

  const newApp = await start(path);
  const newHeaders = await authenticate(newApp.app);
  const restarted = await state(newApp.app, newHeaders);
  assert.equal(restarted.revision, after.revision);
  assert.deepEqual(restarted.schedule, after.schedule);
  assert.deepEqual(restarted.bellSettings, after.bellSettings);
});

test("new timing conflict rejected by PUT /api/state leaves the database snapshot untouched", async () => {
  const { app } = await start();
  const headers = await authenticate(app, true);
  const before = await state(app, headers);
  let conflictingSchedule: StateResponse["schedule"] | undefined;

  outer: for (const [key, days] of Object.entries(before.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    if (!before.catalog.groups.some((group) => group.id === groupId && !group.archived)) continue;
    for (const day of days) {
      if (day.holiday || !day.slots.length || day.slots.some((slot) => slot.some((lesson) => lesson.jointId))) continue;
      for (let start = 0; start <= 900; start += 15) {
        const preview = previewDayTiming(before.schedule, {
          date: day.date, groupIds: [groupId], currentGroupId: groupId, start,
          duration: 45, schoolProfile: day.bellProfile ?? DEFAULT_BELL_PROFILE,
        }, before.catalog);
        if (preview.conflict && /^(Кабинет|Преподаватель)/.test(preview.conflict)) {
          conflictingSchedule = preview.schedule;
          break outer;
        }
      }
    }
  }
  assert.ok(conflictingSchedule, "fixture should yield a new room or teacher conflict");
  const rejection = await app.inject({ method: "PUT", url: "/api/state", headers, payload: {
    schedule: conflictingSchedule, revision: before.revision, requestId: "day-timing-conflict-001",
  } });
  assert.equal(rejection.statusCode, 400, rejection.body);
  const after = await state(app, headers);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.schedule, before.schedule);
  assert.deepEqual(after.bellSettings, before.bellSettings);
});
