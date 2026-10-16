import Database from "better-sqlite3";
import { chmodSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabaseBackup } from "./database-backup.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Curriculum, CurriculumRow } from "../shared/curricula.ts";
import { projectCurricula, validateCurricula } from "../shared/curricula.ts";
import type { Quarter, StudyPlan, PlanAssignment } from "../shared/plans.ts";
import type { TeacherLessonOrigin } from "../shared/teacherReassignment.ts";

type Options = { db: string; names: string; backup: string };
type TeacherRow = { id: string; name: string };
type CurriculumRecord = { id: string; curriculum_json: string };

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const normalizedName = (value: string) => value.trim().toLocaleLowerCase("ru");
const gradeOf = (name: string) => {
  const match = name.trim().match(/^(1[01]|[1-9])(?=$|[\sА-ЯЁA-Z-])/iu);
  return match ? Number(match[1]) : null;
};
const rowOrder = (a: CurriculumRow, b: CurriculumRow) => a.subjectId.localeCompare(b.subjectId, "en") || a.lessonKind.localeCompare(b.lessonKind) || a.mode.localeCompare(b.mode);

function parseArguments(args: string[]): Options {
  const values = new Map<string, string>();
  let confirmed = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--confirm-test-school") {
      if (confirmed) throw new Error("--confirm-test-school was supplied twice");
      confirmed = true;
      continue;
    }
    const value = args[index + 1];
    if (!["--db", "--names", "--backup"].includes(key ?? "") || !value || value.startsWith("--") || values.has(key!))
      throw new Error("Usage: node scripts/refine-full-school-data.ts --db PATH --names JSON --backup PATH --confirm-test-school");
    values.set(key!, value);
    index += 1;
  }
  if (!confirmed) throw new Error("Pass --confirm-test-school to authorize changes to the synthetic school database.");
  const db = values.get("--db"), names = values.get("--names"), backup = values.get("--backup");
  if (!db || !names || !backup) throw new Error("--db, --names, and --backup are required.");
  const absoluteDb = resolve(db), absoluteBackup = resolve(backup);
  if (absoluteDb === absoluteBackup)
    throw new Error("Database and backup paths must be different.");
  statSync(absoluteDb);
  if (basename(absoluteDb) === "smena.sqlite" && !confirmed) throw new Error("Refusing an unconfirmed production database.");
  return { db: absoluteDb, names: resolve(names), backup: absoluteBackup };
}

function loadNames(path: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.some(value => typeof value !== "string" || !value.trim()))
    throw new Error("--names must contain a JSON array of non-empty full names.");
  const names = raw.map(value => (value as string).trim());
  if (names.some(name => name.length > 120 || name.split(/\s+/u).length < 2))
    throw new Error("Each teacher name must contain a surname and given name and be at most 120 characters.");
  if (new Set(names.map(normalizedName)).size !== names.length) throw new Error("Teacher names must be unique.");
  if (new Set(names.map(name => normalizedName(name.split(/\s+/u)[0]!))).size !== names.length)
    throw new Error("Each teacher must have a distinct surname.");
  return names;
}

function readTable(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name));
}

function assertSyntheticSchool(db: Database.Database): TeacherRow[] {
  const groups = db.prepare("SELECT id,name FROM catalog_groups ORDER BY id").all() as Array<{ id: string; name: string }>;
  const teachers = db.prepare("SELECT id,name FROM catalog_teachers ORDER BY id").all() as TeacherRow[];
  const syntheticGroup = /^grade-(?:[1-9]|1[01])-[А-ЯЁ]$/u;
  const gradeGroups = groups.filter(group => syntheticGroup.test(group.id) && gradeOf(group.name) !== null);
  if (gradeGroups.length < 50 || gradeGroups.length !== groups.length)
    throw new Error(`Refusing this database: expected a synthetic school with at least 50 grade-* groups, found ${gradeGroups.length}/${groups.length}.`);
  if (teachers.length < 30 || teachers.some(teacher => !/^teacher-\d{3,}$/u.test(teacher.id)))
    throw new Error("Refusing this database: synthetic teacher IDs teacher-NNN were not found.");
  const lessonColumns = readTable(db, "lessons");
  if (!lessonColumns.has("teacher_ref")) throw new Error("The lessons table has no teacher_ref column.");
  for (const table of ["published_quarters", "teacher_lesson_origins", "curricula", "study_plans", "plan_assignments", "draft_metadata"])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`Required table is missing: ${table}`);
  return teachers;
}

