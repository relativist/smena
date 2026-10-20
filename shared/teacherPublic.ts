import type { CatalogTeacher } from "./catalog.ts";
import type { PublicationSnapshot } from "./publicationTypes.ts";
import { calendarDay, defaultSchoolCalendar } from "./schoolCalendar.ts";
import { publicSubgroupNumber } from "./studentPublic.ts";
import { normalSchoolBreakMinutes } from "./bellSchedule.ts";
import { calculateTeacherGaps } from "./teacherGaps.ts";
import type {
  PublicPublication,
  PublicTeacherDay,
  PublicTeacherGroup,
  PublicTeacherLesson,
  PublicTeacherQuarter,
  PublicTeacherSchedule,
} from "./teacherTypes.ts";

export type PublicTeacherProjection = {
  quarter: PublicTeacherQuarter;
  schedules: Map<string, PublicTeacherSchedule>;
};

export type PublicTeacherProjectionRange = { startDate: string; endDate: string };

type LessonSource = {
  date: string;
  groupId: string;
  groupName: string;
  lesson: PublicationSnapshot["schedule"][string][number]["slots"][number][number];
  slot: number;
  dayStart: number;
  start: number;
  duration: number;
  breakBefore?: number;
  breakAfter?: number;
};

function groupIdFromKey(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function datesInclusive(start: string, end: string): string[] {
  const date = new Date(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  const dates: string[] = [];
  while (date.getTime() <= endTime) {
    dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function publicGroup(source: LessonSource, snapshot: PublicationSnapshot): PublicTeacherGroup {
  const lesson = source.lesson;
  const subgroup = lesson.subgroupId
    ? snapshot.catalog.subgroups.find((entry) => entry.id === lesson.subgroupId)
    : snapshot.catalog.subgroups.find((entry) => entry.groupId === source.groupId && entry.name === lesson.subgroup);
  const subgroupName = subgroup?.name ?? lesson.subgroup;
  const number = subgroupName
    ? publicSubgroupNumber(snapshot, source.groupId, subgroup?.id ?? lesson.subgroupId, subgroupName)
    : undefined;
  return {
    id: source.groupId,
    name: source.groupName,
    slot: source.slot,
    dayStart: source.dayStart,
    ...(subgroup || lesson.subgroup
      ? {
          subgroup: {
            ...(subgroup ? { id: subgroup.id } : lesson.subgroupId ? { id: lesson.subgroupId } : {}),
            name: subgroupName!,
            ...(number !== undefined ? { number } : {}),
          },
        }
      : {}),
  };
}

function occurrenceKey(source: LessonSource, teacherId: string): string {
  const lesson = source.lesson;
  if (!lesson.jointId) return `lesson\0${source.groupId}\0${lesson.id}\0${source.slot}`;
  return [
    "joint",
    lesson.jointId,
    teacherId,
    source.start,
    source.duration,
    lesson.subjectId,
    lesson.event ?? "",
    lesson.lessonKind ?? "regular",
    lesson.roomId ?? lesson.room ?? "",
  ].join("\0");
}

function projectLesson(sources: LessonSource[], snapshot: PublicationSnapshot): PublicTeacherLesson {
  const first = sources[0]!;
  const lesson = first.lesson;
  const subject = snapshot.catalog.subjects.find((entry) => entry.id === lesson.subjectId);
  const room = lesson.roomId ? snapshot.catalog.rooms.find((entry) => entry.id === lesson.roomId) : undefined;
  const groups = [...new Map(sources.map((source) => {
    const item = publicGroup(source, snapshot);
    return [`${item.id}\0${item.slot}\0${item.subgroup?.id ?? item.subgroup?.name ?? ""}`, item] as const;
  })).values()].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id, "ru", { numeric: true }) || a.slot - b.slot);
  const ids = sources.map((source) => source.lesson.id).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return {
    id: ids[0]!,
    start: first.start,
    duration: first.duration,
    ...(subject && lesson.subjectId !== "event"
      ? { subject: { id: subject.id, name: subject.name, shortName: subject.shortName, color: subject.color } }
      : {}),
    ...(lesson.event ? { event: lesson.event } : {}),
    lessonKind: lesson.lessonKind === "lab" ? "lab" : "regular",
    ...((room || lesson.room)
      ? { room: { ...(room ? { id: room.id } : {}), name: room?.name ?? lesson.room! } }
      : {}),
    groups,
  };
}

function storedCalendarStatus(snapshot: PublicationSnapshot, groupId: string, date: string, storedHoliday: boolean) {
  const status = snapshot.calendar
    ? calendarDay(snapshot.calendar, groupId, date)
    : calendarDay(defaultSchoolCalendar(), groupId, date);
  if (status.kind === "study") return { holiday: false, kind: undefined, label: undefined };
  if (status.holiday) return {
    holiday: true,
    kind: status.kind === "holiday" ? "vacation" as const : "non-study" as const,
    label: status.label,
  };
  return storedHoliday
    ? { holiday: true, kind: "vacation" as const, label: "Каникулы" }
    : { holiday: false, kind: undefined, label: undefined };
}

function teacherDayStatus(snapshot: PublicationSnapshot, date: string, assignedGroups: string[], dayByGroupDate: Map<string, PublicationSnapshot["schedule"][string][number]>) {
  if (!assignedGroups.length) {
    const globalCalendar = snapshot.calendar ?? defaultSchoolCalendar();
    const status = calendarDay(globalCalendar, "__public_teacher_global__", date);
    return status.holiday
      ? { holiday: true, holidayKind: status.kind === "holiday" ? "vacation" as const : "non-study" as const, calendarLabel: status.label }
      : { holiday: false };
  }
  const statuses = assignedGroups.map((groupId) => {
    const day = dayByGroupDate.get(`${groupId}\0${date}`);
    return storedCalendarStatus(snapshot, groupId, date, Boolean(day?.holiday));
  });
  if (!statuses.every((status) => status.holiday)) return { holiday: false };
  const allVacation = statuses.every((status) => status.kind === "vacation");
  const labels = [...new Set(statuses.map((status) => status.label).filter((label): label is string => Boolean(label)))];
  return {
    holiday: true,
    holidayKind: allVacation ? "vacation" as const : "non-study" as const,
    calendarLabel: labels.length === 1 ? labels[0] : allVacation ? "Каникулы" : "Нерабочий день",
  };
}

/** Create an allowlisted teacher-facing view of one immutable publication snapshot. */
export function projectPublicTeachers(
  snapshot: PublicationSnapshot,
  publication: PublicPublication,
  range?: PublicTeacherProjectionRange,
): PublicTeacherProjection {
  const groupNames = new Map(snapshot.catalog.groups.map((group) => [group.id, group.name]));
  const teacherById = new Map(snapshot.catalog.teachers.map((teacher) => [teacher.id, teacher]));
  const sourcesByTeacher = new Map<string, LessonSource[]>();
  const groupsByTeacher = new Map<string, Set<string>>();
  const dayByGroupDate = new Map<string, PublicationSnapshot["schedule"][string][number]>();

  for (const [key, days] of Object.entries(snapshot.schedule)) {
    const groupId = groupIdFromKey(key);
    for (const day of days) {
      if (day.date < snapshot.quarter.startDate || day.date > snapshot.quarter.endDate) continue;
      dayByGroupDate.set(`${groupId}\0${day.date}`, day);
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          const teacherId = lesson.teacherId;
          if (!teacherId || !teacherById.has(teacherId)) continue;
          const groupName = groupNames.get(groupId);
          if (!groupName) continue;
          const source: LessonSource = {
            date: day.date,
            groupId,
            groupName,
            lesson,
            slot: slotIndex + 1,
            dayStart: day.times[0]?.start ?? time.start,
            start: time.start,
            duration: time.duration,
            ...(slotIndex > 0 && day.times[slotIndex - 1]
              ? { breakBefore: Math.max(0, time.start - (day.times[slotIndex - 1]!.start + day.times[slotIndex - 1]!.duration)) }
              : {}),
            ...(day.times[slotIndex + 1]
              ? { breakAfter: Math.max(0, day.times[slotIndex + 1]!.start - (time.start + time.duration)) }
              : {}),
          };
          const entries = sourcesByTeacher.get(teacherId) ?? [];
          entries.push(source);
          sourcesByTeacher.set(teacherId, entries);
          const groupIds = groupsByTeacher.get(teacherId) ?? new Set<string>();
          groupIds.add(groupId);
          groupsByTeacher.set(teacherId, groupIds);
        }
      });
    }
  }

  const teachers: CatalogTeacher[] = snapshot.catalog.teachers
    .filter((teacher) => !teacher.archived || (sourcesByTeacher.get(teacher.id)?.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id, "ru", { numeric: true }));
  const schedules = new Map<string, PublicTeacherSchedule>();
  const publicTeachers = teachers.map((teacher) => {
    const sources = sourcesByTeacher.get(teacher.id) ?? [];
    return {
      id: teacher.id,
      name: teacher.name,
      lessonDates: [...new Set(sources.map((source) => source.date))].sort(),
    };
  });

  for (const teacher of teachers) {
    const sources = sourcesByTeacher.get(teacher.id) ?? [];
    const assignedGroups = [...(groupsByTeacher.get(teacher.id) ?? [])].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
    const byDate = new Map<string, LessonSource[]>();
    for (const source of sources) {
      const entries = byDate.get(source.date) ?? [];
      entries.push(source);
      byDate.set(source.date, entries);
    }
    const fallbackNormalBreakMinutes = normalSchoolBreakMinutes(snapshot.bellSettings);
    const firstDate = range && range.startDate > snapshot.quarter.startDate ? range.startDate : snapshot.quarter.startDate;
    const lastDate = range && range.endDate < snapshot.quarter.endDate ? range.endDate : snapshot.quarter.endDate;
    const projectionDates = firstDate <= lastDate ? datesInclusive(firstDate, lastDate) : [];
    const days: PublicTeacherDay[] = projectionDates.map((date) => {
      const dateSources = byDate.get(date) ?? [];
      const grouped = new Map<string, LessonSource[]>();
      for (const source of dateSources) {
        const key = occurrenceKey(source, teacher.id);
        const values = grouped.get(key) ?? [];
        values.push(source);
        grouped.set(key, values);
      }
      const lessons = [...grouped.values()]
        .map((entries) => projectLesson(entries, snapshot))
        .sort((a, b) => a.start - b.start || a.duration - b.duration || a.id.localeCompare(b.id, "en", { numeric: true }));
      const calendar = teacherDayStatus(snapshot, date, assignedGroups, dayByGroupDate);
      const gaps = calendar.holiday ? [] : calculateTeacherGaps(dateSources.map((source) => ({
        id: `${source.groupId}\0${source.lesson.id}\0${source.slot}`,
        start: source.start,
        duration: source.duration,
        breakBefore: source.breakBefore,
        breakAfter: source.breakAfter,
      })), fallbackNormalBreakMinutes);
      return {
        date,
        ...calendar,
        lessons,
        ...(gaps.length ? { gaps } : {}),
      };
    });
    schedules.set(teacher.id, {
      quarter: snapshot.quarter,
      publication,
      teacher: { id: teacher.id, name: teacher.name },
      days,
    });
  }

  return { quarter: { ...snapshot.quarter, publication, teachers: publicTeachers }, schedules };
}
