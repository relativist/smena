import { createId } from "../shared/createId.ts";
import { newUnavailabilityViolation, unavailabilityViolationMessage } from "../shared/unavailability.ts";
import { getWeek, groups, subjects, type Day, type Lesson } from "./demo.ts";
import type { Catalog } from "../shared/catalog.ts";
import { restoreEventRemainder } from "../shared/eventRemainders.ts";
import {
  newRoomSuitabilityViolation,
  roomSuitabilityViolationMessage,
} from "../shared/roomSuitability.ts";
import { bellBreak, DEFAULT_BELL_PROFILE, type BellProfile } from "../shared/bellSchedule.ts";
import {
  findRoomConflict,
  newRoomConflict,
  roomConflictMessage,
  type RoomOccupancy,
} from "../shared/roomConflicts.ts";
import {
  findTeacherConflicts,
  newTeacherConflict,
  teacherConflictMessage,
  type TeacherConflict,
} from "../shared/teacherConflicts.ts";

export type EditorLesson = Lesson & { id: string; note?: string; jointId?: string; eventRemainder?: import("../shared/eventRemainders.ts").EventRemainder };
type SlotTime = { start: number; duration: number };
export type EditorDay = Omit<Day, "slots"> & {
  slots: EditorLesson[][];
  times: { start: number; duration: number }[];
  bellProfile?: BellProfile;
};
export type Schedule = Record<string, EditorDay[]>;
export type Location = {
  groupId: string;
  weekOffset: number;
  date: string;
  slot: number;
};

const DEFAULT_BREAK = 10;

/** Flatten stored lessons for room-conflict previews across all groups. */
export function roomOccupancies(schedule: Schedule, date?: string): RoomOccupancy[] {
  const result: RoomOccupancy[] = [];
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    for (const day of days) {
      if (date !== undefined && day.date !== date) continue;
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          result.push({
            lessonId: lesson.id,
            groupId,
            date: day.date,
            roomId: lesson.roomId,
            start: time.start,
            end: time.start + time.duration,
            jointId: lesson.jointId,
            subjectId: lesson.subjectId,
            teacherId: lesson.teacherId,
            event: lesson.event,
            lessonKind: lesson.lessonKind,
          });
        }
      });
    }
  }
  return result;
}

/** Teacher collisions at a proposed lesson interval, including collisions without a room. */
export function teacherPlacementConflicts(
  schedule: Schedule,
  location: Location,
  lesson: Lesson,
  ignoreId?: string,
): TeacherConflict[] {
  if (!lesson.teacherId) return [];
  const day = schedule[key(location.groupId, location.weekOffset)]?.find(
    (entry) => entry.date === location.date,
  );
  const time = day?.times[location.slot];
  if (!time) return [];
  const candidate: RoomOccupancy = {
    lessonId: ignoreId ?? ("id" in lesson && typeof lesson.id === "string" ? lesson.id : "__teacher-placement-preview__"),
    groupId: location.groupId,
    date: location.date,
    roomId: lesson.roomId,
    start: time.start,
    end: time.start + time.duration,
    jointId: lesson.jointId,
    subjectId: lesson.subjectId,
    teacherId: lesson.teacherId,
    event: lesson.event,
    lessonKind: lesson.lessonKind,
  };
  return findTeacherConflicts(roomOccupancies(schedule), candidate, ignoreId);
}

export function key(groupId: string, weekOffset: number): string {
  return `${groupId}:${weekOffset}`;
}

export function parseTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : Number.NaN;
}

export function formatTime(minutes: number): string {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes === 1440) return "24:00";
  const total = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function timeLabel(day: EditorDay, index: number): string {
  const time = day.times[index];
  return time
    ? `${formatTime(time.start)}–${formatTime(time.start + time.duration)}`
    : "";
}

function fail(message: string): never {
  throw new Error(message);
}

function makeDay(day: Day, groupId: string, weekOffset: number): EditorDay {
  let start = parseTime(day.start);
  if (!Number.isFinite(start)) start = 0;
  const times = day.slots.map((_, index) => {
    const entry = { start, duration: day.duration };
    start += day.duration + (day.breaks[index] ?? DEFAULT_BREAK);
    return entry;
  });
  return {
    ...day,
    breaks: [...day.breaks],
    slots: day.slots.map((slot, slotIndex) =>
      slot.map((lesson, lessonIndex) => ({
        ...lesson,
        id: `${groupId}-${weekOffset}-${day.date}-${slotIndex}-${lessonIndex}`,
      })),
    ),
    times,
  };
}

