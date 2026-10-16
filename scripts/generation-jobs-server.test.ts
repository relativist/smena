import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGenerationApi } from "../server/generationApi.ts";
import type { GenerationApiDeps } from "../server/generationApi.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { Schedule } from "../src/editor.ts";
import { openSqliteDatabase } from "../server/database.ts";

const schedule: Schedule = {
  "g1:-1": [{ date: "2026-09-01", start: "08:30", duration: 45, breaks: [10], times: [{ start: 510, duration: 45 }], slots: [[]] }],
};
const state = {
  revision: 7,
  updatedAt: "2026-08-01T00:00:00.000Z",
  schedule,
  catalog: {
    groups: [{ id: "g1", name: "5А", students: 20, leaderId: null, roomId: null, autoRoomIds: [], archived: false }],
    subgroups: [],
    subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
    teachers: [{ id: "t1", name: "Иванов", subjectIds: ["math"], defaultRoomId: "r1", archived: false }],
    rooms: [{ id: "r1", name: "312", kind: "general", capacity: 30, archived: false }],
  },
  quarters: [{ id: "q1", name: "I четверть", startDate: "2026-09-01", endDate: "2026-09-01" }],
  studyPlans: [{ id: "p1", quarterId: "q1", groupId: "g1", subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "a1", subgroupId: null, target: 1 }] }],
} as unknown as StateResponse;

const asyncDb = openSqliteDatabase(":memory:");
const db = asyncDb.native!;
db.exec("CREATE TABLE test_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT INTO test_revision VALUES(1,7);");
const getRevision = () => (db.prepare("SELECT revision FROM test_revision WHERE id=1").get() as { revision: number }).revision;
let committed = false;
let reservationReadWasTransactional = false;
const deps: GenerationApiDeps = {
  db: asyncDb,
  getSession: async request => request.headers.cookie ? { username: request.headers.cookie === "other" ? "other" : "admin", csrfToken: "csrf" } : null,
  isSameOrigin: () => true,
  readState: async () => {
    reservationReadWasTransactional ||= db.inTransaction;
    return { ...state, revision: getRevision() };
  },
  commit: async (before, after, expected) => {
    assert.deepEqual(before, schedule);
    assert.notDeepEqual(after, before, "generated schedule changes are committed");
    assert.equal(getRevision(), expected);
    committed = true;
    const revision = expected + 1;
    db.prepare("UPDATE test_revision SET revision=? WHERE id=1").run(revision);
    return { revision, updatedAt: "2026-08-01T00:00:01.000Z" };
  },
};
const app = Fastify();
const generationControl = await registerGenerationApi(app, deps);
assert.equal(typeof generationControl.drainWrites, "function", "maintenance can drain queued worker writes");
const headers = { cookie: "session=test", origin: "http://localhost", host: "localhost", "x-csrf-token": "csrf" };
const waitForStatus = async (id: string, expected: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ url: `/api/generation-jobs/${id}`, headers });
    assert.equal(response.statusCode, 200);
    if (response.json().status === expected) return response.json();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`generation job did not reach ${expected}`);
};

