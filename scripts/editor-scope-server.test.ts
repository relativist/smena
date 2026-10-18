import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { mergeScheduleContext, scheduleDayChanges } from "../src/scheduleContext.ts";
import type { AsyncDatabase } from "../server/database.ts";
import type { EditorDay, Schedule } from "../src/editor.ts";
import { teacherLessonFingerprint } from "../shared/teacherReassignment.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const ORIGIN = "http://127.0.0.1";
const QUARTER = "quarter-2026-1";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-editor-scope-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin: ORIGIN, host: "127.0.0.1" },
    payload: { username: "admin", password: "correct horse battery" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
    ?.split(";")[0];
  assert.ok(cookie);
  const auth = {
    cookie,
    csrfToken: response.json().csrfToken as string,
  };
  return {
    app,
    headers: {
      cookie: auth.cookie,
      origin: ORIGIN,
      host: "127.0.0.1",
      "x-csrf-token": auth.csrfToken,
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("editor bootstrap and week return only bounded editor data", async () => {
  const { app, headers } = await setup();
  const bootstrap = await app.inject({
    url: "/api/editor/bootstrap",
    headers: { cookie: headers.cookie },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const base = bootstrap.json();
  assert.equal(base.editorBootstrap, true);
  assert.ok(Number.isInteger(base.revision));
  assert.ok(base.catalog.groups.length > 0);
  assert.deepEqual(base.schedule, {});
  assert.deepEqual(base.studyPlans, []);
  assert.deepEqual(base.baseline, []);
  assert.equal("teacherLessonOrigins" in base, false);
  assert.equal("catalogDeletionBlockers" in base, false);

  const week = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(week.statusCode, 200, week.body);
  const scoped = week.json();
  assert.equal(scoped.revision, base.revision);
  assert.deepEqual(scoped.editorScope.dates, [
    "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
    "2026-10-09", "2026-10-10", "2026-10-11",
  ]);
  assert.equal(scoped.editorScope.groupId, "5a");
  assert.equal(scoped.editorScope.quarterId, QUARTER);
  assert.ok(scoped.editorScope.counts.length > 0);
  const dates = new Set(scoped.editorScope.dates);
  const schedule = scoped.schedule as Schedule;
  assert.deepEqual(Object.keys(schedule), ["5a:0"], "unrelated groups must remain server-side");
  for (const days of Object.values(schedule))
    for (const day of days) assert.ok(dates.has(day.date), `unexpected day ${day.date}`);
  assert.ok(scoped.studyPlans.length > 0);
  assert.ok(scoped.studyPlans.every((plan: { groupId: string; quarterId: string }) =>
    plan.groupId === "5a" && plan.quarterId === QUARTER));
  assert.ok(scoped.baseline.every((entry: { groupId: string }) => entry.groupId === "5a"));
});

test("scoped day command saves only its day and fences stale and replayed requests", async () => {
  const { app, headers } = await setup();
  const week = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(week.statusCode, 200, week.body);
  const beforeResponse = week.json();
  const beforeSchedule = beforeResponse.schedule as Schedule;
  const key = "5a:0";
  const dayIndex = 0;
  const before = structuredClone(beforeSchedule[key][dayIndex]) as EditorDay;
  const after = structuredClone(before);
  after.note = "Изменено scoped editor тестом";
  const request = {
    revision: beforeResponse.revision,
    requestId: "editor-scope-day-0001",
    changes: [{ key, dayIndex, before, after }],
  };

  const db = (app as unknown as {
    smenaDb: {
      prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    };
  }).smenaDb;
  const unaffectedSql = `SELECT d.id AS day_id,s.id AS slot_id,l.id AS lesson_id
    FROM schedule_days d
    LEFT JOIN schedule_slots s ON s.day_id=d.id
    LEFT JOIN lessons l ON l.slot_id=s.id
    WHERE d.group_id=? AND d.date=? ORDER BY s.slot_index,l.id`;
  const unaffectedBefore = db.prepare(unaffectedSql).all("5a", "2026-10-06");

  const saved = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: request,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const savedResponse = saved.json();
  assert.equal(savedResponse.revision, beforeResponse.revision + 1);

  const replay = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: request,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), savedResponse);

  const changedReplay = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: {
      ...request,
      changes: [{ ...request.changes[0], after: { ...after, note: "другой" } }],
    },
  });
  assert.equal(changedReplay.statusCode, 409);

  const stale = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: {
      ...request,
      requestId: "editor-scope-stale-0001",
    },
  });
  assert.equal(stale.statusCode, 409);

  const persisted = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(persisted.statusCode, 200, persisted.body);
  assert.equal(
    persisted.json().schedule[key][dayIndex].note,
    "Изменено scoped editor тестом",
  );
  assert.deepEqual(
    db.prepare(unaffectedSql).all("5a", "2026-10-06"),
    unaffectedBefore,
    "saving one day must preserve neighboring database rows and lesson ids",
  );
});

