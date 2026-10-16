import assert from "node:assert/strict";
import { previewScheduleCopy, type CopyState } from "../shared/scheduleCopy.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";

const quarter: Quarter = { id: "q1", name: "I четверть", startDate: "2026-10-05", endDate: "2026-10-31" };
const catalog: Catalog = {
  groups: [
    { id: "g1", name: "5А", students: 22, leaderId: null, roomId: "r1", autoRoomIds: [], archived: false },
    { id: "g2", name: "5Б", students: 21, leaderId: null, roomId: "r1", autoRoomIds: [], archived: false },
  ],
  subgroups: [
    { id: "a", name: "5А/1", groupId: "g1", students: 11, archived: false },
    { id: "b", name: "5А/2", groupId: "g1", students: 11, archived: false },
  ],
  subjects: [
    { id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, jointGroupSets: [["g1", "g2"]], archived: false },
    { id: "gym", name: "Физкультура", shortName: "Физ.", color: "green", roomKind: "gym", labRoomKind: null, archived: false },
  ],
  teachers: [
    { id: "t1", name: "Иванова Анна", subjectIds: ["math", "gym"], defaultRoomId: null, archived: false },
    { id: "t2", name: "Петров Пётр", subjectIds: ["math"], defaultRoomId: null, archived: false },
  ],
  rooms: [
    { id: "r1", name: "101", kind: "general", capacity: 50, archived: false },
    { id: "r2", name: "Спортзал", kind: "gym", capacity: 40, archived: false },
    { id: "r3", name: "102", kind: "general", capacity: 50, archived: false },
    { id: "small", name: "Маленький", kind: "general", capacity: 5, archived: false },
  ],
};
const plan = (groupId = "g1", subjectId = "math", mode: StudyPlan["mode"] = "whole", assignmentSubgroups: Array<string | null> = [null]): StudyPlan => ({
  id: `${groupId}-${subjectId}`, quarterId: "q1", groupId, subjectId, mode, lessonKind: "regular",
  assignments: assignmentSubgroups.map((subgroupId, index) => ({ id: `a-${index}`, subgroupId, target: 10 })),
});
const day = (date: string, duration = 45, slots: EditorDay["slots"] = [[], []], holiday = false): EditorDay => ({
  date, start: "08:00", duration, breaks: [10], slots, times: slots.map((_, index) => ({ start: 480 + index * (duration + 10), duration })), holiday,
});
const lesson = (id: string, overrides: Partial<EditorLesson> = {}): EditorLesson => ({ id, subjectId: "math", teacherId: "t1", teacher: "Иванова", roomId: "r1", room: "101", note: "Сохранить заметку", ...overrides });
function state(schedule: Schedule, plans: StudyPlan[] = [plan()]): CopyState { return { schedule, catalog, quarters: [quarter], studyPlans: plans }; }
const copy = (s: CopyState, more: Partial<Parameters<typeof previewScheduleCopy>[1]> = {}) => previewScheduleCopy(s, { mode: "week", quarterId: "q1", sourceGroupId: "g1", sourceWeekOffset: 0, targetWeekOffsets: [1], ...more });

// Target bells determine duration; copied lesson identity, details, and resources stay intact.
{
  const source = { "g1:0": [day("2026-10-05", 45, [[lesson("src")], []])], "g1:1": [day("2026-10-12", 30)] };
  const result = copy(state(source));
  assert.equal(result.added.length, 1);
  const copied = result.schedule["g1:1"]![0]!.slots[0]![0]!;
  assert.equal(copied.id, result.added[0]!.lessonId);
  assert.notEqual(copied.id, "src");
  assert.equal(copied.note, "Сохранить заметку");
  assert.equal(copied.teacherId, "t1");
  assert.equal(copied.roomId, "r1");
  assert.equal(result.schedule["g1:1"]![0]!.times[0]!.duration, 30);
  assert.equal(result.hours[0]!.before, 1);
  assert.equal(result.hours[0]!.after, 2);
  const legacy = state({ "g1:0": [day("2026-10-05", 45, [[lesson("legacy", { teacherId: undefined, teacher: "иванова", roomId: undefined, room: "101" })], []])], "g1:1": [day("2026-10-12")] });
  assert.equal(copy(legacy).added.length, 1);
  const unresolved = state({ "g1:0": [day("2026-10-05", 45, [[lesson("legacy-bad", { teacherId: undefined, teacher: "Неизвестный" })], []])], "g1:1": [day("2026-10-12")] });
  assert.match(copy(unresolved).skipped[0]!.reason, /Преподаватель отсутствует/);
}