export function createSchedule(): Schedule {
  const result: Schedule = {};
  for (const group of groups) {
    for (let weekOffset = 0; weekOffset < 4; weekOffset += 1) {
      result[key(group.id, weekOffset)] = getWeek(group.id, weekOffset).map(
        (day) => makeDay(day, group.id, weekOffset),
      );
    }
  }
  return result;
}

function locate(
  schedule: Schedule,
  location: Location,
): { day: EditorDay; days: EditorDay[]; index: number } {
  const days = schedule[key(location.groupId, location.weekOffset)];
  if (!days) fail("Не найдена группа или неделя расписания");
  const index = days.findIndex((day) => day.date === location.date);
  if (index < 0) fail("Не найден день расписания");
  const day = days[index];
  if (
    !Number.isInteger(location.slot) ||
    location.slot < 0 ||
    location.slot >= day.slots.length
  )
    fail("Урока с таким номером нет в этот день");
  return { day, days, index };
}

function locationError(
  schedule: Schedule,
  location: Location,
  lesson: Lesson,
  ignoreId?: string,
  catalog?: Catalog,
  allowArchivedReferences = false,
): string | null {
  const days = schedule[key(location.groupId, location.weekOffset)];
  if (!days) return "Не найдена группа или неделя расписания";
  const day = days.find((entry) => entry.date === location.date);
  if (!day) return "Не найден день расписания";
  if (
    !Number.isInteger(location.slot) ||
    location.slot < 0 ||
    location.slot >= day.slots.length
  )
    return "Урока с таким номером нет в этот день";
  if (day.holiday) return "В этот день каникулы";
  if (lesson.event || lesson.subjectId === "event")
    return "Общее мероприятие нельзя добавить из списка предметов";
  if (catalog) {
    const subject = catalog.subjects.find(
      (entry) => entry.id === lesson.subjectId,
    );
    if (!subject || (subject.archived && !allowArchivedReferences))
      return "Выберите действующий предмет";
    const group = catalog.groups.find((entry) => entry.id === location.groupId);
    if (!group || (group.archived && !allowArchivedReferences))
      return "Не найдена действующая группа";
    if (lesson.subgroupId) {
      const subgroup = catalog.subgroups.find(
        (entry) => entry.id === lesson.subgroupId,
      );
      if (
        !subgroup ||
        subgroup.groupId !== location.groupId ||
        (subgroup.archived && !allowArchivedReferences)
      )
        return "Подгруппа не относится к выбранной группе";
    } else if (lesson.subgroup) {
      return "Выберите подгруппу из справочника";
    }
    if (!lesson.event) {
      const teacher = catalog.teachers.find(
        (entry) => entry.id === lesson.teacherId,
      );
      const room = catalog.rooms.find((entry) => entry.id === lesson.roomId);
      if (!teacher || (teacher.archived && !allowArchivedReferences))
        return "Выберите действующего преподавателя";
      if (
        !allowArchivedReferences &&
        !teacher.subjectIds.includes(lesson.subjectId)
      )
        return "Этот предмет не указан у преподавателя в справочнике";
      if (!room || (room.archived && !allowArchivedReferences))
        return "Выберите действующий кабинет";
    }
  } else {
    const subject = subjects.find((entry) => entry.id === lesson.subjectId);
    if (!subject) return "Выберите существующий предмет";
    const group = groups.find((entry) => entry.id === location.groupId);
    if (!group) return "Не найдена группа";
    if (lesson.subgroup && !lesson.subgroup.startsWith(`${group.name}/`))
      return "Подгруппа не относится к выбранной группе";
  }
  for (const current of day.slots[location.slot]) {
    if (current.id === ignoreId) continue;
    if (!lesson.subgroup || !current.subgroup)
      return "В этой ячейке уже есть занятие всей группы или без подгруппы";
    if (
      catalog && current.subgroupId && lesson.subgroupId
        ? current.subgroupId === lesson.subgroupId
        : current.subgroup === lesson.subgroup
    )
      return "Эта подгруппа уже занята в ячейке";
  }
  if (catalog && lesson.roomId) {
    const time = day.times[location.slot];
    const conflict = findRoomConflict(
      roomOccupancies(schedule),
      {
        lessonId: ignoreId ?? "__placement-preview__",
        groupId: location.groupId,
        date: location.date,
        roomId: lesson.roomId,
        start: time.start,
        end: time.start + time.duration,
        jointId: lesson.jointId,
        subjectId: lesson.subjectId,
        teacherId: lesson.teacherId,
        event: lesson.event,
        lessonKind: lesson.lessonKind,
      },
      ignoreId,
    );
    if (conflict) return roomConflictMessage(conflict, catalog);
  }
  if (catalog && lesson.teacherId) {
    const conflict = teacherPlacementConflicts(schedule, location, lesson, ignoreId)[0];
    if (conflict) return teacherConflictMessage(conflict, catalog);
  }
  return null;
}

