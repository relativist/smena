import assert from "node:assert/strict";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";
function dbPath() {
  const root = mkdtempSync(join(tmpdir(), "smena-plans-"));
  roots.push(root);
  return join(root, "draft.sqlite");
}
async function appWithAdmin() {
  const path = dbPath();
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
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
async function getState(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("v3 migration keeps seeded lessons, introduces quarter plans, and fills every quarter week", async () => {
  const { app, headers } = await appWithAdmin();
  const state = await getState(app, headers);
  assert.equal(state.revision, 1, "fresh draft starts at revision one");
  assert.equal(state.quarters.length, 1);
  assert.equal(state.quarters[0].id, "quarter-2026-1");
  assert.ok(state.studyPlans.length > 0);
  assert.ok(state.studyPlans.some((plan) => plan.mode === "subgroups"));
  assert.ok(
    state.studyPlans.every((plan) =>
      plan.assignments.every((assignment) => assignment.target > 0),
    ),
  );
  assert.equal("teacherId" in state.studyPlans[0].assignments[0], false);
  assert.equal("roomId" in state.studyPlans[0].assignments[0], false);
  assert.equal("roomKind" in state.studyPlans[0], false);
  assert.ok(state.schedule["5a:-5"]);
  assert.equal(state.schedule["5a:-5"].length, 7);
  assert.equal(state.schedule["5a:-5"][0].slots.length, 7);
  assert.ok(
    state.schedule["5a:0"]
      .flatMap((day) => day.slots.flat())
      .some((lesson) => lesson.subjectId === "math"),
  );
  assert.ok(
    state.schedule["5a:0"]
      .flatMap((day) => day.slots.flat())
      .every((lesson) => lesson.lessonKind === "regular"),
  );
  const informatics = state.schedule["5a:0"]
    .flatMap((day) => day.slots.flat())
    .filter((lesson) => lesson.subjectId === "informatics");
  const firstSubgroup = informatics.find(
      (lesson) => lesson.subgroup === "5А/1",
    ),
    secondSubgroup = informatics.find((lesson) => lesson.subgroup === "5А/2");
  assert.equal(
    state.catalog.teachers.find(
      (teacher) => teacher.id === firstSubgroup?.teacherId,
    )?.name,
    "Орлова Светлана Игоревна",
  );
  assert.equal(
    state.catalog.teachers.find(
      (teacher) => teacher.id === secondSubgroup?.teacherId,
    )?.name,
    "Демидов-Константиновский Александр Константинович",
  );
  const plan = state.studyPlans.find(
    (item) => item.groupId === "5a" && item.subjectId === "informatics",
  );
  assert.ok(
    plan?.assignments.some(
      (item) => item.subgroupId === firstSubgroup?.subgroupId,
    ),
  );
  assert.ok(
    plan?.assignments.some(
      (item) => item.subgroupId === secondSubgroup?.subgroupId,
    ),
  );
  const missingSchedule = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: { revision: state.revision, requestId: "missing-schedule-0001" },
  });
  assert.equal(missingSchedule.statusCode, 400);
});

