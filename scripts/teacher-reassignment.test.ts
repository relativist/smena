import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { collectReassignmentLessons, createTeacherReassignmentPreviewCache, previewTeacherReassignment, teacherLessonFingerprint, type TeacherReassignmentState } from "../shared/teacherReassignment.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";

const baseCatalog: Catalog = {
  subjects: [{ id: "physics", name: "Физика", shortName: "Физ.", archived: false, color: "blue", roomKind: null, labRoomKind: null }],
  teachers: [
    { id: "old", name: "Исходный", archived: false, subjectIds: ["physics"], defaultRoomId: null, unavailability: [{ id: "sick", startDate: "2026-10-12", endDate: "2026-10-15", start: 500, end: 800 }] },
    { id: "sub", name: "Замещающий", archived: false, subjectIds: ["physics"], defaultRoomId: null },
    { id: "sub2", name: "Второй заменяющий", archived: false, subjectIds: ["physics"], defaultRoomId: null },
    { id: "busy", name: "Занятой", archived: false, subjectIds: ["physics"], defaultRoomId: null },
    { id: "other", name: "Другой предметник", archived: false, subjectIds: [], defaultRoomId: null },
  ],
  rooms: [{ id: "r", name: "312", archived: false, kind: "general", capacity: null }],
  groups: ["g1", "g2", "g3"].map(id => ({ id, name: id, archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] })),
  subgroups: [],
};
function lesson(id: string, teacherId = "old", extra: Partial<EditorLesson> = {}): EditorLesson {
  return { id, subjectId: "physics", teacherId, teacher: teacherId, roomId: "r", room: "312", ...extra };
}
function day(date: string, entries: EditorLesson[], start = 600): EditorDay {
  return { date, start: "10:00", duration: 45, breaks: [], slots: [entries], times: [{ start, duration: 45 }] };
}
function state(schedule: Schedule, catalog = baseCatalog): TeacherReassignmentState {
  return { schedule, catalog, today: "2026-10-13", quarters: [{ id: "q", name: "Четверть", startDate: "2026-10-12", endDate: "2026-10-18" }] };
}

const initial: Schedule = {
  "g1:0": [day("2026-10-12", [lesson("a")]), day("2026-10-13", [lesson("b")])],
  "g2:0": [day("2026-10-12", [lesson("j1", "old", { jointId: "joint" })])],
  "g3:0": [day("2026-10-12", [lesson("j2", "old", { jointId: "joint" })])],
};

const common = { quarterId: "q", subjectId: "physics", sourceTeacherId: "old", scope: "period" as const };

{
  const units = collectReassignmentLessons(initial, baseCatalog);
  assert.deepEqual(units.find(unit => unit.jointId === "joint")?.lessonIds, ["j1", "j2"]);
  assert.equal(units.find(unit => unit.lessonIds.includes("a"))?.start, 600);
  const stable = lesson("fingerprint", "sub");
  assert.equal(teacherLessonFingerprint({ groupId: "g1", date: "2026-10-12", start: 600, end: 645, lesson: stable }), teacherLessonFingerprint({ groupId: "g1", date: "2026-10-12", start: 600, end: 645, lesson: { ...stable, teacher: "Новое отображаемое имя", room: "313" } }));
}

{
  const result = previewTeacherReassignment(state(initial), { mode: "assign", ...common, sourceTeacherId: undefined, scope: "week", targetTeacherId: "sub", weekStart: "2026-10-12" });
  assert.equal(result.changedLessonIds.length, 0);
  assert.match(result.skipped[0]!.reason, /выберите преподавателя или хотя бы одну группу/);
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "old");
}