export function canPlace(
  schedule: Schedule,
  location: Location,
  lesson: Lesson,
  ignoreId?: string,
  catalog?: Catalog,
): string | null {
  const error = locationError(
    schedule,
    location,
    lesson,
    ignoreId,
    catalog,
    Boolean(ignoreId),
  );
  if (error) return error;
  if (catalog) {
    const candidate: EditorLesson = {
      ...lesson,
      id: ignoreId ?? "__placement-preview__",
    };
    const proposed = updateDay(schedule, location, (day) => {
      day.slots[location.slot] = day.slots[location.slot].filter(
        (entry) => entry.id !== ignoreId,
      );
      day.slots[location.slot].push(candidate);
      return day;
    });
    return resourceConstraintError(proposed, schedule, catalog);
  }
  return null;
}

function cloneDay(day: EditorDay): EditorDay {
  return {
    ...day,
    breaks: [...day.breaks],
    times: day.times.map((time) => ({ ...time })),
    slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson }))),
  };
}

function updateDay(
  schedule: Schedule,
  location: Location,
  transform: (day: EditorDay) => EditorDay,
): Schedule {
  const { days, index, day } = locate(schedule, location);
  const nextDays = [...days];
  nextDays[index] = transform(cloneDay(day));
  return {
    ...schedule,
    [key(location.groupId, location.weekOffset)]: nextDays,
  };
}

function resourceConstraintError(
  next: Schedule,
  previous: Schedule,
  catalog?: Catalog,
): string | null {
  if (!catalog) return null;
  const violation = newRoomSuitabilityViolation(next, previous, catalog);
  if (violation) return roomSuitabilityViolationMessage(violation, catalog);
  const unavailable = newUnavailabilityViolation(next, previous, catalog);
  return unavailable ? unavailabilityViolationMessage(unavailable, catalog) : null;
}

function assertResourceConstraints(next: Schedule, previous: Schedule, catalog?: Catalog): void {
  const error = resourceConstraintError(next, previous, catalog);
  if (error) fail(error);
}

function validateTimes(day: EditorDay): void {
  for (let i = 0; i < day.times.length; i += 1) {
    const { start, duration } = day.times[i];
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(duration) ||
      start < 0 ||
      duration <= 0 ||
      start + duration > 1440
    )
      fail(
        "Время урока должно быть в пределах дня, длительность — больше нуля",
      );
    if (i > 0 && day.times[i - 1].start + day.times[i - 1].duration > start)
      fail("Время уроков пересекается");
  }
  syncDayTiming(day);
}

function syncDayTiming(day: EditorDay): void {
  if (day.times.length) day.start = formatTime(day.times[0].start);
  day.breaks = day.times
    .slice(0, -1)
    .map(
      (time, index) =>
        day.times[index + 1].start - (time.start + time.duration),
    );
}

function findLesson(
  schedule: Schedule,
  location: Location,
  id: string,
): EditorLesson {
  const { day } = locate(schedule, location);
  const lesson = day.slots[location.slot].find((item) => item.id === id);
  if (!lesson) fail("Занятие уже перемещено или удалено");
  return lesson;
}

