import assert from "node:assert/strict";
import test from "node:test";
import { loadPercent, teacherLoadMonth } from "../shared/teacherLoadPeriods.ts";
import type { SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { Quarter } from "../shared/plans.ts";

const quarter = (startDate: string, endDate: string, calendar?: SchoolCalendar) => ({
  quarter: { id: `${startDate}:${endDate}`, name: "test", startDate, endDate } satisfies Quarter,
  calendar,
});

test("October 2026 is split into five clipped Monday–Sunday weeks with matching totals", () => {
  const result = teacherLoadMonth("2026-10", [quarter("2026-09-01", "2026-10-30")]);
  assert.equal(result.weeks.length, 5);
  assert.equal(result.weeks[0].start, "2026-10-01");
  assert.equal(result.weeks[0].fullStart, "2026-09-28");
  assert.equal(result.weeks[0].partial, true);
  assert.equal(result.weeks.at(-1)?.end, "2026-10-31");
  assert.equal(result.weeks.at(-1)?.partial, true);
  assert.equal(result.studyDays, 22);
  assert.equal(result.target, 79.2);
  assert.equal(result.weeks.reduce((sum, week) => sum + week.target, 0), result.target);
});

test("full standard weeks and leap February use 18 lessons per five study days", () => {
  const fullFebruary = teacherLoadMonth("2021-02", [quarter("2021-02-01", "2021-02-28")]);
  assert.equal(fullFebruary.weeks.length, 4);
  assert.equal(fullFebruary.studyDays, 20);
  assert.equal(fullFebruary.target, 72);
  const leapFebruary = teacherLoadMonth("2024-02", [quarter("2024-02-01", "2024-02-29")]);
  assert.equal(leapFebruary.end, "2024-02-29");
  assert.equal(leapFebruary.studyDays, 21);
  assert.equal(leapFebruary.target, 75.6);
});

test("holidays and quarter gaps reduce target, while scoped group holidays do not affect schoolwide target", () => {
  const calendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [
      { id: "holiday", name: "Каникулы", kind: "holiday", startDate: "2026-10-06", endDate: "2026-10-06", groupIds: null },
      { id: "group-holiday", name: "Группа", kind: "holiday", startDate: "2026-10-07", endDate: "2026-10-07", groupIds: ["5a"] },
    ],
  };
  const result = teacherLoadMonth("2026-10", [quarter("2026-10-05", "2026-10-09", calendar), quarter("2026-10-12", "2026-10-16", calendar)]);
  assert.equal(result.studyDays, 9);
  assert.equal(result.target, 32.4);
  assert.equal(result.weeks[0].target, 0, "days outside quarter snapshots are not included");
});

test("six-day calendar, a zero-target Sunday edge, and percentages above 100 are supported", () => {
  const sixDay: SchoolCalendar = { weekdays: [1, 2, 3, 4, 5, 6], periods: [] };
  const october = teacherLoadMonth("2026-10", [quarter("2026-10-01", "2026-10-31", sixDay)]);
  assert.equal(october.studyDays, 27);
  assert.equal(october.target, 81);
  const sundayEdge = teacherLoadMonth("2022-05", [quarter("2022-05-02", "2022-05-31")]);
  assert.equal(sundayEdge.weeks[0].studyDays, 0);
  assert.equal(sundayEdge.weeks[0].target, 0);
  assert.equal(loadPercent(27, 18), 150);
  assert.equal(loadPercent(1, 0), null);
});

test("invalid month format is rejected and partial quarter coverage remains visible", () => {
  assert.throws(() => teacherLoadMonth("2026-13", []), /ГГГГ-ММ/);
  assert.throws(() => teacherLoadMonth("26-10", []), /ГГГГ-ММ/);
  const result = teacherLoadMonth("2026-10", [quarter("2026-10-05", "2026-10-07")]);
  assert.equal(result.weeks[1].studyDays, 3);
  assert.equal(result.weeks[1].target, 10.8);
});

test("named autumn break between quarter snapshots labels its week without adding study target", () => {
  const calendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [{ id: "autumn", name: "Осенние каникулы", kind: "holiday", startDate: "2026-10-26", endDate: "2026-10-30", groupIds: null }],
  };
  const result = teacherLoadMonth("2026-10", [
    quarter("2026-09-01", "2026-10-23", calendar),
    quarter("2026-11-09", "2026-12-25", calendar),
  ]);
  const breakWeek = result.weeks.find((week) => week.start === "2026-10-26");
  assert.equal(breakWeek?.studyDays, 0);
  assert.equal(breakWeek?.target, 0);
  assert.equal(breakWeek?.nonStudyLabel, "Осенние каникулы");
  assert.equal(result.nonStudyLabel, undefined, "the month also contains study days");
});

test("labels only fully covered all-holiday periods; study overrides and mixed weeks are not holidays", () => {
  const mixedCalendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [{ id: "break", name: "Каникулы", kind: "holiday", startDate: "2026-10-05", endDate: "2026-10-06", groupIds: null }],
  };
  const mixed = teacherLoadMonth("2026-10", [quarter("2026-10-05", "2026-10-09", mixedCalendar)]);
  assert.equal(mixed.weeks[1].nonStudyLabel, undefined);

  const overrideCalendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [
      { id: "break", name: "Каникулы", kind: "holiday", startDate: "2026-10-05", endDate: "2026-10-09", groupIds: null },
      { id: "study", name: "Учебный день", kind: "study", startDate: "2026-10-07", endDate: "2026-10-07", groupIds: null },
    ],
  };
  const overridden = teacherLoadMonth("2026-10", [quarter("2026-10-05", "2026-10-09", overrideCalendar)]);
  assert.equal(overridden.weeks[1].nonStudyLabel, undefined);
  assert.equal(overridden.weeks[1].studyDays, 1);
});

test("group-only holidays do not create a schoolwide label; uncovered gaps stay generic", () => {
  const groupCalendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [{ id: "group-break", name: "Каникулы группы", kind: "holiday", startDate: "2026-10-05", endDate: "2026-10-09", groupIds: ["5a"] }],
  };
  const groupOnly = teacherLoadMonth("2026-10", [quarter("2026-10-05", "2026-10-09", groupCalendar)]);
  assert.equal(groupOnly.weeks[1].studyDays, 5);
  assert.equal(groupOnly.weeks[1].nonStudyLabel, undefined);

  const noSource = teacherLoadMonth("2026-10", []);
  assert.equal(noSource.weeks[1].nonStudyLabel, "Нет учебных дней");
  assert.equal(noSource.weeks[1].nonStudyLabel?.includes("каникулы"), false);
});

test("fully covered holiday month gets top-level label and weekends-only period is identified", () => {
  const calendar: SchoolCalendar = {
    weekdays: [1, 2, 3, 4, 5],
    periods: [{ id: "winter", name: "Зимние каникулы", kind: "holiday", startDate: "2026-01-01", endDate: "2026-01-31", groupIds: null }],
  };
  const month = teacherLoadMonth("2026-01", [quarter("2026-01-01", "2026-01-31", calendar)]);
  assert.equal(month.studyDays, 0);
  assert.equal(month.nonStudyLabel, "Зимние каникулы");
  const weekend = teacherLoadMonth("2022-05", [quarter("2022-05-02", "2022-05-31")]);
  assert.equal(weekend.weeks[0].nonStudyLabel, "Выходные");
});
