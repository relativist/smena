import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "../shared/catalog.ts";
import { applyServiceEvent, removeServiceEvent, ServiceEventError } from "../shared/serviceEvents.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";
import { removeLesson } from "../src/editor.ts";

const catalog: Catalog = {
  subjects: [], subgroups: [],
  groups: [
    { id: "g1", name: "5А", archived: false, students: 20, leaderId: null, roomId: null, autoRoomIds: [] },
    { id: "g2", name: "5Б", archived: false, students: 21, leaderId: null, roomId: null, autoRoomIds: [] },
  ],
  teachers: [{ id: "t1", name: "Иванов Иван", archived: false, subjectIds: [], defaultRoomId: null }],
  rooms: [{ id: "r1", name: "Актовый зал", archived: false, capacity: null, kind: "assembly" }],
};
function day(date: string, slots: EditorDay["slots"] = [[], [], []], holiday = false): EditorDay {
  return { date, start: "08:00", duration: 45, breaks: [10, 10, 10], holiday, slots, times: [{ start: 480, duration: 45 }, { start: 535, duration: 45 }, { start: 590, duration: 45 }] };
}
function setup(): Schedule {
  return { "g1:0": [day("2026-10-05")], "g2:0": [day("2026-10-05")], "other:0": [day("2026-10-05", [[{ id: "keep", subjectId: "math", teacherId: "t1" }], [], []])] };
}
const input = { event: "Линейка" as const, groupIds: ["g1", "g2"], date: "2026-10-05", start: 480, duration: 45, roomId: "r1" };

test("creates common event mirrors with unique lesson ids and preserves unrelated schedule data", () => {
  const original = setup();
  const result = applyServiceEvent(original, catalog, input);
  const first = result["g1:0"][0].slots.flat().find((item) => item.subjectId === "event")!;
  const second = result["g2:0"][0].slots.flat().find((item) => item.subjectId === "event")!;
  assert.ok(first.jointId);
  assert.equal(second.jointId, first.jointId);
  assert.notEqual(first.id, second.id);
  assert.equal(first.room, "Актовый зал");
  assert.equal(original["g1:0"][0].slots.flat().length, 0);
  assert.equal(result["other:0"][0].slots[0][0].id, "keep");
});

test("trims custom event titles and rejects blank or overlong titles without mutating input", () => {
  const original = setup();
  const eventInput = { ...input, event: "  Поездка в музей  " };
  const result = applyServiceEvent(original, catalog, eventInput);
  assert.equal(
    result["g1:0"][0].slots.flat().find((item) => item.subjectId === "event")?.event,
    "Поездка в музей",
  );

  for (const event of ["   ", "а".repeat(201)]) {
    const unchanged = setup();
    const before = structuredClone(unchanged);
    assert.throws(() => applyServiceEvent(unchanged, catalog, { ...input, event }), /название мероприятия/i);
    assert.deepEqual(unchanged, before);
  }
});

test("rejects occupied group times, teacher conflicts, room conflicts, aggregate capacity and holidays without changing input", () => {
  const original = setup();
  const occupied = { ...original, "g2:0": [day("2026-10-05", [[{ id: "occupied", subjectId: "math" }], [], []])] };
  assert.throws(() => applyServiceEvent(occupied, catalog, input), /свободной ячейки/);
  assert.throws(() => applyServiceEvent(original, catalog, { ...input, teacherId: "t1" }), /Преподаватель/);
  const roomBusy = { ...original, "other:0": [day("2026-10-05", [[{ id: "room-use", subjectId: "math", roomId: "r1" }], [], []])] };
  assert.throws(() => applyServiceEvent(roomBusy, catalog, input), /Актовый зал/);
  const tightCatalog: Catalog = { ...catalog, rooms: [{ ...catalog.rooms[0], capacity: 40 }] };
  assert.throws(() => applyServiceEvent(original, tightCatalog, input), /выбранных групп/);
  const vacation = { ...original, "g2:0": [day("2026-10-05", [[], [], []], true)] };
  assert.throws(() => applyServiceEvent(vacation, catalog, input), /каникулы/);
  assert.equal(original["g1:0"][0].slots.flat().length, 0);
});

