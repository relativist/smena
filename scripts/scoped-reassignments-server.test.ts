import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-scoped-reassignments-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") }); apps.push(app);
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "scoped reassignment test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return { app, headers, state: response.json() as StateResponse };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("replacement page and preview endpoints return only their requested data", async () => {
  const { app, headers, state } = await setup();
  const candidate = Object.entries(state.schedule).flatMap(([key, days]) => days.flatMap(day => day.slots.flatMap(slot => slot.filter(lesson => lesson.teacherId).map(lesson => ({ key, date: day.date, lesson })))))[0];
  assert.ok(candidate, "seed schedule contains a lesson");
  const sourceTeacherId = candidate.lesson.teacherId ?? state.catalog.teachers.find(teacher => teacher.subjectIds.includes(candidate.lesson.subjectId))?.id;
  assert.ok(sourceTeacherId);
  const quarter = state.quarters.find(item => item.startDate <= candidate.date && item.endDate >= candidate.date)!;
  const groupId = candidate.key.slice(0, candidate.key.lastIndexOf(":"));
  const availability = await app.inject({ url: `/api/admin/reassignments?availability=1&teacherId=${sourceTeacherId}&startDate=${candidate.date}&endDate=${candidate.date}`, headers });
  assert.equal(availability.statusCode, 200, availability.body);
  assert.ok(availability.json().availableGroupIds.includes(groupId));
  assert.ok(availability.json().availableSubjectIds.includes(candidate.lesson.subjectId));
  const emptyPage = await app.inject({ url: `/api/admin/reassignments?quarterId=${quarter.id}`, headers });
  assert.equal(emptyPage.statusCode, 200, emptyPage.body);
  assert.deepEqual(emptyPage.json().schedule, {});
  assert.ok(emptyPage.json().taughtSubjectIds.includes(candidate.lesson.subjectId));

  const page = await app.inject({ url: `/api/admin/reassignments?quarterId=${quarter.id}&subjectId=${candidate.lesson.subjectId}&groupIds=${groupId}`, headers });
  assert.equal(page.statusCode, 200, page.body);
  const pageData = page.json() as { schedule: StateResponse["schedule"]; revision: number };
  assert.ok(Object.values(pageData.schedule).flat().every(day => day.date >= quarter.startDate && day.date <= quarter.endDate));
  assert.ok(Object.values(pageData.schedule).flat().flatMap(day => day.slots.flat()).every(lesson => lesson.subjectId === candidate.lesson.subjectId));
  assert.ok(Buffer.byteLength(page.body) < Buffer.byteLength((await app.inject({ url: "/api/state", headers })).body));

  const preview = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers,
    payload: { revision: state.revision, request: { mode: "return", sourceTeacherId, returnDate: candidate.date } } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.ok(!("schedule" in preview.json().preview));
  assert.ok(!("catalog" in preview.json().preview));

  const automatic = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview?response=compact", headers,
    payload: { revision: state.revision, request: { teacherId: sourceTeacherId, startDate: candidate.date, endDate: candidate.date } } });
  assert.equal(automatic.statusCode, 200, automatic.body);
  assert.ok(!("schedule" in automatic.json().preview));
});

