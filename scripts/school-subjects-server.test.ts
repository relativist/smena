import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import { buildSeedCatalog } from "../shared/catalog-seed.ts";
import type { Catalog } from "../shared/catalog.ts";
import { addMissingSchoolSubjectPresets, schoolSubjectPresets } from "../shared/schoolSubjects.ts";
import type { StateResponse } from "../server/contracts.ts";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const dirs: string[] = [];
const origin = "http://127.0.0.1";

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "smena-school-subjects-"));
  dirs.push(dir);
  return join(dir, "draft.sqlite");
}

function database(app: Awaited<ReturnType<typeof buildApp>>) {
  return (app as unknown as { smenaDb: Database.Database }).smenaDb;
}

async function authorize(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "school subject test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  return { cookie, csrf: response.json().csrfToken as string };
}

function headers(auth: { cookie: string; csrf: string }) {
  return { cookie: auth.cookie, origin, host: "127.0.0.1", "x-csrf-token": auth.csrf };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, auth: { cookie: string }) {
  const response = await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveCatalog(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { cookie: string; csrf: string },
  revision: number,
  catalog: Catalog,
  requestId: string,
) {
  return app.inject({
    method: "PUT", url: "/api/catalog", headers: headers(auth),
    payload: { catalog, revision, requestId },
  });
}

function addPreset(catalog: Catalog, presetId: string): Catalog {
  const subjects = addMissingSchoolSubjectPresets(catalog.subjects);
  assert.ok(subjects.some((subject) => subject.id === presetId), `expected ${presetId} in the automatically filled catalog`);
  return { ...catalog, subjects };
}

function addCustomSubject(catalog: Catalog): Catalog {
  return {
    ...catalog,
    subjects: [...catalog.subjects, {
      id: "custom:concurrent-subject", name: "Параллельный предмет", shortName: "Паралл.",
      color: "blue", roomKind: null, labRoomKind: null, archived: false,
    }],
  };
}

async function startLegacyCatalog(): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; auth: { cookie: string; csrf: string } }> {
  const app = await buildApp({ dbPath: dbPath() });
  apps.push(app);
  database(app).prepare("DELETE FROM catalog_subjects WHERE id='school:geography'").run();
  return { app, auth: await authorize(app) };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("fresh database receives presets once and existing subject edits survive reopen", async () => {
  const path = dbPath();
  const fresh = await buildApp({ dbPath: path });
  apps.push(fresh);
  const db = database(fresh);

  const seededSubjects = db.prepare(
    "SELECT id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived FROM catalog_subjects ORDER BY id",
  ).all() as Array<Record<string, unknown>>;
  assert.equal(seededSubjects.length, 25);
  assert.deepEqual(
    buildSeedCatalog().subjects.map((subject) => subject.id).sort(),
    ["english", "history", "informatics", "literature", "math", "pe", "physics", "russian", "biology"].sort(),
  );
  for (const id of buildSeedCatalog().subjects.map((subject) => subject.id))
    assert.ok(seededSubjects.some((subject) => subject.id === id));

  const demoLessons = db.prepare(
    "SELECT id,subject_id,teacher_ref,room_ref,subgroup_ref FROM lessons ORDER BY id",
  ).all();
  const demoPlans = db.prepare(
    "SELECT id,quarter_id,group_id,subject_id,lesson_kind FROM study_plans ORDER BY id",
  ).all();
  const demoTeacherSubjects = db.prepare(
    "SELECT teacher_id,subject_id FROM catalog_teacher_subjects ORDER BY teacher_id,subject_id",
  ).all();
  assert.ok(demoLessons.length > 0);
  assert.ok(demoPlans.length > 0);
  assert.equal(demoTeacherSubjects.length, buildSeedCatalog().teachers.reduce((count, teacher) => count + teacher.subjectIds.length, 0));

  await fresh.close();
  apps.splice(apps.indexOf(fresh), 1);

  const editable = new Database(path);
  editable.pragma("foreign_keys = ON");
  editable.prepare("DELETE FROM catalog_subjects WHERE id=?").run("school:geography");
  editable.prepare("UPDATE catalog_subjects SET archived=1 WHERE id=?").run("school:chemistry");
  editable.prepare("UPDATE catalog_subjects SET name=?,short_name=? WHERE id=?").run("Переименованный предмет", "Переим.", "school:technology");
  editable.prepare(
    "INSERT INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("custom:subject", "Свой предмет", "Свой", "blue", null, null, "[]", 0, 2, 0);
  const beforeReopen = editable.prepare(
    "SELECT id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived FROM catalog_subjects ORDER BY id",
  ).all();
  editable.close();

  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  const reopenedDb = database(reopened);
  assert.deepEqual(reopenedDb.prepare(
    "SELECT id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived FROM catalog_subjects ORDER BY id",
  ).all(), beforeReopen);
  assert.equal(reopenedDb.prepare("SELECT 1 FROM catalog_subjects WHERE id='school:geography'").get(), undefined);
  assert.deepEqual(reopenedDb.prepare(
    "SELECT id,subject_id,teacher_ref,room_ref,subgroup_ref FROM lessons ORDER BY id",
  ).all(), demoLessons);
  assert.deepEqual(reopenedDb.prepare(
    "SELECT id,quarter_id,group_id,subject_id,lesson_kind FROM study_plans ORDER BY id",
  ).all(), demoPlans);
  assert.deepEqual(reopenedDb.prepare(
    "SELECT teacher_id,subject_id FROM catalog_teacher_subjects ORDER BY teacher_id,subject_id",
  ).all(), demoTeacherSubjects);

  assert.equal(schoolSubjectPresets.length, 25);
});

test("version 20 fills legacy presets once, preserves matches and invalidates stale catalog saves", async () => {
  const path = dbPath();
  const originalApp = await buildApp({ dbPath: path });
  apps.push(originalApp);
  const auth = await authorize(originalApp);
  const before = await state(originalApp, auth);
  const originalDb = database(originalApp);
  const lessonsBefore = originalDb.prepare("SELECT * FROM lessons ORDER BY id").all();
  const plansBefore = originalDb.prepare("SELECT * FROM study_plans ORDER BY id").all();
  const teachersBefore = originalDb.prepare("SELECT * FROM catalog_teacher_subjects ORDER BY teacher_id,subject_id").all();
  await originalApp.close();
  apps.splice(apps.indexOf(originalApp), 1);

  const legacy = new Database(path);
  legacy.pragma("foreign_keys = ON");
  legacy.prepare("DELETE FROM schema_migrations WHERE version=20").run();
  legacy.prepare("DELETE FROM catalog_subjects WHERE id IN ('school:geography','school:algebra','school:geometry','school:chinese')").run();
  legacy.prepare("UPDATE catalog_subjects SET name='Переименованный архивный предмет',short_name='Старый',archived=1 WHERE id='school:safety'").run();
  legacy.prepare(
    "INSERT INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("custom:chinese-alias", "Иностранный факультатив", "中文", "blue", null, null, "[]", 0, 2, 0);
  legacy.prepare(
    "INSERT INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("custom:combined-math", "Алгебра и геометрия", "Объединенная математика", "blue", null, null, "[]", 0, 2, 0);
  legacy.close();

  const migrated = await buildApp({ dbPath: path });
  apps.push(migrated);
  const db = database(migrated);
  const after = await state(migrated, auth);
  assert.ok(after.catalog.subjects.some((subject) => subject.id === "school:geography"));
  assert.ok(after.catalog.subjects.some((subject) => subject.id === "school:algebra"));
  assert.ok(after.catalog.subjects.some((subject) => subject.id === "school:geometry"));
  assert.equal(after.catalog.subjects.filter((subject) => subject.id === "school:chinese").length, 0);
  assert.equal(after.catalog.subjects.find((subject) => subject.id === "school:safety")?.name, "Переименованный архивный предмет");
  assert.equal(after.catalog.subjects.find((subject) => subject.id === "school:safety")?.archived, true);
  assert.ok(after.catalog.subjects.some((subject) => subject.id === "custom:chinese-alias"));
  assert.ok(after.catalog.subjects.some((subject) => subject.id === "custom:combined-math"));
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(db.prepare("SELECT * FROM lessons ORDER BY id").all(), lessonsBefore);
  assert.deepEqual(db.prepare("SELECT * FROM study_plans ORDER BY id").all(), plansBefore);
  assert.deepEqual(db.prepare("SELECT * FROM catalog_teacher_subjects ORDER BY teacher_id,subject_id").all(), teachersBefore);

  const stale = await saveCatalog(migrated, auth, before.revision, structuredClone(before.catalog), "legacy-stale-catalog-0001");
  assert.equal(stale.statusCode, 409, stale.body);

  const beforeSecondOpen = db.prepare("SELECT * FROM catalog_subjects ORDER BY id").all();
  await migrated.close();
  apps.splice(apps.indexOf(migrated), 1);
  const reopened = await buildApp({ dbPath: path });
  apps.push(reopened);
  assert.deepEqual(database(reopened).prepare("SELECT * FROM catalog_subjects ORDER BY id").all(), beforeSecondOpen);
});

test("stale preset save conflicts before missing-row validation and preserves the concurrent catalog", async () => {
  const { app, auth } = await startLegacyCatalog();
  const initial = await state(app, auth);
  const staleCatalog = addPreset(structuredClone(initial.catalog), "school:geography");
  assert.ok(staleCatalog.subjects.some((subject) => subject.id === "school:geography"));

  const concurrentCatalog = addCustomSubject(structuredClone(initial.catalog));
  const concurrentSave = await saveCatalog(app, auth, initial.revision, concurrentCatalog, "concurrent-add-0001");
  assert.equal(concurrentSave.statusCode, 200, concurrentSave.body);
  const concurrentState = concurrentSave.json() as StateResponse;

  const staleSave = await saveCatalog(app, auth, initial.revision, staleCatalog, "stale-preset-add-0001");
  assert.equal(staleSave.statusCode, 409, staleSave.body);
  const afterStale = await state(app, auth);
  assert.equal(afterStale.revision, concurrentState.revision);
  assert.deepEqual(afterStale.catalog, concurrentState.catalog);
  assert.ok(!afterStale.catalog.subjects.some((subject) => subject.id === "school:geography"));
  assert.ok(afterStale.catalog.subjects.some((subject) => subject.id === "custom:concurrent-subject"));
});

test("exact catalog replay returns current state after later additions without revision bump", async () => {
  const { app, auth } = await startLegacyCatalog();
  const initial = await state(app, auth);
  const presetCatalog = addPreset(structuredClone(initial.catalog), "school:geography");
  const requestId = "preset-add-replay-0001";
  const firstSave = await saveCatalog(app, auth, initial.revision, presetCatalog, requestId);
  assert.equal(firstSave.statusCode, 200, firstSave.body);
  const firstState = firstSave.json() as StateResponse;

  const laterCatalog = addCustomSubject(structuredClone(firstState.catalog));
  const laterSave = await saveCatalog(app, auth, firstState.revision, laterCatalog, "later-add-subject-0001");
  assert.equal(laterSave.statusCode, 200, laterSave.body);
  const current = laterSave.json() as StateResponse;

  const replay = await saveCatalog(app, auth, initial.revision, presetCatalog, requestId);
  assert.equal(replay.statusCode, 200, replay.body);
  const replayState = replay.json() as StateResponse;
  assert.equal(replayState.revision, current.revision);
  assert.deepEqual(replayState.catalog, current.catalog);

  const altered = structuredClone(presetCatalog);
  altered.subjects.find((subject) => subject.id === "school:geography")!.name = "Другое имя";
  const alteredReplay = await saveCatalog(app, auth, initial.revision, altered, requestId);
  assert.equal(alteredReplay.statusCode, 409, alteredReplay.body);
  const afterAlteredReplay = await state(app, auth);
  assert.equal(afterAlteredReplay.revision, current.revision);
  assert.deepEqual(afterAlteredReplay.catalog, current.catalog);
});
