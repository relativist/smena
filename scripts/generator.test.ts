import assert from "node:assert/strict";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";

const quarter: Quarter = {
  id: "q1",
  name: "I четверть",
  startDate: "2026-09-01",
  endDate: "2026-09-04",
};
const baseCatalog: Catalog = {
  groups: [
    {
      id: "g1",
      name: "5А",
      students: 20,
      leaderId: null,
      roomId: "main",
      autoRoomIds: ["main"],
      archived: false,
    },
  ],
  subgroups: [
    { id: "sg1", name: "5А/1", groupId: "g1", students: 10, archived: false },
    { id: "sg2", name: "5А/2", groupId: "g1", students: 10, archived: false },
  ],
  subjects: [
    {
      id: "math",
      name: "Математика",
      shortName: "Матем.",
      color: "blue",
      roomKind: null,
      labRoomKind: null,
      archived: false,
    },
    {
      id: "physics",
      name: "Физика",
      shortName: "Физ.",
      color: "green",
      roomKind: null,
      labRoomKind: "physics-lab",
      archived: false,
    },
  ],
  teachers: [
    {
      id: "t1",
      name: "Иванова Анна",
      subjectIds: ["math", "physics"],
      defaultRoomId: null,
      archived: false,
    },
    {
      id: "t2",
      name: "Петров Пётр",
      subjectIds: ["math"],
      defaultRoomId: null,
      archived: false,
    },
  ],
  rooms: [
    {
      id: "main",
      name: "Основной",
      kind: "general",
      capacity: 30,
      archived: false,
    },
    {
      id: "other",
      name: "Свободный",
      kind: "general",
      capacity: 30,
      archived: false,
    },
    {
      id: "small",
      name: "Маленький",
      kind: "general",
      capacity: 8,
      archived: false,
    },
    {
      id: "lab",
      name: "Лаборатория",
      kind: "physics-lab",
      capacity: 20,
      archived: false,
    },
  ],
};

function day(
  date: string,
  slots: Schedule[string][number]["slots"] = [[], [], [], []],
  holiday = false,
) {
  return {
    date,
    start: "08:30",
    duration: 45,
    breaks: [10, 10, 10, 10],
    slots,
    times: slots.map((_, index) => ({ start: 510 + index * 55, duration: 45 })),
    holiday,
  };
}
function state(
  plans: StudyPlan[],
  schedule: Schedule = {
    "g1:-1": [
      day("2026-09-01"),
      day("2026-09-02"),
      day("2026-09-03", [[], [], [], []], true),
      day("2026-09-04"),
    ],
  },
  catalog = baseCatalog,
) {
  return { catalog, schedule, quarters: [quarter], studyPlans: plans };
}
const plan = (
  subjectId: string,
  target: number,
  subgroupId: string | null = null,
  lessonKind: "regular" | "lab" = "regular",
): StudyPlan => ({
  id: `${subjectId}-${subgroupId ?? "all"}-${lessonKind}`,
  quarterId: "q1",
  groupId: "g1",
  subjectId,
  mode: subgroupId ? "subgroups" : "whole",
  lessonKind,
  assignments: [{ id: `a-${subgroupId ?? "all"}`, subgroupId, target }],
});

{
  const existing = {
    id: "manual",
    subjectId: "math",
    teacherId: "t1",
    teacher: "Иванова",
    roomId: "main",
    room: "Основной",
  };
  const original = state([plan("math", 3)], {
    "g1:-1": [
      day("2026-09-01", [[existing], [], [], []]),
      day("2026-09-02"),
      day("2026-09-03", [[], [], [], []], true),
      day("2026-09-04"),
    ],
  });
  const before = structuredClone(original.schedule);
  const result = generateQuarter(original, "q1", ["g1"]);
  assert.equal(
    result.added.length,
    2,
    "counts the existing hour toward the plan",
  );
  assert.deepEqual(original.schedule, before, "does not mutate input");
  assert.equal(
    result.schedule["g1:-1"][0].slots[0][0].id,
    "manual",
    "retains the existing lesson",
  );
  assert.equal(
    result.added.every((entry) => entry.teacherId && entry.roomId),
    true,
  );
  assert.equal(
    result.added.some((entry) => entry.date === "2026-09-03"),
    false,
    "skips holidays",
  );
}

