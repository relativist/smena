import assert from "node:assert/strict";
import { chooseStudentWeekLocation, studentQuarterWeeks } from "../shared/studentQuarterNavigation.ts";
import type { PublicStudentQuarter } from "../shared/studentTypes.ts";

const quarter = (id: string, startDate: string, endDate: string, groups: PublicStudentQuarter["groups"]): PublicStudentQuarter => ({
  id, name: id, startDate, endDate, publication: { version: 1, publishedAt: "2026-01-01T00:00:00.000Z" }, groups,
});
const group = (id: string, lessonDates: string[]) => ({ id, name: id, lessonDates });
const q1 = quarter("q1", "2026-09-02", "2026-09-20", [
  group("empty", []), group("later", ["2026-09-10", "2026-09-18"]),
]);
const q2 = quarter("q2", "2026-09-21", "2026-10-04", [group("g", ["2026-09-28", "2026-10-02"])]);

assert.deepEqual(studentQuarterWeeks(q1), ["2026-08-31", "2026-09-07", "2026-09-14"]);
assert.deepEqual(studentQuarterWeeks({ startDate: "bad", endDate: "2026-09-20" }), []);
assert.deepEqual(chooseStudentWeekLocation([q1], { today: "2026-09-08" }), {
  quarterId: "q1", date: "2026-09-07",
}, "uses lesson dates from all groups when choosing the current week");
assert.deepEqual(chooseStudentWeekLocation([q1], { today: "2026-09-30", queryQuarter: "q1", queryDate: "2026-09-01" }), {
  quarterId: "q1", date: "2026-08-31",
}, "honors explicit quarter and a valid overlapping first partial week");
assert.deepEqual(chooseStudentWeekLocation([q1, q2], { today: "2026-09-08", queryDate: "2026-09-28" }), {
  quarterId: "q2", date: "2026-09-28",
}, "a query week may select its overlapping quarter without an explicit quarter");
assert.deepEqual(chooseStudentWeekLocation([q1], { today: "2026-09-05" }), {
  quarterId: "q1", date: "2026-09-07",
}, "on a weekend, advances to upcoming lesson in the current week");
assert.deepEqual(chooseStudentWeekLocation([q1, q2], { today: "2026-09-19" }), {
  quarterId: "q2", date: "2026-09-28",
}, "weekend selection prefers the next future lesson across quarters");
const empty = quarter("empty", "2026-11-01", "2026-11-14", []);
assert.deepEqual(chooseStudentWeekLocation([empty], { today: "invalid", queryQuarter: "empty" }), {
  quarterId: "empty", date: "2026-10-26",
}, "empty indexes and invalid today safely fall back to the explicitly selected quarter");
assert.deepEqual(chooseStudentWeekLocation([quarter("q0", "2026-09-01", "2026-09-20", [group("g", [])]), empty], { today: "bad" }), {
  quarterId: "empty", date: "2026-11-09",
}, "without lessons or a valid today, falls back to the latest quarter");
assert.deepEqual(chooseStudentWeekLocation([q1], { today: "2026-09-08", queryQuarter: "q1", queryDate: "2026-02-30" }), {
  quarterId: "q1", date: "2026-09-07",
}, "invalid query dates are ignored");
assert.equal(studentQuarterWeeks(quarter("utc", "2026-03-07", "2026-03-09", []))[0], "2026-03-02", "dates stay in UTC without local timezone shifts");

console.log("student quarter navigation tests passed");
