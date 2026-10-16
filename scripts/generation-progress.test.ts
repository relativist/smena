import assert from "node:assert/strict";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  groups: [{ id: "g1", name: "5А", students: 20, leaderId: null, roomId: null, autoRoomIds: [], archived: false }],
  subgroups: [],
  subjects: [{ id: "math", name: "Математика", shortName: "Матем.", color: "blue", roomKind: null, labRoomKind: null, archived: false }],
  teachers: [{ id: "t1", name: "Иванова Анна", subjectIds: ["math"], defaultRoomId: null, archived: false }],
  rooms: [{ id: "r1", name: "Кабинет 1", kind: "general", capacity: 30, archived: false }],
};
const schedule: Schedule = {
  "g1:-1": [
    { date: "2026-09-01", start: "08:30", duration: 45, breaks: [10], times: [{ start: 510, duration: 45 }], slots: [[]] },
  ],
};
const studyPlan: StudyPlan = {
  id: "p1",
  quarterId: "q1",
  groupId: "g1",
  subjectId: "math",
  mode: "whole",
  lessonKind: "regular",
  assignments: [{ id: "a1", subgroupId: null, target: 1 }],
};
const progress: Array<{ percent: number; phase: string }> = [];

const result = generateQuarter({
  catalog,
  schedule,
  quarters: [{ id: "q1", name: "I четверть", startDate: "2026-09-01", endDate: "2026-09-01" }],
  studyPlans: [studyPlan],
}, "q1", ["g1"], { onProgress: (value) => progress.push(value) });

assert.equal(result.added.length, 1);
assert.equal(progress[0]?.percent, 0, "generation announces its initial state");
assert.equal(progress.at(-1)?.percent, 100, "only the completed result reaches 100%");
assert.equal(progress.at(-1)?.phase, "done");
assert.ok(progress.every((value, index) => index === 0 || value.percent >= progress[index - 1].percent), "progress is monotonic");
assert.ok(progress.some((value) => value.phase === "placing"));
assert.ok(progress.some((value) => value.phase === "joining"));

const failedProgress: number[] = [];
assert.throws(() => generateQuarter({
  catalog,
  schedule,
  quarters: [],
  studyPlans: [studyPlan],
}, "missing", ["g1"], { onProgress: (value) => failedProgress.push(value.percent) }));
assert.deepEqual(failedProgress, [0], "a failed calculation never reports completion");
console.log("generation progress: 8 assertions passed");