test("upgrading a v2 catalog with renamed teacher labels preserves existing lesson rows", async () => {
  const path = dbPath(),
    app = await buildApp({ dbPath: path });
  apps.push(app);
  const initial = app.inject({ url: "/api/health" });
  await initial;
  const baseline = (await app.inject({ url: "/api/auth/status" })).json();
  assert.equal(baseline.needsSetup, true);
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(setup.statusCode, 200);
  const cookieRaw = setup.headers["set-cookie"],
    cookie = (Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw)?.split(
      ";",
    )[0];
  assert.ok(cookie);
  const state = await getState(app, { cookie });
  const first = state.schedule["5a:0"]
    .flatMap((day) => day.slots.flat())
    .find((lesson) => lesson.teacherId);
  assert.ok(first?.teacherId);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  db.pragma("foreign_keys=ON");
  db.prepare(
    "UPDATE catalog_teachers SET name='Учитель после переименования' WHERE id=?",
  ).run(first.teacherId);
  db.prepare(
    "UPDATE lessons SET teacher='Учитель после переименования' WHERE teacher_ref=?",
  ).run(first.teacherId);
  db.prepare("DELETE FROM schedule_days WHERE day_index>=5").run();
  db.exec("DROP TABLE school_calendar");
  db.exec(
    "DELETE FROM schema_migrations WHERE version>=3; DROP TABLE catalog_teacher_subjects; DROP TABLE plan_assignments; DROP TABLE study_plans; DROP TABLE quarters; ALTER TABLE lessons DROP COLUMN lesson_kind; ALTER TABLE catalog_teachers DROP COLUMN default_room_id;",
  );
  db.close();
  const upgraded = await buildApp({ dbPath: path });
  apps.push(upgraded);
  const login = await upgraded.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(login.statusCode, 200);
  const raw = login.headers["set-cookie"],
    newCookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(newCookie);
  const after = await getState(upgraded, { cookie: newCookie });
  const saved = after.schedule["5a:0"]
    .flatMap((day) => day.slots.flat())
    .find((lesson) => lesson.id === first.id);
  assert.equal(saved?.teacher, "Учитель после переименования");
  assert.equal(saved?.teacherId, first.teacherId);
  assert.equal(saved?.lessonKind, "regular");
  assert.equal(after.quarters.length, 1);
  assert.equal(
    after.revision,
    state.revision + 5,
    "the v3, v5, v7, v8 and v9 migrations invalidate the editor revision",
  );
});

test("v4 teacher subject migration derives links and invalidates old drafts", async () => {
  const { app, headers, path } = await appWithAdmin();
  const before = await getState(app, headers);
  const teacherId = before.schedule["5a:0"]
    .flatMap((day) => day.slots.flat())
    .find((lesson) => lesson.subjectId === "physics")!.teacherId!;
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  db.pragma("foreign_keys=ON");
  db.prepare("DELETE FROM schema_migrations WHERE version>=4").run();
  db.pragma("foreign_keys=OFF");
  db.exec("ALTER TABLE catalog_teachers DROP COLUMN default_room_id");
  db.exec("DROP TABLE catalog_teacher_subjects");
  db.close();
  const upgraded = await buildApp({ dbPath: path });
  apps.push(upgraded);
  const login = await upgraded.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"],
    cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const after = await getState(upgraded, { cookie });
  assert.equal(after.revision, before.revision + 6);
  const migratedTeacher = after.catalog.teachers.find(
    (teacher) => teacher.id === teacherId,
  );
  assert.ok(migratedTeacher?.subjectIds.includes("physics"));
  assert.equal(migratedTeacher?.defaultRoomId, null);
});

