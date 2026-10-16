import { parentPort, workerData } from "node:worker_threads";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { StateResponse } from "./contracts.ts";
import { summarizeTeacherScheduleComfort } from "../shared/teacherScheduleComfort.ts";

type WorkerData = {
  state: StateResponse;
  quarterId: string;
  groupIds: string[];
  options: { preserveExisting: boolean; allowJointLessons: boolean };
};

const data = workerData as WorkerData;
try {
  const result = generateQuarter(data.state, data.quarterId, data.groupIds, {
    ...data.options,
    onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress }),
  });
  const selected = new Set(data.groupIds);
  const teacherIds = new Set<string>();
  for (const candidate of [data.state.schedule, result.schedule]) {
    for (const [scheduleKey, days] of Object.entries(candidate)) {
      if (!selected.has(scheduleKey.slice(0, scheduleKey.lastIndexOf(":")))) continue;
      for (const day of days) for (const slot of day.slots) for (const lesson of slot)
        if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }
  const quarter = data.state.quarters.find((entry) => entry.id === data.quarterId)!;
  const input = { catalog: data.state.catalog, quarter, teacherIds: [...teacherIds], bellSettings: data.state.bellSettings, calendar: data.state.calendar };
  const before = summarizeTeacherScheduleComfort({ ...input, schedule: data.state.schedule });
  const after = summarizeTeacherScheduleComfort({ ...input, schedule: result.schedule });
  const beforeById = new Map(before.teachers.map((teacher) => [teacher.teacherId, teacher]));
  const afterById = new Map(after.teachers.map((teacher) => [teacher.teacherId, teacher]));
  const empty = { gapMinutes: 0, gapCount: 0, bothShiftDays: 0 };
  const teachers = [...teacherIds].map((teacherId) => ({
    teacherId,
    name: data.state.catalog.teachers.find((teacher) => teacher.id === teacherId)?.name ?? "Преподаватель",
    before: beforeById.get(teacherId) ?? { teacherId, name: "", ...empty },
    after: afterById.get(teacherId) ?? { teacherId, name: "", ...empty },
  })).sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
  const sum = (items: typeof teachers, field: "gapMinutes" | "gapCount" | "bothShiftDays") =>
    items.reduce((total, item) => total + item.after[field], 0);
  const totalBefore = teachers.reduce((total, item) => ({
    gapMinutes: total.gapMinutes + item.before.gapMinutes,
    gapCount: total.gapCount + item.before.gapCount,
    bothShiftDays: total.bothShiftDays + item.before.bothShiftDays,
  }), { gapMinutes: 0, gapCount: 0, bothShiftDays: 0 });
  const totalAfter = { gapMinutes: sum(teachers, "gapMinutes"), gapCount: sum(teachers, "gapCount"), bothShiftDays: sum(teachers, "bothShiftDays") };
  parentPort?.postMessage({ type: "result", result, teacherComfort: { before: totalBefore, after: totalAfter, teachers } });
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : "Не удалось составить расписание.",
  });
}
