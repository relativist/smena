import type { Catalog } from "./catalog.ts";

/** One scheduled lesson occupying a physical room during a date/time interval. */
export type RoomOccupancy = {
  lessonId: string;
  groupId: string;
  date: string;
  roomId: string | null | undefined;
  start: number;
  end: number;
  jointId?: string;
  subjectId?: string;
  event?: string;
  lessonKind?: "regular" | "lab";
  teacherId?: string;
};

export type RoomConflict = { a: RoomOccupancy; b: RoomOccupancy };
export type RoomScheduleLike = Record<
  string,
  Array<{
    date: string;
    slots: Array<Array<{
      id: string;
      roomId?: string | null;
      jointId?: string;
      subjectId?: string;
      event?: string;
      lessonKind?: "regular" | "lab";
      teacherId?: string;
    }>>;
    times: Array<{ start: number; duration: number }>;
  }>
>;

function occupancies(
  input: RoomOccupancy[] | RoomScheduleLike,
): RoomOccupancy[] {
  if (Array.isArray(input)) return input;
  const result: RoomOccupancy[] = [];
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

function valid(entry: RoomOccupancy): boolean {
  return Boolean(
    entry.roomId &&
      Number.isFinite(entry.start) &&
      Number.isFinite(entry.end) &&
      entry.end > entry.start,
  );
}

function pairKey(a: RoomOccupancy, b: RoomOccupancy): string {
  return [a.lessonId, b.lessonId].sort().join("\u0000");
}

function overlaps(a: RoomOccupancy, b: RoomOccupancy): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True only for exact-time mirrors of the same joint lesson and resources. */
export function isCompatibleJointOccupancy(
  a: RoomOccupancy,
  b: RoomOccupancy,
): boolean {
  return Boolean(
    a.jointId &&
      a.jointId === b.jointId &&
      a.groupId !== b.groupId &&
      a.subjectId === b.subjectId &&
      a.event === b.event &&
      a.lessonKind === b.lessonKind &&
      a.teacherId === b.teacherId &&
      a.date === b.date &&
      a.roomId === b.roomId &&
      a.start === b.start &&
      a.end === b.end,
  );
}

/** Returns one collision; touching lesson boundaries are allowed. */
export function findRoomConflict(
  schedule: RoomOccupancy[],
  candidate: RoomOccupancy,
  ignoreLessonId?: string,
): RoomConflict | undefined {
  if (!valid(candidate)) return undefined;
  const peers = schedule
    .filter(
      (entry) =>
        entry.lessonId !== ignoreLessonId &&
        entry.lessonId !== candidate.lessonId &&
        entry.date === candidate.date &&
        entry.roomId === candidate.roomId &&
        valid(entry),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const peer of peers) {
    if (peer.start >= candidate.end) break;
    if (overlaps(peer, candidate) && !isCompatibleJointOccupancy(peer, candidate))
      return { a: candidate, b: peer };
  }
  return undefined;
}

/**
 * Reports only a newly introduced or enlarged collision. This lets an admin
 * edit unrelated parts of a timetable that already contains legacy conflicts.
 */
export function newRoomConflict(
  nextInput: RoomOccupancy[] | RoomScheduleLike,
  previousInput: RoomOccupancy[] | RoomScheduleLike,
): RoomConflict | undefined {
  const next = occupancies(nextInput);
  const previous = occupancies(previousInput);
  const oldByPair = new Map<
    string,
    { date: string; roomId: string; start: number; end: number }
  >();
  const oldValid = previous.filter(valid);
  // Use the same date/room sweep as preview validation instead of comparing
  // every lesson in the school against every other lesson.
  const buckets = new Map<string, RoomOccupancy[]>();
  for (const entry of oldValid) {
    const key = `${entry.date}\u0000${entry.roomId}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: RoomOccupancy[] = [];
    for (const entry of bucket) {
      for (let i = active.length - 1; i >= 0; i -= 1)
        if (active[i].end <= entry.start) active.splice(i, 1);
      for (const peer of active)
        if (peer.lessonId !== entry.lessonId && overlaps(peer, entry) && !isCompatibleJointOccupancy(peer, entry))
          oldByPair.set(pairKey(entry, peer), {
            date: entry.date,
            roomId: entry.roomId!,
            start: Math.max(entry.start, peer.start),
            end: Math.min(entry.end, peer.end),
          });
      active.push(entry);
    }
  }

  const nextBuckets = new Map<string, RoomOccupancy[]>();
  for (const entry of next.filter(valid)) {
    const key = `${entry.date}\u0000${entry.roomId}`;
    const bucket = nextBuckets.get(key) ?? [];
    bucket.push(entry);
    nextBuckets.set(key, bucket);
  }
  for (const bucket of nextBuckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: RoomOccupancy[] = [];
    for (const entry of bucket) {
      for (let i = active.length - 1; i >= 0; i -= 1)
        if (active[i].end <= entry.start) active.splice(i, 1);
      for (const peer of active) {
        if (peer.lessonId === entry.lessonId || !overlaps(peer, entry) || isCompatibleJointOccupancy(peer, entry))
          continue;
        const prior = oldByPair.get(pairKey(entry, peer));
        if (
          !prior ||
          prior.date !== entry.date ||
          prior.roomId !== entry.roomId ||
          Math.max(entry.start, peer.start) < prior.start ||
          Math.min(entry.end, peer.end) > prior.end
        )
          return { a: entry, b: peer };
      }
      active.push(entry);
    }
  }
  return undefined;
}

export function roomConflictMessage(
  conflict: RoomConflict,
  catalog: Catalog,
): string {
  const groupName = (id: string) =>
    catalog.groups.find((group) => group.id === id)?.name ?? id;
  const roomName =
    catalog.rooms.find((room) => room.id === conflict.a.roomId)?.name ??
    conflict.a.roomId ??
    "кабинет";
  const time = (entry: RoomOccupancy) =>
    `${String(Math.floor(entry.start / 60)).padStart(2, "0")}:${String(entry.start % 60).padStart(2, "0")}–${String(Math.floor(entry.end / 60)).padStart(2, "0")}:${String(entry.end % 60).padStart(2, "0")}`;
  return `Кабинет «${roomName}» уже занят группой «${groupName(conflict.b.groupId)}» ${conflict.b.date} ${time(conflict.b)}; назначение группе «${groupName(conflict.a.groupId)}» конфликтует.`;
}
