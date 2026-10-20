import assert from "node:assert/strict";
import { packPrintRows, printDateTables, printLessonDisplay, printRows, printTimeRows, printWeekDays, splitOversizedPrintRow } from "../shared/schedulePrint.ts";
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

const date = "2026-10-10"; // Saturday; Monday-based weekday index is 5.
const datePreview = {
  source: "published" as const,
  quarter: { id: "q", name: "Четверть", ...quarter },
  weekStart: "2026-10-05",
  weekEnd: "2026-10-11",
  groups: [
    { group: { id: "g10", name: "6Б" }, days: [{ date, slotCount: 4, holiday: false, lessons: [lesson("late", 3, 600), lesson("early", 1, 500), lesson("same-slot", 3, 550, { jointGroups: [{ id: "g11", name: "6В" }] })] }] },
    { group: { id: "g11", name: "6В" }, days: [] as PublicStudentDay[] },
    { group: { id: "g2", name: "6А" }, days: [{ date, slotCount: 0, holiday: true, holidayKind: "vacation" as const, lessons: [] }] },
    ...Array.from({ length: 8 }, (_, index) => ({ group: { id: `g${index + 20}`, name: `7${String.fromCharCode(65 + index)}` }, days: [] as PublicStudentDay[] })),
    { group: { id: "g1", name: "5А" }, days: [{ date: "2026-10-09", slotCount: 1, holiday: false, lessons: [lesson("adjacent", 1, 480)] }] },
  ],
};
const dateTables = printDateTables(datePreview, date);
assert.deepEqual(dateTables.map((table) => table.columnHeadings), [["5А"], ["6А", "6Б", "6В"], ["7A", "7B", "7C", "7D", "7E", "7F", "7G"], ["7H"]], "grades are naturally ordered, joint groups stay adjacent, and large grades split into seven-column chunks");
assert.ok(dateTables.every((table) => table.days.length <= 7));
assert.ok(dateTables.every((table) => table.group.id.includes(date) && table.group.name === "Расписание на день"));
assert.deepEqual(dateTables[1].days.map((day) => day.weekday), [5, 5, 5]);
assert.equal(dateTables[1].days[0].holidayLabel, "Каникулы");
assert.deepEqual(dateTables[1].days[1].lessons.map((item) => item.id), ["early", "same-slot", "late"], "same-day lessons sort by slot, start, then id");
assert.equal(dateTables[1].rows.length, 3);
assert.deepEqual(dateTables[1].rows.map(row => [row.slot, row.start]), [[1, 500], [3, 550], [3, 600]], "daily rows use actual start time and separate same-slot lessons with different starts");
assert.equal(dateTables[1].rows[1].days[1].length, 1, "parallel subgroup lesson remains in its shared slot and time row");
assert.equal(dateTables[1].rows[0].days[0].length, 0, "slot alignment includes empty cells before later lessons");
assert.equal(dateTables[1].days[1].lessons.some((item) => item.id === "adjacent"), false, "only exact-date lessons are included");
assert.equal(printDateTables(datePreview, "2026-10-12").length, 0, "date outside week is rejected");
assert.equal(printDateTables({ ...datePreview, quarter: { id: "q", name: "Четверть", startDate: "2026-10-05", endDate: "2026-10-09" } }, date).length, 0, "date outside quarter window is rejected");
const emptyPreview = { ...datePreview, groups: [{ group: { id: "empty", name: "2А" }, days: [] as PublicStudentDay[] }] };
assert.equal(printDateTables(emptyPreview, date)[0].rows[0].slot, 0, "empty groups still produce a printable placeholder row");

const rows = printRows(week);
assert.deepEqual(rows.map(row => row.slot), [1, 2, 3, 4, 5]);
assert.equal(rows.length, 5, "stored empty trailing slots are omitted");
assert.equal(rows[1].days[0].length, 0, "leading/interior alignment is preserved");
assert.equal(rows[4].days[5][0].id, "saturday", "weekend lessons retain the same lesson-number row");
assert.equal(printRows(printWeekDays([], "2026-10-05", quarter))[0].slot, 0, "empty week has one placeholder row");
const parallelRows = printTimeRows([{ date, weekday: 5, inQuarter: true, lessons: [lesson("sub1", 2, 540, { subgroup: { name: "Подгруппа 1", number: 1 } }), lesson("sub2", 2, 540, { subgroup: { name: "Подгруппа 2", number: 2 } }), lesson("other-time", 2, 570)] }]);
assert.equal(parallelRows.length, 2);
assert.deepEqual(parallelRows[0].days[0].map(item => item.id), ["sub1", "sub2"], "parallel subgroups are not lost when rows are aligned");
assert.deepEqual(parallelRows.map(row => row.start), [540, 570]);
assert.deepEqual(printTimeRows([{ date, weekday: 5, inQuarter: true, lessons: [] }])[0], { slot: 0, days: [[]] }, "empty day retains a placeholder row");

assert.deepEqual(packPrintRows([20, 30, 25, 50], 60), [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]);
assert.deepEqual(packPrintRows([], 60), [{ start: 0, end: 0 }]);
assert.deepEqual(packPrintRows([80, 20], 60), [{ start: 0, end: 1 }, { start: 1, end: 2 }], "an oversized row remains an explicit page-boundary concern");
const tallRow = { slot: 4, start: 500, days: [[lesson("a", 4, 500), lesson("b", 4, 550), lesson("c", 4, 600)], [], [], [], [], [], []] };
const split = splitOversizedPrintRow(tallRow, [[15, 15, 15], [], [], [], [], [], []], 35);
assert.equal(split.oversizedCard, false);
assert.deepEqual(split.rows.map(row => row.days[0].map(item => item.id)), [["a", "b"], ["c"]]);
assert.deepEqual(split.rows.map(row => row.slot), [4, 4], "split row fragments retain their lesson number");
assert.deepEqual(split.rows.map(row => row.start), [500, 500], "split row fragments retain their shared actual start");
assert.equal(split.rows[1].continued, true);
assert.equal(splitOversizedPrintRow(tallRow, [[36, 15, 15], [], [], [], [], [], []], 35).oversizedCard, true);

const display = printLessonDisplay(lesson("privacy", 1, 495, { teacher: { name: "Иванов Иван Иванович" }, room: { name: "Кабинет 312" }, subgroup: { name: "Подгруппа 2", number: 2 }, jointGroups: [{ id: "g2", name: "6Б" }] }));
assert.equal(display.time, "08:15", "print shows actual lesson start only");
assert.equal(display.subject, "Мат.", "print prefers the compact subject name");
assert.equal(display.teacher, "Иванов И.И.");
assert.equal(display.room, "312");
assert.equal(display.subgroup, "/2");
assert.equal(display.joint, "6Б");
assert.equal("note" in display, false, "lesson notes are excluded from print display");
assert.equal(printLessonDisplay(lesson("event", 1, 495, { event: "Событие", subject: { id: "math", name: "Математика", shortName: " Мат. ", color: "blue" } })).subject, "Событие", "event labels take precedence over subject names");
assert.equal(printLessonDisplay(lesson("fallback", 1, 495, { subject: { id: "math", name: "Математика", shortName: "  ", color: "blue" } })).subject, "Математика", "subject name is used when short name is blank");

console.log("schedule print row and page packing checks passed");
