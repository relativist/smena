import type { Catalog } from "./catalog.ts";
import { calculateTeacherGaps } from "./teacherGaps.ts";
import { normalSchoolBreakMinutes, type BellSettings } from "./bellSchedule.ts";
import { calendarDay, defaultSchoolCalendar, type SchoolCalendar } from "./schoolCalendar.ts";
import type { Quarter } from "./plans.ts";
import type { Schedule } from "../src/editor.ts";

export type TeacherComfortSummary = {
  gapMinutes: number;
  gapCount: number;
  bothShiftDays: number;
};

export type TeacherScheduleComfortInput = {
  schedule: Schedule;
  catalog: Catalog;
  quarter: Quarter;
  teacherIds?: string[];
  bellSettings?: BellSettings;
  calendar?: SchoolCalendar;
};

export type TeacherScheduleComfortResult = {
  total: TeacherComfortSummary;
  teachers: Array<{ teacherId: string; name: string } & TeacherComfortSummary>;
};

type Occupancy = {
  id: string;
  date: string;
  groupId: string;
  start: number;
  duration: number;
  breakBefore?: number;
  breakAfter?: number;
  dayStart: number;
};

/** Summarizes long waits and mixed-shift days from the actual schedule times. */
export function summarizeTeacherScheduleComfort(
  { schedule, catalog, quarter, teacherIds, bellSettings, calendar }: TeacherScheduleComfortInput,
): TeacherScheduleComfortResult {
  const teachersById = new Map(catalog.teachers.map((teacher) => [teacher.id, teacher]));
  const groupNames = new Map(catalog.groups.map((group) => [group.id, group.name]));
  const fallbackBreak = normalSchoolBreakMinutes(bellSettings);
  const schoolCalendar = calendar ?? defaultSchoolCalendar();
  const occupancyByTeacher = new Map<string, Occupancy[]>();
  const groupsByTeacher = new Map<string, Set<string>>();
  const holidayByGroupDate = new Map<string, boolean>();

  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const separator = scheduleKey.lastIndexOf(":");
    const groupId = separator >= 0 ? scheduleKey.slice(0, separator) : scheduleKey;
    if (!groupNames.has(groupId)) continue;
    for (const day of days) {
      if (day.date < quarter.startDate || day.date > quarter.endDate) continue;
      const status = calendarDay(schoolCalendar, groupId, day.date);
      const holiday = status.kind === "study" ? false : status.holiday || Boolean(day.holiday);
      holidayByGroupDate.set(`${groupId}\0${day.date}`, holiday);

      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          const teacherId = lesson.teacherId;
          if (!teacherId || !teachersById.has(teacherId)) continue;
          const records = occupancyByTeacher.get(teacherId) ?? [];
          records.push({
            id: `${groupId}\0${day.date}\0${lesson.id}\0${slotIndex}`,
            date: day.date,
            groupId,
            start: time.start,
            duration: time.duration,
            dayStart: day.times[0]?.start ?? time.start,
            ...(slotIndex > 0 && day.times[slotIndex - 1]
              ? { breakBefore: Math.max(0, time.start - (day.times[slotIndex - 1]!.start + day.times[slotIndex - 1]!.duration)) }
              : {}),
            ...(day.times[slotIndex + 1]
              ? { breakAfter: Math.max(0, day.times[slotIndex + 1]!.start - (time.start + time.duration)) }
              : {}),
          });
          occupancyByTeacher.set(teacherId, records);
          const groups = groupsByTeacher.get(teacherId) ?? new Set<string>();
          groups.add(groupId);
          groupsByTeacher.set(teacherId, groups);
        }
      });
    }
  }

  const requestedIds = teacherIds ? new Set(teacherIds) : undefined;
  const summaries = new Map<string, TeacherComfortSummary>();
  for (const [teacherId, activities] of occupancyByTeacher) {
    if (requestedIds && !requestedIds.has(teacherId)) continue;
    const assignedGroups = [...(groupsByTeacher.get(teacherId) ?? [])];
    const activitiesByDate = new Map<string, Occupancy[]>();
    for (const activity of activities) {
      const dated = activitiesByDate.get(activity.date) ?? [];
      dated.push(activity);
      activitiesByDate.set(activity.date, dated);
    }

    const summary: TeacherComfortSummary = { gapMinutes: 0, gapCount: 0, bothShiftDays: 0 };
    for (const [date, dateActivities] of activitiesByDate) {
      // Match the teacher page: a date is a holiday only when every group assigned
      // to this teacher is non-teaching on that date.
      const isHoliday = assignedGroups.length > 0 && assignedGroups.every((groupId) =>
        holidayByGroupDate.get(`${groupId}\0${date}`) ?? false);
      if (isHoliday) continue;

      const gaps = calculateTeacherGaps(dateActivities, fallbackBreak);
      summary.gapMinutes += gaps.reduce((sum, gap) => sum + gap.minutes, 0);
      summary.gapCount += gaps.length;

      const shifts = new Set(dateActivities.map((activity) => activity.dayStart < 720 ? "morning" : "afternoon"));
      if (shifts.size > 1) summary.bothShiftDays += 1;
    }
    summaries.set(teacherId, summary);
  }

  const teachers = [...summaries.entries()]
    .map(([teacherId, summary]) => ({ teacherId, name: teachersById.get(teacherId)!.name, ...summary }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.teacherId.localeCompare(b.teacherId));
  const total = teachers.reduce<TeacherComfortSummary>((sum, teacher) => ({
    gapMinutes: sum.gapMinutes + teacher.gapMinutes,
    gapCount: sum.gapCount + teacher.gapCount,
    bothShiftDays: sum.bothShiftDays + teacher.bothShiftDays,
  }), { gapMinutes: 0, gapCount: 0, bothShiftDays: 0 });
  return { total, teachers };
}
