import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-auto-replacement-")); roots.push(root);
  const dbPath = join(root, "draft.sqlite");
  const app = await buildApp({ dbPath }); apps.push(app);
  let auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "automatic replacement test password" } });
  if (auth.statusCode !== 200) auth = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "automatic replacement test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const response = await app.inject({ url: "/api/state", headers }); assert.equal(response.statusCode, 200, response.body);
  return { app, headers, dbPath, state: response.json() as StateResponse };
}
function firstReplaceable(state: StateResponse) {
  for (const [key, days] of Object.entries(state.schedule)) for (const [dayIndex, day] of days.entries())
    for (const [slotIndex, slot] of day.slots.entries()) for (const lesson of slot) {
      const teacher = state.catalog.teachers.find((item) => item.id === lesson.teacherId);
      const substitute = state.catalog.teachers.find((item) => !item.archived && item.id !== teacher?.id && item.subjectIds.includes(lesson.subjectId));
      if (!teacher || !substitute || !lesson.roomId || lesson.jointId) continue;
      return { key, dayIndex, slotIndex, day, slotTime: day.times[slotIndex]!, lesson, teacher, substitute };
    }
  throw new Error("Seed data does not have a replaceable lesson");
}
function makeJointAndBlockedFixture(state: StateResponse) {
  const quarter = state.quarters[0]!;
  const groups = state.catalog.groups.filter((group) => !group.archived && state.studyPlans.some((plan) =>
    plan.quarterId === quarter.id && plan.groupId === group.id && plan.subjectId === "math" && plan.mode === "whole" &&
    plan.assignments.some((assignment) => assignment.subgroupId === null)));
  assert.ok(groups.length >= 2, "fixture needs two full groups with math plans");
  const selected = groups.slice(0, 2);
  const subject = state.catalog.subjects.find((entry) => entry.id === "math"); assert.ok(subject);
  subject.jointGroupSets = [...(subject.jointGroupSets ?? []), selected.map((group) => group.id)];
  subject.maxJointGroups = Math.max(subject.maxJointGroups ?? 2, 2);
  const teachers = [
    { id: "teacher:f2-joint-source", name: "Тестовый источник замены", subjectIds: ["math"], defaultRoomId: null, archived: false },
    { id: "teacher:f2-joint-candidate-a", name: "Кандидат А замены", subjectIds: ["math"], defaultRoomId: null, archived: false },
    { id: "teacher:f2-joint-candidate-b", name: "Кандидат Б замены", subjectIds: ["math"], defaultRoomId: null, archived: false },
    { id: "teacher:f2-joint-unqualified", name: "Не математик замены", subjectIds: ["biology"], defaultRoomId: null, archived: false },
  ];
  state.catalog.teachers.push(...teachers);
  const totalStudents = selected.reduce((sum, group) => sum + group.students, 0);
  const rooms = [
    { id: "room:f2-joint-large", name: "Большой зал F2", capacity: totalStudents, kind: subject.roomKind ?? "general", archived: false },
    { id: "room:f2-joint-closed", name: "Закрытая аудитория F2", capacity: selected[0]!.students, kind: subject.roomKind ?? "general", archived: false },
    { id: "room:f2-joint-small", name: "Маленькая аудитория F2", capacity: selected[0]!.students, kind: subject.roomKind ?? "general", archived: false },
  ] as StateResponse["catalog"]["rooms"];
  state.catalog.rooms.push(...rooms);

  let fixture: { date: string; offset: number; jointSlot: number; blockedSlot: number; capacitySlot: number } | undefined;
  const offsets = [...new Set(Object.keys(state.schedule).map((key) => Number(key.slice(key.lastIndexOf(":") + 1))))];
  for (const offset of offsets) {
    const groupDays = selected.map((group) => state.schedule[`${group.id}:${offset}`] ?? []);
    const dates = groupDays[0]!.filter((day) => day.date >= quarter.startDate && day.date <= quarter.endDate).map((day) => day.date);
    for (const date of dates) {
      const days = groupDays.map((days) => days.find((day) => day.date === date));
      if (days.some((day) => !day) || days.some((day) => day!.times.length < 3)) continue;
      const first = days[0]!;
      for (let jointSlot = 0; jointSlot < first.times.length; jointSlot += 1) {
        const jointTime = first.times[jointSlot]!;
        if (days.some((day) => day!.times[jointSlot]?.start !== jointTime.start || day!.times[jointSlot]?.duration !== jointTime.duration)) continue;
        const blockedSlot = first.times.findIndex((time, index) => index > jointSlot && days.every((day) => day!.times[index]?.start === time.start && day!.times[index]?.duration === time.duration));
        const capacitySlot = first.times.findIndex((time, index) => index > blockedSlot && days.every((day) => day!.times[index]?.start === time.start && day!.times[index]?.duration === time.duration));
        if (blockedSlot >= 0 && capacitySlot >= 0) { fixture = { date, offset, jointSlot, blockedSlot, capacitySlot }; break; }
      }
      if (fixture) break;
    }
    if (fixture) break;
  }
  assert.ok(fixture, "fixture needs two aligned lesson times on one date");
  const schedule = structuredClone(state.schedule);
  for (const days of Object.values(schedule)) for (const day of days) day.slots = day.slots.map(() => []);
  const jointId = "f2-joint-unit";
  for (const [index, group] of selected.entries()) {
    const day = schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture!.date)!;
    day.slots[fixture.jointSlot]!.push({ id: `f2-joint-mirror-${index}`, subjectId: "math", lessonKind: "regular", teacherId: teachers[0]!.id, teacher: teachers[0]!.name, roomId: rooms[0]!.id, room: rooms[0]!.name, jointId, note: `joint mirror ${index}` });
  }
  const firstGroupDay = schedule[`${selected[0]!.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture!.date)!;
  firstGroupDay.slots[fixture.blockedSlot]!.push({ id: "f2-blocked-unit", subjectId: "math", lessonKind: "regular", teacherId: teachers[0]!.id, teacher: teachers[0]!.name, roomId: rooms[1]!.id, room: rooms[1]!.name, note: "closed-room skipped unit" });
  firstGroupDay.slots[fixture.capacitySlot]!.push({ id: "f2-capacity-unit", subjectId: "math", lessonKind: "regular", teacherId: teachers[0]!.id, teacher: teachers[0]!.name, roomId: rooms[2]!.id, room: rooms[2]!.name, note: "inherited insufficient-capacity unit" });
  return { schedule, groups: selected, teachers, rooms, date: fixture.date, offset: fixture.offset, jointSlot: fixture.jointSlot, blockedSlot: fixture.blockedSlot, capacitySlot: fixture.capacitySlot, jointId };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("automatic teacher replacement is protected, recomputed, persisted and undoable as one revisioned action", async () => {
  const { app, headers, dbPath, state: initial } = await setup();
  const chosen = firstReplaceable(initial);
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  sparse[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex] = [chosen.lesson];
  const saveSparse = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `auto-sparse-${crypto.randomUUID()}` } });
  assert.equal(saveSparse.statusCode, 200, saveSparse.body);
  let stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  let state = stateResponse.json() as StateResponse;
  const catalog = structuredClone(state.catalog);
  catalog.teachers.find((teacher) => teacher.id === chosen.teacher.id)!.unavailability = [{
    id: "sick-leave-f2-test", startDate: chosen.day.date, endDate: chosen.day.date,
    start: chosen.slotTime.start, end: chosen.slotTime.start + chosen.slotTime.duration, reason: "Больничный",
  }];
  const saveCatalog = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: state.revision, requestId: `auto-catalog-${crypto.randomUUID()}` } });
  assert.equal(saveCatalog.statusCode, 200, saveCatalog.body); state = saveCatalog.json() as StateResponse;
  const replacementRequest = { teacherId: chosen.teacher.id, startDate: chosen.day.date, endDate: chosen.day.date, ruleId: "sick-leave-f2-test" };
  const noCsrf = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers: { cookie: headers.cookie, origin, host: "127.0.0.1" }, payload: { revision: state.revision, request: replacementRequest } });
  assert.equal(noCsrf.statusCode, 403);
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers, payload: { revision: state.revision, request: replacementRequest } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview;
  assert.equal(preview.units.length, 1);
  assert.equal(typeof preview.units[0].teacherId, "string");
  const proposed = [{ unitId: preview.units[0].id as string, teacherId: preview.units[0].teacherId as string }];
  const forged = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: state.revision, requestId: `auto-forged-${crypto.randomUUID()}`, request: replacementRequest, expectedAssignments: [{ ...proposed[0], teacherId: chosen.teacher.id }] } });
  assert.equal(forged.statusCode, 409);
  const stale = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: state.revision - 1, requestId: `auto-stale-${crypto.randomUUID()}`, request: replacementRequest, expectedAssignments: proposed } });
  assert.equal(stale.statusCode, 409);
  const applyId = `auto-apply-${crypto.randomUUID()}`;
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const publicationQuarterId = state.quarters[0]!.id;
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json) VALUES(?,?,?,?,?,?,?)`)
    .run(publicationQuarterId, 1, new Date().toISOString(), state.revision, "test", JSON.stringify(createPublicationSnapshot(state, publicationQuarterId)), JSON.stringify({}));
  const publicationBefore = db.prepare("SELECT snapshot_json,summary_json,version FROM published_quarters WHERE quarter_id=?").get(publicationQuarterId);
  const applied = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply?response=receipt", headers, payload: { revision: state.revision, requestId: applyId, request: replacementRequest, expectedAssignments: proposed } });
  assert.equal(applied.statusCode, 200, applied.body);
  const applyBody = applied.json() as { revision: number; updatedAt: string; operationId: string };
  assert.deepEqual(Object.keys(applyBody).sort(), ["operationId", "revision", "updatedAt"]);
  assert.equal(applyBody.revision, state.revision + 1);
  assert.ok(Buffer.byteLength(applied.body) < 400, "a receipt must not contain the school state");
  assert.deepEqual(JSON.parse((db.prepare("SELECT apply_response_json FROM teacher_replacement_operations WHERE operation_id=?").get(applyBody.operationId) as { apply_response_json: string }).apply_response_json), applyBody);
  const teacherJournal = JSON.parse((db.prepare("SELECT previous_schedule_json FROM teacher_replacement_operations WHERE operation_id=?").get(applyBody.operationId) as { previous_schedule_json: string }).previous_schedule_json);
  assert.equal(teacherJournal.format, "teacher-reassignment-v2");
  assert.deepEqual(teacherJournal.teachers.map((teacher: { id: string }) => teacher.id), [chosen.lesson.id]);
  state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const changed = state.schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0]!;
  assert.equal(changed.teacherId, proposed[0]!.teacherId);
  assert.equal(state.schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0]!.roomId, chosen.lesson.roomId);
  assert.equal(state.temporaryTeacherReplacements?.length, 1);
  assert.deepEqual(db.prepare("SELECT snapshot_json,summary_json,version FROM published_quarters WHERE quarter_id=?").get(publicationQuarterId), publicationBefore);
  await app.close(); apps.splice(apps.indexOf(app), 1);
  const reopened = await buildApp({ dbPath }); apps.push(reopened);
  const login = await reopened.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "automatic replacement test password" } });
  assert.equal(login.statusCode, 200, login.body);
  const reopenedCookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const reopenedHeaders = { cookie: reopenedCookie, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
  const persistedState = await reopened.inject({ url: "/api/state", headers: reopenedHeaders });
  assert.equal(persistedState.statusCode, 200, persistedState.body);
  assert.deepEqual((persistedState.json() as StateResponse).temporaryTeacherReplacements, state.temporaryTeacherReplacements);
  const reopenedApplyReplay = await reopened.inject({ method: "POST", url: "/api/teacher-replacements/apply?response=receipt", headers: reopenedHeaders, payload: { revision: state.revision - 1, requestId: applyId, request: replacementRequest, expectedAssignments: proposed } });
  assert.equal(reopenedApplyReplay.statusCode, 200); assert.deepEqual(reopenedApplyReplay.json(), applyBody);
  const applyReplay = reopenedApplyReplay;
  assert.equal(applyReplay.statusCode, 200); assert.equal(applyReplay.json().operationId, applyBody.operationId);

  const manualRestore = structuredClone(state.schedule);
  manualRestore[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0] = chosen.lesson;
  const ordinarySave = await reopened.inject({ method: "PUT", url: "/api/state", headers: reopenedHeaders, payload: { schedule: manualRestore, revision: state.revision, requestId: `auto-ordinary-${crypto.randomUUID()}` } });
  assert.equal(ordinarySave.statusCode, 400, "ordinary state writes still reject assigning the unavailable source teacher");
  const undoId = `auto-undo-${crypto.randomUUID()}`;
  const undone = await reopened.inject({ method: "POST", url: `/api/teacher-replacements/${applyBody.operationId}/undo?response=receipt`, headers: reopenedHeaders, payload: { revision: state.revision, requestId: undoId } });
  assert.equal(undone.statusCode, 200, undone.body);
  const undoReceipt = undone.json() as { revision: number; updatedAt: string };
  assert.deepEqual(Object.keys(undoReceipt).sort(), ["revision", "updatedAt"]);
  assert.equal(undoReceipt.revision, applyBody.revision + 1);
  assert.ok(Buffer.byteLength(undone.body) < 400);
  const undoState = (await reopened.inject({ url: "/api/state", headers: reopenedHeaders })).json() as StateResponse;
  const reopenedDb = (reopened as unknown as { smenaDb: Database.Database }).smenaDb;
  assert.deepEqual(reopenedDb.prepare("SELECT snapshot_json,summary_json,version FROM published_quarters WHERE quarter_id=?").get(publicationQuarterId), publicationBefore);
  assert.equal(undoState.schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0]!.teacherId, chosen.teacher.id);
  assert.deepEqual(undoState.temporaryTeacherReplacements, []);
  const undoReplay = await reopened.inject({ method: "POST", url: `/api/teacher-replacements/${applyBody.operationId}/undo?response=receipt`, headers: reopenedHeaders, payload: { revision: undoState.revision - 1, requestId: undoId } });
  assert.equal(undoReplay.statusCode, 200); assert.deepEqual(undoReplay.json(), undone.json());
  const anotherEdit = await reopened.inject({ method: "PUT", url: "/api/catalog", headers: reopenedHeaders, payload: { catalog: undoState.catalog, revision: undoState.revision, requestId: `auto-edit-${crypto.randomUUID()}` } });
  assert.equal(anotherEdit.statusCode, 200);
  const tooLate = await reopened.inject({ method: "POST", url: `/api/teacher-replacements/${applyBody.operationId}/undo`, headers: reopenedHeaders, payload: { revision: (anotherEdit.json() as StateResponse).revision, requestId: `auto-undo-late-${crypto.randomUUID()}` } });
  assert.equal(tooLate.statusCode, 409);
});

