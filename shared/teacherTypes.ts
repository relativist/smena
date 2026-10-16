import type { Quarter } from "./plans.ts";
import type { PublicPublication, PublicStudentLesson } from "./studentTypes.ts";
export type { PublicPublication } from "./studentTypes.ts";

export type PublicTeacher = { id: string; name: string; lessonDates: string[] };
export type PublicTeacherQuarter = Quarter & { publication: PublicPublication; teachers: PublicTeacher[] };
export type PublicTeachersIndex = { quarters: PublicTeacherQuarter[] };
export type PublicTeacherGroup = {
  id: string;
  name: string;
  /** Lesson number in this group, starting at 1. */
  slot: number;
  /** Actual start of the first lesson slot in this group's published day. */
  dayStart: number;
  subgroup?: { id?: string; name: string; number?: number };
};
export type PublicTeacherLesson = Pick<PublicStudentLesson, "id" | "start" | "duration" | "subject" | "event" | "lessonKind" | "room"> & {
  groups: PublicTeacherGroup[];
};
export type PublicTeacherDay = {
  date: string;
  holiday?: boolean;
  holidayKind?: "vacation" | "non-study";
  calendarLabel?: string;
  lessons: PublicTeacherLesson[];
  /** Long waits between lessons, calculated from the immutable published schedule. */
  gaps?: Array<{ start: number; end: number; minutes: number; normalBreakMinutes: number }>;
};
export type PublicTeacherSchedule = {
  quarter: Quarter;
  publication: PublicPublication;
  teacher: { id: string; name: string };
  days: PublicTeacherDay[];
};