function readCatalogForCurricula(db: Database.Database): Catalog {
  const groups = db.prepare("SELECT id,name,students,leader_id AS leaderId,room_id AS roomId,archived FROM catalog_groups").all()
    .map(row => ({ ...(row as object), archived: Boolean((row as { archived: number }).archived), autoRoomIds: [] }));
  const subjects = db.prepare("SELECT id,name,short_name AS shortName,color,archived FROM catalog_subjects").all()
    .map(row => ({ ...(row as object), archived: Boolean((row as { archived: number }).archived), roomKind: null, labRoomKind: null }));
  const subgroups = db.prepare("SELECT id,name,group_id AS groupId,students,archived FROM catalog_subgroups").all()
    .map(row => ({ ...(row as object), archived: Boolean((row as { archived: number }).archived) }));
  return { groups, subjects, subgroups, teachers: [], rooms: [] } as unknown as Catalog;
}

function readQuarters(db: Database.Database): Quarter[] {
  return db.prepare("SELECT id,name,start_date AS startDate,end_date AS endDate,archived FROM quarters").all()
    .map(raw => { const item = raw as Quarter & { archived: number }; return item.archived ? { ...item, archived: true } : (({ archived: _archived, ...quarter }) => quarter)(item); });
}

function readCurricula(db: Database.Database): Curriculum[] {
  return (db.prepare("SELECT id,curriculum_json FROM curricula ORDER BY id").all() as CurriculumRecord[]).map(record => {
    const item = JSON.parse(record.curriculum_json) as Curriculum;
    if (item.id !== record.id || !Array.isArray(item.groupIds) || !Array.isArray(item.rows)) throw new Error(`Malformed curriculum ${record.id}.`);
    return item;
  });
}

