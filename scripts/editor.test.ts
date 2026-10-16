import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSlot,
  canPlace,
  createSchedule,
  editLesson,
  key,
  moveLesson,
  parseTime,
  placeLesson,
  roomOccupancies,
  removeLesson,
  setBreak,
  setSlotTime,
  setDayTime,
  dayTimeGrid,
  type Location,
  type Schedule,
} from "../src/editor.ts";
import { buildSeedCatalog } from "../shared/catalog-seed.ts";
import { findRoomConflict, newRoomConflict } from "../shared/roomConflicts.ts";
import type { Catalog } from "../shared/catalog.ts";
import {
  countPlanLessons,
  editorSubjects,
  teacherChoices,
} from "../src/catalogAdapter.ts";

function setup(): { schedule: Schedule; location: Location } {
  const schedule = createSchedule();
  const day = schedule[key("5a", 0)][0];
  return {
    schedule,
    location: { groupId: "5a", weekOffset: 0, date: day.date, slot: 0 },
  };
}

test("date-filtered room occupancies match full results for one day, including joint mirrors", () => {
  const schedule = createSchedule();
  for (const days of Object.values(schedule))
    for (const day of days) day.slots = day.slots.map(() => []);

  const dayA = schedule[key("5a", 0)][0];
  const dayB = schedule[key("5b", 0)].find((day) => day.date === dayA.date)!;
  const laterDay = schedule[key("5a", 0)].find((day) => day.date !== dayA.date)!;
  const jointLesson = {
    id: "date-filter-joint-a", jointId: "date-filter-joint", subjectId: "math",
    teacherId: "teacher", roomId: "room",
  };
  dayA.slots[0] = [jointLesson];
  dayB.slots[0] = [{ ...jointLesson, id: "date-filter-joint-b" }];
  laterDay.slots[0] = [{ id: "other-date", subjectId: "math", teacherId: "teacher", roomId: "room" }];

  const full = roomOccupancies(schedule);
  const filtered = roomOccupancies(schedule, dayA.date);
  assert.deepEqual(filtered, full.filter((entry) => entry.date === dayA.date));
  assert.deepEqual(filtered.map((entry) => entry.lessonId).sort(), [
    "date-filter-joint-a", "date-filter-joint-b",
  ]);
  assert.ok(full.some((entry) => entry.lessonId === "other-date"));
});

test("shortened day changes every slot and its breaks without changing other dates or groups", () => {
  const { schedule, location } = setup();
  const original = structuredClone(schedule);
  const day = schedule[key(location.groupId, location.weekOffset)][0];
  const breaks = Array(day.times.length - 1).fill(5);
  const next = setDayTime(schedule, location, 840, 30, breaks);
  const changed = next[key(location.groupId, location.weekOffset)][0];
  assert.deepEqual(changed.times, day.times.map((_, index) => ({ start: 840 + index * 35, duration: 30 })));
  assert.deepEqual(changed.breaks, breaks);
  assert.equal(changed.duration, 30);
  assert.equal(changed.start, "14:00");
  const appended = appendSlot(next, location)[key(location.groupId, location.weekOffset)][0];
  assert.equal(appended.times.at(-1)?.duration, 30);
  assert.equal(appended.times.at(-1)?.start, changed.times.at(-1)!.start + 35);
  assert.deepEqual(changed.slots, day.slots, "lessons, IDs and hours are preserved");
  assert.deepEqual(schedule, original, "undo can restore the untouched original");
  assert.deepEqual(next[key(location.groupId, location.weekOffset)].slice(1), schedule[key(location.groupId, location.weekOffset)].slice(1));
  for (const scheduleKey of Object.keys(schedule))
    if (scheduleKey !== key(location.groupId, location.weekOffset)) assert.equal(next[scheduleKey], schedule[scheduleKey]);
});