test("updates and removes all joint mirrors atomically while preserving other lessons", () => {
  const original = setup();
  const created = applyServiceEvent(original, catalog, input);
  const lessonId = created["g1:0"][0].slots.flat().find((item) => item.subjectId === "event")!.id;
  const updated = applyServiceEvent(created, catalog, { ...input, event: "Классный час", start: 535, lessonId });
  for (const groupId of ["g1", "g2"]) {
    const lesson = updated[`${groupId}:0`][0].slots.flat().find((item) => item.subjectId === "event")!;
    assert.equal(lesson.event, "Классный час");
    assert.equal(updated[`${groupId}:0`][0].times[1].start, 535);
  }
  const updatedLessonId = updated["g1:0"][0].slots.flat().find((item) => item.subjectId === "event")!.id;
  const removed = removeServiceEvent(updated, updatedLessonId);
  assert.equal(removed["g1:0"][0].slots.flat().length, 0);
  assert.equal(removed["g2:0"][0].slots.flat().length, 0);
  assert.equal(removed["other:0"][0].slots[0][0].id, "keep");
  assert.equal(updated["g1:0"][0].slots.flat().length, 1);
});

test("renames a legacy Классный час joint event while preserving its time and unrelated lessons", () => {
  const original = setup();
  for (const groupId of ["g1", "g2"]) {
    original[`${groupId}:0`][0].slots[0].push({
      id: `legacy-${groupId}`,
      subjectId: "event",
      event: "Классный час",
      jointId: "legacy-class-hour",
    });
  }
  const updated = applyServiceEvent(original, catalog, {
    ...input,
    event: "Родительское собрание",
    lessonId: "legacy-g1",
  });

  for (const groupId of ["g1", "g2"]) {
    const day = updated[`${groupId}:0`][0];
    const renamed = day.slots.flat().find((item) => item.subjectId === "event")!;
    assert.equal(renamed.event, "Родительское собрание");
    assert.deepEqual(day.times, original[`${groupId}:0`][0].times);
  }
  assert.equal(updated["other:0"][0].slots[0][0].id, "keep");
  assert.equal(original["g1:0"][0].slots[0][0].event, "Классный час");
});


test("changes only the selected empty slot and keeps slot order and valid breaks", () => {
  const original = setup();
  const result = applyServiceEvent(original, catalog, { ...input, roomId: undefined, start: 700, duration: 30 });
  for (const groupId of ["g1", "g2"]) {
    const changed = result[`${groupId}:0`][0];
    assert.equal(changed.slots[2].length, 1);
    assert.deepEqual(changed.times[2], { start: 700, duration: 30 });
    assert.deepEqual(changed.breaks, [10, 120]);
    assert.equal(changed.start, "08:00");
  }
  assert.deepEqual(original["g1:0"][0].times[2], { start: 590, duration: 45 });
  assert.deepEqual(result["other:0"][0].times, original["other:0"][0].times);
  assert.throws(() => applyServiceEvent(original, catalog, { ...input, duration: 181 }), /180 минут/);
});

test("replacement is opt-in, removes overlapping lessons, and collapses multiple timing cells", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-1", subjectId: "math", teacherId: "t1", roomId: "r1" });
  original["g1:0"][0].slots[1].push({ id: "math-2", subjectId: "math" });
  original["other:0"][0].slots[0] = [];
  const before = structuredClone(original);
  assert.throws(() => applyServiceEvent(original, catalog, { ...input, groupIds: ["g1"], start: 480 }), /свободной ячейки/);
  assert.deepEqual(original, before);

  const result = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], start: 480, duration: 110, replaceLessons: true,
    teacherId: "t1", roomId: "r1",
  });
  const changed = result["g1:0"][0];
  assert.deepEqual(changed.slots[0].map((lesson) => lesson.subjectId), ["event"]);
  assert.equal(changed.times[0]!.start, 480);
  assert.equal(changed.times[0]!.duration, 110);
  assert.equal(changed.slots.some((slot) => slot.some((lesson) => lesson.id === "math-1" || lesson.id === "math-2")), false);
  assert.equal(changed.times[1]!.start, 590);
  assert.deepEqual(changed.breaks, [0]);
});

test("replacement removes every subgroup lesson in an overlapped slot", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push(
    { id: "math-a", subjectId: "math", subgroupId: "a" },
    { id: "math-b", subjectId: "math", subgroupId: "b" },
  );
  const result = applyServiceEvent(original, catalog, { ...input, groupIds: ["g1"], replaceLessons: true });
  assert.deepEqual(result["g1:0"][0].slots[0].map((lesson) => lesson.subjectId), ["event"]);
});

