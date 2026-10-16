import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-teacher-reassignment-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") }); apps.push(app);
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "teacher reassignment test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return { app, headers, state: response.json() as StateResponse };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("teacher reassignment records an absence origin and early return restores only the future lesson", async () => {
  const { app, headers, state: initial } = await setup();
  const today = new Date().toLocaleDateString("sv-SE");
  let selected: { key: string; index: number; slot: number; date: string; start: number; duration: number; lesson: NonNullable<StateResponse["schedule"][string]>[number]["slots"][number][number]; groupId: string; sourceId: string; targetId: string } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const [index, day] of days.entries()) {
      if (day.date < today) continue;
      for (const [slot, lessons] of day.slots.entries()) for (const lesson of lessons) {
        const source = initial.catalog.teachers.find((teacher) => teacher.id === lesson.teacherId);
        const target = initial.catalog.teachers.find((teacher) => teacher.id !== lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(lesson.subjectId));
        const quarter = initial.quarters.find((item) => item.startDate <= day.date && item.endDate >= day.date);
        if (source && target && quarter && day.times[slot]) { selected = { key, index, slot, date: day.date, start: day.times[slot]!.start, duration: day.times[slot]!.duration, lesson, groupId, sourceId: source.id, targetId: target.id }; break; }
      }
      if (selected) break;
    }
    if (selected) break;
  }
  assert.ok(selected, "fixture needs a future lesson with an eligible substitute");
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  sparse[selected.key]![selected.index]!.slots[selected.slot] = [selected.lesson];
  const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `reassign-sparse-${crypto.randomUUID()}` } });
  assert.equal(saved.statusCode, 200, saved.body);
  let state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const ruleId = "reassign-illness";
  const catalog = structuredClone(state.catalog);
  catalog.teachers.find((teacher) => teacher.id === selected!.sourceId)!.unavailability = [{ id: ruleId, startDate: selected!.date, endDate: selected!.date.slice(0, 8) + String(Number(selected!.date.slice(8)) + 3).padStart(2, "0"), start: selected!.start, end: selected!.start + selected!.duration, reason: "Больничный" }];
  const savedCatalog = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: state.revision, requestId: `reassign-rule-${crypto.randomUUID()}` } });
  assert.equal(savedCatalog.statusCode, 200, savedCatalog.body); state = savedCatalog.json() as StateResponse;
  const quarter = state.quarters.find((item) => item.startDate <= selected!.date && item.endDate >= selected!.date)!;
  const assignRequest = { mode: "assign", quarterId: quarter.id, subjectId: selected.lesson.subjectId, sourceTeacherId: selected.sourceId, groupIds: [selected.groupId], scope: "lesson", lessonId: selected.lesson.id, targetTeacherId: selected.targetId, persist: false };
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: assignRequest } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview;
  const unit = preview.units.find((item: { lessonIds: string[] }) => item.lessonIds.includes(selected!.lesson.id));
  assert.equal(unit.teacherId, selected.targetId);
  const applied = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: `reassign-apply-${crypto.randomUUID()}`, request: assignRequest, expectedUnits: [{ unitId: unit.id, teacherId: selected.targetId }] } });
  assert.equal(applied.statusCode, 200, applied.body); state = (applied.json() as { state: StateResponse }).state;
  assert.equal(state.teacherLessonOrigins?.find((item) => item.lessonId === selected!.lesson.id)?.sourceTeacherId, selected.sourceId);
  assert.equal(state.schedule[selected.key]![selected.index]!.slots[selected.slot]![0]!.teacherId, selected.targetId);

  const returnRequest = { mode: "return", sourceTeacherId: selected.sourceId, returnDate: selected.date, ruleId };
  const returnPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: returnRequest } });
  assert.equal(returnPreviewResponse.statusCode, 200, returnPreviewResponse.body);
  const returnPreview = returnPreviewResponse.json().preview;
  const returnUnit = returnPreview.units.find((item: { lessonIds: string[] }) => item.lessonIds.includes(selected!.lesson.id));
  assert.equal(returnUnit.teacherId, selected.sourceId);
  assert.equal(returnPreview.ruleChanged, true);
  const returnRequestId = `reassign-return-${crypto.randomUUID()}`;
  const returned = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: returnRequestId, request: returnRequest, expectedUnits: [{ unitId: returnUnit.id, teacherId: selected.sourceId }] } });
  assert.equal(returned.statusCode, 200, returned.body);
  state = (returned.json() as { state: StateResponse }).state;
  assert.equal(state.schedule[selected.key]![selected.index]!.slots[selected.slot]![0]!.teacherId, selected.sourceId);
  const remainingRule = state.catalog.teachers.find((teacher) => teacher.id === selected!.sourceId)!.unavailability?.find((rule) => rule.id === ruleId);
  assert.ok(!remainingRule || remainingRule.endDate < selected!.date, "the absence must end before the return date");
  assert.equal(state.teacherLessonOrigins?.find((item) => item.lessonId === selected!.lesson.id)?.status, "returned");
  const undoRequestId = `reassign-undo-${crypto.randomUUID()}`;
  const undone = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${(returned.json() as { operationId: string }).operationId}/undo`, headers, payload: { revision: state.revision, requestId: undoRequestId } });
  assert.equal(undone.statusCode, 200, undone.body);
  const restored = (undone.json() as { state: StateResponse }).state;
  assert.equal(restored.schedule[selected.key]![selected.index]!.slots[selected.slot]![0]!.teacherId, selected.targetId);
  assert.equal(restored.catalog.teachers.find((teacher) => teacher.id === selected!.sourceId)!.unavailability?.find((rule) => rule.id === ruleId)?.startDate, selected.date);
  assert.equal(restored.teacherLessonOrigins?.find((item) => item.lessonId === selected!.lesson.id)?.status, "active");
  const replay = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${(returned.json() as { operationId: string }).operationId}/undo`, headers, payload: { revision: restored.revision - 1, requestId: undoRequestId } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), undone.json());
  const manuallyEdited = structuredClone(restored.schedule);
  manuallyEdited[selected.key]![selected.index]!.slots[selected.slot]![0]!.note = "Ручная правка после замены";
  const manualSave = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: manuallyEdited, revision: restored.revision, requestId: `reassign-manual-${crypto.randomUUID()}` } });
  assert.equal(manualSave.statusCode, 200, manualSave.body);
  const manualState = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  assert.equal(manualState.teacherLessonOrigins?.find((item) => item.lessonId === selected!.lesson.id)?.status, "manual");
  const manualReturn = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: manualState.revision, request: returnRequest } });
  assert.equal(manualReturn.statusCode, 200, manualReturn.body);
  assert.ok(manualReturn.json().preview.skipped.some((item: { lessonId: string }) => item.lessonId === selected!.lesson.id));
  assert.ok(!manualReturn.json().preview.changedLessonIds.includes(selected.lesson.id));
});

