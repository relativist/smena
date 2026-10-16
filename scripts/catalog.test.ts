import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Catalog } from "../shared/catalog.ts";
import { buildApp } from "../server/app.ts";
import { buildSeedCatalog } from "../shared/catalog-seed.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];
const origin = "http://127.0.0.1";

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "smena-catalog-"));
  dirs.push(dir);
  return join(dir, "draft.sqlite");
}

async function start(path = dbPath()) {
  const app = await buildApp({ dbPath: path });
  apps.push(app);
  return {
    app,
    path,
    db: (app as unknown as { smenaDb: Database.Database }).smenaDb,
  };
}

async function authorize(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "catalog test password" },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
    ";",
  )[0];
  assert.ok(cookie);
  return { cookie, csrf: response.json().csrfToken as string };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "catalog test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
    ";",
  )[0];
  assert.ok(cookie);
  return { cookie, csrf: response.json().csrfToken as string };
}

function headers(auth: { cookie: string; csrf: string }) {
  return {
    cookie: auth.cookie,
    origin,
    host: "127.0.0.1",
    "x-csrf-token": auth.csrf,
  };
}

async function state(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { cookie: string },
) {
  const response = await app.inject({
    url: "/api/state",
    headers: { cookie: auth.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function saveCatalog(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { cookie: string; csrf: string },
  revision: number,
  catalog: Catalog,
  requestId: string = crypto.randomUUID(),
) {
  return app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers: headers(auth),
    payload: { catalog, revision, requestId },
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("legacy free-text assignments migrate into stable catalog refs and follow renamed entries", async () => {
  const first = await start();
  await authorize(first.app);
  first.db
    .prepare(
      "UPDATE lessons SET teacher='Ручной преподаватель',room='Ручной кабинет',teacher_ref=NULL,room_ref=NULL",
    )
    .run();
  first.db.prepare("DELETE FROM schema_migrations WHERE version>=2").run();
  // Recreate the actual v1 schema boundary, not just a missing migration marker.
  first.db
    .exec(`DROP TABLE plan_assignments; DROP TABLE study_plans; DROP TABLE quarters;
    ALTER TABLE lessons DROP COLUMN lesson_kind;
    DROP INDEX IF EXISTS lessons_teacher_slot;
    DROP INDEX IF EXISTS lessons_room_slot;
    ALTER TABLE lessons DROP COLUMN teacher_ref;
    ALTER TABLE lessons DROP COLUMN room_ref;
    ALTER TABLE lessons DROP COLUMN subgroup_ref;
    DROP TABLE catalog_group_auto_rooms;
    DROP TABLE catalog_teacher_subjects;
    DROP TABLE catalog_subjects; DROP TABLE catalog_teachers;
    DROP TABLE catalog_rooms; DROP TABLE catalog_groups; DROP TABLE catalog_subgroups;`);
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);

  const reopened = await start(first.path);
  const reopenedAuth = await login(reopened.app);
  const initial = await state(reopened.app, reopenedAuth);
  const lesson = Object.values(initial.schedule as Record<string, any[]>)
    .flatMap((days) =>
      days.flatMap((day: any) => day.slots.flatMap((slot: any[]) => slot)),
    )
    .find((entry: any) => entry.teacher === "Ручной преподаватель");
  assert.ok(lesson?.teacherId);
  assert.ok(initial.baseline.some((row: any) => row.subgroupId));
  assert.equal(
    initial.catalog.teachers.some(
      (entry: any) => entry.name === "Ручной преподаватель",
    ),
    true,
  );
  assert.equal(
    initial.catalog.rooms.some((entry: any) => entry.name === "Ручной кабинет"),
    true,
  );
  const catalog: Catalog = structuredClone(initial.catalog);
  const teacher = catalog.teachers.find(
    (entry) => entry.id === lesson.teacherId,
  )!;
  teacher.name = "Новое имя преподавателя";
  const renamed = await saveCatalog(
    reopened.app,
    reopenedAuth,
    initial.revision,
    catalog,
  );
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().revision, initial.revision + 1);
  const renamedLesson = Object.values(
    renamed.json().schedule as Record<string, any[]>,
  )
    .flatMap((days) =>
      days.flatMap((day: any) => day.slots.flatMap((slot: any[]) => slot)),
    )
    .find((entry: any) => entry.id === lesson.id);
  assert.equal(renamedLesson.teacherId, lesson.teacherId);
  assert.equal(renamedLesson.teacher, "Новое имя преподавателя");
  await reopened.app.close();
  apps.splice(apps.indexOf(reopened.app), 1);
  const restarted = await start(first.path);
  const restartedAuth = await login(restarted.app);
  const afterRestart = await state(restarted.app, restartedAuth);
  assert.equal(
    afterRestart.catalog.teachers.filter(
      (entry: any) => entry.name === "Новое имя преподавателя",
    ).length,
    1,
  );
  const persistedLesson = Object.values(
    afterRestart.schedule as Record<string, any[]>,
  )
    .flatMap((days) =>
      days.flatMap((day: any) => day.slots.flatMap((slot: any[]) => slot)),
    )
    .find((entry: any) => entry.id === lesson.id);
  assert.equal(persistedLesson.teacherId, lesson.teacherId);
  assert.equal(persistedLesson.teacher, "Новое имя преподавателя");
});

test("teacher subject links persist and archived links cannot be newly added", async () => {
  const { app } = await start();
  const auth = await authorize(app);
  const initial = await state(app, auth);
  const catalog: Catalog = structuredClone(initial.catalog);
  const teacher = catalog.teachers.find(
    (entry) => entry.id === "teacher:соколова-марина-викторовна",
  )!;
  assert.deepEqual(teacher.subjectIds, ["math"]);
  teacher.subjectIds.push("physics");
  const added = await saveCatalog(app, auth, initial.revision, catalog);
  assert.equal(added.statusCode, 200, added.body);
  const persisted = added
    .json()
    .catalog.teachers.find((entry: any) => entry.id === teacher.id);
  assert.deepEqual(persisted.subjectIds, ["math", "physics"]);

  const next: Catalog = structuredClone(added.json().catalog);
  const other = next.teachers.find((entry) => entry.id !== teacher.id)!;
  other.subjectIds.push("biology");
  const linked = await saveCatalog(app, auth, added.json().revision, next);
  assert.equal(linked.statusCode, 200, linked.body);
  const archived: Catalog = structuredClone(linked.json().catalog);
  archived.subjects.find((entry) => entry.id === "biology")!.archived = true;
  const archivedSave = await saveCatalog(
    app,
    auth,
    linked.json().revision,
    archived,
  );
  assert.equal(archivedSave.statusCode, 200, archivedSave.body);
  const invalid: Catalog = structuredClone(archivedSave.json().catalog);
  invalid.teachers
    .find((entry) => entry.id !== other.id)!
    .subjectIds.push("biology");
  assert.equal(
    (await saveCatalog(app, auth, archivedSave.json().revision, invalid))
      .statusCode,
    400,
  );
});

test("teacher group preferences and joint group limits persist and validate", async () => {
  const { app } = await start();
  const auth = await authorize(app);
  const initial = await state(app, auth);
  const catalog: Catalog = structuredClone(initial.catalog);
  const teacher = catalog.teachers.find((entry) => entry.id === "teacher:соколова-марина-викторовна")!;
  const math = catalog.subjects.find((entry) => entry.id === "math")!;
  assert.deepEqual(teacher.preferredGroupIds, []);
  assert.equal(math.maxJointGroups, 2);
  teacher.preferredGroupIds = ["5a", "5b"];
  math.maxJointGroups = 4;
  const saved = await saveCatalog(app, auth, initial.revision, catalog);
  assert.equal(saved.statusCode, 200, saved.body);
  const persisted = await state(app, auth);
  assert.deepEqual(
    persisted.catalog.teachers.find((entry: any) => entry.id === teacher.id).preferredGroupIds,
    ["5a", "5b"],
  );
  assert.equal(persisted.catalog.subjects.find((entry: any) => entry.id === "math").maxJointGroups, 4);

  for (const preferredGroupIds of [["5a", "5a"], ["missing-group"]]) {
    const invalid: Catalog = structuredClone(persisted.catalog);
    invalid.teachers.find((entry) => entry.id === teacher.id)!.preferredGroupIds = preferredGroupIds;
    assert.equal(
      (await saveCatalog(app, auth, persisted.revision, invalid)).statusCode,
      400,
    );
  }
  for (const maxJointGroups of [1, 51, 2.5]) {
    const invalid: Catalog = structuredClone(persisted.catalog);
    invalid.subjects.find((entry) => entry.id === "math")!.maxJointGroups = maxJointGroups;
    assert.equal(
      (await saveCatalog(app, auth, persisted.revision, invalid)).statusCode,
      400,
    );
  }
});

test("teacher preferred shift persists, changes, clears, and rejects invalid values atomically", async () => {
  const first = await start();
  const auth = await authorize(first.app);
  const initial = await state(first.app, auth);
  const teacherId = "teacher:соколова-марина-викторовна";
  const saveShift = async (shift: "morning" | "afternoon" | undefined) => {
    const current = await state(first.app, auth);
    const catalog: Catalog = structuredClone(current.catalog);
    const teacher = catalog.teachers.find((entry) => entry.id === teacherId)!;
    if (shift) teacher.preferredShift = shift;
    else delete teacher.preferredShift;
    return saveCatalog(first.app, auth, current.revision, catalog);
  };

  const morning = await saveShift("morning");
  assert.equal(morning.statusCode, 200, morning.body);
  assert.equal(morning.json().catalog.teachers.find((entry: any) => entry.id === teacherId).preferredShift, "morning");
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);

  const reopened = await start(first.path);
  const reopenedAuth = await login(reopened.app);
  assert.equal((await state(reopened.app, reopenedAuth)).catalog.teachers.find((entry: any) => entry.id === teacherId).preferredShift, "morning");
  const afternoon = await saveCatalog(reopened.app, reopenedAuth, (await state(reopened.app, reopenedAuth)).revision, (() => {
    const catalog: Catalog = structuredClone(initial.catalog);
    catalog.teachers.find((entry) => entry.id === teacherId)!.preferredShift = "afternoon";
    return catalog;
  })());
  assert.equal(afternoon.statusCode, 200, afternoon.body);
  assert.equal(afternoon.json().catalog.teachers.find((entry: any) => entry.id === teacherId).preferredShift, "afternoon");
  const clearCatalog: Catalog = structuredClone(afternoon.json().catalog);
  delete clearCatalog.teachers.find((entry) => entry.id === teacherId)!.preferredShift;
  const cleared = await saveCatalog(reopened.app, reopenedAuth, afternoon.json().revision, clearCatalog);
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().catalog.teachers.find((entry: any) => entry.id === teacherId).preferredShift, undefined);

  const invalid: Catalog = structuredClone(cleared.json().catalog);
  (invalid.teachers.find((entry) => entry.id === teacherId) as any).preferredShift = "night";
  const rejected = await saveCatalog(reopened.app, reopenedAuth, cleared.json().revision, invalid);
  assert.equal(rejected.statusCode, 400);
  const afterRejected = await state(reopened.app, reopenedAuth);
  assert.equal(afterRejected.revision, cleared.json().revision);
  assert.equal(afterRejected.catalog.teachers.find((entry: any) => entry.id === teacherId).preferredShift, undefined);
});

test("preferred shift migration preserves legacy teacher data", async () => {
  const first = await start();
  const auth = await authorize(first.app);
  const current = await state(first.app, auth);
  const teacherId = "teacher:соколова-марина-викторовна";
  const catalog: Catalog = structuredClone(current.catalog);
  const teacher = catalog.teachers.find((entry) => entry.id === teacherId)!;
  teacher.preferredGroupIds = ["5a"];
  teacher.unavailability = [{ id: "legacy-absence", startDate: "2026-10-01", endDate: "2026-10-02", start: 0, end: 1440, reason: "Больничный" }];
  assert.equal((await saveCatalog(first.app, auth, current.revision, catalog)).statusCode, 200);
  first.db.exec("ALTER TABLE catalog_teachers DROP COLUMN preferred_shift; DELETE FROM schema_migrations WHERE version=17");
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1);

  const reopened = await start(first.path);
  const reopenedAuth = await login(reopened.app);
  const migrated = (await state(reopened.app, reopenedAuth)).catalog.teachers.find((entry: any) => entry.id === teacherId);
  assert.ok(migrated);
  assert.deepEqual(migrated.preferredGroupIds, ["5a"]);
  assert.deepEqual(migrated.unavailability, [{ id: "legacy-absence", startDate: "2026-10-01", endDate: "2026-10-02", start: 0, end: 1440, reason: "Больничный" }]);
  assert.equal(migrated.preferredShift, undefined);
});

