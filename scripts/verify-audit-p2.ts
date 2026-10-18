import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { buildApp } from "../server/app.ts";

// Run against a disposable schema cloned from the current local PostgreSQL.
// Never point this at public, rich, or a developer's working schema.
const databaseUrl = process.env.SMENA_DATABASE_URL;
assert.ok(databaseUrl, "Set SMENA_DATABASE_URL from the isolated QA env file");
const parsed = new URL(databaseUrl);
assert.equal(parsed.hostname, "127.0.0.1", "database host guard");
assert.equal(parsed.pathname, "/smena_pg_verify", "database name guard");
assert.match(parsed.searchParams.get("options") ?? "", /search_path=qa_fixes_20261018_p2_(?:before|after)(?:\s|$)/, "exact P2 QA schema guard");
const schema = /search_path=([a-z0-9_]+)/.exec(parsed.searchParams.get("options") ?? "")?.[1];
assert.ok(schema);
assert.ok(["qa_fixes_20261018_p2_before", "qa_fixes_20261018_p2_after"].includes(schema), "database schema must be one of the two isolated P2 QA clones");

type QueryMetric = { count: number; rows: number; ms: number; fingerprints: Record<string, { sql: string; count: number; rows: number; ms: number }> };
const activity = new AsyncLocalStorage<QueryMetric>();
const requestMetrics = new Map<string, QueryMetric>();
const clientPrototype = Client.prototype as unknown as { query: (...args: any[]) => any };
const originalQuery = clientPrototype.query;
const normalizedSql = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim().toLowerCase();
const fingerprint = (sql: unknown) => createHash("sha256").update(normalizedSql(sql)).digest("hex").slice(0, 16);
clientPrototype.query = function (...args: any[]) {
  const metric = activity.getStore();
  const queryConfig = args[0];
  const sql = typeof queryConfig === "string" ? queryConfig : queryConfig?.text ?? "";
  const started = performance.now();
  const record = (result: any) => {
    if (!metric) return;
    const ms = performance.now() - started;
    const rows = Number(result?.rowCount ?? 0);
    const key = fingerprint(sql);
    const item = metric.fingerprints[key] ??= { sql: normalizedSql(sql), count: 0, rows: 0, ms: 0 };
    metric.count += 1; metric.rows += rows; metric.ms += ms;
    item.count += 1; item.rows += rows; item.ms += ms;
  };
  const callbackIndex = args.findIndex((arg, index) => index > 0 && typeof arg === "function");
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex];
    args[callbackIndex] = function (error: unknown, result: unknown) { record(result); return callback(error, result); };
    return originalQuery.apply(this, args);
  }
  const result = originalQuery.apply(this, args);
  return result && typeof result.then === "function" ? result.then((value: unknown) => { record(value); return value; }) : result;
};

