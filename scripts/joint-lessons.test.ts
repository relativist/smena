import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "../shared/catalog.ts";
import { getEligibleJointGroupIds, getJointLessonSource, previewJointLesson, type JointState } from "../shared/jointLessons.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [{ id: "math", name: "Математика", shortName: "Матем.", color: "blue", archived: false, roomKind: "general", labRoomKind: null, jointSameGrade: true, maxJointGroups: 3 }],
  teachers: [{ id: "t1", name: "Иванова", archived: false, subjectIds: ["math"], defaultRoomId: "r1" }, { id: "t2", name: "Петрова", archived: false, subjectIds: ["math"], defaultRoomId: null }],
  rooms: [{ id: "r1", name: "312", archived: false, kind: "general", capacity: 80 }, { id: "r2", name: "313", archived: false, kind: "general", capacity: 80 }, { id: "small", name: "Малый", archived: false, kind: "general", capacity: 20 }],
  groups: ["5А", "5Б", "5В"].map((name, i) => ({ id: `g${i + 1}`, name, archived: false, students: 25, leaderId: null, roomId: i === 1 ? "r2" : null, autoRoomIds: [] })), subgroups: [],
};
const lesson = (id: string, extra: Record<string, unknown> = {}) => ({ id, subjectId: "math", teacherId: "t1", teacher: "Иванова", roomId: "r1", room: "312", ...extra });
const day = (slots: any[][], times = [{ start: 480, duration: 45 }, { start: 535, duration: 45 }]) => ({ date: "2026-10-12", start: "08:00", duration: 90, breaks: [10], slots, times });
function state(targetLessons: any[] = [], options: { sourceJoint?: boolean; extraGroups?: boolean; plans?: boolean } = {}): JointState {
  const schedule: Schedule = {};
  for (let i = 1; i <= 3; i++) schedule[`g${i}:1`] = [day(i === 1 ? [options.sourceJoint ? [lesson("source", { jointId: "old-joint" })] : [lesson("source")], []] : [i === 2 ? targetLessons : [], []])];
  if (options.sourceJoint) schedule["g2:1"]![0]!.slots[0] = [lesson("mirror", { jointId: "old-joint" })];
  const studyPlans = options.plans === false ? [{ id: "p1", quarterId: "q", groupId: "g1", subjectId: "math", mode: "whole" as const, lessonKind: "regular" as const, assignments: [{ id: "a1", subgroupId: null, target: 8 }] }] : [1, 2, 3].map(i => ({ id: `p${i}`, quarterId: "q", groupId: `g${i}`, subjectId: "math", mode: "whole" as const, lessonKind: "regular" as const, assignments: [{ id: `a${i}`, subgroupId: null, target: 8 }] }));
  return { schedule, catalog, quarters: [{ id: "q", name: "I", startDate: "2026-10-01", endDate: "2026-10-30" }], studyPlans };
}
const opts = (groupIds = ["g1", "g2"], extra: Record<string, unknown> = {}) => ({ quarterId: "q", sourceGroupId: "g1", sourceLessonId: "source", groupIds, teacherId: "t1", start: 480, duration: 45, ...extra });

test("eligible expansion keeps every locked joint mirror in its original cell", () => {
  const s = state([], { sourceJoint: true });
  s.schedule["g1:1"][0].times[1] = { start: 600, duration: 45 };
  s.schedule["g2:1"][0].slots[1] = [lesson("following", { teacherId: "t2", roomId: "r2" })];
  s.schedule["g3:1"][0].slots = [[{ id: "busy", subjectId: "other" }], [lesson("candidate", { teacherId: "t2", roomId: "r2" })]];
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1", "g2"], { autoTime: true })), []);
  assert.ok(previewJointLesson(s, opts(["g1", "g2", "g3"], { autoTime: true })).conflict);
});

test("joint preview merges compatible lesson, retains both IDs and notes, computes combined seats", () => {
  const s = state([lesson("target", { teacherId: "t2", teacher: "Петрова", note: "оставить заметку" })]);
  const before = structuredClone(s.schedule);
  const preview = previewJointLesson(s, opts());
  assert.equal(preview.conflict, undefined);
  assert.equal(preview.students, 50);
  assert.equal(preview.roomId, "r1");
  assert.deepEqual(preview.changes.map(change => change.kind), ["existing", "merge"]);
  assert.equal(preview.schedule["g1:1"]![0]!.slots[0]![0]!.id, "source");
  assert.equal(preview.schedule["g2:1"]![0]!.slots[0]![0]!.id, "target");
  assert.equal(preview.schedule["g2:1"]![0]!.slots[0]![0]!.note, "оставить заметку");
  assert.equal(preview.schedule["g1:1"]![0]!.slots[0]![0]!.jointId, preview.schedule["g2:1"]![0]!.slots[0]![0]!.jointId);
  assert.equal(preview.hours.find(row => row.groupId === "g2")?.after, 1);
  assert.deepEqual(s.schedule, before);
});

