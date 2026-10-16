import { newUnavailabilityViolation, unavailabilityViolationMessage } from "./unavailability.ts";
import type { Catalog } from "./catalog.ts";
import { bellBreak, type BellProfile } from "./bellSchedule.ts";
import { newRoomConflict, roomConflictMessage } from "./roomConflicts.ts";
import { newTeacherConflict, teacherConflictMessage } from "./teacherConflicts.ts";
import { dayTimeGrid, formatTime, type EditorDay, type Schedule } from "../src/editor.ts";

export type DayTimingOptions = {
  date: string;
  groupIds: string[];
  currentGroupId: string;
  start: number;
  duration: number;
  uniformBreak?: number;
  schoolProfile: BellProfile;
};

export type DayTimingPreview = {
  schedule: Schedule;
  changedDays: Array<{
    groupId: string;
    date: string;
    before: EditorDay["times"];
    after: EditorDay["times"];
    lessonCount: number;
  }>;
  skippedGroups: Array<{ groupId: string; reason: string }>;
  conflict?: string;
  undoConflict?: string;
};

const fail = (message: string): never => { throw new Error(message); };
const integer = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number.isFinite(value) && (value as number) >= min && (value as number) <= max;
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const groupOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
const timeCopy = (times: EditorDay["times"]): EditorDay["times"] => times.map((time) => ({ ...time }));