// Existing destination lessons are retained, and repeating is idempotent.
{
  const occupied = lesson("existing", { subjectId: "math", teacherId: "t2" });
  const source = { "g1:0": [day("2026-10-05", 45, [[lesson("src")], []])], "g1:1": [day("2026-10-12", 45, [[occupied], []])] };
  const input = state(source);
  const first = copy(input);
  assert.equal(first.added.length, 0);
  assert.match(first.skipped[0]!.reason, /ячейке/);
  assert.equal(first.schedule["g1:1"]![0]!.slots[0]![0]!.id, "existing");
  assert.strictEqual(first.schedule, source);
  const open = { ...source, "g1:1": [day("2026-10-12")] };
  const s = state(open);
  const once = copy(s);
  const twice = copy({ ...s, schedule: once.schedule });
  assert.equal(once.added.length, 1);
  assert.equal(twice.added.length, 0);
}

// Holidays, weekends, and quarter boundaries produce explicit skips.
{
  const source = { "g1:0": [day("2026-10-05", 45, [[lesson("src")], []])], "g1:1": [day("2026-10-12", 45, [[], []], true)] };
  const holiday = copy(state(source));
  assert.match(holiday.skipped[0]!.reason, /календарю/);
  const calendarState: CopyState = { ...state({ ...source, "g1:1": [day("2026-10-12")] }), calendar: { weekdays: [1, 2, 3, 4, 5], periods: [{ id: "off", name: "Каникулы", kind: "holiday", startDate: "2026-10-12", endDate: "2026-10-12", groupIds: ["g1"] }] } };
  assert.match(copy(calendarState).skipped[0]!.reason, /календарю/);
  const edgeQuarter = { ...quarter, endDate: "2026-10-07" };
  const edge = previewScheduleCopy({ ...state(source), quarters: [edgeQuarter] }, { mode: "week", quarterId: "q1", sourceGroupId: "g1", sourceWeekOffset: 0, targetWeekOffsets: [1] });
  assert.match(edge.skipped[0]!.reason, /пределами/);
}

// Availability, resource collisions, and room suitability reject the copied unit.
{
  const source = { "g1:0": [day("2026-10-05", 45, [[lesson("src")], []])], "g1:1": [day("2026-10-12")] };
  const unavailableCatalog: Catalog = { ...catalog, teachers: catalog.teachers.map((entry) => entry.id === "t1" ? { ...entry, unavailability: [{ id: "sick", startDate: "2026-10-12", endDate: "2026-10-12", start: 480, end: 530, reason: "Больничный" }] } : entry) };
  assert.match(previewScheduleCopy({ ...state(source), catalog: unavailableCatalog }, { mode: "week", quarterId: "q1", sourceGroupId: "g1", sourceWeekOffset: 0, targetWeekOffsets: [1] }).skipped[0]!.reason, /Больничный/);
  const occupiedResource = { ...source, "g2:1": [day("2026-10-12", 45, [[lesson("busy")], []])] };
  assert.match(copy(state(occupiedResource), { targetWeekOffsets: [1] }).skipped[0]!.reason, /преподавател|кабинет/i);
  const gymSource = { "g1:0": [day("2026-10-05", 45, [[lesson("src-gym", { subjectId: "gym", roomId: "r1", room: "101" })], []])], "g1:1": [day("2026-10-12")] };
  assert.match(copy(state(gymSource, [plan("g1", "gym")])).skipped[0]!.reason, /тип|кабинет/i);
  const smallSource = { "g1:0": [day("2026-10-05", 45, [[lesson("src-small", { roomId: "small", room: "Маленький" })], []])], "g1:1": [day("2026-10-12")] };
  assert.match(copy(state(smallSource)).skipped[0]!.reason, /человек|рассчитан/);
}