test("joint preview adds to an empty existing cell without moving unrelated lessons", () => {
  const s = state();
  const preview = previewJointLesson(s, opts());
  assert.equal(preview.conflict, undefined);
  assert.deepEqual(preview.changes.map(change => change.kind), ["existing", "add"]);
  assert.ok(preview.schedule["g2:1"]![0]!.slots[0]![0]!.jointId);
  assert.equal(preview.schedule["g2:1"]![0]!.slots[1]!.length, 0);
});

test("source lookup locks existing joint members and selected preview cannot silently drop them", () => {
  const s = state([], { sourceJoint: true });
  assert.deepEqual(getJointLessonSource(s, "g1", "source").lockedGroupIds.sort(), ["g1", "g2"]);
  const preview = previewJointLesson(s, opts(["g1", "g3"]));
  assert.match(preview.conflict!, /связанные группы/);
  assert.equal(preview.schedule, s.schedule);
});

test("unchanged existing joint returns original schedule, while cross-date mirrors are rejected", () => {
  const s = state([], { sourceJoint: true });
  const preview = previewJointLesson(s, opts());
  assert.equal(preview.conflict, undefined);
  assert.equal(preview.schedule, s.schedule);
  assert.ok(preview.changes.every(change => change.kind === "existing"));
  s.schedule["g3:1"]![0]!.slots[1]!.push(lesson("bad-mirror", { jointId: "old-joint" }));
  s.schedule["g3:1"]![0]!.date = "2026-10-13";
  assert.throws(() => getJointLessonSource(s, "g1", "source"), /разных датах/);
});

test("a foreign joint mirror cannot be absorbed and a mixed source cell cannot be edited", () => {
  const foreign = state();
  foreign.schedule["g2:1"]![0]!.slots[0]![0] = lesson("foreign-a", { jointId: "foreign-joint", teacherId: "t2", teacher: "Петрова" });
  foreign.schedule["g3:1"]![0]!.slots[0]![0] = lesson("foreign-b", { jointId: "foreign-joint", teacherId: "t2", teacher: "Петрова" });
  const before = structuredClone(foreign.schedule);
  const preview = previewJointLesson(foreign, opts(["g1", "g2"], { teacherId: "t1", roomId: "r2" }));
  assert.match(preview.conflict!, /другое совместное занятие/);
  assert.deepEqual(foreign.schedule, before);
  const mixed = state([], { sourceJoint: true });
  mixed.schedule["g1:1"]![0]!.slots[0]!.push(lesson("subgroup", { subgroupId: "sg" }));
  const mixedBefore = structuredClone(mixed.schedule);
  assert.match(previewJointLesson(mixed, opts()).conflict!, /вместе с исходным зеркалом есть другие записи/);
  assert.deepEqual(mixed.schedule, mixedBefore);
});

test("preview rejects missing plans, cohort limits, subgroup source, foreign occupancy, overlap and aggregate room capacity", () => {
  const missing = state([], { plans: false });
  assert.match(previewJointLesson(missing, opts()).conflict!, /нет плана/);
  const limited = state(); limited.catalog.subjects[0]!.maxJointGroups = 2;
  assert.match(previewJointLesson(limited, opts(["g1", "g2", "g3"])).conflict!, /не разрешён/);
  const subgroup = state(); subgroup.schedule["g1:1"]![0]!.slots[0]![0]!.subgroupId = "sg";
  assert.match(previewJointLesson(subgroup, opts()).conflict!, /всей группы/);
  const occupied = state([{ id: "foreign", subjectId: "other" }]);
  assert.match(previewJointLesson(occupied, opts()).conflict!, /нет свободной ячейки/);
  const overlap = state();
  overlap.schedule["g2:1"]![0]!.slots[1]![0] = lesson("later", { subjectId: "math" });
  assert.match(previewJointLesson(overlap, opts(["g1", "g2"], { start: 530, duration: 30 })).conflict!, /пересекается/);
  const tooSmall = state();
  assert.match(previewJointLesson(tooSmall, opts(["g1", "g2"], { roomId: "small" })).conflict!, /участников: 50/);
  const noWholeAssignment = state();
  noWholeAssignment.studyPlans.find(item => item.groupId === "g2")!.assignments = [];
  assert.match(previewJointLesson(noWholeAssignment, opts()).conflict!, /нет плана всей группы/);
  assert.match(previewJointLesson(state(), opts(["g1", "g2"], { duration: 181 })).conflict!, /длительность/);
  const reordered = state();
  assert.match(previewJointLesson(reordered, opts(["g1", "g2"], { start: 550, duration: 30 })).conflict!, /пересекается/);
});

test("room auto preference, unavailable teacher, and busy teacher are validated atomically", () => {
  const s = state();
  let preview = previewJointLesson(s, opts());
  assert.equal(preview.roomId, "r1");
  s.catalog.teachers[0]!.unavailability = [{ id: "sick", startDate: "2026-10-12", endDate: "2026-10-12", start: 470, end: 520, reason: "больничный" }];
  preview = previewJointLesson(s, opts());
  assert.match(preview.conflict!, /больничный/);
  delete s.catalog.teachers[0]!.unavailability;
  s.schedule["g3:1"]![0]!.slots[0]![0] = lesson("busy", { subjectId: "other" });
  preview = previewJointLesson(s, opts());
  assert.match(preview.conflict!, /уже ведёт/);
  assert.equal(preview.changes.length, 0);
});

