import assert from "node:assert/strict";
import { collectTeacherLoad, summarizeTeacherLoad } from "../shared/teacherLoad.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  teachers: [
    { id: "active", name: "Иванов Алексей", archived: false, subjectIds: ["math"], defaultRoomId: null },
    { id: "homonym-a", name: "Петров Иван", archived: false, subjectIds: [], defaultRoomId: null },
    { id: "homonym-b", name: "Петров Иван", archived: false, subjectIds: [], defaultRoomId: null },
    { id: "archived", name: "Сидоров Павел", archived: true, subjectIds: [], defaultRoomId: null },
  ],
  subjects: [
    { id: "math", name: "Математика", shortName: "Мат.", color: "blue", archived: false, roomKind: null, labRoomKind: null },
    { id: "english", name: "Английский язык", shortName: "Англ.", color: "violet", archived: false, roomKind: null, labRoomKind: null },
    { id: "event", name: "Мероприятие", shortName: "Меропр.", color: "blue", archived: false, roomKind: null, labRoomKind: null },
  ],
  groups: [
    { id: "g1", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "5Б", archived: false, students: 21, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g3", name: "6А", archived: false, students: 22, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  subgroups: [
    { id: "g1-a", name: "1 подгруппа", archived: false, groupId: "g1", students: 10 },
    { id: "g1-b", name: "2 подгруппа", archived: false, groupId: "g1", students: 10 },
  ],
  rooms: [{ id: "r1", name: "312", archived: false, capacity: 30, kind: "general" }],
};

function day(date: string, slots: Schedule[string][number]["slots"], times = slots.map((_, index) => ({ start: 480 + index * 50, duration: 45 }))): Schedule[string][number] {
  return { date, start: "08:00", duration: 45, breaks: [], slots, times };
}
function lesson(id: string, teacherId: string | undefined, subjectId = "math", rest: Record<string, unknown> = {}) {
  return { id, ...(teacherId ? { teacherId } : {}), subjectId, ...rest } as Schedule[string][number]["slots"][number][number];
}

const schedule: Schedule = {
  "g1:0": [day("2026-10-30", [
    [lesson("joint-30", "active", "math", { jointId: "joint" })],
    [lesson("sub-a", "active", "english", { subgroupId: "g1-a", roomId: "r1" })],
    [lesson("sub-b", "active", "english", { subgroupId: "g1-b", roomId: "r1" })],
    [lesson("event-a", "active", "event", { event: "Линейка" })],
    [lesson("short45", "archived", "math")],
    [lesson("legacy-homonym", undefined, "math", { teacher: "Петров Иван" })],
    [lesson("orphan", "gone-teacher", "math")],
    [lesson("legacy-unique", undefined, "math", { teacher: "Иванов Алексей" })],
  ], [
    { start: 480, duration: 45 }, { start: 535, duration: 45 }, { start: 585, duration: 45 },
    { start: 635, duration: 45 }, { start: 690, duration: 45 }, { start: 740, duration: 45 },
    { start: 790, duration: 45 }, { start: 840, duration: 45 },
  ])],
  // A duplicate schedule copy for the same group/date/id is counted once.
  "g1:1": [day("2026-10-30", [[lesson("joint-30", "active", "math", { jointId: "joint" })]], [{ start: 480, duration: 45 }])],
  "g2:0": [day("2026-10-30", [
    [lesson("joint-30-b", "active", "math", { jointId: "joint" })],
    [lesson("event-b", "active", "event", { event: "Линейка" })],
    [lesson("joint-next-date", "active", "math", { jointId: "joint" })],
    [lesson("joint-next-time", "active", "math", { jointId: "joint" })],
  ], [
    { start: 480, duration: 45 }, { start: 535, duration: 45 },
    { start: 600, duration: 45 }, { start: 650, duration: 45 },
  ])],
  "g3:0": [day("2026-11-01", [[lesson("short30", "archived", "math")]], [{ start: 480, duration: 30 }])],
  "g2:1": [day("2026-11-01", [[lesson("joint-next-date-b", "active", "math", { jointId: "joint" })]], [{ start: 600, duration: 45 }])],
};
// Give the next-date joint mirror matching interval and a distinct date.
schedule["g2:1"]![0]!.times[0] = { start: 480, duration: 45 };

