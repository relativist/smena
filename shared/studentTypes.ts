import type { Quarter } from "./plans.ts";
import type { SubjectIconId } from "./subjectIcons.ts";

export type PublicPublication = { version: number; publishedAt: string };
export type PublicStudentGroup = { id: string; name: string; lessonDates: string[] };
export type PublicStudentQuarter = Quarter & { publication: PublicPublication; groups: PublicStudentGroup[] };
export type PublicStudentsIndex = { quarters: PublicStudentQuarter[] };

export type PublicStudentLesson = {
  id: string;
  slot: number;
  start: number;
  duration: number;
  subject?: { id: string; name: string; shortName: string; color: string; iconId?: SubjectIconId | null };
  event?: string;
  lessonKind: "regular" | "lab";
  teacher?: { id?: string; name: string };
  room?: { id?: string; name: string };
  subgroup?: { id?: string; name: string; number?: number };
  jointGroups?: Array<{ id: string; name: string }>;
};

export type PublicStudentDay = {
  date: string;
  slotCount: number;
  holiday: boolean;
  calendarLabel?: string;
  holidayKind?: "vacation" | "non-study";
  lessons: PublicStudentLesson[];
};

export type PublicStudentSchedule = {
  quarter: Quarter;
  publication: PublicPublication;
  group: { id: string; name: string };
  days: PublicStudentDay[];
};

export type PublicStudentsWeekSchedule = {
  quarter: Quarter;
  publication: PublicPublication;
  weekStart: string;
  weekEnd: string;
  groups: Array<{ id: string; name: string; days: PublicStudentDay[] }>;
};

export type PublicStudentsDaySchedule = {
  requestedDate: string;
  date: string;
  hasPublications: boolean;
  groups: Array<{ id: string; name: string; day?: PublicStudentDay }>;
};