test("v6 drops plan teacher and room bindings while preserving hours, lessons, and group room preferences", async () => {
  const { app, headers, path } = await appWithAdmin();
  const before = await getState(app, headers);
  const assignments = before.studyPlans.flatMap((plan) =>
    plan.assignments.map((assignment) => ({
      planId: plan.id,
      ...assignment,
    })),
  );
  const firstLesson = Object.values(before.schedule)
    .flatMap((days) => days.flatMap((day) => day.slots.flat()))
    .find((lesson) => lesson.teacherId && lesson.roomId)!;
  assert.ok(firstLesson.teacherId && firstLesson.roomId);
  const preferredRooms = ["room:214", "room:206"];
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const db = new Database(path);
  db.pragma("foreign_keys=OFF");
  db.prepare("DELETE FROM catalog_group_auto_rooms WHERE group_id='5a'").run();
  for (const [position, roomId] of preferredRooms.entries())
    db.prepare(
      "INSERT INTO catalog_group_auto_rooms(group_id,room_id,position) VALUES('5a',?,?)",
    ).run(roomId, position);
  db.prepare(
    "UPDATE study_plans SET room_kind='chemistry-lab' WHERE subject_id='physics' AND lesson_kind='regular'",
  ).run();
  db.exec(`
    ALTER TABLE plan_assignments RENAME TO plan_assignments_v6;
    CREATE TABLE plan_assignments(
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
      subgroup_id TEXT REFERENCES catalog_subgroups(id),
      teacher_id TEXT NOT NULL REFERENCES catalog_teachers(id),
      room_id TEXT REFERENCES catalog_rooms(id),
      target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 1000)
    );
  `);
  const restoreAssignment = db.prepare(
    "INSERT INTO plan_assignments(id,plan_id,subgroup_id,teacher_id,room_id,target) VALUES(?,?,?,?,?,?)",
  );
  for (const assignment of assignments)
    restoreAssignment.run(
      assignment.id,
      assignment.planId,
      assignment.subgroupId,
      firstLesson.teacherId,
      firstLesson.roomId,
      assignment.target,
    );
  db.exec("DROP TABLE plan_assignments_v6");
  db.prepare("DELETE FROM schema_migrations WHERE version=6").run();
  db.close();

  const upgraded = await buildApp({ dbPath: path });
  apps.push(upgraded);
  const login = await upgraded.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "temporary test password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"],
    cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const after = await getState(upgraded, { cookie });
  assert.deepEqual(after.schedule, before.schedule);
  assert.deepEqual(
    after.studyPlans.flatMap((plan) =>
      plan.assignments.map((assignment) => ({
        planId: plan.id,
        id: assignment.id,
        subgroupId: assignment.subgroupId,
        target: assignment.target,
      })),
    ),
    assignments.map(({ planId, id, subgroupId, target }) => ({
      planId,
      id,
      subgroupId,
      target,
    })),
  );
  assert.equal("teacherId" in after.studyPlans[0].assignments[0], false);
  assert.equal("roomId" in after.studyPlans[0].assignments[0], false);
  assert.deepEqual(
    after.catalog.groups.find((group) => group.id === "5a")?.autoRoomIds,
    preferredRooms,
  );
  assert.equal(
    after.catalog.subjects.find((subject) => subject.id === "physics")
      ?.roomKind,
    "chemistry-lab",
  );
  assert.equal(after.revision, before.revision + 1);
});

test("teacher default rooms persist and validate catalog references", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers);
  const teacher = before.catalog.teachers[0];
  const room = before.catalog.rooms.find((entry) => !entry.archived)!;
  const catalog = structuredClone(before.catalog);
  catalog.teachers.find((entry) => entry.id === teacher.id)!.defaultRoomId =
    room.id;
  const saved = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers,
    payload: {
      catalog,
      revision: before.revision,
      requestId: "teacher-default-room-01",
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as StateResponse;
  assert.equal(
    after.catalog.teachers.find((entry) => entry.id === teacher.id)
      ?.defaultRoomId,
    room.id,
  );
  const invalid = structuredClone(after.catalog);
  invalid.teachers.find((entry) => entry.id === teacher.id)!.defaultRoomId =
    "missing-room";
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers,
    payload: {
      catalog: invalid,
      revision: after.revision,
      requestId: "teacher-default-room-02",
    },
  });
  assert.equal(rejected.statusCode, 400);
});

test("schedule saves reject newly assigned occupied rooms", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers);
  const rows: Array<{
    key: string;
    dayIndex: number;
    slotIndex: number;
    lesson: (typeof before.schedule)[string][number]["slots"][number][number];
    roomId: string;
  }> = [];
  for (const [key, days] of Object.entries(before.schedule))
    for (const [dayIndex, day] of days.entries())
      for (const [slotIndex, slot] of day.slots.entries())
        for (const lesson of slot)
          if (lesson.roomId)
            rows.push({
              key,
              dayIndex,
              slotIndex,
              lesson,
              roomId: lesson.roomId,
            });
  let collision:
    | { changed: (typeof rows)[number]; occupied: (typeof rows)[number] }
    | undefined;
  for (const changed of rows)
    for (const occupied of rows) {
      if (
        changed.key.slice(0, changed.key.lastIndexOf(":")) ===
          occupied.key.slice(0, occupied.key.lastIndexOf(":")) ||
        changed.roomId === occupied.roomId
      )
        continue;
      const changedDay = before.schedule[changed.key][changed.dayIndex];
      const occupiedDay = before.schedule[occupied.key][occupied.dayIndex];
      if (
        changedDay.date === occupiedDay.date &&
        changedDay.times[changed.slotIndex].start <
          occupiedDay.times[occupied.slotIndex].start +
            occupiedDay.times[occupied.slotIndex].duration &&
        occupiedDay.times[occupied.slotIndex].start <
          changedDay.times[changed.slotIndex].start +
            changedDay.times[changed.slotIndex].duration
      ) {
        collision = { changed, occupied };
        break;
      }
    }
  assert.ok(collision, "seed schedule has distinct rooms at a shared time");
  const schedule = structuredClone(before.schedule);
  const target =
    schedule[collision.changed.key][collision.changed.dayIndex].slots[
      collision.changed.slotIndex
    ];
  const index = target.findIndex(
    (lesson) => lesson.id === collision!.changed.lesson.id,
  );
  const room = before.catalog.rooms.find(
    (entry) => entry.id === collision!.occupied.roomId,
  )!;
  target[index] = {
    ...target[index],
    roomId: room.id,
    room: room.name,
  };
  const response = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule,
      revision: before.revision,
      requestId: "room-overlap-reject-01",
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /уже занят группой/iu);
});