test("event placement preview marks occupied cells red and free cells green in the current group", async () => {
  const { app, headers } = await setup();
  const week = await app.inject({ url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`, headers });
  assert.equal(week.statusCode, 200, week.body);
  const state = week.json();
  const days = (state.schedule as Schedule)["5a:0"];
  const preview = await app.inject({ method: "POST", url: "/api/editor/preview", headers, payload: {
    revision: state.revision, groupId: "5a", quarterId: QUARTER, weekOffset: 0, autoRoom: false,
    payload: { lesson: { subjectId: "event", event: "Мероприятие" } },
  } });
  assert.equal(preview.statusCode, 200, preview.body);
  const targets = preview.json().targets as Array<{ date: string; slot: number; reason: string | null }>;
  let occupied = 0;
  let free = 0;
  for (const target of targets) {
    const entries = days.find(day => day.date === target.date)!.slots[target.slot];
    if (entries.length) {
      occupied++;
      assert.match(target.reason ?? "", /Ячейка занята/);
    } else {
      free++;
      assert.equal(target.reason, null);
    }
  }
  assert.ok(occupied > 0 && free > 0, "both occupied and free event cells are represented");
});

test("placement preview rejects an occupied teacher interval in another group", async () => {
  const { app, headers } = await setup();
  const stateResponse = await app.inject({
    url: "/api/state",
    headers: { cookie: headers.cookie },
  });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  const state = stateResponse.json();
  const schedule = state.schedule as Schedule;
  const plans = state.studyPlans as Array<{
    groupId: string;
    quarterId: string;
    subjectId: string;
    mode: string;
    assignments: Array<{ subgroupId: string | null }>;
  }>;

  let blocked: {
    date: string; slot: number; reason: string; groupId: string; dayIndex: number;
    before: EditorDay; lesson: EditorDay["slots"][number][number]; revision: number;
  } | undefined;
  for (const [sourceKey, sourceDays] of Object.entries(schedule)) {
    if (!sourceKey.endsWith(":0")) continue;
    for (const sourceDay of sourceDays) {
      for (let sourceSlot = 0; sourceSlot < sourceDay.slots.length; sourceSlot += 1) {
        for (const sourceLesson of sourceDay.slots[sourceSlot]) {
          if (!sourceLesson.teacherId || sourceLesson.jointId || sourceLesson.subgroupId) continue;
          for (const [targetKey, targetDays] of Object.entries(schedule)) {
            if (!targetKey.endsWith(":0") || targetKey === sourceKey) continue;
            const targetGroupId = targetKey.slice(0, targetKey.lastIndexOf(":"));
            const targetDay = targetDays.find((day) => day.date === sourceDay.date);
            if (!targetDay) continue;
            const targetPlan = plans.find((plan) =>
              plan.groupId === targetGroupId && plan.quarterId === QUARTER &&
              plan.subjectId === sourceLesson.subjectId &&
              (plan.mode === "whole" || plan.assignments.some((assignment) => assignment.subgroupId === null)),
            );
            if (!targetPlan) continue;
            for (let targetSlot = 0; targetSlot < targetDay.slots.length; targetSlot += 1) {
              if (targetDay.slots[targetSlot].length > 0) continue;
              const sourceTime = sourceDay.times[sourceSlot];
              const targetTime = targetDay.times[targetSlot];
              if (!sourceTime || !targetTime ||
                sourceTime.start >= targetTime.start + targetTime.duration ||
                targetTime.start >= sourceTime.start + sourceTime.duration) continue;

              const { id: _id, ...lesson } = sourceLesson;
              const preview = await app.inject({
                method: "POST",
                url: "/api/editor/preview",
                headers,
                payload: {
                  revision: state.revision,
                  groupId: targetGroupId,
                  quarterId: QUARTER,
                  weekOffset: 0,
                  autoRoom: false,
                  payload: { lesson },
                },
              });
              assert.equal(preview.statusCode, 200, preview.body);
              const target = (preview.json().targets as Array<{
                date: string; slot: number; reason: string | null;
              }>).find((entry) => entry.date === sourceDay.date && entry.slot === targetSlot);
              assert.ok(target, "preview should include the matching date and slot");
              if (target.reason && /учител|преподав|занят/i.test(target.reason)) {
                const dayIndex = targetDays.findIndex((day) => day.date === target.date);
                blocked = {
                  date: target.date, slot: target.slot, reason: target.reason,
                  groupId: targetGroupId, dayIndex,
                  before: structuredClone(targetDay) as EditorDay,
                  lesson: { ...lesson, id: "editor-scope-conflict-lesson" },
                  revision: state.revision,
                };
                break;
              }
            }
            if (blocked) break;
          }
          if (blocked) break;
        }
        if (blocked) break;
      }
      if (blocked) break;
    }
    if (blocked) break;
  }
  assert.ok(blocked, "expected a teacher collision with another group's lesson");
  const after = structuredClone(blocked.before);
  after.slots[blocked.slot] = [...after.slots[blocked.slot]!, blocked.lesson];
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: {
      revision: blocked.revision,
      requestId: "editor-scope-conflict-0001",
      changes: [{
        key: `${blocked.groupId}:0`, dayIndex: blocked.dayIndex,
        before: blocked.before, after,
      }],
    },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  const latest = await app.inject({
    url: "/api/editor/week?groupId=5a&quarterId=quarter-2026-1&weekOffset=0",
    headers: { cookie: headers.cookie },
  });
  assert.equal(latest.statusCode, 200, latest.body);
  assert.equal(latest.json().revision, blocked.revision, "a rejected conflict must not advance revision");
});

test("crossweek move preserves the lesson id and changes only its origin", async () => {
  const { app, headers } = await setup();
  const stateResponse = await app.inject({
    url: "/api/state",
    headers: { cookie: headers.cookie },
  });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  const sourceWeekResponse = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  const targetWeekResponse = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=1`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(sourceWeekResponse.statusCode, 200, sourceWeekResponse.body);
  assert.equal(targetWeekResponse.statusCode, 200, targetWeekResponse.body);
  const sourceWeek = sourceWeekResponse.json();
  const targetWeek = targetWeekResponse.json();
  const sourceSchedule = sourceWeek.schedule as Schedule;
  const targetSchedule = targetWeek.schedule as Schedule;
  const sourceKey = "5a:0";
  const targetKey = "5a:1";
  const db = (app as unknown as {
    smenaDb: {
      prepare: (sql: string) => {
        all: (...params: unknown[]) => unknown[];
        run: (...params: unknown[]) => unknown;
      };
    };
  }).smenaDb;

  let selected: {
    sourceIndex: number; sourceSlot: number; targetIndex: number; targetSlot: number;
    lesson: EditorDay["slots"][number][number];
  } | undefined;
  for (let sourceIndex = 0; sourceIndex < sourceSchedule[sourceKey]!.length && !selected; sourceIndex += 1) {
    const sourceDay = sourceSchedule[sourceKey]![sourceIndex]!;
    for (let sourceSlot = 0; sourceSlot < sourceDay.slots.length && !selected; sourceSlot += 1) {
      const lesson = sourceDay.slots[sourceSlot]!.find((entry) =>
        entry.teacherId && entry.roomId && !entry.subgroupId && !entry.jointId && !entry.event,
      );
      if (!lesson) continue;
      const preview = await app.inject({
        method: "POST",
        url: "/api/editor/preview",
        headers,
        payload: {
          revision: sourceWeek.revision,
          groupId: "5a",
          quarterId: QUARTER,
          weekOffset: 1,
          autoRoom: false,
          payload: {
            lesson,
            from: {
              id: lesson.id,
              location: { groupId: "5a", weekOffset: 0, date: sourceDay.date, slot: sourceSlot },
            },
          },
        },
      });
      assert.equal(preview.statusCode, 200, preview.body);
      const targets = preview.json().targets as Array<{
        date: string; slot: number; reason: string | null; self: boolean;
      }>;
      for (const target of targets) {
        if (target.reason || target.self) continue;
        const targetIndex = targetSchedule[targetKey]!.findIndex((day) => day.date === target.date);
        if (targetIndex < 0 || targetSchedule[targetKey]![targetIndex]!.slots[target.slot]!.length) continue;
        selected = { sourceIndex, sourceSlot, targetIndex, targetSlot: target.slot, lesson };
        break;
      }
    }
  }
  assert.ok(selected, "fixture should have an allowed crossweek destination");

  const sourceDay = structuredClone(sourceSchedule[sourceKey]![selected.sourceIndex]!) as EditorDay;
  const targetDay = structuredClone(targetSchedule[targetKey]![selected.targetIndex]!) as EditorDay;
  const sourceTime = sourceDay.times[selected.sourceSlot]!;
  const moved = sourceDay.slots[selected.sourceSlot]!.find((lesson) => lesson.id === selected!.lesson.id)!;
  sourceDay.slots[selected.sourceSlot] = sourceDay.slots[selected.sourceSlot]!.filter((lesson) => lesson.id !== moved.id);
  targetDay.slots[selected.targetSlot] = [...targetDay.slots[selected.targetSlot]!, moved];

  const originFor = (id: string, date: string, lesson: typeof moved, time: { start: number; duration: number }) => ({
    id,
    lessonId: lesson.id,
    groupId: "5a",
    date,
    sourceTeacherId: lesson.teacherId!,
    substituteTeacherId: lesson.teacherId!,
    kind: "absence",
    startDate: date,
    endDate: null,
    expected: teacherLessonFingerprint({ groupId: "5a", date, start: time.start, end: time.start + time.duration, lesson }),
    status: "active",
  });
  const movedOrigin = originFor("scope-origin-moved", sourceDay.date, moved, sourceTime);
  let unaffectedOrigin: ReturnType<typeof originFor> | undefined;
  for (const [key, days] of Object.entries(stateResponse.json().schedule as Schedule)) {
    if (key === sourceKey) continue;
    const day = days.find((entry) => entry.date === sourceDay.date);
    const lesson = day?.slots.flat().find((entry) => entry.teacherId && entry.roomId && entry.id !== moved.id);
    const timeIndex = lesson ? day!.slots.findIndex((slot) => slot.some((entry) => entry.id === lesson.id)) : -1;
    if (lesson && timeIndex >= 0) {
      const time = day!.times[timeIndex]!;
      unaffectedOrigin = originFor("scope-origin-untouched", day!.date, lesson, time);
      break;
    }
  }
  assert.ok(unaffectedOrigin, "fixture should include an unrelated lesson on the affected date");
  const insertOrigin = db.prepare("INSERT INTO teacher_lesson_origins(id,lesson_id,origin_json) VALUES(?,?,?)");
  insertOrigin.run(movedOrigin.id, movedOrigin.lessonId, JSON.stringify(movedOrigin));
  insertOrigin.run(unaffectedOrigin.id, unaffectedOrigin.lessonId, JSON.stringify(unaffectedOrigin));

  const saved = await app.inject({
    method: "PUT",
    url: "/api/editor/days",
    headers,
    payload: {
      revision: sourceWeek.revision,
      requestId: "editor-scope-crossweek-0001",
      changes: [
        { key: sourceKey, dayIndex: selected.sourceIndex, before: sourceSchedule[sourceKey]![selected.sourceIndex], after: sourceDay },
        { key: targetKey, dayIndex: selected.targetIndex, before: targetSchedule[targetKey]![selected.targetIndex], after: targetDay },
      ],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const originRows = db.prepare("SELECT id,origin_json FROM teacher_lesson_origins WHERE id IN (?,?)")
    .all(movedOrigin.id, unaffectedOrigin.id) as Array<{ id: string; origin_json: string }>;
  const origins = new Map(originRows.map((row) => [row.id, JSON.parse(row.origin_json) as { status: string }]));
  assert.equal(origins.get(movedOrigin.id)?.status, "manual");
  assert.equal(origins.get(unaffectedOrigin.id)?.status, "active");

  const persisted = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=1`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(persisted.statusCode, 200, persisted.body);
  assert.ok((persisted.json().schedule as Schedule)[targetKey]![selected.targetIndex]!
    .slots[selected.targetSlot]!.some((lesson) => lesson.id === moved.id));
});

test("day command rejects forged before data, an unqualified teacher, and an out-of-plan subgroup", async () => {
  const { app, headers } = await setup();
  const week = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(week.statusCode, 200, week.body);
  const scoped = week.json();
  const days = scoped.schedule["5a:0"] as EditorDay[];
  const dayIndex = days.findIndex((day) => day.slots.some((slot) => slot.length));
  assert.ok(dayIndex >= 0);
  const before = structuredClone(days[dayIndex]!);
  const slotIndex = before.slots.findIndex((slot) => slot.length > 0);
  const lessonIndex = before.slots[slotIndex]!.findIndex((lesson) =>
    lesson.teacherId && !lesson.subgroupId && !lesson.jointId && !lesson.event,
  );
  assert.ok(lessonIndex >= 0);
  const db = (app as unknown as {
    smenaDb: {
      prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    };
  }).smenaDb;
  const staleBefore = structuredClone(before);
  staleBefore.note = "tampered";
  const noteAfter = structuredClone(before);
  noteAfter.note = "new note";
  const base = {
    revision: scoped.revision,
    key: "5a:0",
    dayIndex,
    before,
  };

  const forged = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: scoped.revision, requestId: "editor-scope-before-forged",
      changes: [{ ...base, before: staleBefore, after: noteAfter }],
    },
  });
  assert.equal(forged.statusCode, 409, forged.body);

  const invalidTeacherDay = structuredClone(before);
  const lesson = invalidTeacherDay.slots[slotIndex]![lessonIndex]!;
  lesson.teacherId = "teacher:not-qualified-for-this-subject";
  const invalidTeacher = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: scoped.revision, requestId: "editor-scope-invalid-teacher",
      changes: [{ ...base, after: invalidTeacherDay }],
    },
  });
  assert.equal(invalidTeacher.statusCode, 400, invalidTeacher.body);

  const groupSubgroup = (scoped.catalog.subgroups as Array<{ id: string; groupId: string; name: string }>)
    .find((subgroup) => subgroup.groupId === "5a");
  const plan = (scoped.studyPlans as Array<{
    groupId: string; quarterId: string; subjectId: string; mode: string;
    assignments: Array<{ subgroupId: string | null }>;
  }>).find((entry) => entry.groupId === "5a" && entry.quarterId === QUARTER &&
    entry.subjectId === lesson.subjectId && entry.mode === "whole");
  if (groupSubgroup && plan) {
    const outOfPlanDay = structuredClone(before);
    const outOfPlanLesson = outOfPlanDay.slots[slotIndex]![lessonIndex]!;
    outOfPlanLesson.subgroupId = groupSubgroup.id;
    outOfPlanLesson.subgroup = groupSubgroup.name;
    const outOfPlan = await app.inject({
      method: "PUT", url: "/api/editor/days", headers,
      payload: {
        revision: scoped.revision, requestId: "editor-scope-out-of-plan",
        changes: [{ ...base, after: outOfPlanDay }],
      },
    });
    assert.equal(outOfPlan.statusCode, 400, outOfPlan.body);
  } else {
    const meta = db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as { revision: number };
    assert.equal(meta.revision, scoped.revision);
  }

  const unchanged = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().revision, scoped.revision);
  assert.deepEqual(unchanged.json().schedule["5a:0"][dayIndex], before);
});

test("joint lesson removal rejects a partial mirror change and accepts a full detach", async () => {
  const { app, headers } = await setup();
  const stateResponse = await app.inject({ url: "/api/state", headers: { cookie: headers.cookie } });
  assert.equal(stateResponse.statusCode, 200, stateResponse.body);
  const state = stateResponse.json();
  const catalog = state.catalog;
  const math = catalog.subjects.find((subject: { id: string }) => subject.id === "math");
  assert.ok(math);
  math.jointGroupSets = [...(math.jointGroupSets ?? []), ["5a", "5b"]];
  math.maxJointGroups = Math.max(math.maxJointGroups ?? 2, 2);
  const teacher = {
    id: "teacher:editor-scope-joint",
    name: "Сотрудник для проверки совместного урока",
    archived: false,
    subjectIds: ["math"],
    defaultRoomId: null,
  };
  const room = {
    id: "room:editor-scope-joint",
    name: "Кабинет проверки совместного урока",
    archived: false,
    capacity: 100,
    kind: math.roomKind ?? "general",
  };
  catalog.teachers.push(teacher);
  catalog.rooms.push(room);
  const catalogSave = await app.inject({
    method: "PUT", url: "/api/catalog", headers,
    payload: { catalog, revision: state.revision, requestId: "editor-scope-joint-catalog" },
  });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);

  const db = (app as unknown as {
    smenaDb: {
      prepare: (sql: string) => {
        get: (...params: unknown[]) => unknown;
        run: (...params: unknown[]) => unknown;
      };
    };
  }).smenaDb;
  const fixtureWeek = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(fixtureWeek.statusCode, 200, fixtureWeek.body);
  const fixtureState = await app.inject({ url: "/api/state", headers });
  assert.equal(fixtureState.statusCode, 200, fixtureState.body);
  const fixtureSchedule = fixtureState.json().schedule as Schedule;
  let fixture: { dayIndex: number; slot: number; date: string } | undefined;
  for (let dayIndex = 0; dayIndex < fixtureSchedule["5a:0"]!.length && !fixture; dayIndex += 1) {
    const dayA = fixtureSchedule["5a:0"]![dayIndex]!;
    const dayB = fixtureSchedule["5b:0"]!.find((entry) => entry.date === dayA.date);
    if (!dayB) continue;
    for (let slot = 0; slot < Math.min(dayA.slots.length, dayB.slots.length); slot += 1) {
      if (!dayA.slots[slot]!.length && !dayB.slots[slot]!.length) {
        fixture = { dayIndex, slot, date: dayA.date };
        break;
      }
    }
  }
  assert.ok(fixture, "fixture should have a free common group cell");

  const groupADay = fixtureSchedule["5a:0"]!.find((day) => day.date === fixture!.date)!;
  const dayBRow = db.prepare("SELECT id FROM schedule_days WHERE group_id=? AND date=?").get("5b", fixture.date) as { id: number };
  db.prepare("UPDATE schedule_days SET base_start=?,nominal_duration=? WHERE id=?")
    .run(groupADay.start, groupADay.duration, dayBRow.id);
  const alignSlot = db.prepare("UPDATE schedule_slots SET start_minute=?,duration=? WHERE day_id=? AND slot_index=?");
  groupADay.times.forEach((time, slotIndex) =>
    alignSlot.run(time.start, time.duration, dayBRow.id, slotIndex));
  const bump = db.prepare("UPDATE draft_metadata SET revision=revision+1 WHERE id=1");
  bump.run();

  const slotA = db.prepare("SELECT id FROM schedule_slots WHERE day_id=(SELECT id FROM schedule_days WHERE group_id=? AND date=?) AND slot_index=?")
    .get("5a", fixture.date, fixture.slot) as { id: number };
  const slotB = db.prepare("SELECT id FROM schedule_slots WHERE day_id=? AND slot_index=?").get(dayBRow.id, fixture.slot) as { id: number };
  const jointId = "editor-scope-joint-0001";
  const insert = db.prepare(`INSERT INTO lessons(id,slot_id,subject_id,teacher,room,teacher_ref,room_ref,lesson_kind,joint_id)
    VALUES(?,?,'math',?,?,?,?,'regular',?)`);
  insert.run("editor-scope-joint-5a", slotA.id, teacher.name, room.name, teacher.id, room.id, jointId);
  insert.run("editor-scope-joint-5b", slotB.id, teacher.name, room.name, teacher.id, room.id, jointId);
  bump.run();

  const currentWeek = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(currentWeek.statusCode, 200, currentWeek.body);
  const current = currentWeek.json();
  const schedule = current.schedule as Schedule;
  assert.deepEqual(Object.keys(schedule).sort(), ["5a:0", "5b:0"], "only the current group and actual joint peer are included");
  const dayAIndex = schedule["5a:0"]!.findIndex((day) => day.date === fixture!.date);
  const dayBIndex = schedule["5b:0"]!.findIndex((day) => day.date === fixture!.date);
  const beforeA = structuredClone(schedule["5a:0"]![dayAIndex]!) as EditorDay;
  const beforeB = structuredClone(schedule["5b:0"]![dayBIndex]!) as EditorDay;
  assert.ok(beforeA.slots[fixture.slot]!.some((lesson) => lesson.jointId === jointId));
  assert.ok(beforeB.slots[fixture.slot]!.some((lesson) => lesson.jointId === jointId));

  const partialAfter = structuredClone(beforeA);
  partialAfter.slots[fixture.slot] = partialAfter.slots[fixture.slot]!.filter((lesson) => lesson.id !== "editor-scope-joint-5a");
  const partial = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: current.revision,
      requestId: "editor-scope-joint-partial",
      changes: [{ key: "5a:0", dayIndex: dayAIndex, before: beforeA, after: partialAfter }],
    },
  });
  assert.equal(partial.statusCode, 400, partial.body);

  const detachedA = structuredClone(beforeA);
  detachedA.slots[fixture.slot] = detachedA.slots[fixture.slot]!.filter((lesson) => lesson.id !== "editor-scope-joint-5a");
  const detachedB = structuredClone(beforeB);
  const remaining = detachedB.slots[fixture.slot]!.find((lesson) => lesson.id === "editor-scope-joint-5b");
  assert.ok(remaining);
  delete remaining.jointId;
  const complete = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: current.revision,
      requestId: "editor-scope-joint-detach",
      changes: [
        { key: "5a:0", dayIndex: dayAIndex, before: beforeA, after: detachedA },
        { key: "5b:0", dayIndex: dayBIndex, before: beforeB, after: detachedB },
      ],
    },
  });
  assert.equal(complete.statusCode, 200, complete.body);
  const afterWeek = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(afterWeek.statusCode, 200, afterWeek.body);
  const afterSchedule = afterWeek.json().schedule as Schedule;
  assert.equal(afterSchedule["5a:0"]![dayAIndex]!.slots[fixture.slot]!.some((lesson) => lesson.id === "editor-scope-joint-5a"), false);
  assert.deepEqual(Object.keys(afterSchedule), ["5a:0"], "detached unrelated group is no longer included");
  const survivorWeek = await app.inject({ url: `/api/editor/week?groupId=5b&quarterId=${QUARTER}&weekOffset=0`, headers });
  const survivor = (survivorWeek.json().schedule as Schedule)["5b:0"]![dayBIndex]!.slots[fixture.slot]!.find((lesson) => lesson.id === "editor-scope-joint-5b");
  assert.ok(survivor);
  assert.equal(survivor.jointId, undefined);
});

test("day command accepts surname labels for stable teacher IDs on save and undo", async () => {
  const { app, headers } = await setup();
  const week = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(week.statusCode, 200, week.body);
  const state = week.json();
  const days = state.schedule["5a:0"] as EditorDay[];
  const dayIndex = days.findIndex((day) => day.slots.some((slot) =>
    slot.some((lesson) => lesson.teacherId && lesson.teacher && !lesson.subgroupId && !lesson.jointId),
  ));
  assert.ok(dayIndex >= 0);
  const original = structuredClone(days[dayIndex]!) as EditorDay;
  const location = original.slots.findIndex((slot) =>
    slot.some((lesson) => lesson.teacherId && lesson.teacher && !lesson.subgroupId && !lesson.jointId),
  );
  const lessonIndex = original.slots[location]!.findIndex((lesson) =>
    lesson.teacherId && lesson.teacher && !lesson.subgroupId && !lesson.jointId,
  );
  const lesson = original.slots[location]![lessonIndex]!;
  const teacher = (state.catalog.teachers as Array<{ id: string; name: string }>)
    .find((entry) => entry.id === lesson.teacherId);
  assert.ok(teacher);
  const surname = teacher.name.split(/\s+/)[0]!;
  const clientBefore = structuredClone(original);
  clientBefore.slots[location]![lessonIndex]!.teacher = surname;
  const clientAfter = structuredClone(clientBefore);
  clientAfter.note = "Проверка сохранения с кратким именем";

  const saved = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: state.revision,
      requestId: "editor-scope-surname-save",
      changes: [{ key: "5a:0", dayIndex, before: clientBefore, after: clientAfter }],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const undone = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: saved.json().revision,
      requestId: "editor-scope-surname-undo",
      changes: [{ key: "5a:0", dayIndex, before: clientAfter, after: clientBefore }],
    },
  });
  assert.equal(undone.statusCode, 200, undone.body);
  const afterUndo = await app.inject({
    url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`,
    headers: { cookie: headers.cookie },
  });
  assert.equal(afterUndo.statusCode, 200, afterUndo.body);
  const persisted = (afterUndo.json().schedule as Schedule)["5a:0"]![dayIndex]!;
  assert.equal(persisted.note, original.note);
  assert.equal(persisted.slots[location]![lessonIndex]!.teacher, teacher.name);
  assert.equal(afterUndo.json().revision, undone.json().revision);

  const tamperedSubject = structuredClone(persisted);
  tamperedSubject.slots[location]![lessonIndex]!.subjectId = "tampered-subject";
  const rejectSubject = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: afterUndo.json().revision,
      requestId: "editor-scope-tampered-subject",
      changes: [{ key: "5a:0", dayIndex, before: tamperedSubject, after: persisted }],
    },
  });
  assert.equal(rejectSubject.statusCode, 409, rejectSubject.body);

  const tamperedId = structuredClone(persisted);
  tamperedId.slots[location]![lessonIndex]!.id = "tampered-lesson-id";
  const rejectId = await app.inject({
    method: "PUT", url: "/api/editor/days", headers,
    payload: {
      revision: afterUndo.json().revision,
      requestId: "editor-scope-tampered-id",
      changes: [{ key: "5a:0", dayIndex, before: tamperedId, after: persisted }],
    },
  });
  assert.equal(rejectId.statusCode, 409, rejectId.body);
});