test("auto time joins nearby cells with different intervals and reports changed breaks", () => {
  const s = state([lesson("target", { teacherId: "t2", teacher: "Петрова" })]);
  const sourceDay = s.schedule["g1:1"]![0]!;
  sourceDay.times = [{ start: 840, duration: 45 }, { start: 895, duration: 45 }];
  sourceDay.start = "14:00";
  sourceDay.breaks = [10];
  const targetDay = s.schedule["g2:1"]![0]!;
  targetDay.times = [{ start: 845, duration: 50 }, { start: 905, duration: 45 }];
  targetDay.start = "14:05";
  targetDay.breaks = [10];
  const preview = previewJointLesson(s, opts(["g1", "g2"], { autoTime: true, start: 840, duration: 45 }));
  assert.equal(preview.conflict, undefined);
  assert.equal(preview.time?.start, 840);
  assert.equal(preview.schedule["g2:1"]![0]!.times[0]!.start, 840);
  assert.deepEqual(preview.timingChanges?.map(change => change.groupId), ["g2"]);
  assert.deepEqual(preview.timingChanges?.[0]?.before, { start: 845, duration: 50 });
  assert.equal(preview.schedule["g2:1"]![0]!.slots[0]![0]!.id, "target");
});

test("auto time moves only chosen cells to the nearest feasible interval around a neighboring lesson", () => {
  const s = state([lesson("target", { teacherId: "t2", teacher: "Петрова" })]);
  const sourceDay = s.schedule["g1:1"]![0]!;
  sourceDay.times = [{ start: 840, duration: 45 }, { start: 895, duration: 45 }];
  sourceDay.start = "14:00";
  sourceDay.breaks = [10];
  const targetDay = s.schedule["g2:1"]![0]!;
  targetDay.slots = [[lesson("before", { subjectId: "other" })], targetDay.slots[0]!];
  targetDay.times = [{ start: 800, duration: 45 }, { start: 845, duration: 50 }];
  targetDay.start = "13:20";
  targetDay.breaks = [0];
  const preview = previewJointLesson(s, opts(["g1", "g2"], { autoTime: true, start: 840, duration: 45 }));
  assert.equal(preview.conflict, undefined);
  assert.equal(preview.time?.start, 845);
  assert.deepEqual(preview.timingChanges?.map(change => change.groupId), ["g1", "g2"]);
  assert.equal(preview.schedule["g2:1"]![0]!.slots[0]![0]!.id, "before");
  assert.equal(preview.schedule["g2:1"]![0]!.slots[1]![0]!.id, "target");
  assert.equal(preview.schedule["g2:1"]![0]!.times[0]!.start, 800);
});

test("eligible groups are filtered by whole-group plan and joint group limits", () => {
  const s = state();
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"])), ["g2", "g3"]);
  s.catalog.subjects[0]!.maxJointGroups = 2;
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1", "g2"])), []);
});

test("eligible groups match auto-time rules and exclude mixed or foreign joint cells", () => {
  const s = state([lesson("target", { teacherId: "t2", teacher: "Петрова" })]);
  const sourceDay = s.schedule["g1:1"]![0]!;
  sourceDay.times = [{ start: 840, duration: 45 }, { start: 895, duration: 45 }];
  const targetDay = s.schedule["g2:1"]![0]!;
  targetDay.times = [{ start: 845, duration: 50 }, { start: 905, duration: 45 }];
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"])), []);
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"], { autoTime: true })), ["g2"]);
  targetDay.slots[0]!.push(lesson("mixed", { subjectId: "other" }));
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"], { autoTime: true })), []);
  targetDay.slots[0] = [lesson("target", { jointId: "foreign", teacherId: "t2", teacher: "Петрова" })];
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"], { autoTime: true })), []);
});

test("auto-time tries feasible break boundaries between different group intervals", () => {
  const s = state([lesson("target", { teacherId: "t2", teacher: "Петрова" })]);
  const sourceDay = s.schedule["g1:1"]![0]!;
  sourceDay.times = [{ start: 840, duration: 45 }, { start: 890, duration: 45 }];
  sourceDay.breaks = [5];
  const targetDay = s.schedule["g2:1"]![0]!;
  targetDay.slots = [[lesson("before", { subjectId: "other" })], targetDay.slots[0]!];
  targetDay.times = [{ start: 800, duration: 45 }, { start: 850, duration: 45 }];
  targetDay.breaks = [5];
  const options = opts(["g1", "g2"], { autoTime: true, start: 840, duration: 45 });
  const preview = previewJointLesson(s, options);
  assert.equal(preview.conflict, undefined);
  assert.equal(preview.time?.start, 845);
  assert.deepEqual(getEligibleJointGroupIds(s, opts(["g1"], { autoTime: true })), ["g2"]);
});
