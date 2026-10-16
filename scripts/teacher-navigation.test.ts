import assert from "node:assert/strict";
import { chooseTeacherLocation, isValidIsoDate, mondayOf, weekDatesFor } from "../shared/teacherNavigation.ts";
import type { PublicTeacherQuarter } from "../shared/teacherTypes.ts";

const quarter = (id: string, startDate: string, endDate: string, teachers: PublicTeacherQuarter["teachers"]): PublicTeacherQuarter => ({
  id, name: id, startDate, endDate,
  publication: { version: 1, publishedAt: "2026-10-01T10:00:00.000Z" }, teachers,
});
const sameSurname = [
  { id: "teacher-a", name: "Иванов Алексей Петрович", lessonDates: ["2026-10-12", "2026-10-16", "2026-10-26"] },
  { id: "teacher-b", name: "Иванов Алексей Сергеевич", lessonDates: ["2026-10-14", "2026-10-21"] },
];
const q1 = quarter("q1", "2026-09-01", "2026-10-30", sameSurname);
const q2 = quarter("q2", "2026-11-01", "2026-12-25", [
  { id: "teacher-a", name: "Иванов Алексей Петрович", lessonDates: ["2026-11-02", "2026-11-09"] },
]);

assert.equal(mondayOf("2026-10-14"), "2026-10-12");
assert.deepEqual(weekDatesFor("2026-10-14"), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
assert.equal(isValidIsoDate("2026-10-13"), true);
assert.equal(isValidIsoDate("2026-10-99"), false);

assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-14", queryQuarter: "q1", queryTeacher: "teacher-b" }), {
  teacherId: "teacher-b", quarterId: "q1", date: "2026-10-14",
}, "select by teacher id when multiple teachers have the same surname");
assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-14", queryQuarter: "q1", queryTeacher: "invalid", storedTeacher: "teacher-a" }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-16",
}, "invalid URL id falls back to remembered teacher");
assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-14", storedTeacher: "teacher-a" }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-14",
}, "default to the current teaching week");
assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-17", storedTeacher: "teacher-a" }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-26",
}, "weekend after the final lesson advances to the next teaching week");
assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-31", storedTeacher: "teacher-a" }), {
  teacherId: "teacher-a", quarterId: "q2", date: "2026-11-02",
}, "advance across quarters to the next published lesson");
assert.deepEqual(chooseTeacherLocation([q1, q2], { today: "2026-10-14", queryTeacher: "teacher-a", todayIsVacation: true }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-16",
}, "when today is vacation, choose the next scheduled lesson");
assert.deepEqual(chooseTeacherLocation([q1], { today: "2026-10-14", queryQuarter: "q1", queryTeacher: "teacher-a", queryDate: "2026-10-14" }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-14",
}, "a manually selected date stays selected even during a vacation");
assert.deepEqual(chooseTeacherLocation([q1], { today: "2026-10-14", queryQuarter: "q1", queryTeacher: "teacher-a", queryDate: "2026-10-99" }), {
  teacherId: "teacher-a", quarterId: "q1", date: "2026-10-16",
}, "ignore invalid URL dates");
const empty = quarter("empty", "2027-01-11", "2027-03-20", [{ id: "teacher-x", name: "Петрова Мария", lessonDates: [] }]);
assert.deepEqual(chooseTeacherLocation([empty], { today: "2026-12-20", queryQuarter: "empty", queryTeacher: "teacher-x" }), {
  teacherId: "teacher-x", quarterId: "empty", date: "2027-01-11",
}, "keep empty published quarters navigable at their first date");

console.log("teacher navigation tests passed");
