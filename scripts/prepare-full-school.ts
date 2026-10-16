// Populates only an explicitly supplied disposable copy of a Smena SQLite DB.
// The real database is never inferred from SMENA_DB_PATH or the app default.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeSubgroupNames } from "../shared/subgroup-names.ts";
import { buildApp } from "../server/app.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { Catalog, CatalogGroup, CatalogRoom, CatalogSubgroup, CatalogSubject, CatalogTeacher, RoomKind } from "../shared/catalog.ts";
import { defaultBellSettings, type BellProfile, type BellSettings } from "../shared/bellSchedule.ts";
import { calendarDay, type SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import { projectCurricula, type Curriculum } from "../shared/curricula.ts";
import { generateQuarter } from "../shared/generateSchedule.ts";
import { weekOffsetFor } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";
import { mergeGradeCurricula } from "./refine-full-school-data.ts";

type WeeklyEra = { fromSchoolYear: number; grades: Record<string, Record<string, number>> };
type CurriculumInput = { subjects: CatalogSubject[]; weeklyByEra: WeeklyEra[]; assumptions?: string[]; sources?: Array<{ title: string; url: string }> };
type Cli = { db: string; curriculum: string; report?: string };
const origin = "http://127.0.0.1";
const schoolYearGroups = [
  { year: 2024, quarters: [["2024-09-02", "2024-10-25"], ["2024-11-05", "2024-12-28"], ["2025-01-09", "2025-03-21"], ["2025-03-31", "2025-05-24"]] },
  { year: 2025, quarters: [["2025-09-01", "2025-10-24"], ["2025-11-03", "2025-12-26"], ["2026-01-09", "2026-03-20"], ["2026-03-30", "2026-05-23"]] },
  { year: 2026, quarters: [["2026-09-01", "2026-10-23"], ["2026-11-02", "2026-12-25"]] },
] as const;
const letters = Array.from("АБВГДЕЖЗИКЛМНОПРСТУФХЦЧ");
const teacherNameValue: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("./full-school-teacher-names.json", import.meta.url)), "utf8"));
if (!Array.isArray(teacherNameValue) || teacherNameValue.some(name => typeof name !== "string" || !name.trim()) || new Set(teacherNameValue.map(name => name.trim().toLocaleLowerCase("ru"))).size !== teacherNameValue.length || new Set(teacherNameValue.map(name => name.trim().split(/\s+/u)[0]!.toLocaleLowerCase("ru"))).size !== teacherNameValue.length)
  throw new Error("scripts/full-school-teacher-names.json must contain distinct, non-empty full names.");
const teacherNames = teacherNameValue.map(name => (name as string).trim());

function parseCli(args: string[]): Cli {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i], value = args[i + 1];
    if (!["--db", "--curriculum", "--report"].includes(key ?? "") || !value || value.startsWith("--") || values.has(key!))
      throw new Error("Usage: node scripts/prepare-full-school.ts --db /tmp/smena-copy.sqlite [--curriculum scripts/full-school-curriculum.json] [--report PATH]");
    values.set(key!, value);
    i += 1;
  }
  const db = values.get("--db");
  if (!db) throw new Error("Укажите --db с путём к временной копии базы данных");
  const absoluteDb = resolve(db);
  if (!isAbsolute(db) || db === ":memory:") throw new Error("Путь --db должен быть абсолютным путём к временной копии SQLite");
  const tempRoot = resolve(tmpdir());
  const fromTemp = relative(tempRoot, absoluteDb);
  if (fromTemp === ".." || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp))
    throw new Error(`Для безопасности --db должен находиться во временном каталоге ${tempRoot}`);
  const configuredDb = resolve(process.env.SMENA_DB_PATH ?? "data/smena.sqlite");
  if (absoluteDb === configuredDb || basename(absoluteDb) === "smena.sqlite")
    throw new Error("Отказ от записи: выберите временную копию базы, не рабочую smena.sqlite");
  if (!existsSync(absoluteDb)) throw new Error(`Временная копия базы не найдена: ${absoluteDb}`);
  return { db: absoluteDb, curriculum: resolve(values.get("--curriculum") ?? "scripts/full-school-curriculum.json"), report: values.get("--report") ? resolve(values.get("--report")!) : undefined };
}

function assertDbIntegrity(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<Record<string, string>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.integrity_check, "ok", `SQLite integrity check failed: ${path}`);
  } finally { db.close(); }
}

function syntheticSession(path: string): { cookie: string; csrf: string; username: string; tokenHash: string } {
  const db = new Database(path);
  try {
    const admin = db.prepare("SELECT username FROM admin_users WHERE id=1").get() as { username: string } | undefined;
    if (!admin) throw new Error("В копии базы нет учётной записи администратора");
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    db.prepare("INSERT INTO sessions(token_hash,csrf_token,expires_at,username) VALUES(?,?,?,?)")
      .run(tokenHash, csrf, Date.now() + 60 * 60 * 1000, admin.username);
    return { cookie: token, csrf, username: admin.username, tokenHash };
  } finally { db.close(); }
}

