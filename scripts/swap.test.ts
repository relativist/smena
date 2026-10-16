import test from "node:test";
import assert from "node:assert/strict";
import { buildSeedCatalog } from "../shared/catalog-seed.ts";
import {
  canSwapLessons,
  createSchedule,
  key,
  swapLessons,
  type EditorLesson,
  type Location,
  type Schedule,
} from "../src/editor.ts";
import type { Catalog } from "../shared/catalog.ts";

function fixture() {
  const schedule = createSchedule();
  const catalog: Catalog = buildSeedCatalog();
  const teacherA = "swap-teacher-a";
  const teacherB = "swap-teacher-b";
  const roomA = "swap-room-a";
  const roomB = "swap-room-b";
  catalog.teachers.push(
    { id: teacherA, name: "Учитель А", archived: false, subjectIds: ["math", "english"], defaultRoomId: null },
    { id: teacherB, name: "Учитель Б", archived: false, subjectIds: ["math", "english"], defaultRoomId: null },
  );
  catalog.rooms.push(
    { id: roomA, name: "Кабинет А", archived: false, kind: "general", capacity: null },
    { id: roomB, name: "Кабинет Б", archived: false, kind: "general", capacity: null },
  );
  const fromDay = schedule[key("5a", 0)][0];
  const toDay = schedule[key("5a", 0)][1];
  const from: Location = { groupId: "5a", weekOffset: 0, date: fromDay.date, slot: 0 };
  const to: Location = { groupId: "5a", weekOffset: 0, date: toDay.date, slot: 1 };
  const first: EditorLesson = {
    id: "lesson-first", subjectId: "math", lessonKind: "regular",
    teacherId: teacherA, roomId: roomA, note: "Первая заметка",
  };
  const second: EditorLesson = {
    id: "lesson-second", subjectId: "english", lessonKind: "regular",
    teacherId: teacherB, roomId: roomB, note: "Вторая заметка",
  };
  const withLessons: Schedule = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((day) => ({
      ...day,
      slots: day.slots.map((slot, index) =>
        day.date === from.date && index === from.slot ? [first] :
        day.date === to.date && index === to.slot ? [second] : [...slot]),
    })),
  };
  return { schedule: withLessons, catalog, from, to, first, second, teacherA, teacherB, roomA, roomB };
}

function slot(schedule: Schedule, location: Location): EditorLesson[] {
  return schedule[key(location.groupId, location.weekOffset)].find((day) => day.date === location.date)!.slots[location.slot];
}

test("swaps same-day lessons and preserves lesson fields and cell times", () => {
  const f = fixture();
  const day = f.schedule[key("5a", 0)].find((entry) => entry.date === f.from.date)!;
  const toSameDay = { ...f.to, date: f.from.date, slot: 2 };
  const sameDaySchedule: Schedule = {
    ...f.schedule,
    [key("5a", 0)]: f.schedule[key("5a", 0)].map((entry) => entry.date === f.from.date
      ? { ...entry, slots: entry.slots.map((items, index) => index === 2 ? [f.second] : items) }
      : entry.date === f.to.date
        ? { ...entry, slots: entry.slots.map((items, index) => index === f.to.slot ? [] : items) }
        : entry),
  };
  const firstTime = day.times[f.from.slot];
  const secondTime = day.times[toSameDay.slot];
  const swapped = swapLessons(sameDaySchedule, f.from, f.first.id, toSameDay, f.catalog);
  assert.equal(slot(swapped, f.from)[0].id, f.second.id);
  assert.equal(slot(swapped, toSameDay)[0].id, f.first.id);
  assert.equal(slot(swapped, f.from)[0].note, "Вторая заметка");
  assert.deepEqual(swapped[key("5a", 0)].find((entry) => entry.date === f.from.date)!.times[f.from.slot], firstTime);
  assert.deepEqual(swapped[key("5a", 0)].find((entry) => entry.date === f.from.date)!.times[toSameDay.slot], secondTime);
  assert.equal(slot(sameDaySchedule, f.from)[0].id, f.first.id, "the input snapshot stays unchanged");
});

test("swaps across weekdays and across week offsets", () => {
  const f = fixture();
  const weekdaySwap = swapLessons(f.schedule, f.from, f.first.id, f.to, f.catalog);
  assert.equal(slot(weekdaySwap, f.from)[0].id, f.second.id);
  assert.equal(slot(weekdaySwap, f.to)[0].id, f.first.id);

  const nextWeekDay = f.schedule[key("5a", 1)][0];
  const nextWeek: Location = { groupId: "5a", weekOffset: 1, date: nextWeekDay.date, slot: 3 };
  const third: EditorLesson = { ...f.second, id: "lesson-next-week", note: "Следующая неделя" };
  const withNextWeek = {
    ...f.schedule,
    [key("5a", 1)]: f.schedule[key("5a", 1)].map((day) => day.date === nextWeek.date
      ? { ...day, slots: day.slots.map((items, index) => index === nextWeek.slot ? [third] : items) }
      : day),
  };
  const weekSwap = swapLessons(withNextWeek, f.from, f.first.id, nextWeek, f.catalog);
  assert.equal(slot(weekSwap, f.from)[0].id, third.id);
  assert.equal(slot(weekSwap, nextWeek)[0].id, f.first.id);
});

