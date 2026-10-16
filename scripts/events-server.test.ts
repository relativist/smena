import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

async function start() {
  const root = mkdtempSync(join(tmpdir(), "smena-events-server-"));
  roots.push(root);
  const path = join(root, "test.sqlite");
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary event test password" } });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"]?.toString().split(";")[0];
  assert.ok(cookie);
  return { app, path, headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": setup.json().csrfToken as string } };
}

async function readState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

type AcademicLesson = {
  groupId: string;
  date: string;
  lesson: StateResponse["schedule"][string][number]["slots"][number][number];
  start: number;
  duration: number;
};

function academicLessons(state: StateResponse): AcademicLesson[] {
  return Object.entries(state.schedule).flatMap(([key, days]) => {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    return days.flatMap(day => day.slots.flatMap((slot, index) => {
      if (slot.length !== 1 || day.holiday) return [];
      const lesson = slot[0]!;
      if (lesson.event || lesson.subjectId === "event" || lesson.jointId) return [];
      const time = day.times[index];
      return time ? [{ groupId, date: day.date, lesson, start: time.start, duration: time.duration }] : [];
    }));
  });
}

type EventRemainder = {
  date: string;
  lessonIds: string[];
  originalStart: number;
  originalDuration: number;
  eventDuration: number;
};

function eventLesson(state: StateResponse, groupId: string, date: string, name: string) {
  return Object.entries(state.schedule)
    .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === groupId)
    .flatMap(([, days]) => days)
    .find(day => day.date === date)?.slots.flat().find(lesson => lesson.event === name);
}

function dayForLesson(state: StateResponse, target: AcademicLesson) {
  return Object.values(state.schedule).flat().find(day => day.date === target.date && day.slots.some(slot => slot.some(item => item.id === target.lesson.id)))!;
}

function eventRequest(state: StateResponse, target: AcademicLesson, flags: Record<string, unknown> = {}) {
  return {
    revision: state.revision,
    operation: "event",
    options: {
      event: "Проверочное мероприятие",
      groupIds: [target.groupId],
      date: target.date,
      start: target.start,
      duration: target.duration,
      ...flags,
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("event replacement preview reports removed lesson without changing revision, then apply persists it", async () => {
  const { app, headers } = await start();
  const before = await readState(app, headers);
  const target = academicLessons(before).find(item => item.duration >= 20);
  assert.ok(target, "seed schedule includes an individual academic lesson");

  const preview = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: eventRequest(before, target, { duration: target.duration, replaceLessons: true }) });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().revision, before.revision);
  assert.deepEqual(preview.json().affectedLessons.map((row: { lessonId: string }) => row.lessonId), [target.lesson.id]);
  const afterPreview = await readState(app, headers);
  assert.equal(afterPreview.revision, before.revision, "preview does not commit schedule changes");
  assert.ok(academicLessons(afterPreview).some(item => item.lesson.id === target.lesson.id));

  const applied = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: { ...eventRequest(before, target, { duration: target.duration, replaceLessons: true }), requestId: "event-replace-test-001" } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().revision, before.revision + 1);
  assert.deepEqual(applied.json().preview.affectedLessons.map((row: { lessonId: string }) => row.lessonId), [target.lesson.id]);
  const afterApply = await readState(app, headers);
  const current = academicLessons(afterApply);
  assert.equal(current.some(item => item.lesson.id === target.lesson.id), false, "the replaced lesson is removed from persisted schedule");
  const event = eventLesson(afterApply, target.groupId, target.date, "Проверочное мероприятие");
  assert.ok(event);
  assert.equal((event as typeof event & { eventRemainder?: EventRemainder }).eventRemainder, undefined, "full replacement does not record remainder restoration metadata");
  const removed = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: afterApply.revision,
    requestId: "event-replace-delete-no-restore-001",
    operation: "event",
    options: { lessonId: event.id, remove: true },
  } });
  assert.equal(removed.statusCode, 200, removed.body);
  const afterDelete = await readState(app, headers);
  assert.equal(academicLessons(afterDelete).some(item => item.lesson.id === target.lesson.id), false, "full replacement does not restore the removed lesson when the event is deleted");
});

