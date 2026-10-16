import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { previewScheduleCopy } from "../shared/scheduleCopy.ts";
import { weekDates, quarterWeeks } from "../shared/plans.ts";
import { newRoomConflict } from "../shared/roomConflicts.ts";
import { newRoomSuitabilityViolation } from "../shared/roomSuitability.ts";
import { newTeacherConflict } from "../shared/teacherConflicts.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-copy-server-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}

async function start(path = dbPath()) {
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary copy test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const rawCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0];
  assert.ok(cookie);
  return {
    app,
    path,
    headers: {
      cookie,
      origin,
      host: "127.0.0.1",
      "x-csrf-token": response.json().csrfToken as string,
    },
  };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveSchedule(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
  snapshot: StateResponse,
  schedule: StateResponse["schedule"],
) {
  return app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule,
      revision: snapshot.revision,
      requestId: `copy-save-${crypto.randomUUID()}`,
    },
  });
}

function groupId(state: StateResponse, name: string) {
  const group = state.catalog.groups.find((item) => item.name === name);
  assert.ok(group, `missing group ${name}`);
  return group.id;
}

function addJointFixture(state: StateResponse) {
  const firstId = groupId(state, "5А");
  const secondId = groupId(state, "5Б");
  const subject = state.catalog.subjects.find((item) => item.id === "math");
  assert.ok(subject);
  subject.jointGroupSets = [...(subject.jointGroupSets ?? []), [firstId, secondId]];

  const quarter = state.quarters[0]!;
  const sourceOffsets = quarterWeeks(quarter);
  const firstLessons = Object.entries(state.schedule)
    .filter(([key]) => key.startsWith(`${firstId}:`))
    .flatMap(([key, days]) => days.flatMap((day) => day.slots.flatMap((slot, slotIndex) => slot
      .filter((lesson) => lesson.subjectId === "math" && !lesson.event && !lesson.jointId)
      .map((lesson) => ({ offset: Number(key.slice(key.lastIndexOf(":") + 1)), day, slotIndex, lesson })))));

  const template = firstLessons[0]?.lesson;
  assert.ok(template, "seed schedule has a math lesson to use as a valid plan fixture");
  const teachers = state.catalog.teachers.filter((teacher) => !teacher.archived && teacher.subjectIds.includes("math"));
  const students = state.catalog.groups.find((group) => group.id === firstId)!.students + state.catalog.groups.find((group) => group.id === secondId)!.students;
  const requiredKind = template.lessonKind === "lab" ? subject.labRoomKind : subject.roomKind;
  const rooms = state.catalog.rooms.filter((room) => !room.archived && (requiredKind === null || room.kind === requiredKind) &&
    (room.capacity === null || room.capacity >= students));

  for (const offset of sourceOffsets) {
    const firstDays = state.schedule[`${firstId}:${offset}`] ?? [];
    const secondDays = state.schedule[`${secondId}:${offset}`] ?? [];
    for (const firstDay of firstDays) {
      if (firstDay.date < quarter.startDate || firstDay.date > quarter.endDate) continue;
      const secondDay = secondDays.find((day) => day.date === firstDay.date);
      if (!secondDay) continue;
      for (let slotIndex = 0; slotIndex < firstDay.slots.length; slotIndex += 1) {
        if (firstDay.slots[slotIndex]!.length || secondDay.slots[slotIndex]?.length ||
          !firstDay.times[slotIndex] || !secondDay.times[slotIndex]) continue;
        for (const teacher of teachers) for (const room of rooms) {
          const trial = structuredClone(state.schedule);
          const jointId = "copy-server-source-joint";
          const id1 = `${jointId}-${firstId}`;
          const id2 = `${jointId}-${secondId}`;
          const firstCopy = { ...template, id: id1, subjectId: "math", teacherId: teacher.id, roomId: room.id, jointId };
          const secondCopy = { ...firstCopy, id: id2 };
          trial[`${firstId}:${offset}`]!.find((day) => day.date === firstDay.date)!.slots[slotIndex]!.push(firstCopy);
          trial[`${secondId}:${offset}`]!.find((day) => day.date === firstDay.date)!.slots[slotIndex]!.push(secondCopy);
          if (newTeacherConflict(trial, state.schedule) || newRoomConflict(trial, state.schedule) ||
            newRoomSuitabilityViolation(trial, state.schedule, state.catalog)) continue;
          return { schedule: trial, firstId, secondId, offset, sourceLessonId: id1, jointId };
        }
      }
    }
  }
  assert.fail(`could not create a valid math joint fixture in the isolated seed schedule (source lessons=${firstLessons.length}, candidate teachers=${teachers.length}, rooms=${rooms.length})`);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("copying a week with a joint lesson persists all mirrors, keeps destination times, and is idempotent", async () => {
  const { app, headers, path } = await start();
  let initial = await state(app, headers);
  const fixture = addJointFixture(initial);

  const catalogSave = await app.inject({
    method: "PUT", url: "/api/catalog", headers,
    payload: { catalog: initial.catalog, revision: initial.revision, requestId: `copy-catalog-${crypto.randomUUID()}` },
  });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  initial = await state(app, headers);
  const jointSave = await saveSchedule(app, headers, initial, fixture.schedule);
  assert.equal(jointSave.statusCode, 200, jointSave.body);
  initial = await state(app, headers);

  assert.ok(initial.quarters?.length, `state omitted quarters; keys=${Object.keys(initial).join(",")}`);
  const quarter = initial.quarters[0]!;
  const targetOffset = quarterWeeks(quarter).find((offset) => offset !== fixture.offset);
  assert.notEqual(targetOffset, undefined);
  const targetWeekDates = weekDates(targetOffset!);
  const bellSettings = structuredClone(initial.bellSettings!);
  bellSettings.school.duration = 35;
  const shortened = await app.inject({
    method: "PUT", url: "/api/bell-settings", headers,
    payload: {
      settings: bellSettings,
      apply: {
        groupIds: [fixture.firstId, fixture.secondId],
        startDate: targetWeekDates[0], endDate: targetWeekDates[6],
        replaceStart: false, resetBreaks: false,
      },
      revision: initial.revision,
      requestId: `copy-bells-${crypto.randomUUID()}`,
    },
  });
  assert.equal(shortened.statusCode, 200, shortened.body);
  initial = await state(app, headers);
  const sourceDay = initial.schedule[`${fixture.firstId}:${fixture.offset}`]!.find((day) =>
    day.slots.some((slot) => slot.some((lesson) => lesson.id === fixture.sourceLessonId)))!;
  assert.ok(sourceDay);
  const sourceSlot = sourceDay.slots.findIndex((slot) => slot.some((lesson) => lesson.id === fixture.sourceLessonId));
  const weekday = (new Date(`${sourceDay.date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const targetDate = weekDates(targetOffset!)[weekday]!;
  const beforeTimes = [fixture.firstId, fixture.secondId].map((id) => ({
    groupId: id,
    time: initial.schedule[`${id}:${targetOffset}`]!.find((day) => day.date === targetDate)!.times[
      sourceSlot
    ],
  }));

  const proposal = previewScheduleCopy(initial, {
    mode: "week", quarterId: quarter.id, sourceGroupId: fixture.firstId,
    sourceWeekOffset: fixture.offset, targetWeekOffsets: [targetOffset!],
  });
  const jointAdditions = proposal.added.filter((item) => item.jointId);
  assert.equal(jointAdditions.length, 2, "copy adds both group mirrors");
  assert.equal(new Set(jointAdditions.map((item) => item.jointId)).size, 1);
  assert.notEqual(jointAdditions[0]!.jointId, fixture.jointId, "target receives a fresh joint identifier");
  assert.equal(new Set(jointAdditions.map((item) => item.lessonId)).size, 2);
  assert.deepEqual(new Set(jointAdditions.map((item) => item.groupId)), new Set([fixture.firstId, fixture.secondId]));
  assert.ok(proposal.added.length >= jointAdditions.length);
  for (const { groupId: id, time } of beforeTimes) {
    const copied = jointAdditions.find((item) => item.groupId === id)!;
    const day = proposal.schedule[`${id}:${targetOffset}`]!.find((entry) => entry.date === copied.date)!;
    assert.deepEqual(day.times[copied.slot], time, "destination bell times stay intact");
    assert.equal(day.times[copied.slot]!.duration, 35, "copied lesson uses the destination shortened duration");
  }

  const saved = await saveSchedule(app, headers, initial, proposal.schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  let persisted = await state(app, headers);
  for (const addition of proposal.added) {
    const day = persisted.schedule[`${addition.groupId}:${targetOffset}`]!.find((entry) => entry.date === addition.date)!;
    assert.ok(day.slots[addition.slot]!.some((lesson) => lesson.id === addition.lessonId));
  }
  for (const addition of jointAdditions) {
    const day = persisted.schedule[`${addition.groupId}:${targetOffset}`]!.find((entry) => entry.date === addition.date)!;
    const lesson = day.slots[addition.slot]!.find((entry) => entry.id === addition.lessonId)!;
    assert.equal(lesson.jointId, jointAdditions[0]!.jointId);
  }

  // A later manual edit at a copied cell remains untouched on another preview.
  const editedSchedule = structuredClone(persisted.schedule);
  const manual = jointAdditions[0]!;
  const manualDay = editedSchedule[`${manual.groupId}:${targetOffset}`]!.find((entry) => entry.date === manual.date)!;
  manualDay.slots[manual.slot]!.find((lesson) => lesson.id === manual.lessonId)!.note = "Ручная пометка";
  const edited = await saveSchedule(app, headers, persisted, editedSchedule);
  assert.equal(edited.statusCode, 200, edited.body);
  persisted = await state(app, headers);
  const secondProposal = previewScheduleCopy(persisted, {
    mode: "week", quarterId: quarter.id, sourceGroupId: fixture.firstId,
    sourceWeekOffset: fixture.offset, targetWeekOffsets: [targetOffset!],
  });
  assert.equal(secondProposal.added.length, 0, "repeating the same copy adds no duplicate lessons");
  const retained = secondProposal.schedule[`${manual.groupId}:${targetOffset}`]!.find((entry) => entry.date === manual.date)!.slots[manual.slot]!.find((lesson) => lesson.id === manual.lessonId)!;
  assert.equal(retained.note, "Ручная пометка");

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  const reloaded = await state(reopened, headers);
  const roundTrip = reloaded.schedule[`${manual.groupId}:${targetOffset}`]!.find((entry) => entry.date === manual.date)!.slots[manual.slot]!.find((lesson) => lesson.id === manual.lessonId)!;
  assert.equal(roundTrip.note, "Ручная пометка");
  assert.equal(roundTrip.jointId, jointAdditions[0]!.jointId);
});

test("repeating one lesson persists a fresh lesson and the server rejects a stale unavailable proposal", async () => {
  const { app, headers } = await start();
  const initial = await state(app, headers);
  const quarter = initial.quarters[0]!;
  let chosen: { groupId: string; offset: number; lessonId: string } | undefined;
  for (const [key, days] of Object.entries(initial.schedule)) {
    const split = key.lastIndexOf(":");
    const groupId = key.slice(0, split);
    const offset = Number(key.slice(split + 1));
    if (!quarterWeeks(quarter).includes(offset)) continue;
    const lesson = days.flatMap((day) => day.slots.flat()).find((item) => !item.event && !item.jointId && !item.subgroupId && !item.subgroup);
    if (lesson) { chosen = { groupId, offset, lessonId: lesson.id }; break; }
  }
  assert.ok(chosen, "seed schedule contains an ordinary whole-group lesson");
  const targets = quarterWeeks(quarter).filter((offset) => offset !== chosen.offset);
  const proposal = previewScheduleCopy(initial, {
    mode: "lesson", quarterId: quarter.id, sourceGroupId: chosen.groupId,
    sourceWeekOffset: chosen.offset, sourceLessonId: chosen.lessonId,
    targetWeekOffsets: targets,
  });
  assert.equal(proposal.sourceLessonCount, 1);
  assert.ok(proposal.added.length > 0, "at least one destination accepts this repeated lesson");
  assert.ok(proposal.added.every((item) => item.sourceLessonId === chosen!.lessonId));

  const blocked = proposal.added[0]!;
  const blockedDay = proposal.schedule[`${blocked.groupId}:${targets.find((offset) =>
    weekDates(offset).includes(blocked.date))}`]!.find((day) => day.date === blocked.date)!;
  const blockedTime = blockedDay.times[blocked.slot]!;
  const catalog = structuredClone(initial.catalog);
  const source = Object.values(initial.schedule).flatMap((days) => days.flatMap((day) => day.slots.flat()))
    .find((lesson) => lesson.id === chosen!.lessonId)!;
  const teacher = catalog.teachers.find((item) => item.id === source.teacherId);
  assert.ok(teacher, "source lesson has a catalog teacher");
  teacher.unavailability = [...(teacher.unavailability ?? []), {
    id: "copy-server-sick-day",
    startDate: blocked.date,
    endDate: blocked.date,
    start: blockedTime.start,
    end: blockedTime.start + blockedTime.duration,
    reason: "Проверка серверной защиты",
  }];
  const catalogSave = await app.inject({
    method: "PUT", url: "/api/catalog", headers,
    payload: { catalog, revision: initial.revision, requestId: `copy-unavailable-${crypto.randomUUID()}` },
  });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  const current = await state(app, headers);
  const rejected = await saveSchedule(app, headers, current, proposal.schedule);
  assert.equal(rejected.statusCode, 400, "API rejects the stale proposal after teacher unavailability is added");
  assert.match(rejected.body, /недоступен|недоступна/i);
  assert.equal((await state(app, headers)).revision, current.revision, "rejected proposal does not alter persisted schedule");
});
