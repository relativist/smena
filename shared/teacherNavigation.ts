import { chooseStudentLocation, dateIso, isValidIsoDate, mondayOf, nearestLessonDate, weekDatesFor } from "./studentNavigation.ts";
import type { PublicTeacherQuarter, PublicTeachersIndex } from "./teacherTypes.ts";
import type { PublicStudentQuarter } from "./studentTypes.ts";

export const TEACHER_STORAGE_KEY = "smena.teachers.teacher";

export { dateIso, isValidIsoDate, mondayOf, nearestLessonDate, weekDatesFor };

export type TeacherLocation = { teacherId: string; quarterId: string; date: string };
export type TeacherLocationOptions = {
  today: string;
  queryTeacher?: string;
  queryQuarter?: string;
  queryDate?: string;
  storedTeacher?: string;
  todayIsVacation?: boolean;
};

function asStudentQuarters(quarters: PublicTeacherQuarter[]): PublicStudentQuarter[] {
  return quarters.map(quarter => ({
    ...quarter,
    groups: quarter.teachers.map(teacher => ({ id: teacher.id, name: teacher.name, lessonDates: teacher.lessonDates })),
  }));
}

export function chooseTeacherLocation(index: PublicTeachersIndex | PublicTeacherQuarter[], options: TeacherLocationOptions): TeacherLocation | undefined {
  const quarters = Array.isArray(index) ? index : index.quarters;
  const selected = chooseStudentLocation(asStudentQuarters(quarters), {
    today: options.today,
    queryGroup: options.queryTeacher,
    queryQuarter: options.queryQuarter,
    queryDate: options.queryDate,
    storedGroup: options.storedTeacher,
    todayIsVacation: options.todayIsVacation,
  });
  return selected ? { teacherId: selected.groupId, quarterId: selected.quarterId, date: selected.date } : undefined;
}