{
  const result = previewTeacherReassignment(state(initial), { mode: "assign", ...common, scope: "week", targetTeacherId: "sub", weekStart: "2026-10-12", groupIds: ["g1"] });
  assert.deepEqual(result.changedLessonIds, ["a", "b"]);
  assert.equal(result.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId, "sub");
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId, "old");
  assert.equal(result.teachingAssignments.length, 1);
  assert.equal(result.teachingAssignments[0]!.startDate, "2026-10-12");
  assert.equal(result.teachingAssignments[0]!.endDate, "2026-10-18");
  assert.equal(result.teacherLessonOrigins.length, 2);
  const partialCandidate = previewTeacherReassignment(state({ "g1:0": [day("2026-10-12", [lesson("x")])], "g2:0": [day("2026-10-12", [lesson("y")])] }), { mode: "assign", ...common, scope: "period" });
  assert.deepEqual(partialCandidate.candidates.find(candidate => candidate.id === "sub"), { id: "sub", name: "Замещающий", available: 1, total: 2, reason: "У преподавателя уже есть занятие в это время." });
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("unit-a")]), day("2026-10-13", [lesson("unit-b")])] };
  const units = collectReassignmentLessons(schedule, baseCatalog);
  const targets = Object.fromEntries([[units[0]!.id, "sub"], [units[1]!.id, "sub2"]]);
  const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: targets });
  assert.deepEqual(result.changedLessonIds, ["unit-a", "unit-b"]);
  assert.equal(result.canApply, true, "per-unit selections do not require a global target teacher");
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "sub");
  assert.equal(result.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId, "sub2");
  assert.ok(result.teachingAssignments.every(policy => policy.startDate === policy.endDate), "mixed per-unit policies must be restricted to the selected lesson date");
  assert.equal(result.units.every(unit => unit.availableTeacherIds?.length), true);
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("first")])], "g2:0": [day("2026-10-12", [lesson("second")])] };
  const units = collectReassignmentLessons(schedule, baseCatalog);
  const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: { [units[0]!.id]: "sub", [units[1]!.id]: "sub" } });
  assert.deepEqual(result.changedLessonIds, [units[0]!.lessonIds[0]], "the shared target cannot be assigned to two simultaneous rows");
  assert.ok(!result.units.find(unit => unit.id === units[1]!.id)?.availableTeacherIds?.includes("sub"));
  assert.ok(result.skipped.some(item => item.lessonId === units[1]!.lessonIds[0]));
}

{
  const catalog = structuredClone(baseCatalog);
  catalog.teachers.find(teacher => teacher.id === "sub2")!.unavailability = [{ id: "blocked", startDate: "2026-10-12", endDate: "2026-10-12", start: 590, end: 650 }];
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("retains-sub", "sub")])], "g2:0": [day("2026-10-12", [lesson("needs-sub", "old")])] };
  const units = collectReassignmentLessons(schedule, catalog);
  const result = previewTeacherReassignment(state(schedule, catalog), { mode: "assign", quarterId: "q", subjectId: "physics", scope: "period", unitTeacherIds: { [units[0]!.id]: "sub2", [units[1]!.id]: null } });
  assert.equal(result.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "sub", "a failed row keeps its original teacher");
  assert.ok(!result.units.find(unit => unit.id === units[1]!.id)?.availableTeacherIds?.includes("sub"), "a failed row's original teacher must still count as occupied for other rows");
}

{
  const makeSameDayRows = () => {
    const lessonDay = day("2026-10-12", [lesson("same-day-1")]);
    lessonDay.slots.push([lesson("same-day-2")]);
    lessonDay.times.push({ start: 645, duration: 45 });
    return { "g1:0": [lessonDay] } satisfies Schedule;
  };
  const schedule = makeSameDayRows();
  const units = collectReassignmentLessons(schedule, baseCatalog);
  for (const targets of [
    { [units[0]!.id]: "sub", [units[1]!.id]: "sub2" },
    { [units[0]!.id]: "sub", [units[1]!.id]: null },
  ]) {
    const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: targets });
    assert.ok(result.policyWarnings?.length, "different or null-plus-teacher choices on one stream must explain that the rule is not persisted");
    assert.equal(result.teachingAssignments.length, 0, "the existing broad rule model must not persist conflicting per-row choices");
  }
  const noPersistence = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: { [units[0]!.id]: "sub", [units[1]!.id]: "sub2" }, persist: false });
  assert.equal(noPersistence.policyWarnings?.length ?? 0, 0, "no persistence requested means no persistence warning");
  assert.equal(noPersistence.teachingAssignments.length, 0);
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("already-sub", "sub")])] };
  const unit = collectReassignmentLessons(schedule, baseCatalog)[0]!;
  const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, sourceTeacherId: "sub", scope: "period", unitTeacherIds: { [unit.id]: "sub" } });
  assert.deepEqual(result.changedLessonIds, [], "selecting the current teacher is a no-op");
  assert.equal(result.units[0]!.reason, "Преподаватель не меняется.", "no-op units are not returned as eligible proposed changes");
  assert.equal(result.teacherLessonOrigins.length, 0);
  assert.equal(result.teachingAssignments.length, 0);
  assert.equal(result.canApply, false);
}

