import assert from "node:assert/strict";
import { packPrintRows, printLessonDisplay, printRows, printWeekDays, splitOversizedPrintRow } from "../shared/schedulePrint.ts";
import type { PublicStudentDay, PublicStudentLesson } from "../shared/studentTypes.ts";

const lesson = (id: string, slot: number, start: number, additions: Partial<PublicStudentLesson> = {}): PublicStudentLesson => ({
  id, slot, start, duration: 45, lessonKind: "regular", subject: { id: "math", name: "Математика", shortName: "Мат.", color: "blue" }, ...additions,
});
const quarter = { startDate: "2026-10-05", endDate: "2026-10-25" };
const days: PublicStudentDay[] = [
  { date: "2026-10-05", slotCount: 8, holiday: false, lessons: [lesson("first", 1, 480), lesson("third", 3, 580)] },
  { date: "2026-10-10", slotCount: 5, holiday: false, lessons: [lesson("saturday", 5, 700)] },
  { date: "2026-10-12", slotCount: 0, holiday: true, holidayKind: "vacation", calendarLabel: "Осенние каникулы", lessons: [] },
  { date: "2026-10-19", slotCount: 0, holiday: false, lessons: [lesson("last", 2, 540, { note: "Не печатать служебную заметку" } as Partial<PublicStudentLesson>)] },
];

const week = printWeekDays(days, "2026-10-05", quarter);
assert.equal(week.length, 7);
assert.equal(week[0].weekday, 0);
assert.equal(week[0].inQuarter, true);
assert.equal(week[5].lessons[0]?.id, "saturday");
assert.equal(week[6].inQuarter, true);
assert.equal(printWeekDays(days, "2026-10-26", quarter)[0].inQuarter, false);
assert.equal(printWeekDays(days, "2026-10-12", quarter)[0].holidayLabel, "Осенние каникулы");

const rows = printRows(week);
assert.deepEqual(rows.map(row => row.slot), [1, 2, 3, 4, 5]);
assert.equal(rows.length, 5, "stored empty trailing slots are omitted");
assert.equal(rows[1].days[0].length, 0, "leading/interior alignment is preserved");
assert.equal(rows[4].days[5][0].id, "saturday", "weekend lessons retain the same lesson-number row");
assert.equal(printRows(printWeekDays([], "2026-10-05", quarter))[0].slot, 0, "empty week has one placeholder row");

assert.deepEqual(packPrintRows([20, 30, 25, 50], 60), [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]);
assert.deepEqual(packPrintRows([], 60), [{ start: 0, end: 0 }]);
assert.deepEqual(packPrintRows([80, 20], 60), [{ start: 0, end: 1 }, { start: 1, end: 2 }], "an oversized row remains an explicit page-boundary concern");
const tallRow = { slot: 4, days: [[lesson("a", 4, 500), lesson("b", 4, 550), lesson("c", 4, 600)], [], [], [], [], [], []] };
const split = splitOversizedPrintRow(tallRow, [[15, 15, 15], [], [], [], [], [], []], 35);
assert.equal(split.oversizedCard, false);
assert.deepEqual(split.rows.map(row => row.days[0].map(item => item.id)), [["a", "b"], ["c"]]);
assert.deepEqual(split.rows.map(row => row.slot), [4, 4], "split row fragments retain their lesson number");
assert.equal(split.rows[1].continued, true);
assert.equal(splitOversizedPrintRow(tallRow, [[36, 15, 15], [], [], [], [], [], []], 35).oversizedCard, true);

const display = printLessonDisplay(lesson("privacy", 1, 495, { teacher: { name: "Иванов Иван Иванович" }, room: { name: "Кабинет 312" }, subgroup: { name: "Подгруппа 2", number: 2 }, jointGroups: [{ id: "g2", name: "6Б" }] }));
assert.equal(display.time, "08:15", "print shows actual lesson start only");
assert.equal(display.subject, "Математика");
assert.equal(display.teacher, "Иванов И.И.");
assert.equal(display.room, "312");
assert.equal(display.subgroup, "/2");
assert.equal(display.joint, "6Б");
assert.equal("note" in display, false, "lesson notes are excluded from print display");

console.log("schedule print row and page packing checks passed");
