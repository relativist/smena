import assert from "node:assert/strict";
import { requiredRoomKind, roomSuitabilityReason, newRoomSuitabilityViolation, roomSuitabilityViolationMessage } from "../shared/roomSuitability.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [{ id: "s", name: "Физика", shortName: "Физ", color: "blue", archived: false, roomKind: "physics-lab", labRoomKind: null }],
  teachers: [], rooms: [
    { id: "r", name: "Физкабинет", archived: false, kind: "physics-lab", capacity: 25 },
    { id: "small", name: "Малый", archived: false, kind: "general", capacity: 15 },
    { id: "unknown", name: "Без лимита", archived: false, kind: "general", capacity: null },
    { id: "event-room", name: "Зал", archived: false, kind: "general", capacity: null },
  ], groups: [
    { id: "g1", name: "7А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "7Б", archived: false, students: 18, leaderId: null, roomId: null, autoRoomIds: [] },
  ], subgroups: [
    { id: "sub", groupId: "g1", name: "7А/1", archived: false, students: 10 },
    { id: "sub2", groupId: "g1", name: "7А/2", archived: false, students: 10 },
  ],
};
const day = (lesson?: any) => ({ date: "2026-10-12", start: "08:00", duration: 45, breaks: [], slots: [[...(lesson ? [lesson] : [])]], times: [{ start: 480, duration: 45 }] });
const schedule = (lessons: Array<[string, any]>): Schedule => Object.fromEntries(lessons.map(([group, lesson]) => [`${group}:0`, [day(lesson)]]));
const lesson = (id: string, roomId: string, extra: any = {}) => ({ id, subjectId: "s", roomId, ...extra });

assert.equal(requiredRoomKind(catalog.subjects[0], "regular"), "physics-lab");
assert.equal(requiredRoomKind(catalog.subjects[0], "lab"), "physics-lab");
assert.equal(requiredRoomKind({ ...catalog.subjects[0], labRoomKind: "chemistry-lab" }, "lab"), "chemistry-lab");
assert.equal(requiredRoomKind(undefined), null);
assert.match(roomSuitabilityReason(catalog, { subjectId: "s", groupId: "g1", roomId: "small" })!, /тип/);
assert.equal(roomSuitabilityReason(catalog, { subjectId: "missing", groupId: "g1", subgroupId: "sub", roomId: "small" }), null);
assert.match(roomSuitabilityReason(catalog, { subjectId: "s", groupId: "g1", roomId: "small" })!, /тип/);
assert.equal(roomSuitabilityReason(catalog, { subjectId: "missing", groupId: "g1", roomId: "unknown" }), null);
assert.match(roomSuitabilityReason(catalog, { subjectId: "missing", groupId: "g1", groupIds: ["g1", "g2"], roomId: "r" })!, /38/);
assert.equal(roomSuitabilityReason(catalog, { subjectId: "missing", groupId: "g1", groupIds: ["g1", "g2"], roomId: "unknown" }), null);

const prev = schedule([["g1", lesson("a", "small", { subjectId: "unknown" })]]);
assert.equal(newRoomSuitabilityViolation(schedule([["g1", lesson("a", "small", { subjectId: "unknown", note: "edited" })]]), prev, catalog), undefined);
assert.equal(newRoomSuitabilityViolation(schedule([["g1", lesson("a", "small", { subjectId: "s" })]]), schedule([["g1", lesson("a", "unknown", { subjectId: "s" })]]), catalog)?.roomId, "small");
assert.equal(newRoomSuitabilityViolation(schedule([["g1", lesson("new", "small")]]), prev, catalog)?.lessonIds[0], "new");
assert.equal(newRoomSuitabilityViolation(schedule([]), prev, catalog), undefined);
assert.equal(newRoomSuitabilityViolation(schedule([["g1", lesson("a", "small", { subjectId: "unknown", subgroupId: "sub" })]]), prev, catalog), undefined);
assert.match(roomSuitabilityViolationMessage(newRoomSuitabilityViolation(schedule([["g1", lesson("a", "small", { subgroupId: "sub" })]]), schedule([]), catalog)!, catalog), /7А/);

const jointNext = schedule([["g1", lesson("j1", "small", { subjectId: "unknown", jointId: "j" })], ["g2", lesson("j2", "small", { subjectId: "unknown", jointId: "j" })]]);
assert.match(newRoomSuitabilityViolation(jointNext, schedule([]), catalog)!.reason, /38/);
assert.equal(newRoomSuitabilityViolation(schedule([["g1", lesson("j1", "small", { subjectId: "unknown", jointId: "j" })]]), jointNext, catalog), undefined);
const oneJointMember = schedule([["g1", lesson("j1", "small", { subjectId: "unknown", jointId: "j" })]]);
assert.equal(newRoomSuitabilityViolation(jointNext, oneJointMember, catalog)?.participantCount, 38);
const differentSlots: Schedule = {
  "g1:0": [{ ...day(), slots: [[lesson("dj1", "small", { subjectId: "unknown", jointId: "different-slots" })], []] }],
  "g2:0": [{ ...day(), slots: [[], [lesson("dj2", "small", { subjectId: "unknown", jointId: "different-slots" })]] }],
};
assert.equal(newRoomSuitabilityViolation(differentSlots, schedule([]), catalog)?.participantCount, 38);
const twoSubgroups = schedule([["g1", lesson("sg1", "small", { subjectId: "unknown", subgroupId: "sub" })], ["g1", lesson("sg2", "small", { subjectId: "unknown", subgroupId: "sub2" })]]);
assert.equal(newRoomSuitabilityViolation(twoSubgroups, schedule([]), catalog), undefined);
const event = schedule([["g1", { ...lesson("event", "event-room"), event: "Сбор" }]]);
assert.equal(newRoomSuitabilityViolation(event, schedule([]), catalog), undefined);
const legacyName = schedule([["g1", { ...lesson("legacy-name", "missing-id"), room: "Малый", subjectId: "s" }]]);
assert.equal(newRoomSuitabilityViolation(legacyName, schedule([]), catalog)?.roomId, "small");
const frozen = structuredClone(prev); newRoomSuitabilityViolation(prev, schedule([]), catalog); assert.deepEqual(prev, frozen); assert.deepEqual(catalog.rooms[0], { id: "r", name: "Физкабинет", archived: false, kind: "physics-lab", capacity: 25 });
console.log("room suitability tests passed");
