import type { Catalog } from "./catalog.ts";
import { findUnavailability } from "./unavailability.ts";
import { findTeacherConflicts, type TeacherOccupancy } from "./teacherConflicts.ts";
import { teacherLabel } from "./catalog.ts";
import type { EditorLesson, Schedule } from "../src/editor.ts";

export type TeacherReplacementSkip = { lessonId: string; reason: string };
export type TeacherReplacementPreview = {
  schedule: Schedule;
  changedLessonIds: string[];
  skipped: TeacherReplacementSkip[];
};

type Located = {
  groupId: string;
  lesson: EditorLesson;
  date: string;
  start: number;
  end: number;
};

function locate(schedule: Schedule): Located[] {
  const result: Located[] = [];
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    days.forEach(day => day.slots.forEach((slot, slotIndex) => {
      const time = day.times[slotIndex];
      if (!time) return;
      slot.forEach(lesson => result.push({ groupId, lesson, date: day.date, start: time.start, end: time.start + time.duration }));
    }));
  }
  return result;
}

function conflictOccupancy(item: Located, teacherId: string): TeacherOccupancy {
  return { lessonId: item.lesson.id, groupId: item.groupId, date: item.date, start: item.start, end: item.end, teacherId, jointId: item.lesson.jointId, subjectId: item.lesson.subjectId, event: item.lesson.event, lessonKind: item.lesson.lessonKind, roomId: item.lesson.roomId };
}

/** Preview replacement across selected lessons; linked joint lessons are always changed as a unit. */
export function previewTeacherReplacement(schedule: Schedule, catalog: Catalog, lessonIds: string[], teacherId: string): TeacherReplacementPreview {
  const selected = new Set(lessonIds);
  const located = locate(schedule);
  const byId = new Map(located.map(item => [item.lesson.id, item]));
  const skipped: TeacherReplacementSkip[] = [];
  const units: Located[][] = [];
  const seen = new Set<string>();
  for (const id of selected) {
    const item = byId.get(id);
    if (!item) { skipped.push({ lessonId: id, reason: "Урок не найден в расписании." }); continue; }
    const unitKey = item.lesson.jointId ? `joint:${item.date}:${item.lesson.jointId}` : `lesson:${item.groupId}:${item.date}:${id}`;
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);
    units.push(item.lesson.jointId
      ? located.filter(candidate => candidate.date === item.date && candidate.lesson.jointId === item.lesson.jointId)
      : [item]);
  }

  let next = schedule;
  const changedLessonIds: string[] = [];
  for (const unit of units) {
    const ids = unit.map(item => item.lesson.id);
    const reasonForUnit = (reason: string) => ids.forEach(id => skipped.push({ lessonId: id, reason }));
    if (unit.some(item => item.lesson.event || item.lesson.subjectId === "event")) {
      reasonForUnit("Общее мероприятие нельзя переназначить автоматически; измените ответственного в карточке мероприятия.");
      continue;
    }
    const teacher = catalog.teachers.find(item => item.id === teacherId && !item.archived);
    if (!teacher) { reasonForUnit("Выбранный преподаватель отсутствует или архивирован."); continue; }
    if (unit.some(item => !teacher.subjectIds.includes(item.lesson.subjectId))) {
      reasonForUnit("Преподаватель не ведёт предмет одного из связанных уроков.");
      continue;
    }
    if (unit.every(item => item.lesson.teacherId === teacher.id)) continue;
    const unavailability = unit.map(item => findUnavailability(catalog, "teacher", teacher.id, item.date, item.start, item.end)).flat();
    if (unavailability.length) {
      const conflict = unavailability[0]!;
      reasonForUnit(`Преподаватель недоступен ${String(Math.floor(conflict.start / 60)).padStart(2, "0")}:${String(conflict.start % 60).padStart(2, "0")}–${String(Math.floor(conflict.end / 60)).padStart(2, "0")}:${String(conflict.end % 60).padStart(2, "0")}${conflict.reason ? `: ${conflict.reason}` : ""}.`);
      continue;
    }
    const candidateOccupancies = locate(next).map(entry => conflictOccupancy(entry, entry.lesson.teacherId ?? ""));
    const collision = unit.map(item => findTeacherConflicts(candidateOccupancies, conflictOccupancy(item, teacher.id), item.lesson.id)).flat()[0];
    if (collision) {
      reasonForUnit(`У выбранного преподавателя уже есть занятие у группы «${catalog.groups.find(group => group.id === collision.b.groupId)?.name ?? collision.b.groupId}» в это время.`);
      continue;
    }
    const idsToChange = new Set(ids);
    next = Object.fromEntries(Object.entries(next).map(([key, days]) => [key, days.map(day => ({
      ...day,
      slots: day.slots.map(slot => slot.map(lesson => idsToChange.has(lesson.id)
        ? { ...lesson, teacherId: teacher.id, teacher: teacherLabel(teacher.name) }
        : lesson)),
    }))]));
    changedLessonIds.push(...ids);
  }
  return { schedule: next, changedLessonIds, skipped };
}