test("preserve mode inserts the event first and keeps the original lesson remainder and later timing", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math", subjectId: "math", teacherId: "t1", roomId: "r1" });
  original["other:0"][0].slots[0] = [];
  const result = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
    teacherId: "t1", roomId: "r1",
  });
  const changed = result["g1:0"][0];
  assert.equal(changed.slots[0]![0]!.subjectId, "event");
  assert.deepEqual(changed.times.slice(0, 3), [
    { start: 480, duration: 20 }, { start: 500, duration: 25 }, { start: 535, duration: 45 },
  ]);
  assert.equal(changed.slots[1]![0]!.id, "math");
  assert.equal(changed.slots[1]![0]!.teacherId, "t1");
  assert.deepEqual(changed.breaks.slice(0, 2), [0, 10]);
});

test("replacement rejects other events and incomplete joint selections atomically", () => {
  const withEvent = setup();
  withEvent["g1:0"][0].slots[0].push({ id: "event-old", subjectId: "event", event: "Собрание" });
  assert.throws(() => applyServiceEvent(withEvent, catalog, { ...input, groupIds: ["g1"], replaceLessons: true }), /другое мероприятие/);

  const joint = setup();
  joint["g1:0"][0].slots[0].push({ id: "joint-1", subjectId: "math", jointId: "j1" });
  joint["g2:0"][0].slots[0].push({ id: "joint-2", subjectId: "math", jointId: "j1" });
  const before = structuredClone(joint);
  assert.throws(() => applyServiceEvent(joint, catalog, { ...input, groupIds: ["g1"], replaceLessons: true }), /тоже нужно включить/);
  assert.deepEqual(joint, before);
});

test("modes validate runtime booleans, exclusivity, and lesson edit targets", () => {
  const original = setup();
  assert.throws(
    () => applyServiceEvent(original, catalog, { ...input, replaceLessons: "true" as unknown as boolean }),
    (error) => error instanceof ServiceEventError && error.statusCode === 400 && /логическим/.test(error.message),
  );
  assert.throws(() => applyServiceEvent(original, catalog, { ...input, replaceLessons: true, preserveLessonRemainder: true }), /одновременно/);
  assert.throws(() => applyServiceEvent(original, catalog, { ...input, lessonId: "keep" }), /только существующее мероприятие/);
});

test("preserve mode rejects a thirteenth slot", () => {
  const original = setup();
  const full = original["g1:0"][0];
  full.times = Array.from({ length: 12 }, (_, index) => ({ start: 480 + index * 50, duration: 45 }));
  full.slots = Array.from({ length: 12 }, () => []);
  full.slots[0].push({ id: "math", subjectId: "math" });
  assert.throws(() => applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
  }), /больше 12/);
});

test("preserve mode places normally in an empty selected group while splitting occupied groups", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-1", subjectId: "math", roomId: "r1" });
  original["g1:0"][0].slots[0].push({ id: "math-2", subjectId: "math", subgroupId: "b" });
  original["other:0"][0].slots[0] = [];
  const result = applyServiceEvent(original, catalog, {
    ...input, duration: 20, preserveLessonRemainder: true, groupIds: ["g1", "g2"],
  });
  const occupied = result["g1:0"][0];
  assert.deepEqual(occupied.slots[0]!.map((lesson) => lesson.subjectId), ["event"]);
  assert.deepEqual(occupied.slots[1]!.map((lesson) => lesson.id), ["math-1", "math-2"]);
  assert.equal(occupied.slots[1]![0]!.roomId, "r1");
  assert.deepEqual(occupied.times[0], { start: 480, duration: 20 });
  assert.deepEqual(occupied.times[1], { start: 500, duration: 25 });

  const empty = result["g2:0"][0];
  assert.equal(empty.slots[0]!.some((lesson) => lesson.subjectId === "event"), true);
  assert.deepEqual(empty.times[0], { start: 480, duration: 20 });
  assert.equal(empty.slots[1]!.length, 0);
  assert.deepEqual(empty.slots[0]![0]!.eventRemainder, {
    date: "2026-10-05", lessonIds: [], originalStart: 480,
    originalDuration: 45, eventDuration: 20,
  });

  const removed = removeServiceEvent(result, empty.slots[0]![0]!.id, catalog);
  assert.deepEqual(removed["g1:0"][0].times[0], { start: 480, duration: 45 });
  assert.deepEqual(removed["g1:0"][0].slots[0]!.map((item) => item.id), ["math-1", "math-2"]);
  assert.deepEqual(removed["g2:0"][0].times[0], { start: 480, duration: 45 });
  assert.deepEqual(removed["g2:0"][0].slots[0], []);
});

