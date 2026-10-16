import type { Catalog } from "./catalog.ts";
import type { Schedule } from "../src/editor.ts";
import type { RoomOccupancy } from "./roomConflicts.ts";

export type UnavailabilityRule = {
  id: string;
  startDate: string;
  endDate: string;
  start: number;
  end: number;
  weekdays?: number[];
  reason?: string;
};

export type UnavailabilityConflict = {
  kind: "teacher" | "room";
  resourceId: string;
  resourceName: string;
  ruleId: string;
  date: string;
  start: number;
  end: number;
  reason?: string;
};

export type UnavailabilityViolation = {
  lessonId: string;
  groupId: string;
  date: string;
  kind: "teacher" | "room";
  resourceId: string;
  resourceName: string;
  ruleId: string;
  start: number;
  end: number;
  reason?: string;
  message: string;
};

const isoDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Returns a validation message, or null for valid rules and legacy undefined values. */
export function validateUnavailabilityRules(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "Ограничения недоступности должны быть списком";
  if (value.length > 200) return "Нельзя добавить больше 200 ограничений недоступности";
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "Некорректное ограничение недоступности";
    const rule = item as Record<string, unknown>;
    if (typeof rule.id !== "string" || !rule.id.trim() || rule.id !== rule.id.trim() || rule.id.length > 100 || ids.has(rule.id)) return "Идентификаторы ограничений должны быть уникальными и содержать не более 100 символов без пробелов по краям";
    ids.add(rule.id);
    if (!isoDate(rule.startDate) || !isoDate(rule.endDate) || rule.startDate > rule.endDate) return "Укажите корректный период недоступности";
    if (!Number.isInteger(rule.start) || (rule.start as number) < 0 || (rule.start as number) > 1439 || !Number.isInteger(rule.end) || (rule.end as number) < 1 || (rule.end as number) > 1440 || (rule.end as number) <= (rule.start as number)) return "Укажите корректный интервал времени недоступности";
    if (rule.weekdays !== undefined) {
      if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0 || rule.weekdays.some(day => !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7) || new Set(rule.weekdays).size !== rule.weekdays.length) return "Укажите хотя бы один уникальный день недели числом от 1 до 7";
    }
    if (rule.reason !== undefined && (typeof rule.reason !== "string" || rule.reason.length > 300)) return "Причина недоступности не должна превышать 300 символов";
  }
  return null;
}

function dateMatches(rule: UnavailabilityRule, date: string): boolean {
  if (!isoDate(date) || date < rule.startDate || date > rule.endDate) return false;
  if (!rule.weekdays) return true;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
  return rule.weekdays.includes(weekday);
}

function resource(catalog: Catalog, kind: "teacher" | "room", id: string) {
  return kind === "teacher" ? catalog.teachers.find(item => item.id === id) : catalog.rooms.find(item => item.id === id);
}

function resolveResource(catalog: Catalog, kind: "teacher" | "room", id: string | undefined, legacy: string | undefined): string | undefined {
  if (id && resource(catalog, kind, id)) return id;
  if (!legacy?.trim()) return undefined;
  const label = legacy.trim().toLocaleLowerCase("ru");
  const entries = kind === "teacher" ? catalog.teachers : catalog.rooms;
  const matches = entries.filter(entry => {
    const name = entry.name.trim().toLocaleLowerCase("ru");
    if (name === label) return true;
    if (kind !== "teacher") return false;
    const surname = name.split(/\s+/)[0];
    return surname === label || name.startsWith(`${label} `) || label.startsWith(`${surname} `);
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export function findUnavailability(
  catalog: Catalog,
  kind: "teacher" | "room",
  resourceId: string | undefined,
  date: string,
  start: number,
  end: number,
): UnavailabilityConflict[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const id = resourceId && resource(catalog, kind, resourceId) ? resourceId : undefined;
  if (!id) return [];
  const entry = resource(catalog, kind, id)!;
  return (entry.unavailability ?? []).filter(rule => dateMatches(rule, date) && start < rule.end && rule.start < end).map(rule => ({
    kind, resourceId: id, resourceName: entry.name, ruleId: rule.id, date,
    start: Math.max(start, rule.start), end: Math.min(end, rule.end), reason: rule.reason,
  }));
}

export function lessonUnavailability(
  catalog: Catalog,
  entry: { date: string; start: number; end: number; teacherId?: string; roomId?: string; teacher?: string; room?: string },
): UnavailabilityConflict[] {
  const result: UnavailabilityConflict[] = [];
  for (const kind of ["teacher", "room"] as const) {
    const id = resolveResource(catalog, kind, kind === "teacher" ? entry.teacherId : entry.roomId, kind === "teacher" ? entry.teacher : entry.room);
    result.push(...findUnavailability(catalog, kind, id, entry.date, entry.start, entry.end));
  }
  return result;
}

type Located = { lessonId: string; groupId: string; date: string; conflict: UnavailabilityConflict };
function located(schedule: Schedule | RoomOccupancy[], catalog: Catalog): Located[] {
  const result: Located[] = [];
  if (Array.isArray(schedule)) {
    for (const entry of schedule) {
      for (const conflict of lessonUnavailability(catalog, { ...entry, roomId: entry.roomId ?? undefined }))
        result.push({ lessonId: entry.lessonId, groupId: entry.groupId, date: entry.date, conflict });
    }
    return result;
  }
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days) day.slots.forEach((slot, index) => {
      const time = day.times[index];
      if (!time) return;
      for (const lesson of slot) {
        const lessonId = lesson.id;
        for (const conflict of lessonUnavailability(catalog, {
          date: day.date, start: time.start, end: time.start + time.duration,
          teacherId: lesson.teacherId, roomId: lesson.roomId, teacher: lesson.teacher, room: lesson.room,
        })) result.push({ lessonId, groupId, date: day.date, conflict });
      }
    });
  }
  return result;
}

function violationOf(item: Located): UnavailabilityViolation {
  const { conflict: c } = item;
  const reason = c.reason ? `: ${c.reason}` : "";
  const message = `${c.kind === "teacher" ? "Учитель" : "Кабинет"} «${c.resourceName}» недоступен ${formatMinutes(c.start)}–${formatMinutes(c.end)}${reason}`;
  return { lessonId: item.lessonId, groupId: item.groupId, date: item.date, kind: c.kind, resourceId: c.resourceId, resourceName: c.resourceName, ruleId: c.ruleId, start: c.start, end: c.end, reason: c.reason, message };
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function scheduledUnavailability(schedule: Schedule, catalog: Catalog): UnavailabilityViolation[] {
  return located(schedule, catalog).map(violationOf);
}

export function newUnavailabilityViolation(next: Schedule | RoomOccupancy[], previous: Schedule | RoomOccupancy[], catalog: Catalog): UnavailabilityViolation | undefined {
  const old = located(previous, catalog);
  for (const item of located(next, catalog)) {
    const prior = old.find(entry => entry.lessonId === item.lessonId && entry.groupId === item.groupId && entry.date === item.date && entry.conflict.kind === item.conflict.kind && entry.conflict.resourceId === item.conflict.resourceId && entry.conflict.ruleId === item.conflict.ruleId);
    if (prior && item.conflict.start >= prior.conflict.start && item.conflict.end <= prior.conflict.end) continue;
    return violationOf(item);
  }
  return undefined;
}

export function unavailabilityViolationMessage(violation: UnavailabilityViolation, catalog: Catalog): string {
  const group = catalog.groups.find(item => item.id === violation.groupId)?.name ?? violation.groupId;
  return `${violation.message} (группа ${group}, ${violation.date})`;
}