test("a group may use an available room outside its defaults", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers);
  let selection:
    | {
        key: string;
        dayIndex: number;
        slotIndex: number;
        lesson: (typeof before.schedule)[string][number]["slots"][number][number];
        roomId: string;
      }
    | undefined;
  for (const [key, days] of Object.entries(before.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    const groupRoomId = before.catalog.groups.find(
      (entry) => entry.id === groupId,
    )?.roomId;
    for (const [dayIndex, day] of days.entries())
      for (const [slotIndex, slot] of day.slots.entries())
        for (const lesson of slot) {
          if (!lesson.roomId) continue;
          const teacherRoomId = before.catalog.teachers.find(
            (entry) => entry.id === lesson.teacherId,
          )?.defaultRoomId;
          const occupiedAtTime = new Set(
            Object.values(before.schedule).flatMap((otherDays) =>
              otherDays.flatMap((otherDay) =>
                otherDay.date !== day.date
                  ? []
                  : otherDay.slots.flatMap((otherSlot, otherSlotIndex) => {
                      const otherTime = otherDay.times[otherSlotIndex];
                      const time = day.times[slotIndex];
                      return otherSlot
                        .filter(
                          (candidate) =>
                            candidate.roomId &&
                            time.start < otherTime.start + otherTime.duration &&
                            otherTime.start < time.start + time.duration,
                        )
                        .map((candidate) => candidate.roomId!);
                    }),
              ),
            ),
          );
          const room = before.catalog.rooms.find(
            (entry) =>
              !entry.archived &&
              entry.id !== groupRoomId &&
              entry.id !== teacherRoomId &&
              !roomSuitabilityReason(before.catalog, { ...lesson, groupId, roomId: entry.id }) &&
              !occupiedAtTime.has(entry.id),
          );
          if (room) {
            selection = { key, dayIndex, slotIndex, lesson, roomId: room.id };
            break;
          }
        }
    if (selection) break;
  }
  assert.ok(selection, "seed catalog has a free non-default room");
  const schedule = structuredClone(before.schedule);
  const target =
    schedule[selection.key][selection.dayIndex].slots[selection.slotIndex];
  const index = target.findIndex(
    (lesson) => lesson.id === selection!.lesson.id,
  );
  const room = before.catalog.rooms.find(
    (entry) => entry.id === selection!.roomId,
  )!;
  target[index] = { ...target[index], roomId: room.id, room: room.name };
  const response = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule,
      revision: before.revision,
      requestId: "room-free-non-default-01",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const saved = await getState(app, headers);
  assert.equal(
    saved.schedule[selection.key][selection.dayIndex].slots[
      selection.slotIndex
    ].find((lesson) => lesson.id === selection!.lesson.id)?.roomId,
    room.id,
  );
});