test("preserve mode also accepts a free slot exactly as long as the event", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-shortened", subjectId: "math" });
  original["g2:0"][0].times[0].duration = 20;
  original["g2:0"][0].breaks[0] = 35;
  const result = applyServiceEvent(original, catalog, { ...input, duration: 20, preserveLessonRemainder: true });
  assert.equal(result["g1:0"][0].times[1].duration, 25);
  assert.deepEqual(result["g2:0"][0].times[0], { start: 480, duration: 20 });
  assert.equal(result["g2:0"][0].slots.length, 3);
  assert.equal(result["g2:0"][0].slots[0][0].event, "Линейка");
});

test("preserve mode splits all selected mirrors of a joint lesson", () => {
  const original = setup();
  for (const groupId of ["g1", "g2"]) {
    original[`${groupId}:0`][0].slots[0].push({
      id: `joint-${groupId}`, subjectId: "math", jointId: "joint-math", teacherId: "t1", roomId: "r1",
    });
  }
  original["other:0"][0].slots[0] = [];
  const result = applyServiceEvent(original, catalog, {
    ...input, duration: 20, preserveLessonRemainder: true, teacherId: "t1", groupIds: ["g1", "g2"],
  });
  for (const groupId of ["g1", "g2"]) {
    const changed = result[`${groupId}:0`][0];
    assert.equal(changed.slots[0]![0]!.subjectId, "event");
    assert.notEqual(changed.slots[0]![0]!.jointId, "joint-math");
    assert.equal(changed.slots[1]![0]!.id, `joint-${groupId}`);
    assert.equal(changed.slots[1]![0]!.jointId, "joint-math");
    assert.deepEqual(changed.times[1], { start: 500, duration: 25 });
  }
  const eventId = result["g1:0"][0].slots[0][0]!.id;
  const renamed = applyServiceEvent(result, catalog, {
    ...input, event: "Переименованное мероприятие", groupIds: ["g1", "g2"],
    duration: 15, lessonId: eventId,
  });
  for (const groupId of ["g1", "g2"]) {
    const dayRenamed = renamed[`${groupId}:0`][0];
    assert.equal(dayRenamed.slots[0]![0]!.event, "Переименованное мероприятие");
    assert.equal(dayRenamed.slots[1]![0]!.id, `joint-${groupId}`);
    assert.equal(dayRenamed.slots[1]![0]!.jointId, "joint-math");
    assert.deepEqual(dayRenamed.times[0], { start: 480, duration: 15 });
    assert.deepEqual(dayRenamed.times[1], { start: 495, duration: 30 });
  }
  const restored = removeServiceEvent(renamed, eventId, catalog);
  for (const groupId of ["g1", "g2"]) {
    const dayRestored = restored[`${groupId}:0`][0];
    assert.deepEqual(dayRestored.times[0], { start: 480, duration: 45 });
    assert.equal(dayRestored.slots[0]![0]!.id, `joint-${groupId}`);
    assert.equal(dayRestored.slots[0]![0]!.jointId, "joint-math");
  }
});

test("renaming a split event does not validate the temporary restored lesson against its event interval", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math", subjectId: "math", teacherId: "t1" });
  original["other:0"][0].slots[0] = [];
  const split = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true, teacherId: "t1",
  });
  const eventId = split["g1:0"][0].slots[0][0]!.id;
  split["other:0"][0].times[0]!.duration = 10;
  split["other:0"][0].slots[0].push({ id: "new-teacher-use", subjectId: "math", teacherId: "t1" });
  const renamed = applyServiceEvent(split, catalog, {
    ...input, groupIds: ["g1"], duration: 20, lessonId: eventId,
    event: "Переименовано",
  });
  assert.equal(renamed["g1:0"][0].slots[0]![0]!.event, "Переименовано");
});