test("catalog saves archive without deleting lessons and creates an empty schedule for new groups", async () => {
  const { app } = await start();
  const auth = await authorize(app);
  const before = await state(app, auth);
  const catalog: Catalog = structuredClone(before.catalog);
  const group = catalog.groups.find((entry) => entry.id === "5a")!;
  group.archived = true;
  catalog.groups.push({
    id: "7a",
    name: "7А",
    students: 24,
    leaderId: null,
    roomId: null,
    autoRoomIds: ["room:214"],
    archived: false,
  });
  catalog.subgroups.push({
    id: "subgroup:7a:one",
    groupId: "7a",
    name: "7А/1",
    students: 12,
    archived: false,
  });
  const saved = await saveCatalog(app, auth, before.revision, catalog);
  assert.equal(saved.statusCode, 200, saved.body);
  const next = saved.json();
  assert.equal(
    next.catalog.groups.find((entry: any) => entry.id === "5a")?.archived,
    true,
  );
  assert.deepEqual(
    next.catalog.groups.find((entry: any) => entry.id === "7a")?.autoRoomIds,
    ["room:214"],
  );
  assert.equal(
    next.catalog.subjects.find((entry: any) => entry.id === "informatics")
      ?.roomKind,
    "informatics",
  );
  assert.equal(
    next.catalog.subjects.find((entry: any) => entry.id === "physics")
      ?.labRoomKind,
    "physics-lab",
  );
  assert.equal(
    next.catalog.rooms.find((entry: any) => entry.id === "room:комп-класс")
      ?.kind,
    "informatics",
  );
  const newWeeks = Object.entries(next.schedule)
    .filter(([key]) => key.startsWith("7a:"))
    .map(([, days]) => days as any[]);
  assert.equal(
    newWeeks.length,
    Object.keys(before.schedule).filter((key) => key.startsWith("5a:")).length,
  );
  assert.equal(newWeeks.flat().length, newWeeks.length * 7);
  assert.equal(
    newWeeks
      .flat()
      .every(
        (day) =>
          day.slots.length === 7 &&
          day.slots.every((slot: unknown[]) => slot.length === 0),
      ),
    true,
  );
  assert.equal(
    Object.values(next.schedule)
      .flatMap((days: any) => days)
      .flatMap((day: any) => day.slots.flat()).length,
    Object.values(before.schedule)
      .flatMap((days: any) => days)
      .flatMap((day: any) => day.slots.flat()).length,
  );
});

