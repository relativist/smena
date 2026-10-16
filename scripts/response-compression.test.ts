import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "smena-response-compression-"));
  roots.push(root);
  return root;
}

async function newApp(options: { serveStatic?: boolean; staticRoot?: string } = {}) {
  const root = tempRoot();
  const app = await buildApp({ dbPath: join(root, "draft.sqlite"), ...options });
  apps.push(app);
  return app;
}

function hasVaryAcceptEncoding(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : [value ?? ""];
  return values.some((entry) => entry.split(",").some((token) => token.trim().toLowerCase() === "accept-encoding"));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("gzip negotiation compresses large JSON, respects disabled gzip, and leaves health small", async () => {
  const app = await newApp();
  const expected = { value: "Расписание школы. ".repeat(500) };
  app.get("/test/compress-json", async () => expected);

  const compressed = await app.inject({ url: "/test/compress-json", headers: { "accept-encoding": "gzip" } });
  assert.equal(compressed.statusCode, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.ok(hasVaryAcceptEncoding(compressed.headers.vary));
  assert.deepEqual(JSON.parse(gunzipSync(compressed.rawPayload).toString("utf8")), expected);

  for (const acceptEncoding of [undefined, "gzip;q=0"]) {
    const response = await app.inject({
      url: "/test/compress-json",
      ...(acceptEncoding ? { headers: { "accept-encoding": acceptEncoding } } : {}),
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.headers["content-encoding"], "gzip");
    assert.deepEqual(response.json(), expected);
  }

  const health = await app.inject({ url: "/api/health", headers: { "accept-encoding": "gzip" } });
  assert.equal(health.statusCode, 200);
  assert.notEqual(health.headers["content-encoding"], "gzip");
  assert.deepEqual(health.json(), { ok: true });
});

test("static text, vector, and font assets are gzip encoded without changing their bytes", async () => {
  const root = tempRoot();
  const fixtures = join(root, "static");
  mkdirSync(fixtures, { recursive: true });
  const contents = new Map<string, Buffer>([
    ["bundle.js", Buffer.from(`const lesson = "${"Учебное расписание ".repeat(400)}";`, "utf8")],
    ["styles.css", Buffer.from(`.lesson { content: "${"расписание ".repeat(500)}"; }`, "utf8")],
    ["icon.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${"Школа ".repeat(350)}</text></svg>`, "utf8")],
    ["font.woff2", Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256))],
    ["font.ttf", Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 53 + 7) % 256))],
  ]);
  for (const [name, content] of contents) writeFileSync(join(fixtures, name), content);

  const app = await newApp({ serveStatic: true, staticRoot: fixtures });
  for (const [name, original] of contents) {
    const response = await app.inject({ url: `/${name}`, headers: { "accept-encoding": "gzip" } });
    assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
    if (name === "font.woff2") {
      assert.notEqual(response.headers["content-encoding"], "gzip", "already compressed WOFF2 should remain unchanged");
      assert.deepEqual(response.rawPayload, original);
    } else {
      assert.equal(response.headers["content-encoding"], "gzip", `${name} should be compressed`);
      assert.deepEqual(gunzipSync(response.rawPayload), original, `${name} bytes should round-trip`);
    }
  }
  assert.match(String((await app.inject({ url: "/font.ttf" })).headers["content-type"]), /font\/ttf|application\/octet-stream/i);
});

test("gzip archives and already encoded replies are not compressed a second time", async () => {
  const app = await newApp();
  const archive = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 19 + 3) % 256));
  const alreadyEncoded = gzipSync(Buffer.from("already compressed response"));
  app.get("/test/archive.gz", async (_request, reply) => reply.type("application/gzip").send(archive));
  app.get("/test/pre-encoded", async (_request, reply) => reply
    .header("content-encoding", "gzip")
    .type("application/json")
    .send(alreadyEncoded));

  const archiveResponse = await app.inject({ url: "/test/archive.gz", headers: { "accept-encoding": "gzip" } });
  assert.equal(archiveResponse.statusCode, 200);
  assert.match(String(archiveResponse.headers["content-type"]), /^application\/gzip/);
  assert.notEqual(archiveResponse.headers["content-encoding"], "gzip");
  assert.deepEqual(archiveResponse.rawPayload, archive);

  const encodedResponse = await app.inject({ url: "/test/pre-encoded", headers: { "accept-encoding": "gzip" } });
  assert.equal(encodedResponse.statusCode, 200);
  assert.equal(encodedResponse.headers["content-encoding"], "gzip");
  assert.deepEqual(encodedResponse.rawPayload, alreadyEncoded);
  assert.equal(gunzipSync(encodedResponse.rawPayload).toString("utf8"), "already compressed response");
});
