import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { createSchedule } from "../src/editor.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const ORIGIN = "http://127.0.0.1";

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "smena-api-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}

async function newApp(dbPath = tempDb()) {
  const app = await buildApp({ dbPath });
  apps.push(app);
  return { app, dbPath };
}

async function setup(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin: ORIGIN, host: "127.0.0.1" },
    payload: { username: "admin", password: "correct horse battery" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setupCookie = response.headers["set-cookie"];
  const cookie = (
    Array.isArray(setupCookie) ? setupCookie[0] : setupCookie
  )?.split(";")[0];
  assert.ok(cookie);
  const csrfToken = response.json().csrfToken as string;
  return { cookie, csrfToken };
}

function authHeaders(auth: { cookie: string; csrfToken: string }) {
  return {
    cookie: auth.cookie,
    origin: ORIGIN,
    host: "127.0.0.1",
    "x-csrf-token": auth.csrfToken,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("state requires authentication and mutation requires CSRF", async () => {
  const { app } = await newApp();
  assert.equal((await app.inject("/api/state")).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/state", payload: {} }))
      .statusCode,
    401,
  );
  const auth = await setup(app);
  const state = await app.inject({
    url: "/api/state",
    headers: { cookie: auth.cookie },
  });
  assert.equal(state.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: auth.cookie, origin: ORIGIN, host: "127.0.0.1" },
      })
    ).statusCode,
    403,
  );
});

test("first setup is atomic, password is hashed, and a second setup is denied", async () => {
  const { app } = await newApp();
  const auth = await setup(app);
  const db = (
    app as unknown as {
      smenaDb: {
        prepare: (sql: string) => { get: () => { password_hash: string } };
      };
    }
  ).smenaDb;
  const stored = db.prepare("SELECT password_hash FROM admin_users").get();
  assert.ok(stored.password_hash.startsWith("scrypt$"));
  assert.equal(stored.password_hash.includes("correct horse battery"), false);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: { origin: ORIGIN, host: "127.0.0.1" },
        payload: { username: "second", password: "another secure password" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: { origin: ORIGIN, host: "127.0.0.1" },
        payload: { username: "x", password: "short" },
      })
    ).statusCode,
    400,
  );
  assert.ok(auth.csrfToken);
});

test("login, logout, and revoked session behavior", async () => {
  const { app } = await newApp();
  await setup(app);
  const bad = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, host: "127.0.0.1" },
    payload: { username: "admin", password: "incorrect" },
  });
  assert.equal(bad.statusCode, 401);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, host: "127.0.0.1" },
    payload: { username: "admin", password: "correct horse battery" },
  });
  assert.equal(login.statusCode, 200);
  const loginCookie = login.headers["set-cookie"];
  const auth = {
    cookie: (Array.isArray(loginCookie) ? loginCookie[0] : loginCookie)!.split(
      ";",
    )[0],
    csrfToken: login.json().csrfToken as string,
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: authHeaders(auth),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } }))
      .statusCode,
    401,
  );
});

test("draft round trips through SQLite and survives restart", async () => {
  const dbPath = tempDb();
  const { app } = await newApp(dbPath);
  const auth = await setup(app);
  const initial = (
    await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } })
  ).json();
  assert.equal(initial.revision, 1);
  assert.ok(initial.baseline.length > 0);
  const changed = structuredClone(initial.schedule);
  changed["5a:0"][0].slots[0][0].note = "Сохранённая заметка";
  const payload = {
    schedule: changed,
    revision: initial.revision,
    requestId: "save-roundtrip-001",
  };
  const saved = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers: authHeaders(auth),
    payload,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 2);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await newApp(dbPath);
  const loaded = await reopened.app.inject({
    url: "/api/state",
    headers: { cookie: auth.cookie },
  });
  assert.equal(loaded.statusCode, 200);
  assert.equal(
    loaded.json().schedule["5a:0"][0].slots[0][0].note,
    "Сохранённая заметка",
  );
  assert.equal(loaded.json().revision, 2);
});

test("invalid save rolls back; stale revision conflicts; replay is idempotent", async () => {
  const { app } = await newApp();
  const auth = await setup(app);
  const original = (
    await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } })
  ).json();
  const invalid = structuredClone(original.schedule);
  invalid["5a:0"][0].slots[0][0].subjectId = "unknown-subject";
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/state",
        headers: authHeaders(auth),
        payload: {
          schedule: invalid,
          revision: 1,
          requestId: "invalid-save-001",
        },
      })
    ).statusCode,
    400,
  );
  const stillOriginal = await app.inject({
    url: "/api/state",
    headers: { cookie: auth.cookie },
  });
  assert.equal(stillOriginal.json().revision, 1);
  assert.notEqual(
    stillOriginal.json().schedule["5a:0"][0].slots[0][0].subjectId,
    "unknown-subject",
  );

  const changed = structuredClone(original.schedule);
  changed["5a:0"][0].slots[0][0].note = "Опубликовано в черновик";
  const request = {
    schedule: changed,
    revision: 1,
    requestId: "save-idempotent-001",
  };
  const first = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers: authHeaders(auth),
    payload: request,
  });
  assert.equal(first.statusCode, 200, first.body);
  const replay = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers: authHeaders(auth),
    payload: request,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
  const stale = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers: authHeaders(auth),
    payload: {
      schedule: createSchedule(),
      revision: 1,
      requestId: "save-stale-0001",
    },
  });
  assert.equal(stale.statusCode, 409);
});
