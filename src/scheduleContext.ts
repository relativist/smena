import type { Schedule } from "./editor.ts";
import { weekDates } from "../shared/plans.ts";

/** Add server context without overwriting loaded or historical day versions. */
export function mergeScheduleContext(schedule: Schedule, context: Schedule): Schedule {
  const merged = { ...context, ...schedule };
  for (const [key, days] of Object.entries(context)) {
    const existing = schedule[key];
    if (!existing) continue;
    const dates = new Set(existing.map(day => day.date));
    const extra = days.filter(day => !dates.has(day.date));
    if (extra.length) merged[key] = [...existing, ...extra].sort((a, b) => a.date.localeCompare(b.date));
  }
  return merged;
}

export function scheduleDayChanges(before: Schedule, after: Schedule) {
  const changes: Array<{
    key: string;
    dayIndex: number;
    before: Schedule[string][number];
    after: Schedule[string][number];
  }> = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const scheduleKey of keys) {
    const previousDays = before[scheduleKey] ?? [];
    const nextDays = after[scheduleKey] ?? [];
    const dates = new Set([
      ...previousDays.map((day) => day.date),
      ...nextDays.map((day) => day.date),
    ]);
    for (const date of dates) {
      const beforeIndex = previousDays.findIndex((day) => day.date === date);
      const afterIndex = nextDays.findIndex((day) => day.date === date);
      const previous = beforeIndex >= 0 ? previousDays[beforeIndex] : undefined;
      const next = afterIndex >= 0 ? nextDays[afterIndex] : undefined;
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      // The server identifies a day by its index within the submitted week.
      const weekOffset = Number(scheduleKey.slice(scheduleKey.lastIndexOf(":") + 1));
      const dayIndex = weekDates(weekOffset).indexOf(date);
      if (previous && next)
        changes.push({ key: scheduleKey, dayIndex, before: previous, after: next });
    }
  }
  return changes;
}
