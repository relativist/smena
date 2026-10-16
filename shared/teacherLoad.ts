import type { Catalog, CatalogTeacher } from "./catalog.ts";
import type { Schedule } from "../src/editor.ts";

export type TeacherLoadParticipant = {
  id: string;
  name: string;
  subgroup?: string;
  slot: number;
};

export type TeacherLoadLesson = {
  id: string;
  date: string;
  start: number;
  duration: number;
  subjectId: string;
  subject: string;
  shortSubject: string;
  isEvent: boolean;
  room?: string;
  participants: TeacherLoadParticipant[];
};

export type TeacherLoadRow = {
  id: string;
  name: string;
  archived: boolean;
  lessons: TeacherLoadLesson[];
};

export type TeacherLoadSummary = {
  lessons: number;
  events: number;
  minutes: number;
  groupCount: number;
};

function groupIdFromKey(value: string): string {
  return value.slice(0, value.lastIndexOf(":"));
}

function normalized(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru") ?? "";
}

function roomLabel(catalog: Catalog, roomId?: string, legacyRoom?: string): string | undefined {
  if (roomId) return catalog.rooms.find((room) => room.id === roomId)?.name ?? legacyRoom ?? roomId;
  return legacyRoom || undefined;
}

function lessonIdentity(groupId: string, date: string, id: string): string {
  return JSON.stringify([groupId, date, id]);
}

function jointIdentity(lesson: TeacherLoadLesson, jointId: string, teacherId: string, kind: string, room: string): string {
  return JSON.stringify([
    lesson.date,
    jointId,
    teacherId,
    lesson.start,
    lesson.duration,
    lesson.subjectId,
    lesson.isEvent ? lesson.subject : "",
    kind,
    room,
  ]);
}

/** Build a per-teacher view of all scheduled lessons, merging valid joint copies. */
export function collectTeacherLoad(schedule: Schedule, catalog: Catalog): TeacherLoadRow[] {
  const teacherById = new Map(catalog.teachers.map((teacher) => [teacher.id, teacher]));
  const teachersByName = new Map<string, CatalogTeacher[]>();
  for (const teacher of catalog.teachers) {
    const key = normalized(teacher.name);
    if (!key) continue;
    const matches = teachersByName.get(key) ?? [];
    matches.push(teacher);
    teachersByName.set(key, matches);
  }

  const rows = new Map<string, TeacherLoadRow>();
  for (const teacher of catalog.teachers) {
    if (!teacher.archived) rows.set(teacher.id, { id: teacher.id, name: teacher.name, archived: false, lessons: [] });
  }

  // Collapse exact mirrored source rows before considering joint lessons.
  const sourceRows = new Map<string, {
    groupId: string;
    teacherId: string;
    lessonId: string;
    jointId?: string;
    kind: string;
    roomKey: string;
    result: TeacherLoadLesson;
  }>();
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = groupIdFromKey(scheduleKey);
    const group = catalog.groups.find((entry) => entry.id === groupId);
    for (const day of days) {
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time || !Number.isFinite(time.start) || !Number.isFinite(time.duration) || time.duration <= 0) return;
        slot.forEach((lesson) => {
          let teacherId = lesson.teacherId;
          if (!teacherId && lesson.teacher) {
            const matches = teachersByName.get(normalized(lesson.teacher)) ?? [];
            if (matches.length === 1) teacherId = matches[0]!.id;
          }
          if (!teacherId) return;

          const catalogTeacher = teacherById.get(teacherId);
          const teacherName = catalogTeacher?.name ?? lesson.teacher?.trim() ?? `Неизвестный учитель (${teacherId})`;
          let row = rows.get(teacherId);
          if (!row) {
            row = { id: teacherId, name: teacherName, archived: catalogTeacher?.archived ?? false, lessons: [] };
            rows.set(teacherId, row);
          }

          const subject = catalog.subjects.find((entry) => entry.id === lesson.subjectId);
          const subgroup = lesson.subgroupId
            ? catalog.subgroups.find((entry) => entry.id === lesson.subgroupId)?.name ?? lesson.subgroup
            : lesson.subgroup;
          const room = roomLabel(catalog, lesson.roomId, lesson.room);
          const result: TeacherLoadLesson = {
            id: lesson.id,
            date: day.date,
            start: time.start,
            duration: time.duration,
            subjectId: lesson.subjectId,
            subject: lesson.event || (lesson.subjectId === "event" ? "Мероприятие" : subject?.name ?? lesson.subjectId),
            shortSubject: lesson.event || (lesson.subjectId === "event" ? "Меропр." : subject?.shortName?.trim() || subject?.name || lesson.subjectId),
            isEvent: Boolean(lesson.event) || lesson.subjectId === "event",
            ...(room ? { room } : {}),
            participants: [{ id: groupId, name: group?.name ?? groupId, ...(subgroup ? { subgroup } : {}), slot: slotIndex + 1 }],
          };
          const kind = lesson.lessonKind ?? "regular";
          const sourceKey = lessonIdentity(groupId, day.date, lesson.id);
          if (!sourceRows.has(sourceKey)) {
            sourceRows.set(sourceKey, {
              groupId,
              teacherId,
              lessonId: lesson.id,
              ...(lesson.jointId ? { jointId: lesson.jointId } : {}),
              kind,
              roomKey: lesson.roomId ?? lesson.room ?? "",
              result,
            });
          }
        });
      });
    }
  }

  const jointRows = new Map<string, TeacherLoadLesson>();
  for (const source of sourceRows.values()) {
    const target = rows.get(source.teacherId)!;
    if (!source.jointId) {
      target.lessons.push(source.result);
      continue;
    }
    const key = jointIdentity(source.result, source.jointId, source.teacherId, source.kind, source.roomKey);
    const existing = jointRows.get(key);
    if (!existing) {
      jointRows.set(key, source.result);
      target.lessons.push(source.result);
    } else {
      const current = source.result.participants[0]!;
      if (!existing.participants.some((participant) => participant.id === current.id && participant.subgroup === current.subgroup)) {
        existing.participants.push(current);
      }
    }
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      lessons: row.lessons.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id, "ru", { numeric: true }));
}

/** Summarize scheduled lessons in an inclusive ISO-date range. */
export function summarizeTeacherLoad(lessons: TeacherLoadLesson[], startDate: string, endDate: string): TeacherLoadSummary {
  const selected = lessons.filter((lesson) => lesson.date >= startDate && lesson.date <= endDate);
  const taught = selected.filter((lesson) => !lesson.isEvent);
  return {
    lessons: taught.length,
    events: selected.length - taught.length,
    minutes: taught.reduce((sum, lesson) => sum + lesson.duration, 0),
    groupCount: new Set(taught.flatMap((lesson) => lesson.participants.map((participant) => participant.id))).size,
  };
}