{
  const result = generateQuarter(
    state([plan("math", 2, "sg1"), plan("math", 2, "sg2")]),
    "q1",
    ["g1"],
  );
  assert.equal(result.added.length, 4);
  assert.equal(
    result.added.filter(
      (entry) =>
        entry.date === result.added[0].date &&
        entry.slot === result.added[0].slot,
    ).length >= 1,
    true,
  );
  assert.equal(
    result.remaining.length,
    0,
    "separate subgroups can use parallel slots",
  );
}

{
  const oldSelected = { id: "old-selected", subjectId: "math", teacherId: "t1", roomId: "main" };
  const oldOther = { id: "old-other", subjectId: "math", teacherId: "t1", roomId: "main" };
  const source = state([plan("math", 1)], {
    "g1:-1": [day("2026-09-01", [[oldSelected], [], [], []]), day("2026-09-02"), day("2026-09-03", [[], [], [], []], true), day("2026-09-04")],
    "g2:-1": [day("2026-09-01", [[oldOther], [], [], []]), day("2026-09-02"), day("2026-09-03", [[], [], [], []], true), day("2026-09-04")],
  });
  const result = generateQuarter(source, "q1", ["g1"], { preserveExisting: false });
  assert.equal(result.removedCount, 1);
  assert.equal(result.schedule["g1:-1"][0].slots.flat().some((lesson) => lesson.id === "old-selected"), false);
  assert.equal(result.schedule["g2:-1"][0].slots[0][0].id, "old-other");
  const first = generateQuarter(state([plan("math", 1)]), "q1", ["g1"]);
  const second = generateQuarter({ ...state([plan("math", 1)]), schedule: first.schedule }, "q1", ["g1"]);
  assert.equal(second.added.length, 0, "a second generation preserves already counted lessons");
  assert.equal(second.removedCount, 0);
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [{ ...baseCatalog.groups[0], autoRoomIds: ["main"] }],
  };
  const result = generateQuarter(
    state([plan("physics", 2, null, "lab")], undefined, catalog),
    "q1",
    ["g1"],
  );
  assert.equal(result.added.length, 2);
  assert.ok(
    result.added.every((entry) => entry.roomId === "lab"),
    "lab room kind overrides ordinary rooms",
  );
  const ordinary = generateQuarter(
    state([plan("math", 2)], undefined, catalog),
    "q1",
    ["g1"],
  );
  assert.ok(
    ordinary.added.every((entry) => entry.roomId === "main"),
    "prefers group-listed rooms",
  );
  assert.equal(ordinary.fallbackRoomCount, 0);
  const crowdedPreference: Catalog = {
    ...catalog,
    groups: [{ ...catalog.groups[0], autoRoomIds: ["small"] }],
  };
  const fallback = generateQuarter(
    state([plan("math", 1)], undefined, crowdedPreference),
    "q1",
    ["g1"],
  );
  assert.equal(
    fallback.added[0].roomId,
    "main",
    "uses another suitable room after group preferences",
  );
  assert.equal(fallback.fallbackRoomCount, 0, "the group's roomId remains a preference when its auto room is too small");
}