test("partial persisted transfer does not create a policy for an unselected lesson in the same stream", async () => {
  const { app, headers, state: initial } = await setup();
  const today = new Date().toLocaleDateString("sv-SE");
  let chosen: { key: string; dayIndex: number; slotIndex: number; date: string; groupId: string; sourceId: string; targetId: string; lesson: StateResponse["schedule"][string][number]["slots"][number][number] } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const [dayIndex, day] of days.entries()) {
      if (day.date < today) continue;
      for (const [slotIndex, slot] of day.slots.entries()) for (const lesson of slot) {
        const source = initial.catalog.teachers.find((teacher) => teacher.id === lesson.teacherId);
        const target = initial.catalog.teachers.find((teacher) => teacher.id !== lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(lesson.subjectId));
        if (source && target) { chosen = { key, dayIndex, slotIndex, date: day.date, groupId, sourceId: source.id, targetId: target.id, lesson }; break; }
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  assert.ok(chosen, "fixture needs an eligible future lesson");
  const quarter = initial.quarters.find((item) => item.startDate <= chosen!.date && item.endDate >= chosen!.date)!;
  const allDays = Object.entries(initial.schedule).flatMap(([key, days]) => key.startsWith(`${chosen!.groupId}:`) ? days.map((day, dayIndex) => ({ key, day, dayIndex })) : []);
  const sibling = allDays.flatMap(({ key, day, dayIndex }) => day.date > chosen!.date && day.date <= quarter.endDate ? day.slots.flatMap((slot, slotIndex) => slot.filter((lesson) => lesson.subjectId === chosen!.lesson.subjectId && lesson.teacherId === chosen!.sourceId).map((lesson) => ({ key, day, dayIndex, slotIndex, lesson }))) : []).find(Boolean);
  assert.ok(sibling, "fixture needs another date in the same class and quarter");
  const schedule = structuredClone(initial.schedule);
  for (const days of Object.values(schedule)) for (const day of days) day.slots = day.slots.map(() => []);
  schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex] = [{ ...chosen.lesson }];
  schedule[sibling.key]![sibling.dayIndex]!.slots[sibling.slotIndex] = [{ ...sibling.lesson }];
  const save = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule, revision: initial.revision, requestId: `reassign-partial-sparse-${crypto.randomUUID()}` } });
  assert.equal(save.statusCode, 200, save.body);
  let state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const request = { mode: "assign", quarterId: quarter.id, subjectId: chosen.lesson.subjectId, sourceTeacherId: chosen.sourceId, groupIds: [chosen.groupId], scope: "period", startDate: chosen.date, endDate: sibling.day.date, targetTeacherId: chosen.targetId, persist: true };
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview;
  assert.equal(preview.units.filter((unit: { teacherId?: string }) => unit.teacherId === chosen!.targetId).length, 2);
  const selectedUnit = preview.units.find((unit: { lessonIds: string[] }) => unit.lessonIds.includes(chosen!.lesson.id));
  const applied = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: `reassign-partial-apply-${crypto.randomUUID()}`, request, expectedUnits: [{ unitId: selectedUnit.id, teacherId: chosen.targetId }] } });
  assert.equal(applied.statusCode, 200, applied.body);
  state = (applied.json() as { state: StateResponse }).state;
  assert.equal(state.schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0]!.teacherId, chosen.targetId);
  const second = state.schedule[sibling.key]![sibling.dayIndex]!.slots[sibling.slotIndex]![0]!;
  assert.equal(second.teacherId, chosen.sourceId);
  assert.ok(!state.teachingAssignments?.some((entry) => entry.groupId === chosen!.groupId && entry.subjectId === chosen!.lesson.subjectId && entry.targetTeacherId === chosen!.targetId), "an unselected stream must not persist a broad assignment");
});

