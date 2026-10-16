import type { Schedule } from "../src/editor.ts";

export type ClearScheduleRangeResult = {
  schedule: Schedule;
  removedCount: number;
};

/** Clears lessons for selected groups and inclusive dates while retaining the schedule grid. */
export function clearScheduleRange(
  schedule: Schedule,
  groupIds: string[],
  startDate: string,
  endDate: string,
): ClearScheduleRangeResult {
  const selected = new Set(groupIds);
  const next: Schedule = { ...schedule };
  let removedCount = 0;

  if (!selected.size || startDate > endDate) return { schedule: next, removedCount };

  for (const [scheduleKey, days] of Object.entries(schedule)) {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    if (!selected.has(groupId)) continue;
    let changedDays: typeof days | undefined;
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const day = days[dayIndex];
      if (day.date < startDate || day.date > endDate) continue;
      let changedSlots: typeof day.slots | undefined;
      for (let slotIndex = 0; slotIndex < day.slots.length; slotIndex += 1) {
        const slot = day.slots[slotIndex];
        if (!slot.length) continue;
        removedCount += slot.length;
        changedSlots ??= day.slots.slice();
        changedSlots[slotIndex] = [];
      }
      if (changedSlots) {
        changedDays ??= days.slice();
        changedDays[dayIndex] = { ...day, slots: changedSlots };
      }
    }
    if (changedDays) next[scheduleKey] = changedDays;
  }
  return { schedule: next, removedCount };
}
