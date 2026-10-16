import assert from "node:assert/strict";
import { findGapClosingMoves } from "../shared/generationGapClosing.ts";
import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";

type Placement = { lessonId: string; slot: number; joint?: boolean };
const makeDay = (rows: string[][]): EditorDay => ({
  date: "2026-09-01", start: "08:30", duration: 45,
  times: rows.map((_, slot) => ({ start: 510 + slot * 55, duration: 45 })),
  breaks: rows.map(() => 10),
  slots: rows.map((ids) => ids.map((id) => ({ id, subjectId: "s", teacherId: "t", teacher: "T", roomId: "r", room: "R" }))),
  holiday: false,
});
const placement = (lessonId: string, slot: number): Placement => ({ lessonId, slot });
const unrestricted = () => true;
const moveMap = (placements: Placement[], rows: string[][], canMove: (entry: Placement, destination: number) => boolean = unrestricted) =>
  findGapClosingMoves({ day: makeDay(rows), placements, canMove });

{
  const rows = [["manual"], [], ["generated"]];
  const moves = moveMap([placement("generated", 2)], rows);
  assert.deepEqual([...moves!.entries()], [["generated", 1]], "one generated lesson can close a gap beside existing manual work");
}

{
  // The leading empty slot is not a counted gap; two generated lessons shift it forward.
  const rows = [[], ["a"], [], ["b"], ["manual"]];
  const original = structuredClone(rows);
  const placements = [placement("a", 1), placement("b", 3)];
  const moves = moveMap(placements, rows, (entry, destination) => entry.lessonId !== "a" || destination !== 2);
  assert.deepEqual([...moves!.entries()].sort(), [["a", 3], ["b", 2]]);
  assert.deepEqual(rows, original, "search does not mutate the source day");
  assert.deepEqual(placements.map(({ lessonId, slot }) => [lessonId, slot]), [["a", 1], ["b", 3]], "search does not mutate placement metadata");
}

{
  const catalog: Catalog = {
    groups: [{ id: "g", name: "5А", students: 20, leaderId: null, roomId: null, autoRoomIds: [], archived: false }],
    subgroups: [],
    subjects: [
      { id: "pe", name: "Физическая культура", shortName: "Физ-ра", color: "green", roomKind: null, labRoomKind: null, archived: false },
      { id: "math", name: "Математика", shortName: "Матем.", color: "blue", roomKind: null, labRoomKind: null, archived: false },
    ],
    teachers: [
      { id: "pe-teacher", name: "Иванов", subjectIds: ["pe"], defaultRoomId: null, archived: false },
      { id: "math-teacher", name: "Петров", subjectIds: ["math"], defaultRoomId: null, archived: false },
    ],
    rooms: [{ id: "room", name: "Кабинет", kind: "general", capacity: 30, archived: false }],
  };
  const date = "2026-09-01";
  const slots = Array.from({ length: 7 }, (_, slot) => slot === 0
    ? [{ id: "event", subjectId: "math", event: "Событие" }]
    : []);
  const day = { date, start: "08:30", duration: 45,
    times: slots.map((_, slot) => ({ start: 510 + slot * 55, duration: 45 })),
    breaks: slots.map(() => 10), slots, holiday: false };
  const schedule: Schedule = { "g:0": [day] };
  const quarter: Quarter = { id: "q", name: "Q", startDate: date, endDate: date };
  const plan: StudyPlan = { id: "pe", quarterId: "q", groupId: "g", subjectId: "pe", mode: "whole", lessonKind: "regular",
    assignments: [{ id: "pe-work", subgroupId: null, target: 2 }] };
  const result = generateQuarter({ catalog, schedule, quarters: [quarter], studyPlans: [plan] }, "q", ["g"]);
  assert.equal(result.added.filter((entry) => entry.subjectId === "pe").length, 1,
    "the integrated generator schedules no more than one physical education lesson per day");
  assert.equal(result.remaining[0]?.missing, 1, "the second same-day physical education lesson stays unplaced");
  assert.equal(result.schedule["g:0"]?.[0]?.slots[0]?.[0]?.id, "event", "manual events are retained");
}

{
  // Mirrors the requested 7->2, 2->3, 3->6 pattern (zero-based slots).
  const rows = [["manual-start"], ["a"], ["b"], ["manual-middle"], ["manual-middle-2"], [], ["c"]];
  const placements = [placement("a", 1), placement("b", 2), placement("c", 6)];
  const moves = moveMap(placements, rows, (entry, destination) =>
    !(entry.lessonId === "a" && destination === 5) && !(entry.lessonId === "c" && [2, 5].includes(destination)));
  assert.deepEqual([...moves!.entries()].sort(), [["a", 2], ["b", 5], ["c", 1]]);
}

{
  const rows = [["manual"], ["a"], [], ["b"], ["manual-end"]];
  const placements = [placement("a", 1), placement("b", 3)];
  const resourceConflict = moveMap(placements, rows, (entry) => entry.lessonId !== "a");
  const unavailable = moveMap(placements, rows, (_entry, destination) => destination !== 2);
  assert.equal(resourceConflict, undefined, "a room or teacher conflict can reject the only useful chain");
  assert.equal(unavailable, undefined, "teacher unavailability can reject the only useful chain");
  assert.equal(rows[0]?.[0], "manual", "manual lessons are fixed occupants, never chain candidates");
}

{
  const rows = [["manual"], ["a"], [], ["b"], ["manual-end"]];
  const placements = [placement("a", 1), { ...placement("b", 3), joint: true }];
  const moves = findGapClosingMoves({
    day: makeDay(rows), placements,
    isMovable: (entry) => !entry.joint,
    canMove: unrestricted,
  });
  assert.equal(moves, undefined, "joint lessons can be excluded from movement");
}

{
  assert.throws(() => findGapClosingMoves({
    day: makeDay([["manual"], ["a"], [], ["b"], []]),
    placements: [placement("a", 1), placement("b", 3)],
    canMove: unrestricted,
    shouldCancel: () => true,
  }), /отменено/, "search checks cancellation between bounded search steps");
}

console.log("generation gap-closing chain scenarios passed");
