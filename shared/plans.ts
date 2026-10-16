export type Quarter = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  archived?: boolean;
};
/** Active quarters, with the newest academic period first. */
export function visibleQuarters<T extends Quarter>(quarters: readonly T[]): T[] {
  return quarters.filter((quarter) => !quarter.archived).sort((a, b) => b.startDate.localeCompare(a.startDate) || b.endDate.localeCompare(a.endDate) || a.name.localeCompare(b.name, "ru"));
}
export type LessonKind = "regular" | "lab";
export type PlanAssignment = {
  id: string;
  subgroupId: string | null;
  target: number;
};
export type StudyPlan = {
  id: string;
  quarterId: string;
  groupId: string;
  subjectId: string;
  mode: "whole" | "subgroups";
  lessonKind: LessonKind;
  assignments: PlanAssignment[];
};
const DAY = 86400000;
const EPOCH = Date.UTC(2026, 9, 5);
/** Existing week offsets are retained; earlier and later weeks extend the same axis. */
export function weekOffsetFor(date: string) {
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - EPOCH) / (7 * DAY));
}
export function weekDates(offset: number): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    new Date(EPOCH + (offset * 7 + index) * DAY).toISOString().slice(0, 10),
  );
}
export function quarterWeeks(quarter: Quarter): number[] {
  const first = weekOffsetFor(quarter.startDate),
    last = weekOffsetFor(quarter.endDate);
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, index) => first + index,
  );
}
export function inQuarter(date: string, quarter: Quarter) {
  return date >= quarter.startDate && date <= quarter.endDate;
}