export function placeLesson(
  schedule: Schedule,
  location: Location,
  lesson: Omit<EditorLesson, "id">,
  catalog?: Catalog,
): Schedule {
  const error = locationError(schedule, location, lesson, undefined, catalog);
  if (error) fail(error);
  const id = createId();
  const next = updateDay(schedule, location, (day) => {
    day.slots[location.slot].push({ ...lesson, id });
    return day;
  });
  assertResourceConstraints(next, schedule, catalog);
  return next;
}

export function moveLesson(
  schedule: Schedule,
  from: Location,
  id: string,
  to: Location,
  catalog?: Catalog,
): Schedule {
  if (from.groupId !== to.groupId)
    fail("Нельзя переносить занятие в другую группу");
  if (
    from.date === to.date &&
    from.groupId === to.groupId &&
    from.weekOffset === to.weekOffset &&
    from.slot === to.slot
  )
    return schedule;
  const lesson = findLesson(schedule, from, id);
  // Existing archived references remain movable; validation still checks that
  // every stored ID belongs to the destination group's current catalog.
  const error = locationError(schedule, to, lesson, id, catalog, true);
  if (error) fail(error);
  // Validate destination first. No intermediate schedule is exposed if anything fails.
  const removed = updateDay(schedule, from, (day) => {
    day.slots[from.slot] = day.slots[from.slot].filter(
      (item) => item.id !== id,
    );
    return day;
  });
  const next = updateDay(removed, to, (day) => {
    day.slots[to.slot].push({ ...lesson });
    return day;
  });
  assertResourceConstraints(next, schedule, catalog);
  return next;
}

function swapError(
  schedule: Schedule,
  from: Location,
  sourceId: string,
  to: Location,
  catalog: Catalog,
): string | null {
  if (from.groupId !== to.groupId)
    return "Можно обменивать уроки только внутри одной группы";
  let source: EditorLesson;
  let destination: EditorLesson;
  try {
    source = findLesson(schedule, from, sourceId);
    const sourceSlot = locate(schedule, from).day.slots[from.slot];
    const { day } = locate(schedule, to);
    if (sourceSlot.length !== 1)
      return "Для обмена в ячейке должен быть ровно один урок";
    if (from.groupId === to.groupId && from.weekOffset === to.weekOffset && from.date === to.date && from.slot === to.slot)
      return null;
    const targetSlot = day.slots[to.slot];
    if (targetSlot.length !== 1)
      return "Для обмена в ячейке должен быть ровно один урок";
    destination = targetSlot[0];
  } catch (error) {
    return error instanceof Error ? error.message : "Не удалось найти уроки для обмена";
  }

  const isOrdinaryWholeGroupLesson = (lesson: EditorLesson) =>
    !lesson.subgroup && !lesson.subgroupId && !lesson.event &&
    lesson.subjectId !== "event" && !lesson.jointId;
  if (!isOrdinaryWholeGroupLesson(source) || !isOrdinaryWholeGroupLesson(destination))
    return "Обменивать можно только обычные уроки всей группы";

  // Remove both lessons before validating either destination. This makes the
  // two old teacher/room intervals available to each other during the swap.
  let vacant: Schedule;
  try {
    vacant = updateDay(schedule, from, (day) => {
      day.slots[from.slot] = day.slots[from.slot].filter((item) => item.id !== sourceId);
      return day;
    });
    vacant = updateDay(vacant, to, (day) => {
      day.slots[to.slot] = day.slots[to.slot].filter((item) => item.id !== destination.id);
      return day;
    });
  } catch (error) {
    return error instanceof Error ? error.message : "Не удалось подготовить обмен";
  }

  // Archived references already present in the schedule remain valid, matching moveLesson.
  const sourceError = locationError(vacant, to, source, undefined, catalog, true);
  if (sourceError) return sourceError;
  const destinationError = locationError(vacant, from, destination, undefined, catalog, true);
  if (destinationError) return destinationError;
  let proposed = updateDay(vacant, to, (day) => {
    day.slots[to.slot].push({ ...source });
    return day;
  });
  proposed = updateDay(proposed, from, (day) => {
    day.slots[from.slot].push({ ...destination });
    return day;
  });
  const suitabilityError = resourceConstraintError(proposed, schedule, catalog);
  if (suitabilityError) return suitabilityError;
  return null;
}

/** Returns a validation message when these two ordinary lessons cannot swap. */
export function canSwapLessons(
  schedule: Schedule,
  from: Location,
  sourceId: string,
  to: Location,
  catalog: Catalog,
): string | null {
  return swapError(schedule, from, sourceId, to, catalog);
}