export function mergeGradeCurricula(curricula: Curriculum[], catalog: Catalog): Curriculum[] {
  type GroupPlan = { grade: number; quarterId: string; groupId: string; rows: CurriculumRow[] };
  const plans: GroupPlan[] = [];
  const untouched: Curriculum[] = [];
  const seenOwners = new Set<string>();
  for (const item of curricula) {
    const gradeGroups = item.groupIds.flatMap(groupId => {
      const group = catalog.groups.find(candidate => candidate.id === groupId);
      const grade = group ? gradeOf(group.name) : null;
      return grade === null ? [] : [{ groupId, grade }];
    });
    const unknown = item.groupIds.filter(groupId => !catalog.groups.some(group => group.id === groupId));
    if (unknown.length) throw new Error(`Curriculum ${item.id} references unknown groups: ${unknown.join(", ")}`);
    const gradeIds = new Set(gradeGroups.map(item => item.groupId));
    const nonGradeIds = item.groupIds.filter(groupId => !gradeIds.has(groupId));
    if (nonGradeIds.length) {
      const rows = item.rows.map(row => {
        if (!row.subgroupIdsByGroup) return row;
        const subgroupIdsByGroup = Object.fromEntries(Object.entries(row.subgroupIdsByGroup).filter(([groupId]) => nonGradeIds.includes(groupId)));
        const { subgroupIdsByGroup: _old, ...rest } = row;
        return Object.keys(subgroupIdsByGroup).length ? { ...rest, subgroupIdsByGroup } : rest;
      });
      untouched.push({ ...item, groupIds: nonGradeIds, rows });
    } else if (!gradeGroups.length) untouched.push(item);
    for (const { groupId, grade } of gradeGroups) {
      const owner = JSON.stringify([item.quarterId, groupId]);
      if (seenOwners.has(owner)) throw new Error(`Group ${groupId} has more than one curriculum in ${item.quarterId}.`);
      seenOwners.add(owner);
      const rows = item.rows.map(row => {
        const selected = row.subgroupIdsByGroup?.[groupId];
        const { subgroupIdsByGroup: _allGroups, ...rest } = row;
        return selected ? { ...rest, subgroupIdsByGroup: { [groupId]: [...selected] } } : rest;
      }).sort(rowOrder);
      plans.push({ grade, quarterId: item.quarterId, groupId, rows });
    }
  }

  const grouped = new Map<string, GroupPlan[]>();
  for (const plan of plans) {
    const key = JSON.stringify([plan.grade, plan.quarterId]);
    const values = grouped.get(key) ?? [];
    values.push(plan); grouped.set(key, values);
  }
  const records = [...grouped.values()].map(members => {
    members.sort((a, b) => a.groupId.localeCompare(b.groupId));
    const first = members[0]!;
    const bySubject = new Map<string, Array<{ member: GroupPlan; row: CurriculumRow }>>();
    for (const member of members) for (const row of member.rows) {
      const key = JSON.stringify([row.subjectId, row.lessonKind]);
      const values = bySubject.get(key) ?? [];
      values.push({ member, row }); bySubject.set(key, values);
    }
    const rows = [...bySubject.values()].map(values => {
      const firstRow = values[0]!.row;
      if (values.some(({ row }) => row.mode !== firstRow.mode))
        throw new Error(`Grade ${first.grade} has conflicting modes for ${firstRow.subjectId}/${firstRow.lessonKind} in ${first.quarterId}.`);
      const hourValues = values.map(({ row }) => row.hours).sort((a, b) => a - b);
      const middle = Math.floor(hourValues.length / 2);
      const hours = hourValues.length % 2 ? hourValues[middle]! : Math.round((hourValues[middle - 1]! + hourValues[middle]!) / 2);
      const subgroupIdsByGroup: Record<string, string[]> = {};
      for (const { member, row } of values) {
        const selected = row.subgroupIdsByGroup?.[member.groupId];
        if (selected) subgroupIdsByGroup[member.groupId] = [...selected];
      }
      return {
        id: `row-${first.grade}-${hash(JSON.stringify([first.quarterId, firstRow.subjectId, firstRow.lessonKind]))}`,
        subjectId: firstRow.subjectId, lessonKind: firstRow.lessonKind, mode: firstRow.mode, hours,
        ...(Object.keys(subgroupIdsByGroup).length ? { subgroupIdsByGroup } : {}),
      } satisfies CurriculumRow;
    }).sort(rowOrder);
    return { grade: first.grade, quarterId: first.quarterId, groupIds: members.map(item => item.groupId), rows };
  });
  const familyNames = new Map<string, string>();
  for (const record of records) familyNames.set(`school-grade-${record.grade}`, `${record.grade} класс`);
  const usedNames = new Map<string, string>();
  for (const item of untouched) usedNames.set(normalizedName(item.name), item.templateId ?? item.id);
  const next = [...untouched];
  for (const record of records.sort((a, b) => a.quarterId.localeCompare(b.quarterId) || a.grade - b.grade)) {
    const family = `school-grade-${record.grade}`;
    const base = familyNames.get(family)!;
    let name = base, suffix = 2;
    while (usedNames.has(normalizedName(name)) && usedNames.get(normalizedName(name)) !== family) name = `${base} · вариант ${suffix++}`;
    usedNames.set(normalizedName(name), family);
    const id = `curriculum-grade-${record.grade}-${record.quarterId}`;
    next.push({ id, name, templateId: family, quarterId: record.quarterId, groupIds: record.groupIds, rows: record.rows });
  }
  return next;
}

