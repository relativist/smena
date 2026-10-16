import assert from "node:assert/strict";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import { weekOffsetFor } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";

const makeDay = (date: string, slotCount = 7, slots?: Schedule[string][number]["slots"][number][], holiday = false) => ({
  date,
  start: "08:30",
  duration: 45,
  breaks: Array.from({ length: slotCount }, () => 10),
  times: Array.from({ length: slotCount }, (_, index) => ({ start: 510 + index * 55, duration: 45 })),
  slots: slots ?? Array.from({ length: slotCount }, () => []),
  holiday,
});

function makeCatalog(options: {
  groups?: Array<{ id: string; name: string; students?: number }>;
  subjectIds?: string[];
  subgroups?: Catalog["subgroups"];
  teachers?: Catalog["teachers"];
  jointGroupSets?: string[][];
} = {}): Catalog {
  const groups = options.groups ?? [{ id: "g1", name: "5А", students: 20 }];
  const subjectIds = options.subjectIds ?? ["math"];
  return {
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      students: group.students ?? 20,
      leaderId: null,
      roomId: null,
      autoRoomIds: [],
      archived: false,
    })),
    subgroups: options.subgroups ?? [],
    subjects: subjectIds.map((id) => ({
      id,
      name: id,
      shortName: id,
      color: "blue",
      roomKind: null,
      labRoomKind: null,
      archived: false,
      ...(options.jointGroupSets ? { jointGroupSets: options.jointGroupSets } : {}),
    })),
    teachers: options.teachers ?? subjectIds.map((id, index) => ({
      id: `t${index + 1}`,
      name: `Учитель ${index + 1}`,
      subjectIds: [id],
      defaultRoomId: null,
      archived: false,
    })),
    rooms: Array.from({ length: Math.max(2, subjectIds.length) }, (_, index) => ({
      id: `r${index + 1}`,
      name: `Кабинет ${index + 1}`,
      kind: "general" as const,
      capacity: 100,
      archived: false,
    })),
  };
}

function makePlan(groupId: string, subjectId: string, target: number, subgroupId: string | null = null): StudyPlan {
  return {
    id: `${groupId}-${subjectId}-${subgroupId ?? "whole"}`,
    quarterId: "q1",
    groupId,
    subjectId,
    mode: subgroupId ? "subgroups" : "whole",
    lessonKind: "regular",
    assignments: [{ id: `a-${groupId}-${subjectId}-${subgroupId ?? "whole"}`, subgroupId, target }],
  };
}

const quarterFor = (dates: string[]): Quarter => ({
  id: "q1",
  name: "I четверть",
  startDate: dates[0],
  endDate: dates.at(-1)!,
});

function generate(catalog: Catalog, studyPlans: StudyPlan[], daysByGroup: Record<string, ReturnType<typeof makeDay>[]>) {
  const schedule: Schedule = {};
  for (const [groupId, days] of Object.entries(daysByGroup))
    for (const day of days) {
      const key = `${groupId}:${weekOffsetFor(day.date)}`;
      (schedule[key] ??= []).push(day);
    }
  const dates = Object.values(daysByGroup).flat().map((day) => day.date).sort();
  return generateQuarter({ catalog, studyPlans, schedule, quarters: [quarterFor(dates)] }, "q1", Object.keys(daysByGroup));
}

const lesson = (id: string, subjectId: string, teacherId = "t1", roomId = "r1") => ({
  id, subjectId, teacherId, teacher: teacherId, roomId, room: roomId,
});

function occupiedCells(day: Pick<Schedule[string][number], "slots">) {
  return day.slots.filter((slot) => slot.length > 0).length;
}

{
  const subjectIds = ["s1", "s2", "s3", "s4"];
  const catalog = makeCatalog({ subjectIds, teachers: subjectIds.map((id, index) => ({
    id: `t${index + 1}`, name: `Учитель ${index + 1}`, subjectIds: [id], defaultRoomId: null, archived: false,
  })) });
  const plans = subjectIds.map((id) => makePlan("g1", id, 2));
  const result = generate(catalog, plans, { g1: [makeDay("2026-10-05", 10)] });
  assert.equal(result.added.length, 7, "auto placement caps a group at seven occupied cells per day");
  assert.equal(result.remaining.reduce((sum, row) => sum + row.missing, 0), 1);
  assert.ok(result.remaining.some((row) => row.reason.includes("лимит 7")), "the unmet plan explains the daily cap");
}