{
  const schedule: Schedule = { "g2:0": [day("2026-10-12", [lesson("joint-1", "old", { jointId: "shared" })])], "g3:0": [day("2026-10-12", [lesson("joint-2", "old", { jointId: "shared" })])] };
  const unit = collectReassignmentLessons(schedule, baseCatalog)[0]!;
  const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: { [unit.id]: "sub2" } });
  assert.deepEqual(result.changedLessonIds, ["joint-1", "joint-2"], "joint mirrors stay one unit and share one target");
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("apply-me")]), day("2026-10-13", [lesson("leave-me")])] };
  const units = collectReassignmentLessons(schedule, baseCatalog);
  const result = previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds: { [units[0]!.id]: "sub", [units[1]!.id]: null } });
  assert.deepEqual(result.changedLessonIds, ["apply-me"]);
  assert.ok(result.skipped.some(item => item.lessonId === "leave-me"), "explicit null leaves the unit unchanged and reports the partial skip");
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-12", [lesson("unit")])] };
  const unit = collectReassignmentLessons(schedule, baseCatalog)[0]!;
  const malformed = (unitTeacherIds: unknown) => previewTeacherReassignment(state(schedule), { mode: "assign", ...common, scope: "period", unitTeacherIds } as never);
  assert.match(malformed([]).skipped.map(item => item.reason).join(" "), /должен быть объектом/);
  assert.match(malformed({ unknown: "sub" }).skipped.map(item => item.reason).join(" "), /вне области переназначения/);
  assert.match(malformed({ [unit.id]: 42 }).skipped.map(item => item.reason).join(" "), /Идентификатор преподавателя для урока некорректен/);
  assert.match(malformed({ [unit.id]: "other" }).skipped.map(item => item.reason).join(" "), /не ведёт предмет/);
}

{
  const acrossQuarters: Schedule = { "g1:0": [day("2026-10-12", [lesson("anchor")]), day("2027-01-11", [lesson("next-quarter")])] };
  const data = state(acrossQuarters);
  data.quarters.push({ id: "q2", name: "Вторая четверть", startDate: "2027-01-11", endDate: "2027-03-21" });
  const permanent = previewTeacherReassignment(data, { mode: "assign", quarterId: "q", subjectId: "physics", sourceTeacherId: "old", scope: "period", endDate: null, groupIds: ["g1"], targetTeacherId: "sub" });
  assert.deepEqual(permanent.changedLessonIds, ["anchor", "next-quarter"]);
  assert.equal(permanent.teachingAssignments[0]!.startDate, "2026-10-12");
  assert.equal(permanent.teachingAssignments[0]!.endDate, null);
}

