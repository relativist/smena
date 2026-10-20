import type { PublicStudentDay, PublicStudentLesson } from "./studentTypes.ts";
import type { SchedulePrintPreview } from "./schedulePrintTypes.ts";
import { groupGrade, sortDayGroups } from "./studentDayNavigation.ts";

export type PrintDay = {
  date: string;
  weekday: number;
  inQuarter: boolean;
  holidayLabel?: string;
  lessons: PublicStudentLesson[];
};
export type PrintRow = { slot: number; start?: number; days: Array<PublicStudentLesson[]>; continued?: boolean };
export type SplitPrintRowResult = { rows: PrintRow[]; heightsMm: number[]; oversizedCard: boolean };

export type PrintDateTable = {
  group: { id: string; name: string };
  days: PrintDay[];
  rows: PrintRow[];
  columnHeadings: string[];
  date: string;
};

const addDays = (date: string, count: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
};

export function printWeekDays(
  days: PublicStudentDay[],
  weekStart: string,
  quarter: { startDate: string; endDate: string },
): PrintDay[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return Array.from({ length: 7 }, (_, weekday) => {
    const date = addDays(weekStart, weekday);
    const day = byDate.get(date);
    return {
      date,
      weekday,
      inQuarter: date >= quarter.startDate && date <= quarter.endDate,
      holidayLabel: day?.holiday ? day.calendarLabel || (day.holidayKind === "vacation" ? "Каникулы" : "Неучебный день") : undefined,
      lessons: [...(day?.lessons ?? [])].sort((a, b) => a.slot - b.slot || a.start - b.start || a.id.localeCompare(b.id)),
    };
  });
}

/** Creates one daily overview table per grade, split into groups of at most seven columns. */
export function printDateTables(preview: SchedulePrintPreview, date: string): PrintDateTable[] {
  if (date < preview.quarter.startDate || date > preview.quarter.endDate || date < preview.weekStart || date > preview.weekEnd) return [];
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const groups = sortDayGroups(preview.groups.map(({ group, days }) => ({
    ...group,
    day: days.find((day) => day.date === date),
  })));
  const gradeGroups = new Map<number | undefined, typeof groups>();
  for (const group of groups) {
    const grade = groupGrade(group.name);
    const bucket = gradeGroups.get(grade) ?? [];
    bucket.push(group);
    gradeGroups.set(grade, bucket);
  }
  const tables: PrintDateTable[] = [];
  for (const gradeGroup of gradeGroups.values()) {
    for (let start = 0; start < gradeGroup.length; start += 7) {
      const chunk = gradeGroup.slice(start, start + 7);
      const days: PrintDay[] = chunk.map((group) => {
        const day = group.day;
        return {
          date,
          weekday,
          inQuarter: true,
          holidayLabel: day?.holiday ? day.calendarLabel || (day.holidayKind === "vacation" ? "Каникулы" : "Неучебный день") : undefined,
          lessons: [...(day?.lessons ?? [])].sort((a, b) => a.slot - b.slot || a.start - b.start || a.id.localeCompare(b.id)),
        };
      });
      tables.push({
        group: { id: `${date}:${chunk.map((group) => group.id).join(",")}`, name: "Расписание на день" },
        days,
        rows: printTimeRows(days),
        columnHeadings: chunk.map((group) => group.name),
        date,
      });
    }
  }
  return tables;
}

/** Rows are aligned by assigned lesson number and trim only empty trailing numbers. */
export function printRows(days: PrintDay[]): PrintRow[] {
  const maxSlot = Math.max(0, ...days.flatMap((day) => day.lessons.map((lesson) => lesson.slot)));
  if (!maxSlot) return [{ slot: 0, days: days.map(() => []) }];
  return Array.from({ length: maxSlot }, (_, index) => ({
    slot: index + 1,
    days: days.map((day) => day.lessons.filter((lesson) => lesson.slot === index + 1)),
  }));
}