function clearPriorSchoolData(path: string, calendar: SchoolCalendar, bellSettings: BellSettings): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  try {
    const known = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const statements = [
      "DELETE FROM lessons", "DELETE FROM schedule_days", "DELETE FROM plan_baselines",
      "DELETE FROM teacher_lesson_origins", "DELETE FROM teacher_teaching_assignments",
      "DELETE FROM teacher_reassignment_operations", "DELETE FROM temporary_teacher_replacements",
      "DELETE FROM teacher_replacement_operations", "DELETE FROM published_quarters", "DELETE FROM publication_replays",
      "DELETE FROM curricula", "DELETE FROM study_plans", "DELETE FROM quarters",
      "DELETE FROM request_replays", "DELETE FROM catalog_group_auto_rooms", "DELETE FROM catalog_teacher_subjects",
      "DELETE FROM catalog_subgroups", "DELETE FROM catalog_groups", "DELETE FROM catalog_teachers",
      "DELETE FROM catalog_rooms", "DELETE FROM catalog_subjects",
    ];
    db.transaction(() => { for (const sql of statements) {
      const match = /^DELETE FROM ([a-z_]+)$/.exec(sql);
      if (match && known.has(match[1]!)) db.exec(sql);
    }
    // Both APIs update singleton rows and do not insert them when missing.
    // Keep their IDs present so later API writes cannot silently affect zero rows.
    if (known.has("school_calendar")) db.prepare("INSERT INTO school_calendar(id,calendar_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET calendar_json=excluded.calendar_json").run(JSON.stringify(calendar));
    if (known.has("bell_settings")) db.prepare("INSERT INTO bell_settings(id,settings_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json").run(JSON.stringify(bellSettings));
    })();
  } finally { db.close(); }
}

function readCurriculum(path: string): CurriculumInput {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CurriculumInput;
  if (!Array.isArray(raw.subjects) || !Array.isArray(raw.weeklyByEra) || raw.weeklyByEra.length !== 3)
    throw new Error("Файл плана должен содержать предметы и планы на 2024, 2025 и 2026 учебные годы");
  const subjectIds = new Set(raw.subjects.map(subject => subject.id));
  for (const era of raw.weeklyByEra) {
    if (!era.grades || Object.keys(era.grades).length !== 11) throw new Error(`В плане ${era.fromSchoolYear} отсутствуют классы 1–11`);
    for (const [grade, subjects] of Object.entries(era.grades)) {
      if (!/^(?:[1-9]|1[01])$/.test(grade)) throw new Error(`Некорректный номер класса: ${grade}`);
      for (const [subjectId, hours] of Object.entries(subjects))
        if (!subjectIds.has(subjectId) || !Number.isInteger(hours) || hours < 0 || hours > 10)
          throw new Error(`Некорректные часы или предмет ${subjectId} для ${grade} класса`);
    }
  }
  return raw;
}

function gradeClassCount(grade: number): number { return grade === 1 ? 9 : grade % 2 === 0 ? 6 : 7; }
function groupId(grade: number, letter: string): string { return `grade-${grade}-${letter}`; }
function quarterData(): { quarters: Quarter[]; calendar: SchoolCalendar } {
  const quarters: Quarter[] = [];
  const periods: SchoolCalendar["periods"] = [];
  for (const schoolYear of schoolYearGroups) {
    schoolYear.quarters.forEach(([startDate, endDate], index) => {
      quarters.push({ id: `quarter-${schoolYear.year}-${index + 1}`, name: `${index + 1} четверть · ${schoolYear.year}/${schoolYear.year + 1}`, startDate, endDate });
    });
    const holidays = schoolYear.year === 2024
      ? [["2024-10-26", "2024-11-04", "Осенние каникулы"], ["2024-12-29", "2025-01-08", "Зимние каникулы"], ["2025-03-22", "2025-03-30", "Весенние каникулы"], ["2025-05-25", "2025-08-31", "Летние каникулы"]]
      : schoolYear.year === 2025
        ? [["2025-10-25", "2025-11-02", "Осенние каникулы"], ["2025-12-27", "2026-01-08", "Зимние каникулы"], ["2026-03-21", "2026-03-29", "Весенние каникулы"], ["2026-05-24", "2026-08-31", "Летние каникулы"]]
        : [["2026-10-24", "2026-11-01", "Осенние каникулы"], ["2026-12-26", "2027-01-10", "Зимние каникулы"]];
    for (const [index, [startDate, endDate, name]] of holidays.entries()) periods.push({ id: `holiday-${schoolYear.year}-${index + 1}`, name: name!, kind: "holiday", startDate: startDate!, endDate: endDate!, groupIds: null });
  }
  const groupWeekdays: Record<string, number[]> = {};
  for (let grade = 5; grade <= 11; grade += 1)
    for (const letter of letters.slice(0, gradeClassCount(grade))) groupWeekdays[groupId(grade, letter)] = [1, 2, 3, 4, 5, 6];
  return { quarters, calendar: { weekdays: [1, 2, 3, 4, 5], groupWeekdays, periods } };
}