const admin = new Client({ connectionString: databaseUrl, application_name: "smena-audit-p2-harness" });
await admin.connect();
const tableNames = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map((row: any) => String(row.tablename));
for (const table of tableNames) assert.match(table, /^[a-z_][a-z0-9_]*$/i, "safe table identifier");
const hashes = async () => {
  const result: Record<string, { count: number; hash: string }> = {};
  for (const table of tableNames) {
    const response = await admin.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)),'')) AS hash FROM "${table}" t`);
    result[table] = response.rows[0];
  }
  return result;
};
const preservationSnapshot = async (excludedLessonIds: string[] = [], excludedDayIds: string[] = []) => {
  const result: Record<string, { count: number; hash: string }> = {};
  for (const table of tableNames) {
    let sql = `SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)),'')) AS hash FROM "${table}" t`;
    let params: unknown[] = [];
    if (table === "lessons" && excludedLessonIds.length) { sql += " WHERE id::text <> ALL($1::text[])"; params = [excludedLessonIds]; }
    if (table === "schedule_slots" && excludedDayIds.length) { sql += " WHERE day_id::text <> ALL($1::text[])"; params = [excludedDayIds]; }
    if (table === "schedule_days" && excludedDayIds.length) { sql += " WHERE id::text <> ALL($1::text[])"; params = [excludedDayIds]; }
    const response = await admin.query(sql, params);
    result[table] = response.rows[0];
  }
  return result;
};
const unexpectedPreservationDiff = (before: Record<string, unknown>, after: Record<string, unknown>, expectedTables: string[] = []) => Object.fromEntries(tableNames.filter((table) => !expectedTables.includes(table) && JSON.stringify(before[table]) !== JSON.stringify(after[table])).map((table) => [table, { before: before[table], after: after[table] }]));
const diffHashes = (before: Record<string, unknown>, after: Record<string, unknown>) => Object.fromEntries(tableNames.filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table])).map((table) => [table, { before: before[table], after: after[table] }]));
const metric = (): QueryMetric => ({ count: 0, rows: 0, ms: 0, fingerprints: {} });
const origin = "http://127.0.0.1";
const output: any = { schema, createdAt: new Date().toISOString(), operations: {} };
const autoResponseMode = process.env.AUDIT_P2_AUTO_RESPONSE ?? "compact";
assert.ok(["compact", "receipt"].includes(autoResponseMode), "AUDIT_P2_AUTO_RESPONSE must be compact or receipt");
const artifactDir = resolve("artifacts/audit-fixes-20261018");
const outPath = resolve(process.argv[3] ?? `${artifactDir}/${process.argv[2]}-${Date.now()}.json`);
assert.ok(outPath.startsWith(`${artifactDir}/`) && /^p2-[123].*\.json$/.test(basename(outPath)), "output must be a p2*.json file under artifacts/audit-fixes-20261018");
const op = process.argv[2];
assert.ok(["p2-1", "p2-2", "p2-3"].includes(op!), "Usage: node scripts/verify-audit-p2.ts p2-1|p2-2|p2-3 [output.json]");
const app = await buildApp({ databaseUrl, archiveBackupDirectory: "/tmp/smena-audit-p2-restore-backups" });
app.addHook("onRequest", (request: any, _reply: any, done: () => void) => {
  const id = request.headers["x-audit-measure-id"];
  const current = typeof id === "string" ? requestMetrics.get(id) : undefined;
  if (current) activity.run(current, done);
  else done();
});

try {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin, host: "127.0.0.1" }, payload: { username: process.env.AUDIT_LOGIN ?? "qa-audit", password: process.env.AUDIT_PASSWORD ?? "Audit-only-2026!" } });
  assert.equal(login.statusCode, 200, login.body.slice(0, 300));
  let cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  let headers: Record<string, string> = { cookie, origin, host: "127.0.0.1", "x-csrf-token": login.json().csrfToken as string };
  const request = async (name: string, url: string, options: { method?: string; payload?: unknown; contentType?: string } = {}) => {
    const sql = metric();
    const id = randomUUID();
    requestMetrics.set(id, sql);
    const started = performance.now();
    let response: any;
    try {
      response = await app.inject({ method: options.method ?? "GET", url, headers: { ...headers, "x-audit-measure-id": id, ...(options.contentType ? { "content-type": options.contentType } : {}) }, ...(options.payload === undefined ? {} : { payload: options.payload }) } as any);
    } finally { requestMetrics.delete(id); }
    const elapsedMs = performance.now() - started;
    const bodyBytes = Buffer.byteLength(response.body);
    return { response, measurement: { name, status: response.statusCode, elapsedMs, responseBytes: bodyBytes, sqlCount: sql.count, sqlRows: sql.rows, sqlMs: sql.ms, sqlFingerprints: sql.fingerprints } };
  };
  const stateRequest = await request("full-state-fixture", "/api/state");
  assert.equal(stateRequest.response.statusCode, 200, stateRequest.response.body.slice(0, 300));
  let state = stateRequest.response.json();

  if (op === "p2-1") {
    const group = state.catalog.groups.find((entry: any) => !entry.archived && entry.id === "grade-1-А");
    assert.ok(group, "fixture needs an active first-grade group");
    const quarter = state.quarters.find((entry: any) => entry.id === "quarter-2026-1");
    assert.ok(quarter, "fixture needs an active quarter");
    const weekOffset = 1;
    const before = await hashes();
    const week = await request("editor-week", `/api/editor/week?groupId=${encodeURIComponent(group.id)}&quarterId=${encodeURIComponent(quarter.id)}&weekOffset=${weekOffset}`);
    assert.equal(week.response.statusCode, 200, week.response.body.slice(0, 300));
    const scoped = week.response.json();
    const scheduleKeys = Object.keys(scoped.schedule);
    const externalKeys = scheduleKeys.filter((key: string) => !key.startsWith(`${group.id}:`));
    const weekResult: any = { ...week.measurement, groupId: group.id, groupName: group.name, quarterId: quarter.id, weekOffset, decodedBytes: Buffer.byteLength(week.response.body), rawPayloadBytes: week.response.rawPayload.length, contentEncoding: week.response.headers["content-encoding"] ?? null, visibleLessons: Object.values(scoped.schedule).flatMap((days: any) => days.flatMap((day: any) => day.slots.flat())).length, scheduleKeys: scheduleKeys.length, foreignScheduleKeys: externalKeys.length, returnedPlanCount: scoped.studyPlans.length };

    // Reproduce the established cross-group teacher conflict case using a source
    // lesson from the full state. A green target is exercised by moving one
    // existing lesson within its own group; a red target is attempted as a save.
    let green: any;
    let red: any;
    let redCandidatePreviews = 0;
    const fullSchedule = state.schedule;
    const groupsById = new Map<string, { name: string }>(state.catalog.groups.map((entry: { id: string; name: string }) => [entry.id, entry]));
    for (const [sourceKey, sourceDays] of Object.entries(fullSchedule) as any) {
      const sourceGroupId = sourceKey.slice(0, sourceKey.lastIndexOf(":"));
      const sourceWeekOffset = Number(sourceKey.slice(sourceKey.lastIndexOf(":") + 1));
      for (const day of sourceDays) {
        if (day.date < quarter.startDate || day.date > quarter.endDate) continue;
        for (const [sourceSlot, lessons] of day.slots.entries()) for (const lesson of lessons) {
          if (!lesson.teacherId || lesson.jointId || lesson.subgroupId) continue;
          const { id: _id, ...lessonPayload } = lesson;
          if (!green && lesson.id === "grade-1-А-1-2026-10-12-1-0") {
            const editorDays = scoped.schedule[`${sourceGroupId}:${sourceWeekOffset}`];
            const editorDayIndex = editorDays.findIndex((item: any) => item.date === day.date);
            const editorDay = editorDays[editorDayIndex];
            const targetDays = editorDays.map((targetDay: any, targetDayIndex: number) => ({ targetDay, targetDayIndex }));
            const { targetDay, targetDayIndex } = targetDays.find(({ targetDay }: any) => targetDay.date === "2026-10-14") ?? {};
            assert.ok(targetDay && targetDay.slots[4]?.length === 0, "audited green target 1А 2026-10-14 slot 4 must be empty");
            assert.ok(editorDayIndex >= 0 && editorDay?.slots[sourceSlot]?.some((item: any) => item.id === lesson.id));
            green = { key: sourceKey, dayIndex: editorDayIndex, day: structuredClone(editorDay), targetDayIndex, targetDay: structuredClone(targetDay), sourceSlot, targetSlot: 4, lesson: editorDay.slots[sourceSlot].find((item: any) => item.id === lesson.id), groupId: sourceGroupId, weekOffset: sourceWeekOffset, payload: { lesson: lessonPayload, from: { id: lesson.id, location: { groupId: sourceGroupId, date: day.date, weekOffset: sourceWeekOffset, slot: sourceSlot } } } };
          }
          if (!red) {
            for (const [targetKey, targetDays] of Object.entries(fullSchedule) as any) {
              if (redCandidatePreviews >= 12) break;
              const targetGroupId = targetKey.slice(0, targetKey.lastIndexOf(":"));
              const targetWeekOffset = Number(targetKey.slice(targetKey.lastIndexOf(":") + 1));
              if (targetGroupId === sourceGroupId || targetWeekOffset !== sourceWeekOffset) continue;
              const targetDaysForDate = targetDays.map((targetDay: any, targetDayIndex: number) => ({ targetDay, targetDayIndex })).filter(({ targetDay }: any) => targetDay.date === day.date);
              for (const { targetDay, targetDayIndex } of targetDaysForDate) {
                const plan = state.studyPlans.find((entry: any) => entry.groupId === targetGroupId && entry.quarterId === quarter.id && entry.subjectId === lesson.subjectId && (entry.mode === "whole" || entry.assignments.some((assignment: any) => assignment.subgroupId === null)));
                if (!plan) continue;
                const sourceTime = day.times[sourceSlot];
                const targetSlot = targetDay.times.findIndex((time: any, slotIndex: number) => targetDay.slots[slotIndex]?.length === 0 && sourceTime && sourceTime.start < time.start + time.duration && time.start < sourceTime.start + sourceTime.duration);
                if (targetSlot < 0) continue;
                if (redCandidatePreviews >= 12) break;
                redCandidatePreviews += 1;
                const preview = await request("placement-preview-red-candidate", "/api/editor/preview", { method: "POST", payload: { revision: state.revision, groupId: targetGroupId, quarterId: quarter.id, weekOffset: targetWeekOffset, autoRoom: false, payload: { lesson: lessonPayload } } });
                if (preview.response.statusCode !== 200) continue;
                const target = preview.response.json().targets.find((entry: any) => entry.date === targetDay.date && entry.slot === targetSlot);
                const sourceGroupName = groupsById.get(sourceGroupId)?.name ?? sourceGroupId;
                if (!target || !target.reason || !/(Преподаватель|Кабинет)/i.test(target.reason) || !target.reason.includes(`«${sourceGroupName}»`)) continue;
                red = { key: targetKey, dayIndex: targetDayIndex, day: structuredClone(targetDay), targetSlot, groupId: targetGroupId, weekOffset: targetWeekOffset, lesson: { ...lessonPayload, id: `audit-red-${randomUUID()}` }, payload: { lesson: lessonPayload }, blockerGroupId: sourceGroupId, blockerGroupName: sourceGroupName, blockerLessonId: lesson.id };
                break;
              }
              if (red) break;
            }
          }
          if (green && red) break;
        }
        if (green && red) break;
      }
      if (green && red) break;
    }
    // Stable fallback from the recorded UI audit: 1А PE on 12 Oct overlaps
    // 1З PE. Editing the 1З lesson to use 1А's teacher must be rejected.
    if (!red) {
      const source = fullSchedule["grade-1-А:1"]?.find((day: any) => day.date === "2026-10-12")?.slots[0]?.find((lesson: any) => lesson.id === "grade-1-А-1-2026-10-12-0-0");
      const targetKey = "grade-1-З:1";
      const targetDays = fullSchedule[targetKey] ?? [];
      const targetDayIndex = targetDays.findIndex((day: any) => day.date === "2026-10-12");
      const targetDay = targetDays[targetDayIndex];
      const existing = targetDay?.slots[0]?.find((lesson: any) => lesson.id === "grade-1-З-1-2026-10-12-0-0");
      assert.ok(source && targetDay && existing, "audited 1А/1З PE conflict fixture is missing");
      const edited = { ...existing, teacherId: source.teacherId, teacherName: source.teacherName };
      const { id: _id, ...lessonPayload } = edited;
      red = { key: targetKey, dayIndex: targetDayIndex, day: structuredClone(targetDay), targetSlot: 0, groupId: "grade-1-З", weekOffset: 1, lesson: edited, payload: { lesson: lessonPayload, from: { id: existing.id, location: { groupId: "grade-1-З", date: "2026-10-12", weekOffset: 1, slot: 0 } } }, blockerGroupId: "grade-1-А", blockerGroupName: groupsById.get("grade-1-А")?.name ?? "1А", blockerLessonId: source.id, editExisting: true };
    }
    assert.ok(green, "historically verified green lesson missing");
    assert.ok(red, "no bounded conflict target found for red save attempt");
    const greenPreview = await request("green-preview", "/api/editor/preview", { method: "POST", payload: { revision: state.revision, groupId: green.groupId, quarterId: quarter.id, weekOffset: green.weekOffset, autoRoom: false, payload: green.payload } });
    assert.equal(greenPreview.response.statusCode, 200, greenPreview.response.body.slice(0, 300));
    assert.equal(greenPreview.response.json().targets.find((target: any) => target.date === green.day.date && target.slot === green.targetSlot)?.reason, null);
    const greenAfter = structuredClone(green.day);
    greenAfter.slots[green.sourceSlot] = greenAfter.slots[green.sourceSlot].filter((lesson: any) => lesson.id !== green.lesson.id);
    const greenTargetAfter = structuredClone(green.targetDay);
    greenTargetAfter.slots[green.targetSlot].push(green.lesson);
    const greenBeforeHashes = await hashes();
    const greenPreservationBefore = await preservationSnapshot();
    const greenChanges = [
      { key: green.key, dayIndex: green.dayIndex, before: green.day, after: greenAfter },
      { key: green.key, dayIndex: green.targetDayIndex, before: green.targetDay, after: greenTargetAfter },
    ];
    const greenSave = await request("green-save", "/api/editor/days", { method: "PUT", payload: { revision: state.revision, requestId: `audit-green-${randomUUID()}`, changes: greenChanges } });
    assert.equal(greenSave.response.statusCode, 200, greenSave.response.body.slice(0, 300));
    const greenApplied = greenSave.response.json();
    const greenUndo = await request("green-restore", "/api/editor/days", { method: "PUT", payload: { revision: greenApplied.revision, requestId: `audit-green-restore-${randomUUID()}`, changes: [
      { key: green.key, dayIndex: green.dayIndex, before: greenAfter, after: green.day },
      { key: green.key, dayIndex: green.targetDayIndex, before: greenTargetAfter, after: green.targetDay },
    ] } });
    assert.equal(greenUndo.response.statusCode, 200, greenUndo.response.body.slice(0, 300));
    const greenPreservationAfter = await preservationSnapshot();
    const greenUnrelatedDiff = unexpectedPreservationDiff(greenPreservationBefore, greenPreservationAfter, ["draft_metadata", "editor_request_replays"]);
    if (process.env.EXPECT_P2_FIXED === "1") assert.deepEqual(greenUnrelatedDiff, {}, "green move/restore must preserve every unrelated physical row");

    const redBefore = await hashes();
    const redRevisionBefore = Number((await admin.query("SELECT revision FROM draft_metadata WHERE id=1")).rows[0].revision);
    const redPreview = await request("red-preview", "/api/editor/preview", { method: "POST", payload: { revision: greenUndo.response.json().revision, groupId: red.groupId, quarterId: quarter.id, weekOffset: red.weekOffset, autoRoom: false, payload: red.payload } });
    assert.equal(redPreview.response.statusCode, 200, redPreview.response.body.slice(0, 300));
    const redReason = redPreview.response.json().targets.find((target: any) => target.date === red.day.date && target.slot === red.targetSlot)?.reason;
    assert.match(String(redReason), /(Преподаватель|Кабинет)/i, "red target should be blocked by an existing teacher or room conflict");
    assert.ok(String(redReason).includes(`«${red.blockerGroupName}»`), "reason must identify the actual conflicting group");
    const redAfter = structuredClone(red.day);
    if (red.editExisting) {
      const index = redAfter.slots[red.targetSlot].findIndex((lesson: any) => lesson.id === red.lesson.id);
      assert.ok(index >= 0);
      redAfter.slots[red.targetSlot][index] = red.lesson;
    } else redAfter.slots[red.targetSlot].push(red.lesson);
    const redSave = await request("red-save-rejected", "/api/editor/days", { method: "PUT", payload: { revision: greenUndo.response.json().revision, requestId: `audit-red-${randomUUID()}`, changes: [{ key: red.key, dayIndex: red.dayIndex, before: red.day, after: redAfter }] } });
    assert.equal(redSave.response.statusCode, 400, redSave.response.body.slice(0, 300));
    const after = await hashes();
    const redRevisionAfter = Number((await admin.query("SELECT revision FROM draft_metadata WHERE id=1")).rows[0].revision);
    assert.equal(redRevisionAfter, redRevisionBefore, "rejected red save must not advance revision");
    assert.deepEqual(diffHashes(redBefore, after), {}, "rejected red preview/save must leave all database tables unchanged");
    output.operations[op] = { week: weekResult, greenPreview: greenPreview.measurement, greenSave: greenSave.measurement, greenRestore: greenUndo.measurement, greenUnrelatedPreservation: { changedTableCount: Object.keys(greenUnrelatedDiff).length, changedTables: Object.keys(greenUnrelatedDiff) }, redPreview: { ...redPreview.measurement, reason: redReason, blockerGroupId: red.blockerGroupId, blockerGroupName: red.blockerGroupName, blockerLessonId: red.blockerLessonId }, redSave: redSave.measurement, redRevisionBefore, redRevisionAfter, greenRedSemantics: "green move saved and restored; red cross-group teacher or room conflict save rejected", tableChangesAfterRestore: diffHashes(before, after), changesDuringGreenRoundTrip: diffHashes(greenBeforeHashes, await hashes()) };
    if (process.env.EXPECT_P2_BASELINE === "1")
      assert.ok(weekResult.foreignScheduleKeys > 0, "baseline should demonstrate a full-school week payload");
  }

  if (op === "p2-2") {
    const candidate = (await admin.query(`SELECT l.id lesson_id,l.teacher_ref teacher_id,l.subject_id,d.group_id,d.date,d.week_offset,s.slot_index,s.start_minute,s.duration
      FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id
      JOIN catalog_teachers t ON t.id=l.teacher_ref JOIN quarters q ON d.date BETWEEN q.start_date AND q.end_date
      WHERE l.id='grade-10-А--5-2026-09-01-3-0' AND l.teacher_ref='teacher-056' AND d.group_id='grade-10-А' AND d.date='2026-09-01' AND t.archived=0 LIMIT 1`)).rows[0];
    assert.ok(candidate, "historically verified fixture grade-10-А--5-2026-09-01-3-0 is missing");
    const targetLessonRow = async () => (await admin.query(`SELECT l.id,l.teacher_ref,l.teacher,l.room_ref,l.room,l.subject_id,l.subgroup,l.note,l.teacher_ref,l.room_ref,l.subgroup_ref,l.lesson_kind,l.joint_id,l.event_remainder_json,l.insertion_order,d.group_id,d.date,s.slot_index
      FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id=$1`, [candidate.lesson_id])).rows[0];
    const teacher = (await admin.query("SELECT id,unavailability_json FROM catalog_teachers WHERE id=$1", [candidate.teacher_id])).rows[0];
    const priorRules = JSON.parse(teacher.unavailability_json ?? "[]");
    const ruleId = `audit-p2-${randomUUID()}`;
    const newRules = [...priorRules, { id: ruleId, startDate: candidate.date, endDate: candidate.date, start: 0, end: 1440, reason: "QA audit" }];
    await admin.query("UPDATE catalog_teachers SET unavailability_json=$1 WHERE id=$2", [JSON.stringify(newRules), candidate.teacher_id]);
    try {
      const before = await hashes();
      const replacementPreservationBefore = await preservationSnapshot([candidate.lesson_id]);
      const targetRowBefore = await targetLessonRow();
      state = (await request("state-after-fixture", "/api/state")).response.json();
      const replacementRequest = { teacherId: candidate.teacher_id, startDate: candidate.date, endDate: candidate.date, groupId: candidate.group_id, ruleId };
      const preview = await request("automatic-replacement-preview", "/api/teacher-replacements/preview?response=compact", { method: "POST", payload: { revision: state.revision, request: replacementRequest } });
      assert.equal(preview.response.statusCode, 200, preview.response.body.slice(0, 300));
      const unit = preview.response.json().preview.units.find((item: any) => item.lessonIds.includes(candidate.lesson_id) && item.teacherId);
      assert.ok(unit, "fixture lesson must have an eligible substitute");
      if (process.env.EXPECT_P2_BASELINE === "1") assert.equal(unit.teacherId, "teacher-055", "baseline fixture must reproduce the audited 10A Algebra replacement");
      const apply = await request("automatic-replacement-apply", `/api/teacher-replacements/apply?response=${autoResponseMode}`, { method: "POST", payload: { revision: state.revision, requestId: `audit-auto-${randomUUID()}`, request: replacementRequest, expectedAssignments: [{ unitId: unit.id, teacherId: unit.teacherId }] } });
      assert.equal(apply.response.statusCode, 200, apply.response.body.slice(0, 300));
      const targetRowAfterApply = await targetLessonRow();
      const applied = apply.response.json();
      const appliedRevision = autoResponseMode === "receipt" ? applied.revision : applied.state.revision;
      const undo = await request("automatic-replacement-undo", `/api/teacher-replacements/${applied.operationId}/undo?response=${autoResponseMode}`, { method: "POST", payload: { revision: appliedRevision, requestId: `audit-auto-undo-${randomUUID()}` } });
      assert.equal(undo.response.statusCode, 200, undo.response.body.slice(0, 300));
      const targetRowAfterUndo = await targetLessonRow();
      const undoneRevision = autoResponseMode === "receipt" ? undo.response.json().revision : undo.response.json().state.revision;
      assert.equal(undoneRevision, appliedRevision + 1);
      const after = await hashes();
      const replacementPreservationAfter = await preservationSnapshot([candidate.lesson_id]);
      const replacementUnrelatedDiff = unexpectedPreservationDiff(replacementPreservationBefore, replacementPreservationAfter, ["draft_metadata", "editor_request_replays", "teacher_replacement_operations"]);
      const selectedLessonChangedFieldsAfterUndo = Object.fromEntries(Object.keys(targetRowBefore).filter((field) => targetRowBefore[field] !== targetRowAfterUndo[field]).map((field) => [field, { before: targetRowBefore[field], after: targetRowAfterUndo[field] }]));
      const lessonWriteSql = (measurement: any) => Object.values(measurement.sqlFingerprints).filter((entry: any) => /^(insert into|delete from|update) lessons\b/.test(entry.sql));
      output.operations[op] = { candidate, responseMode: autoResponseMode, preview: preview.measurement, apply: apply.measurement, undo: undo.measurement, lessonWriteSql: { apply: lessonWriteSql(apply.measurement), undo: lessonWriteSql(undo.measurement) }, responseBytes: { apply: apply.measurement.responseBytes, undo: undo.measurement.responseBytes }, tableChanges: diffHashes(before, after), unrelatedPreservation: { changedTableCount: Object.keys(replacementUnrelatedDiff).length, changedTables: Object.keys(replacementUnrelatedDiff) }, selectedLessonRows: { before: targetRowBefore, afterApply: targetRowAfterApply, afterUndo: targetRowAfterUndo, changedFieldsAfterUndo: selectedLessonChangedFieldsAfterUndo }, note: "QA absence fixture is restored after measuring; operation/replay rows and revision remain as audit records" };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(output, null, 2), { mode: 0o600 });
      if (process.env.EXPECT_P2_FIXED === "1") {
        assert.deepEqual(replacementUnrelatedDiff, {}, "automatic replacement apply/undo must preserve unrelated lesson and database rows");
        assert.equal(targetRowAfterUndo.teacher_ref, targetRowBefore.teacher_ref, "undo must restore selected lesson teacher_ref");
        for (const field of ["id", "subject_id", "subgroup", "note", "room_ref", "room", "subgroup_ref", "lesson_kind", "joint_id", "event_remainder_json", "insertion_order", "group_id", "date", "slot_index"])
          assert.equal(targetRowAfterUndo[field], targetRowBefore[field], `undo must restore selected lesson ${field}`);
        assert.ok(Object.keys(selectedLessonChangedFieldsAfterUndo).every((field) => field === "teacher"), "only the selected legacy teacher display label may normalize after undo");
      }
    } finally {
      await admin.query("UPDATE catalog_teachers SET unavailability_json=$1 WHERE id=$2", [JSON.stringify(priorRules), candidate.teacher_id]);
    }
  }

  if (op === "p2-3") {
    const group = state.catalog.groups.find((entry: any) => !entry.archived && /^1А$/.test(entry.name));
    const quarter = state.quarters.find((entry: any) => entry.id === "quarter-2026-1");
    assert.ok(group && quarter);
    const lessonId = "grade-1-А-1-2026-10-12-0-0";
    const found = (await admin.query("SELECT d.date,d.week_offset FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id=$1 AND d.group_id=$2", [lessonId, group.id])).rows[0];
    assert.ok(found, `historically verified note fixture ${lessonId} is missing`);
    const beforeHashes = await hashes();
    const notePreservationBefore = await preservationSnapshot();
    const week = await request("note-week", `/api/editor/week?groupId=${encodeURIComponent(group.id)}&quarterId=${encodeURIComponent(quarter.id)}&weekOffset=${found.week_offset}`);
    assert.equal(week.response.statusCode, 200, week.response.body.slice(0, 300));
    const current = week.response.json();
    const key = `${group.id}:${found.week_offset}`;
    const dayIndex = current.schedule[key].findIndex((day: any) => day.date === found.date);
    assert.ok(dayIndex >= 0);
    const dayBefore = structuredClone(current.schedule[key][dayIndex]);
    const rawDaySql = `SELECT d.id day_id,d.group_id,d.date,d.week_offset,d.day_index,d.base_start,d.nominal_duration,d.holiday,d.note day_note,d.bell_profile_json,
      s.id slot_id,s.slot_index,s.start_minute,s.duration,
      l.id lesson_id,l.subject_id,l.subgroup,l.teacher,l.room,l.event,l.note lesson_note,l.teacher_ref,l.room_ref,l.subgroup_ref,l.lesson_kind,l.joint_id,l.event_remainder_json,l.insertion_order
      FROM schedule_days d LEFT JOIN schedule_slots s ON s.day_id=d.id LEFT JOIN lessons l ON l.slot_id=s.id
      WHERE d.group_id=$1 AND d.date=$2 ORDER BY s.slot_index,l.insertion_order`;
    const rowsBefore = await admin.query(rawDaySql, [group.id, found.date]);
    const dayAfter = structuredClone(dayBefore);
    const targetSlot = dayAfter.slots.findIndex((slot: any[]) => slot.some((lesson: any) => lesson.id === lessonId));
    const targetLessonIndex = dayAfter.slots[targetSlot]?.findIndex((lesson: any) => lesson.id === lessonId) ?? -1;
    assert.ok(targetSlot >= 0 && targetLessonIndex >= 0, `lesson ${lessonId} missing from editor week payload`);
    const oldNote = dayAfter.slots[targetSlot][targetLessonIndex].note ?? null;
    const newNote = oldNote === "QA audit note" ? "QA audit note 2" : "QA audit note";
    dayAfter.slots[targetSlot][targetLessonIndex].note = newNote;
    const save = await request("note-save", "/api/editor/days", { method: "PUT", payload: { revision: current.revision, requestId: `audit-note-${randomUUID()}`, changes: [{ key, dayIndex, before: dayBefore, after: dayAfter }] } });
    assert.equal(save.response.statusCode, 200, save.response.body.slice(0, 300));
    const applyRows = (await admin.query(rawDaySql, [group.id, found.date])).rows;
    const expectedOnlyNoteRows = structuredClone(rowsBefore.rows).map((row: any) => row.lesson_id === lessonId ? { ...row, lesson_note: newNote } : row);
    const onlyLessonNoteChanged = JSON.stringify(expectedOnlyNoteRows) === JSON.stringify(applyRows);
    if (process.env.EXPECT_P2_FIXED === "1") assert.equal(onlyLessonNoteChanged, true, "lesson.note edit must preserve every raw day/slot/neighbor row field");
    const saved = save.response.json();
    const restore = await request("note-restore", "/api/editor/days", { method: "PUT", payload: { revision: saved.revision, requestId: `audit-note-restore-${randomUUID()}`, changes: [{ key, dayIndex, before: dayAfter, after: dayBefore }] } });
    assert.equal(restore.response.statusCode, 200, restore.response.body.slice(0, 300));
    const afterHashes = await hashes();
    const notePreservationAfter = await preservationSnapshot();
    const noteUnrelatedDiff = unexpectedPreservationDiff(notePreservationBefore, notePreservationAfter, ["draft_metadata", "editor_request_replays"]);
    if (process.env.EXPECT_P2_FIXED === "1") assert.deepEqual(noteUnrelatedDiff, {}, "note edit/restore must preserve every unrelated physical row");

    // Manual single-lesson reassignment and undo, timed separately from fixture setup.
    state = (await request("reassignment-state", "/api/state")).response.json();
    const manualLessonId = "grade-10-В--5-2026-09-01-0-0";
    const manualGroup = state.catalog.groups.find((entry: any) => entry.id === "grade-10-В");
    const manualSource = state.catalog.teachers.find((entry: any) => entry.id === "teacher-056");
    const manualTarget = state.catalog.teachers.find((entry: any) => entry.id === "teacher-049");
    const manualQuarter = state.quarters.find((entry: any) => entry.id === "quarter-2026-1");
    const manualLesson = Object.values(state.schedule).flatMap((days: any) => days.flatMap((day: any) => day.slots.flat())).find((entry: any) => entry.id === manualLessonId);
    assert.ok(manualGroup && manualSource && manualTarget && manualQuarter && manualLesson, "historically verified manual reassignment fixture missing");
    const reassignmentRequest = { mode: "assign", quarterId: manualQuarter.id, subjectId: manualLesson.subjectId, sourceTeacherId: manualSource.id, groupIds: [manualGroup.id], scope: "lesson", lessonId: manualLesson.id, targetTeacherId: manualTarget.id, persist: false };
    {
      const preview = await request("manual-reassignment-preview", "/api/teacher-reassignments/preview?response=compact", { method: "POST", payload: { revision: state.revision, request: reassignmentRequest } });
      assert.equal(preview.response.statusCode, 200, preview.response.body.slice(0, 300));
      const unit = preview.response.json().preview.units.find((item: any) => item.lessonIds.includes(manualLesson.id) && item.teacherId === manualTarget.id);
      assert.ok(unit, "manual reassignment fixture needs an eligible preview unit");
      const apply = await request("manual-reassignment-apply", "/api/teacher-reassignments/apply?response=receipt", { method: "POST", payload: { revision: state.revision, requestId: `audit-manual-apply-${randomUUID()}`, request: reassignmentRequest, expectedUnits: [{ unitId: unit.id, teacherId: manualTarget.id }] } });
      assert.equal(apply.response.statusCode, 200, apply.response.body.slice(0, 300));
      const applied = apply.response.json();
      const undo = await request("manual-reassignment-undo", `/api/teacher-reassignments/${applied.operationId}/undo?response=receipt`, { method: "POST", payload: { revision: applied.revision, requestId: `audit-manual-undo-${randomUUID()}` } });
      assert.equal(undo.response.statusCode, 200, undo.response.body.slice(0, 300));
      const undoAvailability = Object.values(undo.measurement.sqlFingerprints).filter((entry: any) => /^update catalog_teachers set unavailability_json\s*=/.test(entry.sql));
      output.operations[op] = { noteSave: save.measurement, noteRestore: restore.measurement, noteOnlyRawRowsPreserved: onlyLessonNoteChanged, noteUnrelatedPreservation: { changedTableCount: Object.keys(noteUnrelatedDiff).length, changedTables: Object.keys(noteUnrelatedDiff) }, noteRowCounts: { before: rowsBefore.rows.length, afterSave: applyRows.length }, physicalRowsBeforeNote: rowsBefore.rows, physicalRowsAfterNoteSave: applyRows, hashesAfterNoteRoundTrip: diffHashes(beforeHashes, afterHashes), manualReassignmentFixture: { lessonId: manualLessonId, groupId: manualGroup.id, sourceTeacherId: manualSource.id, targetTeacherId: manualTarget.id }, manualReassignment: { preview: preview.measurement, apply: apply.measurement, undo: undo.measurement, availabilityUpdateStatementsOnUndo: undoAvailability.reduce((sum: number, value: any) => sum + value.count, 0), availabilityUpdatedRowsOnUndo: undoAvailability.reduce((sum: number, value: any) => sum + value.rows, 0) } };
    }
  }

  output.finishedAt = new Date().toISOString();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output: outPath, ...output }, null, 2));
} finally {
  await app.close();
  await admin.end();
  clientPrototype.query = originalQuery;
}
