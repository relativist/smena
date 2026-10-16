import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { applyServiceEvent } from "../shared/serviceEvents.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";

const baseCatalog: Catalog = {
  subjects: [{ id: "event", name: "Мероприятие", shortName: "Меропр.", color: "blue", archived: false, roomKind: "physics-lab", labRoomKind: null }], subgroups: [], teachers: [],
  groups: [
    { id: "g1", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "5Б", archived: false, students: 21, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  rooms: [
    { id: "hall", name: "Зал", archived: false, kind: "assembly", capacity: null },
    { id: "small", name: "Малый зал", archived: false, kind: "general", capacity: 15 },
    { id: "general-ok", name: "Обычный зал", archived: false, kind: "general", capacity: 25 },
  ],
};
function day(date: string, slots: EditorDay["slots"] = [[], [], []]): EditorDay {
  return { date, start: "08:00", duration: 45, breaks: [10, 10], slots, times: [{ start: 480, duration: 45 }, { start: 535, duration: 45 }, { start: 590, duration: 45 }] };
}
function emptySchedule(): Schedule { return { "g1:0": [day("2026-10-05")], "g2:0": [day("2026-10-05")] }; }
const input = { event: "Линейка", groupIds: ["g1", "g2"], date: "2026-10-05", start: 480, duration: 45, roomId: "hall" };
function eventLesson(schedule: Schedule, group: string) { return schedule[`${group}:0`][0]!.slots.flat().find(lesson => lesson.subjectId === "event")!; }

test("editing an under-capacity event preserves each existing mirror ID", () => {
  const initial = applyServiceEvent(emptySchedule(), baseCatalog, { ...input, groupIds: ["g1"] });
  const id = eventLesson(initial, "g1").id;
  const edited = applyServiceEvent(initial, baseCatalog, { ...input, groupIds: ["g1"], lessonId: id, event: "Встреча", start: 535 });
  assert.equal(eventLesson(edited, "g1").id, id);
  assert.equal(eventLesson(edited, "g1").event, "Встреча");
});

test("historic capacity overflow can be renamed and moved after room capacity decreases", () => {
  const initial = applyServiceEvent(emptySchedule(), baseCatalog, input);
  const ids = [eventLesson(initial, "g1").id, eventLesson(initial, "g2").id];
  const reducedCatalog: Catalog = { ...baseCatalog, rooms: baseCatalog.rooms.map(room => room.id === "hall" ? { ...room, capacity: 15 } : room) };
  const edited = applyServiceEvent(initial, reducedCatalog, { ...input, lessonId: ids[0], event: "Изменено", start: 535 });
  assert.deepEqual([eventLesson(edited, "g1").id, eventLesson(edited, "g2").id], ids);
  assert.equal(eventLesson(edited, "g1").event, "Изменено");
  assert.equal(edited["g1:0"][0]!.times[1]!.start, 535);
});

test("new groups and a newly selected low-capacity room are rejected, while removing an old group improves the schedule", () => {
  const oneGroup = applyServiceEvent(emptySchedule(), baseCatalog, { ...input, groupIds: ["g1"] });
  const limitedCatalog: Catalog = { ...baseCatalog, rooms: baseCatalog.rooms.map(room => room.id === "hall" ? { ...room, capacity: 25 } : room) };
  assert.throws(() => applyServiceEvent(oneGroup, limitedCatalog, { ...input, lessonId: eventLesson(oneGroup, "g1").id }), /участников: 41/);
  assert.throws(() => applyServiceEvent(oneGroup, baseCatalog, { ...input, groupIds: ["g1"], lessonId: eventLesson(oneGroup, "g1").id, roomId: "small" }), /Малый зал/);

  const both = applyServiceEvent(emptySchedule(), baseCatalog, input);
  const reduced = applyServiceEvent(both, limitedCatalog, { ...input, groupIds: ["g1"], lessonId: eventLesson(both, "g1").id });
  assert.ok(eventLesson(reduced, "g1"));
  assert.equal(reduced["g2:0"]![0]!.slots.flat().some(lesson => lesson.subjectId === "event"), false);
});

test("event type remains unrestricted while its capacity is checked", () => {
  const event = applyServiceEvent(emptySchedule(), baseCatalog, { ...input, groupIds: ["g1"], roomId: "general-ok" });
  assert.equal(eventLesson(event, "g1").roomId, "general-ok");
});