test("removal and participant removal reject newly conflicting restored lessons", () => {
  const makeSchedule = () => {
    const original = setup();
    original["g1:0"][0].slots[0].push({ id: "math", subjectId: "math", teacherId: "t1" });
    original["other:0"][0].slots[0] = [];
    const split = applyServiceEvent(original, catalog, {
      ...input, groupIds: ["g1", "g2"], duration: 20, preserveLessonRemainder: true,
    });
    split["other:0"][0].times[0]!.duration = 10;
    split["other:0"][0].slots[0].push({ id: "new-teacher-use", subjectId: "math", teacherId: "t1" });
    return split;
  };
  const forDelete = makeSchedule();
  const eventId = forDelete["g1:0"][0].slots[0][0]!.id;
  assert.throws(() => removeServiceEvent(forDelete, eventId, catalog), /Преподаватель/);

  const forEdit = makeSchedule();
  const editEventId = forEdit["g1:0"][0].slots[0][0]!.id;
  assert.throws(() => applyServiceEvent(forEdit, catalog, {
    ...input, groupIds: ["g2"], duration: 20, lessonId: editEventId,
  }), /Преподаватель/);
});

test("deleting a short preserve-mode event restores the exact original lesson and duration", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math", roomId: "r1" });
  const split = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
  });
  const event = split["g1:0"][0].slots[0][0]!;
  assert.deepEqual(event.eventRemainder, {
    date: "2026-10-05", lessonIds: ["math-original"], originalStart: 480,
    originalDuration: 45, eventDuration: 20,
  });
  const removed = removeServiceEvent(split, event.id, catalog);
  const restored = removed["g1:0"][0];
  assert.deepEqual(restored.times.slice(0, 2), [{ start: 480, duration: 45 }, { start: 535, duration: 45 }]);
  assert.equal(restored.slots[0]![0]!.id, "math-original");
  assert.equal(restored.slots[0]![0]!.roomId, "r1");
  assert.equal(restored.slots.flat().some((item) => item.subjectId === "event"), false);
});

test("the schedule editor delete path restores a split lesson too", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math" });
  const split = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
  });
  const eventId = split["g1:0"][0].slots[0][0]!.id;
  const removed = removeLesson(split, {
    groupId: "g1", weekOffset: 0, date: "2026-10-05", slot: 0,
  }, eventId, catalog);
  assert.deepEqual(removed["g1:0"][0].times[0], { start: 480, duration: 45 });
  assert.equal(removed["g1:0"][0].slots[0]![0]!.id, "math-original");
});

test("editing a split event keeps its preserve mode and restores before re-splitting", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math" });
  const split = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
  });
  const eventId = split["g1:0"][0].slots[0][0]!.id;
  const updated = applyServiceEvent(split, catalog, {
    ...input, groupIds: ["g1"], duration: 15, lessonId: eventId,
  });
  const dayResult = updated["g1:0"][0];
  assert.equal(dayResult.slots[0]![0]!.subjectId, "event");
  assert.equal(dayResult.slots[0]![0]!.eventRemainder?.eventDuration, 15);
  assert.equal(dayResult.slots[1]![0]!.id, "math-original");
  assert.deepEqual(dayResult.times.slice(0, 2), [{ start: 480, duration: 15 }, { start: 495, duration: 30 }]);
});

test("a changed remainder cell is not overwritten when deleting a split event", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math" });
  const split = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 20, preserveLessonRemainder: true,
  });
  split["g1:0"][0].times[1]!.start = 501;
  const before = structuredClone(split);
  const eventId = split["g1:0"][0].slots[0][0]!.id;
  assert.throws(() => removeServiceEvent(split, eventId), /исходный урок.*изменились/i);
  assert.deepEqual(split, before);
});

test("preserve mode replaces lessons when the event is at least a lesson long", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math" });
  const result = applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 50, preserveLessonRemainder: true,
  });
  const changed = result["g1:0"][0];
  assert.deepEqual(changed.times[0], { start: 480, duration: 50 });
  assert.equal(changed.slots[0]![0]!.subjectId, "event");
  assert.equal(changed.slots.flat().some((item) => item.id === "math-original"), false);
  assert.equal(changed.slots[0]![0]!.eventRemainder, undefined);
});

test("a shorter event never treats a tiny overlapping empty cell as a replacement-sized lesson", () => {
  const original = setup();
  original["g1:0"][0].slots[0].push({ id: "math-original", subjectId: "math" });
  original["g1:0"][0].times[1] = { start: 515, duration: 5 };
  const before = structuredClone(original);
  assert.throws(() => applyServiceEvent(original, catalog, {
    ...input, groupIds: ["g1"], duration: 40, preserveLessonRemainder: true,
  }), /начинаться с начала одного урока/);
  assert.deepEqual(original, before);
});