// Joint lessons keep mirrors atomic, get a fresh id, and require matching target times.
{
  const jointA = lesson("ja", { jointId: "old-joint" });
  const jointB = lesson("jb", { jointId: "old-joint" });
  const schedule = {
    "g1:0": [day("2026-10-05", 45, [[jointA], []])], "g2:0": [day("2026-10-05", 45, [[jointB], []])],
    "g1:1": [day("2026-10-12")], "g2:1": [day("2026-10-12")],
  };
  const result = copy(state(schedule, [plan("g1"), plan("g2") ]));
  assert.equal(result.added.length, 2);
  assert.notEqual(result.added[0]!.jointId, "old-joint");
  assert.equal(result.added[0]!.jointId, result.added[1]!.jointId);
  assert.deepEqual(result.linkedGroupIds, ["g2"]);
  const mismatch = { ...schedule, "g2:1": [day("2026-10-12", 35)] };
  const skipped = copy(state(mismatch, [plan("g1"), plan("g2") ]));
  assert.equal(skipped.added.length, 0);
  assert.equal(skipped.skipped.length, 2);
  assert.match(skipped.skipped[0]!.reason, /времена/);
  const revoked = { ...catalog, subjects: catalog.subjects.map((subject) => subject.id === "math" ? { ...subject, jointGroupSets: [] } : subject) };
  assert.match(previewScheduleCopy({ ...state(schedule, [plan("g1"), plan("g2")]), catalog: revoked }, { mode: "week", quarterId: "q1", sourceGroupId: "g1", sourceWeekOffset: 0, targetWeekOffsets: [1] }).skipped[0]!.reason, /не разрешён/);
  const malformed = {
    ...schedule,
    "g1:0": [day("2026-10-05", 45, [[lesson("ja", { jointId: "bad", subgroupId: "a", subgroup: "5А/1" })], []])],
    "g2:0": [day("2026-10-05", 45, [[lesson("jb", { jointId: "bad" })], []])],
  };
  assert.match(copy(state(malformed, [plan("g1", "math", "subgroups", ["a"]), plan("g2")])).skipped[0]!.reason, /всей группы/);
}

// Events preserve their metadata and mirrors without requiring a study plan.
{
  const eventA = lesson("ea", { subjectId: "event", event: "Линейка", teacherId: "t1", roomId: "r1", jointId: "event-joint" });
  const eventB = lesson("eb", { subjectId: "event", event: "Линейка", teacherId: "t1", roomId: "r1", jointId: "event-joint" });
  const schedule = { "g1:0": [day("2026-10-05", 45, [[eventA], []])], "g2:0": [day("2026-10-05", 45, [[eventB], []])], "g1:1": [day("2026-10-12")], "g2:1": [day("2026-10-12")] };
  const result = copy(state(schedule, []));
  assert.equal(result.added.length, 2);
  assert.equal(result.added[0]!.event, "Линейка");
  assert.equal(result.added[0]!.jointId, result.added[1]!.jointId);
}

// Subgroup plans copy separate assignments while preserving subgroup identity.
{
  const a = lesson("sa", { subgroupId: "a", subgroup: "5А/1" });
  const b = lesson("sb", { subgroupId: "b", subgroup: "5А/2", teacherId: "t2", roomId: "r3", room: "102" });
  const schedule = { "g1:0": [day("2026-10-05", 45, [[a, b], []])], "g1:1": [day("2026-10-12")] };
  const result = copy(state(schedule, [plan("g1", "math", "subgroups", ["a", "b"])]));
  assert.equal(result.added.length, 2);
  assert.deepEqual(result.schedule["g1:1"]![0]!.slots[0]!.map((item) => item.subgroupId).sort(), ["a", "b"]);
  const legacySubgroupSchedule = {
    "g1:0": [day("2026-10-05", 45, [[lesson("legacy-subgroup", { subgroupId: undefined, subgroup: "5А/1" })], []])],
    "g1:1": [day("2026-10-12", 45, [[lesson("target-b", { subgroupId: undefined, subgroup: "5А/2", teacherId: "t2", roomId: "r3", room: "102" })], []])],
  };
  const legacyCopy = copy(state(legacySubgroupSchedule, [plan("g1", "math", "subgroups", ["a", "b"])]));
  assert.equal(legacyCopy.added.length, 1);
  assert.equal(legacyCopy.schedule["g1:1"]![0]!.slots[0]!.find((item) => item.id === legacyCopy.added[0]!.lessonId)!.subgroupId, "a");
  const wrongKind = state(schedule, [{ ...plan("g1", "math", "subgroups", ["a", "b"]), lessonKind: "lab" }]);
  assert.match(copy(wrongKind).skipped[0]!.reason, /учебного плана/);
}

// Selected-lesson mode only repeats its source lesson; invalid offsets are rejected.
{
  const schedule = { "g1:0": [day("2026-10-05", 45, [[lesson("one")], [lesson("two", { teacherId: "t2" })]])], "g1:1": [day("2026-10-12")] };
  const result = copy(state(schedule), { mode: "lesson", sourceLessonId: "two" });
  assert.equal(result.sourceLessonCount, 1);
  assert.equal(result.added[0]!.sourceLessonId, "two");
  assert.throws(() => copy(state(schedule), { targetWeekOffsets: [1.5] }), /целыми числами/);
}

console.log("Schedule copy tests passed");
