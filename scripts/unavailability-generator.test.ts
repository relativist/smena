import assert from "node:assert/strict";
import { generateQuarter } from "../shared/generateSchedule.ts";
import { lessonUnavailability } from "../shared/unavailability.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";

const date = "2026-09-01"; // Tuesday
const quarter: Quarter = {
  id: "q1",
  name: "I четверть",
  startDate: date,
  endDate: "2026-09-02",
};

function day(start = 510, slots: Schedule[string][number]["slots"] = [[]], lessonDate = date) {
  return {
    date: lessonDate,
    start: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
    duration: 45,
    breaks: [],
    slots,
    times: slots.map((_, index) => ({ start: start + index * 55, duration: 45 })),
    holiday: false,
  };
}

const baseCatalog: Catalog = {
  groups: [{
    id: "g1", name: "5А", students: 20, leaderId: null,
    roomId: "main", autoRoomIds: ["main"], archived: false,
  }],
  subgroups: [],
  subjects: [{
    id: "math", name: "Математика", shortName: "Матем.", color: "blue",
    roomKind: null, labRoomKind: null, jointGroupSets: [["g1", "g2"]], archived: false,
  }],
  teachers: [
    { id: "t1", name: "Иванова Анна", subjectIds: ["math"], defaultRoomId: null, archived: false },
    { id: "t2", name: "Петров Пётр", subjectIds: ["math"], defaultRoomId: null, archived: false },
  ],
  rooms: [
    { id: "main", name: "Основной", kind: "general", capacity: 30, archived: false },
    { id: "other", name: "Свободный", kind: "general", capacity: 30, archived: false },
  ],
};

const plan = (groupId: string, target: number): StudyPlan => ({
  id: `math-${groupId}`,
  quarterId: "q1",
  groupId,
  subjectId: "math",
  mode: "whole",
  lessonKind: "regular",
  assignments: [{ id: `assignment-${groupId}`, subgroupId: null, target }],
});

function state(
  catalog: Catalog,
  plans: StudyPlan[],
  schedule: Schedule,
) {
  return { catalog, studyPlans: plans, schedule, quarters: [quarter] };
}

function unavailable(id: string, start = 510, end = 555, reason = "Больничный") {
  return { id, startDate: date, endDate: date, start, end, reason };
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    teachers: baseCatalog.teachers.map((teacher) => ({
      ...teacher,
      unavailability: [unavailable(`absence-${teacher.id}`, 480, 900)],
    })),
  };
  const manual = { id: "manual", subjectId: "math", teacherId: "t1", teacher: "Иванова", roomId: "main", room: "Основной" };
  const input = state(catalog, [plan("g1", 2)], { "g1:-1": [day(510, [[manual], []])] });
  const before = structuredClone(input);
  const result = generateQuarter(input, "q1", ["g1"]);
  assert.equal(result.added.length, 0, "does not allocate during a full teacher absence");
  assert.match(result.remaining[0]?.reason ?? "", /Учитель.*недоступен.*Больничный/);
  assert.equal(result.schedule["g1:-1"][0].slots[0][0]?.id, "manual", "keeps a pre-existing lesson despite new unavailability");
  assert.deepEqual(input, before, "does not mutate the input schedule or catalog");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    teachers: baseCatalog.teachers.map((teacher) => teacher.id === "t1"
      ? { ...teacher, unavailability: [unavailable("t1-absence")] }
      : teacher),
    rooms: baseCatalog.rooms.map((room) => room.id === "main"
      ? { ...room, unavailability: [unavailable("main-closed", 510, 555, "Ремонт")] }
      : room),
  };
  const result = generateQuarter(state(catalog, [plan("g1", 1)], { "g1:-1": [day()] }), "q1", ["g1"]);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0]?.teacherId, "t2", "chooses another qualified teacher");
  assert.equal(result.added[0]?.roomId, "other", "skips the unavailable room");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    teachers: [
      { id: "t1", name: "Иванова Анна", subjectIds: ["math"], defaultRoomId: null, archived: false,
        unavailability: [{ ...unavailable("weekly-end", 510, 555), startDate: "2026-09-01", endDate: "2026-09-30", weekdays: [2] }] },
    ],
    rooms: [baseCatalog.rooms[0]!],
  };
  const input = state(catalog, [plan("g1", 1)], {
    "g1:-1": [day(510), day(510, [[]], "2026-09-02")],
  });
  const before = structuredClone(input.schedule);
  const result = generateQuarter(input, "q1", ["g1"]);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0]?.date, "2026-09-02", "honors the recurring weekday selector");
  const boundary = generateQuarter(state(catalog, [plan("g1", 1)], { "g1:-1": [day(555)] }), "q1", ["g1"]);
  assert.equal(boundary.added[0]?.date, date, "allows a lesson that starts exactly when the recurring block ends");
  assert.deepEqual(input.schedule, before, "generation leaves original schedule untouched");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      { id: "g1", name: "5А", students: 10, leaderId: null, roomId: "room-a", autoRoomIds: ["room-a"], archived: false },
      { id: "g2", name: "5Б", students: 10, leaderId: null, roomId: "room-b", autoRoomIds: ["room-b"], archived: false },
    ],
    teachers: [
      { id: "blocked-common", name: "Недоступный Общий", subjectIds: ["math"], defaultRoomId: "closed-common", preferredGroupIds: ["g1", "g2"], archived: false, unavailability: [unavailable("blocked-common-rule")] },
      { id: "teacher-a", name: "Первый Учитель", subjectIds: ["math"], defaultRoomId: null, preferredGroupIds: ["g1"], archived: false },
      { id: "teacher-b", name: "Второй Учитель", subjectIds: ["math"], defaultRoomId: null, preferredGroupIds: ["g2"], archived: false },
      { id: "common", name: "Общий Учитель", subjectIds: ["math"], defaultRoomId: "common-room", preferredGroupIds: ["g1", "g2"], archived: false },
    ],
    rooms: [
      { id: "closed-common", name: "Закрытый общий", kind: "general", capacity: 25, archived: false, unavailability: [unavailable("closed-common-rule")] },
      { id: "common-room", name: "Общий кабинет", kind: "general", capacity: 25, archived: false },
      { id: "room-a", name: "Кабинет А", kind: "general", capacity: 25, archived: false },
      { id: "room-b", name: "Кабинет Б", kind: "general", capacity: 25, archived: false },
    ],
  };
  const result = generateQuarter(state(catalog, [plan("g1", 1), plan("g2", 1)], {
    "g1:-1": [day()],
    "g2:-1": [day()],
  }), "q1", ["g1", "g2"]);
  assert.equal(result.added.length, 2);
  const lessons = result.schedule["g1:-1"][0]!.slots.flat().concat(result.schedule["g2:-1"][0]!.slots.flat());
  assert.equal(new Set(lessons.map((lesson) => lesson.jointId)).size, 1, "the post-pass merges the matching cohort lessons");
  assert.ok(lessons.every((lesson) => lesson.teacherId === "common" && lesson.roomId === "common-room"), "the post-pass selects available common resources");
  assert.deepEqual(lessonUnavailability(catalog, {
    date,
    start: 510,
    end: 555,
    teacherId: lessons[0]?.teacherId,
    roomId: lessons[0]?.roomId,
  }), [], "post-pass resources have no unavailable interval");
}

console.log("unavailability generator tests passed");
