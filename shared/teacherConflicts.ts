import type { Catalog } from "./catalog.ts";
import {
  isCompatibleJointOccupancy,
  type RoomOccupancy,
  type RoomScheduleLike,
} from "./roomConflicts.ts";

export type TeacherOccupancy = RoomOccupancy;
export type TeacherConflict = { a: TeacherOccupancy; b: TeacherOccupancy };

function occupancies(input: TeacherOccupancy[] | RoomScheduleLike): TeacherOccupancy[] {
  if (Array.isArray(input)) return input;
  const result: TeacherOccupancy[] = [];
  for (const [scheduleKey, days] of Object.entries(input)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    for (const day of days)
      day.slots.forEach((slot, index) => {
        const time = day.times[index];
        if (!time) return;
        for (const lesson of slot)
          result.push({
            lessonId: lesson.id,
            groupId,
            date: day.date,
            roomId: lesson.roomId,
            start: time.start,
            end: time.start + time.duration,
            jointId: lesson.jointId,
            subjectId: lesson.subjectId,
            event: lesson.event,
            lessonKind: lesson.lessonKind,
            teacherId: lesson.teacherId,
          });
      });
  }
  return result;
}

function valid(entry: TeacherOccupancy): boolean {
  return Boolean(entry.teacherId && Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start);
}

function overlaps(a: TeacherOccupancy, b: TeacherOccupancy): boolean {
  return a.start < b.end && b.start < a.end;
}

function pairKey(a: TeacherOccupancy, b: TeacherOccupancy): string {
  return [a.lessonId, b.lessonId].sort().join("\u0000");
}

/** Returns an overlap for the same teacher and date; touching intervals are allowed. */
export function findTeacherConflicts(
  schedule: TeacherOccupancy[],
  candidate: TeacherOccupancy,
  ignoreLessonId?: string,
): TeacherConflict[] {
  if (!valid(candidate)) return [];
  return schedule
    .filter((entry) =>
      entry.lessonId !== candidate.lessonId &&
      entry.lessonId !== ignoreLessonId &&
      entry.teacherId === candidate.teacherId &&
      entry.date === candidate.date &&
      valid(entry) && overlaps(entry, candidate) &&
      !isCompatibleJointOccupancy(entry, candidate),
    )
    .map((entry) => ({ a: candidate, b: entry }));
}

/** Reports only new or enlarged collisions so legacy overlaps do not block unrelated edits. */
export function newTeacherConflict(
  nextInput: TeacherOccupancy[] | RoomScheduleLike,
  previousInput: TeacherOccupancy[] | RoomScheduleLike,
): TeacherConflict | undefined {
  const next = occupancies(nextInput);
  const previous = occupancies(previousInput);
  const oldByPair = new Map<string, { date: string; teacherId: string; start: number; end: number }>();
  const oldBuckets = new Map<string, TeacherOccupancy[]>();
  for (const entry of previous.filter(valid)) {
    const key = `${entry.date}\u0000${entry.teacherId}`;
    const bucket = oldBuckets.get(key) ?? [];
    bucket.push(entry);
    oldBuckets.set(key, bucket);
  }
  for (const bucket of oldBuckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: TeacherOccupancy[] = [];
    for (const entry of bucket) {
      for (let i = active.length - 1; i >= 0; i -= 1)
        if (active[i].end <= entry.start) active.splice(i, 1);
      for (const peer of active)
        if (peer.lessonId !== entry.lessonId && overlaps(peer, entry) && !isCompatibleJointOccupancy(peer, entry))
          oldByPair.set(pairKey(entry, peer), {
            date: entry.date,
            teacherId: entry.teacherId!,
            start: Math.max(entry.start, peer.start),
            end: Math.min(entry.end, peer.end),
          });
      active.push(entry);
    }
  }

  const nextBuckets = new Map<string, TeacherOccupancy[]>();
  for (const entry of next.filter(valid)) {
    const key = `${entry.date}\u0000${entry.teacherId}`;
    const bucket = nextBuckets.get(key) ?? [];
    bucket.push(entry);
    nextBuckets.set(key, bucket);
  }
  for (const bucket of nextBuckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: TeacherOccupancy[] = [];
    for (const entry of bucket) {
      for (let i = active.length - 1; i >= 0; i -= 1)
        if (active[i].end <= entry.start) active.splice(i, 1);
      for (const peer of active) {
        if (peer.lessonId === entry.lessonId || !overlaps(peer, entry) || isCompatibleJointOccupancy(peer, entry)) continue;
        const prior = oldByPair.get(pairKey(entry, peer));
        if (!prior || prior.date !== entry.date || prior.teacherId !== entry.teacherId ||
          Math.max(entry.start, peer.start) < prior.start || Math.min(entry.end, peer.end) > prior.end)
          return { a: entry, b: peer };
      }
      active.push(entry);
    }
  }
  return undefined;
}

export function teacherConflictMessage(conflict: TeacherConflict, catalog: Catalog): string {
  const groupName = (id: string) => catalog.groups.find((group) => group.id === id)?.name ?? id;
  const teacherName = catalog.teachers.find((teacher) => teacher.id === conflict.b.teacherId)?.name ?? conflict.b.teacherId ?? "Преподаватель";
  const subjectName = conflict.b.event || catalog.subjects.find((subject) => subject.id === conflict.b.subjectId)?.name || conflict.b.subjectId || "урок";
  const time = (entry: TeacherOccupancy) =>
    `${String(Math.floor(entry.start / 60)).padStart(2, "0")}:${String(entry.start % 60).padStart(2, "0")}–${String(Math.floor(entry.end / 60)).padStart(2, "0")}:${String(entry.end % 60).padStart(2, "0")}`;
  return `Преподаватель «${teacherName}» уже ведёт «${subjectName}» у группы «${groupName(conflict.b.groupId)}» ${conflict.b.date} ${time(conflict.b)}; время пересекается.`;
}