test("a weekly transfer preserves original absence lineage and return retires the linked assignment", async () => {
  const { app, headers, state: initial } = await setup();
  const today = new Date().toLocaleDateString("sv-SE");
  let chosen: { key: string; dayIndex: number; slotIndex: number; date: string; groupId: string; sourceId: string; lesson: StateResponse["schedule"][string][number]["slots"][number][number]; start: number; duration: number; candidates: string[] } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const [dayIndex, day] of days.entries()) {
      if (day.date < today) continue;
      for (const [slotIndex, slot] of day.slots.entries()) for (const lesson of slot) {
        const source = initial.catalog.teachers.find((teacher) => teacher.id === lesson.teacherId);
        if (source && day.times[slotIndex]) { chosen = { key, dayIndex, slotIndex, date: day.date, groupId, sourceId: source.id, lesson, start: day.times[slotIndex]!.start, duration: day.times[slotIndex]!.duration, candidates: ["teacher:lineage-substitute-one", "teacher:lineage-substitute-two"] }; break; }
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  assert.ok(chosen, "fixture needs two qualified substitutes for one future lesson");
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  sparse[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex] = [{ ...chosen.lesson }];
  const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `lineage-sparse-${crypto.randomUUID()}` } });
  assert.equal(saved.statusCode, 200, saved.body);
  let state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const ruleId = "lineage-sick-rule";
  const catalog = structuredClone(state.catalog);
  catalog.teachers.push(
    { id: chosen.candidates[0]!, name: "Тестовый заменяющий один", subjectIds: [chosen.lesson.subjectId], defaultRoomId: null, archived: false, preferredGroupIds: [chosen.groupId], unavailability: [] },
    { id: chosen.candidates[1]!, name: "Тестовый заменяющий два", subjectIds: [chosen.lesson.subjectId], defaultRoomId: null, archived: false, preferredGroupIds: [chosen.groupId], unavailability: [] },
  );
  catalog.teachers.find((teacher) => teacher.id === chosen!.sourceId)!.unavailability = [{ id: ruleId, startDate: chosen!.date, endDate: chosen!.date, start: chosen!.start, end: chosen!.start + chosen!.duration, reason: "Больничный" }];
  const catalogSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: state.revision, requestId: `lineage-catalog-${crypto.randomUUID()}` } });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body); state = catalogSave.json() as StateResponse;
  const absenceRequest = { teacherId: chosen.sourceId, startDate: chosen.date, endDate: chosen.date, ruleId };
  const absencePreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-replacements/preview", headers, payload: { revision: state.revision, request: absenceRequest } });
  assert.equal(absencePreviewResponse.statusCode, 200, absencePreviewResponse.body);
  const absenceUnit = absencePreviewResponse.json().preview.units[0];
  assert.ok(absenceUnit.teacherId);
  const firstSubstitute = absenceUnit.teacherId as string;
  const firstApply = await app.inject({ method: "POST", url: "/api/teacher-replacements/apply", headers, payload: { revision: state.revision, requestId: `lineage-first-${crypto.randomUUID()}`, request: absenceRequest, expectedAssignments: [{ unitId: absenceUnit.id, teacherId: firstSubstitute }] } });
  assert.equal(firstApply.statusCode, 200, firstApply.body); state = (firstApply.json() as { state: StateResponse }).state;
  const secondSubstitute = chosen.candidates.find((id) => id !== firstSubstitute)!;
  const date = new Date(`${chosen.date}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const weekStart = date.toISOString().slice(0, 10);
  const weekRequest = { mode: "assign", quarterId: state.quarters[0]!.id, subjectId: chosen.lesson.subjectId, sourceTeacherId: firstSubstitute, groupIds: [chosen.groupId], scope: "week", weekStart, targetTeacherId: secondSubstitute, persist: true };
  const weekPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: weekRequest } });
  assert.equal(weekPreviewResponse.statusCode, 200, weekPreviewResponse.body);
  const weekPreview = weekPreviewResponse.json().preview;
  const weekUnit = weekPreview.units.find((unit: { lessonIds: string[] }) => unit.lessonIds.includes(chosen!.lesson.id));
  assert.equal(weekUnit.teacherId, secondSubstitute);
  const weekApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: `lineage-week-${crypto.randomUUID()}`, request: weekRequest, expectedUnits: [{ unitId: weekUnit.id, teacherId: secondSubstitute }] } });
  assert.equal(weekApply.statusCode, 200, weekApply.body); state = (weekApply.json() as { state: StateResponse }).state;
  const linked = state.teachingAssignments?.find((assignment) => assignment.groupId === chosen!.groupId && assignment.subjectId === chosen!.lesson.subjectId && assignment.targetTeacherId === secondSubstitute);
  assert.equal(linked?.sourceTeacherId, chosen.sourceId);
  assert.equal(linked?.absenceRuleId, ruleId);

  const returnRequest = { mode: "return", sourceTeacherId: chosen.sourceId, returnDate: chosen.date, ruleId };
  const returnPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: returnRequest } });
  assert.equal(returnPreviewResponse.statusCode, 200, returnPreviewResponse.body);
  const returnPreview = returnPreviewResponse.json().preview;
  const returnUnit = returnPreview.units.find((unit: { lessonIds: string[] }) => unit.lessonIds.includes(chosen!.lesson.id));
  assert.ok(returnUnit, `The returned lesson must be present: ${JSON.stringify(returnPreview.skipped)}`);
  assert.equal(returnUnit.teacherId, chosen.sourceId);
  const returnApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: `lineage-return-${crypto.randomUUID()}`, request: returnRequest, expectedUnits: [{ unitId: returnUnit.id, teacherId: chosen.sourceId }] } });
  assert.equal(returnApply.statusCode, 200, returnApply.body);
  state = (returnApply.json() as { state: StateResponse }).state;
  assert.equal(state.schedule[chosen.key]![chosen.dayIndex]!.slots[chosen.slotIndex]![0]!.teacherId, chosen.sourceId);
  assert.ok(state.teachingAssignments?.filter((assignment) => assignment.groupId === chosen!.groupId && assignment.subjectId === chosen!.lesson.subjectId && assignment.targetTeacherId === secondSubstitute).every((assignment) => assignment.endDate !== null && assignment.endDate < chosen!.date), "return must end the temporary page assignment before the return date");
});

test("per-unit reassignment choices are previewed, applied, persisted, replayed and undone together", async () => {
  const { app, headers, state: initial } = await setup();
  const today = new Date().toLocaleDateString("sv-SE");
  type LocatedLesson = { key: string; dayIndex: number; slotIndex: number; date: string; start: number; duration: number; groupId: string; lesson: StateResponse["schedule"][string][number]["slots"][number][number] };
  const streams = new Map<string, LocatedLesson[]>();
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const [dayIndex, day] of days.entries()) {
      if (day.date < today) continue;
      for (const [slotIndex, slot] of day.slots.entries()) for (const lesson of slot) {
        if (!lesson.teacherId || !day.times[slotIndex]) continue;
        const streamKey = [groupId, lesson.subjectId, lesson.teacherId].join("\0");
        const stream = streams.get(streamKey) ?? [];
        stream.push({ key, dayIndex, slotIndex, date: day.date, start: day.times[slotIndex]!.start, duration: day.times[slotIndex]!.duration, groupId, lesson });
        streams.set(streamKey, stream);
      }
    }
  }
  const stream = [...streams.values()].find(items => items.length >= 2 && initial.quarters.some(quarter => items[0]!.date >= quarter.startDate && items[1]!.date <= quarter.endDate));
  assert.ok(stream, "fixture needs two future lessons from the same group and teacher stream");
  stream.sort((a, b) => a.date.localeCompare(b.date));
  const picked = [stream[0]!, stream[1]!];
  const sourceTeacherId = picked[0].lesson.teacherId!;
  const subjectId = picked[0].lesson.subjectId;
  const quarter = initial.quarters.find(item => item.startDate <= picked[0]!.date && item.endDate >= picked[1]!.date);
  assert.ok(quarter, "both lessons must be in one quarter");

  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  for (const item of picked) sparse[item.key]![item.dayIndex]!.slots[item.slotIndex] = [{ ...item.lesson }];
  const saved = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: sparse, revision: initial.revision, requestId: `unit-map-sparse-${crypto.randomUUID()}` } });
  assert.equal(saved.statusCode, 200, saved.body);
  let state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;

  const firstTargetId = "teacher:unit-map-first";
  const secondTargetId = "teacher:unit-map-second";
  const catalog = structuredClone(state.catalog);
  catalog.teachers.push(
    { id: firstTargetId, name: "Проверочный преподаватель Первый", subjectIds: [subjectId], defaultRoomId: null, archived: false, preferredGroupIds: [picked[0]!.groupId], unavailability: [{ id: "unit-map-unavailable-second-date", startDate: picked[1]!.date, endDate: picked[1]!.date, start: picked[1]!.start, end: picked[1]!.start + picked[1]!.duration, reason: "Занят" }] },
    { id: secondTargetId, name: "Проверочный преподаватель Второй", subjectIds: [subjectId], defaultRoomId: null, archived: false, preferredGroupIds: [picked[0]!.groupId], unavailability: [] },
  );
  const catalogSave = await app.inject({ method: "PUT", url: "/api/catalog", headers, payload: { catalog, revision: state.revision, requestId: `unit-map-catalog-${crypto.randomUUID()}` } });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  state = catalogSave.json() as StateResponse;

  const baseRequest = { mode: "assign", quarterId: quarter.id, subjectId, sourceTeacherId, groupIds: [picked[0]!.groupId], scope: "period", startDate: picked[0]!.date, endDate: picked[1]!.date, lessonIds: picked.map(item => item.lesson.id), persist: true };
  const seedPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: { ...baseRequest, targetTeacherId: secondTargetId } } });
  assert.equal(seedPreviewResponse.statusCode, 200, seedPreviewResponse.body);
  const seedUnits = seedPreviewResponse.json().preview.units as Array<{ id: string; lessonIds: string[] }>;
  const firstUnit = seedUnits.find(unit => unit.lessonIds.includes(picked[0]!.lesson.id));
  const secondUnit = seedUnits.find(unit => unit.lessonIds.includes(picked[1]!.lesson.id));
  assert.ok(firstUnit && secondUnit && firstUnit.id !== secondUnit.id);

  const unitTeacherIds = { [firstUnit.id]: firstTargetId, [secondUnit.id]: secondTargetId };
  const request = { ...baseRequest, unitTeacherIds };
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview;
  const units = preview.units as Array<{ id: string; lessonIds: string[]; teacherId?: string; availableTeacherIds?: string[] }>;
  const first = units.find(unit => unit.id === firstUnit.id)!;
  const second = units.find(unit => unit.id === secondUnit.id)!;
  assert.equal(first.teacherId, firstTargetId);
  assert.equal(second.teacherId, secondTargetId);
  assert.ok(first.availableTeacherIds?.includes(firstTargetId));
  assert.ok(second.availableTeacherIds?.includes(secondTargetId));
  assert.ok(!second.availableTeacherIds?.includes(firstTargetId), "a candidate unavailable at this lesson must not be offered");

  const badMaps: unknown[] = [[], { [firstUnit.id]: 17 }, { "outside-scope-unit": secondTargetId }, {}];
  for (const badMap of badMaps) {
    const invalid = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: state.revision, request: { ...baseRequest, unitTeacherIds: badMap } } });
    assert.equal(invalid.statusCode, 400, `invalid per-unit map should be rejected: ${JSON.stringify(badMap)}`);
  }

  const mismatch = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: `unit-map-tamper-${crypto.randomUUID()}`, request, expectedUnits: [{ unitId: firstUnit.id, teacherId: secondTargetId }] } });
  assert.equal(mismatch.statusCode, 409, mismatch.body);

  // Acknowledging one row applies only that row, even when the request previews both.
  const partialId = `unit-map-partial-${crypto.randomUUID()}`;
  const partial = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: partialId, request, expectedUnits: [{ unitId: firstUnit.id, teacherId: firstTargetId }] } });
  assert.equal(partial.statusCode, 200, partial.body);
  const partialState = (partial.json() as { state: StateResponse }).state;
  assert.equal(partialState.schedule[picked[0]!.key]![picked[0]!.dayIndex]!.slots[picked[0]!.slotIndex]![0]!.teacherId, firstTargetId);
  assert.equal(partialState.schedule[picked[1]!.key]![picked[1]!.dayIndex]!.slots[picked[1]!.slotIndex]![0]!.teacherId, sourceTeacherId);
  assert.ok(partialState.teachingAssignments?.some(item => item.targetTeacherId === firstTargetId && item.startDate === picked[0]!.date && item.endDate === picked[0]!.date));
  assert.ok(!partialState.teachingAssignments?.some(item => item.targetTeacherId === secondTargetId && item.startDate === picked[1]!.date));
  const partialReplay = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: partialId, request, expectedUnits: [{ unitId: firstUnit.id, teacherId: firstTargetId }] } });
  assert.equal(partialReplay.statusCode, 200);
  assert.deepEqual(partialReplay.json(), partial.json());
  const partialOperationId = (partial.json() as { operationId: string }).operationId;
  const partialUndo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${partialOperationId}/undo`, headers, payload: { revision: partialState.revision, requestId: `unit-map-partial-undo-${crypto.randomUUID()}` } });
  assert.equal(partialUndo.statusCode, 200, partialUndo.body);
  state = (partialUndo.json() as { state: StateResponse }).state;

  const appliedId = `unit-map-apply-${crypto.randomUUID()}`;
  const expectedUnits = [{ unitId: firstUnit.id, teacherId: firstTargetId }, { unitId: secondUnit.id, teacherId: secondTargetId }];
  const applied = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision, requestId: appliedId, request, expectedUnits } });
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedData = applied.json() as { state: StateResponse; operationId: string };
  state = appliedData.state;
  for (const item of picked) {
    const targetId = item.lesson.id === picked[0]!.lesson.id ? firstTargetId : secondTargetId;
    assert.equal(state.schedule[item.key]![item.dayIndex]!.slots[item.slotIndex]![0]!.teacherId, targetId);
    assert.ok(state.teacherLessonOrigins?.some(origin => origin.lessonId === item.lesson.id && origin.substituteTeacherId === targetId));
    assert.ok(state.teachingAssignments?.some(assignment => assignment.targetTeacherId === targetId && assignment.startDate === item.date && assignment.endDate === item.date));
  }
  const appliedReplay = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: state.revision - 1, requestId: appliedId, request, expectedUnits } });
  assert.equal(appliedReplay.statusCode, 200);
  assert.deepEqual(appliedReplay.json(), applied.json());
  const undo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${appliedData.operationId}/undo`, headers, payload: { revision: state.revision, requestId: `unit-map-undo-${crypto.randomUUID()}` } });
  assert.equal(undo.statusCode, 200, undo.body);
  const restored = (undo.json() as { state: StateResponse }).state;
  for (const item of picked) assert.equal(restored.schedule[item.key]![item.dayIndex]!.slots[item.slotIndex]![0]!.teacherId, sourceTeacherId);
  assert.ok(!restored.teachingAssignments?.some(item => [firstTargetId, secondTargetId].includes(item.targetTeacherId)));
  assert.ok(!restored.teacherLessonOrigins?.some(item => picked.some(selected => selected.lesson.id === item.lessonId && [firstTargetId, secondTargetId].includes(item.substituteTeacherId))));
});

test("migration 23 repairs an existing reassignment history table after schema 16", async () => {
  const root = mkdtempSync(join(tmpdir(), "smena-reassignment-migration-23-")); roots.push(root);
  const dbPath = join(root, "draft.sqlite");
  const password = "teacher reassignment migration test password";
  const oldApp = await buildApp({ dbPath }); apps.push(oldApp);
  const setupAuth = await oldApp.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password } });
  assert.equal(setupAuth.statusCode, 200, setupAuth.body);
  const initialHeaders = { cookie: String(setupAuth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": setupAuth.json().csrfToken as string };
  const initial = (await oldApp.inject({ url: "/api/state", headers: initialHeaders })).json() as StateResponse;
  const today = new Date().toLocaleDateString("sv-SE");
  let fixture: { key: string; dayIndex: number; slotIndex: number; groupId: string; lesson: StateResponse["schedule"][string][number]["slots"][number][number]; targetId: string } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const [dayIndex, day] of days.entries()) {
      if (day.date < today) continue;
      for (const [slotIndex, slot] of day.slots.entries()) for (const lesson of slot) {
        if (!lesson.teacherId) continue;
        const target = initial.catalog.teachers.find(teacher => teacher.id !== lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(lesson.subjectId));
        if (target) { fixture = { key, dayIndex, slotIndex, groupId, lesson, targetId: target.id }; break; }
      }
      if (fixture) break;
    }
    if (fixture) break;
  }
  assert.ok(fixture, "fixture needs a future lesson and another qualified teacher");
  const sparse = structuredClone(initial.schedule);
  for (const days of Object.values(sparse)) for (const day of days) day.slots = day.slots.map(() => []);
  sparse[fixture.key]![fixture.dayIndex]!.slots[fixture.slotIndex] = [{ ...fixture.lesson }];
  const sparseSave = await oldApp.inject({ method: "PUT", url: "/api/state", headers: initialHeaders, payload: { schedule: sparse, revision: initial.revision, requestId: `migration-23-sparse-${crypto.randomUUID()}` } });
  assert.equal(sparseSave.statusCode, 200, sparseSave.body);

  await oldApp.close(); apps.splice(apps.indexOf(oldApp), 1);
  const legacyPolicy = {
    id: "migration-23-existing-policy", sourceTeacherId: fixture.lesson.teacherId!, groupId: fixture.groupId,
    subjectId: fixture.lesson.subjectId, startDate: "2026-09-01", endDate: "2026-10-01", teacherIds: [fixture.targetId],
  };
  const legacyDb = new Database(dbPath);
  assert.ok(legacyDb.prepare("SELECT 1 FROM schema_migrations WHERE version=16").get(), "the old schema has migration 16 recorded");
  legacyDb.prepare("INSERT INTO temporary_teacher_replacements(id,policy_json) VALUES(?,?)").run(legacyPolicy.id, JSON.stringify(legacyPolicy));
  legacyDb.exec("ALTER TABLE teacher_reassignment_operations DROP COLUMN previous_policies_json");
  legacyDb.prepare("DELETE FROM schema_migrations WHERE version=23").run();
  legacyDb.prepare(`INSERT INTO teacher_reassignment_operations(
    operation_id,apply_request_id,apply_fingerprint,apply_response_json,applied_revision,
    previous_schedule_json,previous_catalog_json,previous_origins_json,previous_assignments_json
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run("legacy-reassignment-history", "legacy-reassignment-request", "legacy-fingerprint", "{}", initial.revision, "{}", "{}", "[]", "[]");
  legacyDb.close();

  const app = await buildApp({ dbPath }); apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { cookie: String(login.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
  const migratedDb = new Database(dbPath, { readonly: true });
  assert.ok(migratedDb.prepare("SELECT 1 FROM schema_migrations WHERE version=16").get());
  assert.ok(migratedDb.prepare("SELECT 1 FROM schema_migrations WHERE version=23").get(), "migration 23 must run even when migration 16 is already recorded");
  const oldOperation = migratedDb.prepare("SELECT operation_id,previous_policies_json FROM teacher_reassignment_operations WHERE operation_id='legacy-reassignment-history'").get() as { operation_id: string; previous_policies_json: string } | undefined;
  assert.ok(oldOperation, "the existing operation history must survive the repair migration");
  assert.deepEqual(JSON.parse(oldOperation.previous_policies_json), [legacyPolicy], "old operation undo snapshots preserve the current replacement policies");
  migratedDb.close();

  const current = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const quarter = current.quarters.find(item => item.startDate <= current.schedule[fixture!.key]![fixture!.dayIndex]!.date && item.endDate >= current.schedule[fixture!.key]![fixture!.dayIndex]!.date)!;
  const request = { mode: "assign", quarterId: quarter.id, subjectId: fixture.lesson.subjectId, sourceTeacherId: fixture.lesson.teacherId, groupIds: [fixture.groupId], scope: "lesson", lessonId: fixture.lesson.id, targetTeacherId: fixture.targetId, persist: false };
  const previewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: current.revision, request } });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const unit = previewResponse.json().preview.units.find((item: { lessonIds: string[]; teacherId?: string }) => item.lessonIds.includes(fixture!.lesson.id) && item.teacherId === fixture!.targetId);
  assert.ok(unit, "the substitute should be available in the isolated fixture");
  const apply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply", headers, payload: { revision: current.revision, requestId: `migration-23-apply-${crypto.randomUUID()}`, request, expectedUnits: [{ unitId: unit.id, teacherId: fixture.targetId }] } });
  assert.equal(apply.statusCode, 200, apply.body);
  const applied = apply.json() as { state: StateResponse; operationId: string };
  assert.equal(applied.state.schedule[fixture.key]![fixture.dayIndex]!.slots[fixture.slotIndex]![0]!.teacherId, fixture.targetId);
  const undo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${applied.operationId}/undo`, headers, payload: { revision: applied.state.revision, requestId: `migration-23-undo-${crypto.randomUUID()}` } });
  assert.equal(undo.statusCode, 200, undo.body);
  const restored = (undo.json() as { state: StateResponse }).state;
  assert.equal(restored.schedule[fixture.key]![fixture.dayIndex]!.slots[fixture.slotIndex]![0]!.teacherId, fixture.lesson.teacherId);
  assert.deepEqual(restored.temporaryTeacherReplacements, [legacyPolicy]);
});
