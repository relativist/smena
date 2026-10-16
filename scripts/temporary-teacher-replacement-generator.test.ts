import assert from "node:assert/strict";
import test from "node:test";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";
import type { TemporaryTeacherReplacement } from "../shared/temporaryTeacherReplacements.ts";

const quarter: Quarter = { id: "q", name: "Тест", startDate: "2026-09-01", endDate: "2026-09-03" };
const catalog: Catalog = {
  groups: [{ id: "g", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] }],
  subgroups: [{ id: "sg1", name: "5А/1", groupId: "g", students: 10, archived: false }, { id: "sg2", name: "5А/2", groupId: "g", students: 10, archived: false }],
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", archived: false, color: "blue", roomKind: null, labRoomKind: null, jointGroupSets: [["g", "peer"]] }],
  teachers: [
    { id: "source", name: "Исходный", archived: false, subjectIds: ["math"], defaultRoomId: null, unavailability: [{ id: "sick", startDate: "2026-09-01", endDate: "2026-09-01", start: 510, end: 555, reason: "Больничный" }] },
    { id: "sub", name: "Замена", archived: false, subjectIds: ["math"], defaultRoomId: null, preferredGroupIds: ["g"] },
    { id: "other", name: "Другой", archived: false, subjectIds: ["math"], defaultRoomId: null },
  ],
  rooms: [{ id: "r", name: "Кабинет", archived: false, kind: "general", capacity: null }],
};
const days = (dates: string[], start = 510) => dates.map((date) => ({
  date, start: "08:30", duration: 45, breaks: [], slots: [[]], times: [{ start, duration: 45 }],
}));
const plan = (subgroupId: string | null = null, target = 1): StudyPlan => ({
  id: `p-${subgroupId ?? "all"}`, quarterId: "q", groupId: "g", subjectId: "math",
  mode: subgroupId ? "subgroups" : "whole", lessonKind: "regular",
  assignments: [{ id: "a", subgroupId, target }],
});
const rule = (overrides: Partial<TemporaryTeacherReplacement> = {}): TemporaryTeacherReplacement => ({
  id: "replace", sourceTeacherId: "source", groupId: "g", subjectId: "math",
  startDate: "2026-09-01", endDate: "2026-09-01", unavailabilityRuleId: "sick", teacherIds: ["sub"], ...overrides,
});
function run(schedule: Schedule, temporaryTeacherReplacements: TemporaryTeacherReplacement[], studyPlan = plan(), useCatalog = catalog) {
  return generateQuarter({ catalog: useCatalog, schedule, quarters: [quarter], studyPlans: [studyPlan], temporaryTeacherReplacements }, "q", ["g"], { preserveExisting: false });
}

test("uses accepted substitute on inclusive absence date and restores source outside it", () => {
  const result = run({ "g:-1": days(["2026-09-01", "2026-09-02", "2026-09-03"]) }, [rule()], plan(null, 3));
  assert.equal(result.added.length, 3);
  assert.deepEqual(Object.fromEntries(result.added.map((item) => [item.date, item.teacherId])), {
    "2026-09-01": "sub", "2026-09-02": "source", "2026-09-03": "source",
  });
});

test("restricts an active policy to its accepted candidates even when another teacher prefers the group", () => {
  const withOtherPreferred = { ...catalog, teachers: catalog.teachers.map((teacher) => teacher.id === "other" ? { ...teacher, preferredGroupIds: ["g"] } : teacher) };
  const result = run({ "g:-1": days(["2026-09-01"]) }, [rule()], plan(), withOtherPreferred);
  assert.equal(result.added[0]?.teacherId, "sub");
});

test("does not place the unavailable source or an occupied substitute", () => {
  const occupied = { id: "busy", subjectId: "math", teacherId: "sub", teacher: "Замена", roomId: "r", room: "Кабинет" };
  const result = run({ "g:-1": days(["2026-09-01"]), "peer:-1": [ { ...days(["2026-09-01"])[0]!, slots: [[occupied]] } ] }, [rule()]);
  assert.equal(result.added.length, 0);
  assert.equal(result.remaining[0]?.missing, 1);
});

test("applies the policy to the exact subgroup only", () => {
  const rules = [rule({ subgroupId: "sg1", subgroup: "5А/1" })];
  const result = run({ "g:-1": days(["2026-09-01"]) }, rules, plan("sg1"));
  assert.equal(result.added[0]?.teacherId, "sub");
});

test("an expired policy does not pin the old source teacher in a later quarter", () => {
  const laterQuarter: Quarter = { id: "q2", name: "Следующая четверть", startDate: "2026-09-08", endDate: "2026-09-08" };
  const laterPlan = { ...plan(), id: "later", quarterId: "q2" };
  const laterCatalog = { ...catalog, teachers: catalog.teachers.map((teacher) => teacher.id === "other" ? { ...teacher, preferredGroupIds: ["g"] } : teacher) };
  const oldLesson = { id: "old-sub", subjectId: "math", teacherId: "sub", teacher: "Замена", roomId: "r", room: "Кабинет" };
  const result = generateQuarter({
    catalog: laterCatalog,
    schedule: { "g:-1": [{ ...days(["2026-09-01"])[0]!, slots: [[oldLesson]] }], "g:0": days(["2026-09-08"]) },
    quarters: [quarter, laterQuarter], studyPlans: [laterPlan], temporaryTeacherReplacements: [rule()],
  }, "q2", ["g"], { preserveExisting: false });
  assert.equal(result.added[0]?.teacherId, "other");
});

test("source unavailability outside the accepted interval allows normal fallback", () => {
  const busySource: Catalog = {
    ...catalog,
    teachers: catalog.teachers.map((teacher) => teacher.id === "source" ? {
      ...teacher,
      unavailability: [...(teacher.unavailability ?? []), { id: "meeting", startDate: "2026-09-02", endDate: "2026-09-02", start: 510, end: 555 }],
    } : teacher),
  };
  const result = run({ "g:-1": days(["2026-09-02"]) }, [rule()], plan(), busySource);
  assert.ok(["sub", "other"].includes(result.added[0]?.teacherId ?? ""));
  assert.notEqual(result.added[0]?.teacherId, "source");
});

test("does not form a joint lesson when the peer group policy disallows the assigned teacher", () => {
  const jointCatalog: Catalog = { ...catalog, groups: [...catalog.groups, { id: "peer", name: "5Б", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] }] };
  const jointQuarter = { ...quarter, startDate: "2026-09-01", endDate: "2026-09-01" };
  const peerPlan = { ...plan(), id: "peer-plan", groupId: "peer" };
  const peerDay = days(["2026-09-01"]);
  const peerRule = rule({ id: "peer-rule", groupId: "peer", startDate: "2026-09-01", endDate: "2026-09-01", teacherIds: ["other"] });
  const result = generateQuarter({
    catalog: jointCatalog,
    schedule: { "g:-1": days(["2026-09-01"]), "peer:-1": peerDay },
    quarters: [jointQuarter], studyPlans: [plan(), peerPlan], temporaryTeacherReplacements: [rule(), peerRule],
  }, "q", ["g", "peer"], { preserveExisting: false });
  const generated = result.added.map((placement) => result.schedule[`${placement.groupId}:-1`]?.[0]?.slots[placement.slot]?.find((lesson) => lesson.id === placement.lessonId));
  assert.equal(generated.every((lesson) => !lesson || !(lesson as typeof lesson & { jointId?: string }).jointId), true);
});

console.log("temporary teacher replacement generator: 7 checks passed");