/** Atomically swaps two ordinary whole-group lessons while preserving slot times. */
export function swapLessons(
  schedule: Schedule,
  from: Location,
  sourceId: string,
  to: Location,
  catalog: Catalog,
): Schedule {
  const error = swapError(schedule, from, sourceId, to, catalog);
  if (error) fail(error);
  if (from.groupId === to.groupId && from.weekOffset === to.weekOffset && from.date === to.date && from.slot === to.slot)
    return schedule;

  const source = findLesson(schedule, from, sourceId);
  const destination = locate(schedule, to).day.slots[to.slot][0];
  let next = updateDay(schedule, from, (day) => {
    day.slots[from.slot] = day.slots[from.slot].filter((item) => item.id !== sourceId);
    return day;
  });
  next = updateDay(next, to, (day) => {
    day.slots[to.slot] = day.slots[to.slot].filter((item) => item.id !== destination.id);
    day.slots[to.slot].push({ ...source });
    return day;
  });
  return updateDay(next, from, (day) => {
    day.slots[from.slot].push({ ...destination });
    return day;
  });
}

/**
 * Places or moves a teacher's lesson, removing conflicting ordinary lessons
 * from other groups only after the complete destination has been validated.
 */
export function transferTeacherLesson(
  schedule: Schedule,
  location: Location,
  lesson: Omit<EditorLesson, "id">,
  catalog: Catalog,
  from?: { location: Location; id: string },
): Schedule {
  if (lesson.event || lesson.subjectId === "event" || lesson.jointId)
    fail("Нельзя переносить мероприятие или совместное занятие как обычный урок");
  let source: EditorLesson | undefined;
  if (from) {
    if (from.location.groupId !== location.groupId)
      fail("Нельзя переносить занятие в другую группу");
    source = findLesson(schedule, from.location, from.id);
    if (source.event || source.subjectId === "event" || source.jointId)
      fail("Нельзя переносить мероприятие или совместное занятие как обычный урок");
  }

  const id = from?.id ?? createId();
  const candidate: EditorLesson = { ...(source ?? lesson), id };
  const conflicts = teacherPlacementConflicts(schedule, location, candidate, from?.id);
  for (const conflict of conflicts) {
    const occupied = conflict.b;
    if (occupied.event || occupied.jointId)
      fail(`${teacherConflictMessage(conflict, catalog)} Общее занятие или мероприятие нельзя удалить таким переносом.`);
    if (occupied.groupId === location.groupId)
      fail(`${teacherConflictMessage(conflict, catalog)} Внутри этой группы используйте перемещение существующего урока.`);
  }

  const removedIds = new Set(conflicts.map((conflict) => conflict.b.lessonId));
  if (from) removedIds.add(from.id);
  let next = schedule;
  if (removedIds.size) {
    next = { ...schedule };
    for (const [scheduleKey, days] of Object.entries(schedule)) {
      let changed = false;
      const nextDays = days.map((day) => {
        let dayChanged = false;
        const slots = day.slots.map((slot) => {
          const filtered = slot.filter((entry) => !removedIds.has(entry.id));
          dayChanged ||= filtered.length !== slot.length;
          return dayChanged ? filtered : slot;
        });
        changed ||= dayChanged;
        return dayChanged ? { ...cloneDay(day), slots } : day;
      });
      if (changed) next[scheduleKey] = nextDays;
    }
  }

  const error = locationError(next, location, candidate, undefined, catalog, Boolean(from));
  if (error) fail(error);
  const time = locate(next, location).day.times[location.slot];
  if (!time || !Number.isFinite(time.start) || !Number.isFinite(time.duration) || time.duration <= 0)
    fail("Не задано корректное время урока");
  next = updateDay(next, location, (day) => {
    day.slots[location.slot].push(candidate);
    return day;
  });
  assertResourceConstraints(next, schedule, catalog);
  return next;
}

