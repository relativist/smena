import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1]) throw new Error("Usage: node scripts/verify-teacher-reassignment-acceptance.mjs --db FILE --out EMPTY_DIR");
  args.set(process.argv[i], process.argv[i + 1]);
}
const sourceDb = resolve(args.get("--db") ?? "data/smena.sqlite");
const out = resolve(args.get("--out") ?? "");
if (!args.has("--out") || !statSync(out).isDirectory() || readdirSync(out).length) throw new Error("--out must name an existing empty directory");
const clonePath = join(out, "acceptance.sqlite");
const reportPath = join(out, "acceptance.json");
const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
try { await source.backup(clonePath); } finally { source.close(); }
chmodSync(clonePath, 0o600);

const db = new Database(clonePath);
db.pragma("foreign_keys = ON");
db.exec("DELETE FROM sessions; DELETE FROM admin_users;");
db.close();

const app = await buildApp({ dbPath: clonePath });
const origin = "http://127.0.0.1";
const started = Date.now();
const cases = [];
const record = (name, status, details = {}) => cases.push({ name, status, ...details });
const digest = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const query = (sql, ...params) => app.smenaDb.prepare(sql).all(...params);
const hashQuery = (sql) => digest(query(sql));
const millis = (fn) => async (...params) => {
  const t = performance.now(); const result = await fn(...params);
  return { result, ms: Math.round(performance.now() - t) };
};

