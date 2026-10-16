import type { Catalog, SubjectColor } from "../shared/catalog.ts";
import type { SubjectIconId } from "../shared/subjectIcons.ts";
import { teacherLabel } from "../shared/catalog.ts";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";
import type { Quarter, StudyPlan, LessonKind } from "../shared/plans.ts";
import { preferredRoomIds } from "../shared/roomPreferences.ts";
export { preferredRoomIds } from "../shared/roomPreferences.ts";

export type EditorAssignment = {
  id: string;
  planId: string;
  subjectId: string;
  groupId: string;
  name: string;
  subgroupId?: string;
  groupRoomId?: string;
  unavailable: boolean;
  reason: string;
  target: number;
  lessonKind: LessonKind;
};
export type EditorSubject = {
  id: string;
  name: string;
  shortName: string;
  iconId?: SubjectIconId | "auto" | null;
  color: SubjectColor;
  archived: boolean;
  assignments: EditorAssignment[];
};
export type TeacherChoice = EditorAssignment & {
  teacherId: string;
  teacher: string;
  fullTeacher: string;
  roomId?: string;
  room: string;
};

/** Candidate teachers share the plan hours; choosing one never changes the plan. */
export function teacherChoices(
  catalog: Catalog,
  subject: EditorSubject,
  overrideRoomId?: string,
): TeacherChoice[] {
  const candidates = catalog.teachers
    .filter(
      (teacher) => !teacher.archived && teacher.subjectIds.includes(subject.id),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return subject.assignments.flatMap((assignment) =>
    [...candidates].sort((a, b) =>
      Number(Boolean(b.preferredGroupIds?.includes(assignment.groupId)))
      - Number(Boolean(a.preferredGroupIds?.includes(assignment.groupId)))
      || a.name.localeCompare(b.name, "ru"),
    ).map((teacher) => {
      const suitable = (roomId: string) => !roomSuitabilityReason(catalog, {
        subjectId: subject.id, lessonKind: assignment.lessonKind,
        groupId: assignment.groupId, subgroupId: assignment.subgroupId, roomId,
      });
      const roomId = overrideRoomId ?? preferredRoomIds(catalog, assignment.groupId, teacher.id).find(suitable);
      const room = catalog.rooms.find((entry) => entry.id === roomId);
      const reasons = assignment.reason ? [assignment.reason] : [];
      if (!room) reasons.push("Нет подходящего кабинета. Проверьте тип и вместимость в справочнике");
      else if (room.archived) reasons.push("Кабинет в архиве");
      else {
        const reason = roomSuitabilityReason(catalog, {
          subjectId: subject.id, lessonKind: assignment.lessonKind,
          groupId: assignment.groupId, subgroupId: assignment.subgroupId, roomId,
        });
        if (reason) reasons.push(reason);
      }
      return {
        ...assignment,
        id: JSON.stringify([assignment.id, teacher.id]),
        teacherId: teacher.id,
        teacher: teacherLabel(teacher.name),
        fullTeacher: teacher.name,
        roomId,
        room: room?.name ?? "Выберите кабинет",
        unavailable: reasons.length > 0,
        reason: reasons.join(" · "),
      };
    }),
  );
}

/** Plans describe only hour targets. Teacher and room are chosen per lesson. */
export function editorSubjects(
  catalog: Catalog,
  groupId: string,
  quarterId: string,
  studyPlans: StudyPlan[],
): EditorSubject[] {
  const group = catalog.groups.find((entry) => entry.id === groupId);
  const plans = studyPlans.filter(
    (plan) => plan.groupId === groupId && plan.quarterId === quarterId,
  );
  return catalog.subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    shortName: subject.shortName,
    iconId: subject.iconId,
    color: subject.color,
    archived: subject.archived,
    assignments: plans
      .filter((plan) => plan.subjectId === subject.id)
      .flatMap((plan) =>
        plan.assignments.map((assignment) => {
          const subgroup = assignment.subgroupId
            ? catalog.subgroups.find(
                (entry) => entry.id === assignment.subgroupId,
              )
            : undefined;
          const reasons: string[] = [];
          if (!group || group.archived) reasons.push("Группа недоступна");
          if (subject.archived) reasons.push("Предмет в архиве");
          if (
            assignment.subgroupId &&
            (!subgroup || subgroup.groupId !== groupId || subgroup.archived)
          )
            reasons.push("Подгруппа недоступна");
          return {
            id: assignment.id,
            planId: plan.id,
            subjectId: subject.id,
            groupId,
            name:
              subgroup?.name ??
              (assignment.subgroupId ? "Подгруппа недоступна" : ""),
            subgroupId: assignment.subgroupId ?? undefined,
            groupRoomId: group?.roomId ?? undefined,
            target: assignment.target,
            lessonKind: plan.lessonKind,
            unavailable: reasons.length > 0,
            reason: reasons.join(" · "),
          };
        }),
      ),
  }));
}

/** Counts actual placed lessons within a quarter; subgroup totals include whole-group lessons. */
export function countPlanLessons(
  schedule: import("./editor.ts").Schedule,
  groupId: string,
  quarter: Quarter,
  subjectId: string,
  subgroupId: string | undefined,
  lessonKind: LessonKind = "regular",
): number {
  const ids = new Set<string>();
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    if (!scheduleKey.startsWith(`${groupId}:`)) continue;
    for (const day of days) {
      if (day.date < quarter.startDate || day.date > quarter.endDate) continue;
      for (const slot of day.slots) {
        for (const lesson of slot) {
          const whole = !lesson.subgroupId && !lesson.subgroup;
          if (
            lesson.subjectId === subjectId &&
            (lesson.lessonKind ?? "regular") === lessonKind &&
            (subgroupId === undefined
              ? whole
              : whole || lesson.subgroupId === subgroupId) &&
            !lesson.event
          )
            ids.add(lesson.id);
        }
      }
    }
  }
  return ids.size;
}