function makePeopleAndCatalog(input: CurriculumInput): { catalog: Catalog; groups: CatalogGroup[]; subgroups: CatalogSubgroup[]; teacherCount: number; roomCount: number } {
  const groups: CatalogGroup[] = [], subgroups: CatalogSubgroup[] = [];
  const rooms: CatalogRoom[] = [], teachers: CatalogTeacher[] = [];
  for (let grade = 1; grade <= 11; grade += 1) for (const letter of letters.slice(0, gradeClassCount(grade))) {
    const id = groupId(grade, letter), roomId = `room-home-${grade}-${letter}`;
    rooms.push({ id: roomId, name: `${100 + grade}${letter === "А" ? "1" : String(letters.indexOf(letter) + 1)}`, capacity: 32, kind: "general", archived: false });
    groups.push({ id, name: `${grade}${letter}`, students: 28, leaderId: null, roomId, autoRoomIds: [roomId], archived: false });
    if (grade >= 5) {
      const names = makeSubgroupNames([
        { id: `subgroup-${grade}-${letter}-de`, groupName: `${grade}${letter}`, language: "german" },
        { id: `subgroup-${grade}-${letter}-zh`, groupName: `${grade}${letter}`, language: "chinese" },
      ]);
      subgroups.push({ id: `subgroup-${grade}-${letter}-de`, groupId: id, name: names.get(`subgroup-${grade}-${letter}-de`)!, students: 14, archived: false });
      subgroups.push({ id: `subgroup-${grade}-${letter}-zh`, groupId: id, name: names.get(`subgroup-${grade}-${letter}-zh`)!, students: 14, archived: false });
    }
  }
  const subjectMap = new Map(input.subjects.map(subject => [subject.id, subject]));
  const eraSubjects = new Map<string, Set<string>>();
  for (const era of input.weeklyByEra) for (const [grade, weekly] of Object.entries(era.grades)) {
    const set = eraSubjects.get(grade) ?? new Set<string>();
    Object.entries(weekly).filter(([, hours]) => hours > 0).forEach(([id]) => set.add(id));
    eraSubjects.set(grade, set);
  }
  const teacherForLeader = new Map<string, string>();
  let teacherNumber = 0;
  const hasSubject = (groupId: string, subjectId: string) => {
    const group = groups.find(entry => entry.id === groupId)!;
    const grade = Number(group.name.match(/^\d+/)?.[0]);
    if (["school:german", "school:chinese"].includes(subjectId)) return grade >= 5;
    return (eraSubjects.get(String(grade))?.has(subjectId) ?? false);
  };
  const createTeacher = (bundle: string[], eligibleGroups: string[], cap: number, shift: "morning" | "afternoon", leader = false, fixedRoomId?: string) => {
    for (let offset = 0; offset < eligibleGroups.length; offset += cap) {
      const cohort = eligibleGroups.slice(offset, offset + cap);
      const subjects = bundle.filter(subjectId => subjectMap.has(subjectId) && cohort.some(groupId => hasSubject(groupId, subjectId)));
      if (!subjects.length) continue;
      teacherNumber += 1;
      const id = `teacher-${String(teacherNumber).padStart(3, "0")}`;
      const person = teacherNames[teacherNumber - 1];
      if (!person) throw new Error(`В списке тестовых имён недостаточно записей для преподавателя ${teacherNumber}.`);
      const roomId = fixedRoomId ?? `room-teacher-${teacherNumber}`;
      const kind: RoomKind = subjects.map(subjectId => subjectMap.get(subjectId)?.roomKind).find((roomKind): roomKind is RoomKind => roomKind !== null && roomKind !== undefined) ?? "general";
      if (!fixedRoomId) {
        const roomName = `${String(400 + Math.floor((teacherNumber - 1) / 100))}${String((teacherNumber - 1) % 100 + 1).padStart(2, "0")}`;
        rooms.push({ id: roomId, name: roomName, capacity: kind === "gym" ? 120 : 32, kind, archived: false });
      }
      const teacher: CatalogTeacher = { id, name: person, subjectIds: subjects, defaultRoomId: roomId, preferredGroupIds: cohort, preferredShift: shift, archived: false };
      teachers.push(teacher);
      if (leader && subjects.includes("russian")) for (const groupId of cohort) teacherForLeader.set(groupId, id);
    }
  };
  const groupGrade = (group: CatalogGroup) => Number(group.name.match(/^\d+/)?.[0]);
  const primaryGroups = groups.filter(group => groupGrade(group) <= 4);
  const morningGroups = groups.filter(group => groupGrade(group) === 1 || groupGrade(group) >= 5);
  const afternoonGroups = groups.filter(group => groupGrade(group) >= 2 && groupGrade(group) <= 4);
  const primaryCore = input.subjects.map(subject => subject.id).filter(subjectId => !["english", "pe"].includes(subjectId));
  for (const group of primaryGroups) createTeacher(primaryCore, [group.id], 1, groupGrade(group) === 1 ? "morning" : "afternoon", true, group.roomId ?? undefined);
  const available = (subjectId: string, list: CatalogGroup[]) => list.filter(group => hasSubject(group.id, subjectId)).map(group => group.id);
  const availableBundle = (bundle: string[], list: CatalogGroup[]) => list.filter(group => bundle.some(subjectId => hasSubject(group.id, subjectId))).map(group => group.id);
  for (const [bundle, cap] of [
    [["russian", "literature"], 3], [["math", "school:algebra", "school:geometry", "school:probability-statistics"], 3],
    [["history", "school:social-studies"], 6], [["school:geography", "biology"], 6], [["physics", "school:chemistry"], 5],
    [["informatics"], 12], [["school:visual-arts", "school:music"], 9], [["school:technology"], 10],
    [["school:safety", "school:project", "school:law", "school:odnknr"], 6],
  ] as Array<[string[], number]>) createTeacher(bundle, availableBundle(bundle, groups.filter(group => groupGrade(group) >= 5)), cap, "morning", bundle.includes("russian"));
  for (const subjectId of ["english", "pe"]) {
    const cap = subjectId === "english" ? 6 : 7;
    for (const [list, shift] of [[morningGroups, "morning"], [afternoonGroups, "afternoon"]] as const)
      createTeacher([subjectId], available(subjectId, list), cap, shift);
  }
  for (const subjectId of ["school:german", "school:chinese"]) {
    if (!subjectMap.has(subjectId)) throw new Error(`В каталоге нет предмета ${subjectId}`);
    createTeacher([subjectId], groups.filter(group => groupGrade(group) >= 5).map(group => group.id), 12, "morning");
  }
  for (const group of groups) group.leaderId = teacherForLeader.get(group.id) ?? null;
  return { catalog: { subjects: input.subjects.map(subject => ({ ...subject, jointGroupSets: subject.jointGroupSets ?? [], jointSameGrade: subject.id === "pe" ? true : subject.jointSameGrade ?? false, maxJointGroups: subject.maxJointGroups ?? 2 })), teachers, rooms, groups, subgroups }, groups, subgroups, teacherCount: teachers.length, roomCount: rooms.length };
}

