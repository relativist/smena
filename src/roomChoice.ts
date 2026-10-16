import { findUnavailability } from "../shared/unavailability.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Lesson } from "./demo.ts";
import { preferredRoomIds } from "./catalogAdapter.ts";
import { key, roomOccupancies, type Location, type Schedule } from "./editor.ts";
import { findRoomConflict } from "../shared/roomConflicts.ts";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";

/** Chooses a suitable free room at the actual destination of a new lesson. */
export function choosePlacementRoom(schedule: Schedule, location: Location, lesson: Lesson, catalog: Catalog): Lesson {
  if (lesson.event || lesson.subjectId === "event") return lesson;
  const time = schedule[key(location.groupId, location.weekOffset)]?.find((day) => day.date === location.date)?.times[location.slot];
  if (!time) return lesson;
  const occupancies = roomOccupancies(schedule).filter((entry) => entry.date === location.date);
  for (const roomId of preferredRoomIds(catalog, location.groupId, lesson.teacherId)) {
    if (roomSuitabilityReason(catalog, { ...lesson, groupId: location.groupId, roomId })) continue;
    if (findUnavailability(catalog, "room", roomId, location.date, time.start, time.start + time.duration).length) continue;
    const conflict = findRoomConflict(occupancies, {
      lessonId: "__auto-room-preview__", groupId: location.groupId, date: location.date,
      roomId, start: time.start, end: time.start + time.duration,
      subjectId: lesson.subjectId, lessonKind: lesson.lessonKind, teacherId: lesson.teacherId,
    });
    if (!conflict) return { ...lesson, roomId, room: catalog.rooms.find((room) => room.id === roomId)!.name };
  }
  return lesson;
}