test("event context returns the requested date for every group and rejects invalid or unauthenticated requests", async () => {
  const { app, headers } = await start();
  const state = await readState(app, headers);
  const requestedDate = Object.values(state.schedule).flat()[0]?.date;
  assert.ok(requestedDate, "schedule contains a date for context lookup");

  const response = await app.inject({ url: `/api/schedule-operations/event-context?date=${requestedDate}`, headers });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json() as { revision: number; schedule: StateResponse["schedule"] };
  assert.equal(result.revision, state.revision);
  const returnedDays = Object.entries(result.schedule).flatMap(([key, days]) => days.map(day => ({ groupId: key.slice(0, key.lastIndexOf(":")), day })));
  assert.ok(returnedDays.length > 0);
  assert.ok(returnedDays.every(item => item.day.date === requestedDate), "no other dates are returned");
  const expectedGroups = new Set(Object.entries(state.schedule).flatMap(([key, days]) => days.some(day => day.date === requestedDate) ? [key.slice(0, key.lastIndexOf(":"))] : []));
  assert.deepEqual(new Set(returnedDays.map(item => item.groupId)), expectedGroups, "the requested date includes all groups");

  const missing = await app.inject({ url: "/api/schedule-operations/event-context", headers });
  assert.equal(missing.statusCode, 400, missing.body);
  const malformed = await app.inject({ url: "/api/schedule-operations/event-context?date=not-a-date", headers });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const unauthorized = await app.inject({ url: `/api/schedule-operations/event-context?date=${requestedDate}` });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);
});

test("short event remainder metadata persists through restart and deleting event restores the original lesson", async () => {
  const { app, path, headers } = await start();
  const before = await readState(app, headers);
  const target = academicLessons(before).find(item => item.duration === 45 && item.lesson.teacherId && item.lesson.roomId);
  assert.ok(target, "seed schedule includes an individual 45-minute lesson with teacher and room");
  const targetDay = dayForLesson(before, target);
  const unchangedFollowingTimes = targetDay.times.filter(time => time.start >= target.start + target.duration);
  const targetIndex = targetDay.times.findIndex(time => time.start === target.start);
  const unchangedFollowingBreaks = targetDay.breaks.slice(targetIndex);

  const applied = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    ...eventRequest(before, target, { duration: 20, preserveLessonRemainder: true }),
    requestId: "event-preserve-remainder-test-001",
  } });
  assert.equal(applied.statusCode, 200, applied.body);
  const after = await readState(app, headers);
  const day = Object.values(after.schedule).flat().find(item => item.date === target.date && item.slots.some(slot => slot.some(lesson => lesson.id === target.lesson.id)))!;
  const eventSlot = day.slots.findIndex(slot => slot.some(lesson => lesson.event === "Проверочное мероприятие"));
  const eventTime = day.times[eventSlot]!;
  assert.equal(eventTime.start, target.start);
  assert.equal(eventTime.duration, 20);
  const remainderSlot = day.slots.findIndex(slot => slot.some(lesson => lesson.id === target.lesson.id));
  const remainderTime = day.times[remainderSlot]!;
  const remainder = day.slots[remainderSlot]!.find(lesson => lesson.id === target.lesson.id)!;
  assert.equal(remainderTime.start, target.start + 20);
  assert.equal(remainderTime.duration, target.duration - 20);
  assert.deepEqual(day.times[remainderSlot - 1], eventTime);
  assert.equal(day.breaks[remainderSlot - 1], 0, "event and remainder have no break between them");
  assert.equal(remainder.teacherId, target.lesson.teacherId);
  assert.equal(remainder.roomId, target.lesson.roomId);
  assert.equal(remainder.subgroupId, target.lesson.subgroupId);
  assert.equal(remainder.lessonKind, target.lesson.lessonKind);
  assert.deepEqual(day.times.filter(time => time.start >= target.start + target.duration), unchangedFollowingTimes, "later lesson times stay unchanged");
  assert.deepEqual(day.breaks.slice(targetIndex + 1), unchangedFollowingBreaks, "later breaks stay unchanged");

  const splitEvent = eventLesson(after, target.groupId, target.date, "Проверочное мероприятие");
  assert.ok(splitEvent, "event is persisted for the target group");
  assert.deepEqual((splitEvent as typeof splitEvent & { eventRemainder?: EventRemainder }).eventRemainder, {
    date: target.date,
    lessonIds: [target.lesson.id],
    originalStart: target.start,
    originalDuration: target.duration,
    eventDuration: 20,
  });

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  const persisted = await readState(reopened, headers);
  assert.deepEqual((eventLesson(persisted, target.groupId, target.date, "Проверочное мероприятие") as typeof splitEvent & { eventRemainder?: EventRemainder })?.eventRemainder, {
    date: target.date,
    lessonIds: [target.lesson.id],
    originalStart: target.start,
    originalDuration: target.duration,
    eventDuration: 20,
  }, "event restoration metadata survives closing and reopening the database");

  const removed = await reopened.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: persisted.revision,
    requestId: "event-restore-after-restart-001",
    operation: "event",
    options: { lessonId: splitEvent.id, remove: true },
  } });
  assert.equal(removed.statusCode, 200, removed.body);
  const restored = await readState(reopened, headers);
  const restoredDay = dayForLesson(restored, target);
  const restoredIndex = restoredDay.slots.findIndex(slot => slot.some(lesson => lesson.id === target.lesson.id));
  const restoredLesson = restoredDay.slots[restoredIndex]!.find(lesson => lesson.id === target.lesson.id)!;
  assert.equal(restoredDay.times[restoredIndex]!.start, target.start);
  assert.equal(restoredDay.times[restoredIndex]!.duration, target.duration);
  assert.equal(restoredLesson.teacherId, target.lesson.teacherId);
  assert.equal(restoredLesson.roomId, target.lesson.roomId);
  assert.equal(restoredLesson.subgroupId, target.lesson.subgroupId);
  assert.equal(restoredDay.slots.flat().some(lesson => lesson.id === splitEvent.id), false);
  assert.deepEqual(restoredDay.times.filter(time => time.start >= target.start + target.duration), unchangedFollowingTimes, "restoration leaves later lesson times unchanged");
});

