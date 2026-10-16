import assert from "node:assert/strict";
import test from "node:test";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";
import type { TeacherTeachingAssignment } from "../shared/teacherReassignment.ts";

const quarter: Quarter = { id: "q", name: "I четверть", startDate: "2026-09-01", endDate: "2026-09-03" };
const catalog: Catalog = {
  groups: [
    { id: "g1", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "5Б", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  subgroups: [{ id: "sg1", name: "Актуальное имя", groupId: "g1", students: 10, archived: false }],
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", archived: false, color: "blue", roomKind: null, labRoomKind: null, jointGroupSets: [["g1", "g2"]] }],
  teachers: [
    { id: "source", name: "Исходный", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "target", name: "Назначенный", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "target2", name: "Назначенный 2", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "sub", name: "Замена", archived: false, subjectIds: ["math"], defaultRoomId: null },
  ],
  rooms: [{ id: "r", name: "Кабинет", archived: false, kind: "general", capacity: null }],
};
const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
const emptySchedule = (groupIds = ["g1"]): Schedule => Object.fromEntries(groupIds.map(groupId => [
  `${groupId}:-1`, dates.map(date => ({ date, start: "08:30", duration: 45, breaks: [], slots: [[]], times: [{ start: 510, duration: 45 }] })),
]));
const plan = (groupId = "g1", subgroupId: string | null = null, target = 3): StudyPlan => ({
  id: `p-${groupId}-${subgroupId ?? "all"}`, quarterId: "q", groupId, subjectId: "math",
  mode: subgroupId ? "subgroups" : "whole", lessonKind: "regular", assignments: [{ id: "a", subgroupId, target }],
});
const assignment = (overrides: Partial<TeacherTeachingAssignment> = {}): TeacherTeachingAssignment => ({
  id: "a1", sourceTeacherId: "source", targetTeacherId: "target", groupId: "g1", subjectId: "math",
  startDate: "2026-09-01", endDate: "2026-09-01", ...overrides,
});
function run(input: {
  assignments: TeacherTeachingAssignment[];
  schedule?: Schedule;
  useCatalog?: Catalog;
  plans?: StudyPlan[];
  quarters?: Quarter[];
  replacements?: unknown[];
}) {
  return generateQuarter({
    catalog: input.useCatalog ?? catalog,
    schedule: input.schedule ?? emptySchedule(input.plans?.map(item => item.groupId) ?? ["g1"]),
    quarters: input.quarters ?? [quarter],
    studyPlans: input.plans ?? [plan()],
    teachingAssignments: input.assignments,
    temporaryTeacherReplacements: input.replacements as never,
  }, "q", [...new Set((input.plans ?? [plan()]).map(item => item.groupId))], { preserveExisting: false });
}

test("finite assignment affects only its inclusive dates and keeps source continuity afterward", () => {
  const result = run({ assignments: [assignment()] });
  assert.deepEqual(Object.fromEntries(result.added.map(item => [item.date, item.teacherId])), {
    "2026-09-01": "target", "2026-09-02": "source", "2026-09-03": "source",
  });
});

test("open-ended assignment remains active in a later quarter", () => {
  const next: Quarter = { id: "q2", name: "II четверть", startDate: "2026-10-01", endDate: "2026-10-01" };
  const nextPlan = { ...plan("g1", null, 1), id: "p-next", quarterId: "q2" };
  const nextDay: Schedule = { "g1:0": [{ date: "2026-10-01", start: "08:30", duration: 45, breaks: [], slots: [[]], times: [{ start: 510, duration: 45 }] }] };
  const result = generateQuarter({ catalog, schedule: nextDay, quarters: [quarter, next], studyPlans: [nextPlan], teachingAssignments: [assignment({ startDate: "2026-09-01", endDate: null })] }, "q2", ["g1"], { preserveExisting: false });
  assert.equal(result.added[0]?.teacherId, "target");
});

test("latest overlapping active assignment wins", () => {
  const result = run({ assignments: [assignment({ endDate: "2026-09-02" }), assignment({ id: "a2", targetTeacherId: "target2", startDate: "2026-09-02", endDate: "2026-09-03" })] });
  assert.deepEqual(Object.fromEntries(result.added.map(item => [item.date, item.teacherId])), {
    "2026-09-01": "target", "2026-09-02": "target2", "2026-09-03": "target2",
  });
});

test("manual reassignment back to the original teacher supersedes an open transfer from its start date", () => {
  const result = run({ assignments: [
    assignment({ endDate: null }),
    assignment({ id: "back", sourceTeacherId: "target", targetTeacherId: "source", startDate: "2026-09-02", endDate: null }),
  ] });
  assert.deepEqual(Object.fromEntries(result.added.map(item => [item.date, item.teacherId])), {
    "2026-09-01": "target", "2026-09-02": "source", "2026-09-03": "source",
  });
});

test("subgroup assignment matches stable ID after its display name changes", () => {
  const useCatalog = { ...catalog, subgroups: [{ ...catalog.subgroups[0]!, name: "Переименованная подгруппа" }] };
  const result = run({ useCatalog, plans: [plan("g1", "sg1", 1)], assignments: [assignment({ subgroupId: "sg1", subgroup: "Старое имя" })] });
  assert.equal(result.added[0]?.teacherId, "target");
});

test("an unavailable explicit target can use only accepted substitutes from matching absence policy", () => {
  const useCatalog: Catalog = { ...catalog, teachers: catalog.teachers.map(teacher => teacher.id === "target" ? { ...teacher, unavailability: [{ id: "away", startDate: "2026-09-01", endDate: "2026-09-01", start: 510, end: 555 }] } : teacher) };
  const oneDay: Schedule = { "g1:-1": emptySchedule()["g1:-1"]!.slice(0, 1) };
  const result = run({
    useCatalog,
    plans: [plan("g1", null, 1)],
    schedule: oneDay,
    quarters: [{ ...quarter, endDate: "2026-09-01" }],
    assignments: [assignment()],
    replacements: [{ id: "absence", sourceTeacherId: "target", groupId: "g1", subjectId: "math", startDate: "2026-09-01", endDate: "2026-09-01", teacherIds: ["sub"] }],
  });
  assert.equal(result.added[0]?.teacherId, "sub");
});

test("unavailable explicit target without accepted absence substitute remains unplaced", () => {
  const useCatalog: Catalog = { ...catalog, teachers: catalog.teachers.map(teacher => teacher.id === "target" ? { ...teacher, unavailability: [{ id: "away", startDate: "2026-09-01", endDate: "2026-09-01", start: 510, end: 555 }] } : teacher) };
  const oneDay: Schedule = { "g1:-1": emptySchedule()["g1:-1"]!.slice(0, 1) };
  const result = run({ useCatalog, plans: [plan("g1", null, 1)], schedule: oneDay, quarters: [{ ...quarter, endDate: "2026-09-01" }], assignments: [assignment()] });
  assert.equal(result.added.length, 0);
  assert.equal(result.remaining[0]?.missing, 1);
});

test("absence-linked assignment stops on the exact source absence end date even if assignment continues through Sunday", () => {
  const week: Quarter = { id: "q", name: "Неделя", startDate: "2026-09-04", endDate: "2026-09-06" };
  const weekDates = ["2026-09-04", "2026-09-05", "2026-09-06"];
  const weekSchedule: Schedule = { "g1:-1": weekDates.map(date => ({ date, start: "08:30", duration: 45, breaks: [], slots: [[]], times: [{ start: 510, duration: 45 }] })) };
  const sickCatalog: Catalog = { ...catalog, teachers: catalog.teachers.map(teacher => teacher.id === "source" ? { ...teacher, unavailability: [{ id: "sick", startDate: "2026-09-01", endDate: "2026-09-04", start: 510, end: 555 }] } : teacher) };
  const linked = assignment({ startDate: "2026-09-04", endDate: "2026-09-06", absenceRuleId: "sick" });
  const result = generateQuarter({ catalog: sickCatalog, schedule: weekSchedule, quarters: [week], studyPlans: [plan("g1", null, 3)], teachingAssignments: [linked] }, "q", ["g1"], { preserveExisting: false });
  assert.deepEqual(Object.fromEntries(result.added.map(item => [item.date, item.teacherId])), {
    "2026-09-04": "target", "2026-09-05": "source", "2026-09-06": "source",
  });
});

test("absence-linked assignment is ignored after its source absence rule is deleted", () => {
  const result = run({ assignments: [assignment({ absenceRuleId: "deleted-sick" })], plans: [plan("g1", null, 1)] });
  assert.equal(result.added[0]?.teacherId, "source");
});

test("permanent assignment without an absence link remains active while source is available", () => {
  const result = run({ assignments: [assignment({ startDate: "2026-09-01", endDate: null })], plans: [plan("g1", null, 1)] });
  assert.equal(result.added[0]?.teacherId, "target");
});

test("joint lessons are not formed when participant assignments require different teachers", () => {
  const plans = [plan("g1", null, 1), plan("g2", null, 1)];
  const result = run({ plans, assignments: [assignment({ endDate: "2026-09-03" }), assignment({ id: "a2", groupId: "g2", targetTeacherId: "target2", endDate: "2026-09-03" })] });
  assert.equal(result.added.length, 2);
  assert.deepEqual(Object.fromEntries(result.added.map(item => [item.groupId, item.teacherId])), { g1: "target", g2: "target2" });
  assert.equal(result.added.every(item => !("jointId" in (result.schedule[`${item.groupId}:-1`]![dates.indexOf(item.date)]!.slots[item.slot]![0] as object))), true);
});
