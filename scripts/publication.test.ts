import assert from "node:assert/strict";
import { analyzePublication, createPublicationSnapshot } from "../shared/publication.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { EditorDay, EditorLesson } from "../src/editor.ts";

const quarter = { id: "q1", name: "I четверть", startDate: "2026-10-05", endDate: "2026-10-09" };
const catalog = {
  groups: [{ id: "5a", name: "5А", archived: false, students: 24, leaderId: null, roomId: null, autoRoomIds: [] }],
  subjects: [{ id: "math", name: "Математика", shortName: "Мат.", archived: false, color: "blue" as const, roomKind: null, labRoomKind: null }],
  teachers: [{ id: "t1", name: "Иванов И.И.", archived: false, subjectIds: ["math"], defaultRoomId: "r1" }],
  rooms: [{ id: "r1", name: "312", archived: false, capacity: 30, kind: "general" as const }],
  subgroups: [],
};
const plan = { id: "p1", quarterId: "q1", groupId: "5a", subjectId: "math", mode: "whole" as const, lessonKind: "regular" as const, assignments: [{ id: "a1", subgroupId: null, target: 2 }] };
const lesson = (id: string, subjectId = "math"): EditorLesson => ({ id, subjectId, teacherId: "t1", roomId: "r1" });
const day = (date: string, slots: EditorLesson[][], holiday = false): EditorDay => ({ date, start: "08:30", duration: 45, breaks: [10], holiday, slots, times: slots.map((_, index) => ({ start: 510 + index * 55, duration: 45 })) });
function state(): StateResponse {
  return {
    revision: 7, updatedAt: "2026-10-12T00:00:00.000Z", catalog: structuredClone(catalog), quarters: [quarter, { id: "q2", name: "II четверть", startDate: "2026-10-12", endDate: "2026-10-16" }],
    studyPlans: [structuredClone(plan), { ...structuredClone(plan), id: "p2", quarterId: "q2" }], baseline: [{ groupId: "5a", subjectId: "math", subgroup: null, planned: 2, target: 2, initialCount: 0 }],
    curricula: [{ id: "c1", name: "План I", quarterId: "q1", groupIds: ["5a"], rows: [{ id: "row1", subjectId: "math", mode: "whole", lessonKind: "regular", hours: 2 }] }, { id: "c2", name: "План II", quarterId: "q2", groupIds: ["5a"], rows: [] }],
    schedule: { "5a:0": [day("2026-10-05", [[lesson("l1")]]), day("2026-10-12", [[lesson("other-quarter")]])] },
    calendar: { weekdays: [1, 2, 3, 4, 5], periods: [] }, bellSettings: { school: { start: 510, duration: 45, breaks: [10] }, groups: {} },
  };
}

const draft = state();
const snapshot = createPublicationSnapshot(draft, "q1");
draft.schedule["5a:0"]![0]!.times[0]!.start = 900;
draft.catalog.teachers[0]!.name = "Изменён в черновике";
assert.equal(snapshot.schedule["5a:0"]![0]!.times[0]!.start, 510, "snapshot holds detached timetable times");
assert.equal(snapshot.catalog.teachers[0]!.name, "Иванов И.И.", "snapshot keeps publication-time resource labels");
assert.equal(Object.values(snapshot.schedule).flat().length, 1, "snapshot excludes other-quarter days");
assert.equal(snapshot.studyPlans.length, 1);
assert.equal(snapshot.curricula?.length, 1);

const firstDraft = state();
const initial = analyzePublication(firstDraft, "q1");
assert.equal(initial.canPublish, true, "hours deficit is a warning, not a publication blocker");
assert.equal(initial.warnings.some((item) => item.code === "hours-deficit"), true);
assert.equal(initial.summary.added, 1);
assert.equal(initial.summary.lessonCount, 1);

const published = { publication: { quarterId: "q1", version: 1, publishedAt: "2026-10-10T00:00:00.000Z", draftRevision: 2, publishedBy: "admin" }, snapshot: createPublicationSnapshot(firstDraft, "q1") };
const changed = state();
changed.schedule["5a:0"]![0]!.times[0]!.start += 5;
changed.schedule["5a:0"]![0]!.slots[0]![0]!.teacher = "Петров П.П.";
changed.schedule["5a:0"]![0]!.slots.push([lesson("l2")]);
const changePreview = analyzePublication(changed, "q1", published);
assert.equal(changePreview.summary.added, 1);
assert.equal(changePreview.summary.changed, 1, "time or displayed resource label change counts as changed");
assert.equal(changePreview.summary.removed, 0);
assert.equal(changePreview.summary.settingsChanged, true, "bell grid changes are reflected even when they also move a lesson");
changed.catalog.teachers[0]!.name = "Новая фамилия";
const renamePreview = analyzePublication(changed, "q1", published);
assert.equal(renamePreview.summary.settingsChanged, true, "visible catalog label changes are reflected in settings diff");

const invalid = state();
invalid.schedule["5a:0"]![0]!.slots[0]!.push({ ...lesson("l2"), teacherId: "missing", roomId: "missing" }, lesson("l3"));
const invalidPreview = analyzePublication(invalid, "q1");
assert.equal(invalidPreview.canPublish, false);
assert.equal(invalidPreview.errors.some((item) => item.code === "teacher-conflict"), true);
assert.equal(invalidPreview.errors.some((item) => item.code === "unknown-room"), true);