test("compact reassignment apply and undo persist only the affected dates", async () => {
  const { app, headers, state: initial } = await setup();
  let fixture: { key: string; date: string; lesson: NonNullable<StateResponse["schedule"][string]>[number]["slots"][number][number]; targetId: string; quarterId: string } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    for (const day of days) for (const slot of day.slots) for (const lesson of slot) {
      const quarter = initial.quarters.find(item => item.startDate <= day.date && item.endDate >= day.date);
      if (!quarter || !lesson.teacherId) continue;
      const target = initial.catalog.teachers.find(teacher => teacher.id !== lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(lesson.subjectId));
      if (!target) continue;
      fixture = { key, date: day.date, lesson, targetId: target.id, quarterId: quarter.id }; break;
    }
    if (fixture) break;
  }
  assert.ok(fixture, "seed schedule contains an eligible subject teacher");
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  const sourceDay = sparse[fixture.key]!.find(day => day.date === fixture.date)!;
  const initialDay = initial.schedule[fixture.key]!.find(day => day.date === fixture.date)!;
  const sourceSlot = initialDay.slots.findIndex(slot => slot.some(lesson => lesson.id === fixture!.lesson.id));
  sourceDay.slots[sourceSlot] = [fixture.lesson];
  const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `compact-sparse-${crypto.randomUUID()}` } });
  assert.equal(saved.statusCode, 200, saved.body);
  const state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const request = { mode: "assign", quarterId: fixture.quarterId, subjectId: fixture.lesson.subjectId, sourceTeacherId: fixture.lesson.teacherId, scope: "lesson", lessonId: fixture.lesson.id, targetTeacherId: fixture.targetId, persist: false };
  const preview = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request } });
  assert.equal(preview.statusCode, 200, preview.body);
  const unit = preview.json().preview.units.find((item: { lessonIds: string[]; reason?: string }) => item.lessonIds.includes(fixture!.lesson.id) && !item.reason);
  assert.ok(unit);
  const picked = { ...fixture, unitId: unit.id };
  const apply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=compact", headers,
    payload: { revision: state.revision, requestId: `compact-apply-${crypto.randomUUID()}`, request, expectedUnits: [{ unitId: picked.unitId, teacherId: picked.targetId }] } });
  assert.equal(apply.statusCode, 200, apply.body);
  const compact = apply.json() as { state: StateResponse; operationId: string };
  assert.equal(compact.state.schedule[picked.key]?.find(day => day.date === picked!.date)?.slots.flat().find(lesson => lesson.id === picked!.lesson.id)?.teacherId, picked.targetId);
  assert.ok(Object.values(compact.state.schedule).flat().every(day => day.date === picked!.date));

  const undo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${compact.operationId}/undo?response=compact`, headers,
    payload: { revision: compact.state.revision, requestId: `compact-undo-${crypto.randomUUID()}` } });
  assert.equal(undo.statusCode, 200, undo.body);
  const restored = undo.json().state as StateResponse;
  assert.equal(restored.schedule[picked.key]?.find(day => day.date === picked!.date)?.slots.flat().find(lesson => lesson.id === picked!.lesson.id)?.teacherId, picked.lesson.teacherId);
  const full = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  assert.equal(full.schedule[picked.key]?.find(day => day.date === picked!.date)?.slots.flat().find(lesson => lesson.id === picked!.lesson.id)?.teacherId, picked.lesson.teacherId);

  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const rawBefore = db.prepare("SELECT * FROM lessons ORDER BY id").all();
  const slotsBefore = db.prepare("SELECT * FROM schedule_slots ORDER BY id").all();
  const receiptBody = { revision: full.revision, requestId: `receipt-apply-${crypto.randomUUID()}`, request, expectedUnits: [{ unitId: picked.unitId, teacherId: picked.targetId }] };
  const receiptApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: receiptBody });
  assert.equal(receiptApply.statusCode, 200, receiptApply.body);
  const receipt = receiptApply.json();
  assert.deepEqual(Object.keys(receipt).sort(), ["operationId", "revision", "updatedAt"]);
  assert.equal(receipt.revision, full.revision + 1);
  assert.ok(Buffer.byteLength(receiptApply.body) < 200);
  assert.deepEqual(db.prepare("SELECT * FROM schedule_slots ORDER BY id").all(), slotsBefore, "reassignment must retain physical slots");
  const stored = db.prepare("SELECT previous_schedule_json FROM teacher_reassignment_operations WHERE operation_id=?").get(receipt.operationId) as { previous_schedule_json: string };
  const snapshot = JSON.parse(stored.previous_schedule_json);
  assert.equal(snapshot.format, "teacher-reassignment-v2");
  assert.deepEqual(snapshot.teachers.map((teacher: { id: string }) => teacher.id), [picked.lesson.id]);
  const receiptReplay = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: receiptBody });
  assert.deepEqual(receiptReplay.json(), receipt);
  const stale = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: full.revision, request } });
  assert.equal(stale.statusCode, 409, "cached preview must check the current revision");
  const undoBody = { revision: receipt.revision, requestId: `receipt-undo-${crypto.randomUUID()}` };
  const receiptUndo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${receipt.operationId}/undo?response=receipt`, headers, payload: undoBody });
  assert.equal(receiptUndo.statusCode, 200, receiptUndo.body);
  assert.deepEqual(Object.keys(receiptUndo.json()).sort(), ["revision", "updatedAt"]);
  assert.deepEqual(db.prepare("SELECT * FROM lessons ORDER BY id").all(), rawBefore, "undo must restore exact original fields and slot references");
  const undoReplay = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${receipt.operationId}/undo?response=receipt`, headers, payload: undoBody });
  assert.deepEqual(undoReplay.json(), receiptUndo.json());

  // Already saved v1 journals remain undoable after the new release.
  const legacyApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers,
    payload: { ...receiptBody, revision: receiptUndo.json().revision, requestId: `legacy-apply-${crypto.randomUUID()}` } });
  assert.equal(legacyApply.statusCode, 200, legacyApply.body);
  db.prepare("UPDATE teacher_reassignment_operations SET previous_schedule_json=? WHERE operation_id=?").run(JSON.stringify(full.schedule), legacyApply.json().operationId);
  const legacyUndo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${legacyApply.json().operationId}/undo?response=receipt`, headers,
    payload: { revision: legacyApply.json().revision, requestId: `legacy-undo-${crypto.randomUUID()}` } });
  assert.equal(legacyUndo.statusCode, 200, legacyUndo.body);
  const legacyState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  assert.deepEqual(legacyState.schedule, full.schedule);
});