{
  const catalog = makeCatalog({
    subgroups: [
      { id: "sg1", name: "5А/1", groupId: "g1", students: 10, archived: false },
      { id: "sg2", name: "5А/2", groupId: "g1", students: 10, archived: false },
    ],
    subjectIds: ["s1", "s2", "s3", "s4"],
    teachers: ["s1", "s2", "s3", "s4"].flatMap((subjectId, index) => [
      { id: `t${index * 2 + 1}`, name: `Учитель ${index * 2 + 1}`, subjectIds: [subjectId], defaultRoomId: null, archived: false },
      { id: `t${index * 2 + 2}`, name: `Учитель ${index * 2 + 2}`, subjectIds: [subjectId], defaultRoomId: null, archived: false },
    ]),
  });
  const plans = ["sg1", "sg2"].flatMap((subgroupId) =>
    ["s1", "s2", "s3", "s4"].map((subjectId) => makePlan("g1", subjectId, 2, subgroupId)));
  const result = generate(catalog, plans, {
    g1: [makeDay("2026-10-05", 7)],
  });
  assert.equal(result.added.length, 14, "parallel subgroup cards still fit into seven group cells");
  assert.equal(occupiedCells(result.schedule["g1:0"][0]), 7);
  assert.equal(result.remaining.reduce((sum, row) => sum + row.missing, 0), 2, "each subgroup has one unplaced lesson after seven cells are used");
}

{
  const oldSubjects = Array.from({ length: 8 }, (_, index) => `old${index}`);
  const catalog = makeCatalog({ subjectIds: [...oldSubjects, "new"] });
  const slots = Array.from({ length: 10 }, (_, index) => index < 8
    ? [lesson(`old-${index}`, oldSubjects[index], `t${index + 1}`, `r${index + 1}`)]
    : []);
  const result = generate(catalog, [makePlan("g1", "new", 1)], {
    g1: [makeDay("2026-10-05", 10, slots)],
  });
  assert.equal(result.added.length, 0, "a legacy day above the limit receives no additional lesson cards");
  assert.equal(result.remaining[0]?.missing, 1);
  assert.equal(result.schedule["g1:0"][0].slots.flat().filter((row) => row.id.startsWith("old-")).length, 8);
  assert.equal(occupiedCells(result.schedule["g1:0"][0]), 8);
}

{
  const subjects = ["old1", "old2", "old3", "old4", "old5", "old6", "new"];
  const catalog = makeCatalog({ subjectIds: subjects });
  const event = { id: "event", subjectId: "event", event: "Собрание" };
  const slots = Array.from({ length: 8 }, (_, index) => index === 0
    ? [event]
    : index < 7 ? [lesson(`old-${index}`, subjects[index - 1], `t${index}`, `r${index}`)] : []);
  const result = generate(catalog, [makePlan("g1", "new", 1)], {
    g1: [makeDay("2026-10-05", 8, slots)],
  });
  assert.equal(result.added.length, 0, "an event occupies one of the seven daily cells");
  assert.equal(result.remaining[0]?.reason.includes("лимит 7"), true);
  assert.equal(result.schedule["g1:0"][0].slots[0][0].id, "event");
}

{
  const weekdays = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
  const subjectIds = ["s1", "s2", "s3", "s4", "s5"];
  const catalog = makeCatalog({ subjectIds });
  const result = generate(catalog, subjectIds.map((id) => makePlan("g1", id, 10)), {
    g1: weekdays.map((date) => makeDay(date, 7)),
  });
  const generatedCellsByDate = new Map<string, number>();
  for (const row of result.added) generatedCellsByDate.set(row.date, (generatedCellsByDate.get(row.date) ?? 0) + 1);
  const dailyLoads = weekdays.map((date) => generatedCellsByDate.get(date) ?? 0);
  assert.equal(result.added.length, 50);
  assert.ok(Math.max(...dailyLoads) - Math.min(...dailyLoads) <= 1, `daily loads should be even: ${dailyLoads}`);
  const weekLoads = new Map<number, number>();
  for (const row of result.added) weekLoads.set(weekOffsetFor(row.date), (weekLoads.get(weekOffsetFor(row.date)) ?? 0) + 1);
  const weekly = [...weekLoads.values()];
  assert.ok(Math.max(...weekly) - Math.min(...weekly) <= 2, `weekly loads should be even: ${weekly}`);
}