test("joint replacements apply every mirror, skip a closed-room unit, and undo against inherited room issues", async () => {
  const { app, headers, state: initial } = await setup();
  const fixture = makeJointAndBlockedFixture(initial);
  const catalogSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: initial.catalog, revision: initial.revision, requestId: `auto-joint-catalog-${crypto.randomUUID()}` } });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  const afterCatalog = await app.inject({ url: "/api/state", headers });
  let state = afterCatalog.json() as StateResponse;
  const scheduleSave = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: fixture.schedule, revision: state.revision, requestId: `auto-joint-schedule-${crypto.randomUUID()}` } });
  assert.equal(scheduleSave.statusCode, 200, scheduleSave.body);
  const currentStateResponse = await app.inject({ url: "/api/state", headers });
  state = currentStateResponse.json() as StateResponse;
  const firstGroup = fixture.groups[0]!;
  const jointTime = state.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.times[fixture.jointSlot]!;
  const blockedTime = state.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.times[fixture.blockedSlot]!;
  const capacityTime = state.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.times[fixture.capacitySlot]!;
  const changedCatalog = structuredClone(state.catalog);
  changedCatalog.teachers.find((teacher) => teacher.id === fixture.teachers[0]!.id)!.unavailability = [{ id: "f2-source-sick", startDate: fixture.date, endDate: fixture.date, start: jointTime.start, end: capacityTime.start + capacityTime.duration, reason: "Больничный" }];
  changedCatalog.rooms.find((room) => room.id === fixture.rooms[1]!.id)!.unavailability = [{ id: "f2-room-closed", startDate: fixture.date, endDate: fixture.date, start: blockedTime.start, end: blockedTime.start + blockedTime.duration, reason: "Закрыто" }];
  changedCatalog.rooms.find((room) => room.id === fixture.rooms[2]!.id)!.capacity = 1;
  const rulesSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: changedCatalog, revision: state.revision, requestId: `auto-joint-rules-${crypto.randomUUID()}` } });
  assert.equal(rulesSave.statusCode, 200, rulesSave.body);
  const latestState = await app.inject({ url: "/api/state", headers });
  state = latestState.json() as StateResponse;
  const replacementRequest = { teacherId: fixture.teachers[0]!.id, startDate: fixture.date, endDate: fixture.date, ruleId: "f2-source-sick" };
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers, payload: { revision: state.revision, request: replacementRequest } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview as { units: Array<{ id: string; lessonIds: string[]; groupIds: string[]; teacherId?: string; reason?: string }> };
  const jointUnit = preview.units.find((unit) => unit.lessonIds.includes("f2-joint-mirror-0"));
  const blockedUnit = preview.units.find((unit) => unit.lessonIds.includes("f2-blocked-unit"));
  const capacityUnit = preview.units.find((unit) => unit.lessonIds.includes("f2-capacity-unit"));
  assert.ok(jointUnit?.teacherId, JSON.stringify(preview.units));
  assert.equal(jointUnit!.lessonIds.length, 2, "both joint mirrors are one replacement unit");
  assert.equal(jointUnit!.groupIds.length, 2);
  assert.ok(fixture.teachers.slice(1, 3).some((teacher) => teacher.id === jointUnit!.teacherId), "a qualified teacher must be selected");
  assert.equal(fixture.teachers[3]!.subjectIds.includes("math"), false, "an unqualified teacher must not be proposed");
  assert.equal(state.catalog.rooms.find((room) => room.id === fixture.rooms[0]!.id)!.capacity, fixture.groups.reduce((sum, group) => sum + group.students, 0), "joint room capacity covers both groups");
  assert.ok(blockedUnit?.reason?.includes("недоступен"), JSON.stringify(blockedUnit));
  assert.equal(blockedUnit!.teacherId, undefined);
  assert.ok(capacityUnit?.reason, `a room below lesson capacity must block automatic replacement: ${JSON.stringify(preview.units)}`);
  assert.equal(capacityUnit!.teacherId, undefined);

  const changedCandidate = structuredClone(state.catalog);
  const pickedTeacher = changedCandidate.teachers.find((teacher) => teacher.id === jointUnit!.teacherId)!;
  pickedTeacher.unavailability = [{ id: "f2-candidate-now-sick", startDate: fixture.date, endDate: fixture.date, start: jointTime.start, end: jointTime.start + jointTime.duration, reason: "Недоступен" }];
  const candidateSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: changedCandidate, revision: state.revision, requestId: `auto-joint-candidate-${crypto.randomUUID()}` } });
  assert.equal(candidateSave.statusCode, 200, candidateSave.body);
  const recomputeState = await app.inject({ url: "/api/state", headers });
  const refreshedState = recomputeState.json() as StateResponse;
  const staleChoices = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: refreshedState.revision, requestId: `auto-joint-stale-choice-${crypto.randomUUID()}`, request: replacementRequest, expectedAssignments: [{ unitId: jointUnit!.id, teacherId: jointUnit!.teacherId! }] } });
  assert.equal(staleChoices.statusCode, 409, "the server rejects a reviewed assignment after recomputing a changed candidate list");
  const refreshedPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers, payload: { revision: refreshedState.revision, request: replacementRequest } });
  const refreshedPreview = refreshedPreviewResponse.json().preview as typeof preview;
  const refreshedJoint = refreshedPreview.units.find((unit) => unit.lessonIds.includes("f2-joint-mirror-0"));
  assert.ok(refreshedJoint?.teacherId && refreshedJoint.teacherId !== jointUnit!.teacherId);
  const operationRequestId = `auto-joint-apply-${crypto.randomUUID()}`;
  const applied = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: refreshedState.revision, requestId: operationRequestId, request: replacementRequest, expectedAssignments: [{ unitId: refreshedJoint!.id, teacherId: refreshedJoint!.teacherId! }] } });
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedState = (applied.json() as { state: StateResponse; operationId: string }).state;
  const appliedOperation = applied.json() as { state: StateResponse; operationId: string };
  for (const group of fixture.groups) {
    const lesson = appliedState.schedule[`${group.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.jointSlot]![0]!;
    assert.equal(lesson.teacherId, refreshedJoint!.teacherId, "every joint mirror changes together");
    assert.equal(lesson.jointId, fixture.jointId);
  }
  assert.equal(appliedState.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.blockedSlot]![0]!.teacherId, fixture.teachers[0]!.id, "infeasible unit stays with source awaiting attention");
  assert.equal(appliedState.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.capacitySlot]![0]!.teacherId, fixture.teachers[0]!.id, "capacity-blocked unit remains unchanged");

  // Already persisted operations may still carry the pre-v2 Schedule journal.
  // Exercise this real legacy representation through the same validated undo.
  const operationDb = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const legacySchedule = Object.fromEntries(Object.entries(refreshedState.schedule)
    .map(([key, days]) => [key, days.filter(day => day.date === fixture.date)] as const).filter(([, days]) => days.length));
  operationDb.prepare("UPDATE teacher_replacement_operations SET previous_schedule_json=? WHERE operation_id=?")
    .run(JSON.stringify(legacySchedule), appliedOperation.operationId);
  const undo = await app.inject({ method: "POST", url: `/api/teacher-replacements/${appliedOperation.operationId}/undo`, headers, payload: { revision: appliedState.revision, requestId: `auto-joint-undo-${crypto.randomUUID()}` } });
  assert.equal(undo.statusCode, 200, undo.body);
  const undoneState = (undo.json() as { state: StateResponse }).state;
  for (const group of fixture.groups) {
    const lesson = undoneState.schedule[`${group.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.jointSlot]![0]!;
    assert.equal(lesson.teacherId, fixture.teachers[0]!.id, "undo restores both original joint mirrors");
  }
  assert.equal(undoneState.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.blockedSlot]![0]!.teacherId, fixture.teachers[0]!.id);
  assert.equal(undoneState.schedule[`${firstGroup.id}:${fixture.offset}`]!.find((day) => day.date === fixture.date)!.slots[fixture.capacitySlot]![0]!.teacherId, fixture.teachers[0]!.id, "undo preserves an unrelated inherited capacity issue");

  const appliedAgain = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: undoneState.revision, requestId: `auto-joint-apply-again-${crypto.randomUUID()}`, request: replacementRequest, expectedAssignments: [{ unitId: refreshedJoint!.id, teacherId: refreshedJoint!.teacherId! }] } });
  assert.equal(appliedAgain.statusCode, 200, appliedAgain.body);
  const secondOperation = appliedAgain.json() as { state: StateResponse; operationId: string };
  const interveningCatalogSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog: secondOperation.state.catalog, revision: secondOperation.state.revision, requestId: `auto-joint-after-edit-${crypto.randomUUID()}` } });
  assert.equal(interveningCatalogSave.statusCode, 200, interveningCatalogSave.body);
  const blockedUndo = await app.inject({ method: "POST", url: `/api/teacher-replacements/${secondOperation.operationId}/undo`, headers, payload: { revision: (interveningCatalogSave.json() as StateResponse).revision, requestId: `auto-joint-too-late-${crypto.randomUUID()}` } });
  assert.equal(blockedUndo.statusCode, 409, "any later catalogue edit prevents undo of the earlier replacement");
});
