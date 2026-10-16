import type { RoomOccupancy } from "../shared/roomConflicts.ts";

export type AvailabilityResource = "teacher" | "room";

/**
 * Keep the full validation semantics while limiting a preview to pairs that
 * can have changed: changed lessons and every old/new peer sharing one of
 * their resources. Unchanged pairs cannot become new or enlarged conflicts.
 */
export function scopeAvailabilityPreview(
  previous: RoomOccupancy[],
  changes: Array<{ previous: RoomOccupancy; next: RoomOccupancy }>,
  resource: AvailabilityResource,
): { previous: RoomOccupancy[]; next: RoomOccupancy[] } {
  const resourceId = (entry: RoomOccupancy) =>
    resource === "teacher" ? entry.teacherId : entry.roomId;
  const changedByEntry = new Map(changes.map((change) => [change.previous, change.next]));
  const affectedIds = new Set<string>();
  for (const change of changes) {
    const oldId = resourceId(change.previous);
    const newId = resourceId(change.next);
    if (oldId) affectedIds.add(oldId);
    if (newId) affectedIds.add(newId);
  }
  const relevant = previous.filter((entry) => {
    const id = resourceId(entry);
    return changedByEntry.has(entry) || Boolean(id && affectedIds.has(id));
  });
  return {
    previous: relevant,
    next: relevant.map((entry) => changedByEntry.get(entry) ?? entry),
  };
}