test("day timing can restore unequal school breaks after uniform short breaks", () => {
  const { schedule, location } = setup();
  const count = schedule[key(location.groupId, location.weekOffset)][0].times.length;
  const shortened = setDayTime(schedule, location, 510, 30, Array(count - 1).fill(5));
  const schoolBreaks = [10, 10, 15, 10, 10, 10].slice(0, count - 1);
  const restored = setDayTime(shortened, location, 510, 30, schoolBreaks);
  const times = restored[key(location.groupId, location.weekOffset)][0].times;
  assert.deepEqual(times.slice(0, 4), [
    { start: 510, duration: 30 }, { start: 550, duration: 30 },
    { start: 590, duration: 30 }, { start: 635, duration: 30 },
  ]);
  assert.deepEqual(restored[key(location.groupId, location.weekOffset)][0].breaks, schoolBreaks);
});

test("invalid shortened day and changing only one copy of a joint lesson are atomic", () => {
  const { schedule, location } = setup();
  const day = schedule[key(location.groupId, location.weekOffset)][0];
  const breaks = Array(day.times.length - 1).fill(5);
  const original = structuredClone(schedule);
  assert.throws(() => setDayTime(schedule, location, 1410, 30, breaks), /пределы дня/);
  assert.throws(() => dayTimeGrid(510, 30.5, breaks, day.times.length), /целым числом/);
  assert.throws(() => dayTimeGrid(510, 30, [-1], 2), /Длительность перемены/);
  assert.throws(() => dayTimeGrid(Number.NaN, 30, breaks, day.times.length), /ЧЧ:ММ/);
  assert.deepEqual(schedule, original);
  day.slots[0][0].jointId = "joint";
  const withJoint = structuredClone(schedule);
  assert.throws(() => setDayTime(schedule, location, 510, 30, breaks), /общее занятие/);
  assert.deepEqual(schedule, withJoint);
  assert.doesNotThrow(() => setDayTime(schedule, location, day.times[0].start, 45, day.breaks));
});

test("failed move leaves the original source intact", () => {
  const { schedule, location } = setup();
  const original = schedule[key("5a", 0)][0].slots[0][0];
  assert.throws(
    () => moveLesson(schedule, location, original.id, { ...location, slot: 1 }),
    /уже есть занятие/,
  );
  assert.equal(schedule[key("5a", 0)][0].slots[0][0].id, original.id);
});

test("subgroups can coexist, while a whole group conflicts", () => {
  const { schedule, location } = setup();
  const target = { ...location, slot: 6 };
  const first = {
    subjectId: "informatics",
    subgroup: "5А/1",
    teacher: "Орлова",
    room: "Комп. 1",
  };
  const second = {
    subjectId: "informatics",
    subgroup: "5А/2",
    teacher: "Демидов",
    room: "Комп. 2",
  };
  const withFirst = placeLesson(schedule, target, first);
  const withBoth = placeLesson(withFirst, target, second);
  assert.equal(withBoth[key("5a", 0)][0].slots[6].length, 2);
  assert.throws(
    () => placeLesson(withBoth, target, { subjectId: "math" }),
    /уже есть занятие/,
  );
});