function buildWeeklyPlans(input: CurriculumInput, catalog: Catalog, quarters: Quarter[]): StudyPlan[] {
  const plans: StudyPlan[] = [];
  const eraAt = (schoolYear: number) => input.weeklyByEra.find(era => era.fromSchoolYear === schoolYear);
  for (const quarter of quarters) {
    const year = schoolYearForQuarter(quarter);
    const era = eraAt(year);
    if (!era) throw new Error(`Нет плана для учебного года ${year}`);
    for (const group of catalog.groups) {
      const grade = Number(group.name.match(/^\d+/)?.[0]);
      const groupPlan = era.grades[String(grade)];
      if (!groupPlan) throw new Error(`Нет плана ${grade} класса на ${year}`);
      const add = (subjectId: string, mode: StudyPlan["mode"], assignments: StudyPlan["assignments"]) => {
        if (!catalog.subjects.some(subject => subject.id === subjectId)) throw new Error(`Нет предмета ${subjectId} в каталоге`);
        plans.push({ id: `plan-${quarter.id}-${group.id}-${subjectId.replace(/[^\p{L}\p{N}]+/gu, "-")}`, quarterId: quarter.id, groupId: group.id, subjectId, mode, lessonKind: "regular", assignments });
      };
      for (const [subjectId, hours] of Object.entries(groupPlan)) if (hours > 0)
        add(subjectId, "whole", [{ id: `assignment-${quarter.id}-${group.id}-${subjectId.replace(/[^\p{L}\p{N}]+/gu, "-")}`, subgroupId: null, target: hours }]);
      if (grade >= 5) {
        const german = catalog.subgroups.find(entry => entry.groupId === group.id && entry.id.endsWith("-de"))!;
        const chinese = catalog.subgroups.find(entry => entry.groupId === group.id && entry.id.endsWith("-zh"))!;
        for (const [subjectId, subgroup] of [["school:german", german], ["school:chinese", chinese]] as const)
          add(subjectId, "subgroups", [{ id: `assignment-${quarter.id}-${group.id}-${subjectId.replace(/[^\p{L}\p{N}]+/gu, "-")}`, subgroupId: subgroup.id, target: 1 }]);
      }
    }
  }
  return plans;
}

type PatternKey = `${number}|${string}|${number}`;
type PatternBuild = { schedule: Schedule; plans: StudyPlan[]; quarterValidation: Array<{ quarterId: string; expected: number; placed: number; missing: number; extra: number }>; generation: Array<{ year: number; expected: number; added: number; remaining: number; remainingByReason: Record<string, number> }> };
type PatternCache = { version: 1; fingerprint: string; pattern: PatternBuild };

function weekday(date: string): number { return new Date(`${date}T12:00:00Z`).getUTCDay() || 7; }
function schoolYearForQuarter(quarter: Quarter): number {
  const year = Number(quarter.id.match(/^quarter-(\d{4})-/)?.[1]);
  if (!Number.isInteger(year)) throw new Error(`Некорректный идентификатор четверти: ${quarter.id}`);
  return year;
}
function assignmentKey(quarterId: string, groupId: string, subjectId: string, subgroupId: string | null): string {
  return `${quarterId}|${groupId}|${subjectId}|${subgroupId ?? "whole"}`;
}