const rows = collectTeacherLoad(schedule, catalog);
const byId = new Map(rows.map((row) => [row.id, row]));
assert.deepEqual(rows.filter((row) => row.id === "active")[0]?.lessons.map((item) => [item.date, item.start, item.id]), [
  ["2026-10-30", 480, "joint-30"],
  ["2026-10-30", 535, "event-b"],
  ["2026-10-30", 535, "sub-a"],
  ["2026-10-30", 585, "sub-b"],
  ["2026-10-30", 600, "joint-next-date"],
  ["2026-10-30", 635, "event-a"],
  ["2026-10-30", 650, "joint-next-time"],
  ["2026-10-30", 840, "legacy-unique"],
  ["2026-11-01", 480, "joint-next-date-b"],
], "lessons are normalized and sorted by actual date and start; unknown ambiguous name is omitted");
const shared = byId.get("active")!.lessons.find((item) => item.id === "joint-30")!;
assert.deepEqual(shared.participants.map(({ id, slot }) => ({ id, slot })), [{ id: "g1", slot: 1 }, { id: "g2", slot: 1 }]);
assert.deepEqual(byId.get("active")!.lessons.filter((item) => item.subjectId === "english").map((item) => item.participants[0]?.subgroup), ["1 подгруппа", "2 подгруппа"], "separate subgroup lessons remain separate and count their class once");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "event-a")?.isEvent, true);
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "sub-a")?.room, "312");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "legacy-unique")?.subject, "Математика");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "legacy-unique")?.shortSubject, "Мат.");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "sub-a")?.shortSubject, "Англ.");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "event-a")?.shortSubject, "Линейка");
assert.equal(byId.get("active")!.lessons.filter((item) => item.id.startsWith("joint-next-date")).length, 2, "same joint id on another date remains a separate occurrence");
assert.equal(byId.get("active")!.lessons.find((item) => item.id === "joint-next-time")?.participants.length, 1, "different joint interval remains separate");
assert.deepEqual(byId.get("gone-teacher")!.lessons[0]?.participants.map(({ id }) => id), ["g1"]);
assert.equal(byId.get("gone-teacher")?.name, "Неизвестный учитель (gone-teacher)", "orphan ID stays visible as an isolated row");
assert.equal(byId.get("archived")?.archived, true);
assert.equal(byId.get("archived")?.lessons.length, 2);
assert.equal(rows.some((row) => row.id === "homonym-a" || row.id === "homonym-b"), true, "homonymous active catalog teachers stay distinct zero-load rows");
assert.equal(rows.filter((row) => row.id === "homonym-a" || row.id === "homonym-b").every((row) => row.lessons.length === 0), true);
assert.deepEqual(byId.get("active") && summarizeTeacherLoad(byId.get("active")!.lessons, "2026-10-26", "2026-11-01"), {
  lessons: 7, events: 2, minutes: 315, groupCount: 2,
}, "inclusive cross-month range counts lessons, events, minutes and unique groups");
assert.deepEqual(summarizeTeacherLoad(byId.get("archived")!.lessons, "2026-10-01", "2026-10-31"), {
  lessons: 1, events: 0, minutes: 45, groupCount: 1,
}, "date range selects the actual 45-minute October occurrence");
assert.deepEqual(summarizeTeacherLoad(byId.get("archived")!.lessons, "2026-11-01", "2026-11-30"), {
  lessons: 1, events: 0, minutes: 30, groupCount: 1,
}, "date range selects the actual shortened 30-minute November occurrence");
assert.deepEqual(summarizeTeacherLoad([], "2026-10-01", "2026-10-31"), { lessons: 0, events: 0, minutes: 0, groupCount: 0 });

const edgeSchedule: Schedule = {
  "g1:0": [day("2026-10-12", [
    [lesson("different-slot-a", "homonym-a", "math", { jointId: "different-slots" })],
    [lesson("parallel-sub-a", "homonym-a", "english", { subgroupId: "g1-a" })],
    [lesson("parallel-sub-b", "homonym-b", "english", { subgroupId: "g1-b" })],
    [lesson("joint-event-a", "homonym-b", "event", { event: "Собрание", jointId: "joint-event" })],
  ], [
    { start: 480, duration: 45 }, { start: 535, duration: 45 },
    { start: 535, duration: 45 }, { start: 585, duration: 45 },
  ])],
  "g2:0": [day("2026-10-12", [
    [lesson("joint-event-b", "homonym-b", "event", { event: "Собрание", jointId: "joint-event" })],
    [lesson("different-slot-b", "homonym-a", "math", { jointId: "different-slots" })],
  ], [
    { start: 585, duration: 45 }, { start: 480, duration: 45 },
  ])],
};
const edgeRows = new Map(collectTeacherLoad(edgeSchedule, catalog).map((row) => [row.id, row]));
const crossSlotJoint = edgeRows.get("homonym-a")!.lessons.find((item) => item.id === "different-slot-a")!;
assert.deepEqual(crossSlotJoint.participants.map(({ id, slot }) => [id, slot]), [["g1", 1], ["g2", 2]], "joint lesson mirrors at different slot numbers count once and retain both numbers");
assert.equal(edgeRows.get("homonym-a")!.lessons.filter((item) => item.subjectId === "math").length, 1);
assert.equal(edgeRows.get("homonym-a")!.lessons.filter((item) => item.subjectId === "english").length, 1, "homonym teacher ID resolves independently");
assert.equal(edgeRows.get("homonym-b")!.lessons.filter((item) => item.subjectId === "english").length, 1, "parallel subgroup lesson remains a separate occurrence");
assert.equal(edgeRows.get("homonym-a")!.lessons.find((item) => item.id === "parallel-sub-a")!.start,
  edgeRows.get("homonym-b")!.lessons.find((item) => item.id === "parallel-sub-b")!.start,
  "unlinked simultaneous subgroup lessons stay separate");
const sharedEvent = edgeRows.get("homonym-b")!.lessons.find((item) => item.id === "joint-event-a")!;
assert.equal(sharedEvent.isEvent, true);
assert.deepEqual(sharedEvent.participants.map(({ id, slot }) => [id, slot] as const).sort((a, b) => a[0].localeCompare(b[0])), [["g1", 4], ["g2", 1]]);
assert.deepEqual(summarizeTeacherLoad(edgeRows.get("homonym-b")!.lessons, "2026-10-12", "2026-10-12"), {
  lessons: 1, events: 1, minutes: 45, groupCount: 1,
}, "joint event is one event and adds no subject minutes or group load");
assert.deepEqual(summarizeTeacherLoad(edgeRows.get("homonym-a")!.lessons, "2026-10-12", "2026-10-12"), {
  lessons: 2, events: 0, minutes: 90, groupCount: 2,
}, "the two teachers with the same name retain independent ID-based loads");

console.log("teacher load tests passed");