{
  const fixture: Catalog = {
    ...baseCatalog,
    groups: [{ ...baseCatalog.groups[0], roomId: "group312", autoRoomIds: ["auto316"] }],
    teachers: [
      { ...baseCatalog.teachers[0], defaultRoomId: "teacher315", preferredGroupIds: ["g1"] },
      { ...baseCatalog.teachers[1], defaultRoomId: "other-default" },
    ],
    rooms: [
      { id: "teacher315", name: "315", kind: "general", capacity: 30, archived: false },
      { id: "group312", name: "312", kind: "general", capacity: 30, archived: false },
      { id: "auto316", name: "316", kind: "general", capacity: 30, archived: false },
      { id: "other-default", name: "317", kind: "general", capacity: 30, archived: false },
    ],
  };
  const oneSlot: Schedule = { "g1:-1": [day("2026-09-01", [[]])] };
  const assign = (catalog: Catalog, schedule = oneSlot) =>
    generateQuarter(state([plan("math", 1)], schedule, catalog), "q1", ["g1"]).added[0];
  const generated = generateQuarter(state([plan("math", 1)], oneSlot, fixture), "q1", ["g1"]);
  assert.equal(generated.added[0].teacherId, "t1");
  assert.equal(generated.added[0].roomId, "teacher315", "the assigned teacher's default room comes before group and auto rooms");

  const absence = (id: string) => ({ id, startDate: "2026-09-01", endDate: "2026-09-01", start: 510, end: 555 });
  for (const [label, unavailableRoom] of [
    ["unavailable", { ...fixture.rooms[0], unavailability: [absence("315-closed")] }],
    ["archived", { ...fixture.rooms[0], archived: true }],
    ["wrong type", { ...fixture.rooms[0], kind: "gym" as const }],
    ["undersized", { ...fixture.rooms[0], capacity: 10 }],
  ] satisfies Array<[string, Catalog["rooms"][number]]>) {
    const catalog = { ...fixture, rooms: [unavailableRoom, ...fixture.rooms.slice(1)] };
    assert.equal(assign(catalog)?.roomId, "group312", `${label} teacher default falls through to the group room`);
  }
  const busyDefaultSchedule: Schedule = {
    ...oneSlot,
    "g2:-1": [day("2026-09-01", [[{ id: "busy-315", subjectId: "math", roomId: "teacher315" }]])],
  };
  const busyFixture = { ...fixture, groups: [...fixture.groups, { ...fixture.groups[0], id: "g2", name: "5Б" }] };
  assert.equal(assign(busyFixture, busyDefaultSchedule)?.roomId, "group312", "a busy teacher default falls through to the group room");

  const groupRoomClosed = { ...fixture, rooms: fixture.rooms.map((room) => ["teacher315", "group312"].includes(room.id) ? { ...room, unavailability: [absence(`${room.id}-closed`)] } : room) };
  assert.equal(assign(groupRoomClosed)?.roomId, "auto316", "a closed group room falls through to the auto room");
  const twoClosed = { ...fixture, rooms: fixture.rooms.map((room) => ["teacher315", "group312", "auto316"].includes(room.id) ? { ...room, unavailability: [absence(`${room.id}-closed`)] } : room) };
  assert.equal(assign(twoClosed)?.roomId, "other-default", "closed group and auto rooms fall through to a suitable remaining room");
  const noGroupRoom = { ...fixture, groups: [{ ...fixture.groups[0], roomId: null, autoRoomIds: [] }] };
  assert.equal(assign(noGroupRoom)?.roomId, "teacher315", "teacher default remains preferred when the group has no room set");

  const secondTeacherFixture: Catalog = {
    ...fixture,
    teachers: [
      { ...fixture.teachers[0], preferredGroupIds: [], unavailability: [absence("t1-absent")] },
      { ...fixture.teachers[1], preferredGroupIds: ["g1"] },
    ],
  };
  const secondTeacherPlacement = assign(secondTeacherFixture);
  assert.equal(secondTeacherPlacement?.teacherId, "t2");
  assert.equal(secondTeacherPlacement?.roomId, "other-default", "uses the selected teacher's default, not the first qualified teacher's room");

  const noPreferences: Catalog = {
    ...fixture,
    groups: [{ ...fixture.groups[0], roomId: null, autoRoomIds: [] }],
    teachers: fixture.teachers.map((teacher) => ({ ...teacher, defaultRoomId: null })),
  };
  assert.equal(generateQuarter(state([plan("math", 1)], undefined, noPreferences), "q1", ["g1"]).fallbackRoomCount, 0,
    "general fallback statistics stay quiet when nobody has a room preference");
}

{
  const catalog: Catalog = { ...baseCatalog, teachers: [], rooms: [] };
  const result = generateQuarter(
    state([plan("math", 2)], undefined, catalog),
    "q1",
    ["g1"],
  );
  assert.equal(result.added.length, 0);
  assert.equal(result.remaining[0].missing, 2);
  assert.match(result.remaining[0].reason, /преподавателя/i);
}