test("plan snapshot checks references, uses revision replay, and leaves placed lessons intact", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers);
  const quarters = structuredClone(before.quarters);
  quarters[0]!.name = `${quarters[0]!.name} (обновлена)`;
  const request = {
    quarters,
    studyPlans: before.studyPlans,
    revision: before.revision,
    requestId: "plan-save-000001",
  };
  const saved = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: request,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const replay = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: request,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().revision, saved.json().revision);
  const after = saved.json() as StateResponse;
  assert.deepEqual(after.quarters, quarters);
  assert.deepEqual(after.studyPlans, before.studyPlans);
  assert.deepEqual(after.schedule, before.schedule);
  const forged = structuredClone(after.studyPlans);
  forged[0]!.assignments[0]!.target += 1;
  const protectedEdit = await app.inject({
    method: "PUT", url: "/api/plans", headers,
    payload: { quarters: after.quarters, studyPlans: forged, revision: after.revision, requestId: "plan-protected-0001" },
  });
  assert.equal(protectedEdit.statusCode, 409);
  const bad = structuredClone(after.studyPlans);
  bad[0].assignments[0].target = 0;
  const invalid = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      quarters: after.quarters,
      studyPlans: bad,
      revision: after.revision,
      requestId: "plan-invalid-00001",
    },
  });
  assert.equal(invalid.statusCode, 400);
  const stale = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: { ...request, requestId: "plan-stale-000001" },
  });
  assert.equal(stale.statusCode, 409);
});

test("qualified replacement teacher can take an existing lesson without changing its hour", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers);
  const preferredReplacement = before.catalog.teachers.find(
    (teacher) => teacher.id === "teacher:соколова-марина-викторовна",
  )!;
  const catalog = structuredClone(before.catalog);
  catalog.teachers
    .find((teacher) => teacher.id === preferredReplacement.id)!
    .subjectIds.push("physics");
  const catalogSave = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers,
    payload: {
      catalog,
      revision: before.revision,
      requestId: "specialty-link-save-01",
    },
  });
  assert.equal(catalogSave.statusCode, 200, catalogSave.body);
  const catalogState = catalogSave.json() as StateResponse;
  const locations: Array<{
    key: string;
    dayIndex: number;
    slotIndex: number;
    lesson: any;
    day: (typeof catalogState.schedule)[string][number];
  }> = [];
  for (const [key, days] of Object.entries(catalogState.schedule))
    for (const [dayIndex, day] of days.entries())
      for (const [slotIndex, lessons] of day.slots.entries()) {
        const lesson = lessons.find((item) => item.subjectId === "physics");
        if (lesson) locations.push({ key, dayIndex, slotIndex, lesson, day });
      }
  assert.ok(locations.length, "seeded physics lesson exists for the plan");
  const qualifiedTeachers = catalogState.catalog.teachers.filter(
    (teacher) => teacher.subjectIds.includes("physics"),
  );
  const teacherIsFree = (teacherId: string, location: (typeof locations)[number]) =>
    !Object.entries(catalogState.schedule).some(([key, days]) =>
      (days as typeof catalogState.schedule[string]).some((day) => {
        if (day.date !== location.day.date) return false;
        const groupId = key.slice(0, key.lastIndexOf(":"));
        return day.slots.some((slot, index) =>
          slot.some((lesson) =>
            lesson.id !== location.lesson.id &&
            (lesson.teacherId ?? catalogState.catalog.teachers.find(
              (candidate) => candidate.name === lesson.teacher,
            )?.id) === teacherId &&
            day.times[index].start < location.day.times[location.slotIndex].start +
              location.day.times[location.slotIndex].duration &&
            location.day.times[location.slotIndex].start <
              day.times[index].start + day.times[index].duration &&
            // Mirrors of one joint session are a single teacher assignment.
            !(lesson.jointId && lesson.jointId === location.lesson.jointId && groupId !== location.key.slice(0, location.key.lastIndexOf(":"))),
          ),
        );
      }),
    );
  const replacement = [
    ...qualifiedTeachers.filter((teacher) => teacher.id === preferredReplacement.id),
    ...qualifiedTeachers.filter((teacher) => teacher.id !== preferredReplacement.id),
  ].flatMap((teacher) =>
    locations.filter((candidate) => teacherIsFree(teacher.id, candidate)).map((candidate) => ({ teacher, location: candidate })),
  )[0]?.teacher;
  const location = locations.find((candidate) => replacement && teacherIsFree(replacement.id, candidate));
  assert.ok(replacement && location, "a qualified teacher is free for at least one physics lesson");
  const ineligible = catalogState.catalog.teachers.find(
    (teacher) => !teacher.subjectIds.includes("physics"),
  )!;
  const invalidSchedule = structuredClone(catalogState.schedule);
  const invalidSlot =
    invalidSchedule[location.key][location.dayIndex].slots[location.slotIndex];
  const invalidIndex = invalidSlot.findIndex(
    (item) => item.id === location!.lesson.id,
  );
  invalidSlot[invalidIndex] = {
    ...location.lesson,
    teacherId: ineligible.id,
    teacher: ineligible.name,
  };
  const invalid = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule: invalidSchedule,
      revision: catalogState.revision,
      requestId: "specialty-invalid-replace-01",
    },
  });
  assert.equal(invalid.statusCode, 400);

  const validSchedule = structuredClone(catalogState.schedule);
  const target = validSchedule[location.key][location.dayIndex];
  const beforeTime = target.times[location.slotIndex];
  const lessonIndex = target.slots[location.slotIndex].findIndex(
    (item) => item.id === location!.lesson.id,
  );
  target.slots[location.slotIndex][lessonIndex] = {
    ...location.lesson,
    teacherId: replacement.id,
    teacher: replacement.name,
  };
  const valid = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule: validSchedule,
      revision: catalogState.revision,
      requestId: "specialty-valid-replace-01",
    },
  });
  assert.equal(valid.statusCode, 200, valid.body);
  const saved = valid.json() as { revision: number };
  const after = await getState(app, headers);
  const placed = after.schedule[location.key][location.dayIndex];
  const replacedLesson = placed.slots[location.slotIndex].find(
    (item) => item.id === location!.lesson.id,
  );
  assert.equal(replacedLesson?.teacherId, replacement.id);
  assert.deepEqual(placed.times[location.slotIndex], beforeTime);
  assert.equal(
    Object.values(after.schedule)
      .flatMap((days) => days.flatMap((day) => day.slots.flat()))
      .filter(
        (item) =>
          item.subjectId === "physics" && item.id === location!.lesson.id,
      ).length,
    1,
  );
  assert.equal(after.revision, saved.revision);
});

