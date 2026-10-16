import assert from "node:assert/strict";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";

const catalog: Catalog = {
  groups: ["g1", "g2"].map((id, index) => ({
    id, name: index === 0 ? "5А" : "5Б", students: 20, leaderId: null,
    roomId: null, autoRoomIds: [], archived: false,
  })),
  subgroups: [],
  subjects: [{
    id: "pe", name: "Физкультура", shortName: "Физ-ра", color: "green",
    roomKind: null, labRoomKind: null, archived: false, jointSameGrade: true,
  }],
  teachers: ["t1", "t2"].map((id) => ({
    id, name: id, subjectIds: ["pe"], defaultRoomId: "small", archived: false,
  })),
  rooms: [
    { id: "small", name: "Малый", kind: "general", capacity: 20, archived: false },
    { id: "large", name: "Большой", kind: "general", capacity: 40, archived: false },
  ],
};

const day = (date: string, slots: Schedule[string][number]["slots"] = [[], [], []]) => ({
  date, start: "08:30", duration: 45,
  times: slots.map((_, index) => ({ start: 510 + index * 55, duration: 45 })),
  breaks: slots.map(() => 10), slots,
});
const plans: StudyPlan[] = ["g1", "g2"].map((groupId) => ({
  id: `${groupId}-pe`, quarterId: "q1", groupId, subjectId: "pe",
  mode: "whole", lessonKind: "regular",
  assignments: [{ id: `${groupId}-assignment`, subgroupId: null, target: 1 }],
}));
const quarter: Quarter = { id: "q1", name: "I четверть", startDate: "2026-09-01", endDate: "2026-09-04" };
const baseSchedule: Schedule = {
  "g1:-1": [day("2026-09-01")],
  "g2:-1": [day("2026-09-01")],
};
const state = (schedule: Schedule = baseSchedule) => ({ catalog, schedule, quarters: [quarter], studyPlans: plans });
const addedLessons = (result: ReturnType<typeof generateQuarter>) => result.added.map((entry) =>
  result.schedule[`${entry.groupId}:-1`].find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot]
    .find((lesson) => lesson.id === entry.lessonId) as (typeof result.schedule[string][number]["slots"][number][number] & { jointId?: string }),
);

{
  for (const options of [undefined, { allowJointLessons: true }]) {
    const result = generateQuarter(state(), "q1", ["g1", "g2"], options);
    const lessons = addedLessons(result);
    assert.equal(lessons.length, 2);
    assert.ok(lessons[0].jointId && lessons[0].jointId === lessons[1].jointId,
      "joint lessons remain enabled by default and when explicitly enabled");
    assert.equal(lessons[0].roomId, "large", "joint generation reserves a room sized for the combined groups");
  }
}

{
  const result = generateQuarter(state(), "q1", ["g1", "g2"], { allowJointLessons: false });
  const lessons = addedLessons(result);
  assert.equal(lessons.length, 2);
  assert.ok(lessons.every((lesson) => !lesson.jointId), "disabled mode never creates new joint lessons");
  assert.ok(lessons.every((lesson) => lesson.roomId === "small"), "disabled mode uses ordinary teacher room preference");
  assert.notEqual(result.added[0].slot, result.added[1].slot, "independent groups use separate times when sharing resources");
  assert.equal(result.remaining.length, 0);
}

{
  const jointId = "existing-joint";
  const manual = { id: "manual", subjectId: "pe", teacherId: "t1", teacher: "t1", roomId: "large", room: "large", jointId };
  const schedule: Schedule = {
    "g1:-1": [day("2026-09-01", [[manual], [], []])],
    "g2:-1": [day("2026-09-01", [[{ ...manual, id: "manual-peer" }], [], []])],
  };
  const result = generateQuarter(state(schedule), "q1", ["g1", "g2"], { allowJointLessons: false });
  assert.equal(result.added.length, 0, "already-satisfied manual joint plans are not regenerated");
  assert.deepEqual(result.schedule, schedule, "existing joint mirrors remain unchanged");
}

console.log("generation joint option scenarios passed");