test("warm editor request reuses catalog and schema capabilities without caching mutable catalog rows", async () => {
  const { app, headers } = await setup();
  const db = (app as unknown as { smenaDatabase: AsyncDatabase }).smenaDatabase;
  const weekUrl = `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`;
  await app.inject({ url: weekUrl, headers });
  const originalPragma = db.pragma.bind(db), originalPrepare = db.prepare.bind(db);
  let schemaReads = 0, catalogReads = 0;
  db.pragma = async (sql) => { schemaReads++; return originalPragma(sql); };
  db.prepare = (sql) => {
    if (/FROM catalog_subjects ORDER BY/i.test(sql)) catalogReads++;
    if (/FROM sqlite_master/i.test(sql)) schemaReads++;
    return originalPrepare(sql);
  };
  const response = await app.inject({ url: weekUrl, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(catalogReads, 1, "calendar and bell validation must share request catalog");
  assert.equal(schemaReads, 0, "warm requests must reuse verified schema capabilities");
  await originalPrepare("UPDATE catalog_teachers SET name=? WHERE id=(SELECT id FROM catalog_teachers ORDER BY rowid LIMIT 1)").run("Свежая фамилия");
  const refreshed = await app.inject({ url: weekUrl, headers });
  assert.ok(refreshed.json().catalog.teachers.some((teacher: { name: string }) => teacher.name === "Свежая фамилия"), "catalog values are read afresh");
});

test("room conflicts in an omitted group remain red and independently rejected on save", async () => {
  const { app, headers } = await setup();
  const db = (app as unknown as { smenaDatabase: AsyncDatabase }).smenaDatabase;
  const response = await app.inject({ url: "/api/state", headers });
  const state = response.json();
  const schedule = state.schedule as Schedule;
  let selected: { key: string; index: number; slot: number; before: EditorDay; lesson: EditorDay["slots"][number][number] } | undefined;
  outer: for (const [sourceKey, sourceDays] of Object.entries(schedule)) {
    if (!sourceKey.endsWith(":0")) continue;
    for (const sourceDay of sourceDays) for (let sourceSlot = 0; sourceSlot < sourceDay.slots.length; sourceSlot++) {
      const source = sourceDay.slots[sourceSlot].find(lesson => lesson.roomId && !lesson.event && !lesson.jointId && !lesson.subgroupId);
      if (!source) continue;
      for (const [targetKey, targetDays] of Object.entries(schedule)) {
        if (targetKey === sourceKey || !targetKey.endsWith(":0")) continue;
        const targetGroupId = targetKey.slice(0, targetKey.lastIndexOf(":"));
        if (!state.studyPlans.some((plan: { groupId: string; quarterId: string; subjectId: string; mode: string }) => plan.groupId === targetGroupId && plan.quarterId === QUARTER && plan.subjectId === source.subjectId && plan.mode === "whole")) continue;
        const index = targetDays.findIndex(day => day.date === sourceDay.date);
        if (index < 0) continue;
        const day = targetDays[index];
        for (let slot = 0; slot < day.slots.length; slot++) {
          if (day.slots[slot].length || sourceDay.times[sourceSlot].start >= day.times[slot].start + day.times[slot].duration || day.times[slot].start >= sourceDay.times[sourceSlot].start + sourceDay.times[sourceSlot].duration) continue;
          selected = { key: targetKey, index, slot, before: structuredClone(day), lesson: { ...source, id: "scope-room-conflict", teacher: "Свободный учитель", teacherId: "scope-room-teacher" } };
          break outer;
        }
      }
    }
  }
  assert.ok(selected, "fixture needs a cross-group occupied room and a free planned cell");
  await db.prepare("INSERT INTO catalog_teachers(id,name,archived) VALUES(?,?,0)").run("scope-room-teacher", "Свободный учитель");
  await db.prepare("INSERT INTO catalog_teacher_subjects(teacher_id,subject_id) VALUES(?,?)").run("scope-room-teacher", selected.lesson.subjectId);
  const groupId = selected.key.slice(0, selected.key.lastIndexOf(":"));
  const week = await app.inject({ url: `/api/editor/week?groupId=${groupId}&quarterId=${QUARTER}&weekOffset=0`, headers });
  assert.deepEqual(Object.keys(week.json().schedule), [selected.key]);
  const preview = await app.inject({ method: "POST", url: "/api/editor/preview", headers, payload: {
    revision: state.revision, groupId, quarterId: QUARTER, weekOffset: 0, autoRoom: false, payload: { lesson: selected.lesson },
  } });
  assert.equal(preview.statusCode, 200, preview.body);
  const target = preview.json().targets.find((target: { date: string; slot: number }) => target.date === selected!.before.date && target.slot === selected!.slot);
  assert.match(target.reason, /кабинет/i);
  const unchanged = await db.prepare("SELECT * FROM lessons ORDER BY id").all();
  const after = structuredClone(selected.before); after.slots[selected.slot].push(selected.lesson);
  const rejected = await app.inject({ method: "PUT", url: "/api/editor/days", headers, payload: {
    revision: state.revision, requestId: "scope-room-rejection-0001", changes: [{ key: selected.key, dayIndex: selected.index, before: selected.before, after }],
  } });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.deepEqual(await db.prepare("SELECT * FROM lessons ORDER BY id").all(), unchanged);
  assert.equal((await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get()).revision, state.revision);
  const context = await app.inject({ url: `/api/schedule-operations/event-context?date=${selected.before.date}`, headers });
  assert.equal(context.statusCode, 200, context.body);
  assert.ok(Object.keys(context.json().schedule).length > 1, "on-demand form context retains other groups");
});


test("on-demand sparse date context saves and undoes the exact day without changing loaded or historical days", async () => {
  const { app, headers } = await setup();
  const db = (app as unknown as { smenaDatabase: AsyncDatabase }).smenaDatabase;
  const week = await app.inject({ url: `/api/editor/week?groupId=5a&quarterId=${QUARTER}&weekOffset=0`, headers });
  const state = week.json();
  const context = await app.inject({ url: "/api/schedule-operations/event-context?date=2026-10-07", headers });
  assert.equal(context.statusCode, 200, context.body);
  const current = mergeScheduleContext(state.schedule, context.json().schedule);
  assert.equal(current["5a:0"].length, 7, "hydrating context must preserve all loaded days");
  const historical = structuredClone(state.schedule) as Schedule;
  historical["5a:0"][0].note = "Ранее изменённый день";
  const history = mergeScheduleContext(historical, context.json().schedule);
  assert.equal(history["5a:0"][0].note, "Ранее изменённый день", "context must not overwrite historical snapshots");
  const foreignKey = Object.keys(current).find(key => key !== "5a:0")!;
  assert.ok(foreignKey);
  assert.equal(current[foreignKey].length, 1);
  const next = structuredClone(current);
  next[foreignKey][0].note = "Проверка sparse контекста";
  const commands = scheduleDayChanges(current, next);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].dayIndex, 2, "Wednesday context belongs to full week index 2, not sparse array index 0");
  const untouched = await db.prepare("SELECT * FROM lessons ORDER BY id").all();
  const saved = await app.inject({ method: "PUT", url: "/api/editor/days", headers, payload: {
    revision: state.revision, requestId: "scope-sparse-day-0001", changes: commands,
  } });
  assert.equal(saved.statusCode, 200, saved.body);
  const undone = await app.inject({ method: "PUT", url: "/api/editor/days", headers, payload: {
    revision: saved.json().revision, requestId: "scope-sparse-day-undo", changes: scheduleDayChanges(next, current),
  } });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.deepEqual(await db.prepare("SELECT * FROM lessons ORDER BY id").all(), untouched);
  const refreshed = await app.inject({ url: "/api/schedule-operations/event-context?date=2026-10-07", headers });
  assert.deepEqual(refreshed.json().schedule, context.json().schedule);
});
