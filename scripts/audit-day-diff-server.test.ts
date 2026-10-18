import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { EditorDayChange, StateResponse } from "../server/contracts.ts";
import { appendSlot, removeEmptySlot } from "../src/editor.ts";
import { previewDayTiming } from "../shared/dayTiming.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smena-audit-day-diff-")); roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") }); apps.push(app);
  const origin = "http://127.0.0.1";
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "audit day diff test password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { origin, host: "127.0.0.1", cookie: String(auth.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": auth.json().csrfToken as string };
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  const state = async () => {
    const response = await app.inject({ url: "/api/state", headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as StateResponse;
  };
  const save = (revision: number, changes: EditorDayChange[]) => app.inject({ method: "PUT", url: "/api/editor/days", headers,
    payload: { revision, changes, requestId: crypto.randomUUID() } });
  return { app, headers, db, state, save };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const lessonRows = (db: Database.Database) => db.prepare("SELECT rowid AS insertion_order,* FROM lessons ORDER BY id").all() as Array<Record<string, unknown>>;
const slotRows = (db: Database.Database) => db.prepare("SELECT * FROM schedule_slots ORDER BY id").all();
const unrelated = (db: Database.Database) => Object.fromEntries([
  "catalog_teachers", "catalog_rooms", "catalog_subjects", "catalog_groups", "catalog_subgroups", "study_plans", "plan_assignments", "published_quarters",
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test("P2-3 note edits retain every physical slot and unrelated raw lesson field", async () => {
  const f = await fixture();
  // References still resolve to catalog display labels, while raw legacy strings
  // deliberately differ for the edited lesson and all of its neighbours.
  f.db.prepare("UPDATE lessons SET teacher='legacy teacher',room='legacy room',subgroup=CASE WHEN subgroup_ref IS NULL THEN subgroup ELSE 'legacy subgroup' END WHERE teacher_ref IS NOT NULL").run();
  const initial = await f.state();
  const [key, days] = Object.entries(initial.schedule).find(([, days]) => days.some(day => day.slots.flat().some(lesson => lesson.teacherId)))!;
  const dayIndex = days.findIndex(day => day.slots.flat().some(lesson => lesson.teacherId));
  const before = days[dayIndex]!;
  const after = structuredClone(before);
  const edited = after.slots.flat().find(lesson => lesson.teacherId)!; edited.note = "exactly one note";
  const rows = lessonRows(f.db), slots = slotRows(f.db), other = unrelated(f.db);
  f.db.exec(`CREATE TRIGGER forbid_slot_update BEFORE UPDATE ON schedule_slots BEGIN SELECT RAISE(ABORT,'unexpected slot update'); END;
    CREATE TRIGGER forbid_slot_delete BEFORE DELETE ON schedule_slots BEGIN SELECT RAISE(ABORT,'unexpected slot delete'); END;
    CREATE TRIGGER forbid_slot_insert BEFORE INSERT ON schedule_slots BEGIN SELECT RAISE(ABORT,'unexpected slot insert'); END;
    CREATE TRIGGER forbid_day_update BEFORE UPDATE ON schedule_days BEGIN SELECT RAISE(ABORT,'unexpected day update'); END;`);
  const saved = await f.save(initial.revision, [{ key, dayIndex, before, after }]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(slotRows(f.db), slots);
  assert.deepEqual(lessonRows(f.db), rows.map(row => row.id === edited.id ? { ...row, note: edited.note } : row));
  assert.deepEqual(unrelated(f.db), other);
});

test("P2-3 dependent time rows update without recreating slots or lessons", async () => {
  const f = await fixture();
  let initial = await f.state();
  const key = "5a:0", dayIndex = 0, source = initial.schedule[key]![dayIndex]!;
  const lesson = source.slots.flat().find(lesson => !lesson.jointId)!;
  assert.ok(lesson);
  f.db.prepare("DELETE FROM lessons WHERE id<>?").run(lesson.id);
  initial = await f.state();
  const before = initial.schedule[key]![dayIndex]!;
  const preview = previewDayTiming(initial.schedule, { date: before.date, groupIds: ["5a"], currentGroupId: "5a", start: before.times[0]!.start + 7,
    duration: before.duration, schoolProfile: before.bellProfile! }, initial.catalog);
  assert.equal(preview.conflict, undefined);
  const after = preview.schedule[key]![dayIndex]!;
  const rows = lessonRows(f.db), slots = slotRows(f.db) as Array<Record<string, unknown>>, other = unrelated(f.db);
  const saved = await f.save(initial.revision, [{ key, dayIndex, before, after }]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(lessonRows(f.db), rows);
  const dayId = (f.db.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get("5a", before.date) as { id: number }).id;
  const expected = slots.map(row => row.day_id !== dayId ? row : { ...row, start_minute: after.times[Number(row.slot_index)]!.start, duration: after.times[Number(row.slot_index)]!.duration });
  assert.deepEqual(slotRows(f.db), expected);
  assert.deepEqual(unrelated(f.db), other);
});

test("P2-3 cross-day swaps and moving out of a removed tail preserve lesson rowids", async () => {
  const f = await fixture();
  let initial = await f.state();
  const key = "5a:0";
  const a = initial.schedule[key]![0]!.slots.flat().find(lesson => !lesson.jointId)!;
  const b = initial.schedule[key]![1]!.slots.flat().find(lesson => !lesson.jointId)!;
  assert.ok(a && b);
  f.db.prepare("DELETE FROM lessons WHERE id NOT IN (?,?)").run(a.id, b.id);
  initial = await f.state();
  const beforeA = initial.schedule[key]![0]!, beforeB = initial.schedule[key]![1]!;
  const indexA = beforeA.slots.findIndex(slot => slot.some(lesson => lesson.id === a.id));
  const indexB = beforeB.slots.findIndex(slot => slot.some(lesson => lesson.id === b.id));
  const afterA = structuredClone(beforeA), afterB = structuredClone(beforeB);
  afterA.slots[indexA] = [beforeB.slots[indexB]![0]!]; afterB.slots[indexB] = [beforeA.slots[indexA]![0]!];
  const rows = lessonRows(f.db), slots = slotRows(f.db);
  const slotA = rows.find(row => row.id === a.id)!.slot_id, slotB = rows.find(row => row.id === b.id)!.slot_id;
  const swap = await f.save(initial.revision, [{ key, dayIndex: 0, before: beforeA, after: afterA }, { key, dayIndex: 1, before: beforeB, after: afterB }]);
  assert.equal(swap.statusCode, 200, swap.body);
  assert.deepEqual(slotRows(f.db), slots);
  assert.deepEqual(lessonRows(f.db), rows.map(row => ({ ...row, slot_id: row.id === a.id ? slotB : slotA })));

  // Move the source into its final physical slot, then remove that slot in the
  // same command that appends the destination. FK cascades must not eat it.
  const tail = f.db.prepare("SELECT s.id FROM schedule_slots s JOIN schedule_days d ON d.id=s.day_id WHERE d.group_id='5a' AND d.date=? ORDER BY s.slot_index DESC LIMIT 1").get(beforeB.date) as { id: number };
  f.db.prepare("UPDATE lessons SET slot_id=? WHERE id=?").run(tail.id, a.id);
  const destinationTail = f.db.prepare("SELECT s.id FROM schedule_slots s JOIN schedule_days d ON d.id=s.day_id WHERE d.group_id='5a' AND d.date=? ORDER BY s.slot_index DESC LIMIT 1").get(beforeA.date) as { id: number };
  f.db.prepare("UPDATE lessons SET slot_id=? WHERE id=?").run(destinationTail.id, b.id);
  initial = await f.state();
  const source = initial.schedule[key]![1]!, destination = initial.schedule[key]![0]!;
  let schedule = appendSlot(initial.schedule, { groupId: "5a", weekOffset: 0, date: destination.date, slot: destination.slots.length - 1 });
  schedule = structuredClone(schedule);
  schedule[key]![0]!.slots.at(-1)!.push(source.slots.at(-1)![0]!);
  schedule[key]![1]!.slots.at(-1)!.length = 0;
  schedule = removeEmptySlot(schedule, { groupId: "5a", weekOffset: 0, date: source.date, slot: source.slots.length - 1 });
  const rawBefore = lessonRows(f.db);
  const moved = await f.save(initial.revision, [{ key, dayIndex: 0, before: destination, after: schedule[key]![0]! }, { key, dayIndex: 1, before: source, after: schedule[key]![1]! }]);
  assert.equal(moved.statusCode, 200, moved.body);
  const rawAfter = lessonRows(f.db);
  assert.deepEqual(rawAfter.map(({ slot_id, ...row }) => row), rawBefore.map(({ slot_id, ...row }) => row));
  assert.equal(f.db.prepare("SELECT id FROM schedule_slots WHERE id=?").get(tail.id), undefined);
  assert.equal(rawAfter.length, 2);
});

test("P2-3 late persistence failure rolls back day/lesson notes, revision and replay", async () => {
  const f = await fixture();
  const initial = await f.state(), key = "5a:0", dayIndex = 0;
  const before = initial.schedule[key]![dayIndex]!, after = structuredClone(before);
  after.note = "must roll back"; after.slots.flat()[0]!.note = "must roll back too";
  const rows = lessonRows(f.db), slots = slotRows(f.db), days = f.db.prepare("SELECT * FROM schedule_days ORDER BY id").all();
  const meta = f.db.prepare("SELECT * FROM draft_metadata").all(), replays = f.db.prepare("SELECT * FROM editor_request_replays").all(), other = unrelated(f.db);
  f.db.exec("CREATE TRIGGER fail_late BEFORE UPDATE ON draft_metadata BEGIN SELECT RAISE(ABORT,'injected late failure'); END;");
  const saved = await f.save(initial.revision, [{ key, dayIndex, before, after }]);
  assert.equal(saved.statusCode, 500, saved.body);
  assert.deepEqual(lessonRows(f.db), rows); assert.deepEqual(slotRows(f.db), slots);
  assert.deepEqual(f.db.prepare("SELECT * FROM schedule_days ORDER BY id").all(), days);
  assert.deepEqual(f.db.prepare("SELECT * FROM draft_metadata").all(), meta);
  assert.deepEqual(f.db.prepare("SELECT * FROM editor_request_replays").all(), replays);
  assert.deepEqual(unrelated(f.db), other);
});

test("P2-3 joint mirrors move together while preserving both physical lesson rows", async () => {
  const f = await fixture();
  const initial = await f.state();
  const dayA = initial.schedule["5a:0"]![0]!, dayB = initial.schedule["5b:0"]![0]!;
  assert.equal(dayA.date, dayB.date);
  const teacher = initial.catalog.teachers.find(teacher => teacher.subjectIds.includes("math"))!;
  const room = initial.catalog.rooms.find(room => room.kind === "general")!;
  assert.ok(teacher && room);
  f.db.prepare("UPDATE catalog_subjects SET joint_group_sets=?,max_joint_groups=2 WHERE id='math'").run(JSON.stringify([["5a", "5b"]]));
  f.db.prepare("UPDATE catalog_rooms SET capacity=200 WHERE id=?").run(room.id);
  f.db.exec("DELETE FROM lessons");
  for (const group of ["5a", "5b"]) {
    const day = f.db.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get(group, dayA.date) as { id: number };
    for (const [index, time] of dayA.times.entries())
      f.db.prepare("UPDATE schedule_slots SET start_minute=?,duration=? WHERE day_id=? AND slot_index=?").run(time.start, time.duration, day.id, index);
    const slot = f.db.prepare("SELECT id FROM schedule_slots WHERE day_id=? AND slot_index=0").get(day.id) as { id: number };
    f.db.prepare("INSERT INTO lessons(id,slot_id,subject_id,teacher,teacher_ref,room,room_ref,lesson_kind,joint_id) VALUES(?,?,'math',?,?,?,?,'regular','audit-joint')")
      .run(`audit-joint-${group}`, slot.id, "legacy joint teacher", teacher.id, "legacy joint room", room.id);
  }
  const state = await f.state(), changes: EditorDayChange[] = [];
  for (const group of ["5a", "5b"]) {
    const key = `${group}:0`, before = state.schedule[key]![0]!, after = structuredClone(before);
    after.slots[1] = after.slots[0]!; after.slots[0] = [];
    changes.push({ key, dayIndex: 0, before, after });
  }
  const rows = lessonRows(f.db), physicalSlots = slotRows(f.db), other = unrelated(f.db);
  const saved = await f.save(state.revision, changes);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(slotRows(f.db), physicalSlots);
  const after = lessonRows(f.db);
  assert.deepEqual(after.map(({ slot_id, ...row }) => row), rows.map(({ slot_id, ...row }) => row));
  assert.ok(after.every((row, index) => row.slot_id !== rows[index]!.slot_id));
  assert.deepEqual(unrelated(f.db), other);
});

test("P2-3 manual reassignment undo performs zero unchanged availability updates", async () => {
  const f = await fixture();
  let state = await f.state();
  const candidate = Object.entries(state.schedule).flatMap(([key, days]) => days.flatMap(day => day.slots.flat().map(lesson => ({ key, date: day.date, lesson }))))
    .find(item => item.lesson.teacherId && !item.lesson.jointId && state.catalog.teachers.some(teacher => teacher.id !== item.lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(item.lesson.subjectId)));
  assert.ok(candidate);
  const target = state.catalog.teachers.find(teacher => teacher.id !== candidate.lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(candidate.lesson.subjectId))!;
  const quarter = state.quarters.find(quarter => quarter.startDate <= candidate.date && quarter.endDate >= candidate.date)!;
  f.db.prepare("DELETE FROM lessons WHERE id<>?").run(candidate.lesson.id);
  state = await f.state();
  const request = { mode: "assign", quarterId: quarter.id, subjectId: candidate.lesson.subjectId, sourceTeacherId: candidate.lesson.teacherId,
    scope: "lesson", lessonId: candidate.lesson.id, targetTeacherId: target.id, persist: false };
  const preview = await f.app.inject({ method: "POST", url: "/api/teacher-reassignments/preview", headers: f.headers, payload: { revision: state.revision, request } });
  assert.equal(preview.statusCode, 200, preview.body);
  const unit = preview.json().preview.units.find((unit: { lessonIds: string[]; reason?: string }) => unit.lessonIds.includes(candidate.lesson.id) && !unit.reason);
  assert.ok(unit);
  const rows = lessonRows(f.db), slots = slotRows(f.db), other = unrelated(f.db);
  const apply = await f.app.inject({ method: "POST", url: "/api/teacher-reassignments/apply?response=receipt", headers: f.headers,
    payload: { revision: state.revision, requestId: crypto.randomUUID(), request, expectedUnits: [{ unitId: unit.id, teacherId: target.id }] } });
  assert.equal(apply.statusCode, 200, apply.body);
  f.db.exec("CREATE TRIGGER reject_unchanged_availability BEFORE UPDATE OF unavailability_json ON catalog_teachers BEGIN SELECT RAISE(ABORT,'unexpected availability update'); END;");
  const undo = await f.app.inject({ method: "POST", url: `/api/teacher-reassignments/${apply.json().operationId}/undo?response=receipt`, headers: f.headers,
    payload: { revision: apply.json().revision, requestId: crypto.randomUUID() } });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.deepEqual(lessonRows(f.db), rows); assert.deepEqual(slotRows(f.db), slots); assert.deepEqual(unrelated(f.db), other);
});

test("P2-3 automatic apply/undo preserve physical rows and restore the raw teacher label", async () => {
  const f = await fixture();
  let state = await f.state();
  const candidate = Object.entries(state.schedule).flatMap(([key, days]) => days.flatMap(day => day.slots.flatMap((slot, index) => slot.map(lesson => ({ key, date: day.date, time: day.times[index]!, lesson })))))
    .find(item => item.lesson.teacherId && item.lesson.roomId && !item.lesson.jointId && state.catalog.teachers.some(teacher => teacher.id !== item.lesson.teacherId && !teacher.archived && teacher.subjectIds.includes(item.lesson.subjectId)));
  assert.ok(candidate);
  f.db.prepare("DELETE FROM lessons WHERE id<>?").run(candidate.lesson.id);
  f.db.prepare("UPDATE lessons SET teacher='legacy automatic source label' WHERE id=?").run(candidate.lesson.id);
  f.db.prepare("UPDATE catalog_teachers SET unavailability_json=? WHERE id=?").run(JSON.stringify([{
    id: "audit-auto-absence", startDate: candidate.date, endDate: candidate.date, start: candidate.time.start, end: candidate.time.start + candidate.time.duration,
  }]), candidate.lesson.teacherId);
  state = await f.state();
  const request = { teacherId: candidate.lesson.teacherId, startDate: candidate.date, endDate: candidate.date, ruleId: "audit-auto-absence" };
  const preview = await f.app.inject({ method: "POST", url: "/api/teacher-replacements/preview?response=compact", headers: f.headers, payload: { revision: state.revision, request } });
  assert.equal(preview.statusCode, 200, preview.body);
  const unit = preview.json().preview.units.find((unit: { lessonIds: string[]; teacherId?: string }) => unit.lessonIds.includes(candidate.lesson.id) && unit.teacherId);
  assert.ok(unit);
  const rows = lessonRows(f.db), slots = slotRows(f.db), other = unrelated(f.db);
  const apply = await f.app.inject({ method: "POST", url: "/api/teacher-replacements/apply?response=receipt", headers: f.headers,
    payload: { revision: state.revision, requestId: crypto.randomUUID(), request, expectedAssignments: [{ unitId: unit.id, teacherId: unit.teacherId }] } });
  assert.equal(apply.statusCode, 200, apply.body);
  const appliedRows = lessonRows(f.db);
  assert.deepEqual(appliedRows.map(({ teacher, teacher_ref, ...row }) => row), rows.map(({ teacher, teacher_ref, ...row }) => row));
  const undo = await f.app.inject({ method: "POST", url: `/api/teacher-replacements/${apply.json().operationId}/undo?response=receipt`, headers: f.headers,
    payload: { revision: apply.json().revision, requestId: crypto.randomUUID() } });
  assert.equal(undo.statusCode, 200, undo.body);
  const restored = lessonRows(f.db);
  assert.deepEqual(restored.map(({ teacher, ...row }) => row), rows.map(({ teacher, ...row }) => row));
  assert.deepEqual(slotRows(f.db), slots); assert.deepEqual(unrelated(f.db), other);
  assert.deepEqual(restored, rows, "undo must restore the selected raw teacher label, as well as stable physical keys");
});
