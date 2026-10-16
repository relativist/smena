import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { editLesson, removeLesson } from "../src/editor.ts";
import type { CatalogRoom } from "../shared/catalog.ts";
import { getJointLessonSource, previewJointLesson } from "../shared/jointLessons.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";
type Auth = { cookie: string; csrf: string };

async function start(path = join(mkdtempSync(join(tmpdir(), "smena-joint-manual-")), "draft.sqlite")) {
  roots.push(path.slice(0, path.lastIndexOf("/")));
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const setup = await app.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary joint test password" },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"]?.toString().split(";")[0];
  assert.ok(cookie);
  return { app, path, auth: { cookie, csrf: setup.json().csrfToken as string } };
}

function headers(auth: Auth) {
  return { cookie: auth.cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.csrf };
}

async function readState(app: Awaited<ReturnType<typeof buildApp>>, auth: Auth) {
  const response = await app.inject({ url: "/api/state", headers: headers(auth) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveCatalog(app: Awaited<ReturnType<typeof buildApp>>, auth: Auth, state: StateResponse) {
  return app.inject({
    method: "PUT", url: "/api/catalog", headers: headers(auth),
    payload: { catalog: state.catalog, revision: state.revision, requestId: `joint-catalog-${crypto.randomUUID()}` },
  });
}

async function saveSchedule(
  app: Awaited<ReturnType<typeof buildApp>>, auth: Auth, state: StateResponse, schedule: StateResponse["schedule"],
) {
  return app.inject({
    method: "PUT", url: "/api/state", headers: headers(auth),
    payload: { schedule, revision: state.revision, requestId: `joint-schedule-${crypto.randomUUID()}` },
  });
}

function makeManualFixture(state: StateResponse) {
  const groups = state.catalog.groups.filter((group) => !group.archived);
  const mathGroups = groups.filter((group) => state.studyPlans.some((plan) =>
    plan.quarterId === state.quarters[0]?.id && plan.groupId === group.id && plan.subjectId === "math" &&
    plan.mode === "whole" && plan.assignments.some((assignment) => assignment.subgroupId === null)));
  assert.ok(mathGroups.length >= 3, "fixture needs three full groups with an ordinary math plan");
  const selectedGroups = mathGroups.slice(0, 3);
  const subject = state.catalog.subjects.find((entry) => entry.id === "math");
  assert.ok(subject);
  subject.jointGroupSets = [...(subject.jointGroupSets ?? []), selectedGroups.map((group) => group.id)];
  subject.maxJointGroups = Math.max(subject.maxJointGroups ?? 2, selectedGroups.length);

  const teachers = [0, 1, 2].map((index) => ({
    id: `teacher:joint-manual-${index}`, name: `Тестовый учитель ${index + 1}`,
    subjectIds: ["math"], defaultRoomId: null, archived: false,
  }));
  state.catalog.teachers.push(...teachers);
  const rooms: CatalogRoom[] = [0, 1, 2].map((index) => ({
    id: `room:joint-manual-${index}`, name: `Кабинет объединения ${index + 1}`,
    capacity: selectedGroups[index]!.students + (index === 2 ? selectedGroups[0]!.students + selectedGroups[1]!.students : 0),
    kind: subject.roomKind ?? "general", archived: false,
  }));
  state.catalog.rooms.push(...rooms);

  const quarter = state.quarters[0]!;
  const offsets = [...new Set(Object.keys(state.schedule).map((key) => Number(key.slice(key.lastIndexOf(":") + 1))))];
  let fixture: { offset: number; date: string; slot: number; start: number; duration: number } | undefined;
  for (const offset of offsets) {
    const days = selectedGroups.map((group) => state.schedule[`${group.id}:${offset}`]?.filter((day) =>
      day.date >= quarter.startDate && day.date <= quarter.endDate) ?? []);
    const commonDates = days[0]!.map((day) => day.date).filter((date) => days.every((items) => items.some((day) => day.date === date)));
    for (const date of commonDates) {
      const aligned = days.map((items) => items.find((day) => day.date === date)!);
      for (let slot = 0; slot < Math.min(...aligned.map((day) => day.slots.length)); slot += 1) {
        const time = aligned[0]!.times[slot];
        if (!time || aligned.some((day) => day.slots[slot]!.length > 0 ||
          day.times[slot]?.start !== time.start || day.times[slot]?.duration !== time.duration ||
          (slot > 0 && day.breaks[slot - 1]! < 2) ||
          (slot < day.times.length - 1 && day.breaks[slot]! < 10))) continue;
        fixture = { offset, date, slot, start: time.start, duration: time.duration };
        break;
      }
      if (fixture) break;
    }
    if (fixture) break;
  }
  assert.ok(fixture, "fixture needs a shared free lesson cell in the selected quarter");

  const schedule = structuredClone(state.schedule);
  for (let index = 0; index < 2; index += 1) {
    const group = selectedGroups[index]!;
    const day = schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture!.date)!;
    day.slots[fixture.slot]!.push({
      id: `manual-source-${index}`, subjectId: "math", lessonKind: "regular",
      teacherId: teachers[index]!.id, teacher: teachers[index]!.name,
      roomId: rooms[index]!.id, room: rooms[index]!.name,
      note: `заметка группы ${group.name}`,
    });
  }
  return { groups: selectedGroups, teachers, rooms, schedule, ...fixture };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("manual joint preview merges existing lessons, adds an eligible group, and survives API restart", async () => {
  const { app, auth, path } = await start();
  let snapshot = await readState(app, auth);
  const fixture = makeManualFixture(snapshot);
  const catalogResponse = await saveCatalog(app, auth, snapshot);
  assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
  snapshot = await readState(app, auth);
  const initialSave = await saveSchedule(app, auth, snapshot, fixture.schedule);
  assert.equal(initialSave.statusCode, 200, initialSave.body);
  snapshot = await readState(app, auth);

  const sourceGroupId = fixture.groups[0]!.id;
  const sourceLessonId = "manual-source-0";
  const source = getJointLessonSource(snapshot, sourceGroupId, sourceLessonId);
  assert.ok(source);
  assert.equal(source.date, fixture.date);
  const before = structuredClone(snapshot.schedule);
  const preview = previewJointLesson(snapshot, {
    quarterId: snapshot.quarters[0]!.id, sourceGroupId, sourceLessonId,
    groupIds: fixture.groups.map((group) => group.id),
    teacherId: fixture.teachers[2]!.id, roomId: fixture.rooms[2]!.id,
    start: fixture.start + 1, duration: fixture.duration,
  });
  assert.equal(preview.conflict, undefined);
  assert.deepEqual(snapshot.schedule, before, "preview does not mutate persisted input");
  assert.equal(preview.changes.filter((change) => change.kind === "existing").length, 1);
  assert.equal(preview.changes.filter((change) => change.kind === "merge").length, 1);
  assert.equal(preview.changes.filter((change) => change.kind === "add").length, 1);
  for (const group of fixture.groups) {
    const row = preview.hours.find((entry) => entry.groupId === group.id);
    assert.ok(row, `hour preview includes ${group.name}`);
    if (group.id === fixture.groups[2]!.id) assert.equal(row.after, row.before + 1);
    else assert.equal(row.after, row.before, `merging an existing lesson does not add hours for ${group.name}`);
  }
  const jointIds = new Set<string>();
  for (const change of preview.changes) {
    const group = fixture.groups.find((entry) => entry.id === change.groupId)!;
    const day = preview.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    assert.equal(day.times[change.slot]!.start, fixture.start + 1);
    assert.deepEqual(day.breaks, day.times.slice(0, -1).map((time, index) =>
      day.times[index + 1]!.start - time.start - time.duration));
    const lesson = day.slots[change.slot]!.find((entry) => entry.id === change.lessonId)!;
    assert.ok(lesson.jointId);
    jointIds.add(lesson.jointId);
    if (group.id !== fixture.groups[2]!.id) assert.equal(lesson.id, group.id === sourceGroupId ? sourceLessonId : "manual-source-1");
  }
  assert.equal(jointIds.size, 1, "all participant lessons share one joint id");

  const saved = await saveSchedule(app, auth, snapshot, preview.schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  let persisted = await readState(app, auth);
  for (const group of fixture.groups) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    const lesson = day.slots[fixture.slot]!.find((entry) => entry.jointId === [...jointIds][0]);
    assert.ok(lesson, `joint mirror persisted for ${group.name}`);
    assert.equal(lesson.teacherId, fixture.teachers[2]!.id);
    assert.equal(lesson.roomId, fixture.rooms[2]!.id);
    if (group.id !== fixture.groups[2]!.id) assert.match(lesson.note ?? "", /заметка группы/);
  }

  // Resource edits and timing changes through an existing member apply to every mirror.
  const edited = editLesson(persisted.schedule, source.location, sourceLessonId, {
    teacher: fixture.teachers[0]!.name, teacherId: fixture.teachers[0]!.id,
    room: fixture.rooms[2]!.name, roomId: fixture.rooms[2]!.id, note: "Общее уточнение",
  }, undefined, persisted.catalog);
  const editedDay = edited[`${sourceGroupId}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  assert.equal(editedDay.times[fixture.slot]!.start, fixture.start + 1);
  const editedSave = await saveSchedule(app, auth, persisted, edited);
  assert.equal(editedSave.statusCode, 200, editedSave.body);
  persisted = await readState(app, auth);
  for (const group of fixture.groups) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    const lesson = day.slots[fixture.slot]!.find((entry) => entry.jointId === [...jointIds][0])!;
    assert.equal(lesson.teacherId, fixture.teachers[0]!.id);
    assert.equal(lesson.roomId, fixture.rooms[2]!.id);
    assert.equal(lesson.note, "Общее уточнение");
    assert.equal(day.times[fixture.slot]!.start, fixture.start + 1);
  }

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  persisted = await readState(reopened, auth);
  const mirrors = fixture.groups.map((group) => persisted.schedule[`${group.id}:${fixture.offset}`]!
    .find((entry) => entry.date === fixture.date)!.slots[fixture.slot]!.find((lesson) => lesson.jointId === [...jointIds][0]));
  assert.ok(mirrors.every(Boolean));
  assert.equal(new Set(mirrors.map((lesson) => lesson!.jointId)).size, 1);

  const beforeDetach = structuredClone(persisted.schedule);
  const detachedOne = removeLesson(persisted.schedule, source.location, sourceLessonId);
  const detachOneSave = await saveSchedule(reopened, auth, persisted, detachedOne);
  assert.equal(detachOneSave.statusCode, 200, detachOneSave.body);
  persisted = await readState(reopened, auth);
  const firstDay = persisted.schedule[`${fixture.groups[0]!.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  assert.equal(firstDay.slots[fixture.slot]!.some((lesson) => lesson.id === sourceLessonId), false);
  assert.equal(firstDay.slots[fixture.slot]!.some((lesson) => lesson.jointId === [...jointIds][0]), false);
  for (const group of fixture.groups.slice(1)) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    assert.equal(day.slots[fixture.slot]!.some((lesson) => lesson.jointId === [...jointIds][0]), true,
      `removing one group preserves the remaining shared lesson in ${group.name}`);
  }

  const secondLocation = { groupId: fixture.groups[1]!.id, weekOffset: fixture.offset, date: fixture.date, slot: fixture.slot };
  const detachedPair = removeLesson(persisted.schedule, secondLocation, "manual-source-1");
  const detachPairSave = await saveSchedule(reopened, auth, persisted, detachedPair);
  assert.equal(detachPairSave.statusCode, 200, detachPairSave.body);
  persisted = await readState(reopened, auth);
  const remainingDay = persisted.schedule[`${fixture.groups[2]!.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  const singleton = remainingDay.slots[fixture.slot]!.find((lesson) => lesson.id !== "manual-source-0" && lesson.subjectId === "math");
  assert.ok(singleton);
  assert.equal(singleton.jointId, undefined, "the final remaining participant is normalized to an ordinary lesson");

  const undo = await saveSchedule(reopened, auth, persisted, beforeDetach);
  assert.equal(undo.statusCode, 200, undo.body);
  persisted = await readState(reopened, auth);
  for (const group of fixture.groups) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    assert.ok(day.slots[fixture.slot]!.some((lesson) => lesson.jointId === [...jointIds][0]),
      `saving the prior snapshot restores joint membership for ${group.name}`);
  }
});

test("manual joint preview leaves the schedule unchanged when a participant cell is occupied", async () => {
  const { app, auth } = await start();
  let snapshot = await readState(app, auth);
  const fixture = makeManualFixture(snapshot);
  const catalogResponse = await saveCatalog(app, auth, snapshot);
  assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
  snapshot = await readState(app, auth);
  const initialSave = await saveSchedule(app, auth, snapshot, fixture.schedule);
  assert.equal(initialSave.statusCode, 200, initialSave.body);
  snapshot = await readState(app, auth);
  const target = fixture.groups[2]!;
  const day = snapshot.schedule[`${target.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  day.slots[fixture.slot]!.push({
    id: "blocking-lesson", subjectId: "event", event: "Занято",
    teacherId: fixture.teachers[0]!.id, teacher: fixture.teachers[0]!.name,
    roomId: fixture.rooms[0]!.id, room: fixture.rooms[0]!.name,
  });
  const before = structuredClone(snapshot.schedule);
  const preview = previewJointLesson(snapshot, {
    quarterId: snapshot.quarters[0]!.id, sourceGroupId: fixture.groups[0]!.id, sourceLessonId: "manual-source-0",
    groupIds: fixture.groups.map((group) => group.id), teacherId: fixture.teachers[2]!.id,
    roomId: fixture.rooms[2]!.id, start: fixture.start, duration: fixture.duration,
  });
  assert.ok(preview.conflict);
  assert.deepEqual(preview.schedule, before, "conflicting preview makes no partial edits");
  assert.deepEqual(preview.changes, []);

  const malformed = structuredClone(snapshot.schedule);
  malformed[`${fixture.groups[0]!.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!
    .slots[fixture.slot]!.find((lesson) => lesson.id === "manual-source-0")!.teacherId = "missing-teacher";
  const rejected = await saveSchedule(app, auth, snapshot, malformed);
  assert.equal(rejected.statusCode, 400, rejected.body);
  const persisted = await readState(app, auth);
  assert.ok(persisted.schedule[`${fixture.groups[0]!.id}:${fixture.offset}`]!
    .find((entry) => entry.date === fixture.date)!.slots[fixture.slot]!.some((lesson) => lesson.id === "manual-source-0"));
});

test("automatic joint time aligns different group bells and persists only the selected lesson interval", async () => {
  const { app, auth, path } = await start();
  let snapshot = await readState(app, auth);
  const fixture = makeManualFixture(snapshot);
  const catalogResponse = await saveCatalog(app, auth, snapshot);
  assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);

  // Make 5А's existing lesson start five minutes later and last five minutes longer;
  // 5Б stays at the original 14:00/45-style interval.
  const peerGroup = fixture.groups[0]!;
  const peerDay = fixture.schedule[`${peerGroup.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  const peerTimeBefore = { ...peerDay.times[fixture.slot]! };
  peerDay.times[fixture.slot] = { start: peerTimeBefore.start + 5, duration: peerTimeBefore.duration + 5 };
  peerDay.breaks = peerDay.times.slice(0, -1).map((time, index) =>
    peerDay.times[index + 1]!.start - time.start - time.duration);
  if (fixture.slot === 0) {
    const first = peerDay.times[0]!;
    peerDay.start = `${String(Math.floor(first.start / 60)).padStart(2, "0")}:${String(first.start % 60).padStart(2, "0")}`;
  }

  snapshot = await readState(app, auth);
  const initialSave = await saveSchedule(app, auth, snapshot, fixture.schedule);
  assert.equal(initialSave.statusCode, 200, initialSave.body);
  snapshot = await readState(app, auth);
  const sourceGroup = fixture.groups[1]!; // 5Б, at the earlier bell time.
  const sourceLessonId = "manual-source-1";
  const source = getJointLessonSource(snapshot, sourceGroup.id, sourceLessonId);
  assert.equal(source.start, fixture.start);
  assert.equal(source.duration, fixture.duration);
  const beforeSchedule = structuredClone(snapshot.schedule);
  const peerDayBefore = beforeSchedule[`${peerGroup.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
  assert.deepEqual(peerDayBefore.times[fixture.slot], { start: fixture.start + 5, duration: fixture.duration + 5 });

  const preview = previewJointLesson(snapshot, {
    quarterId: snapshot.quarters[0]!.id, sourceGroupId: sourceGroup.id, sourceLessonId,
    groupIds: fixture.groups.map((group) => group.id), teacherId: fixture.teachers[2]!.id,
    roomId: fixture.rooms[2]!.id, start: fixture.start, duration: fixture.duration, autoTime: true,
  });
  assert.equal(preview.conflict, undefined, preview.conflict);
  assert.deepEqual(preview.time, { start: fixture.start, duration: fixture.duration });
  assert.equal(preview.changes.find((entry) => entry.groupId === peerGroup.id)?.lessonId, "manual-source-0");
  assert.equal(preview.changes.find((entry) => entry.groupId === sourceGroup.id)?.lessonId, sourceLessonId);
  assert.equal(preview.changes.filter((entry) => entry.kind === "add").length, 1);
  const peerTiming = preview.timingChanges?.find((entry) => entry.groupId === peerGroup.id);
  assert.deepEqual(peerTiming?.before, { start: fixture.start + 5, duration: fixture.duration + 5 });
  assert.deepEqual(peerTiming?.after, { start: fixture.start, duration: fixture.duration });
  assert.equal(preview.hours.find((entry) => entry.groupId === fixture.groups[2]!.id)?.after,
    preview.hours.find((entry) => entry.groupId === fixture.groups[2]!.id)?.before! + 1);

  for (const group of fixture.groups) {
    const beforeDay = beforeSchedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    const afterDay = preview.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    for (let slot = 0; slot < beforeDay.times.length; slot += 1) {
      if (slot !== fixture.slot) assert.deepEqual(afterDay.times[slot], beforeDay.times[slot], `other slot ${slot} for ${group.name} remains unchanged`);
    }
  }

  const saved = await saveSchedule(app, auth, snapshot, preview.schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  let persisted = await readState(app, auth);
  const jointId = preview.changes.map((entry) => persisted.schedule[`${entry.groupId}:${fixture.offset}`]!
    .find((day) => day.date === fixture.date)!.slots[entry.slot]!.find((lesson) => lesson.id === entry.lessonId)!.jointId);
  assert.equal(new Set(jointId).size, 1);
  for (const group of fixture.groups) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    const lesson = day.slots[fixture.slot]!.find((entry) => entry.jointId === jointId[0])!;
    assert.equal(day.times[fixture.slot]!.start, fixture.start);
    assert.equal(day.times[fixture.slot]!.duration, fixture.duration);
    if (group.id !== fixture.groups[2]!.id) assert.match(lesson.note ?? "", /заметка группы/);
  }

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  persisted = await readState(reopened, auth);
  for (const group of fixture.groups) {
    const day = persisted.schedule[`${group.id}:${fixture.offset}`]!.find((entry) => entry.date === fixture.date)!;
    const lesson = day.slots[fixture.slot]!.find((entry) => entry.jointId === jointId[0]);
    assert.ok(lesson, `joint lesson for ${group.name} survives restart`);
    assert.equal(lesson.teacherId, fixture.teachers[2]!.id);
    assert.equal(day.times[fixture.slot]!.start, fixture.start);
    assert.equal(day.times[fixture.slot]!.duration, fixture.duration);
  }
});