{
  const subjects = ["s1", "s2", "s3", "s4"];
  const teachingDates = ["2026-10-05", "2026-10-06", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
  const catalog = makeCatalog({ subjectIds: subjects });
  const result = generate(catalog, subjects.map((id) => makePlan("g1", id, 7)), {
    g1: [
      makeDay("2026-10-05", 7), makeDay("2026-10-06", 7), makeDay("2026-10-07", 7, undefined, true),
      ...teachingDates.slice(2).map((date) => makeDay(date, 7)),
    ],
  });
  const weekLoads = new Map<number, number>();
  for (const row of result.added) weekLoads.set(weekOffsetFor(row.date), (weekLoads.get(weekOffsetFor(row.date)) ?? 0) + 1);
  const [partialWeek, fullWeek] = [...weekLoads.entries()].sort(([a], [b]) => a - b).map(([, count]) => count);
  assert.equal(result.added.length, 28, "partial and holiday weeks do not prevent valid work from fitting");
  assert.equal(result.remaining.length, 0);
  assert.ok(Math.abs(partialWeek / 2 - fullWeek / 5) <= 1, `teaching-day averages should account for partial week/holiday: ${partialWeek} vs ${fullWeek}`);
}

{
  const subjects = ["manual1", "manual2", "manual3", "manual4", "math", "science"];
  const catalog = makeCatalog({ subjectIds: subjects });
  const loadedSlots = Array.from({ length: 7 }, (_, index) => index < 4 ? [lesson(`manual-${index}`, subjects[index], `t${index + 1}`)] : []);
  const result = generate(catalog, [makePlan("g1", "math", 1), makePlan("g1", "science", 1)], {
    g1: [makeDay("2026-10-05", 7, loadedSlots), makeDay("2026-10-06", 7)],
  });
  assert.equal(result.added.length, 2);
  assert.ok(result.added.every((row) => row.date === "2026-10-06"), "new work should prefer the lighter day");
}

{
  const catalog = makeCatalog({
    groups: [{ id: "g1", name: "5А" }, { id: "g2", name: "5Б" }],
    subjectIds: ["joint"],
    jointGroupSets: [["g1", "g2"]],
  });
  catalog.teachers[0].defaultRoomId = "r1";
  catalog.teachers.push({
    id: "joint-alt", name: "Второй учитель", subjectIds: ["joint"],
    defaultRoomId: "r1", preferredGroupIds: ["g2"], archived: false,
  });
  const event = (id: string) => ({ id, subjectId: "event", event: "Классное мероприятие" });
  const daysByGroup = {
    g1: [makeDay("2026-10-05", 9, Array.from({ length: 9 }, (_, slot) => slot < 6 ? [event(`g1-${slot}`)] : []))],
    g2: [makeDay("2026-10-05", 9, Array.from({ length: 9 }, (_, slot) => [0, 3, 4, 5, 7, 8].includes(slot) ? [event(`g2-${slot}`)] : []))],
  };
  const plans = [makePlan("g1", "joint", 1), makePlan("g2", "joint", 1)];
  const separateCatalog = structuredClone(catalog);
  separateCatalog.subjects[0].jointGroupSets = [];
  const separate = generate(separateCatalog, plans, daysByGroup);
  assert.equal(separate.added.find((row) => row.groupId === "g1")!.slot, 6);
  assert.equal(separate.added.find((row) => row.groupId === "g2")!.slot, 1, "teacher preference initially puts the second group in another slot");

  const result = generate(catalog, plans, daysByGroup);
  const first = result.added.find((row) => row.groupId === "g1")!;
  const second = result.added.find((row) => row.groupId === "g2")!;
  assert.equal(first.slot, 6);
  assert.equal(second.slot, 6, "postpass moves the separately generated lesson into the common slot");
  assert.equal(first.teacherId, "joint-alt", "postpass selects the common preferred teacher");
  const firstLesson = result.schedule["g1:0"][0].slots[6].find((row) => row.id === first.lessonId)!;
  const secondLesson = result.schedule["g2:0"][0].slots[6].find((row) => row.id === second.lessonId)!;
  assert.ok(firstLesson.jointId && firstLesson.jointId === secondLesson.jointId);
  assert.equal(result.schedule["g2:0"][0].slots[1].length, 0, "the original slot is freed");
  for (const groupId of ["g1", "g2"])
    assert.equal(occupiedCells(result.schedule[`${groupId}:0`][0]), 7, "joint postpass preserves a full seven-cell day");
}

console.log("generation balance scenarios passed");