/** Previews a one-day timing change across groups, including conflicts. */
export function previewDayTiming(schedule: Schedule, options: DayTimingOptions, catalog: Catalog): DayTimingPreview {
  if (!options || typeof options !== "object") fail("Укажите параметры изменения времени уроков");
  if (!validDate(options.date)) fail("Укажите корректную дату");
  if (!Array.isArray(options.groupIds) || !options.groupIds.length ||
    options.groupIds.some((id) => typeof id !== "string") || new Set(options.groupIds).size !== options.groupIds.length)
    fail("Выберите одну или несколько групп без повторов");
  if (options.groupIds.includes(options.currentGroupId) && !integer(options.start, 0, 1439))
    fail("Начало учебного дня должно быть от 00:00 до 23:59");
  if (!integer(options.duration, 1, 180)) fail("Длительность урока должна быть целым числом от 1 до 180 минут");
  if (options.uniformBreak !== undefined && !integer(options.uniformBreak, 0, 240))
    fail("Длительность перемены должна быть целым числом от 0 до 240 минут");
  if (!options.schoolProfile || !Array.isArray(options.schoolProfile.breaks) || !options.schoolProfile.breaks.length ||
    options.schoolProfile.breaks.some((gap) => !integer(gap, 0, 240)))
    fail("Общие настройки перемен заполнены некорректно");
  if (!catalog || !Array.isArray(catalog.groups)) fail("Справочник групп недоступен");
  for (const id of options.groupIds) {
    const group = catalog.groups.find((entry) => entry.id === id);
    if (!group || group.archived) fail(`Группа «${id}» не найдена или архивирована`);
  }

  const next: Schedule = Object.fromEntries(Object.entries(schedule).map(([key, days]) => [key,
    days.map((day) => ({
      ...day,
      breaks: [...day.breaks],
      times: timeCopy(day.times),
      slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson }))),
      ...(day.bellProfile ? { bellProfile: { ...day.bellProfile, breaks: [...day.bellProfile.breaks] } } : {}),
    })),
  ]));
  const changedDays: DayTimingPreview["changedDays"] = [];
  const skippedGroups: DayTimingPreview["skippedGroups"] = [];

  for (const groupId of options.groupIds) {
    const days = Object.entries(next).filter(([key]) => groupOf(key) === groupId).flatMap(([, entries]) => entries);
    const matchingDays = days.filter((entry) => entry.date === options.date);
    if (matchingDays.length > 1) fail(`Для группы «${groupId}» дата ${options.date} повторяется в расписании`);
    const day = matchingDays[0];
    if (!day) {
      skippedGroups.push({ groupId, reason: "На эту дату нет расписания группы" });
      continue;
    }
    if (day.holiday || day.slots.length === 0) {
      skippedGroups.push({ groupId, reason: day.holiday ? "В этот день занятий нет" : "В этот день нет уроков" });
      continue;
    }
    const before = timeCopy(day.times);
    if (before.length !== day.slots.length) fail(`В расписании группы «${groupId}» ${options.date} не совпадает число уроков и времён`);
    const breaks = before.slice(0, -1).map((_, index) => options.uniformBreak ?? bellBreak(options.schoolProfile, index));
    const start = groupId === options.currentGroupId ? options.start : (before[0]?.start ?? options.start);
    const after = dayTimeGrid(start, options.duration, breaks, before.length);
    const changed = day.duration !== options.duration ||
      after.some((time, index) => time.start !== before[index].start || time.duration !== before[index].duration);
    if (!changed) continue;
    day.times = after;
    day.start = `${String(Math.floor((after[0]?.start ?? 0) / 60)).padStart(2, "0")}:${String((after[0]?.start ?? 0) % 60).padStart(2, "0")}`;
    day.duration = options.duration;
    day.breaks = after.slice(0, -1).map((time, index) => after[index + 1].start - time.start - time.duration);
    changedDays.push({
      groupId,
      date: options.date,
      before,
      after: timeCopy(after),
      lessonCount: after.reduce((sum, time, index) => sum +
        (time.start !== before[index].start || time.duration !== before[index].duration ? day.slots[index].length : 0), 0),
    });
  }

  const oldJointTimes = new Map<string, { date: string; start: number; duration: number }>();
  for (const days of Object.values(schedule)) for (const day of days)
    day.slots.forEach((slot, index) => slot.forEach((lesson) => {
      const time = day.times[index];
      if (lesson.jointId && time) oldJointTimes.set(lesson.id, { date: day.date, ...time });
    }));
  const affectedJointIds = new Set<string>();
  for (const days of Object.values(next)) for (const day of days)
    day.slots.forEach((slot, index) => slot.forEach((lesson) => {
      if (!lesson.jointId) return;
      const before = oldJointTimes.get(lesson.id);
      const after = day.times[index];
      if (before && after && (before.date !== day.date || before.start !== after.start || before.duration !== after.duration))
        affectedJointIds.add(lesson.jointId);
    }));
  let conflict: string | undefined;
  for (const jointId of affectedJointIds) {
    const entries = Object.entries(next).flatMap(([scheduleKey, days]) => days.flatMap((day) => day.slots.flatMap((slot, index) =>
      slot.filter((lesson) => lesson.jointId === jointId).map(() => ({ groupId: groupOf(scheduleKey), date: day.date, ...day.times[index] })),
    )));
    const first = entries[0];
    if (entries.length > 1 && entries.some((entry) => entry.date !== first.date || entry.start !== first.start || entry.duration !== first.duration)) {
      const intervals = entries.map((entry) => {
        const group = catalog.groups.find((item) => item.id === entry.groupId);
        return `«${group?.name ?? entry.groupId}» ${formatTime(entry.start)}–${formatTime(entry.start + entry.duration)}`;
      }).join("; ");
      conflict = `Время общего занятия расходится: ${intervals}. Выберите все участвующие группы и проверьте их интервалы в предпросмотре.`;
      break;
    }
  }

  const roomConflict = conflict ? undefined : newRoomConflict(next, schedule);
  if (roomConflict) conflict = roomConflictMessage(roomConflict, catalog);
  const teacherConflict = conflict ? undefined : newTeacherConflict(next, schedule);
  if (teacherConflict) conflict = teacherConflictMessage(teacherConflict, catalog);
  const unavailable = conflict ? undefined : newUnavailabilityViolation(next, schedule, catalog);
  if (unavailable) conflict = unavailabilityViolationMessage(unavailable, catalog);
  let undoConflict: string | undefined;
  if (!conflict && changedDays.length) {
    const restoredRoomConflict = newRoomConflict(schedule, next);
    if (restoredRoomConflict) undoConflict = roomConflictMessage(restoredRoomConflict, catalog);
    else {
      const restoredTeacherConflict = newTeacherConflict(schedule, next);
      if (restoredTeacherConflict) undoConflict = teacherConflictMessage(restoredTeacherConflict, catalog);
    }
  }
  if (!conflict && !undoConflict && changedDays.length) {
    const restoredUnavailable = newUnavailabilityViolation(schedule, next, catalog);
    if (restoredUnavailable) undoConflict = unavailabilityViolationMessage(restoredUnavailable, catalog);
  }
  return { schedule: next, changedDays, skippedGroups, ...(conflict ? { conflict } : {}), ...(undoConflict ? { undoConflict } : {}) };
}

/** Applies a preview atomically, rejecting joint or resource conflicts. */
export function applyDayTiming(schedule: Schedule, options: DayTimingOptions, catalog: Catalog): Schedule {
  const preview = previewDayTiming(schedule, options, catalog);
  if (preview.conflict) fail(preview.conflict);
  return preview.schedule;
}
