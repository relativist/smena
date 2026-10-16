import type { CatalogGroup } from "./catalog.ts";
import type {
  PublicPublication,
  PublicStudentDay,
  PublicStudentGroup,
  PublicStudentLesson,
  PublicStudentQuarter,
  PublicStudentSchedule,
} from "./studentTypes.ts";
import type { PublicationSnapshot } from "./publicationTypes.ts";
import { calendarDay } from "./schoolCalendar.ts";
import { resolveSubjectIconId } from "./subjectIcons.ts";

export type PublicStudentProjection = {
  quarter: PublicStudentQuarter;
  schedules: Map<string, PublicStudentSchedule>;
};

function scheduleGroupId(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

export function publicSubgroupNumber(snapshot: PublicationSnapshot, groupId: string, subgroupId: string | undefined, name: string | undefined): number | undefined {
  const groupSubgroups = snapshot.catalog.subgroups.filter((entry) => entry.groupId === groupId);
  const entry = subgroupId
    ? groupSubgroups.find((item) => item.id === subgroupId)
    : groupSubgroups.find((item) => item.name === name);
  const label = entry?.name ?? name ?? "";
  const match = /^(?:подгруппа\s*(\d+)|(\d+)\s*подгруппа)$/iu.exec(label.trim());
  const parsed = match ? Number(match[1] ?? match[2]) : NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  const index = entry ? groupSubgroups.findIndex((item) => item.id === entry.id) : -1;
  return index >= 0 ? index + 1 : undefined;
}

function makeLesson(
  lesson: PublicationSnapshot["schedule"][string][number]["slots"][number][number],
  groupId: string,
  slot: number,
  start: number,
  duration: number,
  snapshot: PublicationSnapshot,
  jointGroups: Array<{ id: string; name: string }>,
): PublicStudentLesson {
  const subject = snapshot.catalog.subjects.find((entry) => entry.id === lesson.subjectId);
  const teacher = lesson.teacherId
    ? snapshot.catalog.teachers.find((entry) => entry.id === lesson.teacherId)
    : undefined;
  const room = lesson.roomId
    ? snapshot.catalog.rooms.find((entry) => entry.id === lesson.roomId)
    : undefined;
  const subgroup = lesson.subgroupId
    ? snapshot.catalog.subgroups.find((entry) => entry.id === lesson.subgroupId)
    : undefined;
  return {
    id: lesson.id,
    slot,
    start,
    duration,
    ...(subject && lesson.subjectId !== "event"
      ? { subject: { id: subject.id, name: subject.name, shortName: subject.shortName, color: subject.color, iconId: resolveSubjectIconId(subject) } }
      : {}),
    ...(lesson.event ? { event: lesson.event } : {}),
    lessonKind: lesson.lessonKind === "lab" ? "lab" : "regular",
    ...((teacher || lesson.teacher)
      ? { teacher: { ...(teacher ? { id: teacher.id } : {}), name: teacher?.name ?? lesson.teacher! } }
      : {}),
    ...((room || lesson.room)
      ? { room: { ...(room ? { id: room.id } : {}), name: room?.name ?? lesson.room! } }
      : {}),
    ...((subgroup || lesson.subgroup)
      ? {
          subgroup: {
            ...(subgroup ? { id: subgroup.id } : {}),
            name: subgroup?.name ?? lesson.subgroup!,
            ...(publicSubgroupNumber(snapshot, groupId, lesson.subgroupId, subgroup?.name ?? lesson.subgroup) !== undefined
              ? { number: publicSubgroupNumber(snapshot, groupId, lesson.subgroupId, subgroup?.name ?? lesson.subgroup) }
              : {}),
          },
        }
      : {}),
    ...(jointGroups.length > 1 ? { jointGroups } : {}),
  };
}

/** Project a stored publication snapshot into the student-only allowlisted response. */
export function projectPublicStudents(
  snapshot: PublicationSnapshot,
  publication: PublicPublication,
): PublicStudentProjection {
  const groupsWithLessons = new Set<string>();
  const groupById = new Map(snapshot.catalog.groups.map((group) => [group.id, group]));
  const locations = new Map<string, Array<{ id: string; name: string }>>();

  for (const [key, days] of Object.entries(snapshot.schedule)) {
    const groupId = scheduleGroupId(key);
    for (const day of days) {
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          groupsWithLessons.add(groupId);
          if (!lesson.jointId) continue;
          const occurrence = `${lesson.jointId}\0${day.date}\0${time.start}\0${time.duration}`;
          const participants = locations.get(occurrence) ?? [];
          const group = groupById.get(groupId);
          if (group && !participants.some((entry) => entry.id === groupId)) participants.push({ id: groupId, name: group.name });
          locations.set(occurrence, participants);
        }
      });
    }
  }

  const groups: CatalogGroup[] = snapshot.catalog.groups
    .filter((group) => !group.archived || groupsWithLessons.has(group.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id, "ru", { numeric: true }));
  const schedules = new Map<string, PublicStudentSchedule>();
  const publicGroups: PublicStudentGroup[] = groups.map((group) => {
    const dates = new Set<string>();
    for (const [key, scheduleDays] of Object.entries(snapshot.schedule)) {
      if (scheduleGroupId(key) !== group.id) continue;
      for (const day of scheduleDays) {
        if (day.slots.some((slot) => slot.length > 0)) dates.add(day.date);
      }
    }
    return { id: group.id, name: group.name, lessonDates: [...dates].sort() };
  });

  for (const group of groups) {
    const scheduleDays = Object.entries(snapshot.schedule)
      .filter(([key]) => scheduleGroupId(key) === group.id)
      .flatMap(([, days]) => days)
      .sort((a, b) => a.date.localeCompare(b.date));
    const days: PublicStudentDay[] = scheduleDays.map((day) => {
      const storedCalendar = snapshot.calendar
        ? calendarDay(snapshot.calendar, group.id, day.date)
        : { holiday: false, kind: "regular" as const, label: "Учебный день" };
      const fallbackStoredHoliday = Boolean(day.holiday && storedCalendar.kind === "regular");
      const holiday = storedCalendar.kind === "study"
        ? false
        : Boolean(storedCalendar.holiday || fallbackStoredHoliday);
      const holidayKind = holiday
        ? (storedCalendar.kind === "holiday" || fallbackStoredHoliday ? "vacation" : "non-study")
        : undefined;
      const calendarLabel = holiday
        ? (fallbackStoredHoliday ? "Каникулы" : storedCalendar.label)
        : undefined;
      const publicLessons: PublicStudentLesson[] = [];
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          const occurrence = lesson.jointId
            ? `${lesson.jointId}\0${day.date}\0${time.start}\0${time.duration}`
            : "";
          publicLessons.push(makeLesson(
            lesson,
            group.id,
            slotIndex + 1,
            time.start,
            time.duration,
            snapshot,
            occurrence ? locations.get(occurrence) ?? [] : [],
          ));
        }
      });
      return {
        date: day.date,
        slotCount: day.slots.length,
        holiday,
        ...(calendarLabel ? { calendarLabel } : {}),
        ...(holidayKind ? { holidayKind } : {}),
        lessons: publicLessons,
      };
    });
    schedules.set(group.id, {
      quarter: snapshot.quarter,
      publication,
      group: { id: group.id, name: group.name },
      days,
    });
  }

  return {
    quarter: { ...snapshot.quarter, publication, groups: publicGroups },
    schedules,
  };
}