try {
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "acceptance", password: randomUUID() } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0], origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken };
  const initialResp = await app.inject({ url: "/api/state", headers });
  assert.equal(initialResp.statusCode, 200, initialResp.body);
  let initial = initialResp.json();
  const baselineRevision = initial.revision;
  const baselineLessonCount = app.smenaDb.prepare("SELECT COUNT(*) AS count FROM lessons").get().count;
  assert.equal(baselineLessonCount, 181324, `Expected the acceptance baseline's 181324 lessons, got ${baselineLessonCount}`);
  const today = new Date().toLocaleDateString("sv-SE");
  let picked;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days) {
      if (day.date < today) continue;
      const quarter = initial.quarters.find((item) => item.startDate <= day.date && item.endDate >= day.date);
      if (!quarter) continue;
      for (const [slotIndex, lessons] of day.slots.entries()) for (const lesson of lessons) {
        const sourceTeacher = initial.catalog.teachers.find((t) => t.id === lesson.teacherId);
        const targetTeacher = initial.catalog.teachers.find((t) => t.id !== lesson.teacherId && !t.archived && t.subjectIds.includes(lesson.subjectId));
        if (!sourceTeacher || !targetTeacher || !day.times[slotIndex]) continue;
        picked = { groupId, key, date: day.date, slotIndex, lesson, sourceTeacher, targetTeacher, quarter };
        break;
      }
      if (picked) break;
    }
    if (picked) break;
  }
  assert.ok(picked, "No future lesson with an eligible substitute exists in the baseline");
  const fixtureGroups = initial.catalog.groups.filter((group) => group.id !== picked.groupId).slice(0, 2);
  assert.equal(fixtureGroups.length, 2, "Fixture needs two additional groups");
  const fixtureTeacher = picked.targetTeacher;
  const qualifiedTargets = initial.catalog.teachers.filter((teacher) => teacher.id !== fixtureTeacher.id && teacher.id !== picked.sourceTeacher.id && !teacher.archived && teacher.subjectIds.includes(picked.lesson.subjectId));
  const unavailableTeacher = qualifiedTargets[0];
  const adjacentTeacher = qualifiedTargets[1];
  assert.ok(unavailableTeacher && adjacentTeacher, "Fixture needs three qualified teachers for independent interval cases");
  const fixtureSource = picked.sourceTeacher;
  const fixtureSubject = picked.lesson.subjectId;
  const dateDayIndex = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const insertFixture = app.smenaDb.transaction(() => {
    const createdSlotIds = [];
    const createdDayIds = [];
    const ensureLesson = (id, groupId, date, start, duration, options = {}) => {
      let day = app.smenaDb.prepare("SELECT id,week_offset,day_index FROM schedule_days WHERE group_id=? AND date=?").get(groupId, date);
      if (!day) {
        const reference = app.smenaDb.prepare("SELECT week_offset FROM schedule_days WHERE group_id=? ORDER BY date LIMIT 1").get(groupId);
        const offset = reference?.week_offset ?? 0;
        app.smenaDb.prepare("INSERT INTO schedule_days(group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note,bell_profile_json) VALUES(?,?,?,?,?,?,?,?,NULL)")
          .run(groupId, date, offset, dateDayIndex(date), "08:00", 45, 0, null);
        day = app.smenaDb.prepare("SELECT id,week_offset,day_index FROM schedule_days WHERE group_id=? AND date=?").get(groupId, date);
        createdDayIds.push(day.id);
      }
      const maxIndex = app.smenaDb.prepare("SELECT COALESCE(MAX(slot_index),-1) AS value FROM schedule_slots WHERE day_id=?").get(day.id).value;
      const slot = app.smenaDb.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,?,?,?)").run(day.id, maxIndex + 1, start, duration);
      createdSlotIds.push(slot.lastInsertRowid);
      app.smenaDb.prepare(`INSERT INTO lessons(id,slot_id,subject_id,subgroup,teacher,room,event,note,teacher_ref,room_ref,subgroup_ref,lesson_kind,joint_id,event_remainder_json)
        VALUES(?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,'regular',?,NULL)`)
        .run(id, slot.lastInsertRowid, fixtureSubject, options.subgroupName ?? null, options.teacher?.name ?? fixtureSource.name, options.teacher?.id ?? fixtureSource.id, options.subgroupId ?? null, options.jointId ?? null);
      return id;
    };
    const ids = [];
    ids.push(ensureLesson("accept-joint-a", picked.groupId, picked.date, 1360, 25, { jointId: "accept-joint" }));
    ids.push(ensureLesson("accept-joint-b", fixtureGroups[0].id, picked.date, 1360, 25, { jointId: "accept-joint" }));
    ids.push(ensureLesson("accept-malformed-a", picked.groupId, picked.date, 1390, 25, { jointId: "accept-malformed" }));
    ids.push(ensureLesson("accept-malformed-b", fixtureGroups[1].id, picked.date, 1400, 20, { jointId: "accept-malformed" }));
    const subgroup = initial.catalog.subgroups.find((item) => item.groupId === picked.groupId);
    ids.push(ensureLesson("accept-subgroup", picked.groupId, picked.date, 1330, 20, { subgroupName: subgroup?.name ?? "Подгруппа приемки", subgroupId: subgroup?.id }));
    const atStart = ensureLesson("accept-boundary-start", picked.groupId, picked.quarter.startDate, 1300, 20);
    const atEnd = ensureLesson("accept-boundary-end", picked.groupId, picked.quarter.endDate, 1300, 20);
    const afterEndDate = new Date(`${picked.quarter.endDate}T00:00:00Z`); afterEndDate.setUTCDate(afterEndDate.getUTCDate() + 1);
    const afterEnd = ensureLesson("accept-boundary-after", picked.groupId, afterEndDate.toISOString().slice(0, 10), 1300, 20);
    ids.push(atStart, atEnd, afterEnd);
    ensureLesson("accept-cross-source", picked.groupId, picked.date, 1420, 20);
    ensureLesson("accept-cross-busy", fixtureGroups[0].id, picked.date, 1420, 20, { teacher: fixtureTeacher });
    ensureLesson("accept-adjacent-source", picked.groupId, picked.date, 1200, 20);
    ensureLesson("accept-adjacent-busy", fixtureGroups[1].id, picked.date, 1180, 20, { teacher: adjacentTeacher });
    ensureLesson("accept-unavailable-source", picked.groupId, picked.date, 1330, 20);
    const archivedTeacherId = initial.catalog.teachers.find((teacher) => !teacher.archived && teacher.id !== fixtureTeacher.id)?.id;
    const archivedOriginal = archivedTeacherId ? app.smenaDb.prepare("SELECT archived FROM catalog_teachers WHERE id=?").get(archivedTeacherId).archived : undefined;
    const unavailableOriginal = app.smenaDb.prepare("SELECT unavailability_json FROM catalog_teachers WHERE id=?").get(unavailableTeacher.id).unavailability_json;
    if (archivedTeacherId) app.smenaDb.prepare("UPDATE catalog_teachers SET archived=1 WHERE id=?").run(archivedTeacherId);
    const unavailable = JSON.stringify([{ id: "accept-unavailable", startDate: picked.date, endDate: picked.date, start: 1330, end: 1350, reason: "Приемочная проверка" }]);
    app.smenaDb.prepare("UPDATE catalog_teachers SET unavailability_json=? WHERE id=?").run(unavailable, unavailableTeacher.id);
    app.smenaDb.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
    return { ids, createdSlotIds, createdDayIds, archivedTeacherId, archivedOriginal, unavailableOriginal, unavailableTeacherId: unavailableTeacher.id, adjacentTeacherId: adjacentTeacher.id };
  });
  const seeded = insertFixture();
  initial = (await app.inject({ url: "/api/state", headers })).json();
  let allLessons = query("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id");
  let beforeHashes = {
    lessons: digest(allLessons),
    slots: hashQuery("SELECT id,day_id,slot_index,start_minute,duration FROM schedule_slots ORDER BY id"),
    days: hashQuery("SELECT id,group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note FROM schedule_days ORDER BY id"),
    publications: hashQuery("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters ORDER BY quarter_id"),
  };
  const req = { mode: "assign", quarterId: picked.quarter.id, subjectId: picked.lesson.subjectId, sourceTeacherId: picked.sourceTeacher.id, groupIds: [picked.groupId], scope: "period", startDate: picked.quarter.startDate, endDate: picked.quarter.endDate, persist: false };
  const previewRun = await millis(async () => app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: req } }))();
  assert.equal(previewRun.result.statusCode, 200, previewRun.result.body);
  const preview = previewRun.result.json().preview;
  let offeredUnit = preview.units.find((item) => item.availableTeacherIds.length > 0 && item.lessonIds.every((id) => !id.startsWith("accept-")));
  assert.ok(offeredUnit, "No eligible teacher is available for any unit in the chosen group and quarter");
  let selectedLessonId = offeredUnit.lessonIds[0];
  const lessonRows = new Map(allLessons.map((row) => [row.id, row]));
  let selectedLesson = lessonRows.get(selectedLessonId);
  assert.ok(selectedLesson, "Selected preview lesson is absent from the database snapshot");
  let selectedTeacherId = offeredUnit.availableTeacherIds[0];
  let selectedReq = { ...req, lessonIds: [selectedLessonId], targetTeacherId: selectedTeacherId };
  const selectedPreviewRun = await millis(async () => app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: selectedReq } }))();
  assert.equal(selectedPreviewRun.result.statusCode, 200, selectedPreviewRun.result.body);
  const selectedPreview = selectedPreviewRun.result.json().preview;
  let unit = selectedPreview.units.find((item) => item.lessonIds.includes(selectedLessonId));
  assert.ok(unit?.teacherId === selectedTeacherId && !unit.reason, `Selected unit cannot be reassigned: ${JSON.stringify({ reason: unit?.reason, offered: offeredUnit.availableTeacherIds })}`);
  record("large-context-preview", "passed", { lessons: allLessons.length, previewUnits: preview.units.length, candidateTeacherId: selectedTeacherId, durationMs: previewRun.ms + selectedPreviewRun.ms });

  const fixtureRequest = (lessonId, targetTeacherId, groupIds = [picked.groupId]) => ({ mode: "assign", quarterId: picked.quarter.id, subjectId: fixtureSubject, sourceTeacherId: fixtureSource.id, groupIds, scope: "lesson", lessonId, targetTeacherId, persist: false });
  const fixturePreview = async (request) => app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request } });
  const reasonProbe = async (name, lessonId, targetTeacherId, expectedReason, groupIds) => {
    const response = await fixturePreview(fixtureRequest(lessonId, targetTeacherId, groupIds));
    const resultUnit = response.statusCode === 200 && response.json().preview.units.find((item) => item.lessonIds.includes(lessonId));
    const reason = resultUnit?.reason ?? "";
    record(name, response.statusCode === 200 && expectedReason.test(reason) ? "passed" : "gap", { statusCode: response.statusCode, reason: reason || response.json().error || "no rejection", expected: expectedReason.source });
  };
  const unqualifiedTeacherId = initial.catalog.teachers.find((teacher) => !teacher.archived && !teacher.subjectIds.includes(fixtureSubject))?.id;
  await reasonProbe("unqualified-target-rejected", "accept-cross-source", unqualifiedTeacherId, /не ведёт предмет/i);
  const archivedResponse = await fixturePreview(fixtureRequest("accept-cross-source", seeded.archivedTeacherId));
  record("archived-target-rejected", archivedResponse.statusCode === 400 ? "passed" : "gap", { statusCode: archivedResponse.statusCode, error: archivedResponse.statusCode === 400 ? archivedResponse.json().error : "Archived target was accepted" });
  await reasonProbe("unavailability-rejected", "accept-unavailable-source", seeded.unavailableTeacherId, /недоступен/i);
  await reasonProbe("cross-group-overlap-rejected", "accept-cross-source", fixtureTeacher.id, /уже есть занятие/i);
  const adjacentResponse = await fixturePreview(fixtureRequest("accept-adjacent-source", seeded.adjacentTeacherId));
  const adjacentUnit = adjacentResponse.statusCode === 200 && adjacentResponse.json().preview.units.find((item) => item.lessonIds.includes("accept-adjacent-source"));
  record("adjacent-interval-is-allowed", adjacentUnit?.teacherId === seeded.adjacentTeacherId && !adjacentUnit?.reason ? "passed" : "gap", { statusCode: adjacentResponse.statusCode, reason: adjacentUnit?.reason, occupiedInterval: "11:40-12:00", selectedInterval: "12:00-12:20" });
  record("shortened-20-minute-lesson-uses-actual-interval", adjacentUnit?.teacherId === seeded.adjacentTeacherId && !adjacentUnit?.reason ? "passed" : "gap", { selectedDurationMinutes: 20, adjacentDurationMinutes: 20, boundaryMinute: 720 });
  const jointResponse = await fixturePreview(fixtureRequest("accept-joint-a", fixtureTeacher.id, [picked.groupId, fixtureGroups[0].id]));
  const jointUnit = jointResponse.statusCode === 200 && jointResponse.json().preview.units.find((item) => item.lessonIds.includes("accept-joint-a"));
  record("joint-mirrors-grouped", jointUnit?.lessonIds.length === 2 && jointUnit.lessonIds.includes("accept-joint-b") ? "passed" : "gap", { statusCode: jointResponse.statusCode, lessonIds: jointUnit?.lessonIds });
  const malformedResponse = await fixturePreview(fixtureRequest("accept-malformed-a", fixtureTeacher.id, [picked.groupId, fixtureGroups[1].id]));
  const malformedUnit = malformedResponse.statusCode === 200 && malformedResponse.json().preview.units.find((item) => item.lessonIds.includes("accept-malformed-a"));
  record("malformed-joint-rejected", /объединённые уроки имеют разные время/i.test(malformedUnit?.reason ?? "") ? "passed" : "gap", { statusCode: malformedResponse.statusCode, reason: malformedUnit?.reason, mirrorCount: malformedUnit?.lessonIds.length });
  const subgroupResponse = await fixturePreview(fixtureRequest("accept-subgroup", fixtureTeacher.id));
  const subgroupUnit = subgroupResponse.statusCode === 200 && subgroupResponse.json().preview.units.find((item) => item.lessonIds.includes("accept-subgroup"));
  record("subgroup-is-preserved", subgroupUnit?.subgroups?.length > 0 || subgroupUnit?.subgroupIds?.length > 0 ? "passed" : "gap", { statusCode: subgroupResponse.statusCode, subgroups: subgroupUnit?.subgroups, subgroupIds: subgroupUnit?.subgroupIds });
  const boundaryRequest = { mode: "assign", quarterId: picked.quarter.id, subjectId: fixtureSubject, sourceTeacherId: fixtureSource.id, groupIds: [picked.groupId], scope: "period", startDate: picked.quarter.startDate, endDate: picked.quarter.endDate, targetTeacherId: fixtureTeacher.id, persist: false };
  const boundaryResponse = await fixturePreview(boundaryRequest);
  const boundaryIds = boundaryResponse.statusCode === 200 ? boundaryResponse.json().preview.units.flatMap((item) => item.lessonIds) : [];
  record("finite-quarter-boundaries-inclusive", boundaryIds.includes("accept-boundary-start") && boundaryIds.includes("accept-boundary-end") && !boundaryIds.includes("accept-boundary-after") ? "passed" : "gap", { statusCode: boundaryResponse.statusCode, returnedIds: boundaryIds, included: ["quarter start", "quarter end"], excluded: ["day after quarter end"] });

  const lessonIdsOnly = { ...selectedReq, scope: "lesson" };
  delete lessonIdsOnly.lessonId;
  delete lessonIdsOnly.startDate;
  delete lessonIdsOnly.endDate;
  const lessonIdsOnlyResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: lessonIdsOnly } });
  const lessonIdsOnlyPreview = lessonIdsOnlyResponse.statusCode === 200 ? lessonIdsOnlyResponse.json().preview : undefined;
  const lessonIdsOnlyWorks = lessonIdsOnlyResponse.statusCode === 200 && lessonIdsOnlyPreview.units.some((item) => item.lessonIds.includes(selectedLessonId));
  record("lesson-scope-lessonIds-only", lessonIdsOnlyWorks ? "passed" : "gap", { statusCode: lessonIdsOnlyResponse.statusCode, returnedSelectedLesson: Boolean(lessonIdsOnlyWorks), error: lessonIdsOnlyWorks ? undefined : lessonIdsOnlyResponse.json().error });

  const groupOpenEnded = { ...req, endDate: null };
  delete groupOpenEnded.sourceTeacherId;
  const groupOpenEndedResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: groupOpenEnded } });
  const groupOpenEndedWorks = groupOpenEndedResponse.statusCode === 200 && groupOpenEndedResponse.json().preview.units.length > 0;
  record("open-ended-group-subject-without-source", groupOpenEndedWorks ? "passed" : "gap", { statusCode: groupOpenEndedResponse.statusCode, returnedUnits: groupOpenEndedWorks ? groupOpenEndedResponse.json().preview.units.length : 0, error: groupOpenEndedWorks ? undefined : groupOpenEndedResponse.json().error });

  app.smenaDb.transaction(() => {
    app.smenaDb.prepare("DELETE FROM lessons WHERE id LIKE 'accept-%'").run();
    const deleteSlot = app.smenaDb.prepare("DELETE FROM schedule_slots WHERE id=?");
    for (const id of seeded.createdSlotIds) deleteSlot.run(id);
    const deleteDay = app.smenaDb.prepare("DELETE FROM schedule_days WHERE id=?");
    for (const id of seeded.createdDayIds) deleteDay.run(id);
    if (seeded.archivedTeacherId) app.smenaDb.prepare("UPDATE catalog_teachers SET archived=? WHERE id=?").run(seeded.archivedOriginal, seeded.archivedTeacherId);
    app.smenaDb.prepare("UPDATE catalog_teachers SET unavailability_json=? WHERE id=?").run(seeded.unavailableOriginal, seeded.unavailableTeacherId);
    app.smenaDb.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
  })();
  initial = (await app.inject({ url: "/api/state", headers })).json();
  allLessons = query("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id");
  beforeHashes = {
    lessons: digest(allLessons),
    slots: hashQuery("SELECT id,day_id,slot_index,start_minute,duration FROM schedule_slots ORDER BY id"),
    days: hashQuery("SELECT id,group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note FROM schedule_days ORDER BY id"),
    publications: hashQuery("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters ORDER BY quarter_id"),
  };
  const applyPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: req } });
  assert.equal(applyPreviewResponse.statusCode, 200, applyPreviewResponse.body);
  const applyPreview = applyPreviewResponse.json().preview;
  offeredUnit = applyPreview.units.find((item) => item.availableTeacherIds.length > 0);
  assert.ok(offeredUnit, "No eligible candidate remains for the application fixture after controlled cases");
  selectedLessonId = offeredUnit.lessonIds[0];
  selectedLesson = new Map(allLessons.map((row) => [row.id, row])).get(selectedLessonId);
  assert.ok(selectedLesson);
  selectedTeacherId = offeredUnit.availableTeacherIds[0];
  selectedReq = { ...req, lessonIds: [selectedLessonId], targetTeacherId: selectedTeacherId };
  const finalPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview?response=compact", headers, payload: { revision: initial.revision, request: selectedReq } });
  assert.equal(finalPreviewResponse.statusCode, 200, finalPreviewResponse.body);
  const finalPreview = finalPreviewResponse.json().preview;
  unit = finalPreview.units.find((item) => item.lessonIds.includes(selectedLessonId));
  assert.ok(unit?.teacherId === selectedTeacherId && !unit.reason, `Final application fixture is unavailable: ${unit?.reason}`);

  const beforeFailureHashes = {
    lessons: hashQuery("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id"),
    origins: hashQuery("SELECT id,lesson_id,origin_json FROM teacher_lesson_origins ORDER BY id"),
    assignments: hashQuery("SELECT id,assignment_json FROM teacher_teaching_assignments ORDER BY id"),
    policies: hashQuery("SELECT id,policy_json FROM temporary_teacher_replacements ORDER BY id"),
    slots: beforeHashes.slots,
    days: beforeHashes.days,
    publications: beforeHashes.publications,
    revision: app.smenaDb.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get(),
  };
  app.smenaDb.exec("CREATE TEMP TRIGGER qa_fail_reassignment_operation BEFORE INSERT ON teacher_reassignment_operations BEGIN SELECT RAISE(ABORT,'qa-write-fail'); END");
  const failedApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: { revision: initial.revision, requestId: `accept-fail-${randomUUID()}`, request: selectedReq, expectedUnits: [{ unitId: unit.id, teacherId: selectedTeacherId }] } });
  app.smenaDb.exec("DROP TRIGGER qa_fail_reassignment_operation");
  assert.equal(failedApply.statusCode, 500, `Injected write failure should return 500, got ${failedApply.statusCode}: ${failedApply.body}`);
  assert.deepEqual({
    lessons: hashQuery("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id"),
    origins: hashQuery("SELECT id,lesson_id,origin_json FROM teacher_lesson_origins ORDER BY id"),
    assignments: hashQuery("SELECT id,assignment_json FROM teacher_teaching_assignments ORDER BY id"),
    policies: hashQuery("SELECT id,policy_json FROM temporary_teacher_replacements ORDER BY id"),
    slots: hashQuery("SELECT id,day_id,slot_index,start_minute,duration FROM schedule_slots ORDER BY id"),
    days: hashQuery("SELECT id,group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note FROM schedule_days ORDER BY id"),
    publications: hashQuery("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters ORDER BY quarter_id"),
    revision: app.smenaDb.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get(),
  }, beforeFailureHashes, "A mid-transaction apply failure must leave all source and metadata rows unchanged");
  record("mid-transaction-apply-failure-is-atomic", "passed", { statusCode: failedApply.statusCode, lessonsSlotsDaysPublicationsAndRevisionUnchanged: true });

  const applyRun = await millis(async () => app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: { revision: initial.revision, requestId: `accept-${randomUUID()}`, request: selectedReq, expectedUnits: [{ unitId: unit.id, teacherId: selectedTeacherId }] } }))();
  assert.equal(applyRun.result.statusCode, 200, applyRun.result.body);
  const receipt = applyRun.result.json();
  const afterApply = query("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id");
  const afterById = new Map(afterApply.map((row) => [row.id, row]));
  const changed = allLessons.filter((old) => JSON.stringify(old) !== JSON.stringify(afterById.get(old.id)));
  assert.deepEqual(changed.map((row) => row.id).sort(), [...unit.lessonIds].sort(), "Apply changed lessons outside the selected unit or failed to update all mirrors");
  const changedBefore = selectedLesson;
  const changedAfter = afterById.get(selectedLessonId);
  for (const field of ["id", "slot_id", "subject_id", "subgroup", "room", "event", "note"]) assert.equal(changedAfter[field], changedBefore[field], `Apply changed unrelated lesson field ${field}`);
  assert.equal(changedAfter.teacher_ref, selectedTeacherId);
  assert.deepEqual({ slots: hashQuery("SELECT id,day_id,slot_index,start_minute,duration FROM schedule_slots ORDER BY id"), days: hashQuery("SELECT id,group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note FROM schedule_days ORDER BY id"), publications: hashQuery("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters ORDER BY quarter_id") }, { slots: beforeHashes.slots, days: beforeHashes.days, publications: beforeHashes.publications });
  record("single-selection-apply-isolation", "passed", { changedLessonCount: changed.length, mirrorCount: unit.lessonIds.length, durationMs: applyRun.ms, publicationStable: true, slotAndDayRowsStable: true });

  const currentRevision = receipt.revision;
  const undoRun = await millis(async () => app.inject({ method: "POST", url: `/api/teacher-reassignments/${receipt.operationId}/undo?response=receipt`, headers, payload: { revision: currentRevision, requestId: `accept-undo-${randomUUID()}` } }))();
  assert.equal(undoRun.result.statusCode, 200, undoRun.result.body);
  assert.equal(hashQuery("SELECT l.id,l.slot_id,l.subject_id,l.subgroup,l.teacher,l.teacher_ref,l.room,l.event,l.note FROM lessons l ORDER BY l.id"), beforeHashes.lessons, "Undo did not restore every lesson row");
  assert.equal(hashQuery("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters ORDER BY quarter_id"), beforeHashes.publications);
  record("undo-restores-source-data", "passed", { durationMs: undoRun.ms, allLessonRowsRestored: true });

  const stale = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: initial.revision, request: req } });
  assert.equal(stale.statusCode, 409, `Stale revision should be rejected, got ${stale.statusCode}`);
  record("stale-revision-rejected", "passed", { statusCode: stale.statusCode });

  const jointStateBeforeFixture = (await app.inject({ url: "/api/state", headers })).json();
  const jointSubjectId = "math";
  const jointQuarter = jointStateBeforeFixture.quarters.find((quarter) => quarter.id === picked.quarter.id);
  const hasWholePlan = (groupId) => jointStateBeforeFixture.studyPlans.some((plan) => plan.quarterId === jointQuarter.id && plan.groupId === groupId && plan.subjectId === jointSubjectId && plan.mode === "whole" && plan.assignments.some((assignment) => assignment.subgroupId === null));
  const plannedGroups = jointStateBeforeFixture.catalog.groups.filter((group) => !group.archived && hasWholePlan(group.id));
  const jointRoom = { id: "accept-joint-room", name: "Приёмочный кабинет", capacity: 10000, kind: "general" };
  let jointFixture;
  for (let a = 0; a < plannedGroups.length && !jointFixture; a++) for (let b = a + 1; b < plannedGroups.length && !jointFixture; b++) {
    const groups = [plannedGroups[a], plannedGroups[b]];
    const offsetsA = Object.keys(jointStateBeforeFixture.schedule).filter((key) => key.startsWith(`${groups[0].id}:`));
    for (const keyA of offsetsA) {
      const offset = keyA.slice(keyA.lastIndexOf(":") + 1);
      const daysA = jointStateBeforeFixture.schedule[keyA] ?? [];
      const daysB = jointStateBeforeFixture.schedule[`${groups[1].id}:${offset}`] ?? [];
      for (const dayA of daysA) {
        if (dayA.date < jointQuarter.startDate || dayA.date > jointQuarter.endDate) continue;
        const dayB = daysB.find((day) => day.date === dayA.date);
        if (!dayB) continue;
        for (let slot = 0; slot < Math.min(dayA.slots.length, dayB.slots.length); slot++) {
          const time = dayA.times[slot];
          if (!time || dayA.slots[slot].length || dayB.slots[slot].length || dayB.times[slot]?.start !== time.start || dayB.times[slot]?.duration !== time.duration) continue;
          const freeMathTeachers = jointStateBeforeFixture.catalog.teachers.filter((teacher) => !teacher.archived && teacher.subjectIds.includes(jointSubjectId) && !Object.values(jointStateBeforeFixture.schedule).some((days) => days.some((day) => day.date === dayA.date && day.slots.some((lessons, index) => day.times[index] && day.times[index].start < time.start + time.duration && time.start < day.times[index].start + day.times[index].duration && lessons.some((lesson) => lesson.teacherId === teacher.id)))));
          if (freeMathTeachers.length < 2) continue;
          const sourceTeacher = freeMathTeachers[0];
          jointFixture = { groups, date: dayA.date, slot, time, room: jointRoom, sourceTeacher };
          break;
        }
        if (jointFixture) break;
      }
    }
  }
  assert.ok(jointFixture, "Could not find two planned groups with a shared free slot for joint apply");
  const jointSubjectRow = app.smenaDb.prepare("SELECT joint_group_sets,max_joint_groups FROM catalog_subjects WHERE id=?").get(jointSubjectId);
  const jointGroupSets = JSON.parse(jointSubjectRow.joint_group_sets);
  if (!jointGroupSets.some((set) => jointFixture.groups.every((group) => set.includes(group.id)))) jointGroupSets.push(jointFixture.groups.map((group) => group.id));
  const addJoint = app.smenaDb.transaction(() => {
    app.smenaDb.prepare("INSERT INTO catalog_rooms(id,name,capacity,kind,archived) VALUES(?,?,?,? ,0)")
      .run(jointRoom.id, jointRoom.name, jointRoom.capacity, jointRoom.kind);
    app.smenaDb.prepare("UPDATE catalog_subjects SET joint_group_sets=?,max_joint_groups=? WHERE id=?")
      .run(JSON.stringify(jointGroupSets), Math.max(2, jointSubjectRow.max_joint_groups), jointSubjectId);
    const ids = ["accept-apply-joint-a", "accept-apply-joint-b"];
    const slotIds = [];
    for (const [index, group] of jointFixture.groups.entries()) {
      const day = app.smenaDb.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get(group.id, jointFixture.date);
      const slot = app.smenaDb.prepare("SELECT id FROM schedule_slots WHERE day_id=? ORDER BY slot_index LIMIT 1 OFFSET ?").get(day.id, jointFixture.slot);
      if (!slot) throw new Error(`Missing existing free slot ${group.id}/${jointFixture.date}/${jointFixture.slot}`);
      app.smenaDb.prepare(`INSERT INTO lessons(id,slot_id,subject_id,subgroup,teacher,room,event,note,teacher_ref,room_ref,subgroup_ref,lesson_kind,joint_id,event_remainder_json)
        VALUES(?,?,?,NULL,?,?,NULL,NULL,?, ?,NULL,'regular','accept-apply-joint',NULL)`)
        .run(ids[index], slot.id, jointSubjectId, jointFixture.sourceTeacher.name, jointFixture.room.name, jointFixture.sourceTeacher.id, jointFixture.room.id);
      slotIds.push(slot.id);
    }
    app.smenaDb.prepare("INSERT INTO catalog_teachers(id,name,archived,default_room_id,preferred_group_ids) VALUES(?,?,0,NULL,'[]')")
      .run("accept-joint-target", "Приёмочный преподаватель математики");
    app.smenaDb.prepare("INSERT INTO catalog_teacher_subjects(teacher_id,subject_id) VALUES(?,?)")
      .run("accept-joint-target", jointSubjectId);
    app.smenaDb.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
    return { ids, slotIds };
  })();
  const jointState = (await app.inject({ url: "/api/state", headers })).json();
  const jointFoundInState = Object.values(jointState.schedule).some((days) => days.some((day) => day.slots.some((slot) => slot.some((lesson) => lesson.id === "accept-apply-joint-a"))));
  const jointRequestBase = { mode: "assign", quarterId: picked.quarter.id, subjectId: jointSubjectId, sourceTeacherId: jointFixture.sourceTeacher.id, groupIds: jointFixture.groups.map((group) => group.id), scope: "lesson", lessonId: "accept-apply-joint-a", persist: false };
  const jointPreviewResponse = await app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers, payload: { revision: jointState.revision, request: jointRequestBase } });
  assert.equal(jointPreviewResponse.statusCode, 200, JSON.stringify({ body: jointPreviewResponse.body, jointFoundInState, sql: app.smenaDb.prepare("SELECT l.id,d.group_id,d.date,s.start_minute,s.duration FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id LIKE 'accept-apply-joint-%'").all() }));
  const jointPreview = jointPreviewResponse.json().preview;
  const jointApplyUnit = jointPreview.units.find((item) => item.lessonIds.includes("accept-apply-joint-a"));
  assert.deepEqual(jointApplyUnit?.lessonIds, addJoint.ids, "The apply fixture must include both mirrors");
  const jointTarget = jointApplyUnit.availableTeacherIds[0];
  assert.ok(jointTarget, `No available teacher for the joint mirror apply fixture: ${JSON.stringify({ unit: jointApplyUnit, previewKeys: Object.keys(jointPreview), candidates: jointPreview.candidates?.slice(0, 4), assignment: jointPreview.assignment })}`);
  const jointRequest = { ...jointRequestBase, targetTeacherId: jointTarget };
  const jointBefore = query("SELECT id,slot_id,subject_id,subgroup,teacher,teacher_ref,room,event,note FROM lessons WHERE id IN (?,?) ORDER BY id", ...addJoint.ids);
  const jointApply = await app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers, payload: { revision: jointState.revision, requestId: `joint-accept-${randomUUID()}`, request: jointRequest, expectedUnits: [{ unitId: jointApplyUnit.id, teacherId: jointTarget }] } });
  if (jointApply.statusCode === 200) {
    const jointReceipt = jointApply.json();
    const jointAfter = query("SELECT id,slot_id,subject_id,subgroup,teacher,teacher_ref,room,event,note FROM lessons WHERE id IN (?,?) ORDER BY id", ...addJoint.ids);
    assert.deepEqual(jointAfter.map((row) => row.id), addJoint.ids.slice().sort());
    assert.ok(jointAfter.every((row) => row.teacher_ref === jointTarget), "Applying the joint unit must update every mirror");
    for (let i = 0; i < jointBefore.length; i++) for (const field of ["id", "slot_id", "subject_id", "subgroup", "room", "event", "note"]) assert.equal(jointAfter[i][field], jointBefore[i][field]);
    const jointUndo = await app.inject({ method: "POST", url: `/api/teacher-reassignments/${jointReceipt.operationId}/undo?response=receipt`, headers, payload: { revision: jointReceipt.revision, requestId: `joint-undo-${randomUUID()}` } });
    assert.equal(jointUndo.statusCode, 200, jointUndo.body);
    const jointRestored = query("SELECT id,slot_id,subject_id,subgroup,teacher,teacher_ref,room,event,note FROM lessons WHERE id IN (?,?) ORDER BY id", ...addJoint.ids);
    assert.deepEqual(jointRestored, jointBefore, "Undo must restore both joint mirrors and all their fields");
    record("joint-mirror-apply-and-undo", "passed", { mirrorCount: jointAfter.length, teacherId: jointTarget });
  } else assert.fail(`Joint mirror apply must succeed, got ${jointApply.statusCode}: ${jointApply.json().error}`);
  app.smenaDb.transaction(() => {
    app.smenaDb.prepare("DELETE FROM lessons WHERE id IN (?,?)").run(...addJoint.ids);
    app.smenaDb.prepare("DELETE FROM catalog_teachers WHERE id=?").run("accept-joint-target");
    app.smenaDb.prepare("DELETE FROM catalog_rooms WHERE id=?").run(jointRoom.id);
    app.smenaDb.prepare("UPDATE catalog_subjects SET joint_group_sets=?,max_joint_groups=? WHERE id=?")
    .run(jointSubjectRow.joint_group_sets, jointSubjectRow.max_joint_groups, jointSubjectId);
    app.smenaDb.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
  })();

  assert.equal(app.smenaDb.pragma("integrity_check")[0].integrity_check, "ok");
  assert.ok(cases.every((item) => item.status === "passed"), `Acceptance case gap: ${JSON.stringify(cases.filter((item) => item.status !== "passed"))}`);
  const report = { format: "teacher-reassignment-acceptance-v1", overall: cases.some((item) => item.status === "gap") ? "passed_with_gaps" : "passed", source: { lessons: allLessons.length, groups: initial.catalog.groups.length, teachers: initial.catalog.teachers.length, revision: baselineRevision, fixtureRevision: initial.revision }, selectedFixture: { date: picked.date, quarterId: picked.quarter.id, scope: "partial selection in quarter", groupId: picked.groupId, subjectId: picked.lesson.subjectId }, cases, elapsedMs: Date.now() - started, integrity: "ok" };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, source: report.source, cases, elapsedMs: report.elapsedMs }));
} catch (error) {
  const failed = { format: "teacher-reassignment-acceptance-v1", cases, error: error instanceof Error ? error.message : String(error) };
  writeFileSync(reportPath, `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 });
  throw error;
} finally {
  await app.close();
}
