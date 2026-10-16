import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateTeacherGaps } from "../shared/teacherGaps.ts";
import { projectPublicTeachers } from "../shared/teacherPublic.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";

test("gaps compare full waiting time to each adjacent group's actual normal break", () => {
  const regular = calculateTeacherGaps([
    { id: "regular-1", start: 480, duration: 45, breakAfter: 50 },
    { id: "regular-2", start: 575, duration: 45, breakBefore: 50 },
  ]);
  assert.deepEqual(regular, []);
  assert.deepEqual(calculateTeacherGaps([
    { id: "short-1", start: 480, duration: 45, breakAfter: 5 },
    { id: "short-2", start: 550, duration: 45, breakBefore: 5 },
  ]), [{ start: 525, end: 550, minutes: 25, normalBreakMinutes: 5 }]);
});

test("interval union handles nesting, overlap, touching lessons and events without edge waits", () => {
  assert.deepEqual(calculateTeacherGaps([
    { id: "outer", start: 480, duration: 90 },
    { id: "nested", start: 500, duration: 15 },
    { id: "touching", start: 570, duration: 30 },
    { id: "overlap", start: 590, duration: 30 },
    { id: "event", start: 620, duration: 45 },
  ], 10), []);
  assert.deepEqual(calculateTeacherGaps([{ id: "only", start: 600, duration: 45 }]), []);
});

test("different groups and shifts sort fifth lessons by real time and collapse joint mirrors", () => {
  const gaps = calculateTeacherGaps([
    // Both are fifth lessons in their own groups; their slot number is not an input to sorting.
    { id: "late-shift-fifth", start: 960, duration: 45 },
    { id: "first-shift-joint-a", start: 735, duration: 45 },
    { id: "first-shift-joint-b", start: 735, duration: 45 },
  ]);
  assert.deepEqual(gaps, [{ start: 780, end: 960, minutes: 180, normalBreakMinutes: 10 }]);
});

test("the longer normal break from either adjacent group's edge is used", () => {
  assert.deepEqual(calculateTeacherGaps([
    { id: "group-a-previous", start: 480, duration: 45, breakAfter: 5 },
    { id: "group-b-previous", start: 480, duration: 45, breakAfter: 50 },
    { id: "group-a-next", start: 585, duration: 45, breakBefore: 5 },
    { id: "group-b-next", start: 585, duration: 45, breakBefore: 10 },
  ]), [{ start: 525, end: 585, minutes: 60, normalBreakMinutes: 50 }]);
  assert.deepEqual(calculateTeacherGaps([
    { id: "group-a-previous", start: 480, duration: 45, breakAfter: 5 },
    { id: "group-b-previous", start: 480, duration: 45, breakAfter: 50 },
    { id: "group-a-next", start: 525, duration: 45, breakBefore: 5 },
    { id: "group-b-next", start: 525, duration: 45, breakBefore: 10 },
  ]), []);
});

test("an event splits a long wait and a nested activity cannot inflate the block-edge break", () => {
  assert.deepEqual(calculateTeacherGaps([
    { id: "outer-lesson", start: 480, duration: 45, breakAfter: 5 },
    { id: "nested-activity", start: 490, duration: 10, breakAfter: 240 },
    { id: "event", start: 550, duration: 15, breakBefore: 5, breakAfter: 5 },
    { id: "next-lesson", start: 600, duration: 45, breakBefore: 5 },
  ]), [
    { start: 525, end: 550, minutes: 25, normalBreakMinutes: 5 },
    { start: 565, end: 600, minutes: 35, normalBreakMinutes: 5 },
  ]);
});

test("published teacher gaps use immutable snapshot times and expose only public fields", () => {
  const teacher = { id: "t", name: "Учитель", archived: false, subjectIds: ["math"] };
  const lesson = (id: string) => ({ id, subjectId: "math", teacherId: "t", roomId: "r", note: "PRIVATE_NOTE_MARKER" });
  const snapshot: PublicationSnapshot = {
    quarter: { id: "q", name: "Четверть", startDate: "2026-10-05", endDate: "2026-10-06" },
    catalog: {
      groups: [{ id: "g", name: "5А", archived: false, students: 24, leaderId: "PRIVATE_LEADER", roomId: "r", autoRoomIds: [] }],
      subjects: [{ id: "math", name: "Математика", shortName: "Мат.", archived: false, color: "blue", roomKind: null, labRoomKind: null }],
      teachers: [{ ...teacher, defaultRoomId: null }], rooms: [{ id: "r", name: "312", archived: false, capacity: 30, kind: "general" }], subgroups: [],
    },
    schedule: { "g:0": [
      { date: "2026-10-05", start: "08:00", duration: 45, breaks: [50], times: [{ start: 480, duration: 45 }, { start: 530, duration: 45 }, { start: 585, duration: 45 }], slots: [[lesson("l1")], [], [lesson("l3")]], holiday: false },
      { date: "2026-10-06", start: "08:00", duration: 45, breaks: [5], times: [{ start: 480, duration: 45 }, { start: 530, duration: 45 }, { start: 585, duration: 45 }], slots: [[lesson("h1")], [], [lesson("h3")]], holiday: true },
    ] },
    studyPlans: [], curricula: [], baseline: [], calendar: { weekdays: [1, 2, 3, 4, 5], periods: [] },
    bellSettings: { school: { start: 480, duration: 45, breaks: [10] }, groups: {} },
  };
  const publishedAt = "2026-10-01T00:00:00.000Z";
  const projected = projectPublicTeachers(snapshot, { version: 1, publishedAt });
  const schedule = projected.schedules.get("t")!;
  assert.deepEqual(schedule.days[0]!.gaps, [{ start: 525, end: 585, minutes: 60, normalBreakMinutes: 10 }]);
  assert.equal(schedule.days[1]!.gaps, undefined, "holiday displays no waiting gaps");
  const json = JSON.stringify({ quarter: projected.quarter, schedule });
  for (const marker of ["PRIVATE_NOTE_MARKER", "PRIVATE_LEADER", "bellSettings", "draftRevision", "publishedBy"])
    assert.equal(json.includes(marker), false, `public teacher projection leaked ${marker}`);
});

test("legacy bell profiles use standard breaks while valid zero/long school breaks are respected", async () => {
  const { normalSchoolBreakMinutes } = await import("../shared/bellSchedule.ts");
  assert.equal(normalSchoolBreakMinutes(), 15);
  assert.equal(normalSchoolBreakMinutes({ PRIVATE_LEGACY_MARKER: true } as never), 15);
  assert.equal(normalSchoolBreakMinutes({ school: { breaks: [] } } as never), 15);
  assert.equal(normalSchoolBreakMinutes({ school: { breaks: ["10"] } } as never), 15);
  assert.equal(normalSchoolBreakMinutes({ school: { breaks: [0] } } as never), 0);
  assert.equal(normalSchoolBreakMinutes({ school: { breaks: [5, 50] } } as never), 50);
});
