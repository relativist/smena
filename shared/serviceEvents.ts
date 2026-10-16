import { newUnavailabilityViolation, unavailabilityViolationMessage } from "./unavailability.ts";
import type { Catalog } from "./catalog.ts";
import { newRoomConflict, roomConflictMessage } from "./roomConflicts.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";
import { formatTime } from "../src/editor.ts";
import { newRoomSuitabilityViolation, roomSuitabilityViolationMessage } from "./roomSuitability.ts";
import { newTeacherConflict, teacherConflictMessage } from "./teacherConflicts.ts";
import { restoreEventRemainder, type EventRemainder } from "./eventRemainders.ts";

export type ServiceEventType = "Линейка" | "Мероприятие";

export type ServiceEventInput = {
  event: string;
  groupIds: string[];
  date: string;
  start: number;
  duration: number;
  teacherId?: string;
  roomId?: string;
  location?: {
    groupId: string;
    weekOffset: number;
    date: string;
    slot: number;
  };
  lessonId?: string;
  replaceLessons?: boolean;
  preserveLessonRemainder?: boolean;
};

function withoutEventLessons(
  schedule: Schedule,
  lessons: EditorLesson[],
  catalog?: Catalog,
  validateRestored = true,
): Schedule {
  let next = schedule;
  for (const lesson of lessons) {
    if (!lesson.eventRemainder) continue;
    const restored = restoreEventRemainder(next, lesson);
    if (!restored)
      return fail("Не удалось восстановить исходный урок: время мероприятия или оставшаяся часть урока изменились");
    next = restored;
  }
  next = withoutIds(next, new Set(lessons.map((item) => item.id)));
  if (catalog && validateRestored) {
    const roomConflict = newRoomConflict(next, schedule);
    if (roomConflict) fail(roomConflictMessage(roomConflict, catalog));
    const teacherConflict = newTeacherConflict(next, schedule);
    if (teacherConflict) fail(teacherConflictMessage(teacherConflict, catalog));
    const suitability = newRoomSuitabilityViolation(next, schedule, catalog);
    if (suitability) fail(roomSuitabilityViolationMessage(suitability, catalog));
    const unavailable = newUnavailabilityViolation(next, schedule, catalog);
    if (unavailable) fail(unavailabilityViolationMessage(unavailable, catalog));
  }
  return next;
}

export class ServiceEventError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ServiceEventError";
  }
}

const fail = (message: string): never => {
  throw new ServiceEventError(message);
};

const overlaps = (a: number, b: number, c: number, d: number) => a < d && c < b;

function linkedLessons(schedule: Schedule, lessonId?: string): EditorLesson[] {
  if (!lessonId) return [];

  for (const days of Object.values(schedule)) {
    for (const day of days) {
      for (const slot of day.slots) {
        for (const lesson of slot) {
          if (lesson.id !== lessonId) continue;
          if (lesson.subjectId !== "event")
            return fail("Изменять или удалять можно только существующее мероприятие");
          if (!lesson.jointId) return [lesson];

          return Object.values(schedule).flatMap((groupDays) =>
            groupDays.flatMap((entry) =>
              entry.slots.flat().filter((item) => item.subjectId === "event" && item.jointId === lesson.jointId),
            ),
          );
        }
      }
    }
  }

  return fail("Мероприятие уже удалено из расписания");
}

function withoutIds(schedule: Schedule, ids: Set<string>): Schedule {
  const next: Schedule = {};
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    next[scheduleKey] = days.map((day) => ({
      ...day,
      slots: day.slots.map((slot) =>
        slot.filter((lesson) => !ids.has(lesson.id)),
      ),
    }));
  }
  return next;
}

function groupDay(schedule: Schedule, groupId: string, date: string): EditorDay {
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const split = scheduleKey.lastIndexOf(":");
    if (scheduleKey.slice(0, split) !== groupId) continue;
    const day = days.find((item) => item.date === date);
    if (day) return day;
  }
  return fail(`Для группы «${groupId}» нет даты ${date} в расписании`);
}

function canPlaceAt(
  day: EditorDay,
  slot: number,
  start: number,
  duration: number,
  preserveTime: boolean,
): boolean {
  if (day.slots[slot]?.length) return false;
  if (
    preserveTime &&
    (day.times[slot].start !== start || day.times[slot].duration !== duration)
  )
    return false;

  const proposed = day.times.map((time, index) =>
    index === slot ? { start, duration } : time,
  );
  for (let index = 0; index < proposed.length; index += 1) {
    const time = proposed[index];
    if (
      index > 0 &&
      proposed[index - 1].start + proposed[index - 1].duration > time.start
    )
      return false;
    if (index < proposed.length - 1) {
      const gap = proposed[index + 1].start - (time.start + time.duration);
      if (gap < 0 || gap > 240) return false;
    }
  }
  return day.times.every(
    (time, index) =>
      index === slot ||
      !overlaps(start, start + duration, time.start, time.start + time.duration),
  );
}