test("three quarters materialize complete weeks and allow a full schedule save", async () => {
  const { app, headers } = await appWithAdmin();
  const before = await getState(app, headers),
    second = {
      id: "quarter-2026-2",
      name: "II четверть",
      startDate: "2026-11-02",
      endDate: "2027-01-15",
    },
    third = {
      id: "quarter-2027-3",
      name: "III четверть",
      startDate: "2027-01-18",
      endDate: "2027-03-26",
    };
  const plans = structuredClone(before.studyPlans);
  const copied = {
    ...structuredClone(plans[0]),
    id: "plan-second-quarter",
    quarterId: second.id,
    lessonKind: "lab" as const,
    assignments: plans[0].assignments.map((a, index) => ({
      ...a,
      id: `assignment-second-quarter-${index}`,
    })),
  };
  const copiedThird = {
    ...structuredClone(plans[0]),
    id: "plan-third-quarter",
    quarterId: third.id,
    assignments: plans[0].assignments.map((a, index) => ({
      ...a,
      id: `assignment-third-quarter-${index}`,
    })),
  };
  plans.push(copied, copiedThird);
  const saved = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      quarters: [...before.quarters, second, third],
      studyPlans: plans,
      revision: before.revision,
      requestId: "plan-quarter-00001",
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const state = saved.json() as StateResponse;
  assert.ok(Object.keys(state.schedule).some((key) => key === "5a:4"));
  assert.ok(Object.keys(state.schedule).some((key) => key === "5a:24"));
  assert.equal(
    state.studyPlans.find((item) => item.id === "plan-second-quarter")
      ?.lessonKind,
    "lab",
  );
  const outdated = await app.inject({
    method: "PUT",
    url: "/api/plans",
    headers,
    payload: {
      quarters: before.quarters,
      studyPlans: before.studyPlans,
      revision: before.revision,
      requestId: "plan-outdated-after-quarter",
    },
  });
  assert.equal(outdated.statusCode, 409, outdated.body);
  const scheduleSave = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: {
      schedule: state.schedule,
      revision: state.revision,
      requestId: "schedule-three-quarters",
    },
  });
  assert.equal(scheduleSave.statusCode, 200, scheduleSave.body);
});
