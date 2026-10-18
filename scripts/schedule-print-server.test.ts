import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { createPublicationSnapshot } from "../shared/publication.ts";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";
import Database from "better-sqlite3";

const roots: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const origin = "http://127.0.0.1";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smena-schedule-print-"));
  roots.push(root);
  const app = await buildApp({ dbPath: join(root, "print.sqlite") });
  apps.push(app);
  const auth = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, host: "127.0.0.1" }, payload: { username: "admin", password: "schedule print password" } });
  assert.equal(auth.statusCode, 200, auth.body);
  const headers = { cookie: String(auth.headers["set-cookie"]).split(";")[0]!, origin, host: "127.0.0.1", "x-csrf-token": auth.json().csrfToken as string };
  const state = (await app.inject({ url: "/api/state", headers })).json() as StateResponse;
  const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
  return { app, headers, state, db };
}

function putPublication(db: Database.Database, snapshot: PublicationSnapshot, version = 4) {
  db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(quarter_id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    draft_revision=excluded.draft_revision,published_by=excluded.published_by,snapshot_json=excluded.snapshot_json,summary_json=excluded.summary_json,print_index_json=excluded.print_index_json`)
    .run(snapshot.quarter.id, version, "2026-10-12T00:00:00.000Z", 87654, "PRIVATE_PUBLISHER", JSON.stringify(snapshot), "{}", JSON.stringify(createPublicationPrintIndex(snapshot)));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("print index is authenticated, no-store, and separates active draft and snapshot groups", async () => {
  const { app, headers, state, db } = await fixture();
  assert.equal((await app.inject({ url: "/api/schedule-print/index" })).statusCode, 401);
  const beforeRevision = state.revision;
  const quarter = state.quarters[0]!;
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const archived = { ...snapshot.catalog.groups[0]!, id: "print-archived", name: "Архивный класс", archived: true };
  snapshot.catalog.groups.push(archived);
  putPublication(db, snapshot);

  const response = await app.inject({ url: "/api/schedule-print/index", headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const index = response.json();
  assert.equal(index.revision, beforeRevision);
  assert.ok(index.published.some((item: { id: string; publication: { version: number } }) => item.id === quarter.id && item.publication.version === 4));
  assert.ok(index.draft.some((item: { id: string }) => item.id === quarter.id));
  assert.ok(index.published.every((item: { groups: Array<{ id: string; name: string }> }) => !item.groups.some((group) => group.id === archived.id)));
  assert.ok(index.draft.every((item: { groups: Array<{ id: string; name: string }> }) => !item.groups.some((group) => group.id === archived.id)));
  assert.equal(JSON.stringify(index).includes("PRIVATE_PUBLISHER"), false);
  assert.equal(db.prepare("SELECT revision FROM draft_metadata WHERE id=1").pluck().get(), beforeRevision);
});

test("compact print index survives cold restart, preserves snapshot names, and invalidates equal-version cache entries", async () => {
  const { app, headers, state, db } = await fixture();
  const snapshot = createPublicationSnapshot(state, state.quarters[0]!.id);
  snapshot.catalog.groups[0]!.name = "Название на момент публикации";
  putPublication(db, snapshot);
  db.prepare("UPDATE catalog_groups SET name=? WHERE id=?").run("Текущее название", snapshot.catalog.groups[0]!.id);
  const before = (await app.inject({ url: "/api/schedule-print/index", headers })).json();
  assert.equal(before.published[0].groups.find((group: { id: string }) => group.id === snapshot.catalog.groups[0]!.id).name, "Название на момент публикации");
  snapshot.catalog.groups[0]!.name = "Другая восстановленная публикация";
  putPublication(db, snapshot); // Deliberately identical version and published_at.
  const replaced = (await app.inject({ url: "/api/schedule-print/index", headers })).json();
  assert.equal(replaced.published[0].groups.find((group: { id: string }) => group.id === snapshot.catalog.groups[0]!.id).name, "Другая восстановленная публикация");

  const dbPath = db.name;
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const prepare = Database.prototype.prepare;
  const snapshotReads: string[] = [];
  Database.prototype.prepare = function(this: Database.Database, sql: string) {
    if (/^\s*SELECT\b/i.test(sql) && /\bsnapshot_json\b/i.test(sql)) snapshotReads.push(sql);
    return prepare.call(this, sql);
  } as typeof prepare;
  try {
    const restarted = await buildApp({ dbPath });
    apps.push(restarted);
    const cold = await restarted.inject({ url: "/api/schedule-print/index", headers });
    assert.equal(cold.statusCode, 200, cold.body);
    assert.deepEqual(cold.json(), replaced);
    assert.deepEqual(snapshotReads, [], "neither cold startup nor cold index reads publication snapshots after migration");
  } finally { Database.prototype.prepare = prepare; }
});

for (const retainColumn of [false, true]) test(`publication migration backfills compact index and preserves original data (${retainColumn ? "existing column without marker" : "legacy schema"})`, async () => {
  const { app, headers, state, db } = await fixture();
  const snapshot = createPublicationSnapshot(state, state.quarters[0]!.id);
  putPublication(db, snapshot);
  const original = db.prepare("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters").all();
  const lessons = db.prepare("SELECT * FROM lessons ORDER BY id").all();
  if (retainColumn) db.exec("UPDATE published_quarters SET print_index_json='{}'");
  else db.exec("ALTER TABLE published_quarters DROP COLUMN print_index_json");
  db.prepare("DELETE FROM schema_migrations WHERE version=24").run();
  const dbPath = db.name;
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const restarted = await buildApp({ dbPath });
  apps.push(restarted);
  const migrated = (restarted as unknown as { smenaDb: Database.Database }).smenaDb;
  assert.deepEqual(migrated.prepare("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json FROM published_quarters").all(), original);
  assert.deepEqual(migrated.prepare("SELECT * FROM lessons ORDER BY id").all(), lessons);
  assert.deepEqual(JSON.parse(migrated.prepare("SELECT print_index_json FROM published_quarters").pluck().get() as string), createPublicationPrintIndex(snapshot));
  assert.equal((await restarted.inject({ url: "/api/schedule-print/index", headers })).statusCode, 200);
});

test("print preview reads exact published snapshot or matching draft revision and validates all requested groups", async () => {
  const { app, headers, state, db } = await fixture();
  const quarter = state.quarters[0]!;
  const active = state.catalog.groups.filter((group) => !group.archived).slice(0, 2);
  assert.equal(active.length, 2);
  const monday = new Date(`${quarter.startDate}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const snapshot = createPublicationSnapshot(state, quarter.id);
  const subject = snapshot.catalog.subjects[0]!;
  const teacher = snapshot.catalog.teachers[0]!;
  const room = snapshot.catalog.rooms[0]!;
  const date = weekStart < quarter.startDate ? quarter.startDate : weekStart;
  const day = structuredClone(Object.values(state.schedule).flat().find((item) => item.date >= quarter.startDate && item.date <= quarter.endDate)!);
  day.date = date;
  day.note = "PRIVATE_DAY_NOTE";
  day.times = [{ start: 605, duration: 40 }, { start: 655, duration: 35 }];
  day.slots = [[{
    id: "print-lesson-a", subjectId: subject.id, teacherId: teacher.id, roomId: room.id, teacher: teacher.name, room: room.name,
    lessonKind: "regular", note: "PRIVATE_LESSON_NOTE",
  }], [{
    id: "print-lesson-b", subjectId: subject.id, teacherId: teacher.id, roomId: room.id, teacher: teacher.name, room: room.name,
    lessonKind: "lab", subgroupId: snapshot.catalog.subgroups.find((subgroup) => subgroup.groupId === active[0]!.id)?.id,
  }]];
  const saturdayDate = new Date(`${weekStart}T00:00:00.000Z`);
  saturdayDate.setUTCDate(saturdayDate.getUTCDate() + 5);
  const saturday = saturdayDate.toISOString().slice(0, 10);
  const saturdayDay = structuredClone(day);
  saturdayDay.date = saturday;
  saturdayDay.times = [{ start: 720, duration: 30 }];
  saturdayDay.slots = [[{
    id: "print-saturday-event", subjectId: "event", event: "Факультатив", lessonKind: "regular",
  }]];
  snapshot.schedule = { [`${active[0]!.id}:0`]: [day, saturdayDay], [`${active[1]!.id}:0`]: [] };
  snapshot.calendar ??= { weekdays: [1, 2, 3, 4, 5], periods: [] };
  snapshot.calendar.periods.push({ id: "print-weekend-holiday", name: "Каникулы", kind: "holiday", startDate: saturday, endDate: saturday, groupIds: [active[0]!.id] });
  teacher.unavailability = [{ id: "private", startDate: quarter.startDate, endDate: quarter.endDate, start: 0, end: 40, reason: "PRIVATE_AVAILABILITY_REASON" }];
  snapshot.studyPlans = [];
  putPublication(db, snapshot);

  const post = async (payload: unknown, extraHeaders: Record<string, string> = headers) => app.inject({ method: "POST", url: "/api/schedule-print/preview", headers: extraHeaders, payload: payload as never });
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], version: 3 })).statusCode, 409);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], version: 4 })).statusCode, 200);
  const publishedResponse = await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id, active[1]!.id], version: 4 });
  assert.equal(publishedResponse.statusCode, 200, publishedResponse.body);
  assert.equal(publishedResponse.headers["cache-control"], "no-store");
  const result = publishedResponse.json();
  assert.deepEqual(Object.keys(result).sort(), ["groups", "publication", "quarter", "source", "weekEnd", "weekStart"].sort());
  assert.equal(result.groups.length, 2);
  const printedDays = result.groups.find((item: { group: { id: string } }) => item.group.id === active[0]!.id).days;
  assert.equal(printedDays.length, 2);
  assert.equal(printedDays[0].lessons[0].start, 605);
  assert.equal(printedDays[0].lessons[0].duration, 40);
  assert.equal(printedDays[0].lessons[1].subgroup.id, snapshot.catalog.subgroups.find((subgroup) => subgroup.groupId === active[0]!.id)?.id);
  assert.equal(printedDays[1].date, saturday);
  assert.equal(printedDays[1].holiday, true);
  assert.equal(printedDays[1].lessons[0].event, "Факультатив", "scheduled Saturday activities remain included even during a holiday");
  assert.deepEqual(result.groups[1].days, []);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(result).includes("publishedBy"), false);
  assert.equal(JSON.stringify(result).includes("studyPlans"), false);

  const draft = await post({ source: "draft", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], revision: state.revision });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json().draftRevision, state.revision);
  assert.equal("publication" in draft.json(), false, "draft must not claim fake publication metadata");
  assert.equal((await post({ source: "draft", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], revision: state.revision - 1 })).statusCode, 409);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: ["unknown"], version: 4 })).statusCode, 404);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: ["print-archived"], version: 4 })).statusCode, 404);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart: "2026-10-13", groupIds: [active[0]!.id], version: 4 })).statusCode, 400);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart: "2026-02-02", groupIds: [active[0]!.id], version: 4 })).statusCode, 400);
  assert.equal((await post({ source: "published", quarterId: "missing", weekStart, groupIds: [active[0]!.id], version: 4 })).statusCode, 404);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [], version: 4 })).statusCode, 400);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id, active[0]!.id], version: 4 })).statusCode, 400);
  assert.equal((await post({ source: "published", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id] })).statusCode, 400);
  assert.equal((await post({ source: "draft", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], revision: state.revision }, { origin, host: "127.0.0.1" })).statusCode, 401);
  const noCsrf = { cookie: headers.cookie, origin, host: headers.host };
  assert.equal((await post({ source: "draft", quarterId: quarter.id, weekStart, groupIds: [active[0]!.id], revision: state.revision }, noCsrf)).statusCode, 403);
  assert.equal(db.prepare("SELECT revision FROM draft_metadata WHERE id=1").pluck().get(), state.revision);
  assert.equal((db.prepare("SELECT version FROM published_quarters WHERE quarter_id=?").pluck().get(quarter.id)), 4);
});