test("editing a shared event can remove one of its participant groups", async () => {
  const { app, headers } = await start();
  const before = await readState(app, headers);
  const days = Object.entries(before.schedule).flatMap(([key, entries]) => {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    return entries.map(day => ({ groupId, day }));
  }).filter(item => !item.day.holiday);
  let placement: { groups: [string, string]; date: string; start: number; duration: number } | undefined;
  for (let first = 0; first < days.length && !placement; first += 1) {
    for (let second = first + 1; second < days.length && !placement; second += 1) {
      const a = days[first]!;
      const b = days[second]!;
      if (a.groupId === b.groupId || a.day.date !== b.day.date) continue;
      for (let ai = 0; ai < a.day.times.length && !placement; ai += 1) {
        if (a.day.slots[ai]?.length) continue;
        const time = a.day.times[ai]!;
        const bi = b.day.times.findIndex((other, index) =>
          !b.day.slots[index]?.length && other.start === time.start && other.duration === time.duration,
        );
        if (bi >= 0) placement = { groups: [a.groupId, b.groupId], date: a.day.date, start: time.start, duration: time.duration };
      }
    }
  }
  assert.ok(placement, "seed schedule has a shared free slot for two groups");
  const created = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: before.revision,
    requestId: "event-two-groups-create-001",
    operation: "event",
    options: { event: "Общее мероприятие", groupIds: placement.groups, date: placement.date, start: placement.start, duration: placement.duration },
  } });
  assert.equal(created.statusCode, 200, created.body);
  const afterCreate = await readState(app, headers);
  const firstId = Object.values(afterCreate.schedule).flatMap(entries => entries.flatMap(day => day.slots.flat()))
    .find(lesson => lesson.event === "Общее мероприятие")?.id;
  assert.ok(firstId);
  const createdGroups = Object.entries(afterCreate.schedule).flatMap(([key, entries]) => {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    return entries.some(day => day.date === placement.date && day.slots.flat().some(lesson => lesson.event === "Общее мероприятие")) ? [groupId] : [];
  }).sort();
  assert.deepEqual(createdGroups, [...placement.groups].sort());

  const keptGroup = placement.groups[0];
  const edited = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: afterCreate.revision,
    requestId: "event-two-groups-edit-001",
    operation: "event",
    options: { lessonId: firstId, event: "Мероприятие для одной группы", groupIds: [keptGroup], start: placement.start, duration: placement.duration },
  } });
  assert.equal(edited.statusCode, 200, edited.body);
  const afterEdit = await readState(app, headers);
  const eventGroups = Object.entries(afterEdit.schedule).flatMap(([key, entries]) => {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    return entries.some(day => day.date === placement.date && day.slots.flat().some(lesson => lesson.event === "Мероприятие для одной группы")) ? [groupId] : [];
  });
  assert.deepEqual(eventGroups, [keptGroup]);
});

