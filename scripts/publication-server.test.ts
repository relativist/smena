import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { PublishResponse, PublishedQuarterResponse } from "../shared/publicationTypes.ts";
import type Database from "better-sqlite3";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";

async function setup(existingDbPath?: string) {
  const root = existingDbPath ? undefined : mkdtempSync(join(tmpdir(), "smena-publication-server-"));
  if (root) roots.push(root);
  const dbPath = existingDbPath ?? join(root!, "draft.sqlite");
  const app = await buildApp({ dbPath });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "publication test password" } });
  if (auth.statusCode !== 200)
    auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "publication test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  return { app, dbPath, headers, state: stateResponse.json() as StateResponse, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("publication endpoints enforce admin and CSRF, publish frozen quarter snapshots, and replay atomically", async () => {
  const { app, dbPath, headers, db } = await setup();
  // Keep one valid demo lesson and remove legacy overlaps from this isolated fixture.
  const initialSchedule = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const firstLessonId = Object.values(initialSchedule.schedule).flat().flatMap((day) => day.slots.flat()).find((lesson) => lesson.teacherId && lesson.roomId)?.id;
  assert.ok(firstLessonId);
  db.prepare("DELETE FROM lessons WHERE id<>?").run(firstLessonId);
  const initialResponse = await app.inject({ url: "/api/state", headers });
  const initial = initialResponse.json() as StateResponse;
  const quarterId = initial.quarters[0]!.id;

  assert.equal((await app.inject({ url: `/api/publication-preview?quarterId=${quarterId}` })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/publications/${quarterId}` })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/publications", headers: { origin, host: "127.0.0.1" }, payload: { quarterId, revision: initial.revision, requestId: "publish-no-session" } })).statusCode, 401);
  const missingCsrf = await app.inject({ method: "POST", url: "/api/publications", headers: { cookie: headers.cookie, origin, host: headers.host }, payload: { quarterId, revision: initial.revision, requestId: "publish-no-csrf" } });
  assert.equal(missingCsrf.statusCode, 403);
  const wrongOrigin = await app.inject({ method: "POST", url: "/api/publications", headers: { ...headers, origin: "https://attacker.invalid" }, payload: { quarterId, revision: initial.revision, requestId: "publish-wrong-origin" } });
  assert.equal(wrongOrigin.statusCode, 403);

  const preview = await app.inject({ url: `/api/publication-preview?quarterId=${quarterId}`, headers });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().revision, initial.revision);
  assert.equal(preview.json().canPublish, true, preview.body);
  const requestId = "publish-first-version";
  const publish = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId, revision: initial.revision, requestId } });
  assert.equal(publish.statusCode, 200, publish.body);
  const firstResult = publish.json() as PublishResponse;
  assert.equal(firstResult.publication.version, 1);
  assert.equal(firstResult.publication.publishedBy, "admin");
  const publishedResponse = await app.inject({ url: `/api/publications/${quarterId}`, headers });
  assert.equal(publishedResponse.statusCode, 200, publishedResponse.body);
  const published = publishedResponse.json() as PublishedQuarterResponse;
  assert.equal(published.publication.version, 1);
  assert.equal(published.snapshot.quarter.id, quarterId);
  const publishedLesson = Object.values(published.snapshot.schedule).flat().flatMap((day) => day.slots.flat())[0]!;
  assert.equal(publishedLesson.id, firstLessonId);
  assert.ok(Object.values(published.snapshot.schedule).flat().every((day) => day.date >= published.snapshot.quarter.startDate && day.date <= published.snapshot.quarter.endDate));

  const unchangedRequest = { quarterId, revision: initial.revision, requestId: "publish-no-change" };
  const unchanged = await app.inject({ method: "POST", url: "/api/publications", headers, payload: unchangedRequest });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().unchanged, true);
  assert.equal(unchanged.json().publication.version, 1);
  assert.deepEqual((await app.inject({ url: `/api/publications/${quarterId}`, headers })).json(), published, "unchanged publication must preserve published metadata and snapshot");
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/publications", headers, payload: unchangedRequest })).json(), unchanged.json(), "unchanged publish retry must replay atomically");

  const draftBefore = await app.inject({ url: "/api/state", headers });
  assert.equal((draftBefore.json() as StateResponse).revision, initial.revision, "publication must not mutate draft revision");
  const stale = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId, revision: initial.revision - 1, requestId: "publish-stale-revision" } });
  assert.equal(stale.statusCode, 409);

  // Reusing the original request after draft edits must return its byte-for-byte response.
  const changedState = draftBefore.json() as StateResponse;
  const renamed = structuredClone(changedState.catalog);
  const publishedTeacher = renamed.teachers.find((teacher) => teacher.id === publishedLesson.teacherId)!;
  publishedTeacher.name = "Имя после публикации";
  const saved = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: renamed, revision: changedState.revision, requestId: "publish-catalog-edit" } });
  assert.equal(saved.statusCode, 200, saved.body);
  let afterEdit = saved.json() as StateResponse;
  const bellsState = await app.inject({ url: "/api/admin/state?view=bells", headers });
  const bellSettings = structuredClone(bellsState.json().bellSettings);
  bellSettings.school.duration += 5;
  const settingsSave = await app.inject({ method: "PUT", url: "/api/bell-settings", headers, payload: {
    settings: bellSettings,
    revision: afterEdit.revision,
    requestId: "publish-settings-change",
  } });
  assert.equal(settingsSave.statusCode, 200, settingsSave.body);
  afterEdit = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const changedPreview = await app.inject({ url: `/api/publication-preview?quarterId=${quarterId}`, headers });
  assert.equal(changedPreview.json().summary.settingsChanged, true);
  db.exec("CREATE TRIGGER fail_publication_replay BEFORE INSERT ON publication_replays BEGIN SELECT RAISE(ABORT, 'forced publication replay failure'); END;");
  const secondRequest = { quarterId, revision: afterEdit.revision, requestId: "publish-second-version" };
  const failedSecond = await app.inject({ method: "POST", url: "/api/publications", headers, payload: secondRequest });
  assert.equal(failedSecond.statusCode, 500, failedSecond.body);
  const afterFailedPublish = await app.inject({ url: `/api/publications/${quarterId}`, headers });
  assert.deepEqual(afterFailedPublish.json(), published, "failed replay insert must roll back snapshot and metadata upsert");
  assert.equal((db.prepare("SELECT count(*) AS count FROM publication_replays WHERE request_id=?").get(secondRequest.requestId) as { count: number }).count, 0);
  assert.equal(((await app.inject({ url: "/api/state", headers })).json() as StateResponse).revision, afterEdit.revision, "failed publication must not mutate draft revision");
  db.exec("DROP TRIGGER fail_publication_replay;");
  const second = await app.inject({ method: "POST", url: "/api/publications", headers, payload: secondRequest });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().publication.version, 2);
  assert.equal(second.json().unchanged, undefined, "settings changes must create a new publication version");
  const secondTeacherName = renamed.teachers.find((teacher) => teacher.id === publishedLesson.teacherId)!.name;
  const latestFirstQuarter = (await app.inject({ url: `/api/publications/${quarterId}`, headers })).json() as PublishedQuarterResponse;
  db.prepare("INSERT INTO quarters(id,name,start_date,end_date) VALUES(?,?,?,?)").run("publication-other-quarter", "Следующая четверть", "2026-11-02", "2026-11-06");
  const otherQuarter = { id: "publication-other-quarter", name: "Следующая четверть", startDate: "2026-11-02", endDate: "2026-11-06" };
  const otherPublish = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId: otherQuarter.id, revision: afterEdit.revision, requestId: "publish-other-quarter" } });
  assert.equal(otherPublish.statusCode, 200, otherPublish.body);
  assert.equal(otherPublish.json().publication.version, 1);
  assert.deepEqual((await app.inject({ url: `/api/publications/${quarterId}`, headers })).json(), latestFirstQuarter, "publishing another quarter must leave this quarter untouched");
  const draftAfterSecondPublish = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const renamedAgain = structuredClone(draftAfterSecondPublish.catalog);
  renamedAgain.teachers.find((teacher) => teacher.id === publishedLesson.teacherId)!.name = "Имя в черновике после публикации";
  const postPublishEdit = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: renamedAgain, revision: draftAfterSecondPublish.revision, requestId: "publish-after-second-catalog-edit" } });
  assert.equal(postPublishEdit.statusCode, 200, postPublishEdit.body);
  const replay = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId, revision: initial.revision, requestId } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), firstResult);
  const reusedId = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId, revision: afterEdit.revision, requestId } });
  assert.equal(reusedId.statusCode, 409);

  const afterReplayState = await app.inject({ url: "/api/state", headers });
  assert.equal(afterReplayState.statusCode, 200);
  assert.equal((afterReplayState.json() as StateResponse).revision, (postPublishEdit.json() as StateResponse).revision, "publication replay must not write draft state");

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await setup(dbPath);
  const persisted = await reopened.app.inject({ url: `/api/publications/${quarterId}`, headers: reopened.headers });
  assert.equal(persisted.statusCode, 200, persisted.body);
  const restartedPublication = persisted.json() as PublishedQuarterResponse;
  assert.equal(restartedPublication.publication.version, 2);
  assert.equal(restartedPublication.snapshot.catalog.teachers.find((teacher) => teacher.id === publishedLesson.teacherId)?.name, secondTeacherName, "published resource labels stay frozen after catalog edits and restart");
  assert.equal(Object.values(restartedPublication.snapshot.schedule).flat().flatMap((day) => day.slots.flat())[0]!.id, firstLessonId);
  assert.equal((await reopened.app.inject({ url: `/api/publications/${otherQuarter.id}`, headers: reopened.headers })).json().publication.version, 1);
});

test("publication returns useful validation errors and does not leave a partial snapshot or replay", async () => {
  const { app, headers, state, db } = await setup();
  const quarterId = state.quarters[0]!.id;
  db.prepare("UPDATE lessons SET teacher='missing-teacher', room='missing-room' WHERE id=(SELECT id FROM lessons LIMIT 1)").run();
  const response = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId, revision: state.revision, requestId: "publication-invalid-request" } });
  assert.equal(response.statusCode, 422, response.body);
  assert.ok(response.json().preview.errors.length > 0);
  assert.equal((await app.inject({ url: `/api/publications/${quarterId}`, headers })).statusCode, 404);
  assert.equal((db.prepare("SELECT count(*) AS count FROM publication_replays").get() as { count: number }).count, 0);
});