test("catalog room selection previews conflicts across groups", () => {
  const schedule = createSchedule();
  const dayA = schedule[key("5a", 0)][0];
  const slotIndex = 0;
  const catalog: Catalog = {
    subjects: [
      {
        id: "math",
        name: "Математика",
        shortName: "Мат.",
        color: "blue",
        roomKind: null,
        labRoomKind: null,
        archived: false,
      },
    ],
    teachers: [
      {
        id: "teacher",
        name: "Иванов Иван",
        archived: false,
        subjectIds: ["math"],
        defaultRoomId: null,
      },
    ],
    rooms: [
      {
        id: "room",
        name: "Кабинет 12",
        capacity: null,
        kind: "general",
        archived: false,
      },
    ],
    groups: [
      {
        id: "5a",
        name: "5А",
        students: 20,
        autoRoomIds: [],
        leaderId: null,
        roomId: null,
        archived: false,
      },
      {
        id: "5b",
        name: "5Б",
        students: 20,
        autoRoomIds: [],
        leaderId: null,
        roomId: null,
        archived: false,
      },
    ],
    subgroups: [],
  };
  const existing = {
    id: "other-group-lesson",
    subjectId: "math",
    teacherId: "teacher",
    roomId: "room",
  };
  const withExisting = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((day) =>
      day.date === dayA.date
        ? {
            ...day,
            slots: day.slots.map((slot, index) =>
              index === slotIndex ? [] : slot,
            ),
          }
        : day,
    ),
    [key("5b", 0)]: schedule[key("5b", 0)].map((day) =>
      day.date === dayA.date
        ? {
            ...day,
            slots: day.slots.map((slot, index) =>
              index === slotIndex ? [existing] : slot,
            ),
            times: day.times.map((time, index) =>
              index === slotIndex ? { ...dayA.times[slotIndex] } : time,
            ),
          }
        : day,
    ),
  };
  const location = {
    groupId: "5a",
    weekOffset: 0,
    date: dayA.date,
    slot: slotIndex,
  };
  assert.match(
    canPlace(
      withExisting,
      location,
      { subjectId: "math", teacherId: "teacher", roomId: "room" },
      undefined,
      catalog,
    ) ?? "",
    /Кабинет 12.*5Б/,
  );
  assert.equal(
    canPlace(
      withExisting,
      location,
      { subjectId: "math", teacherId: "teacher", roomId: "room2" },
      undefined,
      catalog,
    ),
    "Выберите действующий кабинет",
  );
});

test("catalog subgroup identity survives a display-name change", () => {
  const { schedule, location } = setup();
  const catalog: Catalog = {
    subjects: [
      {
        id: "informatics",
        name: "Информатика",
        shortName: "Инф.",
        color: "blue",
        roomKind: "informatics",
        labRoomKind: null,
        archived: false,
      },
    ],
    teachers: [
      {
        id: "teacher-1",
        name: "Орлова Анна",
        archived: false,
        subjectIds: ["informatics"],
        defaultRoomId: null,
      },
    ],
    rooms: [
      {
        id: "room-1",
        name: "Комп. 1",
        capacity: null,
        kind: "informatics",
        archived: false,
      },
    ],
    groups: [
      {
        id: "5a",
        name: "Пятый А",
        students: 24,
        autoRoomIds: [],
        leaderId: null,
        roomId: null,
        archived: false,
      },
    ],
    subgroups: [
      {
        id: "subgroup-1",
        name: "Первая половина",
        groupId: "5a",
        students: 12,
        archived: false,
      },
    ],
  };
  const target = { ...location, slot: 6 };
  const placed = placeLesson(
    schedule,
    target,
    {
      subjectId: "informatics",
      teacherId: "teacher-1",
      roomId: "room-1",
      subgroupId: "subgroup-1",
      subgroup: "Пятая А/1",
    },
    catalog,
  );
  catalog.subgroups[0].name = "Группа информатики А";
  assert.throws(
    () =>
      placeLesson(
        placed,
        target,
        {
          subjectId: "informatics",
          teacherId: "teacher-1",
          roomId: "room-1",
          subgroupId: "subgroup-1",
          subgroup: "Новое отображаемое имя",
        },
        catalog,
      ),
    /подгруппа уже занята/,
  );
});

test("quarter plan counts whole lessons for each subgroup and separates labs", () => {
  const { schedule } = setup();
  const days = schedule[key("5a", 0)];
  const quarter = {
    id: "q1",
    name: "Четверть",
    startDate: "2026-10-05",
    endDate: "2026-10-09",
  };
  const whole = { id: "whole-1", subjectId: "math" };
  const subgroup = {
    id: "subgroup-lesson",
    subjectId: "math",
    subgroupId: "sg-1",
    subgroup: "5А/1",
  };
  const lab = {
    id: "lab-1",
    subjectId: "math",
    subgroupId: "sg-1",
    subgroup: "5А/1",
    lessonKind: "lab" as const,
  };
  const changed: Schedule = {
    ...schedule,
    [key("5a", 0)]: days.map((day, index) => ({
      ...day,
      slots:
        index === 0
          ? [[whole], [subgroup], [subgroup], [lab]]
          : day.slots.map(() => []),
    })),
  };
  assert.equal(countPlanLessons(changed, "5a", quarter, "math", undefined), 1);
  assert.equal(countPlanLessons(changed, "5a", quarter, "math", "sg-1"), 2);
  assert.equal(
    countPlanLessons(changed, "5a", quarter, "math", "sg-1", "lab"),
    1,
  );
});

