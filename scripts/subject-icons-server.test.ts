import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import { projectPublicStudents } from "../shared/studentPublic.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];
const origin = "http://127.0.0.1";

async function setup(dbPath?: string) {
  const dir = dbPath ? undefined : mkdtempSync(join(tmpdir(), "smena-subject-icons-"));
  if (dir) dirs.push(dir);
  const path = dbPath ?? join(dir!, "draft.sqlite");
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "subject icons test password" } });
  if (auth.statusCode !== 200)
    auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "subject icons test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return { app, path, headers, state: response.json() as StateResponse };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("subject icon overrides persist, legacy omissions preserve them, and invalid ids do not write", async () => {
  const first = await setup();
  const catalog = structuredClone(first.state.catalog);
  const math = catalog.subjects.find((entry) => entry.id === "math")!;
  math.iconId = "algebra";
  const save = (value: unknown, revision: number, requestId: string) => first.app.inject({
    method: "PUT", url: "/api/catalog", headers: first.headers,
    payload: { catalog: value, revision, requestId },
  });
  const customized = await save(catalog, first.state.revision, "subject-icon-custom");
  assert.equal(customized.statusCode, 200, customized.body);
  assert.equal(customized.json().catalog.subjects.find((entry: any) => entry.id === "math").iconId, "algebra");

  const legacyPayload = structuredClone(customized.json().catalog) as any;
  delete legacyPayload.subjects.find((entry: any) => entry.id === "math").iconId;
  const preserved = await save(legacyPayload, customized.json().revision, "subject-icon-legacy-payload");
  assert.equal(preserved.statusCode, 200, preserved.body);
  assert.equal(preserved.json().catalog.subjects.find((entry: any) => entry.id === "math").iconId, "algebra");

  const invalidPayload = structuredClone(preserved.json().catalog) as any;
  invalidPayload.subjects.find((entry: any) => entry.id === "math").iconId = "https://example.invalid/icon.svg";
  const invalid = await save(invalidPayload, preserved.json().revision, "subject-icon-invalid");
  assert.equal(invalid.statusCode, 400);
  const afterInvalid = await first.app.inject({ url: "/api/state", headers: first.headers });
  assert.equal(afterInvalid.json().revision, preserved.json().revision);

  const nonePayload = structuredClone(preserved.json().catalog) as any;
  nonePayload.subjects.find((entry: any) => entry.id === "math").iconId = null;
  const none = await save(nonePayload, preserved.json().revision, "subject-icon-none");
  assert.equal(none.statusCode, 200, none.body);
  assert.equal(none.json().catalog.subjects.find((entry: any) => entry.id === "math").iconId, null);

  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);
  const reopened = await setup(first.path);
  assert.equal(reopened.state.catalog.subjects.find((entry) => entry.id === "math")?.iconId, null);
  const resetCatalog = structuredClone(reopened.state.catalog);
  resetCatalog.subjects.find((entry) => entry.id === "math")!.iconId = "auto";
  const reset = await reopened.app.inject({ method: "PUT", url: "/api/catalog", headers: reopened.headers,
    payload: { catalog: resetCatalog, revision: reopened.state.revision, requestId: "subject-icon-reset-auto" } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().catalog.subjects.find((entry: any) => entry.id === "math").iconId, "auto");
  assert.deepEqual(reset.json().schedule, reopened.state.schedule);
  assert.deepEqual(reset.json().studyPlans, reopened.state.studyPlans);
  assert.deepEqual(reset.json().curricula, reopened.state.curricula);
});

test("public student projection resolves legacy, custom and hidden subject icons from its frozen snapshot", async () => {
  const { state } = await setup();
  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const lessons = Object.values(snapshot.schedule).flat().flatMap((day) => day.slots.flat());
  const mathLesson = lessons.find((lesson) => lesson.subjectId === "math");
  assert.ok(mathLesson, "fixture has a math lesson");
  const math = snapshot.catalog.subjects.find((entry) => entry.id === "math")!;

  delete math.iconId; // old publication snapshot
  let projection = projectPublicStudents(snapshot, { version: 1, publishedAt: "2026-10-14T00:00:00.000Z" });
  const publicMath = [...projection.schedules.values()].flatMap((schedule) => schedule.days.flatMap((day) => day.lessons)).find((lesson) => lesson.id === mathLesson.id);
  assert.equal(publicMath?.subject?.iconId, "math");

  math.iconId = "algebra";
  projection = projectPublicStudents(snapshot, { version: 2, publishedAt: "2026-10-14T00:00:00.000Z" });
  const customMath = [...projection.schedules.values()].flatMap((schedule) => schedule.days.flatMap((day) => day.lessons)).find((lesson) => lesson.id === mathLesson.id);
  assert.equal(customMath?.subject?.iconId, "algebra");

  math.iconId = null;
  projection = projectPublicStudents(snapshot, { version: 3, publishedAt: "2026-10-14T00:00:00.000Z" });
  const hiddenMath = [...projection.schedules.values()].flatMap((schedule) => schedule.days.flatMap((day) => day.lessons)).find((lesson) => lesson.id === mathLesson.id);
  assert.equal(hiddenMath?.subject?.iconId, null);
  assert.equal(hiddenMath?.subject?.name, math.name, "full subject label remains public");
});
