import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import { calendarDay, studyWeekdays } from "../shared/schoolCalendar.ts";
import { weekOffsetFor } from "../shared/plans.ts";

// Audits the saved database independently of the generator's counters.
const path = process.argv[2];
assert.ok(path, "Usage: node scripts/audit-full-school.ts DATABASE [REPORT]");
const app = await buildApp({ dbPath: resolve(path) });
const db = (app as unknown as { smenaDb: Database.Database }).smenaDb;
const token = randomBytes(32).toString("base64url"), csrf = randomBytes(24).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const admin = db.prepare("SELECT username FROM admin_users LIMIT 1").get() as { username: string };
assert.ok(admin);
db.prepare("INSERT INTO sessions(token_hash,csrf_token,expires_at,username) VALUES(?,?,?,?)").run(hash, csrf, Date.now() + 600000, admin.username);
try {
  assert.equal((db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check, "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  const response = await app.inject({ url: "/api/state", headers: { cookie: `smena_session=${token}` } });
  assert.equal(response.statusCode, 200);
  const state = response.json() as StateResponse;
  assert.equal((db.prepare("SELECT count(*) n FROM school_calendar").get() as { n: number }).n, 1, "Missing calendar singleton");
  assert.equal((db.prepare("SELECT count(*) n FROM bell_settings").get() as { n: number }).n, 1, "Missing bell singleton");
  const input = JSON.parse(readFileSync(new URL("./full-school-curriculum.json", import.meta.url), "utf8")) as { weeklyByEra: Array<{ fromSchoolYear: number; grades: Record<string, Record<string, number>> }> };
  const subjects = new Map(state.catalog.subjects.map(s => [s.id, s]));
  const teachers = new Map(state.catalog.teachers.map(t => [t.id, t]));
  const rooms = new Map(state.catalog.rooms.map(r => [r.id, r]));
  const groups = new Map(state.catalog.groups.map(g => [g.id, g]));
  const subgroups = new Map(state.catalog.subgroups.map(g => [g.id, g]));
  const counts = new Map<string, number>();
  const weeklyCounts = new Map<string, Map<string, number>>();
  const teacherTimes = new Map<string, Array<{ start: number; end: number; id: string }>>();
  const roomTimes = new Map<string, Array<{ start: number; end: number; id: string }>>();
  const quarterTotals = new Map(state.quarters.map(q => [q.id, 0]));
  let lessons = 0, saturdayLessons = 0, outsidePreferredGroups = 0, minDate = "9999", maxDate = "0000";
  const addTime = (map: typeof teacherTimes, key: string, start: number, end: number, id: string) => {
    const list = map.get(key) ?? []; list.push({ start, end, id }); map.set(key, list);
  };
  for (const [key, days] of Object.entries(state.schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":")), group = groups.get(groupId);
    assert.ok(group, `Unknown group ${groupId}`);
    const grade = Number(group.name.match(/^\d+/)?.[0]);
    for (const day of days) {
      const occupied = day.slots.filter(slot => slot.length > 0).length;
      assert.ok(occupied <= (grade <= 4 ? 5 : 7), `${group.name} has too many lessons on ${day.date}`);
      if (!occupied) continue;
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      assert.notEqual(weekday, 0, `Sunday lesson ${group.name} ${day.date}`);
      if (grade <= 4) assert.notEqual(weekday, 6, `Primary Saturday lesson ${group.name} ${day.date}`);
      assert.ok(!day.holiday && !calendarDay(state.calendar!, groupId, day.date).holiday, `Holiday lesson ${group.name} ${day.date}`);
      const quarter = state.quarters.find(q => q.startDate <= day.date && day.date <= q.endDate);
      assert.ok(quarter, `Lesson outside quarter ${day.date}`);
      for (let slotIndex = 0; slotIndex < day.slots.length; slotIndex++) {
        const slot = day.slots[slotIndex]!;
        if (slot.length > 1) {
          assert.ok(slot.every(l => !!l.subgroupId), `Whole-group lesson overlaps subgroups ${group.name} ${day.date}`);
          assert.equal(new Set(slot.map(l => l.subgroupId)).size, slot.length);
        }
        for (const lesson of slot) {
          assert.ok(!lesson.event, "Unexpected event");
          const teacher = teachers.get(lesson.teacherId!), room = rooms.get(lesson.roomId!), subject = subjects.get(lesson.subjectId);
          assert.ok(teacher && room && subject, `Missing resources ${lesson.id}`);
          assert.ok(teacher.subjectIds.includes(subject.id), `Teacher specialty ${lesson.id}`);
          if (!teacher.preferredGroupIds?.includes(groupId)) outsidePreferredGroups++;
          // Preferences are a soft priority. This fixture's first 28 teachers
          // are primary teachers, so their use in secondary school is invalid.
          if (Number(teacher.id.replace("teacher-", "")) <= 28) assert.ok(grade <= 4, `Primary teacher in secondary school ${lesson.id}`);
          const subgroup = lesson.subgroupId ? subgroups.get(lesson.subgroupId) : undefined;
          if (lesson.subgroupId) assert.equal(subgroup?.groupId, groupId);
          assert.ok(room.capacity === null || room.capacity >= (subgroup?.students ?? group.students));
          assert.ok(!subject.roomKind || subject.roomKind === room.kind, `Room type ${lesson.id}`);
          if (subject.id === "school:german") assert.ok(lesson.subgroupId?.endsWith("-de"));
          if (subject.id === "school:chinese") assert.ok(lesson.subgroupId?.endsWith("-zh"));
          const time = day.times[slotIndex]!;
          assert.ok(time);
          addTime(teacherTimes, `${teacher.id}|${day.date}`, time.start, time.start + time.duration, lesson.id);
          addTime(roomTimes, `${room.id}|${day.date}`, time.start, time.start + time.duration, lesson.id);
          const countKey = JSON.stringify([quarter.id, groupId, subject.id, lesson.subgroupId ?? null, lesson.lessonKind ?? "regular"]);
          counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
          const weekKey = `${groupId}|${weekOffsetFor(day.date)}`;
          const weekCounts = weeklyCounts.get(weekKey) ?? new Map<string, number>();
          const assignmentKey = JSON.stringify([subject.id, lesson.subgroupId ?? null]);
          weekCounts.set(assignmentKey, (weekCounts.get(assignmentKey) ?? 0) + 1);
          weeklyCounts.set(weekKey, weekCounts);
          lessons++; if (weekday === 6) saturdayLessons++;
          minDate = day.date < minDate ? day.date : minDate; maxDate = day.date > maxDate ? day.date : maxDate;
          quarterTotals.set(quarter.id, quarterTotals.get(quarter.id)! + 1);
        }
      }
    }
  }
  // Check every complete study week against the source hours, independently
  // of stored targets or the generator's own remaining counters.
  let verifiedFullWeeks = 0;
  for (const group of groups.values()) {
    const grade = Number(group.name.match(/^\d+/)?.[0]);
    assert.deepEqual(studyWeekdays(state.calendar!, group.id), grade <= 4 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6]);
    for (const quarter of state.quarters) {
      const year = Number(quarter.id.split("-")[1]);
      const source = input.weeklyByEra.find(era => era.fromSchoolYear === year)!.grades[String(grade)]!;
      const expectedWeek = new Map(Object.entries(source).filter(([, hours]) => hours > 0).map(([id, hours]) => [JSON.stringify([id, null]), hours]));
      if (grade >= 5) for (const [subject, suffix] of [["school:german", "-de"], ["school:chinese", "-zh"]]) {
        const subgroup = [...subgroups.values()].find(s => s.groupId === group.id && s.id.endsWith(suffix!));
        assert.ok(subgroup);
        expectedWeek.set(JSON.stringify([subject, subgroup.id]), 1);
      }
      let stamp = Date.parse(`${quarter.startDate}T00:00:00Z`);
      while (new Date(stamp).getUTCDay() !== 1) stamp += 86400000;
      const end = Date.parse(`${quarter.endDate}T00:00:00Z`);
      for (; stamp + (grade <= 4 ? 4 : 5) * 86400000 <= end; stamp += 7 * 86400000) {
        const dates = Array.from({ length: grade <= 4 ? 5 : 6 }, (_, index) => new Date(stamp + index * 86400000).toISOString().slice(0, 10));
        if (dates.some(date => calendarDay(state.calendar!, group.id, date).holiday)) continue;
        const actual = weeklyCounts.get(`${group.id}|${weekOffsetFor(dates[0]!)}`) ?? new Map<string, number>();
        assert.deepEqual([...actual].sort(), [...expectedWeek].sort(), `Source weekly hours differ: ${group.name}, ${dates[0]}`);
        verifiedFullWeeks++;
      }
    }
  }
  assert.ok(saturdayLessons > 0, "No Saturday lessons");
  for (const [kind, resources] of [["teacher", teacherTimes], ["room", roomTimes]] as const) {
    for (const [key, entries] of resources) {
      entries.sort((a, b) => a.start - b.start || a.end - b.end);
      let end = -1;
      for (const entry of entries) { assert.ok(entry.start >= end, `${kind} conflict ${key} ${entry.id}`); end = Math.max(end, entry.end); }
    }
  }
  let expected = 0;
  for (const plan of state.studyPlans) for (const assignment of plan.assignments) {
    const key = JSON.stringify([plan.quarterId, plan.groupId, plan.subjectId, assignment.subgroupId, plan.lessonKind]);
    assert.equal(counts.get(key) ?? 0, assignment.target, `Plan differs ${key}`);
    counts.delete(key); expected += assignment.target;
  }
  assert.equal(counts.size, 0, "Lessons without plans");
  assert.equal(expected, lessons);
  assert.equal(state.catalog.groups.length, 74);
  assert.equal(state.quarters.length, 10);
  assert.equal(state.curricula?.length, 740);
  const report = { database: resolve(path), lessons, expected, groups: groups.size, students: [...groups.values()].reduce((n, g) => n + g.students, 0), teachers: teachers.size, rooms: rooms.size, subgroups: subgroups.size, quarters: state.quarters.length, curricula: state.curricula!.length, studyPlans: state.studyPlans.length, saturdayLessons, verifiedFullWeeks, outsidePreferredGroups, firstLesson: minDate, lastLesson: maxDate, quarterTotals: Object.fromEntries(quarterTotals), conflicts: 0, missing: 0, extra: 0, events: 0, sqliteIntegrity: "ok" };
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash);
  await app.close();
}