function chooseSlot(
  day: EditorDay,
  start: number,
  duration: number,
  preferred?: number,
): number {
  const slots = day.times.map((_, index) => index);
  const exactSlots = preferred === undefined
    ? slots
    : [preferred, ...slots.filter((slot) => slot !== preferred)];
  const exact = exactSlots.find((slot) =>
    canPlaceAt(day, slot, start, duration, true),
  );
  if (exact !== undefined) return exact;

  // Keep the existing chronological order when changing an empty slot's time.
  const flexible = slots.find((slot) =>
    canPlaceAt(day, slot, start, duration, false),
  );
  if (flexible !== undefined) return flexible;

  const time = `${Math.floor(start / 60)}:${String(start % 60).padStart(2, "0")}`;
  return fail(
    `Нет свободной ячейки на ${time} длительностью ${duration} мин без пересечения с соседними занятиями`,
  );
}

function syncDayTiming(day: EditorDay): void {
  if (day.times.length) day.start = formatTime(day.times[0].start);
  day.breaks = day.times.slice(0, -1).map((time, index) =>
    day.times[index + 1].start - (time.start + time.duration),
  );
}

function assertJointGroupsSelected(
  schedule: Schedule,
  lessons: EditorLesson[],
  selectedGroups: Set<string>,
  catalog: Catalog,
  date: string,
  start: number,
  duration: number,
  preserveRemainder: boolean,
): void {
  for (const lesson of lessons) {
    if (!lesson.jointId) continue;
    const mirrors: Array<{ groupId: string; time: EditorDay["times"][number] }> = [];
    for (const [scheduleKey, days] of Object.entries(schedule)) {
      const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
      for (const day of days) {
        if (day.date !== date) continue;
        day.slots.forEach((slot, index) => {
          if (slot.some((entry) => entry.jointId === lesson.jointId) && day.times[index])
            mirrors.push({ groupId, time: day.times[index] });
        });
      }
    }
    for (const { groupId, time } of mirrors) {
      if (!selectedGroups.has(groupId))
        fail(`Сдвоенный урок группы «${catalog.groups.find((item) => item.id === groupId)?.name ?? groupId}» тоже нужно включить в мероприятие`);
      const valid = preserveRemainder
        ? time.start === start && duration < time.duration && start + duration < time.start + time.duration
        : overlaps(start, start + duration, time.start, time.start + time.duration);
      if (!valid)
        fail(`Сдвоенный урок группы «${catalog.groups.find((item) => item.id === groupId)?.name ?? groupId}» не совпадает по времени с мероприятием`);
    }
  }
}

function insertChronologically(day: EditorDay, lesson: EditorLesson, start: number, duration: number): number {
  const index = day.times.findIndex((time) => time.start > start);
  const insertionIndex = index < 0 ? day.times.length : index;
  day.times.splice(insertionIndex, 0, { start, duration });
  day.slots.splice(insertionIndex, 0, [lesson]);
  if (day.times.length > 12) fail("В расписании не может быть больше 12 занятий в день");
  for (let i = 1; i < day.times.length; i += 1) {
    const gap = day.times[i].start - (day.times[i - 1].start + day.times[i - 1].duration);
    if (gap < 0 || gap > 240) fail("Мероприятие пересекается с соседними занятиями или слишком далеко от них");
  }
  syncDayTiming(day);
  return insertionIndex;
}