test("changing a break affects one day and keeps a shortened lesson at 35 minutes", () => {
  const { schedule, location } = setup();
  const shortDay = schedule[key("5a", 0)][2];
  const shortLocation = { ...location, date: shortDay.date, slot: 0 };
  const beforeOther = schedule[key("5a", 0)][0].times[1].start;
  const changed = setBreak(schedule, { ...shortLocation, slot: 0 }, 20);
  assert.equal(changed[key("5a", 0)][2].times[0].duration, 35);
  assert.equal(
    changed[key("5a", 0)][2].times[1].start -
      changed[key("5a", 0)][2].times[0].start,
    55,
  );
  assert.equal(changed[key("5a", 0)][0].times[1].start, beforeOther);
});

test("slot timing shifts the tail, and invalid overlap or end-of-day time fails atomically", () => {
  const { schedule, location } = setup();
  const shifted = setSlotTime(
    schedule,
    location,
    schedule[key("5a", 0)][0].times[0].start + 5,
    45,
    true,
  );
  assert.equal(
    shifted[key("5a", 0)][0].times[1].start,
    schedule[key("5a", 0)][0].times[1].start + 5,
  );
  assert.throws(
    () => setSlotTime(schedule, location, 540, 45, false),
    /пересекается/,
  );
  assert.throws(
    () => setSlotTime(schedule, location, 1430, 45, true),
    /пределах дня/,
  );
  assert.equal(schedule[key("5a", 0)][0].times[0].start, parseTime("08:30"));
});

test("lesson editing and removal preserve prior schedule snapshots", () => {
  const { schedule, location } = setup();
  const lesson = schedule[key("5a", 0)][0].slots[0][0];
  const edited = editLesson(schedule, location, lesson.id, {
    teacher: "Новая",
    room: "101",
    note: "замена",
  });
  assert.equal(schedule[key("5a", 0)][0].slots[0][0].teacher, undefined);
  assert.equal(edited[key("5a", 0)][0].slots[0][0].note, "замена");
  const removed = removeLesson(edited, location, lesson.id);
  assert.equal(removed[key("5a", 0)][0].slots[0].length, 0);
  assert.equal(edited[key("5a", 0)][0].slots[0].length, 1);
});

