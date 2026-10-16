import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { generateQuarter } from "../shared/generateSchedule.ts";
import { defaultBellSettings } from "../shared/bellSchedule.ts";
import { createDatabaseBackup, restoreDatabaseBackup } from "./database-backup.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const pgCleanup: Array<() => Promise<void>> = [];
const origin = "http://127.0.0.1";

async function openSchool(target: { dbPath?: string; databaseUrl?: string }, archiveBackupDirectory?: string) {
  const app = await buildApp({ ...target, archiveBackupDirectory });
  apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "trial school password" } });
  if (auth.statusCode !== 200) auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "trial school password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const state = await app.inject({ url: "/api/state", headers });
  assert.equal(state.statusCode, 200, state.body);
  return { app, headers, state: state.json() as StateResponse };
}

async function readState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function generateQuarterThroughApi(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, revision: number, quarterId: string, groupId: string, preserveExisting: boolean) {
  const started = await app.inject({ method: "POST", url: "/api/generation-jobs", headers, payload: {
    revision, quarterId, groupIds: [groupId], options: { preserveExisting, allowJointLessons: true },
  } });
  assert.equal(started.statusCode, 202, started.body);
  const id = started.json().id as string;
  let job: { status: string; result?: { added: Array<Record<string, unknown>>; remaining: unknown[] } } | undefined;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await app.inject({ url: `/api/generation-jobs/${id}`, headers });
    assert.equal(status.statusCode, 200, status.body);
    const currentJob = status.json() as NonNullable<typeof job>;
    job = currentJob;
    if (currentJob.status === "complete") break;
    assert.notEqual(currentJob.status, "failed", JSON.stringify(currentJob));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(job && job.status === "complete", "schedule generation worker completes within 30 seconds");
  assert.ok(job.result);
  const applied = await app.inject({ method: "POST", url: `/api/generation-jobs/${id}/apply`, headers, payload: { revision, requestId: requestId("trial-api-generation") } });
  assert.equal(applied.statusCode, 200, applied.body);
  return { result: job.result, state: await readState(app, headers) };
}