test("editing a split event restores a removed group and a renamed event remains restorable", async () => {
  const { app, path, headers } = await start();
  const before = await readState(app, headers);
  const first = academicLessons(before).find(item => item.duration === 45 && item.lesson.teacherId && item.lesson.roomId);
  assert.ok(first, "seed schedule includes an individual 45-minute lesson");
  const secondGroup = before.catalog.groups.find(group => !group.archived && group.id !== first.groupId);
  assert.ok(secondGroup, "seed schedule includes a second active group");
  const secondDay = Object.entries(before.schedule)
    .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === secondGroup.id)
    .flatMap(([, days]) => days)
    .find(day => day.date === first.date && !day.holiday);
  assert.ok(secondDay, "second group has a schedule day on the target date");

  // Seed a deterministic empty 45-minute cell in the isolated database. The
  // bundled school timetable does not otherwise guarantee matching lesson times.
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    const dayId = (db.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get(secondGroup.id, first.date) as { id: number }).id;
    db.prepare("DELETE FROM lessons WHERE slot_id IN (SELECT id FROM schedule_slots WHERE day_id=?)").run(dayId);
    db.prepare("DELETE FROM schedule_slots WHERE day_id=?").run(dayId);
    db.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,0,?,?)").run(dayId, first.start, first.duration);
  })();
  db.close();
  const seeded = await readState(app, headers);
  const seededSecondDay = Object.entries(seeded.schedule)
    .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === secondGroup.id)
    .flatMap(([, days]) => days)
    .find(day => day.date === first.date)!;
  assert.deepEqual(seededSecondDay.times, [{ start: first.start, duration: 45 }]);
  assert.deepEqual(seededSecondDay.slots, [[]], "the second group begins with an empty 45-minute cell");
  const groups = [first.groupId, secondGroup.id];
  const created = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: before.revision,
    requestId: "event-split-multigroup-create-001",
    operation: "event",
    options: { event: "Короткое общее событие", groupIds: groups, date: first.date, start: first.start, duration: 20, preserveLessonRemainder: true },
  } });
  assert.equal(created.statusCode, 200, created.body);
  const afterCreate = await readState(app, headers);
  const sharedEvent = eventLesson(afterCreate, first.groupId, first.date, "Короткое общее событие");
  assert.ok(sharedEvent);
  const firstEvent = eventLesson(afterCreate, first.groupId, first.date, "Короткое общее событие");
  const secondEvent = eventLesson(afterCreate, secondGroup.id, first.date, "Короткое общее событие");
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.deepEqual((firstEvent as typeof firstEvent & { eventRemainder?: EventRemainder }).eventRemainder, {
    date: first.date,
    lessonIds: [first.lesson.id],
    originalStart: first.start,
    originalDuration: 45,
    eventDuration: 20,
  });
  assert.deepEqual((secondEvent as typeof secondEvent & { eventRemainder?: EventRemainder }).eventRemainder, {
    date: first.date,
    lessonIds: [],
    originalStart: first.start,
    originalDuration: 45,
    eventDuration: 20,
  }, "empty-cell shortening also records the original 45-minute duration");

  const renamed = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: afterCreate.revision,
    requestId: "event-split-multigroup-rename-001",
    operation: "event",
    options: { lessonId: sharedEvent.id, event: "Переименованное событие", groupIds: groups, date: first.date, start: first.start, duration: 20 },
  } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const afterRename = await readState(app, headers);
  const renamedEvent = eventLesson(afterRename, first.groupId, first.date, "Переименованное событие");
  assert.ok(renamedEvent);
  assert.deepEqual((renamedEvent as typeof renamedEvent & { eventRemainder?: EventRemainder }).eventRemainder?.lessonIds, [first.lesson.id], "editing a split event without an explicit mode keeps restoration metadata");

  const edited = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: afterRename.revision,
    requestId: "event-split-multigroup-remove-one-001",
    operation: "event",
    options: { lessonId: renamedEvent.id, event: "Переименованное событие", groupIds: [first.groupId], date: first.date, start: first.start, duration: 20 },
  } });
  assert.equal(edited.statusCode, 200, edited.body);
  const afterEdit = await readState(app, headers);
  const droppedDay = Object.entries(afterEdit.schedule)
    .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === secondGroup.id)
    .flatMap(([, days]) => days)
    .find(day => day.date === first.date)!;
  assert.deepEqual(droppedDay.times, [{ start: first.start, duration: 45 }], "removing one participant restores the original empty 45-minute cell");
  assert.deepEqual(droppedDay.slots, [[]], "restoration does not leave an extra remainder cell");
  assert.equal(eventLesson(afterEdit, secondGroup.id, first.date, "Переименованное событие"), undefined);
  assert.ok(eventLesson(afterEdit, first.groupId, first.date, "Переименованное событие"), "the other group's event remains split");

  const remainingEvent = eventLesson(afterEdit, first.groupId, first.date, "Переименованное событие")!;
  const removed = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: {
    revision: afterEdit.revision,
    requestId: "event-split-multigroup-remove-last-001",
    operation: "event",
    options: { lessonId: remainingEvent.id, remove: true },
  } });
  assert.equal(removed.statusCode, 200, removed.body);
  const final = await readState(app, headers);
  const finalDay = dayForLesson(final, first);
  const finalIndex = finalDay.slots.findIndex(slot => slot.some(lesson => lesson.id === first.lesson.id));
  assert.equal(finalDay.times[finalIndex]!.start, first.start);
  assert.equal(finalDay.times[finalIndex]!.duration, first.duration, "renamed event removal restores its original lesson");
});