function readStudyPlans(db: Database.Database): StudyPlan[] {
  const plans = db.prepare("SELECT id,quarter_id AS quarterId,group_id AS groupId,subject_id AS subjectId,mode,lesson_kind AS lessonKind FROM study_plans ORDER BY quarter_id,group_id,subject_id,lesson_kind").all() as Array<Omit<StudyPlan, "assignments">>;
  const assignments = db.prepare("SELECT id,plan_id AS planId,subgroup_id AS subgroupId,target FROM plan_assignments ORDER BY plan_id,id").all() as Array<PlanAssignment & { planId: string }>;
  const byPlan = new Map<string, PlanAssignment[]>();
  for (const { planId, ...assignment } of assignments) { const rows = byPlan.get(planId) ?? []; rows.push(assignment); byPlan.set(planId, rows); }
  return plans.map(plan => ({ ...plan, assignments: byPlan.get(plan.id) ?? [] }));
}

function planIdentitySignature(plans: StudyPlan[]): string {
  return JSON.stringify(plans.map(plan => [plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind,
    plan.assignments.map(assignment => [assignment.id, assignment.subgroupId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function assertStudyPlanIdentityPreserved(before: StudyPlan[], next: StudyPlan[]): void {
  const nextById = new Map(next.map(plan => [plan.id, plan]));
  for (const oldPlan of before) {
    const projected = nextById.get(oldPlan.id);
    if (!projected) throw new Error(`Curriculum normalization removed study plan ${oldPlan.id}.`);
    for (const oldAssignment of oldPlan.assignments) {
      const retained = projected.assignments.find(assignment => assignment.id === oldAssignment.id);
      if (!retained || retained.subgroupId !== oldAssignment.subgroupId) throw new Error(`Curriculum normalization changed assignment identity ${oldAssignment.id}.`);
    }
  }
  const beforeById = new Map(before.map(plan => [plan.id, plan]));
  const existingAssignmentIds = new Set(before.flatMap(plan => plan.assignments.map(assignment => assignment.id)));
  const oldSubset = next.filter(plan => beforeById.has(plan.id)).map(plan => ({
    ...plan,
    assignments: plan.assignments.filter(assignment => existingAssignmentIds.has(assignment.id)),
  }));
  if (planIdentitySignature(before) !== planIdentitySignature(oldSubset)) throw new Error("Existing study plan identities changed during normalization.");
}

function persistStudyPlanProjection(db: Database.Database, before: StudyPlan[], next: StudyPlan[]) {
  assertStudyPlanIdentityPreserved(before, next);
  const beforeById = new Map(before.map(plan => [plan.id, plan]));
  const existingAssignmentIds = new Map(before.flatMap(plan => plan.assignments.map(assignment => [assignment.id, { planId: plan.id, subgroupId: assignment.subgroupId, target: assignment.target }] as const)));

  const insertPlan = db.prepare("INSERT INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind) VALUES(?,?,?,?,?,?,NULL)");
  const updateMode = db.prepare("UPDATE study_plans SET mode=? WHERE id=? AND mode<>?");
  const insertAssignment = db.prepare("INSERT INTO plan_assignments(id,plan_id,subgroup_id,target) VALUES(?,?,?,?)");
  const updateTarget = db.prepare("UPDATE plan_assignments SET target=? WHERE id=? AND target<>?");
  let addedPlans = 0, addedAssignments = 0, normalizedAssignments = 0;
  for (const plan of next) {
    if (!beforeById.has(plan.id)) { insertPlan.run(plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind); addedPlans++; }
    else updateMode.run(plan.mode, plan.id, plan.mode);
    for (const assignment of plan.assignments) {
      const old = existingAssignmentIds.get(assignment.id);
      if (!old) { insertAssignment.run(assignment.id, plan.id, assignment.subgroupId, assignment.target); addedAssignments++; }
      else if (old.target !== assignment.target) { updateTarget.run(assignment.target, assignment.id, old.target); normalizedAssignments++; }
    }
  }
  const after = readStudyPlans(db);
  if (planIdentitySignature(after) !== planIdentitySignature(next)) throw new Error("Persisted study plan identities do not match the normalized projection.");
  return { addedPlans, addedAssignments, normalizedAssignments };
}

function updateTeacherOriginFingerprints(db: Database.Database, nameByTeacher: Map<string, string>, oldNameByTeacher: Map<string, string>): number {
  const rows = db.prepare("SELECT id,origin_json FROM teacher_lesson_origins").all() as Array<{ id: string; origin_json: string }>;
  const update = db.prepare("UPDATE teacher_lesson_origins SET origin_json=? WHERE id=?");
  let changed = 0;
  for (const row of rows) {
    const origin = JSON.parse(row.origin_json) as TeacherLessonOrigin;
    if (typeof origin.expected !== "string") continue;
    let parts: unknown;
    try { parts = JSON.parse(origin.expected); } catch { continue; }
    if (!Array.isArray(parts) || typeof parts[7] !== "string") continue;
    const newName = nameByTeacher.get(origin.substituteTeacherId);
    const oldName = oldNameByTeacher.get(origin.substituteTeacherId);
    if (!newName || !oldName || oldName === newName || parts[7] !== oldName) continue;
    parts[7] = newName;
    origin.expected = JSON.stringify(parts);
    update.run(JSON.stringify(origin), row.id); changed++;
  }
  return changed;
}

function updatePublishedSnapshots(db: Database.Database, nameByTeacher: Map<string, string>): number {
  const rows = db.prepare("SELECT quarter_id,version,snapshot_json FROM published_quarters").all() as Array<{ quarter_id: string; version: number; snapshot_json: string }>;
  const update = db.prepare("UPDATE published_quarters SET version=?,published_at=?,snapshot_json=? WHERE quarter_id=?");
  let updated = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const snapshot = JSON.parse(row.snapshot_json) as Record<string, any>;
    let changed = false;
    const teachers = snapshot.catalog?.teachers;
    if (Array.isArray(teachers)) for (const teacher of teachers) {
      const nextName = typeof teacher?.id === "string" ? nameByTeacher.get(teacher.id) : undefined;
      if (nextName && teacher.name !== nextName) { teacher.name = nextName; changed = true; }
    }
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const object = value as Record<string, unknown>;
      const teacherId = typeof object.teacherId === "string" ? object.teacherId : undefined;
      const nextName = teacherId ? nameByTeacher.get(teacherId) : undefined;
      if (nextName && typeof object.teacher === "string" && object.teacher !== nextName) { object.teacher = nextName; changed = true; }
      Object.values(object).forEach(walk);
    };
    walk(snapshot.schedule);
    if (changed) { update.run(row.version + 1, now, JSON.stringify(snapshot), row.quarter_id); updated++; }
  }
  return updated;
}

function validateAndApply(db: Database.Database, names: string[]) {
  const teachers = assertSyntheticSchool(db);
  if (names.length < teachers.length) throw new Error(`Name list contains ${names.length} names for ${teachers.length} teachers.`);
  const catalog = readCatalogForCurricula(db), quarters = readQuarters(db), beforeCurricula = readCurricula(db);
  const afterCurricula = mergeGradeCurricula(beforeCurricula, catalog);
  const invalid = validateCurricula(afterCurricula, catalog, quarters, beforeCurricula);
  if (invalid) throw new Error(`Merged curricula failed validation: ${invalid}`);
  const beforePlans = readStudyPlans(db);
  const projectedPlans = projectCurricula(afterCurricula, beforePlans, catalog);
  assertStudyPlanIdentityPreserved(beforePlans, projectedPlans);
  const byTeacher = new Map(teachers.map((teacher, index) => [teacher.id, names[index]!]));
  const oldNameByTeacher = new Map(teachers.map(teacher => [teacher.id, teacher.name]));
  const rename = db.prepare("UPDATE catalog_teachers SET name=? WHERE id=?");
  let renamedTeachers = 0;
  for (const teacher of teachers) {
    const nextName = byTeacher.get(teacher.id)!;
    if (teacher.name !== nextName) { rename.run(nextName, teacher.id); renamedTeachers++; }
  }
  const updateLessons = db.prepare("UPDATE lessons SET teacher=? WHERE teacher_ref=? AND teacher IS NOT ?");
  let renamedLessons = 0;
  for (const [teacherId, name] of byTeacher) renamedLessons += updateLessons.run(name, teacherId, name).changes;
  const originCount = updateTeacherOriginFingerprints(db, byTeacher, oldNameByTeacher);
  const publicationCount = updatePublishedSnapshots(db, byTeacher);
  const planChanges = persistStudyPlanProjection(db, beforePlans, projectedPlans);
  db.prepare("DELETE FROM curricula").run();
  const putCurriculum = db.prepare("INSERT INTO curricula(id,curriculum_json) VALUES(?,?)");
  for (const curriculum of afterCurricula) putCurriculum.run(curriculum.id, JSON.stringify(curriculum));
  const canonicalCurricula = (items: Curriculum[]) => JSON.stringify([...items].sort((a,b) => a.id.localeCompare(b.id)));
  const changed = renamedTeachers > 0 || renamedLessons > 0 || originCount > 0 || publicationCount > 0 || canonicalCurricula(beforeCurricula) !== canonicalCurricula(afterCurricula) || planChanges.normalizedAssignments > 0 || planChanges.addedAssignments > 0 || planChanges.addedPlans > 0;
  if (changed) db.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
  return {
    teachers: teachers.length,
    unusedNames: names.length - teachers.length,
    renamedTeachers,
    renamedLessons,
    updatedPublications: publicationCount,
    updatedTeacherOrigins: originCount,
    curriculaBefore: beforeCurricula.length,
    curriculaAfter: afterCurricula.length,
    ...planChanges,
    groupsBefore: beforeCurricula.reduce((count, item) => count + item.groupIds.length, 0),
    groupsAfter: afterCurricula.reduce((count, item) => count + item.groupIds.length, 0),
  };
}

export async function refineFullSchoolData(options: Options, names = loadNames(options.names)) {
  const dbPath = realpathSync(options.db);
  const previewDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const teachers = assertSyntheticSchool(previewDb);
    if (names.length < teachers.length) throw new Error(`Name list contains ${names.length} names for ${teachers.length} teachers.`);
    const candidate = mergeGradeCurricula(readCurricula(previewDb), readCatalogForCurricula(previewDb));
    const catalog = readCatalogForCurricula(previewDb);
    const plans = readStudyPlans(previewDb);
    assertStudyPlanIdentityPreserved(plans, projectCurricula(candidate, plans, catalog));
    const invalid = validateCurricula(candidate, catalog, readQuarters(previewDb), readCurricula(previewDb));
    if (invalid) throw new Error(`Merged curricula failed validation: ${invalid}`);
  } finally { previewDb.close(); }
  await createDatabaseBackup({ db: dbPath, to: options.backup });
  chmodSync(options.backup, 0o600);
  const db = new Database(dbPath);
  try {
    const result = db.transaction(() => validateAndApply(db, names))();
    const integrity = db.pragma("integrity_check") as Array<Record<string, string>>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("SQLite integrity check failed after data refinement.");
    return { backup: options.backup, ...result };
  } finally { db.close(); }
}

async function main(args: string[]) {
  const options = parseArguments(args);
  const names = loadNames(options.names);
  const result = await refineFullSchoolData(options, names);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