/** Aligns lessons by actual start time and lesson number for compact shared-time tables. */
export function printTimeRows(days: PrintDay[]): PrintRow[] {
  const keys = new Map<string, { slot: number; start: number }>();
  for (const day of days) {
    for (const lesson of day.lessons) keys.set(`${lesson.slot}:${lesson.start}`, { slot: lesson.slot, start: lesson.start });
  }
  const rows = [...keys.values()].sort((a, b) => a.start - b.start || a.slot - b.slot);
  if (!rows.length) return [{ slot: 0, days: days.map(() => []) }];
  return rows.map(({ slot, start }) => ({
    slot,
    start,
    days: days.map((day) => day.lessons.filter((lesson) => lesson.slot === slot && lesson.start === start)),
  }));
}

/** Greedy row-boundary pagination. Always returns one page for an empty or oversized row. */
export function packPrintRows(rowHeightsMm: number[], availableMm: number) {
  const pages: Array<{ start: number; end: number }> = [];
  if (!rowHeightsMm.length) return [{ start: 0, end: 0 }];
  let start = 0;
  let used = 0;
  for (let index = 0; index < rowHeightsMm.length; index += 1) {
    const height = Math.max(0, rowHeightsMm[index]);
    if (index > start && used + height > availableMm) {
      pages.push({ start, end: index });
      start = index;
      used = 0;
    }
    used += height;
  }
  pages.push({ start, end: rowHeightsMm.length });
  return pages;
}

/** Splits a tall lesson-number row between lesson cards while retaining its slot number. */
export function splitOversizedPrintRow(row: PrintRow, cardHeightsByDay: number[][], availableMm: number): SplitPrintRowResult {
  const chunksByDay = row.days.map((cards, dayIndex) => {
    const heights = cardHeightsByDay[dayIndex] ?? [];
    const chunks: Array<{ cards: PublicStudentLesson[]; height: number }> = [];
    let currentCards: PublicStudentLesson[] = [];
    let currentHeight = 0;
    for (const [cardIndex, card] of cards.entries()) {
      const height = Math.max(0, heights[cardIndex] ?? 0);
      if (height > availableMm) return { chunks, oversizedCard: true };
      if (currentCards.length && currentHeight + height > availableMm) {
        chunks.push({ cards: currentCards, height: currentHeight });
        currentCards = [];
        currentHeight = 0;
      }
      currentCards.push(card);
      currentHeight += height;
    }
    if (currentCards.length) chunks.push({ cards: currentCards, height: currentHeight });
    return { chunks, oversizedCard: false };
  });
  if (chunksByDay.some(day => day.oversizedCard)) return { rows: [row], heightsMm: [availableMm + 1], oversizedCard: true };
  const count = Math.max(1, ...chunksByDay.map(day => day.chunks.length));
  const rows = Array.from({ length: count }, (_, fragment) => ({
    slot: row.slot,
    ...(row.start === undefined ? {} : { start: row.start }),
    continued: fragment > 0 || row.continued,
    days: row.days.map((_, dayIndex) => chunksByDay[dayIndex].chunks[fragment]?.cards ?? []),
  }));
  const heightsMm = Array.from({ length: count }, (_, fragment) => Math.max(0, ...chunksByDay.map(day => day.chunks[fragment]?.height ?? 0)) + 2.7);
  return { rows, heightsMm, oversizedCard: false };
}

export const printLessonDisplay = (lesson: PublicStudentLesson) => ({
  time: clock(lesson.start),
  subject: lesson.event || lesson.subject?.shortName?.trim() || lesson.subject?.name?.trim() || "Занятие",
  teacher: teacherInitials(lesson.teacher?.name),
  room: lesson.room?.name.replace(/^\s*кабинет\s*/i, "").trim() || "",
  subgroup: lesson.subgroup?.number ? `/${lesson.subgroup.number}` : lesson.subgroup?.name ? `/${lesson.subgroup.name}` : "",
  joint: lesson.jointGroups?.map((group) => group.name).filter(Boolean).join(", ") ?? "",
});

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
function teacherInitials(name?: string) {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  return `${parts[0] ?? ""}${parts[1] ? ` ${parts[1][0]}.` : ""}${parts[2] ? `${parts[2][0]}.` : ""}`;
}
