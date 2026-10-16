import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";

test("proxy deployment preserves origin checks and scopes secure session cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "smena-deployment-"));
  const oldBase = process.env.SMENA_BASE_PATH;
  const oldProxy = process.env.SMENA_TRUST_PROXY;
  process.env.SMENA_BASE_PATH = "/smena/";
  process.env.SMENA_TRUST_PROXY = "1";
  const app = await buildApp({ dbPath: join(root, "test.sqlite") });
  try {
    const headers = { host: "school.example:4173", origin: "https://school.example:4173", "x-forwarded-proto": "https" };
    assert.equal((await app.inject("/api/state")).statusCode, 401);
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers, payload: { username: "admin", password: "deployment test password" } });
    assert.equal(setup.statusCode, 200, setup.body);
    const setCookie = String(setup.headers["set-cookie"]);
    assert.match(setCookie, /Path=\/smena\//);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    const cookie = setCookie.split(";")[0]!;
    const csrfToken = setup.json().csrfToken;
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...headers, cookie, "x-csrf-token": csrfToken, origin: "https://other.example" } })).statusCode, 403);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...headers, cookie, "x-csrf-token": csrfToken } });
    assert.equal(logout.statusCode, 200, logout.body);
    assert.match(String(logout.headers["set-cookie"]), /Path=\/smena\//);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { username: "admin", password: "deployment test password" } });
    assert.equal(login.statusCode, 200, login.body);
    assert.match(String(login.headers["set-cookie"]), /Path=\/smena\//);
    assert.match(String(login.headers["set-cookie"]), /Secure/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    if (oldBase === undefined) delete process.env.SMENA_BASE_PATH; else process.env.SMENA_BASE_PATH = oldBase;
    if (oldProxy === undefined) delete process.env.SMENA_TRUST_PROXY; else process.env.SMENA_TRUST_PROXY = oldProxy;
  }
});
