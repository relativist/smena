import { calendarDay, defaultSchoolCalendar, studyWeekdays } from "./schoolCalendar.ts";
import type { SchoolCalendar } from "./schoolCalendar.ts";
import type { Quarter } from "./plans.ts";

export const WEEKLY_LOAD_TARGET = 18;

export type LoadPeriod = {
  id: string;
  start: string;
  end: string;
  fullStart: string;
  fullEnd: string;
  partial: boolean;
  studyDays: number;
  target: number;
  nonStudyLabel?: string;
};

function roundTarget(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseMonth(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Месяц должен быть указан в формате ГГГГ-ММ.");
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
}

function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
}

/** Split a month into Monday–Sunday weeks and prorate the 18-lesson norm by global study days. */
export function teacherLoadMonth(
  month: string,
  sources: Array<{ quarter: Quarter; calendar?: SchoolCalendar }>,
): { start: string; end: string; weeks: LoadPeriod[]; studyDays: number; target: number; nonStudyLabel?: string } {
  const { start, end } = parseMonth(month);
  const defaultCalendar = defaultSchoolCalendar();
  const weeks: LoadPeriod[] = [];
  let weekStart = mondayOf(start);
  let studyDays = 0;
  let target = 0;

  const calendarForDate = (date: string) => {
    const inQuarter = sources.find(({ quarter }) => quarter.startDate <= date && date <= quarter.endDate);
    if (inQuarter) return inQuarter.calendar ?? defaultCalendar;
    // School calendars are stored with quarter snapshots. Use the nearest snapshot
    // to recognize breaks between quarters, without treating those dates as study days.
    const nearest = sources.reduce<{ source: typeof sources[number]; distance: number } | undefined>((best, source) => {
      const distance = date < source.quarter.startDate
        ? Date.parse(`${source.quarter.startDate}T00:00:00.000Z`) - Date.parse(`${date}T00:00:00.000Z`)
        : date > source.quarter.endDate
          ? Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${source.quarter.endDate}T00:00:00.000Z`)
          : 0;
      return !best || distance < best.distance ? { source, distance } : best;
    }, undefined);
    return nearest ? nearest.source.calendar ?? defaultCalendar : undefined;
  };

  const nonStudyLabel = (periodStart: string, periodEnd: string, hasStudyDays: boolean): string | undefined => {
    if (hasStudyDays) return undefined;
    let hasWeekday = false;
    let fullyCovered = true;
    let hasUncoveredDate = false;
    const names = new Set<string>();
    for (let date = periodStart; date <= periodEnd; date = shiftDate(date, 1)) {
      const calendar = calendarForDate(date);
      if (!calendar) { fullyCovered = false; hasUncoveredDate = true; continue; }
      const day = calendarDay(calendar, "", date);
      if (day.kind === "study") { fullyCovered = false; continue; }
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
      if (!studyWeekdays(calendar, "").includes(weekday)) continue;
      hasWeekday = true;
      if (!day.holiday || (day.kind !== "holiday" && day.kind !== "day-off")) {
        fullyCovered = false;
        continue;
      }
      const explicitGlobal = calendar.periods.some((item) => item.groupIds === null
        && item.startDate <= date && date <= item.endDate
        && item.kind === day.kind && item.name.trim() === day.label);
      if (!explicitGlobal) { fullyCovered = false; continue; }
      names.add(day.label);
    }
    if (fullyCovered && names.size) {
      const labels = [...names];
      return labels.length <= 2 ? labels.join(" · ") : `${labels.slice(0, 2).join(" · ")} +${labels.length - 2}`;
    }
    if (!hasWeekday && !hasUncoveredDate && fullyCovered) return "Выходные";
    return "Нет учебных дней";
  };

  while (weekStart <= end) {
    const fullStart = weekStart;
    const fullEnd = shiftDate(fullStart, 6);
    const clippedStart = fullStart < start ? start : fullStart;
    const clippedEnd = fullEnd > end ? end : fullEnd;
    let periodStudyDays = 0;
    let periodTarget = 0;

    for (let date = clippedStart; date <= clippedEnd; date = shiftDate(date, 1)) {
      // The first matching quarter owns an overlapping date, preventing double counting.
      const source = sources.find(({ quarter }) => quarter.startDate <= date && date <= quarter.endDate);
      if (!source) continue;
      const calendar = source.calendar ?? defaultCalendar;
      // Empty group id deliberately ignores group-specific overrides and periods.
      if (calendarDay(calendar, "", date).holiday) continue;
      const weekdayCount = studyWeekdays(calendar, "").length;
      if (!weekdayCount) continue;
      periodStudyDays += 1;
      periodTarget += WEEKLY_LOAD_TARGET / weekdayCount;
    }

    const period: LoadPeriod = {
      id: `${clippedStart}:${clippedEnd}`,
      start: clippedStart,
      end: clippedEnd,
      fullStart,
      fullEnd,
      partial: clippedStart !== fullStart || clippedEnd !== fullEnd,
      studyDays: periodStudyDays,
      target: roundTarget(periodTarget),
      nonStudyLabel: nonStudyLabel(clippedStart, clippedEnd, periodStudyDays > 0),
    };
    weeks.push(period);
    studyDays += periodStudyDays;
    target += period.target;
    weekStart = shiftDate(fullStart, 7);
  }

  return { start, end, weeks, studyDays, target: roundTarget(target), nonStudyLabel: nonStudyLabel(start, end, studyDays > 0) };
}

/** Return the percentage of the prorated target, preserving values above 100%. */
export function loadPercent(count: number, target: number): number | null {
  if (!Number.isFinite(count) || !Number.isFinite(target) || target <= 0) return null;
  return Math.round((count / target) * 1000) / 10;
}