test("a permanent reassignment keeps its selected anchors and later stream lessons in scope", async () => {
  const { app, headers, state: initial } = await setup();
  const located = Object.entries(initial.schedule).flatMap(([key, days]) => days.flatMap((day, dayIndex) => day.slots.flatMap((slot, slotIndex) => slot.map(lesson => ({ key, day, dayIndex, slotIndex, lesson })))));
  const streams = new Map<string, typeof located>();
  for (const item of located) {
    if (!item.lesson.teacherId) continue;
    const groupId = item.key.slice(0, item.key.lastIndexOf(":"));
    const streamKey = [groupId, item.lesson.subjectId, item.lesson.teacherId].join("\0");
    const list = streams.get(streamKey) ?? [];
    list.push(item);
    streams.set(streamKey, list);
  }
  const selectedStream = [...streams.entries()].find(([streamKey, items]) => {
    const [, subjectId, sourceId] = streamKey.split("\0");
    return items.length > 1 && initial.catalog.teachers.some(teacher => teacher.id !== sourceId && !teacher.archived && teacher.subjectIds.includes(subjectId!));
  });
  assert.ok(selectedStream, "seed contains a group stream with multiple lessons and an eligible subject teacher");
  const [streamKey, stream] = selectedStream;
  const [groupId, subjectId, sourceTeacherId] = streamKey.split("\0");
  const target = initial.catalog.teachers.find(teacher => teacher.id !== sourceTeacherId && !teacher.archived && teacher.subjectIds.includes(subjectId!))!;
  const quarter = initial.quarters.find(item => item.startDate <= stream[0]!.day.date && item.endDate >= stream[0]!.day.date)!;
  const anchors = stream.slice(0, 2);
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  for (const item of anchors) sparse[item.key]!.find(day => day.date === item.day.date)!.slots[item.slotIndex] = [item.lesson];
  const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `permanent-sparse-${crypto.randomUUID()}` } });
  assert.equal(saved.statusCode, 200, saved.body);
  const state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const request = { mode: "assign", quarterId: quarter.id, subjectId, sourceTeacherId, groupIds: [groupId!], scope: "period", startDate: quarter.startDate, endDate: null, lessonIds: anchors.map(item => item.lesson.id), targetTeacherId: target.id, persist: true };
  const preview = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request } });
  assert.equal(preview.statusCode, 200, preview.body);
  const units = preview.json().preview.units as Array<{ id: string; lessonIds: string[]; teacherId?: string; reason?: string }>;
  assert.ok(anchors.every(anchor => units.some(unit => unit.lessonIds.includes(anchor.lesson.id) && !unit.reason)), "permanent scope retains selected lesson anchors");
  const expectedUnits = units.filter(unit => unit.teacherId === target.id && !unit.reason).map(unit => ({ unitId: unit.id, teacherId: target.id }));
  assert.ok(expectedUnits.length >= 2, "future matching lessons are part of permanent scope");
  const groupOnly = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers,
    payload: { revision: state.revision, request: { ...request, sourceTeacherId: undefined, lessonIds: undefined } } });
  assert.equal(groupOnly.statusCode, 200, groupOnly.body);
  assert.deepEqual(groupOnly.json().preview.units, units, "group/subject scope discovers its anchors without an explicit teacher or lesson list");
  const lessonList = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers,
    payload: { revision: state.revision, request: { mode: "assign", quarterId: quarter.id, subjectId, groupIds: [groupId], scope: "lesson", lessonIds: [anchors[0]!.lesson.id], targetTeacherId: target.id, persist: false } } });
  assert.equal(lessonList.statusCode, 200, lessonList.body);
  assert.equal(lessonList.json().preview.units.length, 1);
  assert.deepEqual(lessonList.json().preview.units[0].lessonIds, [anchors[0]!.lesson.id]);
  const applied = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=compact", headers,
    payload: { revision: state.revision, requestId: `permanent-apply-${crypto.randomUUID()}`, request, expectedUnits } });
  assert.equal(applied.statusCode, 200, applied.body);
  const after = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const changed = new Set(expectedUnits.flatMap(unit => units.find(value => value.id === unit.unitId)!.lessonIds));
  assert.ok([...changed].every(lessonId => Object.values(after.schedule).flat().flatMap(day => day.slots.flat()).find(lesson => lesson.id === lessonId)?.teacherId === target.id));
});
