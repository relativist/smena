import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "smena-room-suitability-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "draft.sqlite") });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "room suitability test password" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  assert.ok(cookie);
  const headers = {
    cookie,
    origin,
    host: "127.0.0.1",
    "x-csrf-token": response.json().csrfToken as string,
  };
  return { app, headers, snapshot: await readState(app, headers) };
}

async function readState(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
  const response = await app.inject({ url: "/api/state", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveCatalog(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, snapshot: StateResponse, change: (catalog: StateResponse["catalog"]) => void) {
  const catalog = structuredClone(snapshot.catalog);
  change(catalog);
  const response = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers,
    payload: { catalog, revision: snapshot.revision, requestId: `room-catalog-${crypto.randomUUID()}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as StateResponse;
}

async function saveSchedule(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, snapshot: StateResponse, schedule: StateResponse["schedule"]) {
  return app.inject({
    method: "PUT",
    url: "/api/state",
    headers,
    payload: { schedule, revision: snapshot.revision, requestId: `room-schedule-${crypto.randomUUID()}` },
  });
}

function findLesson(snapshot: StateResponse, groupId: string, subjectId: string, subgroup = false) {
  for (const [dayIndex, day] of snapshot.schedule[`${groupId}:0`].entries())
    for (const [slotIndex, slot] of day.slots.entries())
      for (const lesson of slot)
        if (lesson.subjectId === subjectId && Boolean(lesson.subgroupId || lesson.subgroup) === subgroup)
          return { dayIndex, slotIndex, lesson };
  throw new Error(`No ${subjectId} lesson for ${groupId} (subgroup=${subgroup})`);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("new room type and full-group capacity violations are rejected, while unknown capacity is allowed", async () => {
  const { app, headers, snapshot: initial } = await setup();
  const configured = await saveCatalog(app, headers, initial, (catalog) => {
    catalog.rooms.push(
      { id: "room:suitability-wrong-kind", name: "Неподходящий тип", capacity: null, kind: "gym", archived: false },
      { id: "room:suitability-unknown-capacity", name: "Без заданной вместимости", capacity: null, kind: "general", archived: false },
    );
  });
  const { dayIndex, slotIndex } = findLesson(configured, "5a", "math");
  const wrongType = structuredClone(configured.schedule);
  wrongType["5a:0"][dayIndex]!.slots[slotIndex]![0]!.roomId = "room:suitability-wrong-kind";
  const rejectedType = await saveSchedule(app, headers, configured, wrongType);
  assert.equal(rejectedType.statusCode, 400, rejectedType.body);
  assert.match(rejectedType.json().error, /тип/);
  let current = await readState(app, headers);
  assert.equal(current.revision, configured.revision);
  assert.deepEqual(current.schedule, configured.schedule, "failed type check must be atomic");

  const unknownCapacity = structuredClone(current.schedule);
  unknownCapacity["5a:0"][dayIndex]!.slots[slotIndex]![0]!.roomId = "room:suitability-unknown-capacity";
  const acceptedUnknown = await saveSchedule(app, headers, current, unknownCapacity);
  assert.equal(acceptedUnknown.statusCode, 200, acceptedUnknown.body);
  current = await readState(app, headers);

  const mathGroup = current.catalog.groups.find((group) => group.id === "5a")!;
  const capacityRoomId = "room:suitability-small";
  const withCapacityRoom = await saveCatalog(app, headers, current, (catalog) => {
    catalog.rooms.push({ id: capacityRoomId, name: "Маленький кабинет", capacity: 1, kind: "general", archived: false });
  });
  const fullGroup = findLesson(withCapacityRoom, "5a", "math");
  assert.ok(mathGroup.students > 1);
  const tooSmall = structuredClone(withCapacityRoom.schedule);
  tooSmall["5a:0"][fullGroup.dayIndex]!.slots[fullGroup.slotIndex]![0]!.roomId = capacityRoomId;
  const rejectedCapacity = await saveSchedule(app, headers, withCapacityRoom, tooSmall);
  assert.equal(rejectedCapacity.statusCode, 400, rejectedCapacity.body);
  assert.match(rejectedCapacity.json().error, /человек/);
  const unchanged = await readState(app, headers);
  assert.equal(unchanged.revision, withCapacityRoom.revision);
  assert.deepEqual(unchanged.schedule, withCapacityRoom.schedule, "failed capacity check must be atomic");
});

test("subgroup capacity is counted by subgroup and unchanged legacy room mismatches remain editable", async () => {
  const { app, headers, snapshot: initial } = await setup();
  const subgroup = initial.catalog.subgroups.find((entry) => entry.groupId === "5a")!;
  const group = initial.catalog.groups.find((entry) => entry.id === "5a")!;
  assert.ok(group.students > subgroup.students);
  const roomId = "room:suitability-full-group-capacity";
  const subgroupRoomId = "room:suitability-subgroup-capacity";
  const configured = await saveCatalog(app, headers, initial, (catalog) => {
    catalog.rooms.push(
      { id: roomId, name: "Маленький обычный кабинет", capacity: subgroup.students, kind: "general", archived: false },
      { id: subgroupRoomId, name: "Кабинет на подгруппу", capacity: subgroup.students, kind: "informatics", archived: false },
    );
  });
  const partLesson = findLesson(configured, "5a", "informatics", true);
  const partSchedule = structuredClone(configured.schedule);
  const part = partSchedule["5a:0"][partLesson.dayIndex]!.slots[partLesson.slotIndex]!.find((lesson) => lesson.subjectId === "informatics" && lesson.subgroupId === subgroup.id)!;
  part.roomId = subgroupRoomId;
  const acceptedSubgroup = await saveSchedule(app, headers, configured, partSchedule);
  assert.equal(acceptedSubgroup.statusCode, 200, acceptedSubgroup.body);
  let current = await readState(app, headers);

  const fullLesson = findLesson(current, "5a", "math");
  const fullSchedule = structuredClone(current.schedule);
  fullSchedule["5a:0"][fullLesson.dayIndex]!.slots[fullLesson.slotIndex]![0]!.roomId = roomId;
  const rejectedFull = await saveSchedule(app, headers, current, fullSchedule);
  assert.equal(rejectedFull.statusCode, 400, rejectedFull.body);
  assert.match(rejectedFull.json().error, /участников/);

  current = await readState(app, headers);
  const legacyRoom = current.catalog.rooms.find((entry) => entry.id === subgroupRoomId)!;
  const legacyCatalog = await saveCatalog(app, headers, current, (catalog) => {
    const room = catalog.rooms.find((entry) => entry.id === legacyRoom.id)!;
    room.kind = "general";
    room.capacity = 1;
  });
  const noteEdit = structuredClone(legacyCatalog.schedule);
  noteEdit["5a:0"][partLesson.dayIndex]!.slots[partLesson.slotIndex]!.find((lesson) => lesson.id === part.id)!.note = "Редактирование старого расписания";
  const acceptedLegacyEdit = await saveSchedule(app, headers, legacyCatalog, noteEdit);
  assert.equal(acceptedLegacyEdit.statusCode, 200, acceptedLegacyEdit.body);
});

test("lab room type inherits the subject type unless a lab-specific type is configured", async () => {
  const { snapshot } = await setup();
  const catalog = structuredClone(snapshot.catalog);
  const physics = catalog.subjects.find((subject) => subject.id === "physics")!;
  catalog.rooms.push(
    { id: "room:suitability-lab-general", name: "Обычный кабинет", capacity: null, kind: "general", archived: false },
    { id: "room:suitability-lab-informatics", name: "Компьютерный класс", capacity: null, kind: "informatics", archived: false },
    { id: "room:suitability-lab-physics", name: "Лаборатория физики", capacity: null, kind: "physics-lab", archived: false },
  );
  physics.roomKind = "informatics";
  physics.labRoomKind = null;
  const labInput = { subjectId: "physics", lessonKind: "lab" as const, groupId: "5a" };
  assert.match(roomSuitabilityReason(catalog, { ...labInput, roomId: "room:suitability-lab-general" })!, /требуется «Информатика»/);
  assert.equal(roomSuitabilityReason(catalog, { ...labInput, roomId: "room:suitability-lab-informatics" }), null);

  physics.roomKind = "general";
  physics.labRoomKind = "physics-lab";
  assert.match(roomSuitabilityReason(catalog, { ...labInput, roomId: "room:suitability-lab-general" })!, /требуется «Лаборатория физики»/);
  assert.equal(roomSuitabilityReason(catalog, { ...labInput, roomId: "room:suitability-lab-physics" }), null);
});

test("API rejects a lab in the wrong lab-specific room and then applies inherited subject type", async () => {
  const { app, headers, snapshot: initial } = await setup();
  let current = await saveCatalog(app, headers, initial, (catalog) => {
    const physics = catalog.subjects.find((subject) => subject.id === "physics")!;
    physics.roomKind = "general";
    physics.labRoomKind = "chemistry-lab";
    catalog.rooms.push(
      { id: "room:api-lab-general", name: "Обычный кабинет для проверки", capacity: null, kind: "general", archived: false },
      { id: "room:api-lab-chemistry", name: "Лаборатория для проверки", capacity: null, kind: "chemistry-lab", archived: false },
      { id: "room:api-lab-informatics", name: "Класс для проверки", capacity: null, kind: "informatics", archived: false },
    );
  });
  const curriculum = structuredClone(current.curricula!.find((entry) => entry.groupIds.includes("5a"))!);
  curriculum.rows.push({ id: "room-suitability-physics-lab-row", subjectId: "physics", lessonKind: "lab", mode: "whole", hours: 1 });
  const curriculumSave = await app.inject({
    method: "PUT",
    url: "/api/curricula",
    headers,
    payload: { curricula: current.curricula!.map((entry) => entry.id === curriculum.id ? curriculum : entry), revision: current.revision, requestId: `room-lab-curriculum-${crypto.randomUUID()}` },
  });
  assert.equal(curriculumSave.statusCode, 200, curriculumSave.body);
  current = curriculumSave.json() as StateResponse;
  const physics = findLesson(current, "5a", "physics");

  const labAttempt = structuredClone(current.schedule);
  const lesson = labAttempt["5a:0"][physics.dayIndex]!.slots[physics.slotIndex]!.find((entry) => entry.id === physics.lesson.id)!;
  lesson.lessonKind = "lab";
  lesson.roomId = "room:api-lab-general";
  const wrongSpecific = await saveSchedule(app, headers, current, labAttempt);
  assert.equal(wrongSpecific.statusCode, 400, wrongSpecific.body);
  assert.match(wrongSpecific.json().error, /требуется «Лаборатория химии»/);
  let unchanged = await readState(app, headers);
  assert.equal(unchanged.revision, current.revision);
  assert.deepEqual(unchanged.schedule, current.schedule);

  labAttempt["5a:0"][physics.dayIndex]!.slots[physics.slotIndex]!.find((entry) => entry.id === physics.lesson.id)!.roomId = "room:api-lab-chemistry";
  const acceptedSpecific = await saveSchedule(app, headers, current, labAttempt);
  assert.equal(acceptedSpecific.statusCode, 200, acceptedSpecific.body);
  current = await readState(app, headers);

  const inheritedCatalog = await saveCatalog(app, headers, current, (catalog) => {
    const subject = catalog.subjects.find((entry) => entry.id === "physics")!;
    subject.roomKind = "informatics";
    subject.labRoomKind = null;
  });
  const wrongInheritedSchedule = structuredClone(inheritedCatalog.schedule);
  wrongInheritedSchedule["5a:0"][physics.dayIndex]!.slots[physics.slotIndex]!.find((entry) => entry.id === physics.lesson.id)!.roomId = "room:api-lab-general";
  const wrongInherited = await saveSchedule(app, headers, inheritedCatalog, wrongInheritedSchedule);
  assert.equal(wrongInherited.statusCode, 400, wrongInherited.body);
  assert.match(wrongInherited.json().error, /требуется «Информатика»/);

  const validInheritedSchedule = structuredClone(inheritedCatalog.schedule);
  validInheritedSchedule["5a:0"][physics.dayIndex]!.slots[physics.slotIndex]!.find((entry) => entry.id === physics.lesson.id)!.roomId = "room:api-lab-informatics";
  const acceptedInherited = await saveSchedule(app, headers, inheritedCatalog, validInheritedSchedule);
  assert.equal(acceptedInherited.statusCode, 200, acceptedInherited.body);
  unchanged = await readState(app, headers);
  assert.equal(unchanged.schedule["5a:0"][physics.dayIndex]!.slots[physics.slotIndex]!.find((entry) => entry.id === physics.lesson.id)!.roomId, "room:api-lab-informatics");
});

test("a new multi-group event cannot exceed the room capacity", async () => {
  const { app, headers, snapshot: initial } = await setup();
  const configured = await saveCatalog(app, headers, initial, (catalog) => {
    catalog.rooms.push({ id: "room:suitability-event-capacity", name: "Малый зал", capacity: 50, kind: "assembly", archived: false });
  });
  const schedule = structuredClone(configured.schedule);
  for (const groupId of ["5a", "6a"]) {
    const day = schedule[`${groupId}:0`][4]!;
    day.times[5] = { ...day.times[5]!, start: Math.max(1000, day.times[5]!.start) };
    day.times[6] = { ...day.times[6]!, start: 1250 };
    day.breaks = day.times.slice(0, -1).map((time, index) => day.times[index + 1]!.start - time.start - time.duration);
    day.slots[6] = [{
      id: `room-capacity-event-${groupId}`,
      subjectId: "event",
      event: "Общее мероприятие",
      roomId: "room:suitability-event-capacity",
      jointId: "room-capacity-event-joint",
    }];
  }
  const rejected = await saveSchedule(app, headers, configured, schedule);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json().error, /участников: 58/);
  const after = await readState(app, headers);
  assert.equal(after.revision, configured.revision);
  assert.deepEqual(after.schedule, configured.schedule, "failed event capacity check must be atomic");
});
