import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { Curriculum } from "../shared/curricula.ts";
import type { SchedulePrintIndex } from "../shared/schedulePrintTypes.ts";
import type { PublicStudentsIndex } from "../shared/studentTypes.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const roots: string[] = [];
const origin = "http://127.0.0.1";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-reusable-plans-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") });
  apps.push(app);
  const login = await app.inject({
    method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "reusable plans test password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
  return { app, headers, db: (app as unknown as { smenaDb: Database.Database }).smenaDb };
}

async function getState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function addQuarter(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, state: StateResponse) {
  const quarter = { id: "reuse-quarter-2030", name: "2030 · тест", startDate: "2030-09-01", endDate: "2030-10-15" };
  const response = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: {
    quarters: [...state.quarters, quarter], studyPlans: state.studyPlans, metadataOnly: true,
    responseQuarterId: quarter.id, revision: state.revision, requestId: "reuse-add-quarter-0001",
  } });
  assert.equal(response.statusCode, 200, response.body);
  return { quarter, state: response.json() as StateResponse };
}

function lessonIds(state: StateResponse) {
  return Object.values(state.schedule).flat().flatMap(day => day.slots.flat()).map(lesson => lesson.id).sort();
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("reusing a curriculum synchronizes family composition/name while preserving quarter hours, assignments, and lessons", async () => {
  const { app, headers } = await setup();
  const initial = await getState(app, headers);
  const source = initial.curricula?.find(item => item.groupIds.length > 0 && item.rows.length > 0);
  assert.ok(source, "seed has a curriculum that can be reused");
  const targetGroupId = source.groupIds[0]!;
  const originalSourceHours = source.rows[0]!.hours;
  const { quarter, state: withQuarter } = await addQuarter(app, headers, initial);
  const request = {
    curriculumId: source.id, quarterId: quarter.id, groupIds: [targetGroupId],
    revision: withQuarter.revision, requestId: "reuse-family-copy-0001",
  };

  const noAuth = await app.inject({ method: "POST", url: "/api/curricula/reuse", headers: { origin, host: "127.0.0.1" }, payload: request });
  assert.equal(noAuth.statusCode, 401);
  const badCsrf = await app.inject({ method: "POST", url: "/api/curricula/reuse", headers: { ...headers, "x-csrf-token": "wrong" }, payload: request });
  assert.equal(badCsrf.statusCode, 403);
  const stale = await app.inject({ method: "POST", url: "/api/curricula/reuse", headers, payload: { ...request, revision: initial.revision, requestId: "reuse-stale-quarter-01" } });
  assert.equal(stale.statusCode, 409);

  const copied = await app.inject({ method: "POST", url: "/api/curricula/reuse?response=compact", headers, payload: request });
  assert.equal(copied.statusCode, 200, copied.body);
  let afterCopy = await getState(app, headers);
  let originalFamily = afterCopy.curricula!.find(item => item.id === source.id)!;
  let target = afterCopy.curricula!.find(item => item.quarterId === quarter.id && item.groupIds.includes(targetGroupId))!;
  assert.equal(originalFamily.templateId, source.templateId ?? source.id);
  assert.equal(target.templateId, source.templateId ?? source.id);
  assert.equal(target.name, source.name);
  assert.deepEqual(target.rows.map(({ subjectId, lessonKind, mode }) => ({ subjectId, lessonKind, mode })), source.rows.map(({ subjectId, lessonKind, mode }) => ({ subjectId, lessonKind, mode })));
  assert.equal(target.rows[0]!.hours, originalSourceHours, "new quarter starts with the source totals");
  const copiedPlans = afterCopy.studyPlans.filter(plan => plan.quarterId === quarter.id && plan.groupId === targetGroupId);
  assert.ok(copiedPlans.length > 0);
  const stablePlanAssignments = copiedPlans.map(plan => ({ id: plan.id, assignments: plan.assignments.map(assignment => assignment.id).sort() })).sort((a, b) => a.id.localeCompare(b.id));
  const secondGroupId = afterCopy.catalog.groups.find(group => group.id !== targetGroupId && !group.archived)?.id;
  assert.ok(secondGroupId);
  const merge = await app.inject({ method: "POST", url: "/api/curricula/reuse?response=compact", headers, payload: {
    curriculumId: source.id, quarterId: quarter.id, groupIds: [secondGroupId],
    revision: afterCopy.revision, requestId: "reuse-family-merge-0001",
  } });
  assert.equal(merge.statusCode, 200, merge.body);
  afterCopy = await getState(app, headers);
  target = afterCopy.curricula!.find(item => item.quarterId === quarter.id && item.groupIds.includes(targetGroupId))!;
  assert.ok(target.groupIds.includes(secondGroupId), "reusing the family in the same quarter merges additional groups");
  const stableLessonIds = lessonIds(afterCopy);
  const replay = await app.inject({ method: "POST", url: "/api/curricula/reuse?response=compact", headers, payload: request });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((await getState(app, headers)).revision, afterCopy.revision, "an exact retry does not create another revision");

  const duplicateName: Curriculum = { id: "reuse-duplicate-name", name: target.name, quarterId: quarter.id, groupIds: [], rows: [] };
  const duplicate = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: {
    curricula: [target, duplicateName], scopeQuarterId: quarter.id, revision: afterCopy.revision,
    requestId: "reuse-duplicate-name-01",
  } });
  assert.equal(duplicate.statusCode, 400, duplicate.body);

  const addedSubject = afterCopy.catalog.subjects.find(subject => !subject.archived && !target.rows.some(row => row.subjectId === subject.id));
  assert.ok(addedSubject, "fixture has another active subject to test a composition edit");
  const edited: Curriculum = {
    ...target,
    name: "Общий план · обновлён",
    rows: [
      ...target.rows.map((row, index) => index === 0 ? { ...row, hours: row.hours + 1 } : row),
      { id: "reuse-added-row", subjectId: addedSubject.id, lessonKind: "regular", mode: "whole", hours: 2 },
    ],
  };
  const update = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: {
    curricula: [edited], scopeQuarterId: quarter.id, revision: afterCopy.revision,
    requestId: "reuse-family-edit-0001",
  } });
  assert.equal(update.statusCode, 200, update.body);
  afterCopy = await getState(app, headers);
  originalFamily = afterCopy.curricula!.find(item => item.id === source.id)!;
  target = afterCopy.curricula!.find(item => item.id === edited.id)!;
  assert.equal(originalFamily.name, edited.name, "name change reaches every application of the shared plan");
  assert.equal(target.name, edited.name);
  assert.deepEqual(target.rows.map(({ subjectId, lessonKind, mode }) => ({ subjectId, lessonKind, mode })), originalFamily.rows.map(({ subjectId, lessonKind, mode }) => ({ subjectId, lessonKind, mode })));
  assert.ok(originalFamily.rows.some(row => row.subjectId === addedSubject.id), "composition changes reach the source quarter");
  assert.equal(originalFamily.rows[0]!.hours, originalSourceHours, "editing one quarter preserves the other quarter totals");
  assert.equal(target.rows[0]!.hours, originalSourceHours + 1);
  const plansAfterEdit = afterCopy.studyPlans.filter(plan => plan.quarterId === quarter.id && plan.groupId === targetGroupId);
  for (const stable of stablePlanAssignments) {
    const current = plansAfterEdit.find(plan => plan.id === stable.id);
    assert.ok(current, "projection keeps each existing plan ID");
    assert.deepEqual(current.assignments.map(assignment => assignment.id).sort(), stable.assignments, "projection keeps assignment IDs");
  }
  assert.deepEqual(lessonIds(afterCopy), stableLessonIds, "editing plan metadata leaves existing scheduled lesson IDs untouched");

  const alternate: Curriculum = { id: "reuse-alternate-family", name: "Отдельный план для проверки", quarterId: source.quarterId, groupIds: [], rows: source.rows.map(row => ({ ...row, id: `alternate-${row.id}` })) };
  const sourceQuarterCurricula = afterCopy.curricula!.filter(item => item.quarterId === source.quarterId);
  const addAlternate = await app.inject({ method: "PUT", url: "/api/curricula", headers, payload: {
    curricula: [...sourceQuarterCurricula, alternate], scopeQuarterId: source.quarterId, revision: afterCopy.revision,
    requestId: "reuse-alternate-family-01",
  } });
  assert.equal(addAlternate.statusCode, 200, addAlternate.body);
  const beforeConflict = await getState(app, headers);
  const overwrite = { curriculumId: alternate.id, quarterId: quarter.id, groupIds: [targetGroupId], revision: beforeConflict.revision, requestId: "reuse-overwrite-check-01" };
  const needsConfirmation = await app.inject({ method: "POST", url: "/api/curricula/reuse", headers, payload: overwrite });
  assert.equal(needsConfirmation.statusCode, 409, needsConfirmation.body);
  assert.ok(needsConfirmation.json().replacementGroupIds.includes(targetGroupId));
  assert.equal((await getState(app, headers)).revision, beforeConflict.revision, "overwrite confirmation does not mutate the draft");
});