{
  const noGeneralRooms: Catalog = {
    ...baseCatalog,
    rooms: baseCatalog.rooms.filter((room) => room.kind !== "general"),
  };
  const ordinary = generateQuarter(
    state([plan("math", 1)], undefined, noGeneralRooms),
    "q1",
    ["g1"],
  );
  assert.equal(
    ordinary.added.length,
    0,
    "ordinary lessons require a general room",
  );
  assert.match(ordinary.remaining[0].reason, /кабинет/i);

  const archivedSubgroup: Catalog = {
    ...baseCatalog,
    subgroups: baseCatalog.subgroups.map((entry) => ({
      ...entry,
      archived: entry.id === "sg1",
    })),
  };
  const split = generateQuarter(
    state([plan("math", 1, "sg1")], undefined, archivedSubgroup),
    "q1",
    ["g1"],
  );
  assert.equal(
    split.added.length,
    0,
    "an archived subgroup must not become a whole-group lesson",
  );
  assert.match(split.remaining[0].reason, /архивирована/i);
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      ...baseCatalog.groups,
      {
        id: "g2",
        name: "5Б",
        students: 20,
        leaderId: null,
        roomId: "main",
        autoRoomIds: ["main"],
        archived: false,
      },
    ],
  };
  const occupied = {
    id: "manual-g2",
    subjectId: "math",
    teacherId: "t1",
    teacher: "Иванова",
    roomId: "main",
    room: "Основной",
  };
  const original = state(
    [plan("math", 1)],
    {
      "g1:-1": [day("2026-09-01")],
      "g2:-1": [day("2026-09-01", [[occupied], [], [], []])],
    },
    catalog,
  );
  const result = generateQuarter(original, "q1", ["g1"]);
  assert.equal(result.added.length, 1);
  const placement = result.added[0];
  assert.equal(
    placement.date === "2026-09-01" &&
      placement.slot === 0 &&
      placement.teacherId === "t1" &&
      placement.roomId === "main",
    false,
    "avoids the actual teacher/room conflict",
  );
  assert.equal(
    result.schedule["g2:-1"][0].slots[0][0].id,
    "manual-g2",
    "does not rewrite unselected groups",
  );
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [baseCatalog.groups[0], { ...baseCatalog.groups[0], id: "g2", name: "5Б", students: 20 }],
    rooms: [...baseCatalog.rooms, { id: "large", name: "Большой", kind: "general", capacity: 50, archived: false }],
    subjects: baseCatalog.subjects.map((subject) => subject.id === "math" ? { ...subject, jointGroupSets: [["g1", "g2"]] } : subject),
  };
  const schedule = {
    "g1:-1": [day("2026-09-01"), day("2026-09-02"), day("2026-09-03", [[], [], [], []], true), day("2026-09-04")],
    "g2:-1": [day("2026-09-01"), day("2026-09-02"), day("2026-09-03", [[], [], [], []], true), day("2026-09-04")],
  };
  const plans = [plan("math", 1), { ...plan("math", 1), id: "math-g2", groupId: "g2" }];
  const result = generateQuarter(state(plans, schedule, catalog), "q1", ["g1", "g2"]);
  assert.equal(result.added.length, 2);
  assert.equal(result.added[0].date, result.added[1].date);
  assert.equal(result.added[0].slot, result.added[1].slot);
  const lessons = result.added.map((entry) => result.schedule[`${entry.groupId}:-1`].find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot][0]);
  assert.notEqual(lessons[0].id, lessons[1].id);
  const jointId = (lessons[0] as typeof lessons[number] & { jointId?: string }).jointId;
  assert.ok(jointId, "eligible whole-group lessons are marked as a joint session");
  assert.equal(jointId, (lessons[1] as typeof lessons[number] & { jointId?: string }).jointId);
  assert.equal(lessons[0].teacherId, lessons[1].teacherId);
  assert.equal(lessons[0].roomId, lessons[1].roomId);
  const tooSmall = generateQuarter(
    state(plans, schedule, { ...catalog, rooms: catalog.rooms.filter((room) => room.id !== "large") }),
    "q1",
    ["g1", "g2"],
  );
  const unpaired = tooSmall.added.map((entry) =>
    tooSmall.schedule[`${entry.groupId}:-1`].find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot][0],
  );
  assert.equal((unpaired[0] as typeof unpaired[number] & { jointId?: string }).jointId, undefined,
    "insufficient combined room capacity blocks joint scheduling");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      baseCatalog.groups[0],
      { ...baseCatalog.groups[0], id: "g2", name: "5Б" },
      { ...baseCatalog.groups[0], id: "g3", name: "6А" },
    ],
    rooms: [...baseCatalog.rooms, { id: "large", name: "Большой", kind: "general", capacity: 100, archived: false }],
    subjects: baseCatalog.subjects.map((subject) => subject.id === "math" ? { ...subject, jointSameGrade: true } : subject),
  };
  const dates = ["2026-09-01", "2026-09-02", "2026-09-08", "2026-09-09"];
  const schedule: Schedule = Object.fromEntries(["g1", "g2", "g3"].map((groupId) => [
    `${groupId}:-1`, dates.map((date) => day(date)),
  ]));
  const plans = ["g1", "g2", "g3"].map((groupId) => ({ ...plan("math", 2), groupId, id: `math-${groupId}` }));
  const multiweekQuarter = { ...quarter, endDate: "2026-09-10" };
  const result = generateQuarter({ ...state(plans, schedule, catalog), quarters: [multiweekQuarter] }, "q1", ["g1", "g2", "g3"]);
  assert.equal(result.added.length, 6);
  assert.equal(new Set(result.added.map((entry) => entry.lessonId)).size, result.added.length, "each generated placement keeps a unique ID");
  const distinctWeeks = new Set(result.added.map((entry) => Math.floor((Date.parse(`${entry.date}T00:00:00Z`) - Date.parse("2026-09-01T00:00:00Z")) / (7 * 86400000))));
  assert.ok(distinctWeeks.size >= 2, "placements span both available weeks");
  for (const groupId of ["g1", "g2", "g3"])
    assert.ok(new Set(result.added.filter((entry) => entry.groupId === groupId).map((entry) => Math.floor((Date.parse(`${entry.date}T00:00:00Z`) - Date.parse("2026-09-01T00:00:00Z")) / (7 * 86400000)))).size >= 2,
      `${groupId} hours are spread across both weeks`);
  const jointRows = result.added.filter((entry) => (result.schedule[`${entry.groupId}:-1`].find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot][0] as { jointId?: string }).jointId);
  assert.ok(jointRows.length >= 2, "same-grade groups can share generated PE");
  assert.equal(result.added.filter((entry) => entry.groupId === "g3").some((entry) =>
    Boolean((result.schedule["g3:-1"].find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot][0] as { jointId?: string }).jointId),
  ), false, "groups from another grade are not joined");
  const seen = new Map<string, string>();
  for (const placement of result.added) {
    const dayRow = result.schedule[`${placement.groupId}:-1`].find((entryDay) => entryDay.date === placement.date)!;
    assert.equal(dayRow.slots.flat().filter((lesson) => lesson.id === placement.lessonId).length, 1, "mirrors appear exactly once");
    const time = dayRow.times[placement.slot];
    const lesson = dayRow.slots[placement.slot].find((entry) => entry.id === placement.lessonId)! as { jointId?: string };
    for (const resource of [placement.teacherId, placement.roomId]) {
      const key = `${resource}|${placement.date}|${time.start}`;
      const priorJoint = seen.get(key);
      if (priorJoint) assert.equal(priorJoint, lesson.jointId, "shared resources overlap only inside one joint session");
      else seen.set(key, lesson.jointId ?? placement.lessonId);
    }
  }
}

