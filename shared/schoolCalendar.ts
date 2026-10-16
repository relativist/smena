import type { Catalog } from "./catalog.ts";
import type { Schedule } from "../src/editor.ts";

export type CalendarPeriod = {
  id: string;
  name: string;
  kind: "holiday" | "day-off" | "study";
  startDate: string;
  endDate: string;
  groupIds: string[] | null;
};
export type SchoolCalendar = {
  weekdays: number[];
  /** Optional per-group overrides; omitted groups inherit school weekdays. */
  groupWeekdays?: Record<string, number[]>;
  periods: CalendarPeriod[];
};
export type CalendarPreview = {
  schedule: Schedule;
  changedDays: Array<{
    groupId: string;
    date: string;
    holiday: boolean;
    label: string;
    removedCount: number;
  }>;
  removedCount: number;
  studyOverrideCount: number;
  jointChanges: Array<{
    jointId: string;
    removedGroupIds: string[];
    remainingGroupIds: string[];
  }>;
};

const MAX_PERIODS = 2000;
const MAX_GROUPS = 1000;
const MAX_ID_LENGTH = 120;
const MAX_NAME_LENGTH = 120;
const MAX_DATE = "9999-12-31";
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

export function defaultSchoolCalendar(): SchoolCalendar {
  return { weekdays: [...DEFAULT_WEEKDAYS], periods: [] };
}

export function studyWeekdays(calendar: SchoolCalendar, groupId: string): number[] {
  return calendar.groupWeekdays?.[groupId] ?? calendar.weekdays;
}

function realISODate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateCalendar(value: unknown, catalog: Catalog): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Некорректный календарь.";
  const calendar = value as Partial<SchoolCalendar>;
  if (!Array.isArray(calendar.weekdays) || calendar.weekdays.length === 0) return "Выберите хотя бы один учебный день недели.";
  if (calendar.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || new Set(calendar.weekdays).size !== calendar.weekdays.length)
    return "Дни недели должны быть уникальными числами от 1 до 7.";
  const groupIds = new Set(catalog.groups.map((group) => group.id));
  if (calendar.groupWeekdays !== undefined) {
    if (!calendar.groupWeekdays || typeof calendar.groupWeekdays !== "object" || Array.isArray(calendar.groupWeekdays) || Object.keys(calendar.groupWeekdays).length > MAX_GROUPS)
      return "Некорректные учебные дни групп.";
    for (const [groupId, weekdays] of Object.entries(calendar.groupWeekdays)) {
      if (!groupIds.has(groupId)) return "Настройка учебных дней содержит неизвестную группу.";
      if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || new Set(weekdays).size !== weekdays.length)
        return "Для каждой группы выберите уникальные учебные дни недели от 1 до 7.";
    }
  }
  if (!Array.isArray(calendar.periods) || calendar.periods.length > MAX_PERIODS) return "Некорректное количество периодов календаря.";
  const ids = new Set<string>();
  for (const item of calendar.periods) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "Некорректный период календаря.";
    const period = item as CalendarPeriod;
    if (typeof period.id !== "string" || !period.id.trim() || period.id.length > MAX_ID_LENGTH || ids.has(period.id)) return "Идентификаторы периодов должны быть заполнены и уникальны.";
    ids.add(period.id);
    if (typeof period.name !== "string" || !period.name.trim() || period.name.length > MAX_NAME_LENGTH) return "Название периода должно содержать от 1 до 120 символов.";
    if (!["holiday", "day-off", "study"].includes(period.kind)) return "Неизвестный тип периода календаря.";
    if (!realISODate(period.startDate) || !realISODate(period.endDate) || period.startDate > MAX_DATE || period.endDate > MAX_DATE)
      return "Укажите реальные даты в формате ГГГГ-ММ-ДД.";
    if (period.startDate > period.endDate) return "Дата окончания периода не может быть раньше даты начала.";
    if (period.groupIds !== null) {
      if (!Array.isArray(period.groupIds) || period.groupIds.length === 0 || period.groupIds.length > MAX_GROUPS)
        return "Для периода выберите хотя бы одну группу.";
      if (period.groupIds.some((id) => typeof id !== "string" || !groupIds.has(id)) || new Set(period.groupIds).size !== period.groupIds.length)
        return "Период содержит неизвестную или повторную группу.";
    }
  }
  return null;
}