const holiday = state();
holiday.schedule["5a:0"]![0]!.holiday = true;
assert.equal(analyzePublication(holiday, "q1").errors.some((item) => item.code === "holiday-lessons"), true);

const parallel = state();
parallel.catalog.groups.push({ id: "5b", name: "5Б", archived: false, students: 24, leaderId: null, roomId: null, autoRoomIds: [] });
parallel.catalog.subjects[0]!.jointSameGrade = true;
parallel.catalog.rooms[0]!.capacity = 60;
parallel.studyPlans.push({ ...structuredClone(plan), id: "p5b", groupId: "5b" });
parallel.schedule["5a:0"]![0] = day("2026-10-05", [[], [ { ...lesson("j1"), jointId: "joint" } ]]);
parallel.schedule["5a:0"]![0]!.times = [{ start: 510, duration: 45 }, { start: 565, duration: 45 }];
parallel.schedule["5b:0"] = [day("2026-10-05", [[{ ...lesson("j2"), jointId: "joint" }]])];
parallel.schedule["5b:0"]![0]!.times = [{ start: 565, duration: 45 }];
assert.equal(analyzePublication(parallel, "q1").errors.some((item) => item.code === "invalid-joint"), false, "joint mirrors may use different slot numbers when actual time matches");
assert.equal(analyzePublication(parallel, "q1").canPublish, true);
const ordinaryJointCapacity = structuredClone(parallel);
ordinaryJointCapacity.catalog.rooms[0]!.capacity = 30;
assert.equal(analyzePublication(ordinaryJointCapacity, "q1").errors.some((item) => item.code === "room-suitability"), true, "ordinary joint room capacity sums all participant groups");

const eventJoint = state();
eventJoint.catalog.groups.push({ id: "5b", name: "5Б", archived: false, students: 24, leaderId: null, roomId: null, autoRoomIds: [] });
eventJoint.catalog.rooms[0]!.capacity = 30;
eventJoint.schedule["5a:0"]![0]!.slots = [[{ id: "e1", subjectId: "event", event: "Собрание", jointId: "event-joint", roomId: "r1" }]];
eventJoint.schedule["5b:0"] = [day("2026-10-05", [[{ id: "e2", subjectId: "event", event: "Собрание", jointId: "event-joint", roomId: "r1" }]])];
assert.equal(analyzePublication(eventJoint, "q1").errors.some((item) => item.code === "room-suitability"), true, "event joint room capacity also sums participant groups");
eventJoint.schedule["5b:0"]![0]!.slots = [[]];
const singleEvent = analyzePublication(eventJoint, "q1");
assert.equal(singleEvent.errors.some((item) => item.code === "invalid-joint"), false, "service events with a single remaining joint mirror are publishable");
const optionalResourcesEvent = state();
optionalResourcesEvent.schedule["5a:0"]![0]!.slots = [[{ id: "e3", subjectId: "event", event: "Собрание" }]];
assert.equal(analyzePublication(optionalResourcesEvent, "q1").errors.some((item) => item.code === "unknown-teacher" || item.code === "unknown-room"), false, "event teacher and room remain optional");
const unresolvedResourcesEvent = state();
unresolvedResourcesEvent.schedule["5a:0"]![0]!.slots = [[{ id: "e4", subjectId: "event", event: "Собрание", teacher: "Иванов И.И.", room: "312" }]];
const unresolvedEventPreview = analyzePublication(unresolvedResourcesEvent, "q1");
assert.equal(unresolvedEventPreview.errors.some((item) => item.code === "unknown-teacher"), true);
assert.equal(unresolvedEventPreview.errors.some((item) => item.code === "unknown-room"), true);

const subgroupJoint = structuredClone(parallel);
subgroupJoint.catalog.subgroups.push({ id: "sg-a", name: "5А/1", archived: false, groupId: "5a", students: 12 }, { id: "sg-b", name: "5Б/1", archived: false, groupId: "5b", students: 12 });
subgroupJoint.schedule["5a:0"]![0]!.slots[1]![0]!.subgroupId = "sg-a";
subgroupJoint.schedule["5b:0"]![0]!.slots[0]![0]!.subgroupId = "sg-b";
assert.equal(analyzePublication(subgroupJoint, "q1").errors.some((item) => item.code === "invalid-joint"), true, "joint subgroup rows are rejected");

const emptyGridDraft = state();
emptyGridDraft.schedule["5a:0"]!.push(day("2026-10-07", [[]]));
const emptyGridPublished = { ...published, snapshot: createPublicationSnapshot(emptyGridDraft, "q1") };
const emptyGridChanged = structuredClone(emptyGridDraft);
emptyGridChanged.schedule["5a:0"]![2]!.times[0]!.start += 5;
const emptyGridPreview = analyzePublication(emptyGridChanged, "q1", emptyGridPublished);
assert.equal(emptyGridPreview.summary.settingsChanged, true, "bell changes on empty days are included in the publication diff");
assert.deepEqual(emptyGridPreview.summary.affectedGroupIds, ["5a"]);

const removal = state();
removal.schedule["5a:0"]![0]!.slots = [[]];
assert.equal(analyzePublication(removal, "q1", published).summary.removed, 1);

console.log("publication: snapshot isolation, quarter scope, strict validation, warnings, and publish diff passed");