{
  const oneLesson: Schedule = { "g1:0": [day("2026-10-13", [lesson("chain")])] };
  const initialState = state(oneLesson);
  const first = previewTeacherReassignment(initialState, { mode: "assign", ...common, scope: "week", weekStart: "2026-10-12", groupIds: ["g1"], targetTeacherId: "sub" });
  const unrelated = { id: "unrelated-permanent", sourceTeacherId: "old", targetTeacherId: "busy", groupId: "g2", subjectId: "physics", startDate: "2026-10-12", endDate: null };
  const second = previewTeacherReassignment({ ...initialState, schedule: first.schedule, teacherLessonOrigins: first.teacherLessonOrigins, teachingAssignments: [...first.teachingAssignments, unrelated] }, { mode: "assign", quarterId: "q", subjectId: "physics", sourceTeacherId: "sub", scope: "week", weekStart: "2026-10-12", groupIds: ["g1"], targetTeacherId: "sub2" });
  const sickLinked = second.teachingAssignments.find(policy => policy.groupId === "g1");
  assert.equal(sickLinked?.sourceTeacherId, "old");
  assert.equal(sickLinked?.absenceRuleId, "sick");
  assert.equal(sickLinked?.targetTeacherId, "sub2");
  assert.equal(second.teachingAssignments.filter(policy => policy.groupId === "g1" && policy.absenceRuleId === "sick").length, 1);
  const returned = previewTeacherReassignment({ ...initialState, schedule: second.schedule, teacherLessonOrigins: second.teacherLessonOrigins, teachingAssignments: second.teachingAssignments }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.deepEqual(returned.changedLessonIds, ["chain"]);
  assert.equal(returned.teachingAssignments.find(policy => policy.groupId === "g1" && policy.absenceRuleId === "sick")?.endDate, "2026-10-12");
  assert.equal(returned.teachingAssignments.some(policy => policy.id === unrelated.id), true);
}

{
  const conflicting: Schedule = {
    "g1:0": [day("2026-10-12", [lesson("one")])],
    "g2:0": [day("2026-10-12", [lesson("two")])],
  };
  const result = previewTeacherReassignment(state(conflicting), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  assert.deepEqual(result.changedLessonIds, ["one"]);
  assert.match(result.skipped[0]!.reason, /уже есть занятие/);
  assert.equal(result.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId, "old");
  assert.deepEqual(result.teachingAssignments.map(policy => policy.groupId), ["g1"], "the skipped group must not get a policy that overwrites its lesson later");
}

{
  const invalid = previewTeacherReassignment(state(initial), { mode: "assign", ...common, quarterId: "missing", scope: "week", weekStart: "2026-10-14", targetTeacherId: "sub" });
  assert.equal(invalid.canApply, false);
  assert.match(invalid.skipped.map(item => item.reason).join(" "), /Четверть не найдена/);
  assert.match(invalid.skipped.map(item => item.reason).join(" "), /корректную дату понедельника/);
  const invalidIds = previewTeacherReassignment(state(initial), { mode: "assign", ...common, scope: "week", weekStart: "2026-10-12", endDate: null, groupIds: ["absent"], targetTeacherId: "sub" });
  assert.equal(invalidIds.canApply, false);
  assert.match(invalidIds.skipped.map(item => item.reason).join(" "), /неизвестные или повторяющиеся идентификаторы/);
  assert.match(invalidIds.skipped.map(item => item.reason).join(" "), /только для переназначения периода/);
}

{
  const twoDays: Schedule = { "g1:0": [day("2026-10-12", [lesson("past")]), day("2026-10-13", [lesson("future")])] };
  const assigned = previewTeacherReassignment(state(twoDays), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  const returned = previewTeacherReassignment({ ...state(assigned.schedule, assigned.catalog), teacherLessonOrigins: assigned.teacherLessonOrigins, teachingAssignments: assigned.teachingAssignments }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.deepEqual(returned.changedLessonIds, ["future"]);
  assert.equal(returned.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "sub");
  assert.equal(returned.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId, "old");
  assert.equal(returned.catalog.teachers.find(teacher => teacher.id === "old")!.unavailability![0]!.endDate, "2026-10-12");
  assert.equal(returned.teacherLessonOrigins.find(origin => origin.lessonId === "future")!.status, "returned");
  assert.equal(returned.teacherLessonOrigins.find(origin => origin.lessonId === "past")!.status, "active");
}

{
  const conflicted: Schedule = { "g1:0": [day("2026-10-13", [lesson("to-return")])], "g2:0": [day("2026-10-13", [lesson("stays-old")])] };
  const assigned = previewTeacherReassignment(state(conflicted), { mode: "assign", ...common, scope: "period", groupIds: ["g1"], targetTeacherId: "sub" });
  const returned = previewTeacherReassignment({ ...state(assigned.schedule), teacherLessonOrigins: assigned.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.deepEqual(returned.changedLessonIds, []);
  assert.equal(returned.teacherLessonOrigins[0]!.status, "active", "conflicted return must stay eligible for a later retry");
}

{
  const one: Schedule = { "g1:0": [day("2026-10-13", [lesson("manual")])] };
  const assigned = previewTeacherReassignment(state(one), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  const edited = structuredClone(assigned.schedule);
  edited["g1:0"]![0]!.slots[0]![0]!.note = "ручная правка";
  const returned = previewTeacherReassignment({ ...state(edited, assigned.catalog), teacherLessonOrigins: assigned.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.equal(returned.changedLessonIds.length, 0);
  assert.match(returned.skipped[0]!.reason, /изменено вручную/);
  assert.equal(returned.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "sub");
  assert.equal(returned.teacherLessonOrigins[0]!.status, "manual");
  const secondAttempt = previewTeacherReassignment({ ...state(edited, returned.catalog), teacherLessonOrigins: returned.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.equal(secondAttempt.changedLessonIds.length, 0);
  assert.match(secondAttempt.skipped[0]!.reason, /изменялась вручную/);
}

{
  const catalog = structuredClone(baseCatalog);
  catalog.teachers[0]!.unavailability!.push({ id: "vacation", startDate: "2026-11-01", endDate: "2026-11-05", start: 500, end: 800 });
  const assigned = previewTeacherReassignment(state({ "g1:0": [day("2026-10-13", [lesson("sick-day")])] }, catalog), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  const returned = previewTeacherReassignment({ ...state(assigned.schedule, assigned.catalog), teacherLessonOrigins: assigned.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  const rules = returned.catalog.teachers[0]!.unavailability!;
  assert.equal(rules.find(rule => rule.id === "sick")!.endDate, "2026-10-12");
  assert.equal(rules.find(rule => rule.id === "vacation")!.endDate, "2026-11-05", "return must not close a later vacation rule");
}

{
  const data = state({});
  data.today = "2026-10-15";
  data.teachingAssignments = [
    { id: "absence-week", sourceTeacherId: "old", targetTeacherId: "sub", groupId: "g1", subjectId: "physics", startDate: "2026-10-14", endDate: "2026-10-18", absenceRuleId: "sick" },
    { id: "permanent-other", sourceTeacherId: "old", targetTeacherId: "busy", groupId: "g2", subjectId: "physics", startDate: "2026-10-01", endDate: null },
  ];
  const returned = previewTeacherReassignment(data, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-15", ruleId: "sick" });
  assert.equal(returned.changedLessonIds.length, 0, "no generated future lesson is required to end a sick-leave policy");
  assert.equal(returned.canApply, true);
  assert.equal(returned.teachingAssignments.find(policy => policy.id === "absence-week")!.endDate, "2026-10-14");
  assert.equal(returned.teachingAssignments.find(policy => policy.id === "permanent-other")!.endDate, null);
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-14", [lesson("first", "sub")]), day("2026-10-20", [lesson("future", "sub")])] };
  const originalOrigins = ["first", "future"].map((lessonId, index) => {
    const date = index ? "2026-10-20" : "2026-10-14";
    const located = { groupId: "g1", date, start: 600, end: 645, lesson: lesson(lessonId, "sub") };
    return { id: `illness:${lessonId}`, lessonId, groupId: "g1", date, sourceTeacherId: "old", substituteTeacherId: "sub", kind: "absence" as const, absenceRuleId: "sick", startDate: date, endDate: date, expected: teacherLessonFingerprint(located), status: "active" as const };
  });
  const data = state(schedule);
  data.quarters.push({ id: "q2", name: "Вторая четверть", startDate: "2026-10-19", endDate: "2027-01-01" });
  data.today = "2026-10-14";
  data.teacherLessonOrigins = originalOrigins;
  data.teachingAssignments = [{ id: "illness-policy", sourceTeacherId: "old", targetTeacherId: "sub", groupId: "g1", subjectId: "physics", startDate: "2026-10-14", endDate: null, absenceRuleId: "sick" }];
  const permanent = previewTeacherReassignment(data, { mode: "assign", quarterId: "q", subjectId: "physics", sourceTeacherId: "sub", scope: "period", startDate: "2026-10-14", endDate: null, groupIds: ["g1"], targetTeacherId: "sub2" });
  assert.deepEqual(permanent.changedLessonIds, ["first", "future"]);
  assert.ok(permanent.teacherLessonOrigins.filter(origin => origin.status === "active").every(origin => origin.kind === "transfer" && origin.absenceRuleId === undefined));
  const intentionalPolicy = permanent.teachingAssignments.find(policy => policy.groupId === "g1" && policy.targetTeacherId === "sub2")!;
  assert.equal(intentionalPolicy.sourceTeacherId, "sub");
  assert.equal(intentionalPolicy.absenceRuleId, undefined);
  const returned = previewTeacherReassignment({ ...data, schedule: permanent.schedule, teacherLessonOrigins: permanent.teacherLessonOrigins, teachingAssignments: permanent.teachingAssignments }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-15", ruleId: "sick" });
  assert.equal(returned.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId, "sub2", "permanent intent survives the original teacher's return");
  assert.equal(returned.teachingAssignments.find(policy => policy.id === intentionalPolicy.id)!.endDate, null);
}

{
  const schedule: Schedule = { "g1:0": [day("2026-10-14", [lesson("anchor")]), day("2026-10-20", [lesson("after-sick-leave")])] };
  const data = state(schedule);
  data.quarters.push({ id: "q2", name: "Вторая четверть", startDate: "2026-10-19", endDate: "2027-01-01" });
  data.today = "2026-10-14";
  const permanent = previewTeacherReassignment(data, { mode: "assign", quarterId: "q", subjectId: "physics", sourceTeacherId: "old", scope: "period", startDate: "2026-10-14", endDate: null, groupIds: ["g1"], targetTeacherId: "sub2" });
  const policy = permanent.teachingAssignments[0]!;
  assert.equal(policy.sourceTeacherId, "old");
  assert.equal(policy.absenceRuleId, undefined, "an explicit permanent transfer must not inherit the source's active sick leave");
  const returned = previewTeacherReassignment({ ...data, schedule: permanent.schedule, teachingAssignments: permanent.teachingAssignments, teacherLessonOrigins: permanent.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-15", ruleId: "sick" });
  assert.equal(returned.schedule["g1:0"]![1]!.slots[0]![0]!.teacherId, "sub2");
  assert.equal(returned.teachingAssignments.find(item => item.id === policy.id)!.endDate, null);
}

{
  const expiredCatalog = structuredClone(baseCatalog);
  expiredCatalog.teachers.find(teacher => teacher.id === "old")!.unavailability![0]!.endDate = "2026-10-14";
  const expired = state({}, expiredCatalog);
  expired.today = "2026-10-15";
  expired.teachingAssignments = [{ id: "expired-policy", sourceTeacherId: "old", targetTeacherId: "sub", groupId: "g1", subjectId: "physics", startDate: "2026-10-14", endDate: "2026-10-18", absenceRuleId: "sick" }];
  const afterEnd = previewTeacherReassignment(expired, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-15", ruleId: "sick" });
  assert.equal(afterEnd.canApply, true);
  assert.equal(afterEnd.teachingAssignments[0]!.endDate, "2026-10-14", "an already-ended absence still releases a longer linked policy");

  const deletedRule = structuredClone(baseCatalog);
  deletedRule.teachers.find(teacher => teacher.id === "old")!.unavailability = [];
  const data = state({}, deletedRule);
  data.today = "2026-10-15";
  data.teachingAssignments = [{ id: "orphan-policy", sourceTeacherId: "old", targetTeacherId: "sub", groupId: "g1", subjectId: "physics", startDate: "2026-10-14", endDate: "2026-10-18", absenceRuleId: "sick" }];
  const returned = previewTeacherReassignment(data, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-15", ruleId: "sick" });
  assert.equal(returned.canApply, true);
  assert.equal(returned.ruleChanged, true);
  assert.equal(returned.teachingAssignments[0]!.endDate, "2026-10-14", "a deleted sick-leave rule still releases its linked future policy");
}

{
  const joint: Schedule = {
    "g2:0": [day("2026-10-13", [lesson("j1", "old", { jointId: "joint" })])],
    "g3:0": [day("2026-10-13", [lesson("j2", "old", { jointId: "joint" })])],
  };
  const assigned = previewTeacherReassignment(state(joint), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  const edited = structuredClone(assigned.schedule);
  edited["g3:0"]![0]!.slots[0]![0]!.note = "расхождение";
  const returned = previewTeacherReassignment({ ...state(edited, assigned.catalog), teacherLessonOrigins: assigned.teacherLessonOrigins }, { mode: "return", sourceTeacherId: "old", returnDate: "2026-10-13", ruleId: "sick" });
  assert.equal(returned.changedLessonIds.length, 0);
  assert.equal(returned.schedule["g2:0"]![0]!.slots[0]![0]!.teacherId, "sub");
  assert.equal(returned.schedule["g3:0"]![0]!.slots[0]![0]!.teacherId, "sub");
}

{
  const malformedJoint: Schedule = {
    "g2:0": [day("2026-10-13", [lesson("j1", "old", { jointId: "bad" })], 600)],
    "g3:0": [day("2026-10-13", [lesson("j2", "old", { jointId: "bad" })], 630)],
  };
  const result = previewTeacherReassignment(state(malformedJoint), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  assert.equal(result.changedLessonIds.length, 0);
  assert.match(result.skipped[0]!.reason, /Объединённые уроки имеют разные время/);
}

{
  const subgroupSchedule: Schedule = { "g1:0": [day("2026-10-13", [lesson("subgroup", "old", { subgroupId: "g1-1", subgroup: "5А/1" })])] };
  const preview = previewTeacherReassignment(state(subgroupSchedule), { mode: "assign", ...common, scope: "period", targetTeacherId: "sub" });
  assert.deepEqual(preview.units[0]!.subgroupIds, ["g1-1"]);
  assert.deepEqual(preview.units[0]!.subgroups, ["5А/1"]);
}

{
  const data = state({ "g1:0": [day("2026-10-12", [lesson("cached-a")]), day("2026-10-13", [lesson("cached-b")])] });
  const cache = createTeacherReassignmentPreviewCache();
  const firstRequest = { mode: "assign" as const, ...common, scope: "period" as const };
  const first = previewTeacherReassignment(data, firstRequest, cache);
  const second = previewTeacherReassignment(data, firstRequest, cache);
  assert.deepEqual(second, first, "cached preview keeps the public result byte-for-byte equivalent");
  assert.equal(cache.candidateSummaries.size, 1);
  assert.equal(cache.rowAvailability.size, 2);
  const cachedUnits = collectReassignmentLessons(data.schedule, data.catalog);
  const changedChoiceRequest = { ...firstRequest, unitTeacherIds: { [cachedUnits[0]!.id]: "sub", [cachedUnits[1]!.id]: null } };
  const changedChoice = previewTeacherReassignment(data, changedChoiceRequest, cache);
  assert.deepEqual(changedChoice.candidates, first.candidates, "candidate summary is independent of selected replacement");
  assert.equal(cache.rowAvailability.size, 3, "only the row whose overlapping occupancy changed needs a new availability result");
  assert.deepEqual(changedChoice, previewTeacherReassignment(data, changedChoiceRequest), "cached changed-row preview matches a fresh calculation");
  assert.equal(data.schedule["g1:0"]![0]!.slots[0]![0]!.teacherId, "old", "preview and cache leave caller state untouched");
  const revised = structuredClone(data);
  revised.catalog.teachers.find(teacher => teacher.id === "sub")!.archived = true;
  assert.deepEqual(previewTeacherReassignment(revised, firstRequest, cache), previewTeacherReassignment(revised, firstRequest), "a different draft state invalidates prepared indexes and candidate/row results");
}

{
  const result = previewTeacherReassignment(state(initial), { mode: "assign", ...common, scope: "lesson", lessonIds: ["j1"], targetTeacherId: "sub", persist: false });
  assert.deepEqual(result.changedLessonIds, ["j1", "j2"], "a lesson list selects the whole joint unit without requiring lessonId");
}

console.log("teacher reassignment: 29 checks passed");