{
  const slots = Array.from({ length: 6 }, () => [] as Schedule[string][number]["slots"][number]);
  const onlyDay = day("2026-09-01", slots);
  const result = generateQuarter(
    state([plan("math", 2), plan("math", 1, null, "lab")], { "g1:-1": [onlyDay] }),
    "q1",
    ["g1"],
  );
  const row = result.schedule["g1:-1"][0];
  const subjectCount = row.slots.flat().filter((lesson) => lesson.subjectId === "math").length;
  assert.equal(result.added.length, 2);
  assert.equal(subjectCount, 2, "regular and lab lessons share a two-per-day cap");
  assert.equal(result.remaining[0].missing, 1, "the generator leaves excess demand visible");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      baseCatalog.groups[0],
      { ...baseCatalog.groups[0], id: "g2", name: "5Б" },
      { ...baseCatalog.groups[0], id: "g3", name: "5В" },
      { ...baseCatalog.groups[0], id: "g4", name: "6А" },
    ],
    teachers: [...baseCatalog.teachers, { id: "tpe", name: "Учитель PE", subjectIds: ["pe"], defaultRoomId: null, archived: false }],
    rooms: [...baseCatalog.rooms, { id: "gym", name: "Спортзал", kind: "gym", capacity: null, archived: false }],
    subjects: [...baseCatalog.subjects, {
      id: "pe", name: "Физкультура", shortName: "Физра", color: "green", roomKind: "gym", labRoomKind: null, archived: false, jointSameGrade: true, maxJointGroups: 3,
    }],
  };
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
  const schedule: Schedule = Object.fromEntries(["g1", "g2", "g3", "g4"].map((groupId) => [
    `${groupId}:-1`, dates.map((date) => day(date)),
  ]));
  const plans = ["g1", "g2", "g3", "g4"].flatMap((groupId) => [
    { ...plan("pe", 4), groupId, id: `pe-${groupId}` },
    { ...plan("math", 8), groupId, id: `math-${groupId}` },
  ]);
  const multiweekQuarter = { ...quarter, endDate: "2026-09-11" };
  const result = generateQuarter({ ...state(plans, schedule, catalog), quarters: [multiweekQuarter] }, "q1", ["g1", "g2", "g3", "g4"]);
  assert.equal(result.remaining.length, 0, "joint PE scheduling leaves no demand behind");
  assert.equal(result.added.length, 48);
  const peRows = result.added.filter((entry) => entry.subjectId === "pe");
  const jointIds = new Map<string, string[]>();
  for (const placement of peRows) {
    const lesson = result.schedule[`${placement.groupId}:-1`].find((entryDay) => entryDay.date === placement.date)!.slots[placement.slot].find((entry) => entry.id === placement.lessonId)! as { jointId?: string };
    if (lesson.jointId) jointIds.set(lesson.jointId, [...(jointIds.get(lesson.jointId) ?? []), placement.groupId]);
    if (placement.groupId === "g4") assert.equal(lesson.jointId, undefined, "different-grade PE remains independent");
  }
  assert.equal([...jointIds.values()].flat().filter((groupId) => groupId === "g1" || groupId === "g2" || groupId === "g3").length, 12);
  assert.ok([...jointIds.values()].every((groupIds) => new Set(groupIds).size === 3), "same-grade PE mirrors one session to all three groups");
  for (const groupId of ["g1", "g2", "g3", "g4"]) {
    const weekNumbers = new Set(result.added.filter((entry) => entry.groupId === groupId).map((entry) => Math.floor((Date.parse(`${entry.date}T00:00:00Z`) - Date.parse("2026-09-01T00:00:00Z")) / (7 * 86400000))));
    assert.ok(weekNumbers.size >= 2, `${groupId} lessons span both weeks`);
  }
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      baseCatalog.groups[0],
      { ...baseCatalog.groups[0], id: "g2", name: "5Б" },
    ],
    teachers: [
      baseCatalog.teachers[0],
      { ...baseCatalog.teachers[1], preferredGroupIds: ["g1"] },
    ],
  };
  const dates = ["2026-09-01", "2026-09-02", "2026-09-04"];
  const schedule: Schedule = {
    "g1:-1": [
      day(dates[0], [[{ id: "established-t1", subjectId: "math", teacherId: "t1", roomId: "main" }], [], [], []]),
      ...dates.slice(1).map((date) => day(date)),
    ],
    "g2:-1": dates.map((date) =>
      day(date, [[{
        id: `loaded-${date}`,
        subjectId: "math",
        teacherId: "t1",
        roomId: "main",
      }], [], [], []])),
  };
  // t1 is the group's established teacher, while preferred t2 has a larger
  // existing load in the other group.
  const loadedSchedule: Schedule = {
    ...schedule,
    "g2:-1": dates.map((date) =>
      day(date, [[{
        id: `loaded-${date}`,
        subjectId: "math",
        teacherId: "t2",
        roomId: "main",
      }], [], [], []])),
  };
  const preferred = generateQuarter(
    state([plan("math", 2)], loadedSchedule, catalog),
    "q1",
    ["g1"],
  );
  assert.equal(preferred.added.length, 1);
  assert.equal(preferred.added[0].teacherId, "t2", "teacher load and the established subject teacher do not override the group preference");

  const singleSlotSchedule: Schedule = {
    "g1:-1": [day("2026-09-01", [[]])],
    "g2:-1": [day("2026-09-01", [[{
      id: "busy-preferred",
      subjectId: "math",
      teacherId: "t2",
      roomId: "main",
    }]])],
  };
  const fallback = generateQuarter(
    state([plan("math", 1)], singleSlotSchedule, catalog),
    "q1",
    ["g1"],
  );
  assert.equal(fallback.added.length, 1, "a busy preferred teacher does not block generation");
  assert.equal(fallback.added[0].teacherId, "t1", "uses another qualified teacher when the preferred one is busy");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    groups: [
      baseCatalog.groups[0],
      { ...baseCatalog.groups[0], id: "g2", name: "5Б" },
      { ...baseCatalog.groups[0], id: "g3", name: "5В" },
    ],
    rooms: [...baseCatalog.rooms, { id: "large", name: "Большой", kind: "general", capacity: 100, archived: false }],
    subjects: baseCatalog.subjects.map((subject) => subject.id === "math" ? { ...subject, jointSameGrade: true } : subject),
  };
  const schedule: Schedule = Object.fromEntries(["g1", "g2", "g3"].map((groupId) => [
    `${groupId}:-1`, [day("2026-09-01"), day("2026-09-02")],
  ]));
  const plans = ["g1", "g2", "g3"].map((groupId) => ({ ...plan("math", 1), groupId, id: `math-${groupId}` }));
  const result = generateQuarter(state(plans, schedule, catalog), "q1", ["g1", "g2", "g3"]);
  assert.equal(result.added.length, 3);
  const jointGroups = new Map<string, Set<string>>();
  for (const entry of result.added) {
    const lesson = result.schedule[`${entry.groupId}:-1`]
      .find((entryDay) => entryDay.date === entry.date)!.slots[entry.slot]
      .find((row) => row.id === entry.lessonId)! as { jointId?: string };
    if (lesson.jointId) {
      const groupSet = jointGroups.get(lesson.jointId) ?? new Set<string>();
      groupSet.add(entry.groupId);
      jointGroups.set(lesson.jointId, groupSet);
    }
  }
  assert.equal(jointGroups.size, 1, "the default cap still permits a two-group joint lesson");
  assert.deepEqual([...jointGroups.values()][0], new Set(["g1", "g2"]));
  assert.equal(result.added.find((entry) => entry.groupId === "g3") &&
    jointGroups.values().next().value?.has("g3"), false, "the third group remains in a separate lesson");
}

{
  const catalog: Catalog = {
    ...baseCatalog,
    subjects: [...baseCatalog.subjects, {
      id: "informatics", name: "Информатика", shortName: "Инф.", color: "blue", roomKind: "informatics", labRoomKind: null, archived: false,
    }],
    teachers: [...baseCatalog.teachers, {
      id: "computer-science-teacher", name: "Учитель Информатики", subjectIds: ["informatics"], defaultRoomId: null, archived: false,
    }],
  };
  const result = generateQuarter(
    state([plan("informatics", 1)], undefined, catalog),
    "q1",
    ["g1"],
  );
  assert.equal(result.added.length, 0);
  assert.match(result.remaining[0].reason, /Нет кабинетов типа «Информатика».*Проверьте тип кабинетов/i);
}

console.log("generator.test.ts: 14 checks passed");