export function removeLesson(
  schedule: Schedule,
  location: Location,
  id: string,
  catalog?: Catalog,
): Schedule {
  const original = findLesson(schedule, location, id);
  if (original.subjectId === "event" && original.eventRemainder) {
    const restored = restoreEventRemainder(schedule, original);
    if (!restored) fail("Не удалось восстановить урок: время мероприятия или оставшаяся часть урока изменились");
    if (catalog) {
      const roomConflict = newRoomConflict(restored, schedule);
      if (roomConflict) fail(roomConflictMessage(roomConflict, catalog));
      const teacherConflict = newTeacherConflict(restored, schedule);
      if (teacherConflict) fail(teacherConflictMessage(teacherConflict, catalog));
    }
    assertResourceConstraints(restored, schedule, catalog);
    return restored;
  }
  const remainingJoint = original.jointId
    ? Object.values(schedule).flat().flatMap((day) => day.slots.flat())
        .filter((lesson) => lesson.id !== id && lesson.jointId === original.jointId)
    : [];
  const singletonId = remainingJoint.length === 1 ? remainingJoint[0].id : undefined;
  const next: Schedule = { ...schedule };
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    let changed = false;
    const nextDays = days.map((day) => {
      let dayChanged = false;
      const slots = day.slots.map((slot) => {
        return slot.flatMap((lesson) => {
          if (lesson.id === id) { dayChanged = true; return []; }
          if (lesson.id === singletonId) {
            dayChanged = true;
            const detached = { ...lesson };
            delete detached.jointId;
            return [detached];
          }
          return [lesson];
        });
      });
      changed ||= dayChanged;
      return dayChanged ? { ...cloneDay(day), slots } : day;
    });
    if (changed) next[scheduleKey] = nextDays;
  }
  return next;
}

function hasJointLesson(day: EditorDay, slots: number[], exceptJointId?: string): boolean {
  return slots.some((slotIndex) =>
    day.slots[slotIndex]?.some(
      (lesson) => lesson.jointId && lesson.jointId !== exceptJointId,
    ),
  );
}

function setSlotTimeInternal(
  schedule: Schedule,
  location: Location,
  start: number,
  duration: number,
  shiftFollowing: boolean,
  allowedJointId?: string,
): Schedule {
  const { day } = locate(schedule, location);
  const current = day.times[location.slot];
  const delta = start - current.start;
  const affectedSlots = [
    ...(start !== current.start || duration !== current.duration
      ? [location.slot]
      : []),
    ...(shiftFollowing && delta !== 0
      ? Array.from(
          { length: day.times.length - location.slot - 1 },
          (_, index) => location.slot + index + 1,
        )
      : []),
  ];
  if (hasJointLesson(day, affectedSlots, allowedJointId))
    fail("Сдвиг затрагивает общее занятие; измените его время через редактор общего занятия");
  return updateDay(schedule, location, (day) => {
    day.times[location.slot] = { start, duration };
    if (shiftFollowing)
      for (let i = location.slot + 1; i < day.times.length; i += 1)
        day.times[i].start += delta;
    validateTimes(day);
    return day;
  });
}

export function setSlotTime(
  schedule: Schedule,
  location: Location,
  start: number,
  duration: number,
  shiftFollowing: boolean,
): Schedule {
  return setSlotTimeInternal(schedule, location, start, duration, shiftFollowing);
}

/** Builds the complete daily grid using a common duration and explicit breaks. */
export function dayTimeGrid(start: number, duration: number, breaks: number[], count: number): SlotTime[] {
  if (!Number.isInteger(start) || start < 0 || start > 1439)
    fail("Укажите начало дня в формате ЧЧ:ММ от 00:00 до 23:59");
  if (!Number.isInteger(duration) || duration < 1 || duration > 180)
    fail("Длительность урока должна быть целым числом от 1 до 180 минут");
  const times: SlotTime[] = [];
  let nextStart = start;
  for (let index = 0; index < count; index += 1) {
    if (nextStart + duration > 1440) fail("Уроки выходят за пределы дня");
    times.push({ start: nextStart, duration });
    if (index + 1 < count) {
      const gap = breaks[index];
      if (!Number.isInteger(gap) || gap < 0 || gap > 240)
        fail("Длительность перемены должна быть целым числом от 0 до 240 минут");
      nextStart += duration + gap;
    }
  }
  return times;
}