test("catalog rejects overfull subgroups, missing rows, and stale revisions", async () => {
  const { app } = await start();
  const auth = await authorize(app);
  const before = await state(app, auth);
  const tooMany: Catalog = structuredClone(before.catalog);
  const subgroup = tooMany.subgroups.find((entry) => entry.groupId === "5a")!;
  subgroup.students = 100;
  assert.equal(
    (await saveCatalog(app, auth, before.revision, tooMany)).statusCode,
    400,
  );
  const missing: Catalog = structuredClone(before.catalog);
  missing.teachers.pop();
  assert.equal(
    (await saveCatalog(app, auth, before.revision, missing)).statusCode,
    400,
  );
  const invalidReference: Catalog = structuredClone(before.catalog);
  invalidReference.groups[0].leaderId = "teacher:missing";
  assert.equal(
    (await saveCatalog(app, auth, before.revision, invalidReference))
      .statusCode,
    400,
  );
  const valid: Catalog = structuredClone(before.catalog);
  valid.groups[0].name += " обновлённый";
  assert.equal(
    (await saveCatalog(app, auth, before.revision, valid)).statusCode,
    200,
  );
  assert.equal(
    (await saveCatalog(app, auth, before.revision, valid, "stale-request-0001"))
      .statusCode,
    409,
  );
});