test("editing updates joint mirrors; deleting one keeps the other as an ordinary lesson", () => {
  const schedule = createSchedule();
  const dayA = schedule[key("5a", 0)][0];
  const lessonA = { id: "joint-a", jointId: "joint-1", subjectId: "math", teacher: "Иванов", teacherId: "teacher", room: "101", roomId: "room", lessonKind: "regular" as const };
  const lessonB = { ...lessonA, id: "joint-b" };
  const withMirrors: Schedule = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((day) => day.date === dayA.date ? { ...day, slots: day.slots.map((slot, index) => index === 0 ? [lessonA] : slot) } : day),
    [key("5b", 0)]: schedule[key("5b", 0)].map((day) => day.date === dayA.date ? { ...day, slots: day.slots.map((slot, index) => index === 0 ? [lessonB] : slot), times: day.times.map((time, index) => index === 0 ? { ...dayA.times[0], start: dayA.times[0].start } : time) } : day),
  };
  const location = { groupId: "5a", weekOffset: 0, date: dayA.date, slot: 0 };
  const catalog: Catalog = { subjects: [{ id: "math", name: "Математика", shortName: "Мат.", color: "blue", roomKind: null, labRoomKind: null, archived: false }], teachers: [{ id: "teacher", name: "Иванов", archived: false, subjectIds: ["math"], defaultRoomId: null }], rooms: [{ id: "room", name: "101", capacity: null, kind: "general", archived: false }], groups: ["5a", "5b"].map((id) => ({ id, name: id, students: 20, autoRoomIds: [], leaderId: null, roomId: null, archived: false })), subgroups: [] };
  const edited = editLesson(withMirrors, location, lessonA.id, { teacher: "Иванов", teacherId: "teacher", room: "101", roomId: "room", note: "Общий план" }, { start: dayA.times[0].start, duration: dayA.times[0].duration - 1, shiftFollowing: false }, catalog);
  for (const [group, id] of [["5a", "joint-a"], ["5b", "joint-b"]]) {
    const day = edited[key(group, 0)].find((item) => item.date === dayA.date)!;
    assert.equal(day.slots[0].find((item) => item.id === id)?.note, "Общий план");
    assert.equal(day.times[0].start, dayA.times[0].start);
  }
  assert.equal(findRoomConflict(roomOccupancies(edited), roomOccupancies(edited)[0]), undefined);
  assert.equal(newRoomConflict(roomOccupancies(edited), roomOccupancies(edited)), undefined);
  const removed = removeLesson(edited, location, lessonA.id);
  assert.equal(removed[key("5a", 0)].find((day) => day.date === dayA.date)?.slots[0].length, 0);
  const survivor = removed[key("5b", 0)].find((day) => day.date === dayA.date)!.slots[0][0];
  assert.equal(survivor.id, lessonB.id);
  assert.equal(survivor.jointId, undefined);
  assert.equal(survivor.note, "Общий план");
  assert.equal(edited[key("5b", 0)].find((day) => day.date === dayA.date)!.slots[0][0].jointId, "joint-1");
  const withThird: Schedule = { ...edited, [key("6a", 0)]: [{ ...edited[key("5b", 0)][0], slots: [[{ ...lessonB, id: "joint-c" }]] }] };
  const detached = removeLesson(withThird, location, lessonA.id);
  assert.equal(detached[key("5b", 0)].find((day) => day.date === dayA.date)!.slots[0][0].jointId, "joint-1");
  assert.equal(detached[key("6a", 0)][0].slots[0][0].jointId, "joint-1");
});

test("joint lesson edit rejects conflicting time atomically", () => {
  const schedule = createSchedule();
  const dayA = schedule[key("5a", 0)][0];
  const joint = { id: "joint-a", jointId: "joint-1", subjectId: "math", teacher: "Иванов", teacherId: "teacher", room: "101", roomId: "room" };
  const mirror = { ...joint, id: "joint-b" };
  const withMirrors: Schedule = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((day) => day.date === dayA.date ? { ...day, slots: day.slots.map((slot, index) => index === 0 ? [joint] : slot) } : day),
    [key("5b", 0)]: schedule[key("5b", 0)].map((day) => day.date === dayA.date ? { ...day, slots: day.slots.map((slot, index) => index === 0 ? [mirror] : slot), times: day.times.map((time, index) => index === 0 ? { ...dayA.times[0] } : time) } : day),
  };
  const location = { groupId: "5a", weekOffset: 0, date: dayA.date, slot: 0 };
  assert.throws(() => editLesson(withMirrors, location, joint.id, { teacher: "Иванов", room: "101", note: "" }, { start: dayA.times[1].start - 10, duration: dayA.times[0].duration, shiftFollowing: false }), /пересекается/);
  assert.equal(withMirrors[key("5a", 0)][0].times[0].start, dayA.times[0].start);
  assert.equal(withMirrors[key("5b", 0)][0].times[0].start, dayA.times[0].start);
});