export function applyServiceEvent(
  schedule: Schedule,
  catalog: Catalog,
  input: ServiceEventInput,
): Schedule {
  if (input.replaceLessons !== undefined && typeof input.replaceLessons !== "boolean")
    fail("Параметр замены уроков должен быть логическим");
  if (input.preserveLessonRemainder !== undefined && typeof input.preserveLessonRemainder !== "boolean")
    fail("Параметр сохранения остатка урока должен быть логическим");
  if (input.replaceLessons && input.preserveLessonRemainder)
    fail("Нельзя одновременно заменять урок и включать мероприятие в состав урока");
  if (typeof input.event !== "string")
    fail("Укажите название мероприятия");
  const event = input.event.trim();
  if (!event || event.length > 200)
    fail("Название мероприятия должно содержать от 1 до 200 символов");
  if (!input.groupIds.length) fail("Выберите хотя бы одну группу");
  if (
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.duration) ||
    input.duration < 1 ||
    input.duration > 180 ||
    input.start < 0 ||
    input.start > 1439 ||
    input.start + input.duration > 1440
  )
    fail("Проверьте время и длительность мероприятия (до 180 минут)");

  const old = linkedLessons(schedule, input.lessonId);
  const oldIds = new Set(old.map((item) => item.id));
  const oldIdByGroup = new Map<string, string>();
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    for (const day of days) for (const lesson of day.slots.flat()) {
      if (oldIds.has(lesson.id)) oldIdByGroup.set(groupId, lesson.id);
    }
  }
  const preserveRemainder = input.preserveLessonRemainder ?? old.some((item) => Boolean(item.eventRemainder));
  const base = withoutEventLessons(schedule, old, catalog, false);
  const oldEventJointId = old.find((item) => item.subjectId === "event")?.jointId;
  const jointId = oldEventJointId ?? `event-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const selected = [...new Set(input.groupIds)];
  const groups = selected.map((groupId) => {
    const group = catalog.groups.find(
      (item) => item.id === groupId && !item.archived,
    );
    if (!group) return fail("Выбрана несуществующая или архивная группа");
    return group;
  });
  const selectedSet = new Set(selected);
  const result = structuredClone(base);
  const replacedLessonIds = new Set<string>();
  const teacher = catalog.teachers.find(
    (item) => item.id === input.teacherId && !item.archived,
  );
  const room = catalog.rooms.find(
    (item) => item.id === input.roomId && !item.archived,
  );
  if (input.teacherId && !teacher) fail("Выбранный преподаватель недоступен");
  if (input.roomId && !room) fail("Выбранный кабинет недоступен");
  for (const group of groups) {
    const day = groupDay(result, group.id, input.date);
    if (day.holiday)
      fail(`В группе «${group.name}» на выбранную дату каникулы`);
    const preferred =
      input.location?.groupId === group.id && input.location.date === input.date
        ? input.location.slot
        : undefined;
    const lesson: EditorLesson = {
      id: oldIdByGroup.get(group.id) ?? `service-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      subjectId: "event",
      event,
      jointId,
      teacherId: teacher?.id,
      teacher: teacher?.name,
      roomId: room?.id,
      room: room?.name,
    };
    if (input.replaceLessons) {
      const hit = day.times.flatMap((time, index) =>
        overlaps(input.start, input.start + input.duration, time.start, time.start + time.duration) ? [index] : [],
      );
      const hitLessons = hit.flatMap((index) => day.slots[index] ?? []);
      if (hitLessons.some((item) => item.subjectId === "event"))
        fail(`Группа «${group.name}»: мероприятие не может заменять другое мероприятие`);
      assertJointGroupsSelected(base, hitLessons, selectedSet, catalog, input.date, input.start, input.duration, false);
      for (const item of hitLessons) replacedLessonIds.add(item.id);
      const first = hit[0] ?? -1;
      if (hit.length) {
        const remove = new Set(hit);
        day.times = day.times.filter((_, index) => !remove.has(index));
        day.slots = day.slots.filter((_, index) => !remove.has(index));
      }
      const insertAt = first < 0 ? undefined : Math.min(first, day.times.length);
      if (insertAt === undefined) {
        insertChronologically(day, lesson, input.start, input.duration);
      } else {
        day.times.splice(insertAt, 0, { start: input.start, duration: input.duration });
        day.slots.splice(insertAt, 0, [lesson]);
        if (day.times.length > 12) fail("В расписании не может быть больше 12 занятий в день");
        for (let i = 1; i < day.times.length; i += 1) {
          const gap = day.times[i].start - (day.times[i - 1].start + day.times[i - 1].duration);
          if (gap < 0 || gap > 240)
            fail(`Группа «${group.name}»: мероприятие пересекается с соседними занятиями или слишком далеко от них`);
        }
        syncDayTiming(day);
      }
    } else if (preserveRemainder) {
      const hit = day.times.flatMap((time, index) =>
        overlaps(input.start, input.start + input.duration, time.start, time.start + time.duration) ? [index] : [],
      );
      if (hit.every((index) => !day.slots[index].length)) {
        let slot: number;
        try { slot = chooseSlot(day, input.start, input.duration, preferred); }
        catch (error) { return fail(`Группа «${group.name}»: ${error instanceof Error ? error.message : "не удалось подобрать время"}`); }
        const originalTime = day.times[slot]!;
        if (originalTime.start === input.start && input.duration < originalTime.duration) {
          lesson.eventRemainder = {
            date: input.date,
            lessonIds: [],
            originalStart: originalTime.start,
            originalDuration: originalTime.duration,
            eventDuration: input.duration,
          };
        }
        day.times[slot] = { start: input.start, duration: input.duration };
        day.slots[slot].push(lesson);
        syncDayTiming(day);
      } else if (hit.some((index) => day.slots[index]!.length > 0) &&
          hit.some((index) => day.slots[index]!.length > 0 && input.duration >= day.times[index]!.duration)) {
        const hitLessons = hit.flatMap((index) => day.slots[index] ?? []);
        if (hitLessons.some((item) => item.subjectId === "event"))
          fail(`Группа «${group.name}»: мероприятие не может заменять другое мероприятие`);
        assertJointGroupsSelected(base, hitLessons, selectedSet, catalog, input.date, input.start, input.duration, false);
        for (const item of hitLessons) replacedLessonIds.add(item.id);
        const first = hit[0]!;
        const remove = new Set(hit);
        day.times = day.times.filter((_, index) => !remove.has(index));
        day.slots = day.slots.filter((_, index) => !remove.has(index));
        const insertAt = Math.min(first, day.times.length);
        day.times.splice(insertAt, 0, { start: input.start, duration: input.duration });
        day.slots.splice(insertAt, 0, [lesson]);
        if (day.times.length > 12) fail("В расписании не может быть больше 12 занятий в день");
        for (let i = 1; i < day.times.length; i += 1) {
          const gap = day.times[i]!.start - (day.times[i - 1]!.start + day.times[i - 1]!.duration);
          if (gap < 0 || gap > 240)
            fail(`Группа «${group.name}»: мероприятие пересекается с соседними занятиями или слишком далеко от них`);
        }
        syncDayTiming(day);
      } else {
        const exact = hit.length === 1 ? hit[0] : undefined;
        if (exact === undefined || day.times[exact].start !== input.start || input.duration >= day.times[exact].duration)
          return fail(`Группа «${group.name}»: мероприятие должно начинаться с начала одного урока и быть короче него`);
        const originalLessons = day.slots[exact];
        if (originalLessons.some((item) => item.subjectId === "event")) {
          fail(`Группа «${group.name}»: в этот урок нельзя включить мероприятие`);
        }
        assertJointGroupsSelected(base, originalLessons, selectedSet, catalog, input.date, input.start, input.duration, true);
        const remainder = day.times[exact].duration - input.duration;
        lesson.eventRemainder = {
          date: input.date,
          lessonIds: originalLessons.map((item) => item.id),
          originalStart: day.times[exact]!.start,
          originalDuration: day.times[exact]!.duration,
          eventDuration: input.duration,
        } satisfies EventRemainder;
        day.times[exact] = { start: input.start, duration: input.duration };
        day.slots[exact] = [lesson];
        day.times.splice(exact + 1, 0, { start: input.start + input.duration, duration: remainder });
        day.slots.splice(exact + 1, 0, originalLessons);
        if (day.times.length > 12) fail("В расписании не может быть больше 12 занятий в день");
        syncDayTiming(day);
      }
    } else {
      let slot: number;
      try {
        slot = chooseSlot(day, input.start, input.duration, preferred);
      } catch (error) {
        return fail(`Группа «${group.name}»: ${error instanceof Error ? error.message : "не удалось подобрать время"}`);
      }
      day.times[slot] = { start: input.start, duration: input.duration };
      syncDayTiming(day);
      day.slots[slot].push(lesson);
    }
  }

  const conflictBase = replacedLessonIds.size ? withoutIds(schedule, replacedLessonIds) : schedule;
  const conflict = newRoomConflict(result, conflictBase);
  if (conflict) fail(roomConflictMessage(conflict, catalog));
  const teacherConflict = newTeacherConflict(result, conflictBase);
  if (teacherConflict) fail(teacherConflictMessage(teacherConflict, catalog));
  const suitabilityViolation = newRoomSuitabilityViolation(result, schedule, catalog);
  if (suitabilityViolation) {
    const message = roomSuitabilityViolationMessage(suitabilityViolation, catalog);
    fail(suitabilityViolation.capacityViolation ? `${message}; проверьте число учеников выбранных групп` : message);
  }
  const unavailable = newUnavailabilityViolation(result, schedule, catalog);
  if (unavailable) fail(unavailabilityViolationMessage(unavailable, catalog));
  return result;
}

export function removeServiceEvent(schedule: Schedule, lessonId: string, catalog?: Catalog): Schedule {
  const lessons = linkedLessons(schedule, lessonId);
  return withoutEventLessons(schedule, lessons, catalog);
}