function dateOrdinal(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 86400000;
}
function dateWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Resolve overlapping periods with stable scope and kind priorities. */
export function calendarDay(
  calendar: SchoolCalendar,
  groupId: string,
  date: string,
): { holiday: boolean; kind: CalendarPeriod["kind"] | "weekend" | "regular"; label: string } {
  const matching = calendar.periods
    .filter((period) => period.startDate <= date && date <= period.endDate && (period.groupIds === null || period.groupIds.includes(groupId)))
    .sort((a, b) => {
      const scopeA = a.groupIds === null ? 0 : 1;
      const scopeB = b.groupIds === null ? 0 : 1;
      const kindPriority = (kind: CalendarPeriod["kind"]) => kind === "study" ? 3 : kind === "holiday" ? 2 : 1;
      return scopeB - scopeA || kindPriority(b.kind) - kindPriority(a.kind) || a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id);
    });
  const selected = matching[0];
  if (selected) return { holiday: selected.kind !== "study", kind: selected.kind, label: selected.name.trim() || (selected.kind === "study" ? "Учебный день" : "Выходной") };
  if (!studyWeekdays(calendar, groupId).includes(dateWeekday(date))) return { holiday: true, kind: "weekend", label: "Выходной" };
  return { holiday: false, kind: "regular", label: "Учебный день" };
}

/** Import legacy per-day holiday flags as stable, merged, group-scoped periods. */
export function calendarFromSchedule(schedule: Schedule): SchoolCalendar {
  const periods: CalendarPeriod[] = [];
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    const legacyDays = days.filter((day) => day.holiday).sort((a, b) => a.date.localeCompare(b.date));
    let run: typeof legacyDays = [];
    const flush = () => {
      if (!run.length) return;
      const startDate = run[0].date;
      const endDate = run[run.length - 1].date;
      const note = run.map((day) => day.note?.trim()).find((item): item is string => Boolean(item));
      periods.push({
        id: `legacy:${encodeURIComponent(groupId)}:${startDate}:${endDate}`,
        name: note || "Каникулы",
        kind: "holiday",
        startDate,
        endDate,
        groupIds: [groupId],
      });
      run = [];
    };
    for (const day of legacyDays) {
      if (run.length && dateOrdinal(day.date) !== dateOrdinal(run[run.length - 1].date) + 1) flush();
      run.push(day);
    }
    flush();
  }
  return { ...defaultSchoolCalendar(), periods };
}

/** Apply calendar status only to schedule dates already materialized by the caller. */
export function applyCalendar(schedule: Schedule, calendar: SchoolCalendar): CalendarPreview {
  const updated: Schedule = {};
  const changedDays: CalendarPreview["changedDays"] = [];
  const removedCountByJoint = new Map<string, Map<string, number>>();
  let removedCount = 0;
  let studyOverrideCount = 0;

  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    updated[scheduleKey] = days.map((day) => {
      const status = calendarDay(calendar, groupId, day.date);
      if (day.holiday && status.kind === "study") studyOverrideCount += 1;
      const shouldClear = status.holiday;
      let dayRemoved = 0;
      const slots = day.slots.map((slot) => {
        if (!shouldClear) return slot.map((lesson) => ({ ...lesson }));
        const keep = slot.filter((lesson) => {
          if (lesson.jointId) {
            const groups = removedCountByJoint.get(lesson.jointId) ?? new Map<string, number>();
            groups.set(groupId, (groups.get(groupId) ?? 0) + 1);
            removedCountByJoint.set(lesson.jointId, groups);
          }
          dayRemoved += 1;
          return false;
        });
        return keep.map((lesson) => ({ ...lesson }));
      });
      removedCount += dayRemoved;
      if (Boolean(day.holiday) !== shouldClear || dayRemoved > 0) {
        changedDays.push({ groupId, date: day.date, holiday: shouldClear, label: status.label, removedCount: dayRemoved });
      }
      return { ...day, holiday: shouldClear, slots };
    });
  }

  const jointChanges: CalendarPreview["jointChanges"] = [];
  for (const [jointId, removedByGroup] of removedCountByJoint) {
    const allGroups = new Set<string>();
    for (const [scheduleKey, days] of Object.entries(schedule))
      for (const day of days) for (const slot of day.slots) for (const lesson of slot)
        if (lesson.jointId === jointId) allGroups.add(scheduleKey.slice(0, scheduleKey.lastIndexOf(":")));
    const removedGroupIds = [...removedByGroup.keys()].sort();
    jointChanges.push({ jointId, removedGroupIds, remainingGroupIds: [...allGroups].filter((id) => !removedByGroup.has(id)).sort() });
  }

  return { schedule: updated, changedDays, removedCount, studyOverrideCount, jointChanges };
}