test("catalog inserts newly linked rooms, teachers, groups, and subgroups in dependency order", async () => {
  const { app, db } = await start();
  const auth = await authorize(app);
  const before = await state(app, auth);
  const catalog: Catalog = structuredClone(before.catalog);
  const roomId = "catalog-order:new-room";
  const teacherId = "catalog-order:new-teacher";
  const groupId = "catalog-order:new-group";
  const subgroupId = "catalog-order:new-subgroup";
  catalog.rooms.push({
    id: roomId,
    name: "401",
    archived: false,
    capacity: null,
    kind: "general",
    unavailability: [],
  });
  catalog.teachers.push({
    id: teacherId,
    name: "Новый преподаватель",
    archived: false,
    subjectIds: [],
    defaultRoomId: roomId,
    preferredGroupIds: [],
    unavailability: [],
  });
  catalog.groups.push({
    id: groupId,
    name: "10Я",
    archived: false,
    students: 20,
    leaderId: teacherId,
    roomId,
    autoRoomIds: [roomId],
  });
  catalog.subgroups.push({
    id: subgroupId,
    groupId,
    name: "1",
    students: 20,
    archived: false,
  });

  const saved = await saveCatalog(app, auth, before.revision, catalog);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().catalog.teachers.find((entry: any) => entry.id === teacherId).defaultRoomId, roomId);
  assert.equal(saved.json().catalog.groups.find((entry: any) => entry.id === groupId).leaderId, teacherId);
  assert.ok(db.prepare("SELECT 1 FROM catalog_group_auto_rooms WHERE group_id=? AND room_id=?").get(groupId, roomId));
  assert.ok(db.prepare("SELECT 1 FROM catalog_subgroups WHERE id=? AND group_id=?").get(subgroupId, groupId));

  const invalid = structuredClone(saved.json().catalog) as Catalog;
  invalid.teachers.find((entry) => entry.id === teacherId)!.defaultRoomId = "catalog-order:missing-room";
  const rejected = await saveCatalog(app, auth, saved.json().revision, invalid);
  assert.equal(rejected.statusCode, 400);
  const afterRejected = await state(app, auth);
  assert.equal(afterRejected.revision, saved.json().revision);
  assert.equal(afterRejected.catalog.teachers.find((entry: any) => entry.id === teacherId).defaultRoomId, roomId);
});

