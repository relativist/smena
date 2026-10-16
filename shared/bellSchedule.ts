import { newUnavailabilityViolation, unavailabilityViolationMessage } from "./unavailability.ts";
import type { Catalog } from "./catalog.ts";
import { newRoomConflict, roomConflictMessage } from "./roomConflicts.ts";
import { newTeacherConflict, teacherConflictMessage } from "./teacherConflicts.ts";
import type { Schedule } from "../src/editor.ts";

export type BellProfile = { start: number; duration: number; breaks: number[] };
export type BellSettings = { school: BellProfile; groups: Record<string, BellProfile> };
export type BellApplyOptions = {
  groupIds: string[];
  startDate: string;
  endDate: string;
  replaceStart: boolean;
  resetBreaks: boolean;
};

export const DEFAULT_BELL_PROFILE: BellProfile = {
  start: 510,
  duration: 45,
  breaks: [10, 10, 15, 10, 10, 10],
};

export function defaultBellSettings(): BellSettings {
  return {
    school: { ...DEFAULT_BELL_PROFILE, breaks: [...DEFAULT_BELL_PROFILE.breaks] },
    groups: {},
  };
}

/** Legacy publication snapshots may lack the modern school bell profile. */
export function normalSchoolBreakMinutes(settings?: BellSettings): number {
  const breaks = settings?.school?.breaks;
  return Array.isArray(breaks) && breaks.length > 0 && breaks.every(value => Number.isInteger(value) && value >= 0 && value <= 240)
    ? Math.max(...breaks)
    : Math.max(...DEFAULT_BELL_PROFILE.breaks);
}

export function effectiveBellProfile(settings: BellSettings, groupId: string): BellProfile {
  // `groups` remains on the wire for compatibility with older clients and saved rows.
  // Group-specific values are intentionally ignored.
  void groupId;
  const profile = settings.school;
  return { ...profile, breaks: [...profile.breaks] };
}

export function normalizeBellSettings(value: unknown): BellSettings | null {
  if (!object(value) || Object.keys(value).sort().join(",") !== "groups,school" || !object(value.groups)) return null;
  return { school: value.school as BellProfile, groups: {} };
}