function buildSchoolYearPatterns(state: StateResponse, weeklyPlans: StudyPlan[], input: CurriculumInput, groups: CatalogGroup[]): PatternBuild {
  let schedule = structuredClone(state.schedule);
  const templates = new Map<PatternKey, Schedule[string][number]>();
  const generation: PatternBuild["generation"] = [];
  for (const year of [2024, 2025, 2026]) {
    const templateQuarter = state.quarters.find(quarter => quarter.id === `quarter-${year}-1`)!;
    const dateRange = year === 2024 ? ["2024-09-09", "2024-09-14"] : year === 2025 ? ["2025-09-08", "2025-09-13"] : ["2026-09-07", "2026-09-12"];
    const temporaryQuarter: Quarter = { ...templateQuarter, startDate: dateRange[0]!, endDate: dateRange[1]! };
    let yearSchedule: Schedule = {};
    for (const [key, days] of Object.entries(schedule)) {
      const sampleDays = days.filter(day => day.date >= temporaryQuarter.startDate && day.date <= temporaryQuarter.endDate);
      if (sampleDays.length) yearSchedule[key] = sampleDays;
    }
    const eraPlans = weeklyPlans.filter(plan => plan.quarterId === templateQuarter.id).map(plan => {
      const grade = Number(groups.find(group => group.id === plan.groupId)?.name.match(/^\d+/)?.[0]);
      const hours = input.weeklyByEra.find(era => era.fromSchoolYear === year)?.grades[String(grade)]?.[plan.subjectId];
      const subgroupAssignment = plan.assignments.some(assignment => assignment.subgroupId);
      return { ...plan, assignments: plan.assignments.map(assignment => ({ ...assignment, target: subgroupAssignment ? 1 : (hours ?? assignment.target) })) };
    });
    const generationState = {
      catalog: state.catalog, schedule: yearSchedule, quarters: state.quarters.map(item => item.id === templateQuarter.id ? temporaryQuarter : item),
      studyPlans: eraPlans, temporaryTeacherReplacements: state.temporaryTeacherReplacements ?? [],
      teachingAssignments: state.teachingAssignments ?? [], bellSettings: state.bellSettings,
    };
    const eraReport = { year, expected: 0, added: 0, remaining: 0, remainingByReason: {} as Record<string, number> };
    for (let grade = 1; grade <= 11; grade += 1) {
      const selectedGroups = groups.filter(group => Number(group.name.match(/^\d+/)?.[0]) === grade);
      const gradePlans = eraPlans.filter(plan => selectedGroups.some(group => group.id === plan.groupId));
      const sourceExpected = new Map<string, number>();
      for (const plan of gradePlans) for (const assignment of plan.assignments) {
        const key = `${plan.groupId}|${plan.subjectId}|${assignment.subgroupId ?? "whole"}`;
        sourceExpected.set(key, (sourceExpected.get(key) ?? 0) + assignment.target);
      }
      const expected = [...sourceExpected.values()].reduce((sum, hours) => sum + hours, 0);
      let lastPercent = -1;
      const result = generateQuarter(generationState, templateQuarter.id, selectedGroups.map(group => group.id), {
        preserveExisting: true,
        allowJointLessons: false,
        onProgress: progress => { if (progress.percent !== lastPercent) { lastPercent = progress.percent; process.stdout.write(`\r${year}/${year + 1}, ${grade} классы: ${progress.percent}%`); } },
      });
      generationState.schedule = result.schedule;
      yearSchedule = result.schedule;
      const reasons: Record<string, number> = {};
      for (const item of result.remaining) reasons[item.reason] = (reasons[item.reason] ?? 0) + item.missing;
      const missing = result.remaining.reduce((sum, item) => sum + item.missing, 0);
      eraReport.expected += expected; eraReport.added += result.added.length; eraReport.remaining += missing;
      for (const [reason, count] of Object.entries(reasons)) eraReport.remainingByReason[reason] = (eraReport.remainingByReason[reason] ?? 0) + count;
      if (missing > 0 || result.added.length !== expected) throw new Error(`Недельный образец ${year}/${year + 1}, ${grade} классы не прошёл проверку: план ${expected}, добавлено ${result.added.length}, недобор ${missing}: ${JSON.stringify(reasons)}`);
      const generatedCounts = new Map<string, number>();
      for (const lesson of result.added) {
        const key = `${lesson.groupId}|${lesson.subjectId}|${lesson.subgroupId ?? "whole"}`;
        generatedCounts.set(key, (generatedCounts.get(key) ?? 0) + 1);
      }
      const mismatches = new Set([...sourceExpected.keys(), ...generatedCounts.keys()]);
      const wrong = [...mismatches].filter(key => sourceExpected.get(key) !== generatedCounts.get(key))
        .map(key => ({ assignment: key, expected: sourceExpected.get(key) ?? 0, generated: generatedCounts.get(key) ?? 0 }));
      if (wrong.length) throw new Error(`Недельный шаблон ${year}/${year + 1}, ${grade} классы не совпадает с исходными часами по предметам и подгруппам: ${JSON.stringify(wrong.slice(0, 20))}`);
    }
    generation.push(eraReport);
    process.stdout.write(`\r${year}/${year + 1}: ${eraReport.added} уроков недельного шаблона, недобор ${eraReport.remaining}\n`);
    for (const group of groups) {
      const keyPrefix = `${group.id}:`;
      for (const days of Object.entries(yearSchedule).filter(([key]) => key.startsWith(keyPrefix)).map(([, rows]) => rows))
        for (const day of days) if (day.date >= temporaryQuarter.startDate && day.date <= temporaryQuarter.endDate)
          templates.set(`${year}|${group.id}|${weekday(day.date)}`, structuredClone(day));
      if (Number(group.name.match(/^\d+/)?.[0]) >= 5) {
        const saturday = Object.entries(yearSchedule).filter(([key]) => key.startsWith(keyPrefix))
          .flatMap(([, days]) => days).find(day => day.date === dateRange[1]);
        if (!saturday || weekday(saturday.date) !== 6 || saturday.holiday)
          throw new Error(`В календарной сетке ${year}/${year + 1} для ${group.name} отсутствует учебная суббота`);
      }
    }
    const saturdayLessons = Object.entries(yearSchedule).filter(([key]) => groups.some(group => key.startsWith(`${group.id}:`) && Number(group.name.match(/^\d+/)?.[0]) >= 5))
      .flatMap(([, days]) => days).filter(day => weekday(day.date) === 6).reduce((sum, day) => sum + day.slots.flat().length, 0);
    if (saturdayLessons === 0) throw new Error(`Недельный образец ${year}/${year + 1} не содержит субботних уроков`);
  }
  const plansByQuarter = new Map<string, Map<string, { plan: StudyPlan; targets: Map<string, number> }>>();
  const calendar = state.calendar!;
  const expectedCounts = new Map<string, number>();
  for (const quarter of state.quarters) for (const group of groups) {
    const grade = Number(group.name.match(/^\d+/)?.[0]);
    const year = schoolYearForQuarter(quarter);
    const activeWeekdays = grade <= 4 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
    for (let stamp = Date.parse(`${quarter.startDate}T12:00:00Z`); stamp <= Date.parse(`${quarter.endDate}T12:00:00Z`); stamp += 86400000) {
      const date = new Date(stamp).toISOString().slice(0, 10), dayOfWeek = weekday(date);
      if (!activeWeekdays.includes(dayOfWeek) || calendarDay(calendar, group.id, date).holiday) continue;
      const pattern = templates.get(`${year}|${group.id}|${dayOfWeek}`);
      if (!pattern) throw new Error(`Нет недельного шаблона для ${group.name}, ${date}`);
      for (const [slotIndex, slot] of pattern.slots.entries()) {
        for (const lesson of slot) {
          const countKey = assignmentKey(quarter.id, group.id, lesson.subjectId, lesson.subgroupId ?? null);
          expectedCounts.set(countKey, (expectedCounts.get(countKey) ?? 0) + 1);
        }
      }
    }
  }
  for (const quarter of state.quarters) for (const group of groups) {
    const quarterPlans = weeklyPlans.filter(plan => plan.quarterId === quarter.id && plan.groupId === group.id);
    for (const plan of quarterPlans) {
      const assignments = plan.assignments.flatMap(assignment => {
        const count = expectedCounts.get(assignmentKey(quarter.id, group.id, plan.subjectId, assignment.subgroupId)) ?? 0;
        return count > 0 ? [{ ...assignment, target: count }] : [];
      });
      if (!assignments.length) continue;
      const byId = plansByQuarter.get(quarter.id) ?? new Map<string, { plan: StudyPlan; targets: Map<string, number> }>();
      byId.set(plan.id, { plan: { ...plan, assignments }, targets: new Map(assignments.map(assignment => [assignment.subgroupId ?? "whole", assignment.target])) });
      plansByQuarter.set(quarter.id, byId);
    }
  }
  for (const quarter of state.quarters) for (const group of groups) {
    const year = schoolYearForQuarter(quarter);
    const activeWeekdays = Number(group.name.match(/^\d+/)?.[0]) <= 4 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
    for (let stamp = Date.parse(`${quarter.startDate}T12:00:00Z`); stamp <= Date.parse(`${quarter.endDate}T12:00:00Z`); stamp += 86400000) {
      const date = new Date(stamp).toISOString().slice(0, 10);
      if (!activeWeekdays.includes(weekday(date)) || calendarDay(calendar, group.id, date).holiday) continue;
      const key = `${group.id}:${weekOffsetFor(date)}`;
      const day = schedule[key]?.find(item => item.date === date);
      const pattern = templates.get(`${year}|${group.id}|${weekday(date)}`);
      if (!day || !pattern) throw new Error(`Нет дня или шаблона для ${group.name}, ${date}`);
      for (const [slotIndex, slot] of pattern.slots.entries()) {
        const destination = day.slots[slotIndex];
        if (!destination) throw new Error(`${group.name}, ${date}: отсутствует урок №${slotIndex + 1} в календарной сетке`);
        destination.push(...slot.map((lesson, index) => ({ ...lesson, id: `${group.id}-${weekOffsetFor(date)}-${date}-${slotIndex}-${index}` })));
      }
    }
  }
  const placedCounts = new Map<string, number>();
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days) for (const lesson of day.slots.flat()) {
      if (lesson.event || !state.quarters.some(quarter => day.date >= quarter.startDate && day.date <= quarter.endDate)) continue;
      const quarter = state.quarters.find(item => day.date >= item.startDate && day.date <= item.endDate)!;
      const countKey = assignmentKey(quarter.id, groupId, lesson.subjectId, lesson.subgroupId ?? null);
      placedCounts.set(countKey, (placedCounts.get(countKey) ?? 0) + 1);
    }
  }
  const countMismatches = [...expectedCounts.entries()].filter(([key, expected]) => placedCounts.get(key) !== expected);
  if (countMismatches.length) throw new Error(`Число фактически скопированных уроков не совпало с независимым календарным расчётом: ${JSON.stringify(countMismatches.slice(0, 10))}`);
  const finalPlans = [...plansByQuarter.values()].flatMap(byId => [...byId.values()].map(item => item.plan));
  // Ensure the distribution phase did not exceed the requested daily caps.
  for (const [key, days] of Object.entries(schedule)) {
    const grade = Number(groups.find(group => group.id === key.slice(0, key.lastIndexOf(":")))?.name.match(/^\d+/)?.[0]);
    const maxLessons = grade <= 4 ? 5 : 7;
    for (const day of days) {
      const lessons = day.slots.filter(slot => slot.length > 0).length;
      if (!day.holiday && lessons > maxLessons) throw new Error(`${key} ${day.date}: ${lessons} уроков, дневной предел ${maxLessons}`);
    }
  }
  const quarterValidation = state.quarters.map(quarter => {
    const planned = finalPlans.filter(plan => plan.quarterId === quarter.id);
    const expected = planned.flatMap(plan => plan.assignments).reduce((sum, assignment) => sum + assignment.target, 0);
    let placed = 0;
    for (const [key, days] of Object.entries(schedule)) for (const day of days) {
      if (day.date < quarter.startDate || day.date > quarter.endDate) continue;
      placed += day.slots.flat().filter(lesson => !lesson.event).length;
    }
    return { quarterId: quarter.id, expected, placed, missing: Math.max(0, expected - placed), extra: Math.max(0, placed - expected) };
  });
  if (quarterValidation.some(item => item.missing !== 0 || item.extra !== 0))
    throw new Error(`Проверка квартальных планов не пройдена: ${JSON.stringify(quarterValidation.filter(item => item.missing || item.extra))}`);
  return { schedule, plans: finalPlans, quarterValidation, generation };
}

