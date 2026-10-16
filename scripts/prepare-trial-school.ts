// Disposable trial school: always creates a new temporary database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "../server/app.ts";
import { weekOffsetFor } from "../shared/plans.ts";

const postgresMode = process.argv.includes("--postgres");
const testDatabaseUrl = postgresMode ? process.env.SMENA_TEST_DATABASE_URL : undefined;
if (postgresMode && !testDatabaseUrl) throw new Error("--postgres требует SMENA_TEST_DATABASE_URL; SMENA_DATABASE_URL не используется");
const root = mkdtempSync(join(tmpdir(), "smena-trial-scale-"));
const dbPath = root + "/school.sqlite";
const schema = postgresMode ? `smena_trial_${process.pid}_${randomUUID().replaceAll("-", "")}` : undefined;
const adminPool = postgresMode ? new Pool({ connectionString: testDatabaseUrl, max: 1, application_name: "smena-trial-school-prepare" }) : undefined;
const databaseUrl = postgresMode ? (() => {
  const url = new URL(testDatabaseUrl!);
  const options = url.searchParams.get("options")?.trim();
  url.searchParams.set("options", `${options ? `${options} ` : ""}-c search_path=${schema},public`);
  return url.toString();
})() : undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let prepared = false;

try {
  if (adminPool && schema) await adminPool.query(`CREATE SCHEMA "${schema}"`);
  app = await buildApp(postgresMode ? { databaseUrl } : { dbPath });
  const password = "trial school qa password";
  const origin = "http://127.0.0.1";
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "trial-admin", password },
  });
  assert.equal(login.statusCode, 200, login.body);

  const headers = {
    origin,
    host: "127.0.0.1",
    cookie: String(login.headers["set-cookie"]).split(";")[0],
    "x-csrf-token": login.json().csrfToken,
  };
  let state = (await app.inject({ url: "/api/state", headers })).json();

  const quarter = {
    id: "trial-scale-quarter",
    name: "Проба · 40 групп",
    startDate: "2030-10-07",
    endDate: "2030-11-01",
  };
  const subjectIds = ["math", "russian", "literature", "history", "english"];
  const letters = Array.from("АБВГДЕЖЗИКЛМНПРСТУФХ");
  const groupIds = Array.from({ length: 40 }, (_, index) => `trial-group-${index}`);
  const groups = groupIds.map((id, index) => ({
    id,
    name: String(index < 20 ? 7 : 8) + letters[index % 20],
    students: 24,
    leaderId: null,
    roomId: `trial-room-${index % 24}`,
    autoRoomIds: [],
    archived: false,
  }));
  const rooms = Array.from({ length: 24 }, (_, index) => ({
    id: `trial-room-${index}`,
    name: String(400 + index),
    kind: "general",
    capacity: 30,
    archived: false,
  }));
  const teachers = Array.from({ length: 10 }, (_, cohort) =>
    subjectIds.map((subjectId, subjectIndex) => ({
      id: `trial-teacher-${cohort}-${subjectIndex}`,
      name: `Тестовый ${cohort} ${subjectIndex}`,
      subjectIds: [subjectId],
      preferredGroupIds: groupIds.slice(cohort * 4, cohort * 4 + 4),
      preferredShift: cohort < 5 ? "morning" : "afternoon",
      defaultRoomId: `trial-room-${(cohort * 5 + subjectIndex) % 24}`,
      archived: false,
    })),
  ).flat();
  const catalog = {
    ...state.catalog,
    groups: [...state.catalog.groups, ...groups],
    rooms: [...state.catalog.rooms, ...rooms],
    teachers: [...state.catalog.teachers, ...teachers],
  };

  let response = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers,
    payload: { catalog, revision: state.revision, requestId: crypto.randomUUID() },
  });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json();

  const plans = groupIds.flatMap((groupId) =>
    subjectIds.map((subjectId) => ({
      id: `trial-plan-${groupId}-${subjectId}`,
      quarterId: quarter.id,
      groupId,
      subjectId,
      mode: "whole",
      lessonKind: "regular",
      assignments: [{
        id: `trial-assignment-${groupId}-${subjectId}`,
        subgroupId: null,
        target: 24,
      }],
    })),
  );
  response = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      quarters: [...state.quarters, quarter],
      studyPlans: [...state.studyPlans, ...plans],
      revision: state.revision,
      requestId: crypto.randomUUID(),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json();

  const schedule = structuredClone(state.schedule);
  for (const [index, groupId] of groupIds.entries()) {
    const first = index < 20 ? 510 : 840;
    for (
      let stamp = Date.parse(quarter.startDate + "T12:00:00Z");
      stamp <= Date.parse(quarter.endDate + "T12:00:00Z");
      stamp += 86400000
    ) {
      const dateValue = new Date(stamp);
      const weekday = dateValue.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;

      const date = dateValue.toISOString().slice(0, 10);
      const breaks = [10, 10, 15, 10, 10, 10];
      let start = first;
      const times = Array.from({ length: 7 }, (_, lessonIndex) => {
        const slot = { start, duration: 45 };
        start += 45 + (breaks[lessonIndex] ?? 0);
        return slot;
      });
      const day = {
        date,
        start:
          (Math.floor(first / 60) + "").padStart(2, "0") +
          ":" +
          String(first % 60).padStart(2, "0"),
        duration: 45,
        breaks,
        times,
        slots: Array.from({ length: 7 }, () => []),
        holiday: false,
      };
      const key = groupId + ":" + weekOffsetFor(date);
      schedule[key] ??= [];
      const oldIndex = schedule[key].findIndex((dayEntry) => dayEntry.date === date);
      if (oldIndex >= 0) schedule[key][oldIndex] = day;
      else schedule[key].push(day);
    }
  }

  response = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: { schedule, revision: state.revision, requestId: crypto.randomUUID() },
  });
  assert.equal(response.statusCode, 200, response.body);
  state = (await app.inject({ url: "/api/state", headers })).json();

  writeFileSync(root + "/baseline.json", JSON.stringify(state), { mode: 0o600 });
  writeFileSync(
    join(root, "context.json"),
    JSON.stringify({ root, ...(postgresMode ? { schema } : { dbPath }), username: "trial-admin", password, quarter, groupIds, expectedLessons: 4800 }, null, 2),
    { mode: 0o600 },
  );
  if (databaseUrl) writeFileSync(join(root, ".env.local"), `SMENA_DATABASE_URL=${databaseUrl}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    root,
    ...(postgresMode ? { schema, envFile: join(root, ".env.local") } : { dbPath }),
    username: "trial-admin",
    password,
    quarter: quarter.name,
    groups: 40,
    teachers: 50,
    rooms: 24,
    expectedLessons: 4800,
  }, null, 2));
  prepared = true;
} finally {
  try { await app?.close(); }
  finally {
    if (!prepared) {
      if (adminPool && schema && /^smena_trial_\d+_[0-9a-f]{32}$/.test(schema))
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      rmSync(root, { recursive: true, force: true });
    }
    await adminPool?.end();
  }
}