test("unchanged prior lesson timing remains editable before a joint lesson", () => {
  const { schedule, location } = setup();
  const day = schedule[key("5a", 0)][0];
  const ordinary = day.slots[0][0];
  const joint = {
    id: "later-joint",
    jointId: "joint-later",
    subjectId: "math",
    teacher: "Иванов",
    room: "101",
  };
  const withJoint: Schedule = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((item) =>
      item.date === day.date
        ? { ...item, slots: item.slots.map((slot, index) => index === 4 ? [joint] : slot) }
        : item,
    ),
  };
  const edited = editLesson(
    withJoint,
    location,
    ordinary.id,
    { teacher: "Иванов", room: "101", note: "Примечание" },
    {
      start: day.times[0].start,
      duration: day.times[0].duration,
      shiftFollowing: false,
    },
  );
  const editedDay = edited[key("5a", 0)][0];
  assert.equal(editedDay.slots[0].find((item) => item.id === ordinary.id)?.note, "Примечание");
  assert.deepEqual(editedDay.times, day.times);
  assert.equal(editedDay.slots[4][0].jointId, "joint-later");
});

test("moving a joint slot with following lessons enabled is blocked", () => {
  const { schedule, location } = setup();
  const day = schedule[key("5a", 0)][0];
  const withJoint: Schedule = {
    ...schedule,
    [key("5a", 0)]: schedule[key("5a", 0)].map((item) =>
      item.date === day.date
        ? {
            ...item,
            slots: item.slots.map((slot, index) =>
              index === 0
                ? [{ id: "joint-current", jointId: "joint-current-id", subjectId: "math" }]
                : slot,
            ),
          }
        : item,
    ),
  };
  assert.throws(
    () => setSlotTime(withJoint, location, day.times[0].start + 1, day.times[0].duration, true),
    /общее занятие/,
  );
  assert.equal(withJoint[key("5a", 0)][0].times[0].start, day.times[0].start);
});

test("append uses the day, adds a 45 minute slot after the final break", () => {
  const { schedule, location } = setup();
  const appended = appendSlot(schedule, { ...location, slot: 99 });
  const before = schedule[key("5a", 0)][0];
  const after = appended[key("5a", 0)][0];
  assert.equal(after.slots.length, before.slots.length + 1);
  assert.equal(after.times.at(-1)?.duration, 45);
  assert.equal(
    after.times.at(-1)?.start,
    before.times.at(-1)!.start + before.times.at(-1)!.duration + 10,
  );
});

test("append follows the configured break position and preserves a shortened day", () => {
  const { schedule, location } = setup();
  const before = schedule[key("5a", 0)][0];
  const profile = { start: 840, duration: 40, breaks: [10, 10, 15, 10, 10, 10, 25] };
  const after = appendSlot(schedule, location, profile)[key("5a", 0)][0];
  assert.equal(after.times.at(-1)?.start, before.times.at(-1)!.start + before.times.at(-1)!.duration + 25);
  assert.equal(after.times.at(-1)?.duration, 40);
  assert.deepEqual(after.times.slice(0, -1), before.times);

  const shortened = structuredClone(schedule);
  shortened[key("5a", 0)][0].duration = 35;
  assert.equal(appendSlot(shortened, location, profile)[key("5a", 0)][0].times.at(-1)?.duration, 35);
});