function quartersAndCalendar(): { quarters: Quarter[]; calendar: SchoolCalendar } { return quarterData(); }

function buildCurricula(plans: StudyPlan[], catalog: Catalog, quarters: Quarter[]): Curriculum[] {
  const curricula: Curriculum[] = [];
  for (const quarter of quarters) for (const group of catalog.groups) {
    const groupPlans = plans.filter(plan => plan.quarterId === quarter.id && plan.groupId === group.id);
    if (!groupPlans.length) throw new Error(`Не сформирован учебный план для ${group.name}, ${quarter.name}`);
    const rows = groupPlans.map(plan => {
      if (plan.assignments.length !== 1) throw new Error(`План ${group.name} · ${plan.subjectId} содержит несколько назначений`);
      const assignment = plan.assignments[0]!;
      return {
        id: `row-${quarter.id}-${group.id}-${plan.subjectId.replace(/[^\p{L}\p{N}]+/gu, "-")}`,
        subjectId: plan.subjectId,
        lessonKind: plan.lessonKind,
        mode: plan.mode,
        hours: assignment.target,
        ...(assignment.subgroupId ? { subgroupIdsByGroup: { [group.id]: [assignment.subgroupId] } } : {}),
      };
    });
    curricula.push({ id: `curriculum-${quarter.id}-${group.id}`, name: `${group.name} · ${quarter.name}`, quarterId: quarter.id, groupIds: [group.id], rows });
  }
  return mergeGradeCurricula(curricula, catalog);
}

