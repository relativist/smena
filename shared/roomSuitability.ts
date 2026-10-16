import type { Catalog, CatalogSubject, RoomKind } from "./catalog.ts";
import type { EditorLesson, Schedule } from "../src/editor.ts";
import { roomKinds } from "./catalog.ts";

export function requiredRoomKind(subject: CatalogSubject | undefined, lessonKind: "regular" | "lab" = "regular"): RoomKind | null {
  if (!subject) return null;
  if (lessonKind === "lab") return subject.labRoomKind ?? subject.roomKind ?? "general";
  return subject.roomKind ?? "general";
}

type SuitabilityInput = { subjectId: string; lessonKind?: "regular" | "lab"; roomId?: string; groupId: string; subgroupId?: string; subgroup?: string; groupIds?: string[] };
function getRoom(catalog: Catalog, roomId?: string) { return roomId ? catalog.rooms.find(r => r.id === roomId) : undefined; }
function studentCount(catalog: Catalog, groupId: string, subgroupId?: string, subgroupName?: string): number | undefined {
  const group = catalog.groups.find(g => g.id === groupId);
  if (!group) return undefined;
  if (!subgroupId && !subgroupName) return group.students;
  const matches = catalog.subgroups.filter(s => s.groupId === groupId && (subgroupId ? s.id === subgroupId : s.name === subgroupName));
  return matches.length === 1 ? matches[0]!.students : group.students;
}
function reasonFor(catalog: Catalog, input: SuitabilityInput, room = getRoom(catalog, input.roomId)): string | null {
  if (!room) return null;
  const subject = input.subjectId === "event" ? undefined : catalog.subjects.find(s => s.id === input.subjectId);
  const required = requiredRoomKind(subject, input.lessonKind);
  if (required && room.kind !== required) return `Кабинет «${room.name}» имеет тип «${roomKinds[room.kind]}», требуется «${roomKinds[required]}»`;
  if (room.capacity !== null) {
    const ids = input.groupIds?.length ? [...new Set(input.groupIds)] : [input.groupId];
    const count = ids.reduce((sum, id) => sum + (studentCount(catalog, id, ids.length === 1 ? input.subgroupId : undefined, ids.length === 1 ? input.subgroup : undefined) ?? 0), 0);
    if (count > room.capacity) return `Кабинет «${room.name}» рассчитан на ${room.capacity} человек, участников: ${count}`;
  }
  return null;
}
export function roomSuitabilityReason(catalog: Catalog, input: SuitabilityInput): string | null { return reasonFor(catalog, input); }

export type RoomSuitabilityViolation = { roomId: string; subjectId: string; lessonKind: "regular" | "lab"; reason: string; groupIds: string[]; lessonIds: string[]; participantCount: number; typeViolation: boolean; capacityViolation: boolean };
type Unit = { room: NonNullable<ReturnType<typeof getRoom>>; subjectId: string; lessonKind: "regular" | "lab"; groupIds: string[]; lessonIds: string[]; members: string[]; count: number; reason: string; typeViolation: boolean; capacityViolation: boolean };
function units(schedule: Schedule, catalog: Catalog): Unit[] {
  type Entry = { groupId: string; lesson: EditorLesson; date: string; slot: number };
  type ResolvedEntry = Entry & { room: NonNullable<ReturnType<typeof getRoom>> };
  const raw: Entry[] = [];
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    days.forEach(day => day.slots.forEach((slot, slotIndex) => slot.forEach(lesson => raw.push({ groupId, lesson, date: day.date, slot: slotIndex }))));
  }
  const buckets = new Map<string, ResolvedEntry[]>();
  for (const entry of raw) {
    const l = entry.lesson;
    let room = l.roomId ? getRoom(catalog, l.roomId) : undefined;
    if (!room && l.room) { const matches = catalog.rooms.filter(r => r.name === l.room); if (matches.length === 1) room = matches[0]; }
    if (!room) continue;
    const resolved: ResolvedEntry = { ...entry, room };
    const jointKey = l.jointId
      ? `joint:${entry.date}:${l.jointId}:${room.id}:${l.subjectId ?? ""}:${l.lessonKind ?? "regular"}:${l.event ?? ""}`
      : `lesson:${entry.date}:${entry.slot}:${l.id}:${entry.groupId}`;
    const arr = buckets.get(jointKey) ?? []; arr.push(resolved); buckets.set(jointKey, arr);
  }
  const result: Unit[] = [];
  for (const entries of buckets.values()) {
    const first = entries[0]!; const l = first.lesson; const groupIds = [...new Set(entries.map(e => e.groupId))];
    const subjectId = l.subjectId ?? ""; const lessonKind = l.lessonKind ?? "regular";
    const room = first.room;
    const count = groupIds.reduce((sum, gid) => {
      const members = entries.filter(e => e.groupId === gid);
      if (l.event || members.some(e => !e.lesson.subgroupId && !e.lesson.subgroup))
        return sum + (catalog.groups.find(g => g.id === gid)?.students ?? 0);
      const subgroupKeys = new Set<string>();
      let subgroupTotal = 0;
      for (const member of members) {
        const subgroupKey = member.lesson.subgroupId ?? member.lesson.subgroup ?? "";
        if (!subgroupKey || subgroupKeys.has(subgroupKey)) continue;
        subgroupKeys.add(subgroupKey);
        subgroupTotal += studentCount(catalog, gid, member.lesson.subgroupId, member.lesson.subgroup) ?? 0;
      }
      return sum + subgroupTotal;
    }, 0);
    const required = l.event || subjectId === "event" ? null : requiredRoomKind(catalog.subjects.find(s => s.id === subjectId), lessonKind);
    const typeViolation = Boolean(required && room.kind !== required);
    const capacityViolation = room.capacity !== null && count > room.capacity;
    if (!typeViolation && !capacityViolation) continue;
    const reason = typeViolation
      ? `Кабинет «${room.name}» имеет тип «${roomKinds[room.kind]}», требуется «${roomKinds[required!]}»`
      : `Кабинет «${room.name}» рассчитан на ${room.capacity} человек, участников: ${count}`;
    result.push({ room, subjectId, lessonKind, groupIds, lessonIds: entries.map(e => e.lesson.id), members: entries.map(e => `${e.lesson.id}\0${e.groupId}\0${e.lesson.subgroupId ?? e.lesson.subgroup ?? ""}`), count, reason, typeViolation, capacityViolation });
  }
  return result;
}
export function newRoomSuitabilityViolation(next: Schedule, previous: Schedule, catalog: Catalog): RoomSuitabilityViolation | undefined {
  const old = units(previous, catalog);
  for (const unit of units(next, catalog)) {
    const inherited = old.find(prior => prior.room.id === unit.room.id && prior.subjectId === unit.subjectId && prior.lessonKind === unit.lessonKind && unit.members.every(m => prior.members.includes(m)) && (!unit.capacityViolation || (prior.capacityViolation && unit.count <= prior.count)) && (!unit.typeViolation || prior.typeViolation));
    if (!inherited) return { roomId: unit.room.id, subjectId: unit.subjectId, lessonKind: unit.lessonKind, reason: unit.reason, groupIds: unit.groupIds, lessonIds: unit.lessonIds, participantCount: unit.count, typeViolation: unit.typeViolation, capacityViolation: unit.capacityViolation };
  }
  return undefined;
}
export function roomSuitabilityViolationMessage(violation: RoomSuitabilityViolation, catalog: Catalog): string {
  const names = violation.groupIds.map(id => catalog.groups.find(g => g.id === id)?.name ?? id).join(", ");
  return `${violation.reason}${names ? ` (группы: ${names})` : ""}`;
}