test("teacher alternatives share one plan and replacement preserves the lesson and hour count", () => {
  const catalog = buildSeedCatalog();
  const main = catalog.teachers.find((t) => t.subjectIds.includes("math"))!;
  assert.ok(main);
  catalog.teachers.push(
    {
      id: "substitute",
      name: "Андреев Иван",
      archived: false,
      subjectIds: ["math", "physics"],
      defaultRoomId: null,
    },
    {
      id: "unrelated",
      name: "Безматематиков Иван",
      archived: false,
      subjectIds: ["physics"],
      defaultRoomId: null,
    },
    {
      id: "archived",
      name: "Архивный Иван",
      archived: true,
      subjectIds: ["math"],
      defaultRoomId: null,
    },
  );
  const quarter = {
    id: "q",
    name: "Четверть",
    startDate: "2026-09-01",
    endDate: "2026-10-30",
  };
  const plans = [
    {
      id: "plan",
      groupId: "5a",
      quarterId: "q",
      subjectId: "math",
      mode: "whole" as const,
      lessonKind: "regular" as const,
      assignments: [
        {
          id: "assignment",
          subgroupId: null,
          target: 40,
        },
      ],
    },
  ];
  const subject = editorSubjects(catalog, "5a", "q", plans).find(
    (s) => s.id === "math",
  )!;
  const choices = teacherChoices(catalog, subject);
  assert.equal(subject.assignments.length, 1);
  assert.ok(choices.some((c) => c.teacherId === main.id));
  assert.ok(choices.some((c) => c.teacherId === "substitute"));
  assert.ok(
    !choices.some((c) => ["unrelated", "archived"].includes(c.teacherId)),
  );
  assert.equal(new Set(choices.map((c) => c.id)).size, choices.length);
  const substitute = catalog.teachers.find((t) => t.id === "substitute")!;
  const suggestedRoom = catalog.rooms[0].id;
  const manualRoom = catalog.rooms[2].id;
  substitute.defaultRoomId = suggestedRoom;
  assert.equal(
    teacherChoices(catalog, subject).find((c) => c.teacherId === substitute.id)
      ?.roomId,
    suggestedRoom,
  );
  assert.equal(
    teacherChoices(catalog, subject, manualRoom).find(
      (c) => c.teacherId === substitute.id,
    )?.roomId,
    manualRoom,
  );

  const { schedule, location } = setup();
  const original = schedule[key("5a", 0)][0].slots[0][0];
  original.room = "208";
  const beforeCount = countPlanLessons(
    schedule,
    "5a",
    quarter,
    original.subjectId,
    undefined,
  );
  const updated = editLesson(schedule, location, original.id, {
    teacher: "Андреев",
    teacherId: "substitute",
    room: original.room!,
    roomId: original.roomId,
    note: original.note ?? "",
  });
  const replacement = updated[key("5a", 0)][0].slots[0][0];
  assert.equal(replacement.id, original.id);
  assert.equal(replacement.teacherId, "substitute");
  assert.equal(replacement.room, original.room);
  assert.deepEqual(
    updated[key("5a", 0)][0].times,
    schedule[key("5a", 0)][0].times,
  );
  assert.equal(
    countPlanLessons(updated, "5a", quarter, original.subjectId, undefined),
    beforeCount,
  );
  assert.deepEqual(Object.keys(plans[0].assignments[0]).sort(), [
    "id",
    "subgroupId",
    "target",
  ]);
  main.subjectIds = [];
  const changed = teacherChoices(catalog, subject);
  assert.equal(
    changed.some((c) => c.teacherId === main.id),
    false,
  );
  assert.equal(
    changed.find((c) => c.teacherId === "substitute")?.unavailable,
    false,
  );
});

test("teacher palette puts group preferences first and sorts each section by surname", () => {
  const catalog = buildSeedCatalog();
  const model = catalog.teachers.find(teacher => teacher.subjectIds.includes("math"))!;
  catalog.teachers = [
    { ...model, id: "ordinary-b", name: "Белов Иван", preferredGroupIds: [] },
    { ...model, id: "preferred-z", name: "Яковлев Иван", preferredGroupIds: ["5a"] },
    { ...model, id: "ordinary-a", name: "Андреев Иван", preferredGroupIds: ["5b"] },
    { ...model, id: "preferred-a", name: "Алексеев Иван", preferredGroupIds: ["5a"] },
  ];
  const subject = editorSubjects(catalog, "5a", "q", [{
    id: "plan-preference", groupId: "5a", quarterId: "q", subjectId: "math", mode: "whole", lessonKind: "regular",
    assignments: [{ id: "assignment-preference", subgroupId: null, target: 40 }],
  }]).find(item => item.id === "math")!;
  assert.deepEqual(teacherChoices(catalog, subject).map(choice => choice.teacherId),
    ["preferred-a", "preferred-z", "ordinary-a", "ordinary-b"]);
});