export function setDayTime(
  schedule: Schedule,
  location: Location,
  start: number,
  duration: number,
  breaks: number[],
): Schedule {
  const { day } = locate(schedule, location);
  const times = dayTimeGrid(start, duration, breaks, day.times.length);
  const changedSlots = times.flatMap((time, index) =>
    time.start !== day.times[index].start || time.duration !== day.times[index].duration ? [index] : [],
  );
  if (hasJointLesson(day, changedSlots))
    fail("Изменение дня затрагивает общее занятие; измените его время через редактор общего занятия");
  return updateDay(schedule, location, (copy) => {
    copy.times = times;
    copy.duration = duration;
    validateTimes(copy);
    return copy;
  });
}

export function uniformDayBreak(day: EditorDay, profile: BellProfile): number | undefined {
  return day.breaks.length > 0 && day.breaks.every((gap) => gap === day.breaks[0]) &&
    day.breaks.some((gap, index) => gap !== bellBreak(profile, index))
    ? day.breaks[0] : undefined;
}

export function editLesson(
  schedule: Schedule,
  location: Location,
  id: string,
  patch: {
    teacher: string;
    room: string;
    note: string;
    teacherId?: string;
    roomId?: string;
  },
  timing?: { start: number; duration: number; shiftFollowing: boolean },
  catalog?: Catalog,
): Schedule {
  const original = findLesson(schedule, location, id);
  if (!original.event && !patch.teacher.trim()) fail("Укажите преподавателя");
  if (!patch.room.trim()) fail("Укажите кабинет");
  const occurrences: Location[] = original.jointId
    ? Object.entries(schedule).flatMap(([scheduleKey, days]) => {
        const split = scheduleKey.lastIndexOf(":");
        const groupId = scheduleKey.slice(0, split);
        const weekOffset = Number(scheduleKey.slice(split + 1));
        return days.flatMap((day) => day.slots.flatMap((slot, slotIndex) =>
          slot.some((lesson) => lesson.jointId === original.jointId)
            ? [{ groupId, weekOffset, date: day.date, slot: slotIndex }]
            : [],
        ));
      })
    : [location];
  if (occurrences.length > 1) {
    const first = locate(schedule, occurrences[0]);
    const baseline = first.day.times[occurrences[0].slot];
    if (occurrences.some((entry) => {
      const found = locate(schedule, entry);
      const time = found.day.times[entry.slot];
      return found.day.date !== first.day.date || time.start !== baseline.start || time.duration !== baseline.duration;
    })) fail("Общее занятие уже имеет разные времена; сначала исправьте расписание");
  }
  let next = schedule;
  for (const entry of occurrences) {
    const lesson = findLesson(next, entry, entry === location ? id :
      locate(next, entry).day.slots[entry.slot].find((item) => item.jointId === original.jointId)!.id);
    if (timing)
      next = setSlotTimeInternal(next, entry, timing.start, timing.duration, timing.shiftFollowing, original.jointId);
    next = updateDay(next, entry, (day) => {
      const current = day.slots[entry.slot].find((item) => item.id === lesson.id);
      if (!current) fail("Занятие уже перемещено или удалено");
      Object.assign(current, patch);
      if (!patch.note) delete current.note;
      return day;
    });
  }
  if (original.jointId && catalog) {
    const beforeOccupancies = roomOccupancies(schedule);
    const afterOccupancies = roomOccupancies(next);
    for (const entry of occurrences) {
      const current = findLesson(next, entry, locate(next, entry).day.slots[entry.slot].find((item) => item.jointId === original.jointId)!.id);
      const error = locationError(next, entry, current, current.id, catalog, true);
      if (error) fail(error);
    }
    for (const current of afterOccupancies.filter((entry) => entry.jointId === original.jointId)) {
      const conflict = findRoomConflict(afterOccupancies, current, current.lessonId);
      if (conflict) fail(roomConflictMessage(conflict, catalog));
      if (!current.teacherId) continue;
      for (const [scheduleKey, days] of Object.entries(next)) {
        const split = scheduleKey.lastIndexOf(":");
        const groupId = scheduleKey.slice(0, split);
        for (const day of days) day.slots.forEach((slot, slotIndex) => slot.forEach((peer) => {
          if (!peer.teacherId || peer.teacherId !== current.teacherId || peer.jointId === original.jointId || day.date !== current.date) return;
          const peerTime = day.times[slotIndex];
          if (!peerTime) return;
          const peerAfter = { lessonId: peer.id, groupId, date: day.date, roomId: peer.roomId, start: peerTime.start, end: peerTime.start + peerTime.duration };
          const overlapStart = Math.max(current.start, peerAfter.start);
          const overlapEnd = Math.min(current.end, peerAfter.end);
          if (overlapStart >= overlapEnd) return;
          const previous = beforeOccupancies.find((item) => item.lessonId === current.lessonId);
          const oldPeer = beforeOccupancies.find((item) => item.lessonId === peer.id);
          const samePriorTeacher = previous?.teacherId === current.teacherId && oldPeer?.teacherId === current.teacherId;
          const priorStart = samePriorTeacher && previous && oldPeer ? Math.max(previous.start, oldPeer.start) : Infinity;
          const priorEnd = samePriorTeacher && previous && oldPeer ? Math.min(previous.end, oldPeer.end) : -Infinity;
          if (overlapStart < priorStart || overlapEnd > priorEnd)
            fail(`Преподаватель уже занят группой «${catalog.groups.find((group) => group.id === groupId)?.name ?? groupId}» в это время`);
        }));
      }
    }
  }
  assertResourceConstraints(next, schedule, catalog);
  return next;
}