try {
  const noSession = await app.inject({ method: "POST", url: "/api/generation-jobs", payload: {} });
  assert.equal(noSession.statusCode, 401);
  const invalidCsrf = await app.inject({ method: "POST", url: "/api/generation-jobs", headers: { cookie: "session=test" }, payload: {} });
  assert.equal(invalidCsrf.statusCode, 403);
  const started = await app.inject({ method: "POST", url: "/api/generation-jobs", headers, payload: {
    revision: 7, quarterId: "q1", groupIds: ["g1"], options: { preserveExisting: true, allowJointLessons: true },
  } });
  assert.equal(started.statusCode, 202);
  assert.equal(reservationReadWasTransactional, true, "job reservation reads the authoritative revision under the database transaction");
  const id = started.json().id as string;
  const ping = await app.inject({ method: "GET", url: `/api/generation-jobs/${id}`, headers });
  assert.equal(ping.statusCode, 200, "Fastify remains responsive while generation runs in a worker thread");
  const complete = await waitForStatus(id, "complete");
  assert.equal(complete.result.added.length, 1);
  assert.equal(complete.result.remaining.length, 0);
  assert.equal("schedule" in complete.result, false, "poll response does not ship the generated quarter schedule");
  assert.equal(complete.result.added[0].start, 510, "added lesson details include only its compact time");
  const otherOwner = await app.inject({ url: `/api/generation-jobs/${id}`, headers: { cookie: "other" } });
  assert.equal(otherOwner.statusCode, 404, "a job is visible only to its owner");

  db.prepare("UPDATE test_revision SET revision=revision+1 WHERE id=1").run();
  const staleApply = await app.inject({ method: "POST", url: `/api/generation-jobs/${id}/apply`, headers, payload: { revision: 7, requestId: "apply-stale-0001" } });
  assert.equal(staleApply.statusCode, 409, "stale generated proposal is fenced by the server revision");
  assert.equal(committed, false);

  const freshStart = await app.inject({ method: "POST", url: "/api/generation-jobs", headers, payload: {
    revision: getRevision(), quarterId: "q1", groupIds: ["g1"], options: { preserveExisting: true, allowJointLessons: true },
  } });
  assert.equal(freshStart.statusCode, 202);
  const freshId = freshStart.json().id as string;
  await waitForStatus(freshId, "complete");
  const freshRevision = getRevision();
  db.exec("CREATE TRIGGER fail_generation_job_apply BEFORE UPDATE OF status ON generation_jobs WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'forced apply-update failure'); END;");
  const failedApply = await app.inject({ method: "POST", url: `/api/generation-jobs/${freshId}/apply`, headers, payload: { revision: freshRevision, requestId: "apply-fresh-0001" } });
  assert.equal(failedApply.statusCode, 500, "apply errors are surfaced to the client");
  assert.equal(getRevision(), freshRevision, "schedule commit rolls back when the job status update fails");
  assert.equal((await app.inject({ url: `/api/generation-jobs/${freshId}`, headers })).json().status, "complete");
  db.exec("DROP TRIGGER fail_generation_job_apply;");
  const applied = await app.inject({ method: "POST", url: `/api/generation-jobs/${freshId}/apply`, headers, payload: { revision: freshRevision, requestId: "apply-fresh-0001" } });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().status, "applied");
  assert.equal(applied.json().revision, freshRevision + 1);
  assert.equal(committed, true, "fresh result is passed to the atomic commit callback");
  const replayedApply = await app.inject({ method: "POST", url: `/api/generation-jobs/${freshId}/apply`, headers, payload: { revision: freshRevision, requestId: "apply-fresh-0001" } });
  assert.equal(replayedApply.statusCode, 200, "retry after a lost apply response is idempotent");
  assert.equal(replayedApply.json().revision, freshRevision + 1);
  const reusedApplyId = await app.inject({ method: "POST", url: `/api/generation-jobs/${freshId}/apply`, headers, payload: { revision: freshRevision + 1, requestId: "apply-fresh-0001" } });
  assert.equal(reusedApplyId.statusCode, 409, "an applied request ID cannot be reused with a different body");

  const cancelStart = await app.inject({ method: "POST", url: "/api/generation-jobs", headers, payload: {
    revision: getRevision(), quarterId: "q1", groupIds: ["g1"], options: { preserveExisting: true, allowJointLessons: true },
  } });
  assert.equal(cancelStart.statusCode, 202);
  const cancelId = cancelStart.json().id as string;
  const cancelled = await app.inject({ method: "POST", url: `/api/generation-jobs/${cancelId}/cancel`, headers, payload: {} });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "cancelled");

  console.log("generation job server tests passed");
} finally {
  await app.close();
  await asyncDb.close();
}
