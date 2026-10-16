import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";
const mathTeacherId = "teacher:соколова-марина-викторовна";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "smena-joint-"));
  roots.push(dir);
  const app = await buildApp({ dbPath: join(dir, "draft.sqlite") });
  apps.push(app);
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin, host: "127.0.0.1" },
    payload: { username: "admin", password: "joint test password" },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const setCookie = setup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  assert.ok(cookie);
  return { app, auth: { cookie, csrf: setup.json().csrfToken as string } };
}

function headers(auth: { cookie: string; csrf: string }) {
  return {
    cookie: auth.cookie,
    origin,
    host: "127.0.0.1",
    "x-csrf-token": auth.csrf,
  };
}

async function state(app: Awaited<ReturnType<typeof buildApp>>, auth: { cookie: string }) {
  const response = await app.inject({ url: "/api/state", headers: { cookie: auth.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function configureRoom(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { cookie: string; csrf: string },
  snapshot: any,
  capacity: number | null,
  jointGroupSets?: string[][],
  maxJointGroups?: number,
  kind = "general",
) {
  const catalog = structuredClone(snapshot.catalog);
  if (jointGroupSets) catalog.subjects.find((subject: any) => subject.id === "math").jointGroupSets = jointGroupSets;
  if (maxJointGroups !== undefined) catalog.subjects.find((subject: any) => subject.id === "math").maxJointGroups = maxJointGroups;
  const room = {
    id: "room:joint-test",
    name: "Кабинет совместных занятий",
    capacity,
    kind,
    archived: false,
  };
  const existingRoom = catalog.rooms.find((entry: any) => entry.id === room.id);
  if (existingRoom) Object.assign(existingRoom, room);
  else catalog.rooms.push(room);
  const response = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers: headers(auth),
    payload: { catalog, revision: snapshot.revision, requestId: `catalog-${crypto.randomUUID()}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

function scheduleWithJoint(snapshot: any, groupIds: string[], lesson: Record<string, unknown>) {
  const schedule = structuredClone(snapshot.schedule);
  for (const groupId of groupIds) {
    assert.ok(schedule[`${groupId}:0`], `missing schedule for ${groupId}; keys=${Object.keys(schedule).join(",")}`);
    const day = schedule[`${groupId}:0`][4];
    // Align the two empty final slots while keeping every lesson in place.
    day.times[5] = { ...day.times[5], start: Math.max(1000, day.times[5].start) };
    day.times[6] = { ...day.times[6], start: 1250 };
    day.breaks = day.times.slice(0, -1).map((time: any, index: number) =>
      day.times[index + 1].start - time.start - time.duration,
    );
    day.slots[6] = [];
    day.slots[6].push({ ...lesson, id: `${String(lesson.jointId)}-${groupId}` });
  }
  return schedule;
}

async function saveSchedule(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { cookie: string; csrf: string },
  snapshot: any,
  schedule: any,
) {
  return app.inject({
    method: "PUT",
    url: "/api/state",
    headers: headers(auth),
    payload: { schedule, revision: snapshot.revision, requestId: `schedule-${crypto.randomUUID()}` },
  });
}

function regularJoint() {
  return {
    subjectId: "math",
    lessonKind: "regular",
    teacherId: mathTeacherId,
    roomId: "room:joint-test",
    jointId: "math-cohort-5a-5b",
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("regular joint mirrors persist, then a cleared participant can be edited as a singleton", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  let configured = await configureRoom(app, auth, initial, 60, [["5a", "5b"]]);
  const joint = regularJoint();
  let schedule = scheduleWithJoint(configured, ["5a", "5b"], joint);
  let saved = await saveSchedule(app, auth, configured, schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  configured = await state(app, auth);
  assert.equal(configured.schedule["5a:0"][4].slots[6][0].jointId, joint.jointId);
  assert.equal(configured.schedule["5b:0"][4].slots[6][0].jointId, joint.jointId);

  schedule = structuredClone(configured.schedule);
  schedule["5b:0"][4].slots[6] = [];
  saved = await saveSchedule(app, auth, configured, schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  configured = await state(app, auth);

  schedule = structuredClone(configured.schedule);
  schedule["5a:0"][4].slots[6][0].note = "Уточнённая тема";
  saved = await saveSchedule(app, auth, configured, schedule);
  assert.equal(saved.statusCode, 200, saved.body);
  configured = await state(app, auth);
  assert.equal(configured.schedule["5a:0"][4].slots[6][0].note, "Уточнённая тема");
});

test("regular joint rejects a wrong cohort and aggregate room overflow", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  let configured = await configureRoom(app, auth, initial, 60, [["5a", "6a"]]);
  let schedule = scheduleWithJoint(configured, ["5a", "5b"], regularJoint());
  let response = await saveSchedule(app, auth, configured, schedule);
  assert.equal(response.statusCode, 400);

  configured = await configureRoom(app, auth, configured, 40, [["5a", "5b"]]);
  schedule = scheduleWithJoint(configured, ["5a", "5b"], regularJoint());
  response = await saveSchedule(app, auth, configured, schedule);
  assert.equal(response.statusCode, 400);
});

test("single-group and multi-group events are valid, with aggregate room capacity enforced", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  let configured = await configureRoom(app, auth, initial, 60);
  const event = {
    subjectId: "event",
    event: "Родительское собрание",
    roomId: "room:joint-test",
    jointId: "event-assembly",
  };
  let response = await saveSchedule(
    app,
    auth,
    configured,
    scheduleWithJoint(configured, ["5a"], event),
  );
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);
  assert.equal(configured.schedule["5a:0"][4].slots[6][0].event, "Родительское собрание");

  response = await saveSchedule(
    app,
    auth,
    configured,
    scheduleWithJoint(configured, ["5a", "6a"], event),
  );
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);

  configured = await configureRoom(app, auth, configured, 50);
  const schedule = scheduleWithJoint(configured, ["5a", "6a"], event);
  response = await saveSchedule(app, auth, configured, schedule);
  assert.equal(response.statusCode, 200, "existing overflow is preserved without worsening");
  configured = await state(app, auth);
  response = await saveSchedule(app, auth, configured,
    scheduleWithJoint(configured, ["5a", "6a"], { ...event, jointId: "new-event-assembly" }));
  assert.equal(response.statusCode, 400, "a new event cannot inherit another event's old overflow");
});

test("same-grade PE permits joint groups while rejecting a different grade", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  const configured = await configureRoom(app, auth, initial, 100, undefined, undefined, "gym");
  const pe = configured.catalog.subjects.find((subject: any) => subject.id === "pe");
  assert.equal(pe.jointSameGrade, true);
  const teacherId = configured.catalog.teachers.find((teacher: any) => teacher.subjectIds.includes("pe")).id;
  const lesson = {
    subjectId: "pe",
    lessonKind: "regular",
    teacherId,
    roomId: "room:joint-test",
    jointId: "pe-grade-5",
  };
  let response = await saveSchedule(
    app,
    auth,
    configured,
    scheduleWithJoint(configured, ["5a", "5b"], lesson),
  );
  assert.equal(response.statusCode, 200, response.body);

  response = await saveSchedule(
    app,
    auth,
    configured,
    scheduleWithJoint(configured, ["5a", "6a"], { ...lesson, jointId: "pe-cross-grade" }),
  );
  assert.equal(response.statusCode, 409, "the first successful save advanced the revision");
  const current = await state(app, auth);
  response = await saveSchedule(
    app,
    auth,
    current,
    scheduleWithJoint(current, ["5a", "6a"], { ...lesson, jointId: "pe-cross-grade" }),
  );
  assert.equal(response.statusCode, 400);
});

test("lowering a joint limit preserves unchanged legacy joints and caps changed participant sets", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  let configured = await configureRoom(app, auth, initial, 100, [["5a", "5b", "6a"]], 3);
  const lesson = regularJoint();
  const threeGroupJoint = scheduleWithJoint(configured, ["5a", "5b", "6a"], lesson);
  let response = await saveSchedule(app, auth, configured, threeGroupJoint);
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);

  const catalog = structuredClone(configured.catalog);
  catalog.subjects.find((subject: any) => subject.id === "math").maxJointGroups = 2;
  response = await app.inject({
    method: "PUT",
    url: "/api/catalog",
    headers: headers(auth),
    payload: { catalog, revision: configured.revision, requestId: `catalog-${crypto.randomUUID()}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);

  const unchanged = structuredClone(configured.schedule);
  unchanged["5a:0"][4].slots[0][0].note = "Дополнение";
  response = await saveSchedule(app, auth, configured, unchanged);
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);

  const reduced = structuredClone(configured.schedule);
  reduced["6a:0"][4].slots[6] = [];
  response = await saveSchedule(app, auth, configured, reduced);
  assert.equal(response.statusCode, 200, response.body);
  configured = await state(app, auth);

  const overLimit = structuredClone(configured.schedule);
  overLimit["6a:0"][4].slots[6].push({ ...lesson, id: `${lesson.jointId}-6a` });
  response = await saveSchedule(app, auth, configured, overLimit);
  assert.equal(response.statusCode, 400, response.body);
});

test("a room conflict with an unlinked third lesson is still rejected", async () => {
  const { app, auth } = await start();
  const initial = await state(app, auth);
  const configured = await configureRoom(app, auth, initial, 100, [["5a", "5b"]]);
  const schedule = scheduleWithJoint(configured, ["5a", "5b"], regularJoint());
  const third = schedule["6a:0"][4];
  third.times[5] = { ...third.times[5], start: Math.max(1000, third.times[5].start) };
  third.times[6] = { ...third.times[6], start: 1250 };
  third.breaks = third.times.slice(0, -1).map((time: any, index: number) =>
    third.times[index + 1].start - time.start - time.duration,
  );
  third.slots[6].push({
    id: "unlinked-room-occupant",
    subjectId: "event",
    event: "Отдельное мероприятие",
    roomId: "room:joint-test",
  });
  const response = await saveSchedule(app, auth, configured, schedule);
  assert.equal(response.statusCode, 400);
});