test("archiving and restoring a quarter hides it from public and print indexes without deleting lessons", async () => {
  const { app, headers, db } = await setup();
  const initial = await getState(app, headers);
  const firstLesson = Object.values(initial.schedule).flat().flatMap(day => day.slots.flat()).find(lesson => lesson.teacherId && lesson.roomId);
  assert.ok(firstLesson);
  db.prepare("DELETE FROM lessons WHERE id<>?").run(firstLesson.id);
  let state = await getState(app, headers);
  const quarter = state.quarters[0]!;
  const publish = await app.inject({ method: "POST", url: "/api/publications", headers, payload: {
    quarterId: quarter.id, revision: state.revision, requestId: "archive-publication-01",
  } });
  assert.equal(publish.statusCode, 200, publish.body);
  state = await getState(app, headers);
  const lessonIdsBefore = lessonIds(state);

  async function setArchived(archived: boolean, requestId: string) {
    const quarters = state.quarters.map(item => item.id === quarter.id ? { ...item, archived } : item);
    const response = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: {
      quarters, studyPlans: state.studyPlans, metadataOnly: true, responseQuarterId: quarter.id,
      revision: state.revision, requestId,
    } });
    assert.equal(response.statusCode, 200, response.body);
    state = await getState(app, headers);
    assert.equal(Boolean(state.quarters.find(item => item.id === quarter.id)?.archived), archived);
    assert.deepEqual(lessonIds(state), lessonIdsBefore, "quarter archive state does not delete or rewrite lessons");
  }

  async function assertIndexes(include: boolean) {
    const publicIndex = await app.inject({ url: "/api/public/students" });
    assert.equal(publicIndex.statusCode, 200, publicIndex.body);
    const printIndex = await app.inject({ url: "/api/schedule-print/index", headers });
    assert.equal(printIndex.statusCode, 200, printIndex.body);
    const publicHasQuarter = (publicIndex.json() as PublicStudentsIndex).quarters.some(item => item.id === quarter.id);
    const print = printIndex.json() as SchedulePrintIndex;
    assert.equal(publicHasQuarter, include);
    assert.equal(print.published.some(item => item.id === quarter.id), include);
    assert.equal(print.draft.some(item => item.id === quarter.id), include);
  }

  await setArchived(true, "archive-quarter-0001");
  await assertIndexes(false);
  await setArchived(false, "restore-quarter-0001");
  await assertIndexes(true);
});
