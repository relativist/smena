import { isValidIsoDate, mondayOf } from "./studentNavigation.ts";
import type { PublicStudentQuarter } from "./studentTypes.ts";

const DAY_MS = 86400000;

function validQuarter(quarter: PublicStudentQuarter): boolean {
  return isValidIsoDate(quarter.startDate) && isValidIsoDate(quarter.endDate) && quarter.startDate <= quarter.endDate;
}

export function studentQuarterWeeks(quarter: Pick<PublicStudentQuarter, "startDate" | "endDate">): string[] {
  if (!isValidIsoDate(quarter.startDate) || !isValidIsoDate(quarter.endDate) || quarter.startDate > quarter.endDate) return [];
  const first = Date.parse(`${mondayOf(quarter.startDate)}T00:00:00Z`);
  const last = Date.parse(`${mondayOf(quarter.endDate)}T00:00:00Z`);
  const weeks: string[] = [];
  for (let time = first; time <= last; time += 7 * DAY_MS) weeks.push(new Date(time).toISOString().slice(0, 10));
  return weeks;
}

function overlapsQuarter(monday: string, quarter: PublicStudentQuarter): boolean {
  const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  return monday <= quarter.endDate && sunday >= quarter.startDate;
}

function quarterWeekDate(date: string, quarter: PublicStudentQuarter): string {
  // The caller has established week overlap; clamp the anchor before finding its Monday.
  const anchor = date < quarter.startDate ? quarter.startDate : date > quarter.endDate ? quarter.endDate : date;
  return mondayOf(anchor);
}

export function chooseStudentWeekLocation(
  quarters: PublicStudentQuarter[],
  options: { today: string; queryQuarter?: string; queryDate?: string },
): { quarterId: string; date: string } | undefined {
  const sorted = quarters.filter(validQuarter).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (!sorted.length) return undefined;

  const validToday = isValidIsoDate(options.today) ? options.today : undefined;
  const queryMonday = isValidIsoDate(options.queryDate) ? mondayOf(options.queryDate) : undefined;
  const explicit = sorted.find(quarter => quarter.id === options.queryQuarter);
  if (explicit) {
    if (queryMonday && overlapsQuarter(queryMonday, explicit)) return { quarterId: explicit.id, date: quarterWeekDate(options.queryDate!, explicit) };
    const fallback = validToday ?? explicit.startDate;
    return { quarterId: explicit.id, date: mondayOf(fallback < explicit.startDate ? explicit.startDate : fallback > explicit.endDate ? explicit.endDate : fallback) };
  }

  if (queryMonday) {
    const matched = sorted.find(quarter => overlapsQuarter(queryMonday, quarter));
    if (matched) return { quarterId: matched.id, date: quarterWeekDate(options.queryDate!, matched) };
  }

  const today = validToday ?? sorted.at(-1)!.endDate;
  const currentWeek = mondayOf(today);
  const weekend = [0, 6].includes(new Date(`${today}T00:00:00Z`).getUTCDay());
  const currentQuarter = sorted.find(quarter => quarter.startDate <= today && today <= quarter.endDate);
  const currentWeekQuarter = currentQuarter && overlapsQuarter(currentWeek, currentQuarter) && currentQuarter.groups.some(group =>
    group.lessonDates.some(date => isValidIsoDate(date) && mondayOf(date) === currentWeek && (!weekend || date >= today)),
  ) ? currentQuarter : undefined;
  if (currentWeekQuarter) return { quarterId: currentWeekQuarter.id, date: currentWeek };

  const lessons = sorted.flatMap(quarter => quarter.groups.flatMap(group => group.lessonDates
    .filter(isValidIsoDate)
    .map(date => ({ quarter, date }))))
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = lessons.find(item => item.date >= today);
  const selected = next ?? lessons.at(-1);
  if (selected && overlapsQuarter(mondayOf(selected.date), selected.quarter)) {
    return { quarterId: selected.quarter.id, date: mondayOf(selected.date) };
  }

  const fallbackQuarter = currentQuarter ?? sorted.at(-1)!;
  const anchor = today < fallbackQuarter.startDate ? fallbackQuarter.startDate : today > fallbackQuarter.endDate ? fallbackQuarter.endDate : today;
  return { quarterId: fallbackQuarter.id, date: mondayOf(anchor) };
}
