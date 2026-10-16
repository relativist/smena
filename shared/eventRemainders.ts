import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";

/** Provenance for a lesson shortened to make room for a service event. */
export type EventRemainder = {
  date: string;
  lessonIds: string[];
  originalStart: number;
  originalDuration: number;
  eventDuration: number;
};

export function isEventRemainder(value: unknown): value is EventRemainder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const date = item.date;
  const validDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) &&
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  return validDate &&
    Array.isArray(item.lessonIds) && item.lessonIds.length <= 20 &&
    item.lessonIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 120) &&
    new Set(item.lessonIds).size === item.lessonIds.length &&
    Number.isInteger(item.originalStart) && (item.originalStart as number) >= 0 && (item.originalStart as number) <= 1439 &&
    Number.isInteger(item.originalDuration) && (item.originalDuration as number) > 0 && (item.originalDuration as number) <= 180 &&
    Number.isInteger(item.eventDuration) && (item.eventDuration as number) > 0 &&
    (item.eventDuration as number) < (item.originalDuration as number) &&
    (item.originalStart as number) + (item.originalDuration as number) <= 1440;
}

function syncDayTiming(day: EditorDay): void {
  if (day.times.length) {
    const first = day.times[0]!;
    day.start = `${String(Math.floor(first.start / 60)).padStart(2, "0")}:${String(first.start % 60).padStart(2, "0")}`;
  }
  day.breaks = day.times.slice(0, -1).map((time, index) =>
    day.times[index + 1]!.start - (time.start + time.duration),
  );
}

function locateEvent(schedule: Schedule, eventId: string) {
  for (const [scheduleKey, days] of Object.entries(schedule)) {
    for (const day of days) {
      for (let index = 0; index < day.slots.length; index += 1) {
        const lesson = day.slots[index]!.find((item) => item.id === eventId);
        if (lesson) return { scheduleKey, day, index, lesson };
      }
    }
  }
  return undefined;
}

/**
 * Restore a split only when both cells still match the recorded split exactly.
 * A changed or legacy event returns null. Callers must report a clear error
 * rather than removing a changed split or inventing lesson timing.
 */
export function restoreEventRemainder(
  schedule: Schedule,
  event: EditorLesson,
): Schedule | null {
  const provenance = event.eventRemainder;
  if (!isEventRemainder(provenance)) return null;
  const found = locateEvent(schedule, event.id);
  if (!found || found.lesson.subjectId !== "event" || found.day.date !== provenance.date) return null;
  const { day, index } = found;
  const eventTime = day.times[index];
  if (!eventTime || day.slots[index]!.length !== 1 ||
      eventTime.start !== provenance.originalStart ||
      eventTime.duration !== provenance.eventDuration)
    return null;

  if (provenance.lessonIds.length > 0) {
    const remainderTime = day.times[index + 1];
    const remainderSlot = day.slots[index + 1];
    if (!remainderTime || !remainderSlot ||
        remainderTime.start !== provenance.originalStart + provenance.eventDuration ||
        remainderTime.duration !== provenance.originalDuration - provenance.eventDuration ||
        remainderSlot.length !== provenance.lessonIds.length ||
        !provenance.lessonIds.every((id) => remainderSlot.some((lesson) => lesson.id === id)))
      return null;
  }

  const result = structuredClone(schedule);
  const restored = locateEvent(result, event.id);
  if (!restored) return null;
  restored.day.times[restored.index] = {
    start: provenance.originalStart,
    duration: provenance.originalDuration,
  };
  if (provenance.lessonIds.length > 0) {
    restored.day.slots[restored.index] = restored.day.slots[restored.index + 1]!;
    restored.day.times.splice(restored.index + 1, 1);
    restored.day.slots.splice(restored.index + 1, 1);
  } else {
    restored.day.slots[restored.index] = [];
  }
  for (let index = 0; index < restored.day.times.length; index += 1) {
    const time = restored.day.times[index]!;
    if (!Number.isInteger(time.start) || time.start < 0 || time.start > 1439 ||
        !Number.isInteger(time.duration) || time.duration <= 0 || time.start + time.duration > 1440)
      return null;
    if (index > 0 && restored.day.times[index - 1]!.start + restored.day.times[index - 1]!.duration > time.start)
      return null;
  }
  syncDayTiming(restored.day);
  return result;
}
