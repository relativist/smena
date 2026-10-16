import type { Catalog } from "./catalog.ts";

function preferredIds(catalog: Catalog, groupIds: string | string[], teacherId?: string): Array<string | null | undefined> {
  const teacher = catalog.teachers.find(entry => entry.id === teacherId);
  const ids = Array.isArray(groupIds) ? groupIds : [groupIds];
  const groups = ids.map(id => catalog.groups.find(entry => entry.id === id));
  return [teacher?.defaultRoomId, ...groups.map(group => group?.roomId), ...groups.flatMap(group => group?.autoRoomIds ?? [])];
}

/** Same resource order for manual placement, generation and joint lessons. */
export function preferredRoomIds(catalog: Catalog, groupIds: string | string[], teacherId?: string): string[] {
  const active = catalog.rooms.filter(room => !room.archived);
  const remaining = active.slice().sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true })).map(room => room.id);
  const activeIds = new Set(active.map(room => room.id));
  return [...new Set([...preferredIds(catalog, groupIds, teacherId), ...remaining])]
    .filter((id): id is string => typeof id === "string" && activeIds.has(id));
}

/** Whether a room belongs to the teacher/group preferences rather than general fallback. */
export function isPreferredRoom(catalog: Catalog, groupId: string, teacherId: string | undefined, roomId: string): boolean {
  return preferredIds(catalog, groupId, teacherId).includes(roomId);
}