test("event without a placement mode still rejects an occupied time; malformed or contradictory modes return 400", async () => {
  const { app, headers } = await start();
  const state = await readState(app, headers);
  const target = academicLessons(state).find(item => item.duration >= 20);
  assert.ok(target);
  const options = eventRequest(state, target).options;

  const occupied = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { ...eventRequest(state, target), options: { ...options, duration: target.duration } } });
  assert.equal(occupied.statusCode, 400, occupied.body);
  const malformed = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { ...eventRequest(state, target), options: { ...options, duration: target.duration, replaceLessons: "yes" } } });
  assert.equal(malformed.statusCode, 400, malformed.body);
  const contradictory = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { ...eventRequest(state, target), options: { ...options, duration: target.duration, replaceLessons: true, preserveLessonRemainder: true } } });
  assert.equal(contradictory.statusCode, 400, contradictory.body);
});

test("replacing a lesson does not bypass a teacher conflict in another group", async () => {
  const { app, path, headers } = await start();
  const initial = await readState(app, headers);
  const lessons = academicLessons(initial);
  const pair = lessons.flatMap(target => lessons
    .filter(other => other.groupId !== target.groupId && other.date === target.date && target.start < other.start + other.duration && other.start < target.start + target.duration)
    .map(other => ({ target, other })))[0];
  assert.ok(pair, "seed schedule contains overlapping lessons in separate groups");
  const teacher = initial.catalog.teachers.find(item => !item.archived);
  assert.ok(teacher);
  const db = new Database(path);
  db.prepare("UPDATE lessons SET teacher_ref=?,teacher=? WHERE id=?").run(teacher.id, teacher.name, pair.other.lesson.id);
  db.close();
  const state = await readState(app, headers);
  const target = academicLessons(state).find(item => item.lesson.id === pair.target.lesson.id)!;
  const response = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: eventRequest(state, target, { duration: target.duration, replaceLessons: true, teacherId: teacher.id }) });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /Преподаватель/);
});
