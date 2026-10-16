import type { PublicStudentQuarter } from "./studentTypes.ts";

export const STUDENT_GROUP_STORAGE_KEY = "smena.students.group";
const DAY_MS = 86400000;

export function dateIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function mondayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = (parsed.getUTCDay() + 6) % 7;
  return new Date(parsed.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
}

export function weekDatesFor(date: string): string[] {
  const monday = Date.parse(`${mondayOf(date)}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(monday + i * DAY_MS).toISOString().slice(0, 10));
}

export function groupFor(quarter: PublicStudentQuarter | undefined, groupId?: string) {
  return quarter?.groups.find(group => group.id === groupId);
}

export function quarterFor(index: PublicStudentQuarter[], id?: string) {
  return index.find(quarter => quarter.id === id);
}

function clampToQuarter(date: string, quarter: PublicStudentQuarter): string {
  return date < quarter.startDate ? quarter.startDate : date > quarter.endDate ? quarter.endDate : date;
}

export function nearestLessonDate(dates: string[], today: string): string | undefined {
  const unique = [...new Set(dates)].sort();
  return unique.find(date => date >= today) ?? unique.at(-1);
}

export function chooseStudentLocation(
  quarters: PublicStudentQuarter[],
  options: { today: string; queryGroup?: string; queryQuarter?: string; queryDate?: string; storedGroup?: string; todayIsVacation?: boolean },
): { groupId: string; quarterId: string; date: string } | undefined {
  if (!quarters.length) return undefined;
  const sorted = [...quarters].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const explicitQuarter = quarterFor(sorted, options.queryQuarter);
  const preferredGroupId = options.queryGroup;
  const fallbackGroupId = options.storedGroup;
  const validQueryDate = isValidIsoDate(options.queryDate) ? options.queryDate : undefined;

  if (explicitQuarter) {
    const group = groupFor(explicitQuarter, preferredGroupId) ?? groupFor(explicitQuarter, fallbackGroupId) ?? [...explicitQuarter.groups].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }))[0];
    if (group) {
      const date = validQueryDate && validQueryDate >= explicitQuarter.startDate && validQueryDate <= explicitQuarter.endDate
        ? validQueryDate
        : nearestLessonDate(group.lessonDates, options.today) ?? clampToQuarter(options.today, explicitQuarter);
      return { groupId: group.id, quarterId: explicitQuarter.id, date };
    }
  }

  // Prefer the current quarter only when this group actually has lessons this week.
  const activeQuarter = sorted.find(quarter => quarter.startDate <= options.today && options.today <= quarter.endDate);
  if (activeQuarter) {
    const group = groupFor(activeQuarter, preferredGroupId) ?? groupFor(activeQuarter, fallbackGroupId) ?? [...activeQuarter.groups].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }))[0];
    if (group) {
      const currentWeek = mondayOf(options.today);
      const isWeekend = [0, 6].includes(new Date(`${options.today}T00:00:00Z`).getUTCDay());
      const currentWeekHasUpcomingLesson = group.lessonDates.some(date => mondayOf(date) === currentWeek && date >= options.today);
      if (!options.todayIsVacation && group.lessonDates.some(date => mondayOf(date) === currentWeek) && (!isWeekend || currentWeekHasUpcomingLesson)) {
        return { groupId: group.id, quarterId: activeQuarter.id, date: validQueryDate && activeQuarter.startDate <= validQueryDate && validQueryDate <= activeQuarter.endDate ? validQueryDate : options.today };
      }
    }
  }

  const allGroups = sorted.flatMap(quarter => quarter.groups);
  const preferredGroup = allGroups.find(group => group.id === preferredGroupId) ?? allGroups.find(group => group.id === fallbackGroupId);
  const candidates = sorted.flatMap(quarter => quarter.groups
    .filter(group => !preferredGroup || group.id === preferredGroup.id)
    .flatMap(group => group.lessonDates.map(date => ({ quarter, group, date }))))
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = candidates.find(item => item.date >= options.today);
  const chosen = next ?? candidates.at(-1);
  if (chosen) return { groupId: chosen.group.id, quarterId: chosen.quarter.id, date: validQueryDate && chosen.quarter.startDate <= validQueryDate && validQueryDate <= chosen.quarter.endDate ? validQueryDate : chosen.date };

  const quarter = activeQuarter ?? sorted.at(-1)!;
  const group = groupFor(quarter, preferredGroupId) ?? groupFor(quarter, fallbackGroupId) ?? [...quarter.groups].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }))[0];
  return group ? { groupId: group.id, quarterId: quarter.id, date: validQueryDate && quarter.startDate <= validQueryDate && validQueryDate <= quarter.endDate ? validQueryDate : clampToQuarter(options.today, quarter) } : undefined;
}