export function bellBreak(profile: BellProfile, slotIndex: number): number {
  return profile.breaks[slotIndex] ?? profile.breaks.at(-1) ?? 10;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number.isFinite(value) && (value as number) >= min && (value as number) <= max;

export function validateBellProfile(value: unknown): string | null {
  if (!object(value) || Object.keys(value).sort().join(",") !== "breaks,duration,start")
    return "Профиль звонков должен содержать начало, длительность и перемены";
  if (!integer(value.start, 0, 1439)) return "Начало уроков должно быть целым числом от 0 до 1439 минут";
  if (!integer(value.duration, 1, 180)) return "Длительность урока должна быть целым числом от 1 до 180 минут";
  if (!Array.isArray(value.breaks) || value.breaks.length < 1 || value.breaks.length > 11 ||
    value.breaks.some((gap) => !integer(gap, 0, 240)))
    return "Перемены должны содержать от 1 до 11 целых значений от 0 до 240 минут";
  let end = (value.start as number) + 7 * (value.duration as number);
  for (let index = 0; index < 6; index += 1)
    end += (value.breaks as number[])[index] ?? (value.breaks as number[]).at(-1)!;
  if (end > 1440) return "Семь уроков по этим настройкам выходят за пределы дня";
  return null;
}

export function validateBellSettings(value: unknown, catalog: Catalog): string | null {
  if (!object(value) || Object.keys(value).sort().join(",") !== "groups,school" || !object(value.groups))
    return "Настройки звонков должны содержать общие настройки";
  const schoolError = validateBellProfile(value.school);
  if (schoolError) return `Общие настройки: ${schoolError}`;
  void catalog;
  return null;
}

type ChangedDay = {
  groupId: string;
  date: string;
  before: Array<{ start: number; duration: number }>;
  after: Array<{ start: number; duration: number }>;
  lessonCount: number;
  manualChanges: number;
};
export type BellApplyResult = {
  schedule: Schedule;
  changedDays: ChangedDay[];
  changedLessons: number;
  manualChanges: number;
};

const fail = (message: string): never => { throw new Error(message); };
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const equalTimes = (a: Array<{ start: number; duration: number }>, b: Array<{ start: number; duration: number }>) =>
  a.length === b.length && a.every((time, i) => time.start === b[i].start && time.duration === b[i].duration);

/** Applies bell settings to selected groups and inclusive school days atomically. */
export function applyBellSettings(
  schedule: Schedule,
  settings: BellSettings,
  options: BellApplyOptions,
  catalog: Catalog,
): BellApplyResult {
  if (!object(options) || Object.keys(options).sort().join(",") !== "endDate,groupIds,replaceStart,resetBreaks,startDate")
    fail("Укажите параметры применения настроек расписания");
  if (!Array.isArray(options.groupIds) || options.groupIds.some((groupId) => typeof groupId !== "string") ||
    typeof options.replaceStart !== "boolean" || typeof options.resetBreaks !== "boolean")
    fail("Параметры групп и изменения перемен заполнены некорректно");
  const settingsError = validateBellSettings(settings, catalog);
  if (settingsError) fail(settingsError);
  if (!Array.isArray(options.groupIds) || !options.groupIds.length || new Set(options.groupIds).size !== options.groupIds.length)
    fail("Выберите одну или несколько групп без повторов");
  if (!validDate(options.startDate) || !validDate(options.endDate) || options.startDate > options.endDate)
    fail("Укажите корректный период: дата начала должна быть не позже даты окончания");
  for (const groupId of options.groupIds) {
    const group = catalog.groups.find((entry) => entry.id === groupId);
    if (!group || group.archived) fail(`Группа «${groupId}» не найдена или архивирована`);
  }

  const next: Schedule = Object.fromEntries(Object.entries(schedule).map(([key, days]) => [key,
    days.map((day) => ({
      ...day,
      breaks: [...day.breaks],
      slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson }))),
      times: day.times.map((time) => ({ ...time })),
      ...(day.bellProfile ? { bellProfile: { ...day.bellProfile, breaks: [...day.bellProfile.breaks] } } : {}),
    })),
  ]));
  const changedDays: ChangedDay[] = [];

  for (const groupId of options.groupIds) {
    const profile = effectiveBellProfile(settings, groupId);
    let foundSchedule = false;
    for (const [scheduleKey, days] of Object.entries(next)) {
      if (scheduleKey.slice(0, scheduleKey.lastIndexOf(":")) !== groupId) continue;
      foundSchedule = true;
      for (const day of days) {
        if (day.date < options.startDate || day.date > options.endDate || day.holiday || day.slots.length === 0) continue;
        const before = day.times.map((time) => ({ ...time }));
        if (before.length !== day.slots.length) fail(`В расписании группы «${groupId}» ${day.date} не совпадает число уроков и времён`);
        const oldProfile = day.bellProfile ?? DEFAULT_BELL_PROFILE;
        const anchor = options.replaceStart ? profile.start : (before[0]?.start ?? profile.start);
        const oldAnchor = before[0]?.start ?? oldProfile.start;
        const manualSlots: boolean[] = [];
        const newTimes: Array<{ start: number; duration: number }> = [];
        let nextStart = anchor;
        for (let slotIndex = 0; slotIndex < before.length; slotIndex += 1) {
          const time = before[slotIndex];
          const inferredOldStart = oldAnchor + oldProfile.duration * slotIndex +
            Array.from({ length: slotIndex }, (_, gapIndex) => bellBreak(oldProfile, gapIndex)).reduce((sum, gap) => sum + gap, 0);
          const isManual = time.start !== inferredOldStart || time.duration !== oldProfile.duration;
          manualSlots.push(isManual);
          newTimes.push({ start: nextStart, duration: profile.duration });
          if (slotIndex + 1 < before.length) {
            const actualGap = before[slotIndex + 1].start - (before[slotIndex].start + before[slotIndex].duration);
            const oldGap = bellBreak(oldProfile, slotIndex);
            const gap = !options.resetBreaks && actualGap !== oldGap ? actualGap : bellBreak(profile, slotIndex);
            if (!integer(gap, 0, 240)) fail(`Некорректная перемена после урока ${slotIndex + 1} группы «${groupId}» ${day.date}`);
            nextStart += profile.duration + gap;
          }
        }
        if (newTimes.some((time) => !integer(time.start, 0, 1439) || time.start + time.duration > 1440))
          fail(`Расписание группы «${groupId}» ${day.date} выходит за пределы суток`);
        if (newTimes.some((time, index) => index > 0 && newTimes[index - 1].start + newTimes[index - 1].duration > time.start))
          fail(`Уроки группы «${groupId}» ${day.date} пересекаются`);

        const nextBreaks = newTimes.slice(0, -1).map((time, slotIndex) => {
          const gap = newTimes[slotIndex + 1].start - (time.start + time.duration);
          if (!integer(gap, 0, 240)) fail(`Перемена группы «${groupId}» ${day.date} должна быть от 0 до 240 минут`);
          return gap;
        });
        const snapshotChanged = JSON.stringify(day.bellProfile ?? DEFAULT_BELL_PROFILE) !== JSON.stringify(profile);
        const timesChanged = !equalTimes(before, newTimes);
        const startLabel = `${String(Math.floor((newTimes[0]?.start ?? 0) / 60)).padStart(2, "0")}:${String((newTimes[0]?.start ?? 0) % 60).padStart(2, "0")}`;
        const metadataChanged = snapshotChanged || day.duration !== profile.duration || day.start !== startLabel ||
          JSON.stringify(day.breaks) !== JSON.stringify(nextBreaks);
        if (timesChanged || metadataChanged) {
          day.times = newTimes;
          day.start = startLabel;
          day.duration = profile.duration;
          day.breaks = nextBreaks;
          day.bellProfile = { ...profile, breaks: [...profile.breaks] };
          const changedSlots = newTimes.map((time, index) =>
            time.start !== before[index].start || time.duration !== before[index].duration,
          );
          const manualChanges = changedSlots.reduce((count, changed, index) =>
            count + Number(changed && manualSlots[index]), 0,
          );
          const lessonCount = changedSlots.reduce((count, changed, index) =>
            count + (changed ? day.slots[index].length : 0), 0,
          );
          changedDays.push({ groupId, date: day.date, before, after: newTimes.map((time) => ({ ...time })), lessonCount, manualChanges });
        }
      }
    }
    if (!foundSchedule) fail(`Для группы «${groupId}» нет расписания`);
  }

  const originalTimes = new Map<string, { date: string; start: number; duration: number }>();
  for (const days of Object.values(schedule)) for (const day of days)
    day.slots.forEach((slot, slotIndex) => slot.forEach((lesson) => {
      const time = day.times[slotIndex];
      if (time) originalTimes.set(lesson.id, { date: day.date, ...time });
    }));
  const affectedJointIds = new Set<string>();
  for (const days of Object.values(next)) for (const day of days)
    day.slots.forEach((slot, slotIndex) => slot.forEach((lesson) => {
      if (!lesson.jointId) return;
      const prior = originalTimes.get(lesson.id);
      const time = day.times[slotIndex];
      if (prior && time && (prior.date !== day.date || prior.start !== time.start || prior.duration !== time.duration))
        affectedJointIds.add(lesson.jointId);
    }));
  for (const jointId of affectedJointIds) {
    const intervals = Object.entries(next).flatMap(([, days]) => days.flatMap((day) => day.slots.flatMap((slot, index) =>
      slot.filter((lesson) => lesson.jointId === jointId).map(() => ({ date: day.date, ...day.times[index] })),
    )));
    if (intervals.length < 2) continue;
    const first = intervals[0];
    if (intervals.some((entry) => entry.date !== first.date || entry.start !== first.start || entry.duration !== first.duration))
      fail("Нельзя изменить время только части совместного занятия; выберите все группы совместного урока");
  }

  const unavailable = newUnavailabilityViolation(next, schedule, catalog);
  if (unavailable) fail(unavailabilityViolationMessage(unavailable, catalog));
  const roomConflict = newRoomConflict(next, schedule);
  if (roomConflict) fail(roomConflictMessage(roomConflict, catalog));
  const teacherConflict = newTeacherConflict(next, schedule);
  if (teacherConflict) fail(teacherConflictMessage(teacherConflict, catalog));
  return {
    schedule: next,
    changedDays,
    changedLessons: changedDays.reduce((sum, day) => sum + day.lessonCount, 0),
    manualChanges: changedDays.reduce((sum, day) => sum + day.manualChanges, 0),
  };
}
