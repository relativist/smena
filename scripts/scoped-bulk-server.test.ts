import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { quarterWeeks, weekDates } from "../shared/plans.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

async function start() {
  const root = mkdtempSync(join(tmpdir(), "smena-scoped-bulk-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "test.sqlite") });
  apps.push(app);
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "temporary scoped bulk password" } });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"]?.toString().split(";")[0];
  assert.ok(cookie);
  return { app, path: join(root, "test.sqlite"), headers: { cookie, origin, host: "127.0.0.1", "x-csrf-token": setup.json().csrfToken as string } };
}

function createCopyTeacherConflict(path: string, state: StateResponse) {
  const quarter = state.quarters[0]!;
  for (const [sourceKey, sourceDays] of Object.entries(state.schedule)) {
    const sourceGroupId = sourceKey.slice(0, sourceKey.lastIndexOf(":"));
    const sourceWeekOffset = Number(sourceKey.slice(sourceKey.lastIndexOf(":") + 1));
    if (!quarterWeeks(quarter).includes(sourceWeekOffset)) continue;
    for (const sourceDay of sourceDays) {
      if (sourceDay.date < quarter.startDate || sourceDay.date > quarter.endDate) continue;
      const weekday = (new Date(`${sourceDay.date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
      for (const sourceSlot of sourceDay.slots.flatMap((slot, index) => slot.map(lesson => ({ lesson, index })))) {
        const sourceLesson = sourceSlot.lesson;
        if (sourceLesson.event || !sourceLesson.teacher || !sourceLesson.teacherId) continue;
        for (const targetWeekOffset of quarterWeeks(quarter)) {
          if (targetWeekOffset === sourceWeekOffset) continue;
          const targetDate = weekDates(targetWeekOffset)[weekday]!;
          const sourceTargetDay = state.schedule[`${sourceGroupId}:${targetWeekOffset}`]?.find(day => day.date === targetDate);
          const targetTime = sourceTargetDay?.times[sourceSlot.index];
          if (!sourceTargetDay || !targetTime || sourceTargetDay.slots[sourceSlot.index]?.length) continue;
          const targetEnd = targetTime.start + targetTime.duration;
          for (const [otherKey, otherDays] of Object.entries(state.schedule)) {
            const otherGroupId = otherKey.slice(0, otherKey.lastIndexOf(":"));
            if (otherGroupId === sourceGroupId) continue;
            const otherDay = otherDays.find(day => day.date === targetDate);
            const occupied = otherDay?.slots.flatMap((slot, index) => slot.map(lesson => ({ lesson, index }))).find(({ lesson, index }) => {
              if (lesson.event) return false;
              const time = otherDay!.times[index];
              return Boolean(time && targetTime.start < time.start + time.duration && time.start < targetEnd);
            });
            if (!occupied) continue;
            const db = new Database(path);
            db.prepare("UPDATE lessons SET teacher=? WHERE id=?").run(sourceLesson.teacher, occupied.lesson.id);
            db.close();
            return { sourceGroupId, sourceWeekOffset, sourceLessonId: sourceLesson.id, targetWeekOffset, targetDate, otherGroupId, otherLessonId: occupied.lesson.id };
          }
        }
      }
    }
  }
  assert.fail("could not construct a copy destination with another group's overlapping lesson");
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("bulk clear previews compactly, applies only scoped days, and replays idempotently", async () => {
  const { app, headers } = await start();
  const stateResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  const state = stateResponse.json() as StateResponse;
  const selected = Object.entries(state.schedule).flatMap(([scheduleKey, days]) => {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    return days.flatMap(day => day.slots.some(slot => slot.length) ? [{ groupId, date: day.date }] : []);
  })[0];
  assert.ok(selected, "fixture schedule includes at least one lesson");
  const options = { groupIds: [selected.groupId], startDate: selected.date, endDate: selected.date };
  const preview = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { revision: state.revision, operation: "clear", options } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.ok(preview.json().removedCount > 0);
  assert.equal("schedule" in preview.json(), false);

  const request = { revision: state.revision, requestId: "bulk-clear-request-001", operation: "clear", options };
  const applied = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: request });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().revision, state.revision + 1);
  assert.deepEqual(applied.json().changedDays.map((row: { date: string }) => row.date), [selected.date]);
  assert.equal("schedule" in applied.json(), false);

  const replay = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: request });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), applied.json());
  const reusedId = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: { ...request, options: { ...options, endDate: `${selected.date}T` } } });
  assert.equal(reusedId.statusCode, 409);
});

test("copy preview loads selected quarter context and returns no schedule snapshot", async () => {
  const { app, headers } = await start();
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  const state = response.json() as StateResponse;
  const quarter = state.quarters[0]!;
  const source = Object.keys(state.schedule).map(key => ({ groupId: key.slice(0, key.lastIndexOf(":")), offset: Number(key.slice(key.lastIndexOf(":") + 1)) }))
    .find(item => state.schedule[`${item.groupId}:${item.offset}`]?.some(day => day.date >= quarter.startDate && day.date <= quarter.endDate));
  assert.ok(source, "fixture has a source group and week");
  const target = Object.keys(state.schedule).map(key => Number(key.slice(key.lastIndexOf(":") + 1))).find(offset => offset !== source.offset && state.schedule[`${source.groupId}:${offset}`]?.some(day => day.date >= quarter.startDate && day.date <= quarter.endDate));
  assert.ok(target !== undefined, "fixture has a target week");
  const result = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: {
    revision: state.revision, operation: "copy", options: { mode: "week", quarterId: quarter.id, sourceGroupId: source.groupId, sourceWeekOffset: source.offset, targetWeekOffsets: [target] },
  } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal("schedule" in result.json(), false);
  assert.ok(Array.isArray(result.json().added));
  assert.ok(Array.isArray(result.json().skipped));
  assert.ok(Array.isArray(result.json().hours));
});

test("copy preview and apply include unrelated groups when checking destination teacher conflicts", async () => {
  const { app, path, headers } = await start();
  const initialResponse = await app.inject({ url: "/api/state", headers });
  assert.equal(initialResponse.statusCode, 200, initialResponse.body);
  const initial = initialResponse.json() as StateResponse;
  const conflict = createCopyTeacherConflict(path, initial);
  const options = {
    mode: "lesson", quarterId: initial.quarters[0]!.id, sourceGroupId: conflict.sourceGroupId,
    sourceWeekOffset: conflict.sourceWeekOffset, sourceLessonId: conflict.sourceLessonId,
    targetWeekOffsets: [conflict.targetWeekOffset],
  };
  const refreshedResponse = await app.inject({ url: "/api/state", headers });
  const refreshed = refreshedResponse.json() as StateResponse;
  const targetOtherBefore = structuredClone(refreshed.schedule[`${conflict.otherGroupId}:${conflict.targetWeekOffset}`]!.find(day => day.date === conflict.targetDate)!);
  const preview = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { revision: refreshed.revision, operation: "copy", options } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().added.length, 0);
  assert.ok(preview.json().skipped.some((row: { reason: string }) => /преподавател|учител|кабинет/i.test(row.reason)), JSON.stringify(preview.json().skipped));

  const applied = await app.inject({ method: "POST", url: "/api/schedule-operations/apply", headers, payload: { revision: refreshed.revision, requestId: "copy-external-teacher-001", operation: "copy", options } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().preview.added.length, 0);
  assert.ok(applied.json().preview.skipped.some((row: { reason: string }) => /преподавател|учител|кабинет/i.test(row.reason)), JSON.stringify(applied.json().preview.skipped));
  const final = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const targetOtherAfter = final.schedule[`${conflict.otherGroupId}:${conflict.targetWeekOffset}`]!.find(day => day.date === conflict.targetDate)!;
  assert.deepEqual(targetOtherAfter, targetOtherBefore, "the unrelated group's lesson remains unchanged");
  assert.equal(final.schedule[`${conflict.sourceGroupId}:${conflict.targetWeekOffset}`]!.find(day => day.date === conflict.targetDate)!.slots.flat().some(lesson => lesson.id.startsWith("copy-")), false);
});

test("clear rejects invalid group IDs and excessive ranges before loading date context", async () => {
  const { app, headers } = await start();
  const state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const base = { revision: state.revision, operation: "clear", options: { groupIds: [state.catalog.groups[0]!.id], startDate: "2019-01-01", endDate: "2019-01-02" } };
  const tooLong = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { ...base, options: { ...base.options, endDate: "2030-01-01" } } });
  assert.equal(tooLong.statusCode, 400);
  const unknownGroup = await app.inject({ method: "POST", url: "/api/schedule-operations/preview", headers, payload: { ...base, options: { ...base.options, groupIds: ["missing-group"] } } });
  assert.equal(unknownGroup.statusCode, 400);
});