test("checks both destinations for teacher and room conflicts, with both old slots vacated", () => {
  const f = fixture();
  assert.equal(canSwapLessons(f.schedule, f.from, f.first.id, f.to, f.catalog), null);
  // Both lessons reuse the same teacher and room at different dates. The
  // vacated slots must not make these resources conflict with their old use.
  const sameResources: Schedule = {
    ...f.schedule,
    [key("5a", 0)]: f.schedule[key("5a", 0)].map((day) => ({
      ...day,
      slots: day.slots.map((items) => items.map((lesson) =>
        lesson.id === f.second.id
          ? { ...lesson, teacherId: f.teacherA, roomId: f.roomA }
          : lesson)),
    })),
  };
  assert.equal(canSwapLessons(sameResources, f.from, f.first.id, f.to, f.catalog), null);
  const reused = swapLessons(sameResources, f.from, f.first.id, f.to, f.catalog);
  assert.equal(slot(reused, f.from)[0].id, f.second.id);
  assert.equal(slot(reused, f.to)[0].id, f.first.id);
  const otherGroupKey = key("5b", 0);
  const addBlocker = (location: Location, teacherId?: string, roomId?: string): Schedule => ({
    ...f.schedule,
    [otherGroupKey]: f.schedule[otherGroupKey].map((day) => day.date === location.date
      ? {
        ...day,
        times: day.times.map((time, index) => index === location.slot
          ? { ...time, ...f.schedule[key("5a", 0)].find((entry) => entry.date === location.date)!.times[location.slot] }
          : time),
        slots: day.slots.map((items, index) => index === location.slot
          ? [...items, { id: "blocker", subjectId: "math", teacherId, roomId }]
          : items),
      }
      : day),
  });
  const teacherBlocked = addBlocker(f.to, f.teacherA);
  assert.match(canSwapLessons(teacherBlocked, f.from, f.first.id, f.to, f.catalog) ?? "", /Учитель А/);
  assert.throws(() => swapLessons(teacherBlocked, f.from, f.first.id, f.to, f.catalog), /Учитель А/);
  assert.equal(slot(teacherBlocked, f.from)[0].id, f.first.id);

  const roomBlocked = addBlocker(f.to, undefined, f.roomA);
  assert.match(canSwapLessons(roomBlocked, f.from, f.first.id, f.to, f.catalog) ?? "", /Кабинет А/);
  assert.throws(() => swapLessons(roomBlocked, f.from, f.first.id, f.to, f.catalog), /Кабинет А/);
  assert.equal(slot(roomBlocked, f.from)[0].id, f.first.id);

  const reverseTeacherBlocked = addBlocker(f.from, f.teacherB);
  assert.match(canSwapLessons(reverseTeacherBlocked, f.from, f.first.id, f.to, f.catalog) ?? "", /Учитель Б/);
  const reverseRoomBlocked = addBlocker(f.from, undefined, f.roomB);
  assert.match(canSwapLessons(reverseRoomBlocked, f.from, f.first.id, f.to, f.catalog) ?? "", /Кабинет Б/);
});

test("rejects subgroup, joint, event, holiday and non-singleton target cells without mutation", () => {
  const f = fixture();
  const variants: EditorLesson[] = [
    { ...f.first, subgroup: "5А/1" },
    { ...f.first, subgroupId: "subgroup:5a:1" },
    { ...f.first, jointId: "joint-1" },
    { ...f.first, event: "Линейка", subjectId: "event" },
  ];
  for (const lesson of variants) {
    const schedule = { ...f.schedule, [key("5a", 0)]: f.schedule[key("5a", 0)].map((day) => day.date === f.from.date
      ? { ...day, slots: day.slots.map((items, index) => index === f.from.slot ? [lesson] : items) }
      : day) };
    assert.ok(canSwapLessons(schedule, f.from, lesson.id, f.to, f.catalog));
    assert.throws(() => swapLessons(schedule, f.from, lesson.id, f.to, f.catalog));
    assert.equal(slot(schedule, f.from)[0].id, lesson.id);
  }
  const extraTarget: Schedule = {
    ...f.schedule,
    [key("5a", 0)]: f.schedule[key("5a", 0)].map((day) => day.date === f.to.date
      ? { ...day, slots: day.slots.map((items, index) => index === f.to.slot ? [...items, { ...f.first, id: "extra" }] : items) }
      : day),
  };
  assert.match(canSwapLessons(extraTarget, f.from, f.first.id, f.to, f.catalog) ?? "", /ровно один урок/);
  assert.throws(() => swapLessons(extraTarget, f.from, f.first.id, f.to, f.catalog), /ровно один урок/);
  assert.equal(slot(extraTarget, f.from)[0].id, f.first.id);

  const extraSource: Schedule = {
    ...f.schedule,
    [key("5a", 0)]: f.schedule[key("5a", 0)].map((day) => day.date === f.from.date
      ? { ...day, slots: day.slots.map((items, index) => index === f.from.slot ? [...items, { ...f.second, id: "extra-source" }] : items) }
      : day),
  };
  assert.match(canSwapLessons(extraSource, f.from, f.first.id, f.to, f.catalog) ?? "", /ровно один урок/);
  assert.throws(() => swapLessons(extraSource, f.from, f.first.id, f.to, f.catalog), /ровно один урок/);
  assert.equal(slot(extraSource, f.from)[0].id, f.first.id);

  const holiday = { ...f.schedule, [key("5a", 0)]: f.schedule[key("5a", 0)].map((day) => day.date === f.to.date ? { ...day, holiday: true } : day) };
  assert.match(canSwapLessons(holiday, f.from, f.first.id, f.to, f.catalog) ?? "", /каникулы/);
});