export function setBreak(
  schedule: Schedule,
  location: Location,
  minutes: number,
): Schedule {
  const { day: originalDay } = locate(schedule, location);
  const currentGap = originalDay.times[location.slot + 1]?.start -
    (originalDay.times[location.slot].start + originalDay.times[location.slot].duration);
  if (minutes !== currentGap && hasJointLesson(
    originalDay,
    Array.from(
      { length: Math.max(0, originalDay.times.length - location.slot - 1) },
      (_, index) => location.slot + index + 1,
    ),
  ))
    fail("Перемена затронет общее занятие; измените его время через редактор общего занятия");
  return updateDay(schedule, location, (day) => {
    if (!Number.isInteger(minutes) || minutes < 0)
      fail("Перемена не может быть отрицательной");
    if (location.slot >= day.times.length - 1)
      fail("После последнего урока перемены нет");
    const currentGap =
      day.times[location.slot + 1].start -
      (day.times[location.slot].start + day.times[location.slot].duration);
    const delta = minutes - currentGap;
    for (let i = location.slot + 1; i < day.times.length; i += 1)
      day.times[i].start += delta;
    validateTimes(day);
    return day;
  });
}

export function appendSlot(schedule: Schedule, location: Location, profile?: BellProfile): Schedule {
  const days = schedule[key(location.groupId, location.weekOffset)];
  const day = days?.find((entry) => entry.date === location.date);
  if (!day) fail("Не найден день расписания");
  if (day.holiday) fail("В этот день каникулы");
  if (day.slots.at(-1)?.length === 0)
    fail("В конце дня уже есть пустая ячейка — сначала заполните её");
  if (day.slots.length >= 12) fail("В день можно добавить не больше 12 ячеек");
  const effectiveProfile = profile ?? day.bellProfile ?? DEFAULT_BELL_PROFILE;
  const previous = day.times.at(-1);
  const gap = uniformDayBreak(day, effectiveProfile) ?? bellBreak(effectiveProfile, day.times.length - 1);
  const start = previous
    ? previous.start + previous.duration + gap
    : parseTime(day.start);
  const duration = day.duration !== (day.bellProfile ?? DEFAULT_BELL_PROFILE).duration
    ? day.duration
    : effectiveProfile.duration;
  const copy = cloneDay(day);
  copy.slots.push([]);
  copy.times.push({ start, duration });
  validateTimes(copy);
  return {
    ...schedule,
    [key(location.groupId, location.weekOffset)]: days.map(entry => entry === day ? copy : entry),
  };
}

export function removeEmptySlot(schedule: Schedule, location: Location): Schedule {
  const { day } = locate(schedule, location);
  if (day.holiday) fail("В этот день каникулы");
  if (location.slot !== day.slots.length - 1)
    fail("Можно удалить только последнюю пустую ячейку дня");
  if (day.slots[location.slot].length)
    fail("Сначала удалите или перенесите занятие из ячейки");
  return updateDay(schedule, location, copy => {
    copy.slots.pop();
    copy.times.pop();
    validateTimes(copy);
    return copy;
  });
}