function planSnapshot(plans: StudyPlan[]): string {
  const rows = plans.flatMap(plan => plan.assignments.map(assignment => ({
    quarterId: plan.quarterId, groupId: plan.groupId, subjectId: plan.subjectId,
    mode: plan.mode, lessonKind: plan.lessonKind, subgroupId: assignment.subgroupId, target: assignment.target,
  })));
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(rows);
}

function apiHeaders(session: ReturnType<typeof syntheticSession>) { return { origin, host: "127.0.0.1", cookie: `smena_session=${session.cookie}`, "x-csrf-token": session.csrf }; }
async function put(app: Awaited<ReturnType<typeof buildApp>>, url: string, headers: ReturnType<typeof apiHeaders>, payload: Record<string, unknown>): Promise<StateResponse> {
  const response = await app.inject({ method: "PUT", url, headers, payload });
  if (response.statusCode !== 200) throw new Error(`${url} вернул ${response.statusCode}: ${response.body.slice(0, 1200)}`);
  return response.json() as StateResponse;
}

async function getState(app: Awaited<ReturnType<typeof buildApp>>, headers: ReturnType<typeof apiHeaders>): Promise<StateResponse> {
  const response = await app.inject({ url: "/api/state", headers });
  if (response.statusCode !== 200) throw new Error(`/api/state вернул ${response.statusCode}: ${response.body.slice(0, 1200)}`);
  return response.json() as StateResponse;
}

function timeForGroup(day: Schedule[string][number], grade: number, secondShift: boolean): void {
  const count = grade <= 4 ? 5 : 7;
  const duration = grade === 1 ? 35 : grade <= 4 ? 40 : 45;
  const breaks = Array.from({ length: count - 1 }, (_, index) => grade >= 5 && index === 2 ? 15 : 10);
  const start = secondShift ? 13 * 60 + 30 : 8 * 60;
  let cursor = start;
  day.start = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  day.duration = duration;
  day.breaks = breaks;
  day.times = Array.from({ length: count }, (_, index) => { const time = { start: cursor, duration }; cursor += duration + (breaks[index] ?? 0); return time; });
  day.slots = Array.from({ length: count }, () => []);
  day.bellProfile = { start, duration, breaks } satisfies BellProfile;
}

function patternFingerprint(state: StateResponse, input: CurriculumInput): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    input,
    catalog: state.catalog,
    quarters: state.quarters,
    calendar: state.calendar,
    bellSettings: state.bellSettings,
    schedule: state.schedule,
  })).digest("hex");
}

function cachedPattern(path: string, fingerprint: string): PatternBuild | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as PatternCache;
    if (cache.version !== 1 || cache.fingerprint !== fingerprint || !cache.pattern ||
      !Array.isArray(cache.pattern.plans) || !Array.isArray(cache.pattern.generation) ||
      !Array.isArray(cache.pattern.quarterValidation) || !cache.pattern.schedule ||
      cache.pattern.generation.some(item => item.remaining !== 0 || item.expected !== item.added) ||
      cache.pattern.quarterValidation.some(item => item.missing !== 0 || item.extra !== 0 || item.expected !== item.placed)) return undefined;
    return cache.pattern;
  } catch { return undefined; }
}