test("archived teachers keep current lessons but cannot be assigned to a new one", async () => {
  const { app } = await start();
  const auth = await authorize(app);
  const before = await state(app, auth);
  const catalog: Catalog = structuredClone(before.catalog);
  const teacher =
    catalog.teachers.find(
      (entry) => entry.id === "teacher:соколова-марина-викторовна",
    ) ?? catalog.teachers[0];
  teacher.archived = true;
  const saved = await saveCatalog(app, auth, before.revision, catalog);
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json();
  const schedule = structuredClone(after.schedule);
  const targetDays = schedule["6a:0"] as any[];
  const free = targetDays
    .flatMap((day: any, dayIndex: number) =>
      day.slots.map((slot: any[], slotIndex: number) => ({
        day,
        dayIndex,
        slot,
        slotIndex,
      })),
    )
    .find((entry: any) => entry.slot.length === 0 && !entry.day.holiday);
  assert.ok(free);
  free.slot.push({
    id: "new-archived-teacher-lesson",
    subjectId: "math",
    teacherId: teacher.id,
    teacher: teacher.name,
    roomId: "room:214",
    room: "214",
  });
  const response = await app.inject({
    method: "PUT",
    url: "/api/state",
    headers: headers(auth),
    payload: {
      schedule,
      revision: after.revision,
      requestId: "archived-teacher-0001",
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  const retained = await state(app, auth);
  assert.ok(
    Object.values(retained.schedule as Record<string, any[]>)
      .flatMap((days) =>
        days.flatMap((day: any) => day.slots.flatMap((slot: any[]) => slot)),
      )
      .some((lesson: any) => lesson.teacherId === teacher.id),
  );
});

test("seed IDs are deterministic and include the shared computer room", () => {
  assert.deepEqual(buildSeedCatalog(), buildSeedCatalog());
  const seed = buildSeedCatalog();
  assert.ok(seed.rooms.some((room) => room.name === "Комп. класс"));
  assert.equal(
    new Set(seed.teachers.map((entry) => entry.id)).size,
    seed.teachers.length,
  );
  assert.equal(
    new Set(seed.rooms.map((entry) => entry.id)).size,
    seed.rooms.length,
  );
  assert.ok(seed.subgroups.some((entry) => entry.groupId === "5b"));
});