function requestId(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const cleanup of pgCleanup.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runTrialScenario(postgres: boolean) {
  const root = mkdtempSync(join(tmpdir(), "smena-trial-school-")); roots.push(root);
  const dbPath = join(root, "school.sqlite");
  let sourceUrl: string | undefined;
  let targetUrl: string | undefined;
  if (postgres) {
    const testUrl = process.env.SMENA_TEST_DATABASE_URL;
    assert.ok(testUrl, "SMENA_TEST_DATABASE_URL is required; production database URLs are never used by this test");
    const pool = new Pool({ connectionString: testUrl, max: 1, application_name: "smena-trial-school-test-admin" });
    const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const sourceSchema = `smena_trial_source_${suffix}`;
    const targetSchema = `smena_trial_target_${suffix}`;
    await pool.query(`CREATE SCHEMA "${sourceSchema}"`);
    await pool.query(`CREATE SCHEMA "${targetSchema}"`);
    const scoped = (schema: string) => {
      const url = new URL(testUrl);
      const options = url.searchParams.get("options")?.trim();
      url.searchParams.set("options", `${options ? `${options} ` : ""}-c search_path=${schema},public`);
      return url.toString();
    };
    sourceUrl = scoped(sourceSchema);
    targetUrl = scoped(targetSchema);
    pgCleanup.push(async () => {
      await pool.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA "${targetSchema}" CASCADE`);
      await pool.end();
    });
  }
  let school = await openSchool(postgres ? { databaseUrl: sourceUrl } : { dbPath }, join(root, "restore-backups"));
  const { app, headers } = school;
  if (postgres) {
    // PostgreSQL starts without the legacy SQLite demo school. Seed only this owned schema.
    const catalog = structuredClone(school.state.catalog);
    catalog.groups.push({ id: "5a", name: "5А", students: 24, leaderId: null, roomId: "trial-room", autoRoomIds: [], archived: false });
    catalog.rooms.push({ id: "trial-room", name: "214", kind: "general", capacity: 30, archived: false });
    catalog.teachers.push({ id: "teacher:trial-source", name: "Пробный учитель", subjectIds: ["math"], defaultRoomId: "trial-room", preferredGroupIds: ["5a"], archived: false });
    let seed = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: school.state.revision, requestId: requestId("trial-pg-catalog") } });
    assert.equal(seed.statusCode, 200, seed.body);
    const initialQuarter = { id: "trial-pg-quarter", name: "Пробная четверть", startDate: `${new Date().getFullYear() + 1}-09-01`, endDate: `${new Date().getFullYear() + 1}-10-31` };
    seed = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: { quarters: [initialQuarter], studyPlans: [{ id: "trial-pg-plan", quarterId: initialQuarter.id, groupId: "5a", subjectId: "math", mode: "whole", lessonKind: "regular", assignments: [{ id: "trial-pg-assignment", subgroupId: null, target: 24 }] }], revision: seed.json().revision, requestId: requestId("trial-pg-plans") } });
    assert.equal(seed.statusCode, 200, seed.body);
    school = { ...school, state: await readState(app, headers) };
    const emptyGroups = await app.inject({ url: `/api/admin/reassignments?quarterId=${encodeURIComponent(initialQuarter.id)}&groupIds=%2C`, headers });
    assert.equal(emptyGroups.statusCode, 200, emptyGroups.body);
    assert.deepEqual(emptyGroups.json().schedule, {}, "an explicitly empty group filter returns an empty schedule");
    const unavailable = await app.inject({ url: `/api/admin/reassignments?availability=1&teacherId=teacher%3Atrial-source&startDate=2029-01-01&endDate=2029-01-02`, headers });
    assert.equal(unavailable.statusCode, 200, unavailable.body);
    assert.deepEqual(unavailable.json().availableGroupIds, []);
    assert.deepEqual(unavailable.json().availableSubjectIds, []);
  }
  const group = school.state.catalog.groups.find(item => item.id === "5a")!;
  const quarter = school.state.quarters[0]!;
  assert.ok(group && quarter);

  // Save and reload the operational records through the same APIs used by the admin pages.
  let response = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: school.state.catalog, revision: school.state.revision, requestId: requestId("trial-catalog") } });
  assert.equal(response.statusCode, 200, response.body);
  let state = response.json() as StateResponse;
  response = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: { quarters: state.quarters, studyPlans: state.studyPlans, revision: state.revision, requestId: requestId("trial-plans") } });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json() as StateResponse;
  if (!postgres) {
    response = await app.inject({ method: "PUT", url: "/api/calendar", headers, payload: { calendar: state.calendar, confirmLessonRemoval: false, revision: state.revision, requestId: requestId("trial-calendar") } });
    assert.equal(response.statusCode, 200, response.body);
    state = response.json() as StateResponse;
  }

  const clearedSchedule = Object.fromEntries(Object.entries(state.schedule).map(([key, days]) => [key, days.map(day => ({
    ...day,
    slots: day.slots.map(() => []),
  }))]));
  response = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: clearedSchedule, revision: state.revision, requestId: requestId("trial-clear") } });
  assert.equal(response.statusCode, 200, response.body);
  state = await readState(app, headers);

  // Move the now-empty fixture quarter into the next calendar year so the
  // absence and return workflow stays future-dated whenever the suite runs.
  const futureStart = `${new Date().getFullYear() + 1}-09-01`;
  const dayShift = Math.round((Date.parse(`${futureStart}T00:00:00Z`) - Date.parse(`${quarter.startDate}T00:00:00Z`)) / 86_400_000);
  const futureQuarter = { ...quarter, startDate: futureStart, endDate: shiftDate(quarter.endDate, dayShift) };
  response = await app.inject({ method: "PUT", url: "/api/plans", headers, payload: {
    quarters: state.quarters.map(item => item.id === quarter.id ? futureQuarter : item),
    studyPlans: state.studyPlans,
    revision: state.revision,
    requestId: requestId("trial-future-quarter"),
  } });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json() as StateResponse;
  quarter.startDate = futureQuarter.startDate;
  quarter.endDate = futureQuarter.endDate;
  // Saving the future quarter creates its dated schedule rows; reread them as
  // the editor would before making the next change.
  state = await readState(app, headers);

  const targetDate = shiftDate(quarter.startDate, 44);
  const bells = defaultBellSettings();
  bells.school.duration = 30;
  response = await app.inject({ method: "PUT", url: "/api/bell-settings", headers, payload: {
    settings: bells,
    revision: state.revision, requestId: requestId("trial-bells"),
  } });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json() as StateResponse;

  const otherGroupsBefore = Object.fromEntries(Object.entries(state.schedule).filter(([key]) => !key.startsWith(`${group.id}:`)));
  // The school's saved bell profile is the default; shorten this particular date
  // in the selected group's working week before generating its lessons.
  for (const [key, days] of Object.entries(state.schedule))
    if (key.startsWith(`${group.id}:`)) days.find(day => day.date === targetDate)?.times.forEach(time => { time.duration = 30; });
  let result = generateQuarter(state, quarter.id, [group.id], { preserveExisting: false });
  assert.ok(result.added.length > 0, "generation should place lessons from this group's plan");
  const schedule = result.schedule;
  const generatedDays = Object.entries(schedule).filter(([key]) => key.startsWith(`${group.id}:`)).flatMap(([, days]) => days.filter(day => day.date >= quarter.startDate && day.date <= quarter.endDate));
  for (const day of generatedDays) assert.ok(day.slots.reduce((n, slot) => n + slot.length, 0) <= 7, `${day.date} exceeds seven lessons`);
  assert.deepEqual(Object.fromEntries(Object.entries(schedule).filter(([key]) => !key.startsWith(`${group.id}:`))), otherGroupsBefore, "generation for one class leaves other classes intact");
  for (const plan of state.studyPlans.filter(item => item.quarterId === quarter.id && item.groupId === group.id)) {
    for (const assignment of plan.assignments) {
      const added = result.added.filter(item => item.groupId === group.id && item.subjectId === plan.subjectId && item.lessonKind === plan.lessonKind && (item.subgroupId ?? null) === assignment.subgroupId).length;
      const missing = result.remaining.filter(item => item.groupId === group.id && item.subjectId === plan.subjectId && item.lessonKind === plan.lessonKind && (item.subgroupId ?? null) === assignment.subgroupId).reduce((sum, item) => sum + item.missing, 0);
      assert.equal(added + missing, assignment.target, `${plan.subjectId} plan target accounting`);
    }
  }
  const slotDate = generatedDays.find(day => day.date === targetDate);
  assert.ok(slotDate, "shortened date is part of the selected group's quarter calendar");
  assert.ok(slotDate!.times.length > 0 && slotDate!.times.every(time => time.duration === 30), "the chosen day should use shortened lesson lengths");

  if (postgres) {
    // Exercise the production generation and bulk-operation APIs against PG, including the
    // empty metadata-date query that previously generated `IN ()` during preview/apply.
    const generated = await generateQuarterThroughApi(app, headers, state.revision, quarter.id, group.id, false);
    state = generated.state;
    assert.equal(generated.result.added.length, result.added.length, "API generation matches the planned lesson count");
    const clearDate = String(generated.result.added[0]!.date);
    const clearOptions = { groupIds: [group.id], startDate: clearDate, endDate: clearDate };
    const preview = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { revision: state.revision, operation: "clear", options: clearOptions } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.ok(preview.json().removedCount > 0, "the selected date contains lessons to clear");
    const applied = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: { revision: state.revision, requestId: requestId("trial-api-clear"), operation: "clear", options: clearOptions } });
    assert.equal(applied.statusCode, 200, applied.body);
    state = await readState(app, headers);
    const clearedDay = Object.values(state.schedule).flat().find(day => day.date === clearDate);
    assert.ok(clearedDay && clearedDay.slots.every(slot => slot.length === 0), "bulk clear removes lessons from the selected day");
    const regenerated = await generateQuarterThroughApi(app, headers, state.revision, quarter.id, group.id, false);
    assert.equal(regenerated.result.added.length, result.added.length, "API regeneration restores the initial quarter lesson count");
    state = regenerated.state;
    result = { ...result, schedule: state.schedule, added: regenerated.result.added as typeof result.added };
  } else {
    response = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule, revision: state.revision, requestId: requestId("trial-generated") } });
    assert.equal(response.statusCode, 200, response.body);
    state = await readState(app, headers);
  }
  let candidate: { placement: typeof result.added[number]; entry: [string, StateResponse["schedule"][string]]; day: StateResponse["schedule"][string][number]; lesson: StateResponse["schedule"][string][number]["slots"][number][number] } | undefined;
  for (const placement of result.added) {
    const entry = Object.entries(state.schedule).find(([key, days]) => key.startsWith(`${placement.groupId}:`) && days.some(day => day.date === placement.date));
    const day = entry?.[1].find(item => item.date === placement.date);
    const lesson = day?.slots.flat().find(item => item.id === placement.lessonId);
    if (entry && day && lesson && day.date > new Date().toLocaleDateString("sv-SE")) {
      candidate = { placement, entry: entry as [string, StateResponse["schedule"][string]], day, lesson };
      break;
    }
  }
  assert.ok(candidate, "a future generated lesson is required for the absence workflow");

  const sourceId = candidate!.placement.teacherId;
  const substitute = { id: "teacher:trial-substitute", name: "Пробный заменяющий", subjectIds: [candidate!.placement.subjectId], defaultRoomId: null, preferredGroupIds: [group.id], archived: false };
  const catalog = structuredClone(state.catalog);
  catalog.teachers.push(substitute);
  const ruleId = "trial-sick-leave";
  catalog.teachers.find(item => item.id === sourceId)!.unavailability = [{ id: ruleId, startDate: candidate!.placement.date, endDate: candidate!.placement.date, start: candidate!.day.times[candidate!.placement.slot]!.start, end: candidate!.day.times[candidate!.placement.slot]!.start + candidate!.day.times[candidate!.placement.slot]!.duration, reason: "Пробная проверка больничного" }];
  response = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: state.revision, requestId: requestId("trial-absence") } });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json() as StateResponse;
  const replacementRequest = { teacherId: sourceId, startDate: candidate!.placement.date, endDate: candidate!.placement.date, groupId: group.id, subjectId: candidate!.placement.subjectId, ruleId };
  response = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers, payload: { revision: state.revision, request: replacementRequest } });
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json().preview;
  const unit = preview.units.find((item: { lessonIds: string[] }) => item.lessonIds.includes(candidate!.placement.lessonId));
  assert.equal(unit?.teacherId, substitute.id, "the qualified substitute should be selected automatically");
  response = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: state.revision, requestId: requestId("trial-replace"), request: replacementRequest, expectedAssignments: [{ unitId: unit.id, teacherId: substitute.id }] } });
  assert.equal(response.statusCode, 200, response.body);
  state = (response.json() as { state: StateResponse }).state;
  assert.equal(state.schedule[candidate!.entry[0]]![candidate!.entry[1].findIndex(day => day.date === candidate!.placement.date)]!.slots[candidate!.placement.slot]!.find(item => item.id === candidate!.placement.lessonId)?.teacherId, substitute.id);

  const returnRequest = { mode: "return", sourceTeacherId: sourceId, returnDate: candidate!.placement.date, ruleId };
  response = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: returnRequest } });
  assert.equal(response.statusCode, 200, response.body);
  const returnPreview = response.json().preview;
  const returnUnit = returnPreview.units.find((item: { lessonIds: string[] }) => item.lessonIds.includes(candidate!.placement.lessonId));
  assert.equal(returnUnit?.teacherId, sourceId);
  response = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: requestId("trial-return"), request: returnRequest, expectedUnits: [{ unitId: returnUnit.id, teacherId: sourceId }] } });
  assert.equal(response.statusCode, 200, response.body);
  state = (response.json() as { state: StateResponse }).state;
  assert.equal(state.schedule[candidate!.entry[0]]![candidate!.entry[1].findIndex(day => day.date === candidate!.placement.date)]!.slots[candidate!.placement.slot]!.find(item => item.id === candidate!.placement.lessonId)?.teacherId, sourceId, "early return restores the original teacher");

  response = await app.inject({ method: "POST", url: "/api/publications", headers, payload: { quarterId: quarter.id, revision: state.revision, requestId: requestId("trial-publish") } });
  assert.equal(response.statusCode, 200, response.body);
  const publication = response.json().publication;
  const studentIndex = await app.inject({ url: "/api/public/students" });
  assert.ok(studentIndex.json().quarters.some((item: { id: string }) => item.id === quarter.id));
  const studentData = await app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${group.id}` });
  assert.equal(studentData.statusCode, 200, studentData.body);
  assert.ok(studentData.json().days.length > 0);
  const teacherIndex = await app.inject({ url: "/api/public/teachers" });
  assert.ok(teacherIndex.json().quarters.some((item: { id: string }) => item.id === quarter.id));
  const teacherData = await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${sourceId}` });
  assert.equal(teacherData.statusCode, 200, teacherData.body);

  const weekStart = (() => {
    const date = new Date(`${targetDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  })();
  response = await app.inject({ method: "POST", url: "/api/schedule-print/preview", headers, payload: { source: "published", quarterId: quarter.id, weekStart, groupIds: [group.id], version: publication.version } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().groups[0].group.id, group.id);
  const printBeforeDraftEdit = response.json();
  const publicStudentBeforeDraftEdit = studentData.json();
  const publicTeacherBeforeDraftEdit = teacherData.json();

  // Draft edits must not alter the immutable public/print snapshot.
  const editedCatalog = structuredClone(state.catalog);
  editedCatalog.teachers.find(item => item.id === sourceId)!.name = "Исходный преподаватель после публикации";
  response = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: editedCatalog, revision: state.revision, requestId: requestId("trial-draft-edit") } });
  assert.equal(response.statusCode, 200, response.body);
  state = response.json() as StateResponse;
  const draftSchedule = structuredClone(state.schedule);
  const draftDay = draftSchedule[candidate!.entry[0]]!.find(day => day.date === candidate!.placement.date)!;
  draftDay.slots[candidate!.placement.slot]!.find(item => item.id === candidate!.placement.lessonId)!.note = "Черновая заметка после публикации";
  response = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: draftSchedule, revision: state.revision, requestId: requestId("trial-draft-note") } });
  assert.equal(response.statusCode, 200, response.body);
  const frozenStudent = await app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${group.id}` });
  const frozenTeacher = await app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${sourceId}` });
  const frozenPrint = await app.inject({ method: "POST", url: "/api/schedule-print/preview", headers, payload: { source: "published", quarterId: quarter.id, weekStart, groupIds: [group.id], version: publication.version } });
  assert.deepEqual(frozenStudent.json(), publicStudentBeforeDraftEdit);
  assert.deepEqual(frozenTeacher.json(), publicTeacherBeforeDraftEdit);
  assert.deepEqual(frozenPrint.json(), printBeforeDraftEdit);

  await app.close(); apps.splice(apps.indexOf(app), 1);
  let restored: Awaited<ReturnType<typeof openSchool>>;
  if (!postgres) {
    const backup = join(root, "school-backup.sqlite");
    const restoredPath = join(root, "school-restored.sqlite");
    await createDatabaseBackup({ db: dbPath, to: backup });
    await restoreDatabaseBackup({ from: backup, to: restoredPath });
    restored = await openSchool({ dbPath: restoredPath });
  } else {
    const archive = await openSchool({ databaseUrl: sourceUrl }, join(root, "restore-backups"));
    const exported = await archive.app.inject({ method: "POST", url: "/api/data-transfer/export", headers: archive.headers });
    assert.equal(exported.statusCode, 200, exported.body);
    await archive.app.close(); apps.splice(apps.indexOf(archive.app), 1);
    restored = await openSchool({ databaseUrl: targetUrl }, join(root, "restore-backups"));
    const previewResponse = await restored.app.inject({ method: "POST", url: "/api/data-transfer/inspect", headers: { ...restored.headers, "content-type": "application/octet-stream" }, payload: exported.rawPayload });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json();
    const restoreResponse = await restored.app.inject({ method: "POST", url: "/api/data-transfer/restore", headers: restored.headers, payload: { token: preview.token, confirm: true } });
    assert.equal(restoreResponse.statusCode, 200, restoreResponse.body);
    const newCookie = String(restoreResponse.headers["set-cookie"]).split(";")[0]!;
    const status = await restored.app.inject({ url: `/api/auth/status`, headers: { cookie: newCookie, origin, host: "127.0.0.1" } });
    assert.equal(status.statusCode, 200, status.body);
    const csrfToken = status.json().csrfToken as string;
    restored.headers = { cookie: newCookie, origin, host: "127.0.0.1", "x-csrf-token": csrfToken };
    const preservedAdmin = await restored.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "trial school password" } });
    assert.equal(preservedAdmin.statusCode, 200, "the receiving administrator remains local and can log in");
  }
  const persisted = await readState(restored.app, restored.headers);
  assert.equal(persisted.catalog.groups.find(item => item.id === group.id)?.name, group.name);
  assert.equal(persisted.catalog.teachers.some(item => item.id === substitute.id), true);
  assert.equal(persisted.schedule[candidate!.entry[0]]![candidate!.entry[1].findIndex(day => day.date === candidate!.placement.date)]!.slots[candidate!.placement.slot]!.find(item => item.id === candidate!.placement.lessonId)?.teacherId, sourceId);
  const publishedAfterRestore = await restored.app.inject({ url: `/api/publications/${quarter.id}`, headers: restored.headers });
  assert.equal(publishedAfterRestore.statusCode, 200, publishedAfterRestore.body);
  assert.equal(publishedAfterRestore.json().publication.version, publication.version);
  assert.deepEqual((await restored.app.inject({ url: `/api/public/students/schedule?quarterId=${quarter.id}&groupId=${group.id}` })).json(), publicStudentBeforeDraftEdit);
  assert.deepEqual((await restored.app.inject({ url: `/api/public/teachers/schedule?quarterId=${quarter.id}&teacherId=${sourceId}` })).json(), publicTeacherBeforeDraftEdit);
  const restoredPrint = await restored.app.inject({ method: "POST", url: "/api/schedule-print/preview", headers: restored.headers, payload: { source: "published", quarterId: quarter.id, weekStart, groupIds: [group.id], version: publication.version } });
  assert.equal(restoredPrint.statusCode, 200, restoredPrint.body);
  assert.deepEqual(restoredPrint.json(), printBeforeDraftEdit);
  assert.deepEqual(Object.fromEntries(Object.entries(persisted.schedule).filter(([key]) => !key.startsWith(`${group.id}:`))), otherGroupsBefore, "restoring the backup keeps unaffected class schedules");
}

test("school trial: generate, adjust one day, substitute, publish, print and restore a SQLite backup", async () => runTrialScenario(false));

test("PostgreSQL school trial: generate, adjust one day, substitute, publish, print and restore archive to another owned schema", {
  skip: process.env.SMENA_TEST_DATABASE_URL ? false : "Set SMENA_TEST_DATABASE_URL to run the isolated PostgreSQL trial",
}, async () => runTrialScenario(true));