async function run(cli: Cli): Promise<void> {
  assertDbIntegrity(cli.db);
  const input = readCurriculum(cli.curriculum);
  const { catalog, teacherCount, roomCount } = makePeopleAndCatalog(input);
  if (catalog.groups.length !== 74 || teacherCount > 500 || roomCount > 500 || catalog.subgroups.length > 1000)
    throw new Error(`Каталог превышает ожидаемые ограничения: groups=${catalog.groups.length}, teachers=${teacherCount}, rooms=${roomCount}, subgroups=${catalog.subgroups.length}`);
  const { quarters, calendar } = quartersAndCalendar();
  const weeklyPlans = buildWeeklyPlans(input, catalog, quarters);
  if (quarters.length > 12 || weeklyPlans.length > 20_000) throw new Error(`Слишком много планов: quarters=${quarters.length}, plans=${weeklyPlans.length}`);
  const session = syntheticSession(cli.db);
  const app = await buildApp({ dbPath: cli.db, serveStatic: false });
  const headers = apiHeaders(session);
  let state: StateResponse;
  try {
    const before = await app.inject({ url: "/api/state", headers });
    if (before.statusCode !== 200) throw new Error(`Не удалось открыть временную копию через API: ${before.statusCode}`);
    const oldState = before.json() as StateResponse;
    const oldSchoolName = oldState.displaySettings?.settings.schoolName ?? "";
    console.log(`Очистка только временной копии: ${cli.db}`);
    const bellSettings = defaultBellSettings();
    bellSettings.school = { start: 8 * 60, duration: 45, breaks: [10, 10, 15, 10, 10, 10] };
    clearPriorSchoolData(cli.db, calendar, bellSettings);
    state = await put(app, "/api/catalog", headers, { catalog, revision: oldState.revision, requestId: randomUUID() });
    const planState = await put(app, "/api/plans", headers, { quarters, studyPlans: weeklyPlans, revision: state.revision, requestId: randomUUID() });
    state = planState;
    state = await put(app, "/api/calendar", headers, { calendar, confirmLessonRemoval: false, revision: state.revision, requestId: randomUUID() });
    assert.deepEqual(state.calendar, calendar, "Календарь после API-записи отличается от переданного; проверьте singleton school_calendar");
    for (const group of catalog.groups) {
      const grade = Number(group.name.match(/^\d+/)?.[0]);
      const expectedWeekdays = grade <= 4 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6];
      assert.deepEqual(state.calendar?.groupWeekdays?.[group.id] ?? state.calendar?.weekdays, expectedWeekdays,
        `Не сохранились учебные дни для группы ${group.name}`);
    }
    state = await put(app, "/api/bell-settings", headers, { settings: bellSettings, revision: state.revision, requestId: randomUUID() });
    assert.deepEqual(state.bellSettings, bellSettings, "Звонки после API-записи отличаются от переданных; проверьте singleton bell_settings");
    if ((state.displaySettings?.settings.schoolName ?? "") !== oldSchoolName) throw new Error("Сохранённое название школы неожиданно изменилось");

    const adjusted: Schedule = structuredClone(state.schedule);
    for (const [key, days] of Object.entries(adjusted)) {
      const groupId = key.slice(0, key.lastIndexOf(":"));
      const group = catalog.groups.find(item => item.id === groupId)!;
      const grade = Number(group.name.match(/^\d+/)?.[0]);
      const secondShift = grade >= 2 && grade <= 4;
      for (const day of days) {
        timeForGroup(day, grade, secondShift);
        day.holiday = calendarDay(calendar, groupId, day.date).holiday;
      }
    }
    await put(app, "/api/state", headers, { schedule: adjusted, revision: state.revision, requestId: randomUUID() });
    state = await getState(app, headers);

    const patternCachePath = `${cli.db}.full-school-pattern.json`;
    const fingerprint = patternFingerprint(state, input);
    let pattern = cachedPattern(patternCachePath, fingerprint);
    if (pattern) console.log(`Использую проверенные недельные образцы из ${patternCachePath}`);
    else {
      pattern = buildSchoolYearPatterns(state, weeklyPlans, input, catalog.groups);
      const cache: PatternCache = { version: 1, fingerprint, pattern };
      writeFileSync(patternCachePath, JSON.stringify(cache), { mode: 0o600 });
      console.log(`Сохранён шаблон генерации для повторного запуска: ${patternCachePath}`);
    }
    const curricula = buildCurricula(pattern.plans, state.catalog, state.quarters);
    const normalizedPlans = projectCurricula(curricula, pattern.plans, state.catalog);
    const normalizedAssignmentCount = normalizedPlans.flatMap(plan => plan.assignments).filter(assignment => {
      const previous = pattern.plans.find(candidate => candidate.id === plan.id)?.assignments.find(item => item.id === assignment.id);
      return previous && previous.target !== assignment.target;
    }).length;
    state = await put(app, "/api/curricula", headers, { curricula, confirmGroupReplacement: true, revision: state.revision, requestId: randomUUID() });
    if (planSnapshot(state.studyPlans) !== planSnapshot(normalizedPlans)) throw new Error("Планы после сохранения curricula отличаются от нормализованных четвертных целей");
    const scheduleResponse = await app.inject({ method: "PUT", url: "/api/state", headers, payload: { schedule: pattern.schedule, revision: state.revision, requestId: randomUUID() } });
    if (scheduleResponse.statusCode !== 200) throw new Error(`/api/state вернул ${scheduleResponse.statusCode}: ${scheduleResponse.body.slice(0, 1200)}`);
    const allLessons = Object.values(pattern.schedule).flatMap(days => days.flatMap(day => day.slots.flat())).filter(lesson => !lesson.event);
    const checkDb = new Database(cli.db, { readonly: true });
    const persistedCount = checkDb.prepare("SELECT COUNT(*) AS count FROM lessons").get() as { count: number };
    checkDb.close();
    if (persistedCount.count !== allLessons.length) throw new Error(`После записи SQLite хранит ${persistedCount.count} уроков, ожидалось ${allLessons.length}`);
    const report = {
      createdAt: new Date().toISOString(), database: cli.db, startDate: "2024-09-02", endDate: "2026-12-31",
      schoolName: state.displaySettings?.settings.schoolName ?? "", groups: state.catalog.groups.length,
      teachers: state.catalog.teachers.length, rooms: state.catalog.rooms.length, subgroups: state.catalog.subgroups.length,
      normalizedStudyPlanAssignments: normalizedAssignmentCount,
      quarters: state.quarters.length, studyPlans: state.studyPlans.length, curricula: state.curricula?.length ?? 0, lessons: allLessons.length,
      saturdayGroups: state.catalog.groups.filter(group => Number(group.name.match(/^\d+/)?.[0]) >= 5).length,
      firstShiftGroups: state.catalog.groups.filter(group => Number(group.name.match(/^\d+/)?.[0]) === 1 || Number(group.name.match(/^\d+/)?.[0]) >= 5).length,
      secondShiftGroups: state.catalog.groups.filter(group => { const grade = Number(group.name.match(/^\d+/)?.[0]); return grade >= 2 && grade <= 4; }).length,
      weeklyPatternGeneration: pattern.generation, quarterPlanValidation: pattern.quarterValidation,
      generationMethod: "Для каждого учебного года один полный учебный шаблон создан через generateQuarter. Его будние и субботние уроки повторены на учебные даты соответствующих четвертей; каникулы исключены. Полная автоматическая генерация каждой четверти не выполнялась.",
      sources: input.sources ?? [], assumptions: input.assumptions ?? [],
      note: "Тестовая учебная модель: стабильные группы 1–11, без индивидуального перехода учеников между годами; календарь каникул условный; мероприятия не создавались.",
    };
    const reportPath = cli.report ?? join(dirname(cli.db), "full-school-report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(`Подготовлено: ${allLessons.length} уроков в ${state.catalog.groups.length} группах. Отчёт: ${reportPath}`);
  } finally {
    const db = new Database(cli.db);
    try { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(session.tokenHash); } finally { db.close(); }
    await app.close();
  }
  assertDbIntegrity(cli.db);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  await run(cli);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? (error.stack ?? error.message) : String(error)); process.exitCode = 1; });
}
