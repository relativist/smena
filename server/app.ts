import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { openSqliteDatabase, openPostgresDatabase, type AsyncDatabase } from "./database.ts";
import { initializePostgresSchema } from "./postgresSchema.ts";
import { createPublicationPrintIndex, migratePublicationPrintIndex, readPublicationPrintIndex } from "./publicationPrintIndex.ts";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { canPlace, canSwapLessons, createSchedule, key as scheduleKey, parseTime, type Location, type Schedule } from "../src/editor.ts";
import { choosePlacementRoom } from "../src/roomChoice.ts";
import { groups, subjects } from "../src/demo.ts";
import type { EditorDayChange, EditorDaysRequest, EditorPlacement, EditorPreviewRequest, PlanBaseline, StateResponse } from "./contracts.ts";
import type { TemporaryTeacherReplacement } from "../shared/temporaryTeacherReplacements.ts";
import { previewAutomaticTeacherReplacement } from "../shared/automaticTeacherReplacement.ts";
import { createTeacherReassignmentPreviewCache, previewTeacherReassignment, teacherLessonFingerprint, validateTeacherReassignmentRequest, type TeacherLessonOrigin, type TeacherReassignmentRequest, type TeacherReassignmentPreview, type TeacherTeachingAssignment, } from "../shared/teacherReassignment.ts";
import type { Catalog, CatalogRoom, CatalogSubject, CatalogTeacher, RoomKind, } from "../shared/catalog.ts";
import { projectCurricula, replacementGroups, fromGroupPlan, validateCurricula, type Curriculum, } from "../shared/curricula.ts";
import { canShareSubject } from "../shared/catalog.ts";
import { isSubjectIconId } from "../shared/subjectIcons.ts";
import { defaultDisplaySettings, type DisplaySettings } from "../shared/displaySettings.ts";
import { applyCalendar, calendarDay, calendarFromSchedule, defaultSchoolCalendar, validateCalendar, type SchoolCalendar, } from "../shared/schoolCalendar.ts";
import { applyBellSettings, defaultBellSettings, effectiveBellProfile, bellBreak, validateBellSettings, validateBellProfile, normalizeBellSettings, type BellApplyOptions, type BellProfile, type BellSettings, } from "../shared/bellSchedule.ts";
import { buildSeedCatalog, roomCatalogId, subgroupCatalogId, teacherCatalogId, } from "../shared/catalog-seed.ts";
import { inQuarter, quarterWeeks, weekDates, visibleQuarters, weekOffsetFor, type LessonKind, type Quarter, type StudyPlan, type PlanAssignment, } from "../shared/plans.ts";
import { subjectColors } from "../shared/subjectColors.ts";
import { addMissingSchoolSubjectPresets } from "../shared/schoolSubjects.ts";
import { newRoomConflict, roomConflictMessage, } from "../shared/roomConflicts.ts";
import { newTeacherConflict, teacherConflictMessage, } from "../shared/teacherConflicts.ts";
import { newRoomSuitabilityViolation, roomSuitabilityViolationMessage, } from "../shared/roomSuitability.ts";
import { findUnavailability, newUnavailabilityViolation, unavailabilityViolationMessage, validateUnavailabilityRules, } from "../shared/unavailability.ts";
import { analyzePublication, createPublicationSnapshot } from "../shared/publication.ts";
import type { PublicationMetadata, PublishedQuarterResponse, PublishResponse, } from "../shared/publicationTypes.ts";
import type { PublicStudentSchedule, PublicStudentsDaySchedule, PublicStudentsIndex, PublicStudentsWeekSchedule } from "../shared/studentTypes.ts";
import { projectPublicStudents, type PublicStudentProjection } from "../shared/studentPublic.ts";
import type { SchedulePrintIndex, SchedulePrintPreview, SchedulePrintPreviewRequest, SchedulePrintSource } from "../shared/schedulePrintTypes.ts";
import type { PublicTeacherSchedule, PublicTeachersDaySchedule, PublicTeachersIndex, PublicTeachersWeekSchedule } from "../shared/teacherTypes.ts";
import { projectPublicTeachers, type PublicTeacherProjection } from "../shared/teacherPublic.ts";
import { registerTeacherLoadApi } from "./teacherLoadApi.ts";
import { registerPlanCoverageApi } from "./planCoverageApi.ts";
import { registerBulkApi } from "./bulkApi.ts";
import { registerGenerationApi } from "./generationApi.ts";
import { registerDataTransferApi } from "./dataTransferApi.ts";
import { SchoolArchiveService } from "./schoolArchive.ts";
import { MaintenanceGate } from "./maintenanceGate.ts";
import { scheduledUnavailability } from "../shared/unavailability.ts";
import { isEventRemainder, type EventRemainder } from "../shared/eventRemainders.ts";
const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "smena_session";
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_STATE_BODY_BYTES = 100 * 1024 * 1024;
const MAX_STUDY_PLANS = 20000;
const MAX_SCHEDULE_SLOTS = 500000;
type AppOptions = {
    dbPath?: string;
    databaseUrl?: string;
    archiveBackupDirectory?: string;
    archiveBeforeWrite?: () => Promise<void>;
    serveStatic?: boolean;
    staticRoot?: string;
};
type AuthBody = {
    username?: unknown;
    password?: unknown;
};
type SaveBody = {
    schedule?: unknown;
    revision?: unknown;
    requestId?: unknown;
};
type CatalogBody = {
    catalog?: unknown;
    revision?: unknown;
    requestId?: unknown;
};
type PlansBody = {
    quarters?: unknown;
    studyPlans?: unknown;
    revision?: unknown;
    requestId?: unknown;
    scopeQuarterId?: unknown;
    responseQuarterId?: unknown;
    metadataOnly?: unknown;
};
type CalendarBody = {
    calendar?: unknown;
    revision?: unknown;
    requestId?: unknown;
    confirmLessonRemoval?: unknown;
};
type BellSettingsBody = {
    settings?: unknown;
    apply?: unknown;
    revision?: unknown;
    requestId?: unknown;
};
type CurriculaBody = {
    curricula?: unknown;
    revision?: unknown;
    requestId?: unknown;
    confirmGroupReplacement?: unknown;
    scopeQuarterId?: unknown;
};
type SessionInfo = {
    username: string;
    csrfToken: string;
};
function nowIso(): string {
    return new Date().toISOString();
}
function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}
async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [, saltText, expectedText] = encoded.split("$");
    if (!saltText || !expectedText)
        return false;
    const expected = Buffer.from(expectedText, "base64url");
    const actual = (await scrypt(password, Buffer.from(saltText, "base64url"), expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function makeSqliteDatabase(path: string): Promise<AsyncDatabase> {
    if (path !== ":memory:")
        mkdirSync(dirname(resolve(path)), { recursive: true });
    const db = openSqliteDatabase(path);
    await db.pragma("foreign_keys = ON");
    await db.pragma("journal_mode = WAL");
    await db.pragma("busy_timeout = 5000");
    await db.transaction(async () => await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      username TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draft_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      initialized INTEGER NOT NULL CHECK (initialized IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS schedule_days (
      id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      date TEXT NOT NULL,
      week_offset INTEGER NOT NULL,
      day_index INTEGER NOT NULL,
      base_start TEXT NOT NULL,
      nominal_duration INTEGER NOT NULL,
      holiday INTEGER NOT NULL,
      note TEXT,
      UNIQUE (group_id, date)
    );
    CREATE TABLE IF NOT EXISTS schedule_slots (
      id INTEGER PRIMARY KEY,
      day_id INTEGER NOT NULL REFERENCES schedule_days(id) ON DELETE CASCADE,
      slot_index INTEGER NOT NULL,
      start_minute INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      UNIQUE (day_id, slot_index)
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      slot_id INTEGER NOT NULL REFERENCES schedule_slots(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL,
      subgroup TEXT,
      teacher TEXT,
      room TEXT,
      event TEXT,
      note TEXT
    );
    -- Cascading slot deletion must look up its lessons without a table scan.
    CREATE INDEX IF NOT EXISTS lessons_slot_id ON lessons(slot_id);
    CREATE TABLE IF NOT EXISTS plan_baselines (
      group_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      subgroup TEXT NOT NULL DEFAULT '',
      planned INTEGER NOT NULL,
      target INTEGER NOT NULL,
      initial_count INTEGER NOT NULL,
      PRIMARY KEY (group_id, subject_id, subgroup)
    );
    CREATE TABLE IF NOT EXISTS request_replays (
      request_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO draft_metadata(id, revision, updated_at, initialized) VALUES (1, 0, '', 0);
  `))();
    const initializedBeforeMigrations = Boolean((await db.prepare("SELECT initialized FROM draft_metadata WHERE id=1").get() as {
        initialized: number;
    }).initialized);
    await migrateCatalog(db);
    await migrateSubjectIcons(db);
    await migrateDisplaySettings(db);
    await migrateTeacherPreferredShift(db);
    await migrateCatalogPreferences(db, initializedBeforeMigrations);
    await ensureJointColumns(db);
    await migrateTeacherDefaultRooms(db, initializedBeforeMigrations);
    await db.exec("CREATE TABLE IF NOT EXISTS catalog_teacher_subjects(teacher_id TEXT NOT NULL REFERENCES catalog_teachers(id) ON DELETE CASCADE, subject_id TEXT NOT NULL REFERENCES catalog_subjects(id) ON DELETE CASCADE, PRIMARY KEY(teacher_id,subject_id))");
    const hadQuarterPlans = Boolean(await db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get());
    // v3 may initialize and serialize the schedule before the later migrations run.
    await migrateEventRemainders(db);
    await migratePlans(db);
    await migrateQuarterArchive(db);
    await migrateTeacherSubjects(db, hadQuarterPlans);
    await migrateHoursOnlyPlansAndGeneratorRooms(db, hadQuarterPlans);
    await migrateJointLessons(db, initializedBeforeMigrations);
    await migrateBellSettings(db);
    await migrateSchoolCalendar(db, initializedBeforeMigrations);
    await migrateCurricula(db);
    await migrateUnifiedCurricula(db);
    await migrateUnavailability(db);
    await migratePublications(db);
    await db.transaction(() => migratePublicationPrintIndex(db))();
    await migrateTemporaryTeacherReplacements(db);
    await migrateTeacherReassignments(db);
    await migrateReassignmentPolicyHistory(db);
    await migrateSchoolSubjectPresets(db, initializedBeforeMigrations);
    // Bounded editor reads and availability checks use these date/resource keys.
    await db.exec(`
    CREATE INDEX IF NOT EXISTS schedule_days_date_group ON schedule_days(date, group_id);
    CREATE INDEX IF NOT EXISTS plan_assignments_plan_id ON plan_assignments(plan_id);
    CREATE INDEX IF NOT EXISTS lessons_teacher_slot ON lessons(teacher_ref, slot_id);
    CREATE INDEX IF NOT EXISTS lessons_room_slot ON lessons(room_ref, slot_id);
    CREATE INDEX IF NOT EXISTS lessons_joint_id ON lessons(joint_id);
    CREATE TABLE IF NOT EXISTS editor_request_replays(
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL
    );
  `);
    return db;
}
async function migrateSchoolSubjectPresets(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=20").get())
        return;
    const draft = await db.prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    const insert = db.prepare("INSERT OR IGNORE INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived) VALUES(?,?,?,?,?,?,?,?,?,?)");
    await db.transaction(async () => {
        const existing = (await readCatalog(db)).subjects;
        const subjects = addMissingSchoolSubjectPresets(existing);
        const additions = subjects.slice(existing.length);
        for (const subject of additions)
            await insert.run(subject.id, subject.name, subject.shortName, subject.color, subject.roomKind, subject.labRoomKind, JSON.stringify(subject.jointGroupSets ?? []), Number(subject.jointSameGrade ?? false), subject.maxJointGroups ?? 2, Number(subject.archived));
        if (additions.length && bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1")
                .run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(20,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateTeacherPreferredShift(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=17").get())
        return;
    await db.transaction(async () => {
        const columns = new Set((await db.pragma("table_info(catalog_teachers)") as Array<{
            name: string;
        }>).map((row) => row.name));
        if (!columns.has("preferred_shift"))
            await db.exec("ALTER TABLE catalog_teachers ADD COLUMN preferred_shift TEXT CHECK(preferred_shift IS NULL OR preferred_shift IN ('morning','afternoon'))");
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(17,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateSubjectIcons(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=18").get())
        return;
    await db.transaction(async () => {
        const columns = new Set((await db.pragma("table_info(catalog_subjects)") as Array<{
            name: string;
        }>).map((row) => row.name));
        if (!columns.has("icon_id"))
            await db.exec("ALTER TABLE catalog_subjects ADD COLUMN icon_id TEXT");
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(18,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateDisplaySettings(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=19").get())
        return;
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS school_display_settings(
        id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS school_display_setting_replays(
        request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL
      );
    `);
        await db.prepare("INSERT OR IGNORE INTO school_display_settings(id,settings_json,revision) VALUES(1,?,0)")
            .run(JSON.stringify(defaultDisplaySettings()));
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(19,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateReassignmentPolicyHistory(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=23").get())
        return;
    await db.transaction(async () => {
        const columns = await db.prepare("PRAGMA table_info(teacher_reassignment_operations)").all() as Array<{
            name: string;
        }>;
        if (!columns.some(column => column.name === "previous_policies_json")) {
            await db.exec("ALTER TABLE teacher_reassignment_operations ADD COLUMN previous_policies_json TEXT NOT NULL DEFAULT '[]'");
            // Older operations never changed temporary replacement policies. Preserve
            // the current policies if such an operation is still eligible for undo.
            await db.prepare("UPDATE teacher_reassignment_operations SET previous_policies_json=?")
                .run(JSON.stringify(await readTemporaryTeacherReplacements(db)));
        }
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(23,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateTeacherReassignments(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=16").get())
        return;
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS teacher_lesson_origins (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, origin_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS teacher_lesson_origins_lesson ON teacher_lesson_origins(lesson_id);
      CREATE TABLE IF NOT EXISTS teacher_teaching_assignments (id TEXT PRIMARY KEY, assignment_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teacher_reassignment_operations (
        operation_id TEXT PRIMARY KEY, apply_request_id TEXT NOT NULL UNIQUE, apply_fingerprint TEXT NOT NULL,
        apply_response_json TEXT NOT NULL, applied_revision INTEGER NOT NULL, previous_schedule_json TEXT NOT NULL,
        previous_catalog_json TEXT NOT NULL, previous_origins_json TEXT NOT NULL, previous_assignments_json TEXT NOT NULL, previous_policies_json TEXT NOT NULL DEFAULT '[]',
        undo_request_id TEXT UNIQUE, undo_fingerprint TEXT, undo_response_json TEXT
      );
    `);
        const reassignColumns = await db.prepare("PRAGMA table_info(teacher_reassignment_operations)").all() as Array<{
            name: string;
        }>;
        if (!reassignColumns.some((column) => column.name === "previous_policies_json"))
            await db.exec("ALTER TABLE teacher_reassignment_operations ADD COLUMN previous_policies_json TEXT NOT NULL DEFAULT '[]'");
        const columns = await db.prepare("PRAGMA table_info(teacher_replacement_operations)").all() as Array<{
            name: string;
        }>;
        if (!columns.some((column) => column.name === "previous_origins_json"))
            await db.exec("ALTER TABLE teacher_replacement_operations ADD COLUMN previous_origins_json TEXT NOT NULL DEFAULT '[]'");
        if (!columns.some((column) => column.name === "previous_assignments_json"))
            await db.exec("ALTER TABLE teacher_replacement_operations ADD COLUMN previous_assignments_json TEXT NOT NULL DEFAULT '[]'");
        // Preserve the actual F2 substitutions already accepted before origins were tracked.
        const operations = await db.prepare("SELECT operation_id,apply_response_json,previous_schedule_json,previous_policies_json,undo_request_id FROM teacher_replacement_operations ORDER BY rowid").all() as Array<{
            operation_id: string;
            apply_response_json: string;
            previous_schedule_json: string;
            previous_policies_json: string;
            undo_request_id: string | null;
        }>;
        const catalog = await readCatalog(db);
        const currentById = new Map(locatedLessons(await readSchedule(db)).map((item) => [item.lesson.id, item]));
        const originTimeline = new Map<string, TeacherLessonOrigin>();
        for (const operation of operations) {
            try {
                const savedSchedule = JSON.parse(operation.previous_schedule_json) as Schedule | ReassignmentTeacherSnapshot;
                const response = JSON.parse(operation.apply_response_json) as {
                    state?: StateResponse;
                };
                const next = response.state?.schedule;
                await db.prepare("UPDATE teacher_replacement_operations SET previous_origins_json=?,previous_assignments_json=? WHERE operation_id=?")
                    .run(JSON.stringify([...originTimeline.values()]), JSON.stringify([]), operation.operation_id);
                if (!next || operation.undo_request_id)
                    continue;
                const previous = savedSchedule.format === "teacher-reassignment-v2"
                    ? restoreReassignmentTeachers(next, savedSchedule as ReassignmentTeacherSnapshot) : savedSchedule as Schedule;
                const previousLessons = locatedLessons(previous);
                const nextLessons = locatedLessons(next);
                const afterById = new Map(nextLessons.map((item) => [item.lesson.id, item]));
                // Policies are persisted after applying; recover them from the stored response.
                const currentPolicyList = response.state?.temporaryTeacherReplacements ?? [];
                for (const before of previousLessons) {
                    const after = afterById.get(before.lesson.id);
                    if (!after || before.groupId !== after.groupId || before.date !== after.date || before.lesson.teacherId === after.lesson.teacherId || !after.lesson.teacherId || !before.lesson.teacherId)
                        continue;
                    const oldOrigin = originTimeline.get(before.lesson.id);
                    const sourceTeacherId = oldOrigin?.sourceTeacherId ?? before.lesson.teacherId;
                    const matching = currentPolicyList.find((rule) => rule.groupId === before.groupId && rule.subjectId === before.lesson.subjectId && rule.sourceTeacherId === sourceTeacherId && rule.startDate <= before.date && rule.endDate >= before.date && (rule.subgroupId ? rule.subgroupId === before.lesson.subgroupId : (rule.subgroup ?? "") === (before.lesson.subgroup ?? "")));
                    const absence = catalog.teachers.find((teacher) => teacher.id === sourceTeacherId)?.unavailability?.find((rule) => rule.startDate <= before.date && rule.endDate >= before.date && before.start < rule.end && rule.start < before.end);
                    const kind = matching || absence ? "absence" : "transfer";
                    const origin: TeacherLessonOrigin = {
                        id: `legacy:${operation.operation_id}:${before.lesson.id}`, lessonId: before.lesson.id, groupId: before.groupId, date: before.date,
                        sourceTeacherId, substituteTeacherId: after.lesson.teacherId, kind,
                        ...(matching?.unavailabilityRuleId ?? absence?.id ? { absenceRuleId: matching?.unavailabilityRuleId ?? absence?.id } : {}),
                        startDate: matching?.startDate ?? absence?.startDate ?? before.date, endDate: matching?.endDate ?? absence?.endDate ?? before.date,
                        expected: teacherLessonFingerprint(after), status: "active",
                    };
                    originTimeline.set(origin.lessonId, origin);
                }
            }
            catch { /* A malformed historical operation must not prevent the database from opening. */ }
        }
        const persistedOrigins = [...originTimeline.values()].map((origin) => {
            const current = currentById.get(origin.lessonId);
            return { ...origin, status: current && teacherLessonFingerprint(current) === origin.expected ? "active" as const : "manual" as const };
        });
        await writeTeacherLessonOrigins(db, persistedOrigins);
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(16,CURRENT_TIMESTAMP)").run();
    })();
}
function locatedLessons(schedule: Schedule): Array<{
    groupId: string;
    date: string;
    start: number;
    end: number;
    lesson: import("../src/editor.ts").EditorLesson;
}> {
    const result: Array<{
        groupId: string;
        date: string;
        start: number;
        end: number;
        lesson: import("../src/editor.ts").EditorLesson;
    }> = [];
    for (const [key, days] of Object.entries(schedule)) {
        const groupId = key.slice(0, key.lastIndexOf(":"));
        for (const day of days)
            day.slots.forEach((slot, index) => {
                const time = day.times[index];
                if (time)
                    for (const lesson of slot)
                        result.push({ groupId, date: day.date, start: time.start, end: time.start + time.duration, lesson });
            });
    }
    return result;
}
async function migrateTemporaryTeacherReplacements(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=15").get())
        return;
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS temporary_teacher_replacements (
        id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teacher_replacement_operations (
        operation_id TEXT PRIMARY KEY,
        apply_request_id TEXT NOT NULL UNIQUE,
        apply_fingerprint TEXT NOT NULL,
        apply_response_json TEXT NOT NULL,
        applied_revision INTEGER NOT NULL,
        previous_schedule_json TEXT NOT NULL,
        previous_policies_json TEXT NOT NULL,
        undo_request_id TEXT UNIQUE,
        undo_fingerprint TEXT,
        undo_response_json TEXT
      );
    `);
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(15,CURRENT_TIMESTAMP)").run();
    })();
}
async function migratePublications(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=14").get())
        return;
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS published_quarters (
        quarter_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        draft_revision INTEGER NOT NULL,
        published_by TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_replays (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL
      );
    `);
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(14,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateUnavailability(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=13").get())
        return;
    await db.transaction(async () => {
        const columns = async (table: string) => new Set((await db.pragma(`table_info(${table})`) as Array<{
            name: string;
        }>).map(row => row.name));
        if (!(await columns("catalog_teachers")).has("unavailability_json"))
            await db.exec("ALTER TABLE catalog_teachers ADD COLUMN unavailability_json TEXT NOT NULL DEFAULT '[]'");
        if (!(await columns("catalog_rooms")).has("unavailability_json"))
            await db.exec("ALTER TABLE catalog_rooms ADD COLUMN unavailability_json TEXT NOT NULL DEFAULT '[]'");
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(13,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateBellSettings(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=12").get())
        return;
    await db.transaction(async () => {
        const columns = new Set((await db.pragma("table_info(schedule_days)") as Array<{
            name: string;
        }>).map(row => row.name));
        if (!columns.has("bell_profile_json"))
            await db.exec("ALTER TABLE schedule_days ADD COLUMN bell_profile_json TEXT");
        await db.exec("CREATE TABLE IF NOT EXISTS bell_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings_json TEXT NOT NULL)");
        await db.prepare("INSERT OR IGNORE INTO bell_settings(id,settings_json) VALUES(1,?)")
            .run(JSON.stringify(defaultBellSettings()));
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateCurricula(db: AsyncDatabase): Promise<void> {
    await db.transaction(async () => {
        await db.exec("CREATE TABLE IF NOT EXISTS curricula(id TEXT PRIMARY KEY, curriculum_json TEXT NOT NULL)");
        await db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(10,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateUnifiedCurricula(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get())
        return;
    await db.transaction(async () => {
        const rows = await db.prepare("SELECT id,curriculum_json FROM curricula ORDER BY rowid").all() as Array<{
            id: string;
            curriculum_json: string;
        }>;
        const put = db.prepare("UPDATE curricula SET curriculum_json=? WHERE id=?");
        const existing: Curriculum[] = [];
        for (const raw of rows) {
            try {
                const old = JSON.parse(raw.curriculum_json) as Record<string, any>;
                if (!old || typeof old.id !== "string" || !Array.isArray(old.rows))
                    continue;
                const migrated = {
                    id: old.id, name: old.name, quarterId: old.quarterId, groupIds: old.groupIds,
                    rows: old.rows.map((row: Record<string, any>) => ({
                        id: row.id, subjectId: row.subjectId, lessonKind: row.lessonKind, mode: row.mode,
                        hours: typeof row.hours === "number" ? row.hours : Math.max(...(Array.isArray(row.hours) ? row.hours : [1]).filter(Number.isFinite), 1),
                    })),
                } as Curriculum;
                await put.run(JSON.stringify(migrated), raw.id);
                existing.push(migrated);
            }
            catch { /* Keep malformed historical rows readable as before. */ }
        }
        const plans = await readStudyPlans(db), catalog = await readCatalog(db), quarters = await readQuarters(db);
        const covered = new Set(existing.flatMap(c => c.groupIds.map(groupId => JSON.stringify([c.quarterId, groupId]))));
        const uniqueName = (base: string) => {
            const names = new Set(existing.map(c => c.name.toLocaleLowerCase("ru")));
            let name = base, suffix = 2;
            while (names.has(name.toLocaleLowerCase("ru")))
                name = `${base} (${suffix++})`;
            return name;
        };
        const insert = db.prepare("INSERT INTO curricula(id,curriculum_json) VALUES(?,?)");
        const keys = new Set(plans.map(p => JSON.stringify([p.quarterId, p.groupId])));
        for (const key of keys) {
            const [quarterId, groupId] = JSON.parse(key) as [
                string,
                string
            ];
            if (covered.has(key))
                continue;
            const group = catalog.groups.find(g => g.id === groupId);
            if (!group || !quarters.some(q => q.id === quarterId))
                continue;
            const curriculum = fromGroupPlan(uniqueName(`План ${group.name}`), groupId, quarterId, plans, catalog);
            await insert.run(curriculum.id, JSON.stringify(curriculum));
            existing.push(curriculum);
        }
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,CURRENT_TIMESTAMP)").run();
    })();
}
async function readCurricula(db: AsyncDatabase): Promise<Curriculum[]> {
    return (await db.prepare("SELECT curriculum_json FROM curricula ORDER BY rowid").all()).flatMap((raw) => {
        try {
            const value = JSON.parse((raw as {
                curriculum_json: string;
            }).curriculum_json);
            return value && typeof value.id === "string" ? [value as Curriculum] : [];
        }
        catch {
            return [];
        }
    });
}
function curriculumTemplates(curricula: Curriculum[]): Curriculum[] {
    const families = new Map<string, Curriculum>();
    for (const item of curricula)
        families.set(item.templateId ?? item.id, item);
    return [...families.values()].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
}
/** Share composition; keep quarter totals and application-specific subgroup choices. */
function syncCurriculumTemplates(next: Curriculum[], previous: Curriculum[], changedQuarterId?: string): Curriculum[] {
    const changed = new Map<string, {
        source: Curriculum;
        name: boolean;
        composition: boolean;
    }>();
    const composition = (item: Curriculum) => JSON.stringify(item.rows.map((row) => [row.subjectId, row.lessonKind, row.mode]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    for (const item of next) {
        if (changedQuarterId && item.quarterId !== changedQuarterId)
            continue;
        const prior = previous.find((entry) => entry.id === item.id);
        if (item.templateId && prior) {
            const name = item.name !== prior.name, rows = composition(item) !== composition(prior);
            if (name || rows)
                changed.set(item.templateId, { source: item, name, composition: rows });
        }
    }
    return next.map((item) => {
        const change = item.templateId ? changed.get(item.templateId) : undefined;
        if (!change || change.source.id === item.id)
            return item;
        const source = change.source;
        return { ...item, name: change.name ? source.name : item.name, rows: !change.composition ? item.rows : source.rows.map((row) => {
                const prior = item.rows.find((entry) => entry.subjectId === row.subjectId && entry.lessonKind === row.lessonKind);
                return { ...row, id: prior?.id ?? crypto.randomUUID(), hours: prior?.hours ?? row.hours,
                    subgroupIdsByGroup: row.mode === "subgroups" ? prior?.subgroupIdsByGroup : undefined };
            }) };
    });
}
async function writeCurriculaProjection(db: AsyncDatabase, curricula: Curriculum[], projected: StudyPlan[]): Promise<void> {
    const previousCurricula = await readCurricula(db), previousPlans = await readStudyPlans(db);
    const previousCurriculaById = new Map(previousCurricula.map(item => [item.id, item]));
    const nextCurriculaById = new Map(curricula.map(item => [item.id, item]));
    const deleteCurriculum = db.prepare("DELETE FROM curricula WHERE id=?");
    const insertCurriculum = db.prepare("INSERT INTO curricula(id,curriculum_json) VALUES(?,?)");
    const updateCurriculum = db.prepare("UPDATE curricula SET curriculum_json=? WHERE id=?");
    for (const item of previousCurricula)
        if (!nextCurriculaById.has(item.id)) await deleteCurriculum.run(item.id);
    for (const item of curricula) {
        const old = previousCurriculaById.get(item.id);
        const json = JSON.stringify(item);
        if (!old) await insertCurriculum.run(item.id, json);
        else if (stableJson(old) !== stableJson(item)) await updateCurriculum.run(json, item.id);
    }

    const previousById = new Map(previousPlans.map(plan => [plan.id, plan]));
    const nextById = new Map(projected.map(plan => [plan.id, plan]));
    const uniqueKey = (plan: StudyPlan) => JSON.stringify([plan.quarterId, plan.groupId, plan.subjectId, plan.lessonKind]);
    const recreate = new Set<string>();
    for (const plan of previousPlans) {
        const next = nextById.get(plan.id);
        if (!next || uniqueKey(plan) !== uniqueKey(next)) recreate.add(plan.id);
    }
    const orderColumn = db.dialect === "postgres" ? "insertion_order" : "rowid";
    const planOrders = new Map<string, number>();
    const assignmentOrders = new Map<string, number>();
    if (recreate.size && db.dialect === "sqlite") {
        const rows = await db.prepare("SELECT id,rowid AS insertion_order FROM study_plans").all() as Array<{ id: string; insertion_order: number }>;
        for (const row of rows) planOrders.set(row.id, row.insertion_order);
    }
    if (recreate.size) {
        const rows = await db.prepare(`SELECT id,${orderColumn} AS insertion_order FROM plan_assignments`).all() as Array<{ id: string; insertion_order: number }>;
        for (const row of rows) assignmentOrders.set(row.id, row.insertion_order);
    }
    const deletePlan = db.prepare("DELETE FROM study_plans WHERE id=?");
    for (const id of recreate) await deletePlan.run(id);

    const updatePlan = db.prepare("UPDATE study_plans SET quarter_id=?,group_id=?,subject_id=?,mode=?,lesson_kind=?,room_kind=NULL WHERE id=?");
    const insertPlan = db.prepare("INSERT INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind) VALUES(?,?,?,?,?,?,NULL)");
    const insertPlanWithOrder = db.dialect === "sqlite"
        ? db.prepare("INSERT INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind,rowid) VALUES(?,?,?,?,?,?,NULL,?)")
        : undefined;
    const existingPlanIds = new Set(previousById.keys());
    for (const plan of projected) {
        if (!existingPlanIds.has(plan.id) || recreate.has(plan.id)) {
            const order = planOrders.get(plan.id);
            if (order === undefined) await insertPlan.run(plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind);
            else if (insertPlanWithOrder) await insertPlanWithOrder.run(plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind, order);
            else await insertPlan.run(plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind);
        }
        else {
            const old = previousById.get(plan.id)!;
            if (old.quarterId !== plan.quarterId || old.groupId !== plan.groupId || old.subjectId !== plan.subjectId || old.mode !== plan.mode || old.lessonKind !== plan.lessonKind)
                await updatePlan.run(plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind, plan.id);
        }
    }

    const previousAssignments = new Map(previousPlans.flatMap(plan => plan.assignments.map(assignment => [assignment.id, { ...assignment, planId: plan.id }] as const)));
    const nextAssignments = new Map(projected.flatMap(plan => plan.assignments.map(assignment => [assignment.id, { ...assignment, planId: plan.id }] as const)));
    const deleteAssignment = db.prepare("DELETE FROM plan_assignments WHERE id=?");
    const insertAssignment = db.prepare("INSERT INTO plan_assignments(id,plan_id,subgroup_id,target) VALUES(?,?,?,?)");
    const insertAssignmentWithOrder = db.prepare(`INSERT INTO plan_assignments(id,plan_id,subgroup_id,target,${orderColumn}) VALUES(?,?,?,?,?)`);
    const updateAssignment = db.prepare("UPDATE plan_assignments SET plan_id=?,subgroup_id=?,target=? WHERE id=?");
    for (const [id, old] of previousAssignments) {
        const next = nextAssignments.get(id);
        if (!next) await deleteAssignment.run(id);
        else if (recreate.has(old.planId)) {
            // Deleting the old plan cascaded this assignment; restore it under
            // its projected owner below, retaining its prior insertion order.
        }
        else if (old.planId !== next.planId || old.subgroupId !== next.subgroupId || old.target !== next.target)
            await updateAssignment.run(next.planId, next.subgroupId, next.target, id);
    }
    for (const [id, assignment] of nextAssignments) {
        const old = previousAssignments.get(id);
        if (!old || recreate.has(old.planId)) {
            const order = assignmentOrders.get(id);
            if (order === undefined) await insertAssignment.run(id, assignment.planId, assignment.subgroupId, assignment.target);
            else await insertAssignmentWithOrder.run(id, assignment.planId, assignment.subgroupId, assignment.target, order);
        }
    }
    await wrapOrphanPlans(db);
}
async function wrapOrphanPlans(db: AsyncDatabase): Promise<void> {
    const curricula = await readCurricula(db), catalog = await readCatalog(db), plans = await readStudyPlans(db);
    const covered = new Set(curricula.flatMap(c => c.groupIds.map(groupId => JSON.stringify([c.quarterId, groupId]))));
    const insert = db.prepare("INSERT INTO curricula(id,curriculum_json) VALUES(?,?)");
    for (const key of new Set(plans.map(p => JSON.stringify([p.quarterId, p.groupId])))) {
        if (covered.has(key))
            continue;
        const [quarterId, groupId] = JSON.parse(key) as [
            string,
            string
        ];
        const group = catalog.groups.find(g => g.id === groupId);
        if (!group)
            continue;
        const names = new Set(curricula.map(c => c.name.toLocaleLowerCase("ru")));
        const base = `План ${group.name}`;
        let name = base, suffix = 2;
        while (names.has(name.toLocaleLowerCase("ru")))
            name = `${base} (${suffix++})`;
        const curriculum = fromGroupPlan(name, groupId, quarterId, plans, catalog);
        await insert.run(curriculum.id, JSON.stringify(curriculum));
        curricula.push(curriculum);
        covered.add(key);
    }
}
async function reprojectCurriculumAssignments(db: AsyncDatabase, catalog: Catalog, affectedGroupIds: Set<string>): Promise<void> {
    const curricula = await readCurricula(db), current = await readStudyPlans(db);
    if (!curricula.length || !affectedGroupIds.size)
        return;
    const projected = projectCurricula(curricula, current, catalog);
    const managed = new Set(curricula.flatMap(c => c.groupIds.map(groupId => JSON.stringify([c.quarterId, groupId]))));
    const currentByPlan = new Map(current.map(plan => [plan.id, plan]));
    const deleteAssignment = db.prepare("DELETE FROM plan_assignments WHERE id=?");
    const insertAssignment = db.prepare("INSERT INTO plan_assignments(id,plan_id,subgroup_id,target) VALUES(?,?,?,?)");
    const updateAssignment = db.prepare("UPDATE plan_assignments SET subgroup_id=?,target=? WHERE id=?");
    for (const plan of projected) {
        if (!affectedGroupIds.has(plan.groupId) || !managed.has(JSON.stringify([plan.quarterId, plan.groupId])))
            continue;
        const prior = new Map((currentByPlan.get(plan.id)?.assignments ?? []).map(assignment => [assignment.id, assignment]));
        const next = new Map(plan.assignments.map(assignment => [assignment.id, assignment]));
        for (const assignment of prior.values())
            if (!next.has(assignment.id))
                await deleteAssignment.run(assignment.id);
        for (const assignment of next.values()) {
            const old = prior.get(assignment.id);
            if (!old)
                await insertAssignment.run(assignment.id, plan.id, assignment.subgroupId, assignment.target);
            else if (old.subgroupId !== assignment.subgroupId || old.target !== assignment.target)
                await updateAssignment.run(assignment.subgroupId, assignment.target, assignment.id);
        }
    }
}
async function migrateSchoolCalendar(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get()) {
        const draft = await db.prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
            initialized: number;
        };
        await db.transaction(async () => {
            const before = (await db.prepare("SELECT COUNT(*) AS count FROM schedule_days").get() as {
                count: number;
            }).count;
            await fillQuarterWeeks(db, await readQuarters(db));
            const after = (await db.prepare("SELECT COUNT(*) AS count FROM schedule_days").get() as {
                count: number;
            }).count;
            if (after > before && bumpRevision && draft.initialized)
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1")
                    .run(draft.revision + 1, nowIso());
        })();
        return;
    }
    const draft = await db.prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    await db.transaction(async () => {
        await db.exec("CREATE TABLE IF NOT EXISTS school_calendar(id INTEGER PRIMARY KEY CHECK(id=1),calendar_json TEXT NOT NULL)");
        const calendar = calendarFromSchedule(await readSchedule(db));
        await db.prepare("INSERT OR IGNORE INTO school_calendar(id,calendar_json) VALUES(1,?)")
            .run(JSON.stringify(calendar));
        await fillQuarterWeeks(db, await readQuarters(db));
        if (bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1")
                .run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(9,CURRENT_TIMESTAMP)").run();
    })();
}
async function readSchoolCalendar(db: AsyncDatabase, catalog?: Catalog): Promise<SchoolCalendar> {
    const row = await db.prepare("SELECT calendar_json FROM school_calendar WHERE id=1").get() as {
        calendar_json: string;
    } | undefined;
    if (!row)
        return defaultSchoolCalendar();
    try {
        const parsed = JSON.parse(row.calendar_json) as SchoolCalendar;
        return validateCalendar(parsed, catalog ?? await readCatalog(db)) ? defaultSchoolCalendar() : parsed;
    }
    catch {
        return defaultSchoolCalendar();
    }
}
async function migrateJointLessons(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get())
        return;
    const draft = await db
        .prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    await db.transaction(async () => {
        if (bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1")
                .run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(7,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateCatalogPreferences(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get())
        return;
    const draft = await db
        .prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    await db.transaction(async () => {
        const columns = async (table: string) => new Set((await db.pragma(`table_info(${table})`) as Array<{
            name: string;
        }>).map((row) => row.name));
        if (!(await columns("catalog_subjects")).has("max_joint_groups"))
            await db.exec("ALTER TABLE catalog_subjects ADD COLUMN max_joint_groups INTEGER NOT NULL DEFAULT 2");
        if (!(await columns("catalog_teachers")).has("preferred_group_ids"))
            await db.exec("ALTER TABLE catalog_teachers ADD COLUMN preferred_group_ids TEXT NOT NULL DEFAULT '[]'");
        if (bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1")
                .run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(8,CURRENT_TIMESTAMP)").run();
    })();
}
async function ensureJointColumns(db: AsyncDatabase): Promise<void> {
    const columns = async (table: string) => new Set((await db.pragma(`table_info(${table})`) as Array<{
        name: string;
    }>).map((row) => row.name));
    if (!(await columns("catalog_subjects")).has("joint_group_sets"))
        await db.exec("ALTER TABLE catalog_subjects ADD COLUMN joint_group_sets TEXT NOT NULL DEFAULT '[]'");
    const addedSameGrade = !(await columns("catalog_subjects")).has("joint_same_grade");
    if (addedSameGrade) {
        await db.exec("ALTER TABLE catalog_subjects ADD COLUMN joint_same_grade INTEGER NOT NULL DEFAULT 0");
        await db.prepare("UPDATE catalog_subjects SET joint_same_grade=1 WHERE id='pe' AND name IN ('Физкультура','Физическая культура')").run();
    }
    if (!(await columns("lessons")).has("joint_id"))
        await db.exec("ALTER TABLE lessons ADD COLUMN joint_id TEXT");
}
async function migrateHoursOnlyPlansAndGeneratorRooms(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get())
        return;
    const draft = await db
        .prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    await db.transaction(async () => {
        const columns = async (table: string) => new Set((await db.pragma(`table_info(${table})`) as Array<{
            name: string;
        }>).map((row) => row.name));
        const subjectColumns = await columns("catalog_subjects"), groupColumns = await columns("catalog_groups");
        if (!subjectColumns.has("room_kind"))
            await db.exec("ALTER TABLE catalog_subjects ADD COLUMN room_kind TEXT");
        if (!subjectColumns.has("lab_room_kind"))
            await db.exec("ALTER TABLE catalog_subjects ADD COLUMN lab_room_kind TEXT");
        if (!groupColumns.has("auto_room_ids")) {
            await db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_group_auto_rooms(
          group_id TEXT NOT NULL REFERENCES catalog_groups(id) ON DELETE CASCADE,
          room_id TEXT NOT NULL REFERENCES catalog_rooms(id),
          position INTEGER NOT NULL,
          PRIMARY KEY(group_id,room_id)
        );
      `);
        }
        // Preserve any requirement already recorded on the earlier plan model.
        const oldPlans = await columns("study_plans");
        if (oldPlans.has("room_kind")) {
            await db.prepare(`
        UPDATE catalog_subjects SET room_kind=(
          SELECT room_kind FROM study_plans p
          WHERE p.subject_id=catalog_subjects.id AND p.lesson_kind='regular'
            AND p.room_kind IS NOT NULL LIMIT 1
        ) WHERE room_kind IS NULL AND EXISTS(
          SELECT 1 FROM study_plans p WHERE p.subject_id=catalog_subjects.id
            AND p.lesson_kind='regular' AND p.room_kind IS NOT NULL
        )
      `).run();
            await db.prepare(`
        UPDATE catalog_subjects SET lab_room_kind=(
          SELECT room_kind FROM study_plans p
          WHERE p.subject_id=catalog_subjects.id AND p.lesson_kind='lab'
            AND p.room_kind IS NOT NULL LIMIT 1
        ) WHERE lab_room_kind IS NULL AND EXISTS(
          SELECT 1 FROM study_plans p WHERE p.subject_id=catalog_subjects.id
            AND p.lesson_kind='lab' AND p.room_kind IS NOT NULL
        )
      `).run();
        }
        const seed = buildSeedCatalog();
        const setRequirement = db.prepare("UPDATE catalog_subjects SET room_kind=COALESCE(room_kind,?),lab_room_kind=COALESCE(lab_room_kind,?) WHERE id=?");
        for (const subject of seed.subjects)
            await setRequirement.run(subject.roomKind, subject.labRoomKind, subject.id);
        // Plans now describe hour counts only. Keep assignment IDs, subgroup IDs,
        // and targets while removing the old teacher and room columns.
        const assignmentColumns = await columns("plan_assignments");
        if (assignmentColumns.has("teacher_id") ||
            assignmentColumns.has("room_id")) {
            await db.exec(`
        ALTER TABLE plan_assignments RENAME TO plan_assignments_v5;
        CREATE TABLE plan_assignments(
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
          subgroup_id TEXT REFERENCES catalog_subgroups(id),
          target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 1000)
        );
        INSERT INTO plan_assignments(id,plan_id,subgroup_id,target)
          SELECT id,plan_id,subgroup_id,target FROM plan_assignments_v5;
        DROP TABLE plan_assignments_v5;
      `);
        }
        const defaultRooms = await db
            .prepare(`
        SELECT id AS group_id,room_id FROM catalog_groups g
        WHERE room_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM catalog_group_auto_rooms a WHERE a.group_id=g.id
        )
      `)
            .all() as Array<{
            group_id: string;
            room_id: string;
        }>;
        const addPreferredRoom = db.prepare("INSERT OR IGNORE INTO catalog_group_auto_rooms(group_id,room_id,position) VALUES(?,?,?)");
        for (const [position, row] of defaultRooms.entries())
            await addPreferredRoom.run(row.group_id, row.room_id, position);
        if (bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(6,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateTeacherDefaultRooms(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get())
        return;
    const draft = await db
        .prepare("SELECT revision FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
    };
    await db.transaction(async () => {
        const columns = new Set((await db.pragma("table_info(catalog_teachers)") as Array<{
            name: string;
        }>).map((row) => row.name));
        if (!columns.has("default_room_id"))
            await db.exec("ALTER TABLE catalog_teachers ADD COLUMN default_room_id TEXT REFERENCES catalog_rooms(id)");
        if (bumpRevision)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(5,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateTeacherSubjects(db: AsyncDatabase, bumpRevision: boolean): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get())
        return;
    const draft = await db
        .prepare("SELECT revision,initialized FROM draft_metadata WHERE id=1")
        .get() as {
        revision: number;
        initialized: number;
    };
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_teacher_subjects(
        teacher_id TEXT NOT NULL REFERENCES catalog_teachers(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL REFERENCES catalog_subjects(id) ON DELETE CASCADE,
        PRIMARY KEY(teacher_id,subject_id)
      );
    `);
        const add = db.prepare("INSERT OR IGNORE INTO catalog_teacher_subjects(teacher_id,subject_id) VALUES(?,?)");
        const seed = buildSeedCatalog();
        for (const teacher of seed.teachers)
            for (const subjectId of teacher.subjectIds)
                await add.run(teacher.id, subjectId);
        const assignmentColumns = new Set((await db.pragma("table_info(plan_assignments)") as Array<{
            name: string;
        }>).map((row) => row.name));
        if (assignmentColumns.has("teacher_id"))
            await db.prepare(`
      INSERT OR IGNORE INTO catalog_teacher_subjects(teacher_id,subject_id)
      SELECT pa.teacher_id,sp.subject_id FROM plan_assignments pa
      JOIN study_plans sp ON sp.id=pa.plan_id
    `).run();
        await db.prepare(`
      INSERT OR IGNORE INTO catalog_teacher_subjects(teacher_id,subject_id)
      SELECT teacher_ref,subject_id FROM lessons
      WHERE teacher_ref IS NOT NULL AND subject_id <> 'event'
    `).run();
        if (bumpRevision && draft.initialized)
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(draft.revision + 1, nowIso());
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(4,CURRENT_TIMESTAMP)").run();
    })();
}
async function migratePlans(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get())
        return;
    const draftBeforeMigration = await db
        .prepare("SELECT revision, initialized FROM draft_metadata WHERE id = 1")
        .get() as {
        revision: number;
        initialized: number;
    };
    const hasLessonKind = (await db.pragma("table_info(lessons)") as Array<{
        name: string;
    }>).some((row) => row.name === "lesson_kind");
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS quarters(id TEXT PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS study_plans(id TEXT PRIMARY KEY,quarter_id TEXT NOT NULL REFERENCES quarters(id),group_id TEXT NOT NULL,subject_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('whole','subgroups')),lesson_kind TEXT NOT NULL CHECK(lesson_kind IN ('regular','lab')),room_kind TEXT,UNIQUE(quarter_id,group_id,subject_id,lesson_kind));
      CREATE TABLE IF NOT EXISTS plan_assignments(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,subgroup_id TEXT REFERENCES catalog_subgroups(id),teacher_id TEXT NOT NULL REFERENCES catalog_teachers(id),room_id TEXT REFERENCES catalog_rooms(id),target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 1000));
    `);
        if (!hasLessonKind)
            await db.exec("ALTER TABLE lessons ADD COLUMN lesson_kind TEXT NOT NULL DEFAULT 'regular'");
        const quarter: Quarter = {
            id: "quarter-2026-1",
            name: "I четверть",
            startDate: "2026-09-01",
            endDate: "2026-10-30",
        };
        await db.prepare("INSERT OR IGNORE INTO quarters(id,name,start_date,end_date) VALUES(?,?,?,?)").run(quarter.id, quarter.name, quarter.startDate, quarter.endDate);
        await initializeDraft(db);
        await seedStudyPlans(db, quarter.id);
        await fillQuarterWeeks(db, [quarter]);
        if (draftBeforeMigration.initialized) {
            await db.prepare("UPDATE draft_metadata SET revision = ?, updated_at = ? WHERE id = 1").run(draftBeforeMigration.revision + 1, nowIso());
        }
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(3,CURRENT_TIMESTAMP)").run();
    })();
}
async function seedStudyPlans(db: AsyncDatabase, quarterId: string): Promise<void> {
    const baselines = await db
        .prepare("SELECT group_id,subject_id,subgroup,target FROM plan_baselines ORDER BY group_id,subject_id,subgroup")
        .all() as Array<{
        group_id: string;
        subject_id: string;
        subgroup: string;
        target: number;
    }>;
    const schedule = await readSchedule(db), catalog = await readCatalog(db);
    const planExists = db.prepare("SELECT 1 FROM study_plans WHERE quarter_id=? AND group_id=? AND subject_id=? AND lesson_kind='regular'");
    const insertPlan = db.prepare("INSERT OR IGNORE INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind) VALUES(?,?,?,?,?,'regular',NULL)");
    const insertAssignment = db.prepare("INSERT OR IGNORE INTO plan_assignments(id,plan_id,subgroup_id,teacher_id,room_id,target) VALUES(?,?,?,?,?,?)");
    const makeKey = (g: string, s: string) => `${g}\u0000${s}`;
    const bySubject = new Map<string, typeof baselines>();
    for (const row of baselines) {
        const key = makeKey(row.group_id, row.subject_id);
        bySubject.set(key, [...(bySubject.get(key) ?? []), row]);
    }
    for (const rows of bySubject.values()) {
        const first = rows[0], split = rows.some((row) => Boolean(row.subgroup));
        const id = `plan:${quarterId}:${first.group_id}:${first.subject_id}:regular`;
        if (await planExists.get(quarterId, first.group_id, first.subject_id))
            continue;
        await insertPlan.run(id, quarterId, first.group_id, first.subject_id, split ? "subgroups" : "whole");
        for (const row of rows) {
            const subgroup = row.subgroup
                ? catalog.subgroups.find((s) => s.groupId === row.group_id && s.name === row.subgroup)
                : undefined;
            const lessons = Object.entries(schedule)
                .filter(([key]) => key.startsWith(`${row.group_id}:`))
                .flatMap(([, days]) => days.flatMap((day) => day.slots.flatMap((slot) => slot.filter((lesson) => lesson.subjectId === row.subject_id &&
                (subgroup
                    ? lesson.subgroupId === subgroup.id ||
                        lesson.subgroup === row.subgroup
                    : !lesson.subgroupId && !lesson.subgroup)))));
            const demoSubject = subjects.find((s) => s.id === row.subject_id);
            const demoSubgroup = demoSubject?.subgroups?.find((item) => subgroup &&
                item.name.split("/").at(-1) === subgroup.name.split("/").at(-1));
            const teacherId = lessons.find((item) => item.teacherId)?.teacherId ??
                teacherCatalogId(demoSubgroup?.fullTeacher ?? demoSubject?.fullTeacher ?? "");
            const roomId = lessons.find((item) => item.roomId)?.roomId ??
                roomCatalogId(demoSubgroup?.room ?? demoSubject?.room ?? "");
            if (!teacherId)
                continue;
            await insertAssignment.run(`assignment:${id}:${subgroup?.id ?? "whole"}`, id, subgroup?.id ?? null, teacherId, roomId, row.target);
        }
    }
}
async function fillQuarterWeeks(db: AsyncDatabase, quarters: Quarter[]): Promise<void> {
    const hasCalendar = Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='school_calendar'").get());
    const calendar = hasCalendar ? await readSchoolCalendar(db) : defaultSchoolCalendar();
    const groupsNow = await db.prepare("SELECT id FROM catalog_groups").all() as Array<{
        id: string;
    }>;
    const settings = await readBellSettings(db);
    const hasBellProfile = await hasColumn(db, "schedule_days", "bell_profile_json");
    const insertDay = db.prepare(hasBellProfile
        ? "INSERT OR IGNORE INTO schedule_days(group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note,bell_profile_json) VALUES(?,?,?,?,?,?,?,NULL,?)"
        : "INSERT OR IGNORE INTO schedule_days(group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note) VALUES(?,?,?,?,?,?,?,NULL)");
    const insertSlot = db.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,?,?,?)");
    for (const quarter of quarters)
        for (const offset of quarterWeeks(quarter)) {
            const dates = weekDates(offset);
            for (const group of groupsNow)
                for (let dayIndex = 0; dayIndex < (hasCalendar ? 7 : 5); dayIndex++) {
                    const date = dates[dayIndex];
                    const profile = effectiveBellProfile(settings, group.id);
                    const values: unknown[] = [
                        group.id,
                        date,
                        offset,
                        dayIndex,
                        `${String(Math.floor(profile.start / 60)).padStart(2, "0")}:${String(profile.start % 60).padStart(2, "0")}`,
                        profile.duration,
                        hasCalendar && calendarDay(calendar, group.id, date).holiday ? 1 : 0,
                    ];
                    if (hasBellProfile)
                        values.push(JSON.stringify(effectiveBellProfile(settings, group.id)));
                    const result = await insertDay.run(...values);
                    if (result.changes) {
                        const dayId = Number(result.lastInsertRowid);
                        let start = profile.start;
                        for (let slot = 0; slot < 7; slot++) {
                            await insertSlot.run(dayId, slot, start, profile.duration);
                            start += profile.duration + bellBreak(profile, slot);
                        }
                    }
                }
        }
}
async function migrateCatalog(db: AsyncDatabase): Promise<boolean> {
    const migrated = Boolean(await db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get());
    if (migrated)
        return false;
    const columns = async (table: string) => new Set((await db.pragma(`table_info(${table})`) as Array<{
        name: string;
    }>).map((row) => row.name));
    const lessonColumns = await columns("lessons");
    await db.transaction(async () => {
        await db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_subjects(id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT NOT NULL, color TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, joint_same_grade INTEGER NOT NULL DEFAULT 0, max_joint_groups INTEGER NOT NULL DEFAULT 2);
      CREATE TABLE IF NOT EXISTS catalog_teachers(id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, default_room_id TEXT REFERENCES catalog_rooms(id), preferred_group_ids TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS catalog_teacher_subjects(teacher_id TEXT NOT NULL REFERENCES catalog_teachers(id) ON DELETE CASCADE, subject_id TEXT NOT NULL REFERENCES catalog_subjects(id) ON DELETE CASCADE, PRIMARY KEY(teacher_id,subject_id));
      CREATE TABLE IF NOT EXISTS catalog_rooms(id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER, kind TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS catalog_groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, students INTEGER NOT NULL, leader_id TEXT, room_id TEXT, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS catalog_subgroups(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, students INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    `);
        if (!(await columns("catalog_subjects")).has("max_joint_groups"))
            await db.exec("ALTER TABLE catalog_subjects ADD COLUMN max_joint_groups INTEGER NOT NULL DEFAULT 2");
        if (!(await columns("catalog_teachers")).has("preferred_group_ids"))
            await db.exec("ALTER TABLE catalog_teachers ADD COLUMN preferred_group_ids TEXT NOT NULL DEFAULT '[]'");
        if (!lessonColumns.has("teacher_ref"))
            await db.exec("ALTER TABLE lessons ADD COLUMN teacher_ref TEXT");
        if (!lessonColumns.has("room_ref"))
            await db.exec("ALTER TABLE lessons ADD COLUMN room_ref TEXT");
        if (!lessonColumns.has("subgroup_ref"))
            await db.exec("ALTER TABLE lessons ADD COLUMN subgroup_ref TEXT");
        await ensureCatalogSeed(db);
        await backfillCatalogReferences(db);
        await db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP)").run();
    })();
    return true;
}
async function ensureCatalogSeed(db: AsyncDatabase): Promise<void> {
    const catalog = buildSeedCatalog();
    const tx = db.transaction(async () => {
        const subject = db.prepare("INSERT OR IGNORE INTO catalog_subjects(id,name,short_name,color,joint_same_grade,archived) VALUES(?,?,?,?,?,0)");
        for (const row of catalog.subjects) {
            await subject.run(row.id, row.name, row.shortName, row.color, Number(row.jointSameGrade ?? false));
        }
        const teacher = db.prepare("INSERT OR IGNORE INTO catalog_teachers(id,name,archived) VALUES(?,?,0)");
        for (const row of catalog.teachers) {
            await teacher.run(row.id, row.name);
        }
        const room = db.prepare("INSERT OR IGNORE INTO catalog_rooms(id,name,capacity,kind,archived) VALUES(?,?,?, ?,0)");
        for (const row of catalog.rooms) {
            await room.run(row.id, row.name, row.capacity, row.kind);
        }
        const group = db.prepare("INSERT OR IGNORE INTO catalog_groups(id,name,students,leader_id,room_id,archived) VALUES(?,?,?,?,?,0)");
        for (const row of catalog.groups) {
            await group.run(row.id, row.name, row.students, row.leaderId, row.roomId);
        }
        const subgroup = db.prepare("INSERT OR IGNORE INTO catalog_subgroups(id,group_id,name,students,archived) VALUES(?,?,?,?,0)");
        for (const row of catalog.subgroups) {
            await subgroup.run(row.id, row.groupId, row.name, row.students);
        }
    });
    await tx();
}
async function readCatalog(db: AsyncDatabase): Promise<Catalog> {
    const subjectColumns = await schemaColumns(db, "catalog_subjects");
    const teacherColumns = await schemaColumns(db, "catalog_teachers");
    const roomColumns = await schemaColumns(db, "catalog_rooms");
    const hasAutoRooms = await schemaTableExists(db, "catalog_group_auto_rooms");
    const subjects = await db
        .prepare(`SELECT id,name,short_name,color,${subjectColumns.has("room_kind") ? "room_kind" : "NULL AS room_kind"},${subjectColumns.has("lab_room_kind") ? "lab_room_kind" : "NULL AS lab_room_kind"},${subjectColumns.has("joint_group_sets") ? "joint_group_sets" : "'[]' AS joint_group_sets"},${subjectColumns.has("joint_same_grade") ? "joint_same_grade" : "0 AS joint_same_grade"},${subjectColumns.has("max_joint_groups") ? "max_joint_groups" : "2 AS max_joint_groups"},${subjectColumns.has("icon_id") ? "icon_id" : "NULL AS icon_id"},archived FROM catalog_subjects ORDER BY rowid`)
        .all() as Array<{
        id: string;
        name: string;
        short_name: string;
        color: CatalogSubject["color"];
        room_kind: RoomKind | null;
        lab_room_kind: RoomKind | null;
        joint_group_sets: string;
        joint_same_grade: number;
        max_joint_groups: number;
        icon_id: string | null;
        archived: number;
    }>;
    const teacherSubjectRows = await db
        .prepare("SELECT teacher_id,subject_id FROM catalog_teacher_subjects ORDER BY rowid")
        .all() as Array<{
        teacher_id: string;
        subject_id: string;
    }>;
    const subjectsByTeacher = new Map<string, string[]>();
    for (const row of teacherSubjectRows)
        subjectsByTeacher.set(row.teacher_id, [
            ...(subjectsByTeacher.get(row.teacher_id) ?? []),
            row.subject_id,
        ]);
    const teachers = await db
        .prepare(`SELECT id,name,archived,default_room_id,${teacherColumns.has("preferred_group_ids") ? "preferred_group_ids" : "'[]' AS preferred_group_ids"},${teacherColumns.has("preferred_shift") ? "preferred_shift" : "NULL AS preferred_shift"},${teacherColumns.has("unavailability_json") ? "unavailability_json" : "'[]' AS unavailability_json"} FROM catalog_teachers ORDER BY rowid`)
        .all() as Array<{
        id: string;
        name: string;
        archived: number;
        default_room_id: string | null;
        preferred_group_ids: string;
        preferred_shift: string | null;
        unavailability_json: string;
    }>;
    const rooms = await db
        .prepare(`SELECT id,name,capacity,kind,archived,${roomColumns.has("unavailability_json") ? "unavailability_json" : "'[]' AS unavailability_json"} FROM catalog_rooms ORDER BY rowid`)
        .all() as Array<{
        id: string;
        name: string;
        capacity: number | null;
        kind: CatalogRoom["kind"];
        archived: number;
        unavailability_json: string;
    }>;
    const groups = await db
        .prepare("SELECT id,name,students,leader_id,room_id,archived FROM catalog_groups ORDER BY rowid")
        .all() as Array<{
        id: string;
        name: string;
        students: number;
        leader_id: string | null;
        room_id: string | null;
        archived: number;
    }>;
    const subgroups = await db
        .prepare("SELECT id,group_id,name,students,archived FROM catalog_subgroups ORDER BY rowid")
        .all() as Array<{
        id: string;
        group_id: string;
        name: string;
        students: number;
        archived: number;
    }>;
    const autoRoomRows = hasAutoRooms
        ? (await db
            .prepare("SELECT group_id,room_id FROM catalog_group_auto_rooms ORDER BY group_id,position,room_id")
            .all() as Array<{
            group_id: string;
            room_id: string;
        }>)
        : [];
    const autoRoomsByGroup = new Map<string, string[]>();
    for (const row of autoRoomRows)
        autoRoomsByGroup.set(row.group_id, [
            ...(autoRoomsByGroup.get(row.group_id) ?? []),
            row.room_id,
        ]);
    return {
        subjects: subjects.map((r) => ({
            id: r.id,
            name: r.name,
            shortName: r.short_name,
            color: r.color,
            roomKind: r.room_kind,
            labRoomKind: r.lab_room_kind,
            jointGroupSets: JSON.parse(r.joint_group_sets) as string[][],
            jointSameGrade: Boolean(r.joint_same_grade),
            maxJointGroups: r.max_joint_groups,
            ...(r.icon_id === "none"
                ? { iconId: null }
                : r.icon_id === "auto" || isSubjectIconId(r.icon_id)
                    ? { iconId: r.icon_id }
                    : {}),
            archived: Boolean(r.archived),
        })),
        teachers: teachers.map((r) => ({
            id: r.id,
            name: r.name,
            archived: Boolean(r.archived),
            subjectIds: subjectsByTeacher.get(r.id) ?? [],
            defaultRoomId: r.default_room_id,
            preferredGroupIds: JSON.parse(r.preferred_group_ids) as string[],
            ...(r.preferred_shift === "morning" || r.preferred_shift === "afternoon"
                ? { preferredShift: r.preferred_shift }
                : {}),
            unavailability: parseRuleArray(r.unavailability_json),
        })),
        rooms: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            capacity: r.capacity,
            kind: r.kind,
            archived: Boolean(r.archived),
            unavailability: parseRuleArray(r.unavailability_json),
        })),
        groups: groups.map((r) => ({
            id: r.id,
            name: r.name,
            students: r.students,
            leaderId: r.leader_id,
            roomId: r.room_id,
            autoRoomIds: autoRoomsByGroup.get(r.id) ?? [],
            archived: Boolean(r.archived),
        })),
        subgroups: subgroups.map((r) => ({
            id: r.id,
            name: r.name,
            groupId: r.group_id,
            students: r.students,
            archived: Boolean(r.archived),
        })),
    };
}
function parseRuleArray(value: string): NonNullable<CatalogTeacher["unavailability"]> {
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as NonNullable<CatalogTeacher["unavailability"]> : [];
    }
    catch {
        return [];
    }
}
async function backfillCatalogReferences(db: AsyncDatabase): Promise<void> {
    const catalog = await readCatalog(db);
    const normalized = (value: string) => value.trim().toLocaleLowerCase("ru");
    const subjectById = new Map(catalog.subjects.map((entry) => [entry.id, entry]));
    const teacherAliases = new Map<string, CatalogTeacher>();
    for (const teacher of catalog.teachers) {
        teacherAliases.set(normalized(teacher.name), teacher);
        teacherAliases.set(normalized(teacher.name.split(/\s+/)[0]), teacher);
    }
    const roomAliases = new Map(catalog.rooms.map((entry) => [normalized(entry.name), entry]));
    const subgroupAliases = new Map(catalog.subgroups.map((entry) => [
        `${entry.groupId}:${normalized(entry.name)}`,
        entry,
    ]));
    const addTeacher = db.prepare("INSERT OR IGNORE INTO catalog_teachers(id,name,archived) VALUES(?,?,0)");
    const addRoom = db.prepare("INSERT OR IGNORE INTO catalog_rooms(id,name,capacity,kind,archived) VALUES(?,?,NULL,'other',0)");
    const lessons = await db
        .prepare("SELECT l.id,l.subject_id,l.teacher,l.room,l.subgroup,l.teacher_ref,l.room_ref,l.subgroup_ref,d.group_id FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id")
        .all() as Array<{
        id: string;
        subject_id: string;
        teacher: string | null;
        room: string | null;
        subgroup: string | null;
        teacher_ref: string | null;
        room_ref: string | null;
        subgroup_ref: string | null;
        group_id: string;
    }>;
    const update = db.prepare("UPDATE lessons SET teacher_ref=?,room_ref=?,subgroup_ref=? WHERE id=?");
    const tx = db.transaction(async () => {
        for (const lesson of lessons) {
            const subject = subjectById.get(lesson.subject_id);
            let teacher = lesson.teacher_ref
                ? catalog.teachers.find((entry) => entry.id === lesson.teacher_ref)
                : lesson.teacher
                    ? teacherAliases.get(normalized(lesson.teacher))
                    : undefined;
            if (!lesson.teacher_ref && !teacher && lesson.teacher) {
                const id = teacherCatalogId(lesson.teacher);
                await addTeacher.run(id, lesson.teacher.trim());
                teacher = {
                    id,
                    name: lesson.teacher.trim(),
                    archived: false,
                    subjectIds: subject ? [subject.id] : [],
                    defaultRoomId: null,
                };
                teacherAliases.set(normalized(lesson.teacher), teacher);
            }
            let room = lesson.room_ref
                ? catalog.rooms.find((entry) => entry.id === lesson.room_ref)
                : lesson.room
                    ? roomAliases.get(normalized(lesson.room))
                    : undefined;
            if (!lesson.room_ref && !room && lesson.room) {
                const id = roomCatalogId(lesson.room);
                await addRoom.run(id, lesson.room.trim());
                room = {
                    id,
                    name: lesson.room.trim(),
                    capacity: null,
                    kind: "other",
                    archived: false,
                };
                roomAliases.set(normalized(lesson.room), room);
            }
            const defaultTeacher = subject
                ? catalog.teachers.find((entry) => entry.id ===
                    teacherCatalogId(subjects.find((s) => s.id === subject.id)?.fullTeacher ?? ""))
                : undefined;
            const defaultRoom = subject
                ? catalog.rooms.find((entry) => entry.id ===
                    roomCatalogId(subjects.find((s) => s.id === subject.id)?.room ?? ""))
                : undefined;
            let subgroup = lesson.subgroup_ref
                ? catalog.subgroups.find((entry) => entry.id === lesson.subgroup_ref)
                : lesson.subgroup
                    ? subgroupAliases.get(`${lesson.group_id}:${normalized(lesson.subgroup)}`)
                    : undefined;
            if (!lesson.subgroup_ref && !subgroup && lesson.subgroup) {
                const id = subgroupCatalogId(lesson.group_id, lesson.subgroup);
                const insert = db.prepare("INSERT OR IGNORE INTO catalog_subgroups(id,group_id,name,students,archived) VALUES(?,?,?,0,0)");
                await insert.run(id, lesson.group_id, lesson.subgroup.trim());
                subgroup = {
                    id,
                    groupId: lesson.group_id,
                    name: lesson.subgroup.trim(),
                    students: 0,
                    archived: false,
                };
                subgroupAliases.set(`${lesson.group_id}:${normalized(lesson.subgroup)}`, subgroup);
            }
            await update.run(teacher?.id ?? defaultTeacher?.id ?? null, room?.id ?? defaultRoom?.id ?? null, subgroup?.id ?? null, lesson.id);
        }
    });
    await tx();
}
async function initializeDraft(db: AsyncDatabase): Promise<void> {
    const meta = await db
        .prepare("SELECT initialized FROM draft_metadata WHERE id = 1")
        .get() as {
        initialized: number;
    };
    if (meta.initialized)
        return;
    const schedule = createSchedule();
    const tx = db.transaction(async () => {
        await writeSchedule(db, schedule);
        const baseline: PlanBaseline[] = [];
        for (const group of groups) {
            for (const subject of subjects) {
                const subgroupNames = [
                    ...new Set(Object.entries(schedule)
                        .filter(([scheduleKey]) => scheduleKey.startsWith(`${group.id}:`))
                        .flatMap(([, days]) => days.flatMap((day) => day.slots.flatMap((slot) => slot
                        .filter((lesson) => lesson.subjectId === subject.id && lesson.subgroup)
                        .map((lesson) => lesson.subgroup!))))),
                ];
                if (subgroupNames.length) {
                    for (const subgroupName of subgroupNames) {
                        const subgroup = subject.subgroups?.find((entry) => entry.name.split("/").at(-1) === subgroupName.split("/").at(-1));
                        baseline.push({
                            groupId: group.id,
                            subjectId: subject.id,
                            subgroup: subgroupName,
                            planned: subgroup?.planned ?? subject.planned,
                            target: subgroup?.target ?? subject.target,
                            initialCount: countLessons(schedule, group.id, subject.id, subgroupName),
                        });
                    }
                }
                else {
                    baseline.push({
                        groupId: group.id,
                        subjectId: subject.id,
                        subgroup: null,
                        planned: subject.planned,
                        target: subject.target,
                        initialCount: countLessons(schedule, group.id, subject.id),
                    });
                }
            }
        }
        const insert = db.prepare(`INSERT INTO plan_baselines(group_id, subject_id, subgroup, planned, target, initial_count)
      VALUES (@groupId, @subjectId, @subgroup, @planned, @target, @initialCount)`);
        for (const row of baseline)
            await insert.run({ ...row, subgroup: row.subgroup ?? "" });
        await db.prepare("UPDATE draft_metadata SET initialized = 1, revision = 1, updated_at = ? WHERE id = 1").run(nowIso());
    });
    await tx();
}
function countLessons(schedule: Schedule, groupId: string, subjectId: string, subgroup?: string): number {
    let count = 0;
    for (const [key, days] of Object.entries(schedule)) {
        if (!key.startsWith(`${groupId}:`))
            continue;
        for (const day of days)
            for (const slot of day.slots)
                for (const lesson of slot) {
                    if (lesson.subjectId === subjectId &&
                        (subgroup
                            ? !lesson.subgroup || lesson.subgroup === subgroup
                            : !lesson.subgroup))
                        count += 1;
                }
    }
    return count;
}
async function writeSchedule(db: AsyncDatabase, schedule: Schedule): Promise<void> {
    const previousLessonIds = new Set(locatedLessons(await readSchedule(db)).map((item) => item.lesson.id));
    const catalog = await readCatalog(db);
    const legacyBellSettings = defaultBellSettings();
    const previousProfiles = new Map<string, BellProfile>();
    if (await hasColumn(db, "schedule_days", "bell_profile_json")) {
        const rows = await db.prepare("SELECT group_id,date,bell_profile_json FROM schedule_days WHERE bell_profile_json IS NOT NULL").all() as Array<{
            group_id: string;
            date: string;
            bell_profile_json: string;
        }>;
        for (const row of rows) {
            try {
                const profile = JSON.parse(row.bell_profile_json);
                if (!validateBellProfile(profile))
                    previousProfiles.set(`${row.group_id}:${row.date}`, profile as BellProfile);
            }
            catch { /* Invalid snapshots fall back to the legacy default profile. */ }
        }
    }
    const teacherById = new Map(catalog.teachers.map((entry) => [entry.id, entry]));
    const roomById = new Map(catalog.rooms.map((entry) => [entry.id, entry]));
    const subjectDefaults = new Map(subjects.map((entry) => [entry.id, entry]));
    const defaultTeacherBySubjectId = new Map<string, CatalogTeacher>();
    const defaultRoomBySubjectId = new Map<string, CatalogRoom>();
    const subgroupById = new Map(catalog.subgroups.map((entry) => [entry.id, entry]));
    const teacherDefaultsByName = new Map<string, CatalogTeacher | undefined>();
    const roomDefaultsByName = new Map<string, CatalogRoom | undefined>();
    const teacherDefault = (name: string | undefined) => {
        if (!name)
            return undefined;
        if (!teacherDefaultsByName.has(name))
            teacherDefaultsByName.set(name, teacherById.get(teacherCatalogId(name)));
        return teacherDefaultsByName.get(name);
    };
    const roomDefault = (name: string | undefined) => {
        if (!name)
            return undefined;
        if (!roomDefaultsByName.has(name))
            roomDefaultsByName.set(name, roomById.get(roomCatalogId(name)));
        return roomDefaultsByName.get(name);
    };
    for (const subject of subjects) {
        const defaultTeacherId = teacherCatalogId(subject.fullTeacher ?? "");
        const defaultTeacher = teacherById.get(defaultTeacherId);
        if (defaultTeacher)
            defaultTeacherBySubjectId.set(subject.id, defaultTeacher);
        const defaultRoomId = roomCatalogId(subject.room ?? "");
        const defaultRoom = roomById.get(defaultRoomId);
        if (defaultRoom)
            defaultRoomBySubjectId.set(subject.id, defaultRoom);
    }
    const teacherByLabelCache = new Map<string, CatalogTeacher | undefined>();
    const teacherByLabel = (label: string | undefined) => {
        if (!label)
            return undefined;
        const normalized = label.trim().toLocaleLowerCase("ru");
        if (teacherByLabelCache.has(normalized))
            return teacherByLabelCache.get(normalized);
        const exact = catalog.teachers.find((entry) => entry.name.trim().toLocaleLowerCase("ru") === normalized);
        if (exact) {
            teacherByLabelCache.set(normalized, exact);
            return exact;
        }
        const surnameMatches = catalog.teachers.filter((entry) => entry.name.trim().split(/\s+/)[0]?.toLocaleLowerCase("ru") === normalized);
        const resolved = surnameMatches.length === 1 ? surnameMatches[0] : undefined;
        teacherByLabelCache.set(normalized, resolved);
        return resolved;
    };
    const roomByLabel = new Map<string, CatalogRoom>();
    for (const entry of catalog.rooms) {
        const name = entry.name.toLocaleLowerCase("ru");
        if (!roomByLabel.has(name))
            roomByLabel.set(name, entry);
    }
    await db.exec("DELETE FROM schedule_days");
    const snapshots = await hasColumn(db, "schedule_days", "bell_profile_json");
    const insertDay = db.prepare(snapshots
        ? `INSERT INTO schedule_days(group_id, date, week_offset, day_index, base_start, nominal_duration, holiday, note, bell_profile_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO schedule_days(group_id, date, week_offset, day_index, base_start, nominal_duration, holiday, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertSlot = db.prepare("INSERT INTO schedule_slots(day_id, slot_index, start_minute, duration) VALUES (?, ?, ?, ?)");
    const insertLesson = db.prepare(`INSERT INTO lessons(id, slot_id, subject_id, subgroup, teacher, room, event, note, teacher_ref, room_ref, subgroup_ref, lesson_kind, joint_id, event_remainder_json)
    VALUES (@id, @slotId, @subjectId, @subgroup, @teacher, @room, @event, @note, @teacherRef, @roomRef, @subgroupRef, @lessonKind, @jointId, @eventRemainderJson)`);
    for (const [scheduleKey, days] of Object.entries(schedule)) {
        const split = scheduleKey.lastIndexOf(":");
        const groupId = scheduleKey.slice(0, split);
        const weekOffset = Number(scheduleKey.slice(split + 1));
        for (const [dayIndex, day] of days.entries()) {
            const bellProfile = day.bellProfile ?? previousProfiles.get(`${groupId}:${day.date}`) ?? effectiveBellProfile(legacyBellSettings, groupId);
            const result = await insertDay.run(groupId, day.date, weekOffset, dayIndex, day.start, day.duration, day.holiday ? 1 : 0, day.note ?? null, ...(snapshots ? [JSON.stringify(bellProfile)] : []));
            const dayId = Number(result.lastInsertRowid);
            for (const [slotIndex, lessons] of day.slots.entries()) {
                const time = day.times[slotIndex];
                const slotResult = await insertSlot.run(dayId, slotIndex, time.start, time.duration);
                const slotId = Number(slotResult.lastInsertRowid);
                for (const lesson of lessons) {
                    const teacherLabel = lesson.teacher?.trim();
                    const subgroup = lesson.subgroupId
                        ? subgroupById.get(lesson.subgroupId)
                        : catalog.subgroups.find((entry) => entry.groupId === groupId &&
                            entry.name.toLocaleLowerCase("ru") ===
                                lesson.subgroup?.trim().toLocaleLowerCase("ru"));
                    const teacher = lesson.teacherId
                        ? teacherById.get(lesson.teacherId)
                        : teacherByLabel(teacherLabel);
                    const room = lesson.roomId
                        ? roomById.get(lesson.roomId)
                        : lesson.room?.trim()
                            ? roomByLabel.get(lesson.room.trim().toLocaleLowerCase("ru"))
                            : undefined;
                    const defaults = subjectDefaults.get(lesson.subjectId);
                    const subgroupDefaults = defaults?.subgroups?.find((entry) => entry.name.split("/").at(-1)?.toLocaleLowerCase("ru") ===
                        subgroup?.name.split("/").at(-1)?.toLocaleLowerCase("ru"));
                    const defaultTeacherName = subgroupDefaults?.fullTeacher ?? defaults?.fullTeacher;
                    const defaultTeacher = defaultTeacherName
                        ? teacherDefault(defaultTeacherName)
                        : defaults ? defaultTeacherBySubjectId.get(defaults.id) : undefined;
                    const defaultRoomName = subgroupDefaults?.room ?? defaults?.room;
                    const defaultRoom = defaultRoomName
                        ? roomDefault(defaultRoomName)
                        : defaults ? defaultRoomBySubjectId.get(defaults.id) : undefined;
                    await insertLesson.run({
                        id: lesson.id,
                        slotId,
                        subjectId: lesson.subjectId,
                        subgroup: lesson.subgroup ?? null,
                        teacher: teacher?.name ??
                            (teacherLabel ? lesson.teacher : (defaultTeacher?.name ?? null)),
                        room: room?.name ??
                            (lesson.room?.trim() ? lesson.room : (defaultRoom?.name ?? null)),
                        event: lesson.event ?? null,
                        note: lesson.note ?? null,
                        lessonKind: lesson.lessonKind ?? "regular",
                        jointId: lesson.jointId ?? null,
                        eventRemainderJson: lesson.eventRemainder ? JSON.stringify(lesson.eventRemainder) : null,
                        teacherRef: teacher?.id ?? (!teacherLabel ? defaultTeacher?.id : null),
                        roomRef: room?.id ?? (!lesson.room?.trim() ? defaultRoom?.id : null),
                        subgroupRef: subgroup?.id ?? null,
                    });
                }
            }
        }
    }
    await markChangedOriginsManual(db, schedule);
    await registerAcceptedAssignmentOrigins(db, schedule, previousLessonIds);
}
async function replaceEditorDays(db: AsyncDatabase, schedule: Schedule, changes: EditorDayChange[]): Promise<void> {
    const catalog = await readCatalog(db);
    const teachers = new Map(catalog.teachers.map((entry) => [entry.id, entry]));
    const rooms = new Map(catalog.rooms.map((entry) => [entry.id, entry]));
    const subgroups = new Map(catalog.subgroups.map((entry) => [entry.id, entry]));
    const teacherNames = new Map(catalog.teachers.map((entry) => [entry.name.toLocaleLowerCase("ru"), entry]));
    const roomNames = new Map(catalog.rooms.map((entry) => [entry.name.toLocaleLowerCase("ru"), entry]));
    const insertSlot = db.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,?,?,?)");
    const insertLesson = db.prepare(`INSERT INTO lessons(id,slot_id,subject_id,subgroup,teacher,room,event,note,teacher_ref,room_ref,subgroup_ref,lesson_kind,joint_id,event_remainder_json)
    VALUES(@id,@slotId,@subjectId,@subgroup,@teacher,@room,@event,@note,@teacherRef,@roomRef,@subgroupRef,@lessonKind,@jointId,@eventRemainderJson)`);
    const changedIds = new Set<string>();
    const previousIds = new Set<string>();
    type Lesson = EditorDayChange["before"]["slots"][number][number];
    type StoredRow = Record<string, string | number | null>;
    const previousLessons = new Map<string, Lesson>();
    const storedLessons = new Map<string, StoredRow>();
    const pending: Array<{
        groupId: string;
        dayId: number;
        day: EditorDayChange["after"];
        slots: Map<number, { id: number; start_minute: number; duration: number }>;
    }> = [];
    for (const change of changes) {
        const groupId = change.key.slice(0, change.key.lastIndexOf(":"));
        const day = change.after;
        const row = await db.prepare("SELECT id,week_offset,bell_profile_json FROM schedule_days WHERE group_id=? AND date=?")
            .get(groupId, day.date) as {
            id: number;
            week_offset: number;
            bell_profile_json: string | null;
        } | undefined;
        if (!row)
            throw new Error("editor-day-missing");
        const dayId = row.id;
        const dayFields: string[] = [];
        const dayValues: unknown[] = [];
        const dayField = (column: string, before: unknown, after: unknown, value: unknown = after) => {
            if (stableJson(before) === stableJson(after)) return;
            dayFields.push(`${column}=?`);
            dayValues.push(value);
        };
        dayField("base_start", change.before.start, day.start);
        dayField("nominal_duration", change.before.duration, day.duration);
        dayField("holiday", Boolean(change.before.holiday), Boolean(day.holiday), day.holiday ? 1 : 0);
        dayField("note", change.before.note ?? null, day.note ?? null);
        dayField("bell_profile_json", change.before.bellProfile ?? null, day.bellProfile ?? null,
            day.bellProfile ? JSON.stringify(day.bellProfile) : row.bell_profile_json);
        if (dayFields.length)
            await db.prepare(`UPDATE schedule_days SET ${dayFields.join(",")} WHERE id=?`).run(...dayValues, dayId);
        const slotRows = await db.prepare("SELECT id,slot_index,start_minute,duration FROM schedule_slots WHERE day_id=?").all(dayId) as Array<{
            id: number; slot_index: number; start_minute: number; duration: number;
        }>;
        const slots = new Map(slotRows.map((slot) => [slot.slot_index, slot]));
        const lessonRows = await db.prepare("SELECT l.* FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id WHERE s.day_id=?").all(dayId) as StoredRow[];
        for (const lesson of lessonRows) storedLessons.set(String(lesson.id), lesson);
        for (const [slotIndex, time] of day.times.entries()) {
            const slot = slots.get(slotIndex);
            if (!slot) {
                const result = await insertSlot.run(dayId, slotIndex, time.start, time.duration);
                slots.set(slotIndex, { id: Number(result.lastInsertRowid), slot_index: slotIndex, start_minute: time.start, duration: time.duration });
            }
            else if (slot.start_minute !== time.start || slot.duration !== time.duration)
                await db.prepare("UPDATE schedule_slots SET start_minute=?,duration=? WHERE id=?").run(time.start, time.duration, slot.id);
        }
        for (const slot of change.before.slots)
            for (const lesson of slot) {
                previousIds.add(lesson.id);
                previousLessons.set(lesson.id, lesson);
            }
        for (const slot of day.slots)
            for (const lesson of slot)
                changedIds.add(lesson.id);
        pending.push({ groupId, dayId, day, slots });
    }
    // Create destinations before moving existing lessons. Keep every original slot
    // until all moves (including cross-day swaps and joint mirrors) are persisted.
    for (const { groupId, day, slots } of pending) {
        for (const [slotIndex, lessons] of day.slots.entries()) {
                    const slotId = slots.get(slotIndex)!.id;
                    for (const lesson of lessons) {
                        const teacher = lesson.teacherId ? teachers.get(lesson.teacherId) : lesson.teacher ? teacherNames.get(lesson.teacher.trim().toLocaleLowerCase("ru")) : undefined;
                        const room = lesson.roomId ? rooms.get(lesson.roomId) : lesson.room ? roomNames.get(lesson.room.trim().toLocaleLowerCase("ru")) : undefined;
                        const subgroup = lesson.subgroupId ? subgroups.get(lesson.subgroupId) : catalog.subgroups.find((entry) => entry.groupId === groupId && entry.name.toLocaleLowerCase("ru") === lesson.subgroup?.trim().toLocaleLowerCase("ru"));
                        const values = {
                            id: lesson.id, slotId, subjectId: lesson.subjectId,
                            subgroup: lesson.subgroup ?? null, teacher: teacher?.name ?? lesson.teacher ?? null,
                            room: room?.name ?? lesson.room ?? null, event: lesson.event ?? null,
                            note: lesson.note ?? null, teacherRef: teacher?.id ?? null, roomRef: room?.id ?? null,
                            subgroupRef: subgroup?.id ?? null, lessonKind: lesson.lessonKind ?? "regular", jointId: lesson.jointId ?? null,
                            eventRemainderJson: lesson.eventRemainder ? JSON.stringify(lesson.eventRemainder) : null,
                        };
                        const stored = storedLessons.get(lesson.id);
                        if (!stored) {
                            await insertLesson.run(values);
                            continue;
                        }
                        const before = previousLessons.get(lesson.id);
                        if (!before) throw new Error("editor-lesson-missing");
                        const fields: string[] = [];
                        const args: unknown[] = [];
                        const field = (column: string, value: unknown) => {
                            if (stored[column] === value) return;
                            fields.push(`${column}=?`);
                            args.push(value);
                        };
                        const logicalChanged = (...keys: Array<keyof Lesson>) => keys.some((key) => stableJson(before[key] ?? null) !== stableJson(lesson[key] ?? null));
                        field("slot_id", slotId);
                        if (logicalChanged("subjectId")) field("subject_id", values.subjectId);
                        if (logicalChanged("note")) field("note", values.note);
                        if (logicalChanged("event")) field("event", values.event);
                        if (logicalChanged("lessonKind")) field("lesson_kind", values.lessonKind);
                        if (logicalChanged("jointId")) field("joint_id", values.jointId);
                        if (logicalChanged("eventRemainder")) field("event_remainder_json", values.eventRemainderJson);
                        // Catalog labels are derived display values. Keeping the
                        // same reference must not rewrite a legacy raw label.
                        if (before.teacherId !== lesson.teacherId || (!lesson.teacherId && logicalChanged("teacher"))) {
                            field("teacher", values.teacher);
                            field("teacher_ref", values.teacherRef);
                        }
                        if (before.roomId !== lesson.roomId || (!lesson.roomId && logicalChanged("room"))) {
                            field("room", values.room);
                            field("room_ref", values.roomRef);
                        }
                        if (before.subgroupId !== lesson.subgroupId || (!lesson.subgroupId && logicalChanged("subgroup"))) {
                            field("subgroup", values.subgroup);
                            field("subgroup_ref", values.subgroupRef);
                        }
                        if (fields.length)
                            await db.prepare(`UPDATE lessons SET ${fields.join(",")} WHERE id=?`).run(...args, lesson.id);
                    }
        }
    }
    for (const id of previousIds)
        if (!changedIds.has(id)) await db.prepare("DELETE FROM lessons WHERE id=?").run(id);
    for (const { day, slots } of pending)
        for (const [index, slot] of slots)
            if (index >= day.slots.length) await db.prepare("DELETE FROM schedule_slots WHERE id=?").run(slot.id);
    await markScopedOriginsManual(db, new Set([...previousIds, ...changedIds]), schedule);
    const changedSchedule: Schedule = {};
    for (const { groupId, day } of pending) {
        const offset = weekOffsetFor(day.date);
        const key = scheduleKey(groupId, offset);
        (changedSchedule[key] ??= []).push(day);
    }
    await registerAcceptedAssignmentOrigins(db, changedSchedule, previousIds);
}
async function markScopedOriginsManual(db: AsyncDatabase, lessonIds: Set<string>, schedule: Schedule): Promise<void> {
    if (!lessonIds.size || !await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teacher_lesson_origins'").get())
        return;
    const ids = [...lessonIds];
    const rows: Array<{
        id: string;
        lesson_id: string;
        origin_json: string;
    }> = [];
    for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500);
        rows.push(...await db.prepare(`SELECT id,lesson_id,origin_json FROM teacher_lesson_origins WHERE lesson_id IN (${chunk.map(() => "?").join(",")})`)
            .all(...chunk) as Array<{
            id: string;
            lesson_id: string;
            origin_json: string;
        }>);
    }
    const current = new Map(locatedLessons(schedule).map((item) => [item.lesson.id, item]));
    const update = db.prepare("UPDATE teacher_lesson_origins SET origin_json=? WHERE id=?");
    for (const row of rows) {
        try {
            const origin = JSON.parse(row.origin_json) as TeacherLessonOrigin;
            if (origin.status !== "active")
                continue;
            const lesson = current.get(row.lesson_id);
            if (lesson && teacherLessonFingerprint(lesson) === origin.expected)
                continue;
            await update.run(JSON.stringify({ ...origin, status: "manual" }), row.id);
        }
        catch { /* Ignore malformed legacy metadata; it does not block a lesson edit. */ }
    }
}
async function markChangedOriginsManual(db: AsyncDatabase, schedule: Schedule): Promise<void> {
    if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teacher_lesson_origins'").get())
        return;
    const origins = await readTeacherLessonOrigins(db);
    if (!origins.length)
        return;
    const current = new Map(locatedLessons(schedule).map((item) => [item.lesson.id, item]));
    let changed = false;
    const next = origins.map((origin) => {
        if (origin.status !== "active")
            return origin;
        const lesson = current.get(origin.lessonId);
        if (lesson && teacherLessonFingerprint(lesson) === origin.expected)
            return origin;
        changed = true;
        return { ...origin, status: "manual" as const };
    });
    if (changed)
        await writeTeacherLessonOrigins(db, next);
}
async function registerAcceptedAssignmentOrigins(db: AsyncDatabase, schedule: Schedule, previousLessonIds: Set<string>): Promise<void> {
    if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teacher_lesson_origins'").get())
        return;
    const catalog = await readCatalog(db);
    const replacements = await readTemporaryTeacherReplacements(db);
    const assignments = await readTeacherTeachingAssignments(db);
    if (!replacements.length && !assignments.length)
        return;
    const origins = await readTeacherLessonOrigins(db);
    const next = [...origins];
    for (const item of locatedLessons(schedule)) {
        // A persisted lesson ID has an existing history. Keep manual/returned provenance intact;
        // newly generated lessons after a clear receive fresh origin metadata.
        if (previousLessonIds.has(item.lesson.id))
            continue;
        const targetTeacherId = item.lesson.teacherId;
        if (!targetTeacherId)
            continue;
        const subgroupMatches = (entry: {
            subgroupId?: string;
            subgroup?: string;
        }) => {
            if (entry.subgroupId || item.lesson.subgroupId)
                return entry.subgroupId === item.lesson.subgroupId;
            if (entry.subgroup || item.lesson.subgroup)
                return (entry.subgroup ?? "") === (item.lesson.subgroup ?? "");
            return true;
        };
        let match: Omit<TeacherLessonOrigin, "id" | "expected" | "status"> | undefined;
        const replacement = replacements.find((entry) => entry.groupId === item.groupId && entry.subjectId === item.lesson.subjectId && entry.startDate <= item.date && entry.endDate >= item.date && entry.teacherIds.includes(targetTeacherId) && subgroupMatches(entry) && findUnavailability(catalog, "teacher", entry.sourceTeacherId, item.date, item.start, item.end).some((unavailable) => !entry.unavailabilityRuleId || unavailable.ruleId === entry.unavailabilityRuleId));
        if (replacement) {
            const unavailable = findUnavailability(catalog, "teacher", replacement.sourceTeacherId, item.date, item.start, item.end).find((entry) => !replacement.unavailabilityRuleId || entry.ruleId === replacement.unavailabilityRuleId);
            if (unavailable)
                match = { lessonId: item.lesson.id, groupId: item.groupId, date: item.date, sourceTeacherId: replacement.sourceTeacherId, substituteTeacherId: targetTeacherId, kind: "absence", absenceRuleId: unavailable.ruleId, startDate: replacement.startDate, endDate: replacement.endDate };
        }
        if (!match) {
            const assignment = assignments.find((entry) => entry.groupId === item.groupId && entry.subjectId === item.lesson.subjectId && entry.targetTeacherId === targetTeacherId && entry.startDate <= item.date && (entry.endDate === null || entry.endDate >= item.date) && subgroupMatches(entry));
            if (assignment)
                match = { lessonId: item.lesson.id, groupId: item.groupId, date: item.date, sourceTeacherId: assignment.sourceTeacherId, substituteTeacherId: targetTeacherId, kind: assignment.absenceRuleId ? "absence" : "transfer", ...(assignment.absenceRuleId ? { absenceRuleId: assignment.absenceRuleId } : {}), startDate: assignment.startDate, endDate: assignment.endDate };
        }
        if (!match)
            continue;
        const expected = teacherLessonFingerprint(item);
        if (next.some((origin) => origin.lessonId === item.lesson.id && origin.status === "active" && origin.expected === expected && origin.substituteTeacherId === targetTeacherId))
            continue;
        for (let index = next.length - 1; index >= 0; index -= 1)
            if (next[index]!.lessonId === item.lesson.id && next[index]!.status === "active")
                next.splice(index, 1);
        next.push({ ...match, id: `generated:${item.lesson.id}:${randomToken(5)}`, expected, status: "active" });
    }
    if (next.length !== origins.length || next.some((origin, index) => origin !== origins[index]))
        await writeTeacherLessonOrigins(db, next);
}
async function readSchedule(db: AsyncDatabase, catalog: Catalog | undefined = undefined, dates?: string[], groupIds?: string[], resource?: {
    kind: "teacher" | "room";
    id: string;
}): Promise<Schedule> {
    // Empty scopes mean no rows, including the metadata-only bulk-operation read.
    // PostgreSQL rejects IN (), while SQLite treats it as an empty result.
    if (dates?.length === 0 || groupIds?.length === 0) return {};
    catalog ??= await readCatalog(db);
    const schedule: Schedule = {};
    const bellProfileColumn = await hasColumn(db, "schedule_days", "bell_profile_json") ? "d.bell_profile_json"
        : "NULL AS bell_profile_json";
    const clauses: string[] = [];
    const args: string[] = [];
    if (dates) {
        clauses.push(`d.date IN (${dates.map(() => "?").join(",")})`);
        args.push(...dates);
    }
    if (groupIds) {
        clauses.push(`d.group_id IN (${groupIds.map(() => "?").join(",")})`);
        args.push(...groupIds);
    }
    if (resource) {
        const column = resource.kind === "teacher" ? "teacher_ref" : "room_ref";
        const label = resource.kind === "teacher" ? "teacher" : "room";
        const entry = (resource.kind === "teacher" ? catalog.teachers : catalog.rooms).find((row) => row.id === resource.id);
        clauses.push(`(l.${column}=? OR (l.${column} IS NULL AND l.${label}=?))`);
        args.push(resource.id, entry?.name ?? "");
    }
    const dateClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await db.prepare(`
    SELECT d.id AS day_id,d.group_id,d.date,d.week_offset,d.base_start,d.nominal_duration,d.holiday,d.note,${bellProfileColumn},
      s.id AS slot_id,s.slot_index,s.start_minute,s.duration AS slot_duration,
      l.id AS lesson_id,l.subject_id,l.subgroup,l.teacher,l.room,l.event,l.note AS lesson_note,
      l.teacher_ref,l.room_ref,l.subgroup_ref,l.lesson_kind,l.joint_id,l.event_remainder_json
    FROM schedule_days d
    LEFT JOIN schedule_slots s ON s.day_id=d.id
    LEFT JOIN lessons l ON l.slot_id=s.id
    ${dateClause}
    ORDER BY d.group_id,d.week_offset,d.day_index,s.slot_index,l.rowid
  `).all(...args) as Array<{
        day_id: number;
        group_id: string;
        date: string;
        week_offset: number;
        base_start: string;
        nominal_duration: number;
        holiday: number;
        note: string | null;
        bell_profile_json: string | null;
        slot_id: number | null;
        slot_index: number | null;
        start_minute: number | null;
        slot_duration: number | null;
        lesson_id: string | null;
        subject_id: string | null;
        subgroup: string | null;
        teacher: string | null;
        room: string | null;
        event: string | null;
        lesson_note: string | null;
        teacher_ref: string | null;
        room_ref: string | null;
        subgroup_ref: string | null;
        lesson_kind: LessonKind | null;
        joint_id: string | null;
        event_remainder_json: string | null;
    }>;
    type BuiltDay = {
        row: (typeof rows)[number];
        slots: Array<{
            id: number;
            start: number;
            duration: number;
            lessons: Schedule[string][number]["slots"][number];
        }>;
    };
    const orderedDays: BuiltDay[] = [];
    const dayById = new Map<number, BuiltDay>();
    const legacyBellSettings = defaultBellSettings();
    const teacherNames = new Map(catalog.teachers.map((entry) => [entry.id, entry.name]));
    const roomNames = new Map(catalog.rooms.map((entry) => [entry.id, entry.name]));
    const subgroupNames = new Map(catalog.subgroups.map((entry) => [entry.id, entry.name]));
    for (const row of rows) {
        let built = dayById.get(row.day_id);
        if (!built) {
            built = { row, slots: [] };
            dayById.set(row.day_id, built);
            orderedDays.push(built);
        }
        if (row.slot_id === null)
            continue;
        let slot = built.slots.at(-1);
        if (!slot || slot.id !== row.slot_id) {
            slot = {
                id: row.slot_id,
                start: row.start_minute!,
                duration: row.slot_duration!,
                lessons: [],
            };
            built.slots.push(slot);
        }
        if (row.lesson_id === null)
            continue;
        const eventRemainder = parseEventRemainder(row.event_remainder_json, row.subject_id === "event" && Boolean(row.event));
        slot.lessons.push({
            id: row.lesson_id,
            subjectId: row.subject_id!,
            lessonKind: row.lesson_kind!,
            ...(row.joint_id ? { jointId: row.joint_id } : {}),
            ...(row.subgroup_ref
                ? {
                    subgroupId: row.subgroup_ref,
                    subgroup: subgroupNames.get(row.subgroup_ref) ?? row.subgroup ?? undefined,
                }
                : row.subgroup ? { subgroup: row.subgroup } : {}),
            ...(row.teacher_ref
                ? {
                    teacherId: row.teacher_ref,
                    teacher: teacherNames.get(row.teacher_ref) ?? row.teacher ?? undefined,
                }
                : row.teacher ? { teacher: row.teacher } : {}),
            ...(row.room_ref
                ? { roomId: row.room_ref, room: roomNames.get(row.room_ref) ?? row.room ?? undefined }
                : row.room ? { room: row.room } : {}),
            ...(row.event ? { event: row.event } : {}),
            ...(eventRemainder ? { eventRemainder } : {}),
            ...(row.lesson_note ? { note: row.lesson_note } : {}),
        });
    }
    for (const built of orderedDays) {
        const day = built.row;
        const scheduleKey = `${day.group_id}:${day.week_offset}`;
        const times = built.slots.map((slot) => ({ start: slot.start, duration: slot.duration }));
        const lessonSlots = built.slots.map((slot) => slot.lessons);
        const start = times.length
            ? `${String(Math.floor(times[0].start / 60)).padStart(2, "0")}:${String(times[0].start % 60).padStart(2, "0")}`
            : day.base_start;
        const breaks = times
            .slice(0, -1)
            .map((time, index) => times[index + 1].start - time.start - time.duration);
        (schedule[scheduleKey] ??= []).push({
            date: day.date,
            start,
            duration: day.nominal_duration,
            breaks,
            slots: lessonSlots,
            times,
            ...(day.note ? { note: day.note } : {}),
            bellProfile: (() => {
                if (day.bell_profile_json) {
                    try {
                        const profile = JSON.parse(day.bell_profile_json);
                        if (!validateBellProfile(profile))
                            return profile as BellProfile;
                    }
                    catch { /* Legacy or invalid snapshot uses the legacy default profile. */ }
                }
                return effectiveBellProfile(legacyBellSettings, day.group_id);
            })(),
            ...(day.holiday ? { holiday: true } : {}),
        });
    }
    return schedule;
}
async function readBaseline(db: AsyncDatabase, catalog: Catalog | undefined = undefined, groupId?: string): Promise<PlanBaseline[]> {
    catalog ??= await readCatalog(db);
    const rows = await db
        .prepare(`SELECT group_id, subject_id, subgroup, planned, target, initial_count FROM plan_baselines ${groupId ? "WHERE group_id=?" : ""} ORDER BY group_id, subject_id, subgroup`)
        .all(...(groupId ? [groupId] : [])) as Array<{
        group_id: string;
        subject_id: string;
        subgroup: string;
        planned: number;
        target: number;
        initial_count: number;
    }>;
    const subgroups = new Map(catalog.subgroups.map((entry) => [
        `${entry.groupId}:${entry.name.toLocaleLowerCase("ru")}`,
        entry,
    ]));
    return rows.map((row) => {
        const subgroup = row.subgroup
            ? subgroups.get(`${row.group_id}:${row.subgroup.toLocaleLowerCase("ru")}`)
            : undefined;
        return {
            groupId: row.group_id,
            subjectId: row.subject_id,
            subgroup: subgroup?.name ?? (row.subgroup || null),
            ...(subgroup ? { subgroupId: subgroup.id } : {}),
            planned: row.planned,
            target: row.target,
            initialCount: row.initial_count,
        };
    });
}
async function migrateQuarterArchive(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=21").get())
        return;
    await db.transaction(async () => {
        const columns = await db.pragma("table_info(quarters)") as Array<{
            name: string;
        }>;
        if (!columns.some((column) => column.name === "archived"))
            await db.exec("ALTER TABLE quarters ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))");
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(21,CURRENT_TIMESTAMP)").run();
    })();
}
async function migrateEventRemainders(db: AsyncDatabase): Promise<void> {
    if (await db.prepare("SELECT 1 FROM schema_migrations WHERE version=22").get())
        return;
    await db.transaction(async () => {
        if (!await hasColumn(db, "lessons", "event_remainder_json"))
            await db.exec("ALTER TABLE lessons ADD COLUMN event_remainder_json TEXT");
        await db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(22,CURRENT_TIMESTAMP)").run();
    })();
}
function parseEventRemainder(value: string | null, isEvent: boolean): EventRemainder | undefined {
    if (!isEvent || !value)
        return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return isEventRemainder(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
async function readQuarters(db: AsyncDatabase): Promise<Quarter[]> {
    return (await db
        .prepare("SELECT id,name,start_date AS startDate,end_date AS endDate,archived FROM quarters ORDER BY start_date,id")
        .all()).map((raw) => { const row = raw as Quarter; return row.archived ? { ...row, archived: true } : (({ archived: _archived, ...quarter }) => quarter)(row); });
}
async function readStudyPlans(db: AsyncDatabase, groupId?: string, quarterId?: string): Promise<StudyPlan[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (groupId) {
        where.push("group_id=?");
        args.push(groupId);
    }
    if (quarterId) {
        where.push("quarter_id=?");
        args.push(quarterId);
    }
    const plans = await db
        .prepare(`SELECT id,quarter_id AS quarterId,group_id AS groupId,subject_id AS subjectId,mode,lesson_kind AS lessonKind FROM study_plans ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY quarter_id,group_id,subject_id,lesson_kind`)
        .all(...args) as Array<Omit<StudyPlan, "assignments">>;
    if (plans.length === 0)
        return [];
    const planIds = plans.map((plan) => plan.id);
    const assignments = await db
        .prepare(`SELECT id,plan_id,subgroup_id AS subgroupId,target FROM plan_assignments WHERE plan_id IN (${planIds.map(() => "?").join(",")}) ORDER BY rowid`)
        .all(...planIds) as Array<PlanAssignment & {
        plan_id: string;
    }>;
    const assignmentsByPlanId = new Map<string, PlanAssignment[]>();
    for (const { plan_id: planId, ...assignment } of assignments) {
        const rows = assignmentsByPlanId.get(planId) ?? [];
        rows.push(assignment);
        assignmentsByPlanId.set(planId, rows);
    }
    return plans.map((plan) => ({
        ...plan,
        assignments: assignmentsByPlanId.get(plan.id) ?? [],
    }));
}
async function readEditorQuarterCounts(db: AsyncDatabase, groupId: string, quarter: Quarter) {
    return await db.prepare(`
    SELECT p.subject_id AS subjectId,pa.subgroup_id AS subgroupId,p.lesson_kind AS lessonKind,
      COUNT(DISTINCT l.id) AS count
    FROM study_plans p
    JOIN plan_assignments pa ON pa.plan_id=p.id
    LEFT JOIN schedule_days d ON d.group_id=p.group_id AND d.date BETWEEN ? AND ?
    LEFT JOIN schedule_slots s ON s.day_id=d.id
    LEFT JOIN lessons l ON l.slot_id=s.id AND l.subject_id=p.subject_id
      AND COALESCE(l.lesson_kind,'regular')=p.lesson_kind
      AND (l.subgroup_ref=pa.subgroup_id OR
        (l.subgroup_ref IS NULL AND (l.subgroup IS NULL OR l.subgroup='') AND pa.subgroup_id IS NULL) OR
        (l.subgroup_ref IS NULL AND (l.subgroup IS NULL OR l.subgroup='') AND pa.subgroup_id IS NOT NULL))
    WHERE p.group_id=? AND p.quarter_id=?
    GROUP BY p.id,pa.id
    ORDER BY p.subject_id,pa.subgroup_id,p.lesson_kind
  `).all(quarter.startDate, quarter.endDate, groupId, quarter.id) as Array<{
        subjectId: string;
        subgroupId: string | null;
        lessonKind: "regular" | "lab";
        count: number;
    }>;
}
async function readDisplaySettings(db: AsyncDatabase) {
    const row = await db.prepare("SELECT settings_json,revision FROM school_display_settings WHERE id=1")
        .get() as {
        settings_json: string;
        revision: number;
    } | undefined;
    if (!row)
        return { settings: defaultDisplaySettings(), revision: 0 };
    let settings = defaultDisplaySettings();
    try {
        const parsed: unknown = JSON.parse(row.settings_json);
        if (isRecord(parsed)) {
            settings = {
                adminSubjectIcons: typeof parsed.adminSubjectIcons === "boolean"
                    ? parsed.adminSubjectIcons : settings.adminSubjectIcons,
                studentSubjectIcons: typeof parsed.studentSubjectIcons === "boolean"
                    ? parsed.studentSubjectIcons : settings.studentSubjectIcons,
                schoolName: typeof parsed.schoolName === "string" && parsed.schoolName.trim().length <= 200
                    ? parsed.schoolName.trim() : "",
            };
        }
    }
    catch { /* Ignore malformed optional display preferences. */ }
    const revision = Number.isInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
    return { settings, revision };
}
async function fullState(db: AsyncDatabase): Promise<StateResponse> {
    return await db.readTransaction(async () => {
        const meta = await db
            .prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
            updated_at: string;
        };
        const catalog = await readCatalog(db);
        return {
            schedule: await readSchedule(db, catalog),
            revision: meta.revision,
            updatedAt: meta.updated_at,
            baseline: await readBaseline(db, catalog),
            catalog,
            catalogDeletionBlockers: await catalogDeletionBlockers(db, catalog),
            quarters: await readQuarters(db),
            studyPlans: await readStudyPlans(db),
            curricula: await readCurricula(db),
            calendar: await readSchoolCalendar(db, catalog),
            bellSettings: await readBellSettings(db, catalog),
            displaySettings: await readDisplaySettings(db),
            temporaryTeacherReplacements: await readTemporaryTeacherReplacements(db),
            teacherLessonOrigins: await readTeacherLessonOrigins(db),
            teachingAssignments: await readTeacherTeachingAssignments(db),
        };
    });
}
type AdminStateOptions = {
    view: "bootstrap" | "catalog" | "plans" | "calendar" | "bells" | "print" | "operation";
    dates?: string[];
    groupIds?: string[];
    quarterId?: string;
    includePlans?: boolean;
};
async function adminState(db: AsyncDatabase, options: AdminStateOptions): Promise<StateResponse> {
    return await db.readTransaction(async () => {
        const catalog = await readCatalog(db);
        const quarters = await readQuarters(db);
        const quarter = options.quarterId ? quarters.find((entry) => entry.id === options.quarterId) : undefined;
        const dates = options.dates ?? (options.view === "operation" && quarter
            ? [...new Set(quarterWeeks(quarter).flatMap(weekDates))] : undefined);
        const schedule = dates ? await readSchedule(db, catalog, dates, options.groupIds) : {};
        const meta = await db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get() as {
            revision: number;
            updated_at: string;
        };
        const plans = options.view === "plans" || options.includePlans;
        const lessonIds = dates ? locatedLessons(schedule).map((entry) => entry.lesson.id) : [];
        return {
            schedule, catalog, quarters, revision: meta.revision, updatedAt: meta.updated_at,
            baseline: [], studyPlans: plans ? await readStudyPlans(db, undefined, options.quarterId) : [],
            ...(options.view === "plans" ? {
                curricula: (await readCurricula(db)).filter((entry) => !options.quarterId || entry.quarterId === options.quarterId),
                curriculumTemplates: curriculumTemplates(await readCurricula(db)),
                ...(options.quarterId ? { plansScope: { quarterId: options.quarterId } } : {}),
            } : {}),
            calendar: await readSchoolCalendar(db, catalog), bellSettings: await readBellSettings(db, catalog), displaySettings: await readDisplaySettings(db),
            ...(options.view === "operation" ? {
                temporaryTeacherReplacements: await readTemporaryTeacherReplacements(db),
                teachingAssignments: await readTeacherTeachingAssignments(db),
                teacherLessonOrigins: await readTeacherLessonOrigins(db, lessonIds),
            } : {}),
        };
    });
}
/** Preserve untouched day/slot/lesson rows for server-side operations. */
async function persistScheduleDelta(db: AsyncDatabase, before: Schedule, after: Schedule): Promise<void> {
    const changes: EditorDayChange[] = [];
    for (const [key, days] of Object.entries(after)) {
        const oldDays = before[key];
        if (!oldDays)
            throw new Error("Не найдена исходная неделя");
        days.forEach((day, dayIndex) => {
            const previous = oldDays.find((entry) => entry.date === day.date);
            if (!previous)
                throw new Error("Не найден исходный день");
            if (stableJson(previous) !== stableJson(day))
                changes.push({ key, dayIndex, before: previous, after: day });
        });
    }
    if (changes.length)
        await replaceEditorDays(db, after, changes);
}
type ReassignmentTeacherSnapshot = {
    format: "teacher-reassignment-v2";
    dates: string[];
    teachers: Array<{
        id: string;
        teacher: string | null;
        teacher_ref: string | null;
    }>;
};
/** Only teacher columns change; retain original labels and physical slot IDs. */
async function reassignmentTeacherSnapshot(db: AsyncDatabase, schedule: Schedule, ids: Set<string>): Promise<ReassignmentTeacherSnapshot> {
    const teachers: ReassignmentTeacherSnapshot["teachers"] = [];
    const selected = [...ids];
    for (let offset = 0; offset < selected.length; offset += 500) {
        const chunk = selected.slice(offset, offset + 500);
        teachers.push(...await db.prepare(`SELECT id,teacher,teacher_ref FROM lessons WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as ReassignmentTeacherSnapshot["teachers"]);
    }
    if (teachers.length !== ids.size)
        throw new Error("Не найдены переназначаемые уроки");
    const dates = [...new Set(locatedLessons(schedule).filter(item => ids.has(item.lesson.id)).map(item => item.date))].sort();
    return { format: "teacher-reassignment-v2", dates, teachers };
}
async function persistReassignmentTeachers(db: AsyncDatabase, schedule: Schedule, ids: Set<string>, catalog: Catalog): Promise<void> {
    const teachers = new Map(catalog.teachers.map(teacher => [teacher.id, teacher]));
    const update = db.prepare("UPDATE lessons SET teacher=?,teacher_ref=? WHERE id=?");
    for (const { lesson } of locatedLessons(schedule)) {
        if (!ids.has(lesson.id))
            continue;
        const teacher = teachers.get(lesson.teacherId ?? "");
        await update.run(teacher?.name ?? lesson.teacher ?? null, lesson.teacherId ?? null, lesson.id);
    }
}
function restoreReassignmentTeachers(schedule: Schedule, snapshot: ReassignmentTeacherSnapshot): Schedule {
    const byId = new Map(snapshot.teachers.map(teacher => [teacher.id, teacher]));
    return Object.fromEntries(Object.entries(schedule).map(([key, days]) => [key, days.map(day => ({ ...day,
            slots: day.slots.map(slot => slot.map(lesson => {
                const saved = byId.get(lesson.id);
                return saved ? { ...lesson, teacher: saved.teacher ?? undefined, teacherId: saved.teacher_ref ?? undefined } : lesson;
            })),
        }))]));
}
async function commitScopedSchedule(db: AsyncDatabase, before: Schedule, next: Schedule, revision: number, requestId: string) {
    return await db.transaction(async () => {
        const fingerprint = hash(stableJson({ revision, before, next }));
        const replay = await db.prepare("SELECT fingerprint,response_json FROM editor_request_replays WHERE request_id=?").get(requestId) as {
            fingerprint: string;
            response_json: string;
        } | undefined;
        if (replay) {
            if (replay.fingerprint !== fingerprint)
                throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
            return JSON.parse(replay.response_json) as {
                revision: number;
                updatedAt: string;
            };
        }
        const catalog = await readCatalog(db);
        const quarters = await readQuarters(db);
        const dates = new Set(Object.values(before).flatMap((days) => days.map((day) => day.date)));
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== revision)
            throw Object.assign(new Error("Расписание изменилось. Обновите данные"), { statusCode: 409 });
        // Every command validates against authoritative resource occupancy, even if
        // its caller only needed a subset of groups for the operation's calculations.
        const beforeContext = await readSchedule(db, catalog, [...dates]);
        const nextContext = structuredClone(beforeContext);
        for (const [key, days] of Object.entries(next))
            for (const day of days) {
                const index = nextContext[key]?.findIndex((entry) => entry.date === day.date) ?? -1;
                if (index < 0 || !before[key]?.some((entry) => entry.date === day.date))
                    throw Object.assign(new Error("Не найден исходный день расписания"), { statusCode: 400 });
                nextContext[key]![index] = day;
            }
        const plans = (await Promise.all(quarters.filter((quarter) => [...dates].some((date) => inQuarter(date, quarter))).map(async (quarter) => await readStudyPlans(db, undefined, quarter.id)))).flat();
        if (!validateSchedule(nextContext, beforeContext, catalog, quarters, plans))
            throw Object.assign(new Error("Изменения содержат недопустимые данные"), { statusCode: 400 });
        const existingIds = new Set(locatedLessons(beforeContext).map((entry) => entry.lesson.id));
        const newIds = locatedLessons(nextContext).map((entry) => entry.lesson.id).filter((id) => !existingIds.has(id));
        for (let index = 0; index < newIds.length; index += 500) {
            const ids = newIds.slice(index, index + 500);
            if (await db.prepare(`SELECT id FROM lessons WHERE id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).get(...ids))
                throw Object.assign(new Error("Идентификатор урока уже используется"), { statusCode: 400 });
        }
        const resolved = roomResolvedSchedule(nextContext, beforeContext, catalog);
        const old = roomResolvedSchedule(beforeContext, beforeContext, catalog);
        if (!resolved || !old)
            throw Object.assign(new Error("Не удалось проверить кабинеты"), { statusCode: 400 });
        const unavailability = newUnavailabilityViolation(resolved, old, catalog);
        if (unavailability)
            throw Object.assign(new Error(unavailabilityViolationMessage(unavailability, catalog)), { statusCode: 400 });
        const room = newRoomConflict(resolved, old);
        if (room)
            throw Object.assign(new Error(roomConflictMessage(room, catalog)), { statusCode: 400 });
        const suitability = newRoomSuitabilityViolation(resolved, old, catalog);
        if (suitability)
            throw Object.assign(new Error(roomSuitabilityViolationMessage(suitability, catalog)), { statusCode: 400 });
        const teacher = newTeacherConflict(resolved, old);
        if (teacher)
            throw Object.assign(new Error(teacherConflictMessage(teacher, catalog)), { statusCode: 400 });
        await persistScheduleDelta(db, beforeContext, resolved);
        const response = { revision: revision + 1, updatedAt: nowIso() };
        await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(response.revision, response.updatedAt);
        await db.prepare("INSERT INTO editor_request_replays(request_id,fingerprint,response_json) VALUES(?,?,?)").run(requestId, fingerprint, JSON.stringify(response));
        return response;
    })();
}
async function calendarAffectedDates(db: AsyncDatabase, calendar: SchoolCalendar): Promise<string[]> {
    const rows = await db.prepare(`SELECT d.group_id,d.date,d.holiday,
      EXISTS(SELECT 1 FROM schedule_slots s JOIN lessons l ON l.slot_id=s.id WHERE s.day_id=d.id) AS has_lessons
    FROM schedule_days d`).all() as Array<{
        group_id: string;
        date: string;
        holiday: number;
        has_lessons: number;
    }>;
    return [...new Set(rows.filter((row) => {
            const status = calendarDay(calendar, row.group_id, row.date);
            return status.holiday !== Boolean(row.holiday) || status.holiday && Boolean(row.has_lessons);
        }).map((row) => row.date))];
}
async function bellAffectedDates(db: AsyncDatabase, options: BellApplyOptions): Promise<string[]> {
    return (await db.prepare(`SELECT DISTINCT date FROM schedule_days WHERE date BETWEEN ? AND ?
    AND group_id IN (${options.groupIds.map(() => "?").join(",")}) ORDER BY date`)
        .all(options.startDate, options.endDate, ...options.groupIds) as Array<{
        date: string;
    }>).map((row) => row.date);
}
async function publicationState(db: AsyncDatabase, quarterId: string): Promise<StateResponse> {
    return await db.readTransaction(async () => {
        return { ...await adminState(db, { view: "operation", quarterId, includePlans: true }),
            baseline: await readBaseline(db), curricula: (await readCurricula(db)).filter((entry) => entry.quarterId === quarterId),
        };
    });
}
function stableJson(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (isRecord(value))
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}
async function editorWeekState(db: AsyncDatabase, groupId: string, quarter: Quarter, weekOffset: number, dates = weekDates(weekOffset), requestCatalog?: Catalog) {
    return await db.readTransaction(async () => {
        const catalog = requestCatalog ?? await readCatalog(db);
        const schedule = await readSchedule(db, catalog, dates, [groupId]);
        // Joint edits must retain their peer days, while unrelated school weeks
        // remain on the server for independent preview/save validation.
        const jointIds = [...new Set(locatedLessons(schedule).flatMap(item => item.lesson.jointId ? [item.lesson.jointId] : []))];
        if (jointIds.length) {
            const peers = await db.prepare(`SELECT DISTINCT d.group_id FROM lessons l
                JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id
                WHERE l.joint_id IN (${jointIds.map(() => "?").join(",")})
                AND d.date IN (${dates.map(() => "?").join(",")}) AND d.group_id<>?`)
                .all(...jointIds, ...dates, groupId) as Array<{ group_id: string }>;
            const groupIds = [...new Set(peers.map(row => row.group_id))];
            if (groupIds.length) Object.assign(schedule, await readSchedule(db, catalog, dates, groupIds));
        }
        const meta = await db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get() as {
            revision: number;
            updated_at: string;
        };
        const counts = (await readEditorQuarterCounts(db, groupId, quarter)).map((row) => ({ ...row, count: Number(row.count) }));
        const weeks = (await db.prepare(`SELECT d.week_offset AS weekOffset, MIN(d.holiday) AS holiday,
      MAX(CASE WHEN l.event IS NOT NULL AND l.event<>'' THEN 1 ELSE 0 END) AS event
    FROM schedule_days d LEFT JOIN schedule_slots s ON s.day_id=d.id LEFT JOIN lessons l ON l.slot_id=s.id
    WHERE d.group_id=? AND d.week_offset BETWEEN ? AND ? GROUP BY d.week_offset ORDER BY d.week_offset`)
            .all(groupId, weekOffsetFor(quarter.startDate), weekOffsetFor(quarter.endDate)) as Array<{
            weekOffset: number;
            holiday: number;
            event: number;
        }>)
            .map((row) => ({ weekOffset: row.weekOffset, holiday: Boolean(row.holiday), event: Boolean(row.event) }));
        return {
            schedule, revision: meta.revision, updatedAt: meta.updated_at,
            baseline: (await readBaseline(db, catalog, groupId)).filter((row) => row.groupId === groupId),
            catalog, quarters: await readQuarters(db), studyPlans: await readStudyPlans(db, groupId, quarter.id),
            calendar: await readSchoolCalendar(db, catalog), bellSettings: await readBellSettings(db, catalog), displaySettings: await readDisplaySettings(db),
            editorScope: { groupId, quarterId: quarter.id, weekOffset, dates, counts, weeks },
        } satisfies StateResponse;
    });
}
async function readReplacementStudyPlans(db: AsyncDatabase, groupIds: string[], quarters: Quarter[], dates: string[]): Promise<StudyPlan[]> {
    const quarterIds = quarters.filter((quarter) => dates.some((date) => inQuarter(date, quarter))).map((quarter) => quarter.id);
    if (!groupIds.length || !quarterIds.length)
        return [];
    const scope = `p.group_id IN (${groupIds.map(() => "?").join(",")}) AND p.quarter_id IN (${quarterIds.map(() => "?").join(",")})`;
    const args = [...groupIds, ...quarterIds];
    const plans = await db.prepare(`SELECT p.id,p.quarter_id AS quarterId,p.group_id AS groupId,p.subject_id AS subjectId,p.mode,p.lesson_kind AS lessonKind
      FROM study_plans p WHERE ${scope} ORDER BY p.quarter_id,p.group_id,p.subject_id,p.lesson_kind`).all(...args) as Array<Omit<StudyPlan, "assignments">>;
    const assignments = await db.prepare(`SELECT a.id,a.plan_id,a.subgroup_id AS subgroupId,a.target FROM plan_assignments a
      JOIN study_plans p ON p.id=a.plan_id WHERE ${scope} ORDER BY a.rowid`).all(...args) as Array<PlanAssignment & { plan_id: string }>;
    const byPlan = new Map<string, PlanAssignment[]>();
    for (const { plan_id, ...assignment } of assignments) {
        const rows = byPlan.get(plan_id) ?? [];
        rows.push(assignment);
        byPlan.set(plan_id, rows);
    }
    return plans.map((plan) => ({ ...plan, assignments: byPlan.get(plan.id) ?? [] }));
}
async function scheduleDatesInRange(db: AsyncDatabase, startDate: string, endDate: string): Promise<string[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate)
        return [];
    return (await db.prepare("SELECT DISTINCT date FROM schedule_days WHERE date BETWEEN ? AND ? ORDER BY date").all(startDate, endDate) as Array<{
        date: string;
    }>).map(row => row.date);
}
function scheduleDates(schedule: Schedule): string[] {
    return [...new Set(Object.values(schedule).flatMap(days => days.map(day => day.date)))].sort();
}
async function reassignmentDates(db: AsyncDatabase, request: TeacherReassignmentRequest): Promise<string[]> {
    if (request.mode === "return") {
        const dates = (await readTeacherLessonOrigins(db)).filter(origin => origin.status !== "returned" && origin.sourceTeacherId === request.sourceTeacherId && origin.date >= request.returnDate && (!request.ruleId || origin.absenceRuleId === request.ruleId)).map(origin => origin.date);
        return [...new Set(dates)].sort();
    }
    if (request.scope === "lesson") {
        const ids = [...new Set([...(Array.isArray(request.lessonIds) ? request.lessonIds : []), ...(request.lessonId ? [request.lessonId] : [])])].filter(id => typeof id === "string" && id.length <= 200);
        const dates = new Set<string>();
        for (let offset = 0; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const rows = await db.prepare(`SELECT DISTINCT d.date FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{
                date: string;
            }>;
            rows.forEach(row => dates.add(row.date));
        }
        return [...dates].sort();
    }
    if (request.scope === "week" && request.weekStart) {
        const end = new Date(`${request.weekStart}T12:00:00Z`);
        if (!Number.isFinite(end.getTime()))
            return [];
        end.setUTCDate(end.getUTCDate() + 6);
        return await scheduleDatesInRange(db, request.weekStart, end.toISOString().slice(0, 10));
    }
    if (request.scope === "period") {
        const quarter = (await readQuarters(db)).find(item => item.id === request.quarterId);
        const startDate = request.startDate ?? quarter?.startDate;
        const endDate = request.endDate === undefined ? quarter?.endDate : request.endDate;
        if (!startDate)
            return [];
        if (endDate !== null)
            return await scheduleDatesInRange(db, startDate, endDate ?? startDate);
        // A permanent transfer continues the selected stream after the current
        // quarter. Find its future lesson dates first, then load every group on
        // those dates so room/teacher conflicts and joint mirrors remain visible.
        const anchorIds = [...new Set([...(request.lessonIds ?? []), ...(request.lessonId ? [request.lessonId] : [])])].filter(id => typeof id === "string" && id.length <= 200);
        const anchorRows = anchorIds.length
            ? await db.prepare(`SELECT d.group_id AS groupId,d.date,l.teacher_ref AS teacherId FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id IN (${anchorIds.map(() => "?").join(",")})`).all(...anchorIds) as Array<{
                groupId: string;
                date: string;
                teacherId: string | null;
            }>
            : [];
        if (!anchorIds.length && !request.sourceTeacherId && quarter) {
            // The group/subject scope also has an implicit anchor: its selected
            // lessons in the current quarter. Their streams can continue later.
            const groups = Array.isArray(request.groupIds) ? request.groupIds : [];
            const groupClause = groups.length ? `AND d.group_id IN (${groups.map(() => "?").join(",")})` : "";
            anchorRows.push(...await db.prepare(`SELECT DISTINCT d.group_id AS groupId,d.date,l.teacher_ref AS teacherId FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE d.date BETWEEN ? AND ? AND l.subject_id=? ${groupClause}`)
                .all(startDate, quarter.endDate, request.subjectId, ...groups) as Array<{
                groupId: string;
                date: string;
                teacherId: string | null;
            }>);
        }
        const groupIds = [...new Set([...(request.groupIds ?? []), ...anchorRows.map(row => row.groupId)])];
        const teacherIds = [...new Set([...(request.sourceTeacherId ? [request.sourceTeacherId] : []), ...anchorRows.flatMap(row => row.teacherId ? [row.teacherId] : [])])];
        const origins = (await readTeacherLessonOrigins(db)).filter(origin => teacherIds.includes(origin.sourceTeacherId) && origin.date >= startDate);
        const originLessonIds = [...new Set(origins.map(origin => origin.lessonId))];
        const conditions: string[] = [];
        if (teacherIds.length) {
            conditions.push(`l.teacher_ref IN (${teacherIds.map(() => "?").join(",")})`);
        }
        if (originLessonIds.length) {
            conditions.push(`l.id IN (${originLessonIds.map(() => "?").join(",")})`);
        }
        const selectedGroups = groupIds.length ? `AND d.group_id IN (${groupIds.map(() => "?").join(",")})` : "";
        const queryArgs = [startDate, ...groupIds, request.subjectId, ...teacherIds, ...originLessonIds];
        const futureDates = conditions.length
            ? await db.prepare(`SELECT DISTINCT d.date FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id JOIN lessons l ON l.slot_id=s.id WHERE d.date>=? ${selectedGroups} AND l.subject_id=? AND (${conditions.join(" OR ")}) ORDER BY d.date`).all(...queryArgs) as Array<{
                date: string;
            }>
            : [];
        return [...new Set([...anchorRows.map(row => row.date), ...futureDates.map(row => row.date)])].sort();
    }
    return [];
}
async function readReassignmentState(db: AsyncDatabase, request?: TeacherReassignmentRequest) {
    return await db.readTransaction(async () => {
        const catalog = await readCatalog(db);
        const dates = request ? await reassignmentDates(db, request) : undefined;
        const schedule = await readSchedule(db, catalog, dates);
        const lessonIds = locatedLessons(schedule).map(item => item.lesson.id);
        const origins = await readTeacherLessonOrigins(db, lessonIds);
        return { schedule, catalog, quarters: await readQuarters(db), teachingAssignments: await readTeacherTeachingAssignments(db), teacherLessonOrigins: origins };
    });
}
function replaceSelectedLessons(original: Schedule, proposed: Schedule, ids: Set<string>): Schedule {
    const proposedById = new Map(locatedLessons(proposed).map((item) => [item.lesson.id, item.lesson]));
    return Object.fromEntries(Object.entries(original).map(([key, days]) => [key, days.map((day) => ({
            ...day,
            slots: day.slots.map((slot) => slot.map((lesson) => ids.has(lesson.id) ? proposedById.get(lesson.id) ?? lesson : lesson)),
        }))]));
}
function mergeSelectedOrigins(current: TeacherLessonOrigin[], proposed: TeacherLessonOrigin[], lessonIds: Set<string>): TeacherLessonOrigin[] {
    const selected = new Map(proposed.filter((origin) => lessonIds.has(origin.lessonId)).map((origin) => [origin.lessonId, origin]));
    const retained = current.filter((origin) => !lessonIds.has(origin.lessonId));
    return [...retained, ...selected.values()];
}
function mergeSelectedAssignments(current: TeacherTeachingAssignment[], proposed: TeacherTeachingAssignment[], selectedUnitIds: Set<string>, units: Array<{
    id: string;
    lessonIds: string[];
    groupIds: string[];
    subjectId: string;
    date: string;
    sourceTeacherId?: string;
    teacherId?: string;
    subgroupIds?: string[];
    subgroups?: string[];
    reason?: string;
}>, origins: TeacherLessonOrigin[]): TeacherTeachingAssignment[] {
    const readyUnits = units.filter((unit) => unit.teacherId && !unit.reason);
    const selected = proposed.filter((assignment) => {
        const matching = readyUnits.filter((unit) => {
            const lineageTeacherIds = new Set([unit.sourceTeacherId, ...origins.filter((origin) => unit.lessonIds.includes(origin.lessonId) && origin.status === "active").map((origin) => origin.sourceTeacherId)]);
            return unit.groupIds.includes(assignment.groupId) && unit.subjectId === assignment.subjectId && lineageTeacherIds.has(assignment.sourceTeacherId) && assignment.targetTeacherId === unit.teacherId && assignment.startDate <= unit.date && (assignment.endDate === null || assignment.endDate >= unit.date) && (assignment.subgroupId ? unit.subgroupIds?.includes(assignment.subgroupId) : assignment.subgroup ? unit.subgroups?.includes(assignment.subgroup) : !unit.subgroupIds?.length && !unit.subgroups?.length);
        });
        return matching.length > 0 && matching.every((unit) => selectedUnitIds.has(unit.id));
    });
    const byId = new Map(current.map((assignment) => [assignment.id, assignment]));
    selected.forEach((assignment) => byId.set(assignment.id, assignment));
    return [...byId.values()];
}
async function writeCatalogTeacherAvailability(db: AsyncDatabase, catalog: Catalog): Promise<void> {
    const rows = await db.prepare("SELECT id,unavailability_json FROM catalog_teachers").all() as Array<{ id: string; unavailability_json: string }>;
    const previous = new Map(rows.map((row) => [row.id, parseRuleArray(row.unavailability_json)]));
    const update = db.prepare("UPDATE catalog_teachers SET unavailability_json=? WHERE id=?");
    for (const teacher of catalog.teachers) {
        const rules = teacher.unavailability ?? [];
        if (stableJson(previous.get(teacher.id)) !== stableJson(rules))
            await update.run(JSON.stringify(rules), teacher.id);
    }
}
function trimTemporaryReplacementPolicies(policies: TemporaryTeacherReplacement[], request: Extract<TeacherReassignmentRequest, {
    mode: "return";
}>): TemporaryTeacherReplacement[] {
    const today = new Date();
    const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const effectiveDate = request.returnDate > todayText ? request.returnDate : todayText;
    const lastActiveDate = new Date(`${effectiveDate}T00:00:00`);
    lastActiveDate.setDate(lastActiveDate.getDate() - 1);
    const endDate = `${lastActiveDate.getFullYear()}-${String(lastActiveDate.getMonth() + 1).padStart(2, "0")}-${String(lastActiveDate.getDate()).padStart(2, "0")}`;
    return policies.flatMap((policy) => {
        if (policy.sourceTeacherId !== request.sourceTeacherId || (request.ruleId && policy.unavailabilityRuleId !== request.ruleId))
            return [policy];
        if (request.subjectId && policy.subjectId !== request.subjectId)
            return [policy];
        if (request.groupIds?.length && !request.groupIds.includes(policy.groupId))
            return [policy];
        if (effectiveDate > policy.endDate)
            return [policy];
        if (endDate < policy.startDate)
            return [];
        return [{ ...policy, endDate: endDate < policy.endDate ? endDate : policy.endDate }];
    });
}
async function readTeacherLessonOrigins(db: AsyncDatabase, lessonIds?: string[]): Promise<TeacherLessonOrigin[]> {
    if (lessonIds?.length === 0)
        return [];
    if (lessonIds && lessonIds.length > 500) {
        const result: TeacherLessonOrigin[] = [];
        const ids = [...new Set(lessonIds)];
        for (let index = 0; index < ids.length; index += 500)
            result.push(...await readTeacherLessonOrigins(db, ids.slice(index, index + 500)));
        return result;
    }
    return (await db.prepare(`SELECT origin_json FROM teacher_lesson_origins ${lessonIds ? `WHERE lesson_id IN (${lessonIds.map(() => "?").join(",")})` : ""} ORDER BY rowid`)
        .all(...(lessonIds ?? [])) as Array<{
        origin_json: string;
    }>).flatMap(({ origin_json }) => {
        try {
            const parsed: unknown = JSON.parse(origin_json);
            return parsed && typeof parsed === "object" ? [parsed as TeacherLessonOrigin] : [];
        }
        catch {
            return [];
        }
    });
}
async function writeTeacherLessonOrigins(db: AsyncDatabase, origins: TeacherLessonOrigin[]): Promise<void> {
    await db.prepare("DELETE FROM teacher_lesson_origins").run();
    const insert = db.prepare("INSERT INTO teacher_lesson_origins(id,lesson_id,origin_json) VALUES(?,?,?)");
    for (const origin of origins) {
        await insert.run(origin.id, origin.lessonId, JSON.stringify(origin));
    }
}
async function readTeacherTeachingAssignments(db: AsyncDatabase): Promise<TeacherTeachingAssignment[]> {
    return (await db.prepare("SELECT assignment_json FROM teacher_teaching_assignments ORDER BY rowid").all() as Array<{
        assignment_json: string;
    }>).flatMap(({ assignment_json }) => {
        try {
            const parsed: unknown = JSON.parse(assignment_json);
            return parsed && typeof parsed === "object" ? [parsed as TeacherTeachingAssignment] : [];
        }
        catch {
            return [];
        }
    });
}
type CatalogDeletionBlockers = Partial<Record<import("../shared/catalog.ts").CatalogKind, Record<string, string[]>>>;
async function catalogDeletionBlockers(db: AsyncDatabase, catalog: Catalog | undefined = undefined): Promise<CatalogDeletionBlockers> {
    catalog ??= await readCatalog(db);
    const kinds = ["subjects", "teachers", "rooms", "groups", "subgroups"] as const;
    const refs: Record<typeof kinds[number], Map<string, Set<string>>> = {
        subjects: new Map(), teachers: new Map(), rooms: new Map(), groups: new Map(), subgroups: new Map(),
    };
    const add = (kind: typeof kinds[number], id: unknown, source: string) => {
        if (typeof id !== "string" || !id)
            return;
        const list = refs[kind].get(id) ?? new Set<string>();
        list.add(source);
        refs[kind].set(id, list);
    };
    const markUnverifiableHistory = (source: string) => {
        for (const kind of kinds)
            for (const entry of catalog[kind])
                add(kind, entry.id, `${source}: не удалось проверить сохранённые данные`);
    };
    const addSubgroupByName = (groupId: unknown, name: unknown, source: string) => {
        if (typeof groupId !== "string" || typeof name !== "string")
            return;
        const normalizedName = name.trim().toLocaleLowerCase("ru");
        for (const subgroup of catalog.subgroups)
            if (subgroup.groupId === groupId && subgroup.name.trim().toLocaleLowerCase("ru") === normalizedName)
                add("subgroups", subgroup.id, source);
    };
    const scanState = (state: any, source: string) => {
        if (!state || typeof state !== "object")
            return;
        const oldCatalog = state.catalog;
        const addByName = (kind: "teachers" | "rooms", id: unknown, name: unknown) => {
            if (typeof id === "string" && id) {
                add(kind, id, source);
                return;
            }
            if (typeof name !== "string" || !name.trim())
                return;
            const normalized = name.trim().toLocaleLowerCase("ru");
            const oldEntries = oldCatalog?.[kind];
            const entries = Array.isArray(oldEntries) ? oldEntries : catalog[kind];
            for (const entry of entries)
                if (typeof entry?.name === "string" && entry.name.trim().toLocaleLowerCase("ru") === normalized)
                    add(kind, entry.id, source);
        };
        const addHistoricalSubgroup = (groupId: unknown, subgroupId: unknown, name: unknown) => {
            if (typeof subgroupId === "string" && subgroupId) {
                add("subgroups", subgroupId, source);
                return;
            }
            if (typeof groupId !== "string" || typeof name !== "string")
                return;
            const entries = Array.isArray(oldCatalog?.subgroups) ? oldCatalog.subgroups : catalog.subgroups;
            const normalized = name.trim().toLocaleLowerCase("ru");
            for (const entry of entries)
                if (entry?.groupId === groupId && typeof entry.name === "string" && entry.name.trim().toLocaleLowerCase("ru") === normalized)
                    add("subgroups", entry.id, source);
        };
        const schedule = state.schedule;
        if (schedule?.format === "teacher-reassignment-v2") {
            if (!Array.isArray(schedule.teachers))
                throw new Error("Некорректный снимок преподавателей");
            for (const teacher of schedule.teachers)
                addByName("teachers", teacher?.teacher_ref, teacher?.teacher);
        }
        else if (schedule && typeof schedule === "object")
            for (const [key, days] of Object.entries(schedule)) {
                const groupId = key.slice(0, key.lastIndexOf(":"));
                if (!Array.isArray(days))
                    continue;
                for (const day of days)
                    for (const slot of day?.slots ?? [])
                        for (const lesson of slot ?? []) {
                            add("groups", groupId, source);
                            add("subjects", lesson?.subjectId, source);
                            addByName("teachers", lesson?.teacherId, lesson?.teacher);
                            addByName("rooms", lesson?.roomId, lesson?.room);
                            addHistoricalSubgroup(groupId, lesson?.subgroupId, lesson?.subgroup);
                            for (const id of lesson?.groupIds ?? [])
                                add("groups", id, source);
                        }
            }
        for (const row of state.baseline ?? []) {
            add("groups", row?.groupId, source);
            add("subjects", row?.subjectId, source);
            addHistoricalSubgroup(row?.groupId, row?.subgroupId, row?.subgroup);
        }
        for (const plan of state.studyPlans ?? []) {
            add("groups", plan?.groupId, source);
            add("subjects", plan?.subjectId, source);
            for (const assignment of plan?.assignments ?? []) {
                addByName("teachers", assignment?.teacherId, assignment?.teacher);
                addByName("rooms", assignment?.roomId, assignment?.room);
                addHistoricalSubgroup(plan?.groupId, assignment?.subgroupId, assignment?.subgroup);
            }
        }
        for (const curriculum of state.curricula ?? []) {
            for (const id of curriculum?.groupIds ?? [])
                add("groups", id, source);
            for (const row of curriculum?.rows ?? [])
                add("subjects", row?.subjectId, source);
        }
        const calendar = state.calendar;
        if (calendar) {
            for (const id of Object.keys(calendar.groupWeekdays ?? {}))
                add("groups", id, source);
            for (const period of calendar.periods ?? [])
                for (const id of period?.groupIds ?? [])
                    add("groups", id, source);
        }
        for (const origin of state.teacherLessonOrigins ?? []) {
            add("teachers", origin?.sourceTeacherId, source);
            add("teachers", origin?.substituteTeacherId, source);
            add("groups", origin?.groupId, source);
        }
        for (const assignment of state.teachingAssignments ?? []) {
            add("teachers", assignment?.sourceTeacherId, source);
            add("teachers", assignment?.targetTeacherId, source);
            add("groups", assignment?.groupId, source);
            add("subjects", assignment?.subjectId, source);
            addHistoricalSubgroup(assignment?.groupId, assignment?.subgroupId, assignment?.subgroup);
        }
        for (const policy of state.temporaryTeacherReplacements ?? []) {
            add("teachers", policy?.sourceTeacherId, source);
            for (const id of policy?.teacherIds ?? [])
                add("teachers", id, source);
            add("groups", policy?.groupId, source);
            add("subjects", policy?.subjectId, source);
            addHistoricalSubgroup(policy?.groupId, policy?.subgroupId, policy?.subgroup);
        }
        // Historical catalogue links count as references; mere presence of an entry does not.
        if (oldCatalog) {
            for (const teacher of oldCatalog.teachers ?? []) {
                for (const id of teacher.subjectIds ?? [])
                    add("subjects", id, source);
                add("rooms", teacher.defaultRoomId, source);
                for (const id of teacher.preferredGroupIds ?? [])
                    add("groups", id, source);
            }
            for (const subject of oldCatalog.subjects ?? [])
                for (const set of subject.jointGroupSets ?? [])
                    for (const id of set)
                        add("groups", id, source);
            for (const group of oldCatalog.groups ?? []) {
                add("teachers", group.leaderId, source);
                add("rooms", group.roomId, source);
                for (const id of group.autoRoomIds ?? [])
                    add("rooms", id, source);
            }
            for (const subgroup of oldCatalog.subgroups ?? [])
                add("groups", subgroup.groupId, source);
        }
    };
    // Current normalized relations include legacy text-only lesson assignments too.
    for (const row of await db.prepare(`SELECT l.subject_id,l.teacher_ref,l.room_ref,l.subgroup_ref,l.subgroup,l.teacher,l.room,d.group_id
    FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id`).all() as any[]) {
        add("subjects", row.subject_id, "занятия");
        add("teachers", row.teacher_ref, "занятия");
        add("rooms", row.room_ref, "занятия");
        add("subgroups", row.subgroup_ref, "занятия");
        add("groups", row.group_id, "занятия");
        addSubgroupByName(row.group_id, row.subgroup, "занятия");
        if (!row.teacher_ref && row.teacher)
            for (const entry of catalog.teachers)
                if (entry.name.trim().toLocaleLowerCase("ru") === row.teacher.trim().toLocaleLowerCase("ru"))
                    add("teachers", entry.id, "занятия");
        if (!row.room_ref && row.room)
            for (const entry of catalog.rooms)
                if (entry.name.trim().toLocaleLowerCase("ru") === row.room.trim().toLocaleLowerCase("ru"))
                    add("rooms", entry.id, "занятия");
    }
    for (const row of await db.prepare("SELECT group_id,subject_id,subgroup FROM plan_baselines").all() as any[]) {
        add("groups", row.group_id, "план четверти");
        add("subjects", row.subject_id, "план четверти");
        addSubgroupByName(row.group_id, row.subgroup, "план четверти");
    }
    const assignmentColumns = new Set((await db.pragma("table_info(plan_assignments)") as Array<{
        name: string;
    }>).map((column) => column.name));
    const planAssignmentQuery = `SELECT p.group_id,p.subject_id,${assignmentColumns.has("teacher_id") ? "a.teacher_id" : "NULL AS teacher_id"},${assignmentColumns.has("room_id") ? "a.room_id" : "NULL AS room_id"},a.subgroup_id FROM study_plans p LEFT JOIN plan_assignments a ON a.plan_id=p.id`;
    for (const row of await db.prepare(planAssignmentQuery).all() as any[]) {
        add("groups", row.group_id, "учебные планы");
        add("subjects", row.subject_id, "учебные планы");
        add("teachers", row.teacher_id, "учебные планы");
        add("rooms", row.room_id, "учебные планы");
        add("subgroups", row.subgroup_id, "учебные планы");
    }
    for (const teacher of catalog.teachers) {
        for (const id of teacher.subjectIds)
            add("subjects", id, "специальности преподавателей");
        add("rooms", teacher.defaultRoomId, "преподаватели");
    }
    for (const group of catalog.groups) {
        add("teachers", group.leaderId, "классные руководители");
        add("rooms", group.roomId, "группы");
        for (const id of group.autoRoomIds)
            add("rooms", id, "группы");
    }
    for (const subgroup of catalog.subgroups)
        add("groups", subgroup.groupId, "подгруппы");
    for (const teacher of catalog.teachers)
        for (const id of teacher.preferredGroupIds ?? [])
            add("groups", id, "предпочтительные группы преподавателей");
    for (const subject of catalog.subjects)
        for (const set of subject.jointGroupSets ?? [])
            for (const id of set)
                add("groups", id, "параллельные группы предметов");
    for (const curriculum of await readCurricula(db)) {
        for (const id of curriculum.groupIds)
            add("groups", id, "сводные учебные планы");
        for (const row of curriculum.rows)
            add("subjects", row.subjectId, "сводные учебные планы");
    }
    const calendar = await readSchoolCalendar(db);
    for (const id of Object.keys(calendar.groupWeekdays ?? {}))
        add("groups", id, "календарь школы");
    for (const period of calendar.periods)
        for (const id of period.groupIds ?? [])
            add("groups", id, "календарь школы");
    for (const origin of await readTeacherLessonOrigins(db)) {
        add("teachers", origin.sourceTeacherId, "история замен");
        add("teachers", origin.substituteTeacherId, "история замен");
        add("groups", origin.groupId, "история замен");
    }
    for (const assignment of await readTeacherTeachingAssignments(db)) {
        add("teachers", assignment.sourceTeacherId, "переназначения");
        add("teachers", assignment.targetTeacherId, "переназначения");
        add("groups", assignment.groupId, "переназначения");
        add("subjects", assignment.subjectId, "переназначения");
        add("subgroups", assignment.subgroupId, "переназначения");
        addSubgroupByName(assignment.groupId, assignment.subgroup, "переназначения");
    }
    for (const policy of await readTemporaryTeacherReplacements(db)) {
        add("teachers", policy.sourceTeacherId, "правила временных замен");
        for (const id of policy.teacherIds)
            add("teachers", id, "правила временных замен");
        add("groups", policy.groupId, "правила временных замен");
        add("subjects", policy.subjectId, "правила временных замен");
        add("subgroups", policy.subgroupId, "правила временных замен");
        addSubgroupByName(policy.groupId, policy.subgroup, "правила временных замен");
    }
    for (const [table, column, key] of [["teacher_lesson_origins", "origin_json", "teacherLessonOrigins"], ["teacher_teaching_assignments", "assignment_json", "teachingAssignments"], ["temporary_teacher_replacements", "policy_json", "temporaryTeacherReplacements"], ["curricula", "curriculum_json", "curricula"]] as const) {
        if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            continue;
        for (const row of await db.prepare(`SELECT ${column} AS value FROM ${table}`).all() as Array<{
            value: string;
        }>) {
            try {
                scanState({ [key]: [JSON.parse(row.value)] }, "сохранённые назначения");
            }
            catch {
                markUnverifiableHistory("сохранённые назначения");
            }
        }
    }
    for (const row of await db.prepare("SELECT calendar_json FROM school_calendar").all() as Array<{
        calendar_json: string;
    }>) {
        try {
            scanState({ calendar: JSON.parse(row.calendar_json) }, "календарь школы");
        }
        catch {
            markUnverifiableHistory("календарь школы");
        }
    }
    for (const row of await db.prepare("SELECT snapshot_json FROM published_quarters").all() as Array<{
        snapshot_json: string;
    }>) {
        try {
            scanState(JSON.parse(row.snapshot_json), "опубликованное расписание");
        }
        catch {
            markUnverifiableHistory("история публикаций");
        }
    }
    for (const [table, columns] of [["teacher_replacement_operations", ["previous_schedule_json", "apply_response_json", "undo_response_json", "previous_origins_json", "previous_assignments_json", "previous_policies_json"]], ["teacher_reassignment_operations", ["previous_schedule_json", "previous_catalog_json", "apply_response_json", "undo_response_json", "previous_origins_json", "previous_assignments_json", "previous_policies_json"]]] as const) {
        if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            continue;
        const available = new Set((await db.pragma(`table_info(${table})`) as Array<{
            name: string;
        }>).map((column) => column.name));
        for (const column of columns)
            if (available.has(column)) {
                for (const row of await db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{
                    value: string;
                }>) {
                    try {
                        const value = JSON.parse(row.value);
                        if (column === "previous_schedule_json")
                            scanState({ schedule: value }, "история операций");
                        else if (column === "previous_catalog_json")
                            scanState({ catalog: value }, "история операций");
                        else if (column === "apply_response_json")
                            scanState(value?.state ?? value, "история операций");
                        else if (column === "undo_response_json")
                            scanState(value?.state ?? value, "история операций");
                        else if (column === "previous_origins_json")
                            scanState({ teacherLessonOrigins: value }, "история операций");
                        else if (column === "previous_assignments_json")
                            scanState({ teachingAssignments: value }, "история операций");
                        else if (column === "previous_policies_json")
                            scanState({ temporaryTeacherReplacements: value }, "история операций");
                    }
                    catch {
                        markUnverifiableHistory("история операций");
                    }
                }
            }
    }
    const result = Object.fromEntries(kinds.map((kind) => [kind, Object.fromEntries(catalog[kind].map((entry) => [entry.id, [...(refs[kind].get(entry.id) ?? [])]]))])) as CatalogDeletionBlockers;
    const activeGroups = catalog.groups.filter((group) => !group.archived);
    if (activeGroups.length === 1)
        result.groups![activeGroups[0]!.id]!.push("последняя действующая группа");
    return result;
}
async function writeTeacherTeachingAssignments(db: AsyncDatabase, assignments: TeacherTeachingAssignment[]): Promise<void> {
    await db.prepare("DELETE FROM teacher_teaching_assignments").run();
    const insert = db.prepare("INSERT INTO teacher_teaching_assignments(id,assignment_json) VALUES(?,?)");
    for (const assignment of assignments) {
        await insert.run(assignment.id, JSON.stringify(assignment));
    }
}
async function readTemporaryTeacherReplacements(db: AsyncDatabase): Promise<TemporaryTeacherReplacement[]> {
    return (await db.prepare("SELECT policy_json FROM temporary_teacher_replacements ORDER BY rowid").all() as Array<{
        policy_json: string;
    }>)
        .flatMap(({ policy_json }) => {
        try {
            const parsed: unknown = JSON.parse(policy_json);
            return parsed && typeof parsed === "object" ? [parsed as TemporaryTeacherReplacement] : [];
        }
        catch {
            return [];
        }
    });
}
async function writeTemporaryTeacherReplacements(db: AsyncDatabase, policies: TemporaryTeacherReplacement[]): Promise<void> {
    await db.prepare("DELETE FROM temporary_teacher_replacements").run();
    const insert = db.prepare("INSERT INTO temporary_teacher_replacements(id,policy_json) VALUES(?,?)");
    for (const policy of policies) {
        await insert.run(policy.id, JSON.stringify(policy));
    }
}
async function readPublishedQuarter(db: AsyncDatabase, quarterId: string): Promise<PublishedQuarterResponse | null> {
    const row = await db.prepare("SELECT quarter_id,version,published_at,draft_revision,published_by,snapshot_json FROM published_quarters WHERE quarter_id=?").get(quarterId) as {
        quarter_id: string;
        version: number;
        published_at: string;
        draft_revision: number;
        published_by: string;
        snapshot_json: string;
    } | undefined;
    if (!row)
        return null;
    const publication: PublicationMetadata = {
        quarterId: row.quarter_id,
        version: row.version,
        publishedAt: row.published_at,
        draftRevision: row.draft_revision,
        publishedBy: row.published_by,
    };
    return { publication, snapshot: JSON.parse(row.snapshot_json) };
}
async function readBellSettings(db: AsyncDatabase, catalog?: Catalog): Promise<BellSettings> {
    const exists = await schemaTableExists(db, "bell_settings");
    if (!exists)
        return defaultBellSettings();
    const row = await db.prepare("SELECT settings_json FROM bell_settings WHERE id=1").get() as {
        settings_json: string;
    } | undefined;
    if (!row)
        return defaultBellSettings();
    try {
        const parsed = JSON.parse(row.settings_json);
        const normalized = normalizeBellSettings(parsed);
        return !normalized || validateBellSettings(normalized, catalog ?? await readCatalog(db)) ? defaultBellSettings() : normalized;
    }
    catch {
        return defaultBellSettings();
    }
}
// Capabilities are immutable between migrations/restore, unlike catalog data.
// Startup migration readers bypass this cache until the schema is ready.
const schemaCapabilities = new WeakMap<AsyncDatabase, {
    columns: Map<string, Promise<Set<string>>>;
    tables: Map<string, Promise<boolean>>;
}>();
function resetSchemaCapabilities(db: AsyncDatabase) {
    schemaCapabilities.set(db, { columns: new Map(), tables: new Map() });
}
async function schemaColumns(db: AsyncDatabase, table: string): Promise<Set<string>> {
    const cache = schemaCapabilities.get(db)?.columns;
    let result = cache?.get(table);
    if (!result) {
        result = db.pragma(`table_info(${table})`).then((rows: Array<{ name: string }>) => new Set(rows.map(row => row.name)));
        cache?.set(table, result);
        result.catch(() => { if (cache?.get(table) === result) cache?.delete(table); });
    }
    return result;
}
async function schemaTableExists(db: AsyncDatabase, table: string): Promise<boolean> {
    const cache = schemaCapabilities.get(db)?.tables;
    let result = cache?.get(table);
    if (!result) {
        result = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table).then(Boolean);
        cache?.set(table, result);
        result.catch(() => { if (cache?.get(table) === result) cache?.delete(table); });
    }
    return result;
}
async function hasColumn(db: AsyncDatabase, table: string, column: string): Promise<boolean> {
    return (await schemaColumns(db, table)).has(column);
}
function validDate(value: unknown): value is string {
    return (typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
}
async function validatePlanSnapshot(quartersInput: unknown, plansInput: unknown, db: AsyncDatabase): Promise<boolean> {
    if (!Array.isArray(quartersInput) ||
        !Array.isArray(plansInput) ||
        quartersInput.length < 1 ||
        quartersInput.length > 100 ||
        plansInput.length > MAX_STUDY_PLANS)
        return false;
    const currentQuarters = await readQuarters(db), currentPlans = await readStudyPlans(db), catalog = await readCatalog(db);
    const qids = new Set<string>(), quarters: Quarter[] = [];
    for (const raw of quartersInput) {
        if (!isRecord(raw) ||
            !validText(raw.id, 120) ||
            !/^[\p{L}\p{N}_:.-]+$/u.test(raw.id) ||
            !validText(raw.name, 100) ||
            !raw.name.trim() ||
            (raw.archived !== undefined && typeof raw.archived !== "boolean") ||
            !validDate(raw.startDate) ||
            !validDate(raw.endDate) ||
            raw.startDate > raw.endDate ||
            raw.startDate.slice(0, 4) < "2024" ||
            raw.endDate.slice(0, 4) > "2040" ||
            Date.parse(`${raw.endDate}T00:00:00Z`) -
                Date.parse(`${raw.startDate}T00:00:00Z`) >
                180 * 86400000 ||
            qids.has(raw.id))
            return false;
        const q = raw as unknown as Quarter;
        if (quarters.some((other) => q.startDate <= other.endDate && q.endDate >= other.startDate))
            return false;
        const prior = currentQuarters.find((item) => item.id === q.id);
        if (prior) {
            const movedLessons = await db
                .prepare("SELECT d.date FROM schedule_days d JOIN schedule_slots s ON s.day_id=d.id JOIN lessons l ON l.slot_id=s.id WHERE d.date BETWEEN ? AND ? LIMIT 1")
                .get(prior.startDate, prior.endDate) as {
                date: string;
            } | undefined;
            if (movedLessons &&
                (movedLessons.date < q.startDate || movedLessons.date > q.endDate))
                return false;
        }
        qids.add(q.id);
        quarters.push(q);
    }
    if (currentQuarters.some((q) => !qids.has(q.id)))
        return false;
    const groupById = new Map(catalog.groups.map((item) => [item.id, item])), subjectById = new Map(catalog.subjects.map((item) => [item.id, item])), subgroupById = new Map(catalog.subgroups.map((item) => [item.id, item]));
    const oldPlans = new Map(currentPlans.map((item) => [item.id, item])), seenIds = new Set<string>(), seenAssignmentIds = new Set<string>(), uniqueness = new Set<string>();
    for (const raw of plansInput) {
        if (!isRecord(raw) ||
            !validText(raw.id, 120) ||
            !/^[\p{L}\p{N}_:.-]+$/u.test(raw.id) ||
            seenIds.has(raw.id) ||
            !validText(raw.quarterId, 120) ||
            !qids.has(raw.quarterId) ||
            !validText(raw.groupId, 120) ||
            !groupById.has(raw.groupId) ||
            !validText(raw.subjectId, 80) ||
            !subjectById.has(raw.subjectId) ||
            !(["whole", "subgroups"] as unknown[]).includes(raw.mode) ||
            !(["regular", "lab"] as unknown[]).includes(raw.lessonKind) ||
            !Array.isArray(raw.assignments) ||
            raw.assignments.length < 1 ||
            raw.assignments.length > 100)
            return false;
        const previous = oldPlans.get(raw.id), group = groupById.get(raw.groupId), subject = subjectById.get(raw.subjectId);
        const samePlan = previous?.quarterId === raw.quarterId &&
            previous.groupId === raw.groupId &&
            previous.subjectId === raw.subjectId &&
            previous.lessonKind === raw.lessonKind;
        if ((group?.archived && (!samePlan || previous?.groupId !== group.id)) ||
            (subject?.archived && (!samePlan || previous?.subjectId !== subject.id)))
            return false;
        const unique = `${raw.quarterId}:${raw.groupId}:${raw.subjectId}:${raw.lessonKind}`;
        if (uniqueness.has(unique))
            return false;
        uniqueness.add(unique);
        seenIds.add(raw.id);
        const assignmentIds = new Set<string>(), participants = new Set<string>();
        for (const ass of raw.assignments) {
            if (!isRecord(ass) ||
                !validText(ass.id, 120) ||
                !/^[\p{L}\p{N}_:./-]+$/u.test(ass.id) ||
                assignmentIds.has(ass.id) ||
                seenAssignmentIds.has(ass.id) ||
                !Number.isInteger(ass.target) ||
                Number(ass.target) < 1 ||
                Number(ass.target) > 1000)
                return false;
            const oldAssignment = previous?.assignments.find((item) => item.id === ass.id);
            const subgroupId = ass.subgroupId;
            if (raw.mode === "whole") {
                if (subgroupId !== null || participants.has("*"))
                    return false;
                participants.add("*");
            }
            else {
                const subgroup = typeof subgroupId === "string"
                    ? subgroupById.get(subgroupId)
                    : undefined;
                if (!subgroup ||
                    subgroup.groupId !== raw.groupId ||
                    participants.has(subgroupId as string) ||
                    (subgroup.archived &&
                        (!samePlan || oldAssignment?.subgroupId !== subgroup.id)))
                    return false;
                participants.add(subgroupId as string);
            }
            assignmentIds.add(ass.id);
            seenAssignmentIds.add(ass.id);
        }
    }
    return true;
}
async function managedPlansChanged(input: unknown, db: AsyncDatabase): Promise<boolean> {
    if (!Array.isArray(input))
        return true;
    const managed = new Set<string>();
    for (const curriculum of await readCurricula(db))
        for (const groupId of curriculum.groupIds)
            managed.add(JSON.stringify([curriculum.quarterId, groupId]));
    if (!managed.size)
        return false;
    const current = await readStudyPlans(db);
    const normalize = (plans: StudyPlan[], quarterId: string, groupId: string) => plans
        .filter(plan => plan.quarterId === quarterId && plan.groupId === groupId)
        .map(plan => ({
        id: plan.id, quarterId: plan.quarterId, groupId: plan.groupId,
        subjectId: plan.subjectId, mode: plan.mode, lessonKind: plan.lessonKind,
        assignments: plan.assignments.map(a => ({ id: a.id, subgroupId: a.subgroupId, target: a.target }))
            .sort((a, b) => a.id.localeCompare(b.id)),
    }))
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const key of managed) {
        const [quarterId, groupId] = JSON.parse(key) as [
            string,
            string
        ];
        const expected = normalize(current, quarterId, groupId);
        const proposed = normalize(input as StudyPlan[], quarterId, groupId);
        if (JSON.stringify(expected) !== JSON.stringify(proposed))
            return true;
    }
    return false;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validText(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length <= max;
}
function validationFailure(): false {
    return false;
}
function roomResolvedSchedule(schedule: Schedule, reference: Schedule, catalog: Catalog): Schedule | undefined {
    const result = structuredClone(schedule);
    const roomsByName = new Map(catalog.rooms.map((room) => [room.name.toLocaleLowerCase("ru"), room]));
    const roomById = new Map(catalog.rooms.map((room) => [room.id, room]));
    const groupById = new Map(catalog.groups.map((group) => [group.id, group]));
    const teacherById = new Map(catalog.teachers.map((teacher) => [teacher.id, teacher]));
    const teacherByName = new Map(catalog.teachers.map((teacher) => [teacher.name.toLocaleLowerCase("ru"), teacher]));
    const teachersBySurname = new Map<string, CatalogTeacher[]>();
    for (const teacher of catalog.teachers) {
        const surname = teacher.name.trim().split(/\s+/)[0]?.toLocaleLowerCase("ru");
        if (surname)
            teachersBySurname.set(surname, [...(teachersBySurname.get(surname) ?? []), teacher]);
    }
    const teacherLabels = new Map<string, CatalogTeacher | undefined>();
    const teacherByLabel = (label: string | undefined) => {
        if (!label?.trim())
            return undefined;
        const normalized = label.trim().toLocaleLowerCase("ru");
        if (teacherLabels.has(normalized))
            return teacherLabels.get(normalized);
        const exact = teacherByName.get(normalized);
        if (exact) {
            teacherLabels.set(normalized, exact);
            return exact;
        }
        const surnameMatches = teachersBySurname.get(normalized);
        const resolved = surnameMatches?.length === 1 ? surnameMatches[0] : undefined;
        teacherLabels.set(normalized, resolved);
        return resolved;
    };
    const subjectsById = new Map(subjects.map((subject) => [subject.id, subject]));
    const previousById = new Map<string, (typeof catalog.rooms)[number]>();
    for (const days of Object.values(reference))
        for (const day of days)
            for (const slot of day.slots)
                for (const lesson of slot)
                    if (lesson.roomId) {
                        const room = roomById.get(lesson.roomId);
                        if (room)
                            previousById.set(lesson.id, room);
                    }
    for (const [key, days] of Object.entries(result)) {
        const groupId = key.slice(0, key.lastIndexOf(":"));
        const groupRoomId = groupById.get(groupId)?.roomId;
        for (const day of days)
            for (const slot of day.slots)
                for (const lesson of slot) {
                    const teacher = lesson.teacherId
                        ? teacherById.get(lesson.teacherId)
                        : teacherByLabel(lesson.teacher);
                    if (!lesson.teacherId && teacher)
                        lesson.teacherId = teacher.id;
                    if (lesson.roomId)
                        continue;
                    const labelRoom = lesson.room?.trim()
                        ? roomsByName.get(lesson.room.trim().toLocaleLowerCase("ru"))
                        : undefined;
                    const subjectRoomName = subjectsById.get(lesson.subjectId)?.room;
                    const inferredId = labelRoom?.id ??
                        previousById.get(lesson.id)?.id ??
                        (lesson.room?.trim()
                            ? undefined
                            : lesson.subjectId === "event"
                                ? undefined
                                : (teacher?.defaultRoomId ??
                                    groupRoomId ??
                                    (subjectRoomName
                                        ? roomsByName.get(subjectRoomName.toLocaleLowerCase("ru"))
                                            ?.id
                                        : undefined)));
                    if (inferredId)
                        lesson.roomId = inferredId;
                    else if (lesson.subjectId !== "event" &&
                        !referenceHasSameUnresolvedRoom(reference, lesson.id, lesson.room))
                        return undefined;
                }
    }
    return result;
}
function referenceHasSameUnresolvedRoom(schedule: Schedule, lessonId: string, room: string | undefined): boolean {
    for (const days of Object.values(schedule))
        for (const day of days)
            for (const slot of day.slots)
                for (const lesson of slot)
                    if (lesson.id === lessonId &&
                        !lesson.roomId &&
                        (lesson.room ?? "") === (room ?? ""))
                        return true;
    return false;
}
function validateSchedule(input: unknown, reference: Schedule, catalog: Catalog, quarters: Quarter[], plans: StudyPlan[]): input is Schedule {
    if (!isRecord(input) ||
        Object.keys(input).length !== Object.keys(reference).length)
        return validationFailure();
    const subjectIds = new Set(catalog.subjects.map((subject) => subject.id));
    const subjectById = new Map(catalog.subjects.map((subject) => [subject.id, subject]));
    const groupById = new Map(catalog.groups.map((group) => [group.id, group]));
    const subgroupNamesByGroup = new Map<string, Map<string, Catalog["subgroups"][number]>>();
    for (const subgroup of catalog.subgroups) {
        const names = subgroupNamesByGroup.get(subgroup.groupId) ?? new Map();
        if (!names.has(subgroup.name))
            names.set(subgroup.name, subgroup);
        subgroupNamesByGroup.set(subgroup.groupId, names);
    }
    const knownSubgroups = new Map<string, Set<string>>();
    for (const [scheduleKey, days] of Object.entries(reference)) {
        const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
        const names = days.flatMap((day) => day.slots.flatMap((slot) => slot
            .map((lesson) => lesson.subgroup)
            .filter((name): name is string => Boolean(name))));
        const known = knownSubgroups.get(groupId) ?? new Set<string>();
        names.forEach((name) => known.add(name));
        knownSubgroups.set(groupId, known);
    }
    const subgroupById = new Map(catalog.subgroups.map((entry) => [entry.id, entry]));
    const teacherById = new Map(catalog.teachers.map((entry) => [entry.id, entry]));
    const teacherExactByName = new Map(catalog.teachers.map((entry) => [entry.name.toLocaleLowerCase("ru"), entry]));
    const teacherSurnameMatches = new Map<string, CatalogTeacher[]>();
    for (const teacher of catalog.teachers) {
        const surname = teacher.name.trim().split(/\s+/)[0]?.toLocaleLowerCase("ru");
        if (surname)
            teacherSurnameMatches.set(surname, [...(teacherSurnameMatches.get(surname) ?? []), teacher]);
    }
    const teacherLabelCache = new Map<string, CatalogTeacher | undefined>();
    const teacherByLabel = (label: string | undefined) => {
        if (!label)
            return undefined;
        const normalized = label.trim().toLocaleLowerCase("ru");
        if (teacherLabelCache.has(normalized))
            return teacherLabelCache.get(normalized);
        const exact = teacherExactByName.get(normalized);
        if (exact) {
            teacherLabelCache.set(normalized, exact);
            return exact;
        }
        const matches = teacherSurnameMatches.get(normalized);
        const resolved = matches?.length === 1 ? matches[0] : undefined;
        teacherLabelCache.set(normalized, resolved);
        return resolved;
    };
    const roomById = new Map(catalog.rooms.map((entry) => [entry.id, entry]));
    const quarterByDate = new Map<string, Quarter | undefined>();
    const planByKey = new Map<string, StudyPlan>();
    for (const plan of plans) {
        const key = `${plan.quarterId}\u0000${plan.groupId}\u0000${plan.subjectId}\u0000${plan.lessonKind}`;
        if (!planByKey.has(key))
            planByKey.set(key, plan);
    }
    const quarterForDate = (date: string) => {
        if (!quarterByDate.has(date))
            quarterByDate.set(date, quarters.find((item) => inQuarter(date, item)));
        return quarterByDate.get(date);
    };
    const jointMembers = new Map<string, Array<{
        lesson: Record<string, unknown>;
        groupId: string;
        date: string;
        start: number;
        end: number;
        event: boolean;
        teacher: string | undefined;
        room: string | undefined;
        fullGroup: boolean;
    }>>();
    const scheduleLessons: Array<{
        id: string;
        groupId: string;
        date: string;
        start: number;
        end: number;
        teacher: string | undefined;
        jointId: string | undefined;
    }> = [];
    const existingLessons = new Map<string, {
        row: Record<string, unknown>;
        groupId: string;
        date: string;
    }>();
    for (const [scheduleKey, days] of Object.entries(reference))
        for (const day of days)
            for (const slot of day.slots)
                for (const lesson of slot)
                    existingLessons.set(lesson.id, {
                        row: lesson as unknown as Record<string, unknown>,
                        groupId: scheduleKey.slice(0, scheduleKey.lastIndexOf(":")),
                        date: day.date,
                    });
    const seenLessonIds = new Set<string>();
    let totalSlots = 0;
    for (const [scheduleKey, expectedDays] of Object.entries(reference)) {
        const days = input[scheduleKey];
        if (!Array.isArray(days) || days.length !== expectedDays.length)
            return validationFailure();
        const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
        for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
            const day = days[dayIndex];
            const expected = expectedDays[dayIndex];
            if (!isRecord(day) ||
                day.date !== expected.date ||
                Boolean(day.holiday) !== Boolean(expected.holiday) ||
                !validText(day.start, 5) ||
                !/^\d{2}:\d{2}$/.test(day.start) ||
                !Number.isFinite(parseTime(day.start)) ||
                !Number.isInteger(day.duration) ||
                Number(day.duration) < 1 ||
                Number(day.duration) > 180 ||
                (typeof day.holiday !== "boolean" && day.holiday !== undefined) ||
                (day.note !== undefined && !validText(day.note, 500)) ||
                (day.bellProfile !== undefined && validateBellProfile(day.bellProfile) !== null) ||
                !Array.isArray(day.slots) ||
                !Array.isArray(day.times) ||
                day.slots.length !== day.times.length ||
                day.slots.length > 12 ||
                !Array.isArray(day.breaks))
                return validationFailure();
            totalSlots += day.slots.length;
            if (totalSlots > MAX_SCHEDULE_SLOTS)
                return validationFailure();
            let previousEnd = -1;
            for (const time of day.times) {
                if (!isRecord(time) ||
                    !Number.isInteger(time.start) ||
                    Number(time.start) < 0 ||
                    Number(time.start) > 1439 ||
                    !Number.isInteger(time.duration) ||
                    Number(time.duration) < 1 ||
                    Number(time.duration) > 180 ||
                    Number(time.start) + Number(time.duration) > 1440 ||
                    Number(time.start) < previousEnd)
                    return validationFailure();
                previousEnd = Number(time.start) + Number(time.duration);
            }
            if (day.breaks.length !== Math.max(0, day.times.length - 1) ||
                day.breaks.some((entry) => !Number.isInteger(entry) ||
                    Number(entry) < 0 ||
                    Number(entry) > 240))
                return validationFailure();
            for (const [slotIndex, lessons] of day.slots.entries()) {
                if (!Array.isArray(lessons) || lessons.length > 20)
                    return validationFailure();
                const occupied = new Set<string>();
                for (const lesson of lessons) {
                    if (!isRecord(lesson) ||
                        !validText(lesson.id, 120) ||
                        !lesson.id ||
                        seenLessonIds.has(lesson.id) ||
                        !validText(lesson.subjectId, 80) ||
                        (!validText(lesson.subgroup, 120) &&
                            lesson.subgroup !== undefined) ||
                        (!validText(lesson.subgroupId, 120) &&
                            lesson.subgroupId !== undefined) ||
                        (!validText(lesson.teacher, 160) && lesson.teacher !== undefined) ||
                        (!validText(lesson.teacherId, 120) &&
                            lesson.teacherId !== undefined) ||
                        (!validText(lesson.room, 120) && lesson.room !== undefined) ||
                        (!validText(lesson.roomId, 120) && lesson.roomId !== undefined) ||
                        (!validText(lesson.event, 200) && lesson.event !== undefined) ||
                        (!validText(lesson.note, 500) && lesson.note !== undefined)
                        || (!validText(lesson.jointId, 120) && lesson.jointId !== undefined)
                        || (lesson.jointId !== undefined && !lesson.jointId))
                        return validationFailure();
                    seenLessonIds.add(lesson.id);
                    const oldPlacement = existingLessons.get(lesson.id);
                    if (expected.holiday && (!oldPlacement || oldPlacement.groupId !== groupId || oldPlacement.date !== expected.date))
                        return validationFailure();
                    const event = lesson.subjectId === "event";
                    if (!event && !subjectIds.has(lesson.subjectId))
                        return validationFailure();
                    if (event && !lesson.event)
                        return validationFailure();
                    if (!event && lesson.event !== undefined)
                        return validationFailure();
                    if (lesson.eventRemainder !== undefined &&
                        (!event || !isEventRemainder(lesson.eventRemainder)))
                        return validationFailure();
                    const subgroupEntry = typeof lesson.subgroupId === "string"
                        ? subgroupById.get(lesson.subgroupId)
                        : undefined;
                    if (lesson.subgroupId &&
                        (!subgroupEntry || subgroupEntry.groupId !== groupId))
                        return validationFailure();
                    const resolvedSubgroup = subgroupEntry ??
                        (typeof lesson.subgroup === "string"
                            ? subgroupNamesByGroup.get(groupId)?.get(lesson.subgroup)
                            : undefined);
                    const oldMeta = existingLessons.get(lesson.id);
                    const oldLesson = oldMeta?.row;
                    if (lesson.lessonKind !== undefined &&
                        lesson.lessonKind !== "regular" &&
                        lesson.lessonKind !== "lab")
                        return validationFailure();
                    const subjectEntry = subjectById.get(lesson.subjectId);
                    if (subjectEntry?.archived &&
                        oldLesson?.subjectId !== lesson.subjectId)
                        return validationFailure();
                    if (resolvedSubgroup?.archived &&
                        oldLesson?.subgroupId !== resolvedSubgroup.id)
                        return validationFailure();
                    if (lesson.subgroup &&
                        !lesson.subgroupId &&
                        !knownSubgroups.get(groupId)?.has(lesson.subgroup))
                        return validationFailure();
                    const teacherEntry = lesson.teacherId
                        ? teacherById.get(lesson.teacherId)
                        : teacherByLabel(lesson.teacher);
                    const roomEntry = lesson.roomId
                        ? roomById.get(lesson.roomId)
                        : undefined;
                    if (lesson.teacherId && !teacherEntry)
                        return validationFailure();
                    if (lesson.roomId && !roomEntry)
                        return validationFailure();
                    const time = day.times[slotIndex] as {
                        start: number;
                        duration: number;
                    };
                    const teacherIdentity = teacherEntry?.id ??
                        (typeof lesson.teacher === "string"
                            ? lesson.teacher.trim().toLocaleLowerCase("ru")
                            : undefined);
                    scheduleLessons.push({
                        id: lesson.id as string,
                        groupId,
                        date: day.date as string,
                        start: time.start,
                        end: time.start + time.duration,
                        teacher: teacherIdentity,
                        jointId: typeof lesson.jointId === "string" ? lesson.jointId : undefined,
                    });
                    if (lesson.jointId) {
                        const members = jointMembers.get(lesson.jointId) ?? [];
                        members.push({
                            lesson: lesson as Record<string, unknown>,
                            groupId,
                            date: day.date as string,
                            start: time.start,
                            end: time.start + time.duration,
                            event,
                            teacher: teacherEntry?.id ?? (typeof lesson.teacher === "string" ? lesson.teacher : undefined),
                            room: roomEntry?.id ?? (typeof lesson.room === "string" ? lesson.room : undefined),
                            fullGroup: !lesson.subgroupId && !lesson.subgroup,
                        });
                        jointMembers.set(lesson.jointId, members);
                    }
                    if (teacherEntry?.archived &&
                        oldLesson?.teacherId !== teacherEntry.id)
                        return validationFailure();
                    const sameTeacherAndSubject = oldLesson?.subjectId === lesson.subjectId &&
                        (teacherEntry
                            ? oldLesson.teacherId === teacherEntry.id
                            : oldLesson.teacher === lesson.teacher);
                    if (!event &&
                        !sameTeacherAndSubject &&
                        (!teacherEntry ||
                            teacherEntry.archived ||
                            !teacherEntry.subjectIds.includes(lesson.subjectId)))
                        return validationFailure();
                    if (roomEntry?.archived && oldLesson?.roomId !== roomEntry.id)
                        return validationFailure();
                    if (lesson.subgroupId &&
                        lesson.subgroup &&
                        subgroupEntry &&
                        lesson.subgroup !== subgroupEntry.name)
                        return validationFailure();
                    const scope = resolvedSubgroup?.id ?? lesson.subgroup ?? "*";
                    const groupEntry = groupById.get(groupId);
                    if (groupEntry?.archived && !oldLesson)
                        return validationFailure();
                    if (occupied.has("*") ||
                        (scope === "*" && occupied.size > 0) ||
                        occupied.has(scope))
                        return validationFailure();
                    occupied.add(scope);
                    if (!event) {
                        const kind = (lesson.lessonKind as LessonKind | undefined) ?? "regular";
                        const unchanged = oldMeta?.groupId === groupId &&
                            oldMeta.date === day.date &&
                            oldLesson?.subjectId === lesson.subjectId &&
                            (oldLesson?.lessonKind ?? "regular") === kind &&
                            (oldLesson?.subgroupId ?? oldLesson?.subgroup ?? null) ===
                                (lesson.subgroupId ?? lesson.subgroup ?? null);
                        if (!unchanged) {
                            const quarter = quarterForDate(day.date as string);
                            const plan = quarter &&
                                planByKey.get(`${quarter.id}\u0000${groupId}\u0000${lesson.subjectId}\u0000${kind}`);
                            const participant = lesson.subgroupId ?? null;
                            const assignment = plan?.assignments.find((item) => item.subgroupId === participant);
                            if (!plan ||
                                !assignment ||
                                (plan.mode === "whole" && participant !== null) ||
                                (plan.mode === "subgroups" && participant === null))
                                return validationFailure();
                        }
                    }
                }
            }
        }
    }
    const oldJointSignatures = jointSignatures(reference);
    const nextJointSignatures = jointSignatures(input as Schedule);
    for (const [jointId, members] of jointMembers) {
        if (oldJointSignatures.get(jointId) === nextJointSignatures.get(jointId))
            continue;
        const first = members[0];
        if (!first || members.some((member) => !member.fullGroup || member.date !== first.date ||
            member.start !== first.start || member.end !== first.end ||
            member.event !== first.event || member.teacher !== first.teacher ||
            member.room !== first.room ||
            member.lesson.subjectId !== first.lesson.subjectId ||
            (member.lesson.event ?? "") !== (first.lesson.event ?? "") ||
            (member.lesson.lessonKind ?? "regular") !== (first.lesson.lessonKind ?? "regular")))
            return validationFailure();
        if (new Set(members.map((member) => member.groupId)).size !== members.length)
            return validationFailure();
        const mirrorIds = new Set(members.map((member) => String(member.lesson.id)));
        for (const member of members) {
            if (!member.teacher)
                continue;
            if (scheduleLessons.some((other) => !mirrorIds.has(other.id) && other.teacher === member.teacher &&
                other.date === member.date && other.start < member.end &&
                member.start < other.end))
                return validationFailure();
        }
        if (first.event) {
            if (members.some((member) => member.lesson.subjectId !== "event" || !member.lesson.event))
                return validationFailure();
        }
        else {
            if (members.some((member) => member.lesson.subjectId === "event" || member.lesson.event !== undefined))
                return validationFailure();
            const subject = subjectById.get(String(first.lesson.subjectId));
            const cohort = canShareSubject(subject, members.map((member) => member.groupId), catalog.groups);
            if (!cohort)
                return validationFailure();
        }
        // Room type and aggregate capacity are checked after room resolution by
        // newRoomSuitabilityViolation. That comparison allows unchanged legacy
        // joints to remain editable while still rejecting new or enlarged issues.
    }
    return true;
}
function jointSignatures(schedule: Schedule): Map<string, string> {
    const members = new Map<string, string[]>();
    for (const [key, days] of Object.entries(schedule)) {
        const groupId = key.slice(0, key.lastIndexOf(":"));
        for (const day of days)
            day.slots.forEach((slot, slotIndex) => {
                const time = day.times[slotIndex];
                for (const lesson of slot)
                    if (lesson.jointId)
                        members.set(lesson.jointId, [
                            ...(members.get(lesson.jointId) ?? []),
                            JSON.stringify([groupId, day.date, time?.start, time?.duration, lesson]),
                        ]);
            });
    }
    return new Map([...members].map(([id, values]) => [id, values.sort().join("\u0001")]));
}
function validateCatalog(input: unknown, current: Catalog): input is Catalog {
    if (!isRecord(input))
        return false;
    const keys = [
        "subjects",
        "teachers",
        "rooms",
        "groups",
        "subgroups",
    ] as const;
    if (keys.some((key) => !Array.isArray(input[key])))
        return false;
    const next = input as unknown as Catalog;
    const specs: Array<[
        keyof Catalog,
        number,
        number
    ]> = [
        ["subjects", 200, 100],
        ["teachers", 500, 160],
        ["rooms", 500, 80],
        ["groups", 500, 80],
        ["subgroups", 1000, 120],
    ];
    for (const [key, maxCount, maxName] of specs) {
        if ((next[key] as unknown[]).length > maxCount)
            return false;
        const seenIds = new Set<string>();
        const seenNames = new Set<string>();
        const scopedSubgroupNames = new Set<string>();
        for (const raw of next[key] as unknown[]) {
            if (!isRecord(raw) ||
                !validText(raw.id, 120) ||
                !/^[\p{L}\p{N}_:.-]+$/u.test(raw.id) ||
                !validText(raw.name, maxName) ||
                !raw.name.trim() ||
                raw.name !== raw.name.trim() ||
                typeof raw.archived !== "boolean" ||
                seenIds.has(raw.id))
                return false;
            if (key !== "subgroups") {
                const name = raw.name.toLocaleLowerCase("ru");
                if (seenNames.has(name))
                    return false;
                seenNames.add(name);
            }
            else {
                const scopedName = `${String(raw.groupId)}:${raw.name.toLocaleLowerCase("ru")}`;
                if (scopedSubgroupNames.has(scopedName))
                    return false;
                scopedSubgroupNames.add(scopedName);
            }
            seenIds.add(raw.id);
        }
    }
    const currentTeacherSubjects = new Set(current.teachers.flatMap((teacher) => teacher.subjectIds.map((subjectId) => `${teacher.id}\u0000${subjectId}`)));
    const currentTeacherPreferences = new Map(current.teachers.map((teacher) => [teacher.id, new Set(teacher.preferredGroupIds ?? [])]));
    const groupById = new Map(next.groups.map((group) => [group.id, group]));
    const subjectById = new Map(next.subjects.map((entry) => [entry.id, entry]));
    for (const teacher of next.teachers) {
        if (!Array.isArray(teacher.subjectIds))
            return false;
        if (!Array.isArray(teacher.preferredGroupIds))
            return false;
        if (teacher.preferredShift !== undefined && teacher.preferredShift !== null && teacher.preferredShift !== "morning" && teacher.preferredShift !== "afternoon")
            return false;
        if (validateUnavailabilityRules(teacher.unavailability))
            return false;
        if (teacher.defaultRoomId !== null &&
            (typeof teacher.defaultRoomId !== "string" ||
                !next.rooms.some((room) => room.id === teacher.defaultRoomId)))
            return false;
        const seen = new Set<string>();
        for (const subjectId of teacher.subjectIds) {
            if (typeof subjectId !== "string" || seen.has(subjectId))
                return false;
            const subject = subjectById.get(subjectId);
            if (!subject)
                return false;
            const key = `${teacher.id}\u0000${subjectId}`;
            const wasLinked = currentTeacherSubjects.has(key);
            if (!wasLinked && (teacher.archived || subject.archived))
                return false;
            seen.add(subjectId);
        }
        const seenPreferredGroups = new Set<string>();
        const oldPreferences = currentTeacherPreferences.get(teacher.id) ?? new Set();
        for (const groupId of teacher.preferredGroupIds) {
            if (typeof groupId !== "string" || seenPreferredGroups.has(groupId))
                return false;
            const group = groupById.get(groupId);
            if (!group || (group.archived && !oldPreferences.has(groupId)))
                return false;
            seenPreferredGroups.add(groupId);
        }
    }
    const allowedColors = new Set(subjectColors.map(({ id }) => id));
    const allowedRoomKinds = new Set([
        "general",
        "informatics",
        "physics-lab",
        "chemistry-lab",
        "gym",
        "assembly",
        "other",
    ]);
    if (next.subjects.some((entry) => (entry.iconId !== undefined && entry.iconId !== null && entry.iconId !== "auto" && !isSubjectIconId(entry.iconId)) ||
        !validText(entry.shortName, 40) ||
        !entry.shortName.trim() ||
        !allowedColors.has(entry.color) ||
        (entry.roomKind !== null && !allowedRoomKinds.has(entry.roomKind)) ||
        (entry.labRoomKind !== null &&
            !allowedRoomKinds.has(entry.labRoomKind)) ||
        (entry.jointSameGrade !== undefined && typeof entry.jointSameGrade !== "boolean") ||
        (entry.maxJointGroups !== undefined &&
            (!Number.isInteger(entry.maxJointGroups) || entry.maxJointGroups < 2 || entry.maxJointGroups > 50)) ||
        !Array.isArray(entry.jointGroupSets ?? []) ||
        (entry.jointGroupSets ?? []).some((set) => !Array.isArray(set) || set.length < 2 ||
            new Set(set).size !== set.length ||
            set.some((groupId) => typeof groupId !== "string" || !next.groups.some((group) => group.id === groupId)))))
        return false;
    if (next.rooms.some((entry) => !allowedRoomKinds.has(entry.kind) ||
        Boolean(validateUnavailabilityRules(entry.unavailability)) ||
        (entry.capacity !== null &&
            (!Number.isInteger(entry.capacity) || entry.capacity < 1))))
        return false;
    if (next.groups.some((entry) => !Number.isInteger(entry.students) ||
        entry.students < 0 ||
        !Array.isArray(entry.autoRoomIds) ||
        new Set(entry.autoRoomIds).size !== entry.autoRoomIds.length ||
        entry.autoRoomIds.some((roomId) => {
            if (typeof roomId !== "string")
                return true;
            const room = next.rooms.find((item) => item.id === roomId);
            const old = current.groups.find((item) => item.id === entry.id);
            return !room || (room.archived && !old?.autoRoomIds.includes(roomId));
        }) ||
        (entry.leaderId !== null &&
            !next.teachers.some((teacher) => teacher.id === entry.leaderId)) ||
        (entry.roomId !== null &&
            !next.rooms.some((room) => room.id === entry.roomId))))
        return false;
    if (next.subgroups.some((entry) => !validText(entry.groupId, 120) ||
        !next.groups.some((group) => group.id === entry.groupId) ||
        !Number.isInteger(entry.students) ||
        entry.students < 0))
        return false;
    const activeGroups = next.groups.filter((group) => !group.archived);
    if (!activeGroups.length)
        return false;
    for (const group of activeGroups) {
        const students = next.subgroups
            .filter((entry) => entry.groupId === group.id && !entry.archived)
            .reduce((sum, entry) => sum + entry.students, 0);
        if (students > group.students)
            return false;
    }
    const oldGroups = new Map(current.groups.map((entry) => [entry.id, entry]));
    const oldTeachers = new Map(current.teachers.map((entry) => [entry.id, entry]));
    for (const teacher of next.teachers) {
        const old = oldTeachers.get(teacher.id);
        const roomChanged = !old || old.defaultRoomId !== teacher.defaultRoomId;
        const room = teacher.defaultRoomId
            ? next.rooms.find((entry) => entry.id === teacher.defaultRoomId)
            : undefined;
        if (roomChanged && room?.archived)
            return false;
    }
    for (const group of next.groups) {
        const old = oldGroups.get(group.id);
        if ((!old || old.leaderId !== group.leaderId) &&
            group.leaderId &&
            next.teachers.find((entry) => entry.id === group.leaderId)?.archived)
            return false;
        if ((!old || old.roomId !== group.roomId) &&
            group.roomId &&
            next.rooms.find((entry) => entry.id === group.roomId)?.archived)
            return false;
    }
    return true;
}
async function addGroupSchedule(db: AsyncDatabase, groupId: string): Promise<void> {
    const quarters = await readQuarters(db);
    const calendar = await readSchoolCalendar(db);
    const settings = await readBellSettings(db);
    const profile = effectiveBellProfile(settings, groupId);
    const insertDay = db.prepare("INSERT OR IGNORE INTO schedule_days(group_id,date,week_offset,day_index,base_start,nominal_duration,holiday,note,bell_profile_json) VALUES(?,?,?,?,?,?,?,NULL,?)");
    const insertSlot = db.prepare("INSERT INTO schedule_slots(day_id,slot_index,start_minute,duration) VALUES(?,?,?,?)");
    for (const quarter of quarters)
        for (const weekOffset of quarterWeeks(quarter)) {
            const dates = weekDates(weekOffset);
            for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
                const date = dates[dayIndex];
                const result = await insertDay.run(groupId, date, weekOffset, dayIndex, `${String(Math.floor(profile.start / 60)).padStart(2, "0")}:${String(profile.start % 60).padStart(2, "0")}`, profile.duration, calendarDay(calendar, groupId, date).holiday ? 1 : 0, JSON.stringify(profile));
                if (!result.changes)
                    continue;
                let start = profile.start;
                for (let slotIndex = 0; slotIndex < 7; slotIndex += 1) {
                    await insertSlot.run(Number(result.lastInsertRowid), slotIndex, start, profile.duration);
                    start += profile.duration + bellBreak(profile, slotIndex);
                }
            }
        }
}
async function makePostgresDatabase(url: string): Promise<AsyncDatabase> {
    const db = openPostgresDatabase(url);
    try {
        await initializePostgresSchema(db);
        await db.transaction(async () => {
            await db.prepare("INSERT OR IGNORE INTO draft_metadata(id,revision,updated_at,initialized) VALUES(1,0,?,1)").run(nowIso());
            await db.prepare("INSERT OR IGNORE INTO school_display_settings(id,settings_json,revision) VALUES(1,?,0)").run(JSON.stringify(defaultDisplaySettings()));
            await db.prepare("INSERT OR IGNORE INTO bell_settings(id,settings_json) VALUES(1,?)").run(JSON.stringify(defaultBellSettings()));
            await db.prepare("INSERT OR IGNORE INTO school_calendar(id,calendar_json) VALUES(1,?)").run(JSON.stringify(defaultSchoolCalendar()));
            if (!await db.prepare("SELECT 1 FROM postgres_schema_migrations WHERE version=2").get()) {
                const existing = (await readCatalog(db)).subjects;
                const subjects = addMissingSchoolSubjectPresets(existing);
                const insert = db.prepare("INSERT OR IGNORE INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,archived,icon_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
                for (const subject of subjects.slice(existing.length))
                    await insert.run(subject.id, subject.name, subject.shortName, subject.color, subject.roomKind, subject.labRoomKind, JSON.stringify(subject.jointGroupSets ?? []), Number(subject.jointSameGrade ?? false), subject.maxJointGroups ?? 2, Number(subject.archived), subject.iconId ?? null);
                await db.prepare("INSERT INTO postgres_schema_migrations(version) VALUES(2)").run();
            }
        })();
        return db;
    }
    catch (error) {
        await db.close();
        throw error;
    }
}
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
    const databaseUrl = options.databaseUrl ?? process.env.SMENA_DATABASE_URL;
    const dbPath = options.dbPath ?? process.env.SMENA_DB_PATH;
    if (!options.dbPath && !databaseUrl && !dbPath)
        throw new Error("Укажите SMENA_DATABASE_URL для PostgreSQL");
    const db = options.dbPath || (options.databaseUrl === undefined && process.env.SMENA_DB_PATH !== undefined)
        ? await makeSqliteDatabase(dbPath!)
        : await makePostgresDatabase(databaseUrl!);
    resetSchemaCapabilities(db);
    const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES, trustProxy: process.env.SMENA_TRUST_PROXY === "1" });
    await app.register(fastifyCompress, {
        globalCompression: true,
        globalDecompression: false,
        encodings: ["gzip"],
        threshold: 1024,
        zlibOptions: { level: 6 },
        // Keep the default text/data types and include the bundled TTF fonts.
        customTypes: /^text\/(?!event-stream)|(?:\+|\/)(?:json|text|xml)(?:;|$)|octet-stream(?:;|$)|^font\/(?:ttf|otf)(?:;|$)/u,
    });
    const cookiePath = process.env.SMENA_BASE_PATH || "/";
    await app.register(cookie);
    const maintenance = new MaintenanceGate();
    const activeHandlers = new WeakSet<object>();
    app.addHook("onRoute", (route) => {
        if (!route.url.startsWith("/api/")) return;
        const handler = route.handler;
        route.handler = async function (request, reply) {
            if (reply.raw.destroyed) { maintenance.leave(request); return reply; }
            activeHandlers.add(request);
            try { return await handler.call(this, request, reply); }
            finally { activeHandlers.delete(request); maintenance.leave(request); }
        };
    });
    app.addHook("onRequest", async (request, reply) => {
        if (!request.url.startsWith("/api/") || request.url.startsWith("/api/data-transfer/status/")) return;
        if (!maintenance.enter(request)) return reply.code(503).header("retry-after", "3").send({ error: "Восстанавливаем школьные данные. Повторите запрос через несколько секунд" });
        // A disconnected client does not cancel an async database operation.
        reply.raw.once("close", () => { if (!activeHandlers.has(request)) maintenance.leave(request); });
    });
    app.addHook("onResponse", async (request) => { if (!activeHandlers.has(request)) maintenance.leave(request); });
    const failureWindow = new Map<string, {
        count: number;
        since: number;
    }>();
    // One current scope per session, with a small global bound. The revision is
    // checked before every hit, including identical requests; apply never uses it.
    const reassignmentPreviews = new Map<string, {
        revision: number;
        scope: string;
        expires: number;
        state: Awaited<ReturnType<typeof readReassignmentState>>;
        calculations: ReturnType<typeof createTeacherReassignmentPreviewCache>;
        requestKey?: string;
        preview?: TeacherReassignmentPreview;
    }>();
    const publicProjectionIndexCache = new Map<string, {
        key: string;
        studentsQuarter?: PublicStudentProjection["quarter"];
        teachersQuarter?: PublicTeacherProjection["quarter"];
    }>();
    const printPublishedIndexCache = new Map<string, {
        key: string;
        quarter: SchedulePrintIndex["published"][number];
    }>();
    let publicStudentScheduleCache: {
        quarterId: string;
        targetId: string;
        key: string;
        projection: PublicStudentProjection;
    } | undefined;
    let publicStudentsDayCache: { key: string; signature: string; value: PublicStudentsDaySchedule } | undefined;
    let publicStudentsWeekCache: { key: string; value: PublicStudentsWeekSchedule } | undefined;
    let publicTeachersDayCache: { key: string; signature: string; value: PublicTeachersDaySchedule } | undefined;
    let publicTeachersWeekCache: { key: string; value: PublicTeachersWeekSchedule } | undefined;
    let publicTeacherScheduleCache: {
        quarterId: string;
        targetId: string;
        key: string;
        projection: PublicTeacherProjection;
    } | undefined;
    app.decorate<unknown>("smenaDb", db.native ?? db);
    app.decorate("smenaDatabase", db);
    app.addHook("onClose", async () => await db.close());
    const isSameOrigin = (request: FastifyRequest): boolean => {
        const origin = request.headers.origin;
        if (!origin)
            return true;
        try {
            const expected = `${request.protocol}://${request.headers.host}`;
            return new URL(origin).origin === new URL(expected).origin;
        }
        catch {
            return false;
        }
    };
    const getSession = async (request: FastifyRequest): Promise<SessionInfo | null> => {
        const token = request.cookies[COOKIE_NAME];
        if (!token)
            return null;
        const row = await db
            .prepare("SELECT csrf_token, expires_at, username FROM sessions WHERE token_hash = ?")
            .get(hash(token)) as {
            csrf_token: string;
            expires_at: number;
            username: string;
        } | undefined;
        if (!row || row.expires_at <= Date.now()) {
            if (row)
                await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
            return null;
        }
        return { username: row.username, csrfToken: row.csrf_token };
    };
    const authStatus = async (request: FastifyRequest) => {
        const needsSetup = !await db.prepare("SELECT 1 FROM admin_users LIMIT 1").get();
        const session = await getSession(request);
        return session
            ? {
                needsSetup,
                authenticated: true,
                username: session.username,
                csrfToken: session.csrfToken,
            }
            : { needsSetup, authenticated: false };
    };
    await registerPlanCoverageApi(app, {
        db, getSession, readCatalog: async () => await readCatalog(db), readQuarters: async () => await readQuarters(db),
        readStudyPlans: async (quarterId) => await readStudyPlans(db, undefined, quarterId),
    });
    await registerTeacherLoadApi(app, {
        db, getSession, readCatalog: async () => await readCatalog(db), readQuarters: async () => await readQuarters(db),
        readCalendar: async () => await readSchoolCalendar(db),
        readSchedule: async (catalog, dates, groupIds) => await readSchedule(db, catalog, dates, groupIds),
        readPublishedQuarter: async (id) => await readPublishedQuarter(db, id),
    });
    await registerBulkApi(app, {
        db, getSession, isSameOrigin,
        readState: async (options) => await adminState(db, { view: "operation", ...options }),
        commit: async (before, next, revision, requestId) => await commitScopedSchedule(db, before.schedule, next, revision, requestId),
    });
    const generationControl = await registerGenerationApi(app, {
        db, getSession, isSameOrigin,
        readState: async (quarterId) => await adminState(db, { view: "operation", quarterId, includePlans: true }),
        commit: async (before, next, revision, requestId) => await commitScopedSchedule(db, before, next, revision, requestId),
    });
    await registerDataTransferApi(app, {
        db,
        service: db.dialect === "postgres" ? new SchoolArchiveService(databaseUrl!, { backupDirectory: options.archiveBackupDirectory ?? resolve("backups/restore") }) : undefined,
        gate: maintenance,
        getSession, isSameOrigin,
        sessionKey: (request) => hash(request.cookies[COOKIE_NAME] ?? ""),
        setCookie: (reply, token, secure) => { reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "strict", path: cookiePath, secure, maxAge: Math.floor(SESSION_MS / 1000) }); },
        drainGenerationWrites: () => generationControl.drainWrites(),
        beforeWrite: options.archiveBeforeWrite,
        onRestored: () => {
            resetSchemaCapabilities(db);
            reassignmentPreviews.clear();
            publicProjectionIndexCache.clear();
            printPublishedIndexCache.clear();
            publicStudentScheduleCache = undefined;
            publicStudentsDayCache = undefined;
            publicStudentsWeekCache = undefined;
            publicTeachersDayCache = undefined;
            publicTeachersWeekCache = undefined;
            publicTeacherScheduleCache = undefined;
        },
    });
    const pageState = async (request: FastifyRequest, view: AdminStateOptions["view"], quarterId?: string) => (request.query as {
        response?: string;
    })?.response === "compact" ? await adminState(db, { view, quarterId }) : await fullState(db);
    app.get<{
        Querystring: {
            view?: string;
            quarterId?: string;
        };
    }>("/api/admin/state", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const view = request.query.view;
        if (!["catalog", "plans", "calendar", "bells", "print", "bootstrap"].includes(view ?? ""))
            return reply.code(400).send({ error: "Некорректный раздел" });
        if (request.query.quarterId && !(await readQuarters(db)).some((quarter) => quarter.id === request.query.quarterId))
            return reply.code(404).send({ error: "Четверть не найдена" });
        reply.header("cache-control", "no-store");
        const today = new Date().toISOString().slice(0, 10);
        const quarterId = request.query.quarterId ?? (view === "plans" ?
            (visibleQuarters(await readQuarters(db)).find((quarter) => inQuarter(today, quarter)) ?? visibleQuarters(await readQuarters(db))[0])?.id : undefined);
        return await adminState(db, { view: view as AdminStateOptions["view"], quarterId });
    });
    app.get<{
        Querystring: {
            kind?: string;
            id?: string;
        };
    }>("/api/catalog/blockers", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const kind = request.query.kind;
        if (!["subjects", "teachers", "rooms", "groups", "subgroups"].includes(kind ?? "") || !validText(request.query.id, 120))
            return reply.code(400).send({ error: "Некорректная запись" });
        const blockers = await catalogDeletionBlockers(db);
        reply.header("cache-control", "no-store");
        return { blockers: blockers[kind as keyof Catalog]?.[request.query.id!] ?? [] };
    });
    app.post<{
        Body: {
            kind?: unknown;
            resourceId?: unknown;
            rules?: unknown;
            revision?: unknown;
        };
    }>("/api/catalog/availability-preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || (body.kind !== "teacher" && body.kind !== "room") || !validText(body.resourceId, 120) || validateUnavailabilityRules(body.rules))
            return reply.code(400).send({ error: "Некорректная недоступность" });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (body.revision !== meta.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите справочники" });
        const catalog = await readCatalog(db);
        const rows = body.kind === "teacher" ? catalog.teachers : catalog.rooms;
        const resource = rows.find((entry) => entry.id === body.resourceId);
        if (!resource)
            return reply.code(404).send({ error: "Запись не найдена" });
        resource.unavailability = body.rules as NonNullable<typeof resource.unavailability>;
        const schedule = await readSchedule(db, catalog, undefined, undefined, { kind: body.kind, id: body.resourceId });
        const lessons = new Map(locatedLessons(schedule).map((entry) => [entry.lesson.id, entry.lesson]));
        const groups = new Map(catalog.groups.map((entry) => [entry.id, entry.name]));
        const subjects = new Map(catalog.subjects.map((entry) => [entry.id, entry.name]));
        const violations = scheduledUnavailability(schedule, catalog).filter((entry) => entry.kind === body.kind && entry.resourceId === body.resourceId)
            .map((entry) => ({ ...entry, groupName: groups.get(entry.groupId) ?? entry.groupId, subjectName: subjects.get(lessons.get(entry.lessonId)?.subjectId ?? "") ?? "Мероприятие" }));
        reply.header("cache-control", "no-store");
        return { revision: meta.revision, violations };
    });
    app.get("/api/health", async () => ({ ok: true }));
    type PublishedProjectionRow = {
        quarter_id: string;
        version: number;
        published_at: string;
        start_date: string;
        end_date: string;
        print_index_json: string;
    };
    const publishedProjectionRows = async (): Promise<PublishedProjectionRow[]> => {
        const rows = await db.prepare("SELECT p.quarter_id,p.version,p.published_at,p.print_index_json,q.start_date,q.end_date FROM published_quarters p JOIN quarters q ON q.id=p.quarter_id WHERE q.archived=0 ORDER BY p.quarter_id").all() as Array<{
            quarter_id: string;
            version: number;
            published_at: string;
            print_index_json: string;
            start_date: string;
            end_date: string;
        }>;
        for (const row of rows) {
            if (row.print_index_json) {
                const publishedQuarter = readPublicationPrintIndex(row.print_index_json).quarter;
                row.start_date = publishedQuarter.startDate;
                row.end_date = publishedQuarter.endDate;
            }
        }
        rows.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.quarter_id.localeCompare(b.quarter_id));
        const present = new Set(rows.map((row) => row.quarter_id));
        for (const quarterId of publicProjectionIndexCache.keys())
            if (!present.has(quarterId))
                publicProjectionIndexCache.delete(quarterId);
        return rows;
    };
    const publicationKey = (row: PublishedProjectionRow) => `${row.version}\0${row.published_at}`;
    const publishedSnapshot = async (row: PublishedProjectionRow): Promise<ReturnType<typeof createPublicationSnapshot>> => {
        const published = await db.prepare("SELECT snapshot_json FROM published_quarters WHERE quarter_id=? AND version=? AND published_at=?")
            .get(row.quarter_id, row.version, row.published_at) as {
            snapshot_json: string;
        } | undefined;
        if (!published)
            throw new Error("Опубликованное расписание изменилось во время чтения");
        return JSON.parse(published.snapshot_json) as ReturnType<typeof createPublicationSnapshot>;
    };
    function publicIndex(kind: "students"): Promise<PublicStudentsIndex["quarters"]>;
    function publicIndex(kind: "teachers"): Promise<PublicTeachersIndex["quarters"]>;
    async function publicIndex(kind: "students" | "teachers"): Promise<PublicStudentsIndex["quarters"] | PublicTeachersIndex["quarters"]> {
        const rows = await publishedProjectionRows();
        const quarters = (await Promise.all(rows.map(async (row) => {
            const key = publicationKey(row);
            let cached = publicProjectionIndexCache.get(row.quarter_id);
            if (cached?.key !== key)
                cached = { key };
            if (kind === "students" && !cached.studentsQuarter) {
                const projection = projectPublicStudents(await publishedSnapshot(row), { version: row.version, publishedAt: row.published_at });
                cached = { ...cached, studentsQuarter: projection.quarter };
            }
            else if (kind === "teachers" && !cached.teachersQuarter) {
                const projection = projectPublicTeachers(await publishedSnapshot(row), { version: row.version, publishedAt: row.published_at });
                cached = { ...cached, teachersQuarter: projection.quarter };
            }
            publicProjectionIndexCache.set(row.quarter_id, cached);
            const quarter = kind === "students" ? cached.studentsQuarter : cached.teachersQuarter;
            return quarter ? [quarter] : [];
        }))).flat();
        const sorted = quarters.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
        return kind === "students"
            ? sorted as PublicStudentsIndex["quarters"]
            : sorted as PublicTeachersIndex["quarters"];
    }
    const publicScheduleProjection = async (kind: "students" | "teachers", quarterId: string, targetId: string, row: PublishedProjectionRow) => {
        const key = publicationKey(row);
        if (kind === "students" && publicStudentScheduleCache?.quarterId === quarterId && publicStudentScheduleCache.targetId === targetId && publicStudentScheduleCache.key === key)
            return publicStudentScheduleCache.projection;
        if (kind === "teachers" && publicTeacherScheduleCache?.quarterId === quarterId && publicTeacherScheduleCache.targetId === targetId && publicTeacherScheduleCache.key === key)
            return publicTeacherScheduleCache.projection;
        const snapshot = await publishedSnapshot(row);
        const publication = { version: row.version, publishedAt: row.published_at };
        if (kind === "students") {
            const selectedSnapshot = printSnapshotSlice(snapshot, [targetId], snapshot.quarter.startDate, snapshot.quarter.endDate);
            const projection = projectPublicStudents(selectedSnapshot, publication);
            publicStudentScheduleCache = { quarterId, targetId, key, projection };
            return projection;
        }
        const selectedSnapshot = teacherSnapshotSlice(snapshot, targetId);
        const projection = projectPublicTeachers(selectedSnapshot, publication);
        publicTeacherScheduleCache = { quarterId, targetId, key, projection };
        return projection;
    };
    app.get("/api/public/students", async (_request, reply): Promise<PublicStudentsIndex> => {
        reply.header("cache-control", "no-store");
        return { quarters: await publicIndex("students") };
    });
    app.get<{ Querystring: { date?: string; nextStudyDay?: string } }>("/api/public/students/day", async (request, reply): Promise<PublicStudentsDaySchedule | unknown> => {
        const requestedDate = request.query.date;
        if (!requestedDate || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !Number.isFinite(Date.parse(`${requestedDate}T00:00:00Z`)) || new Date(`${requestedDate}T00:00:00Z`).toISOString().slice(0, 10) !== requestedDate)
            return reply.code(400).send({ error: "Укажите корректную дату в формате YYYY-MM-DD" });
        if (request.query.nextStudyDay !== undefined && request.query.nextStudyDay !== "true" && request.query.nextStudyDay !== "false")
            return reply.code(400).send({ error: "Некорректный параметр nextStudyDay" });
        const nextStudyDay = request.query.nextStudyDay === "true";
        const rows = await publishedProjectionRows();
        const signature = rows.map((row) => `${row.quarter_id}:${publicationKey(row)}`).join("|");
        const cacheKey = `${requestedDate}\0${nextStudyDay}`;
        if (publicStudentsDayCache?.key === cacheKey && publicStudentsDayCache.signature === signature) {
            reply.header("cache-control", "no-store");
            return publicStudentsDayCache.value;
        }
        let selectedDate = requestedDate;
        const selectedRow = rows.find((row) => requestedDate >= row.start_date && requestedDate <= row.end_date);
        let selected: { row: PublishedProjectionRow; snapshot: Awaited<ReturnType<typeof publishedSnapshot>> } | undefined;
        if (selectedRow) selected = { row: selectedRow, snapshot: await publishedSnapshot(selectedRow) };
        if (nextStudyDay) {
            for (const row of rows) {
                if (row.end_date < requestedDate) continue;
                const snapshot = selected?.row.quarter_id === row.quarter_id ? selected.snapshot : await publishedSnapshot(row);
                const groupById = new Map(snapshot.catalog.groups.map((group) => [group.id, group]));
                const candidates = [...new Set(Object.values(snapshot.schedule).flatMap((days) => days
                    .filter((day) => day.date >= requestedDate && day.slots.some((slot) => slot.length)).map((day) => day.date)))].sort();
                let found: string | undefined;
                for (const date of candidates) {
                    const hasTeachingLessons = Object.entries(snapshot.schedule).some(([key, days]) => {
                        const groupId = key.slice(0, key.lastIndexOf(":"));
                        const group = groupById.get(groupId);
                        const day = days.find((entry) => entry.date === date);
                        if (!group || !day || !day.slots.some((slot) => slot.length)) return false;
                        const stored = snapshot.calendar ? calendarDay(snapshot.calendar, groupId, date) : { holiday: false, kind: "regular" as const };
                        return !(stored.kind === "study" ? false : Boolean(stored.holiday || (day.holiday && stored.kind === "regular")));
                    });
                    if (hasTeachingLessons) { found = date; break; }
                }
                if (found) { selectedDate = found; selected = { row, snapshot }; break; }
            }
        }
        const groups: PublicStudentsDaySchedule["groups"] = [];
        if (selected) {
            const slicedSchedule: typeof selected.snapshot.schedule = {};
            for (const [key, days] of Object.entries(selected.snapshot.schedule)) {
                const match = days.filter((day) => day.date === selectedDate);
                if (match.length) slicedSchedule[key] = match;
            }
            const projection = projectPublicStudents({ ...selected.snapshot, schedule: slicedSchedule }, { version: selected.row.version, publishedAt: selected.row.published_at });
            for (const group of projection.quarter.groups) {
                const day = projection.schedules.get(group.id)?.days[0];
                groups.push({ id: group.id, name: group.name, ...(day ? { day } : {}) });
            }
        }
        const value = { requestedDate, date: selectedDate, hasPublications: rows.length > 0, groups };
        publicStudentsDayCache = { key: cacheKey, signature, value };
        reply.header("cache-control", "no-store");
        return value;
    });
    app.get<{ Querystring: { quarterId?: string; weekStart?: string } }>("/api/public/students/week", async (request, reply): Promise<PublicStudentsWeekSchedule | unknown> => {
        const { quarterId, weekStart } = request.query;
        const isIsoDate = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
        if (!validText(quarterId, 120) || !quarterId || !isIsoDate(weekStart) || new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1)
            return reply.code(400).send({ error: "Укажите четверть и понедельник недели в формате YYYY-MM-DD" });
        const end = new Date(`${weekStart}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 6);
        const weekEnd = end.toISOString().slice(0, 10);
        const row = (await publishedProjectionRows()).find((item) => item.quarter_id === quarterId);
        if (!row)
            return reply.code(404).send({ error: "Опубликованное расписание не найдено" });
        const key = `${quarterId}\0${weekStart}\0${publicationKey(row)}`;
        if (publicStudentsWeekCache?.key === key) {
            reply.header("cache-control", "no-store");
            return publicStudentsWeekCache.value;
        }
        const snapshot = await publishedSnapshot(row);
        if (weekEnd < snapshot.quarter.startDate || weekStart > snapshot.quarter.endDate)
            return reply.code(400).send({ error: "Неделя не пересекается с четвертью" });
        const publicGroupIds = new Set(snapshot.catalog.groups.filter((group) => !group.archived).map((group) => group.id));
        for (const [scheduleKey, days] of Object.entries(snapshot.schedule)) {
            const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
            if (days.some((day) => day.slots.some((slot, index) => Boolean(day.times[index] && slot.length))))
                publicGroupIds.add(groupId);
        }
        const publicGroups = snapshot.catalog.groups
            .filter((group) => publicGroupIds.has(group.id))
            .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id, "ru", { numeric: true }));
        const slicedSchedule = printSnapshotSlice(snapshot, [...publicGroupIds], weekStart, weekEnd).schedule;
        const projection = projectPublicStudents({ ...snapshot, schedule: slicedSchedule }, { version: row.version, publishedAt: row.published_at });
        const value: PublicStudentsWeekSchedule = {
            quarter: {
                id: snapshot.quarter.id,
                name: snapshot.quarter.name,
                startDate: snapshot.quarter.startDate,
                endDate: snapshot.quarter.endDate,
                ...(snapshot.quarter.archived !== undefined ? { archived: snapshot.quarter.archived } : {}),
            },
            publication: { version: row.version, publishedAt: row.published_at },
            weekStart,
            weekEnd,
            groups: publicGroups.map((group) => ({ id: group.id, name: group.name, days: projection.schedules.get(group.id)?.days ?? [] })),
        };
        publicStudentsWeekCache = { key, value };
        reply.header("cache-control", "no-store");
        return value;
    });
    app.get<{
        Querystring: {
            quarterId?: string;
            groupId?: string;
        };
    }>("/api/public/students/schedule", async (request, reply): Promise<PublicStudentSchedule | unknown> => {
        const { quarterId, groupId } = request.query;
        if (!validText(quarterId, 120) || !quarterId || !validText(groupId, 120) || !groupId)
            return reply.code(400).send({ error: "Укажите четверть и класс" });
        const row = (await publishedProjectionRows()).find((item) => item.quarter_id === quarterId);
        if (!row)
            return reply.code(404).send({ error: "Опубликованное расписание не найдено" });
        const projection = await publicScheduleProjection("students", quarterId, groupId, row);
        const schedule = projection.schedules.get(groupId);
        if (!schedule)
            return reply.code(404).send({ error: "Класс не найден в опубликованном расписании" });
        reply.header("cache-control", "no-store");
        return schedule;
    });
    app.get("/api/public/teachers", async (_request, reply): Promise<PublicTeachersIndex> => {
        reply.header("cache-control", "no-store");
        return { quarters: await publicIndex("teachers") };
    });
    app.get<{ Querystring: { date?: string; nextStudyDay?: string } }>("/api/public/teachers/day", async (request, reply): Promise<PublicTeachersDaySchedule | unknown> => {
        const requestedDate = request.query.date;
        const isIsoDate = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
        if (!isIsoDate(requestedDate)) return reply.code(400).send({ error: "Укажите корректную дату в формате YYYY-MM-DD" });
        if (request.query.nextStudyDay !== undefined && request.query.nextStudyDay !== "true" && request.query.nextStudyDay !== "false")
            return reply.code(400).send({ error: "Некорректный параметр nextStudyDay" });
        const rows = await publishedProjectionRows();
        const signature = rows.map((row) => `${row.quarter_id}:${publicationKey(row)}`).join("|");
        const nextStudyDay = request.query.nextStudyDay === "true";
        const cacheKey = `${requestedDate}\0${nextStudyDay}`;
        if (publicTeachersDayCache?.key === cacheKey && publicTeachersDayCache.signature === signature) {
            reply.header("cache-control", "no-store");
            return publicTeachersDayCache.value;
        }
        let date = requestedDate;
        let selected: { row: PublishedProjectionRow; snapshot: Awaited<ReturnType<typeof publishedSnapshot>> } | undefined;
        const containing = rows.find((row) => date >= row.start_date && date <= row.end_date);
        if (containing) selected = { row: containing, snapshot: await publishedSnapshot(containing) };
        if (nextStudyDay) {
            outer: for (const row of rows) {
                if (row.end_date < requestedDate) continue;
                const snapshot: Awaited<ReturnType<typeof publishedSnapshot>> = await publishedSnapshot(row);
                const catalogGroups = new Map(snapshot.catalog.groups.map((group) => [group.id, group]));
                const teacherIds = new Set(snapshot.catalog.teachers.map((teacher) => teacher.id));
                const candidates = [...new Set(Object.entries(snapshot.schedule).flatMap(([key, days]) => {
                    const groupId = key.slice(0, key.lastIndexOf(":"));
                    return days.filter((day) => day.date >= requestedDate && day.date >= snapshot.quarter.startDate && day.date <= snapshot.quarter.endDate &&
                        day.slots.some((slot, index) => Boolean(day.times[index] && slot.some((lesson) => lesson.teacherId && teacherIds.has(lesson.teacherId))))
                    ).map((day) => day.date).map((candidate) => `${groupId}\0${candidate}`);
                }))].map((value) => value.split("\0")).sort((a, b) => a[1]!.localeCompare(b[1]!));
                for (const [groupId, candidateDate] of candidates) {
                    const group = catalogGroups.get(groupId!);
                    if (!group) continue;
                    const day = snapshot.schedule[`${groupId}:0`]?.find((entry) => entry.date === candidateDate)
                        ?? Object.entries(snapshot.schedule).filter(([key]) => key.slice(0, key.lastIndexOf(":")) === groupId).flatMap(([, days]) => days).find((entry) => entry.date === candidateDate);
                    const calendar = snapshot.calendar ?? defaultSchoolCalendar();
                    const status = calendarDay(calendar, groupId!, candidateDate!);
                    const hasLessons = Object.entries(snapshot.schedule).some(([key, days]) =>
                        key.slice(0, key.lastIndexOf(":")) === groupId && days.some((entry) =>
                            entry.date === candidateDate && entry.slots.some((slot, index) =>
                                Boolean(entry.times[index] && slot.some((lesson) => lesson.teacherId && teacherIds.has(lesson.teacherId))))));
                    if (!day || !hasLessons || (status.kind !== "study" && (status.holiday || (day.holiday && status.kind === "regular")))) continue;
                    date = candidateDate!;
                    selected = { row, snapshot };
                    break outer;
                }
            }
        }
        let teachers: PublicTeachersDaySchedule["teachers"] = [];
        if (selected) {
            const projection = projectPublicTeachers(selected.snapshot, { version: selected.row.version, publishedAt: selected.row.published_at }, { startDate: date, endDate: date });
            teachers = projection.quarter.teachers.map((teacher) => ({ id: teacher.id, name: teacher.name, ...(projection.schedules.get(teacher.id)?.days[0] ? { day: projection.schedules.get(teacher.id)!.days[0] } : {}) }));
        }
        const value: PublicTeachersDaySchedule = { requestedDate, date, hasPublications: rows.length > 0, teachers };
        publicTeachersDayCache = { key: cacheKey, signature, value };
        reply.header("cache-control", "no-store");
        return value;
    });
    app.get<{ Querystring: { quarterId?: string; weekStart?: string } }>("/api/public/teachers/week", async (request, reply): Promise<PublicTeachersWeekSchedule | unknown> => {
        const { quarterId, weekStart } = request.query;
        const isIsoDate = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
        if (!validText(quarterId, 120) || !quarterId || !isIsoDate(weekStart) || new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1)
            return reply.code(400).send({ error: "Укажите четверть и понедельник недели в формате YYYY-MM-DD" });
        const weekEndDate = new Date(`${weekStart}T00:00:00Z`);
        weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
        if (!Number.isFinite(weekEndDate.getTime()) || weekEndDate.getUTCFullYear() > 9999)
            return reply.code(400).send({ error: "Недопустимая граница недели" });
        const weekEnd = weekEndDate.toISOString().slice(0, 10);
        const row = (await publishedProjectionRows()).find((item) => item.quarter_id === quarterId);
        if (!row) return reply.code(404).send({ error: "Опубликованное расписание не найдено" });
        const key = `${quarterId}\0${weekStart}\0${publicationKey(row)}`;
        if (publicTeachersWeekCache?.key === key) {
            reply.header("cache-control", "no-store");
            return publicTeachersWeekCache.value;
        }
        const snapshot = await publishedSnapshot(row);
        if (weekEnd < snapshot.quarter.startDate || weekStart > snapshot.quarter.endDate)
            return reply.code(400).send({ error: "Неделя не пересекается с четвертью" });
        const from = weekStart < snapshot.quarter.startDate ? snapshot.quarter.startDate : weekStart;
        const through = weekEnd > snapshot.quarter.endDate ? snapshot.quarter.endDate : weekEnd;
        const projection = projectPublicTeachers(snapshot, { version: row.version, publishedAt: row.published_at }, { startDate: from, endDate: through });
        const value: PublicTeachersWeekSchedule = {
            quarter: { ...snapshot.quarter }, publication: { version: row.version, publishedAt: row.published_at }, weekStart, weekEnd,
            teachers: projection.quarter.teachers.map((teacher) => ({ id: teacher.id, name: teacher.name, days: projection.schedules.get(teacher.id)?.days ?? [] })),
        };
        publicTeachersWeekCache = { key, value };
        reply.header("cache-control", "no-store");
        return value;
    });
    app.get<{
        Querystring: {
            quarterId?: string;
            teacherId?: string;
        };
    }>("/api/public/teachers/schedule", async (request, reply): Promise<PublicTeacherSchedule | unknown> => {
        const { quarterId, teacherId } = request.query;
        if (!validText(quarterId, 120) || !quarterId || !validText(teacherId, 120) || !teacherId)
            return reply.code(400).send({ error: "Укажите четверть и преподавателя" });
        const row = (await publishedProjectionRows()).find((item) => item.quarter_id === quarterId);
        if (!row)
            return reply.code(404).send({ error: "Опубликованное расписание не найдено" });
        const projection = await publicScheduleProjection("teachers", quarterId, teacherId, row);
        const schedule = projection.schedules.get(teacherId);
        if (!schedule)
            return reply.code(404).send({ error: "Преподаватель не найден в опубликованном расписании" });
        reply.header("cache-control", "no-store");
        return schedule;
    });
    app.get("/api/public/display-settings", async (_request, reply) => {
        const { settings } = await readDisplaySettings(db);
        reply.header("cache-control", "no-store");
        return { schoolName: settings.schoolName, studentSubjectIcons: settings.studentSubjectIcons };
    });
    app.get("/api/display-settings", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        reply.header("cache-control", "no-store");
        return await readDisplaySettings(db);
    });
    app.put<{
        Body: {
            settings?: unknown;
            revision?: unknown;
            requestId?: unknown;
        };
    }>("/api/display-settings", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) ||
            !isRecord(body.settings) || typeof body.settings.adminSubjectIcons !== "boolean" ||
            typeof body.settings.studentSubjectIcons !== "boolean" ||
            (body.settings.schoolName !== undefined &&
                (typeof body.settings.schoolName !== "string" || body.settings.schoolName.trim().length > 200)))
            return reply.code(400).send({ error: "Некорректные общие настройки" });
        const current = await readDisplaySettings(db);
        const hasSchoolName = Object.hasOwn(body.settings, "schoolName");
        const settings = {
            adminSubjectIcons: body.settings.adminSubjectIcons,
            studentSubjectIcons: body.settings.studentSubjectIcons,
            schoolName: hasSchoolName ? (body.settings.schoolName as string).trim() : current.settings.schoolName,
        } satisfies DisplaySettings;
        const revision = Number(body.revision);
        const requestId = body.requestId;
        // Keep the old fingerprint shape for requests from clients predating schoolName.
        const fingerprint = hash(JSON.stringify(hasSchoolName
            ? { revision, settings }
            : { revision, settings: { adminSubjectIcons: settings.adminSubjectIcons, studentSubjectIcons: settings.studentSubjectIcons } }));
        try {
            const result = await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint,response_json FROM school_display_setting_replays WHERE request_id=?")
                    .get(requestId) as {
                    fingerprint: string;
                    response_json: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("display-settings-idempotency-conflict");
                    return await readDisplaySettings(db);
                }
                const latest = await readDisplaySettings(db);
                if (latest.revision !== revision)
                    throw new Error("display-settings-revision-conflict");
                const nextSettings = hasSchoolName ? settings : { ...settings, schoolName: latest.settings.schoolName };
                const response = { settings: nextSettings, revision: latest.revision + 1 };
                await db.prepare("UPDATE school_display_settings SET settings_json=?,revision=? WHERE id=1")
                    .run(JSON.stringify(nextSettings), response.revision);
                await db.prepare("INSERT INTO school_display_setting_replays(request_id,fingerprint,response_json) VALUES(?,?,?)")
                    .run(requestId, fingerprint, JSON.stringify(response));
                return response;
            })();
            reply.header("cache-control", "no-store");
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof Error && error.message === "display-settings-revision-conflict")
                return reply.code(409).send({ error: "Общие настройки уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "display-settings-idempotency-conflict")
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
    });
    app.get("/api/auth/status", async (request) => await authStatus(request));
    app.post<{
        Body: AuthBody;
    }>("/api/auth/setup", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const username = typeof request.body?.username === "string"
            ? request.body.username.trim()
            : "";
        const password = typeof request.body?.password === "string" ? request.body.password : "";
        if (username.length < 2 ||
            username.length > 80 ||
            password.length < 8 ||
            password.length > 128)
            return reply.code(400).send({
                error: "Проверьте имя пользователя и пароль (от 8 до 128 символов)",
            });
        const passwordHash = await hashPassword(password);
        const token = randomToken();
        const csrfToken = randomToken(24);
        const expiresAt = Date.now() + SESSION_MS;
        const createdAt = nowIso();
        try {
            await db.transaction(async () => {
                if (await db.prepare("SELECT 1 FROM admin_users LIMIT 1").get())
                    throw new Error("setup-complete");
                await db.prepare("INSERT INTO admin_users(id, username, password_hash, created_at) VALUES(1, ?, ?, ?)").run(username, passwordHash, createdAt);
                await db.prepare("INSERT INTO sessions(token_hash, csrf_token, expires_at, username) VALUES(?, ?, ?, ?)").run(hash(token), csrfToken, expiresAt, username);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "setup-complete")
                return reply
                    .code(409)
                    .send({ error: "Первоначальная настройка уже выполнена" });
            throw error;
        }
        reply.setCookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: "strict",
            path: cookiePath,
            secure: request.protocol === "https",
            maxAge: Math.floor(SESSION_MS / 1000),
        });
        return reply.send({
            needsSetup: false,
            authenticated: true,
            username,
            csrfToken,
        });
    });
    app.post<{
        Body: AuthBody;
    }>("/api/auth/login", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const ip = request.ip;
        const current = failureWindow.get(ip);
        if (current &&
            current.since + 15 * 60 * 1000 > Date.now() &&
            current.count >= 10)
            return reply
                .code(429)
                .send({ error: "Слишком много попыток. Попробуйте позже" });
        const username = typeof request.body?.username === "string"
            ? request.body.username.trim()
            : "";
        const password = typeof request.body?.password === "string" ? request.body.password : "";
        const user = await db
            .prepare("SELECT username, password_hash FROM admin_users WHERE username = ?")
            .get(username) as {
            username: string;
            password_hash: string;
        } | undefined;
        const ok = user
            ? await verifyPassword(password, user.password_hash)
            : false;
        if (!user || !ok) {
            if (!current || current.since + 15 * 60 * 1000 <= Date.now())
                failureWindow.set(ip, { count: 1, since: Date.now() });
            else
                current.count += 1;
            return reply
                .code(401)
                .send({ error: "Неверное имя пользователя или пароль" });
        }
        failureWindow.delete(ip);
        const token = randomToken();
        const csrfToken = randomToken(24);
        const expiresAt = Date.now() + SESSION_MS;
        await db.prepare("INSERT INTO sessions(token_hash, csrf_token, expires_at, username) VALUES(?, ?, ?, ?)").run(hash(token), csrfToken, expiresAt, user.username);
        reply.setCookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: "strict",
            path: cookiePath,
            secure: request.protocol === "https",
            maxAge: Math.floor(SESSION_MS / 1000),
        });
        return reply.send({
            needsSetup: false,
            authenticated: true,
            username: user.username,
            csrfToken,
        });
    });
    app.post("/api/auth/logout", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const token = request.cookies[COOKIE_NAME];
        if (token)
            await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
        reply.clearCookie(COOKIE_NAME, {
            path: cookiePath,
            sameSite: "strict",
            secure: request.protocol === "https",
        });
        return reply.send({ authenticated: false });
    });
    const printSnapshotSlice = (snapshot: ReturnType<typeof createPublicationSnapshot>, groupIds: string[], weekStart: string, weekEnd: string): ReturnType<typeof createPublicationSnapshot> => {
        const selected = new Set(groupIds);
        const from = weekStart < snapshot.quarter.startDate ? snapshot.quarter.startDate : weekStart;
        const through = weekEnd > snapshot.quarter.endDate ? snapshot.quarter.endDate : weekEnd;
        const occurrence = (day: (typeof snapshot.schedule)[string][number]) => day.slots.flatMap((slot, index) => {
            const time = day.times[index];
            return time ? slot.filter((lesson) => lesson.jointId).map((lesson) => `${lesson.jointId}\0${day.date}\0${time.start}\0${time.duration}`) : [];
        });
        const jointOccurrences = new Set<string>();
        for (const [key, days] of Object.entries(snapshot.schedule)) {
            const groupId = key.slice(0, key.lastIndexOf(":"));
            if (!selected.has(groupId))
                continue;
            for (const day of days)
                if (day.date >= from && day.date <= through)
                    for (const token of occurrence(day))
                        jointOccurrences.add(token);
        }
        const schedule: typeof snapshot.schedule = {};
        for (const [key, days] of Object.entries(snapshot.schedule)) {
            const groupId = key.slice(0, key.lastIndexOf(":"));
            const selectedGroup = selected.has(groupId);
            const matchingDays = days.filter((day) => day.date >= from && day.date <= through &&
                (selectedGroup || occurrence(day).some((token) => jointOccurrences.has(token))));
            if (matchingDays.length)
                schedule[key] = matchingDays;
        }
        return { ...snapshot, schedule };
    };
    const teacherSnapshotSlice = (snapshot: ReturnType<typeof createPublicationSnapshot>, teacherId: string): ReturnType<typeof createPublicationSnapshot> => {
        const assignedGroups = new Set<string>();
        for (const [key, days] of Object.entries(snapshot.schedule)) {
            const groupId = key.slice(0, key.lastIndexOf(":"));
            if (days.some((day) => day.date >= snapshot.quarter.startDate && day.date <= snapshot.quarter.endDate &&
                day.slots.some((slot) => slot.some((lesson) => lesson.teacherId === teacherId))))
                assignedGroups.add(groupId);
        }
        const schedule: typeof snapshot.schedule = {};
        for (const [key, days] of Object.entries(snapshot.schedule)) {
            const groupId = key.slice(0, key.lastIndexOf(":"));
            if (!assignedGroups.has(groupId))
                continue;
            const selectedDays = days.filter((day) => day.date >= snapshot.quarter.startDate && day.date <= snapshot.quarter.endDate);
            if (selectedDays.length)
                schedule[key] = selectedDays;
        }
        return { ...snapshot, schedule };
    };
    app.get("/api/schedule-print/index", async (request, reply): Promise<SchedulePrintIndex | unknown> => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        reply.header("cache-control", "no-store");
        return await db.readTransaction(async () => {
            const revision = (await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                revision: number;
            }).revision;
            const quarters = await readQuarters(db);
            const activeGroups = (await readCatalog(db)).groups.filter((group) => !group.archived)
                .map(({ id, name }) => ({ id, name }))
                .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
            const draft = visibleQuarters(quarters).map((quarter) => ({ ...quarter, groups: activeGroups }));
            const rows = await db.prepare("SELECT p.quarter_id,p.version,p.published_at,p.print_index_json,q.start_date,q.end_date FROM published_quarters p JOIN quarters q ON q.id=p.quarter_id WHERE q.archived=0 ORDER BY p.quarter_id")
                .all() as Array<{
                quarter_id: string;
                version: number;
                published_at: string;
                print_index_json: string;
                start_date: string;
                end_date: string;
            }>;
            const present = new Set(rows.map((row) => row.quarter_id));
            for (const quarterId of printPublishedIndexCache.keys())
                if (!present.has(quarterId))
                    printPublishedIndexCache.delete(quarterId);
            const published = (await Promise.all(rows.map(async (row) => {
                const key = `${publicationKey(row)}\0${row.print_index_json}`;
                const cached = printPublishedIndexCache.get(row.quarter_id);
                if (cached?.key === key)
                    return [cached.quarter];
                const index = readPublicationPrintIndex(row.print_index_json);
                const quarter = {
                    ...index.quarter,
                    publication: { version: row.version, publishedAt: row.published_at },
                    groups: index.groups,
                } satisfies SchedulePrintIndex["published"][number];
                printPublishedIndexCache.set(row.quarter_id, { key, quarter });
                return [quarter];
            }))).flat();
            return { revision, published, draft };
        });
    });
    app.post<{
        Body: SchedulePrintPreviewRequest | unknown;
    }>("/api/schedule-print/preview", async (request, reply): Promise<SchedulePrintPreview | unknown> => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || (body.source !== "published" && body.source !== "draft") ||
            !validText(body.quarterId, 120) || !body.quarterId || !validDate(body.weekStart) ||
            !Array.isArray(body.groupIds) || body.groupIds.length < 1 || body.groupIds.length > 1000 ||
            body.groupIds.some((id) => !validText(id, 120)) || new Set(body.groupIds).size !== body.groupIds.length)
            return reply.code(400).send({ error: "Некорректный запрос печати" });
        const source = body.source as SchedulePrintSource;
        const weekStart = body.weekStart as string;
        const monday = new Date(`${weekStart}T00:00:00.000Z`);
        if (monday.getUTCDay() !== 1)
            return reply.code(400).send({ error: "Неделя должна начинаться в понедельник" });
        const weekEndDate = new Date(monday);
        weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
        const weekEnd = weekEndDate.toISOString().slice(0, 10);
        reply.header("cache-control", "no-store");
        try {
            const result = await db.readTransaction(async () => {
                let snapshot: ReturnType<typeof createPublicationSnapshot>;
                let publication: {
                    version: number;
                    publishedAt: string;
                } | undefined;
                let draftRevision: number | undefined;
                if (source === "published") {
                    if (!Number.isInteger(body.version) || Number(body.version) < 1)
                        return { error: 400, message: "Укажите версию публикации" };
                    const row = await db.prepare("SELECT version,published_at,snapshot_json FROM published_quarters WHERE quarter_id=?")
                        .get(body.quarterId) as {
                        version: number;
                        published_at: string;
                        snapshot_json: string;
                    } | undefined;
                    if (!row)
                        return { error: 404, message: "Опубликованное расписание не найдено" };
                    if (row.version !== body.version)
                        return { error: 409, message: "Публикация изменилась. Обновите список" };
                    snapshot = JSON.parse(row.snapshot_json) as ReturnType<typeof createPublicationSnapshot>;
                    publication = { version: row.version, publishedAt: row.published_at };
                }
                else {
                    if (!Number.isInteger(body.revision) || Number(body.revision) < 0)
                        return { error: 400, message: "Укажите версию черновика" };
                    const meta = await db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get() as {
                        revision: number;
                        updated_at: string;
                    };
                    if (meta.revision !== body.revision)
                        return { error: 409, message: "Черновик изменился. Обновите список" };
                    const quarter = (await readQuarters(db)).find((entry) => entry.id === body.quarterId);
                    if (!quarter)
                        return { error: 404, message: "Четверть не найдена" };
                    if (weekStart > quarter.endDate || weekEnd < quarter.startDate)
                        return { error: 400, message: "Неделя не пересекается с четвертью" };
                    const groupIds = body.groupIds as string[];
                    const dates: string[] = [];
                    const cursor = new Date(`${weekStart}T00:00:00.000Z`);
                    for (let day = 0; day < 7; day += 1) {
                        const date = cursor.toISOString().slice(0, 10);
                        if (date >= quarter.startDate && date <= quarter.endDate)
                            dates.push(date);
                        cursor.setUTCDate(cursor.getUTCDate() + 1);
                    }
                    let state = await adminState(db, { view: "print", dates, groupIds, quarterId: quarter.id, includePlans: true });
                    const jointIds = [...new Set(Object.values(state.schedule).flat().flatMap((day) => day.slots.flatMap((slot) => slot.flatMap((lesson) => lesson.jointId ? [lesson.jointId] : []))))];
                    if (jointIds.length) {
                        const peers = await db.prepare(`SELECT DISTINCT d.group_id FROM lessons l
              JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id
              WHERE l.joint_id IN (${jointIds.map(() => "?").join(",")}) AND d.date BETWEEN ? AND ?`)
                            .all(...jointIds, weekStart, weekEnd) as Array<{
                            group_id: string;
                        }>;
                        const scheduleGroupIds = [...new Set([...groupIds, ...peers.map((peer) => peer.group_id)])];
                        if (scheduleGroupIds.length > groupIds.length)
                            state = await adminState(db, { view: "print", dates, groupIds: scheduleGroupIds, quarterId: quarter.id, includePlans: true });
                    }
                    snapshot = createPublicationSnapshot(state, body.quarterId as string);
                    draftRevision = state.revision;
                }
                const quarter = snapshot.quarter;
                if (!quarter || quarter.id !== body.quarterId)
                    return { error: 404, message: "Четверть не найдена в выбранном расписании" };
                if (weekStart > quarter.endDate || weekEnd < quarter.startDate)
                    return { error: 400, message: "Неделя не пересекается с четвертью" };
                const activeGroups = new Map(snapshot.catalog.groups.filter((group) => !group.archived).map((group) => [group.id, { id: group.id, name: group.name }]));
                const groups = (body.groupIds as string[]).map((id) => activeGroups.get(id));
                if (groups.some((group) => !group))
                    return { error: 404, message: "Одна или несколько групп отсутствуют в выбранном расписании" };
                snapshot = printSnapshotSlice(snapshot, body.groupIds as string[], weekStart, weekEnd);
                const projection = projectPublicStudents(snapshot, publication ?? { version: 0, publishedAt: "" });
                const daysFor = (groupId: string) => (projection.schedules.get(groupId)?.days ?? [])
                    .filter((day) => day.date >= weekStart && day.date <= weekEnd && day.date >= quarter.startDate && day.date <= quarter.endDate)
                    .map((day) => ({
                    date: day.date, slotCount: day.slotCount, holiday: day.holiday,
                    ...(day.calendarLabel ? { calendarLabel: day.calendarLabel } : {}),
                    ...(day.holidayKind ? { holidayKind: day.holidayKind } : {}),
                    lessons: day.lessons.map((lesson) => ({
                        id: lesson.id, slot: lesson.slot, start: lesson.start, duration: lesson.duration,
                        ...(lesson.subject ? { subject: { id: lesson.subject.id, name: lesson.subject.name, shortName: lesson.subject.shortName, color: lesson.subject.color } } : {}),
                        ...(lesson.event ? { event: lesson.event } : {}), lessonKind: lesson.lessonKind,
                        ...(lesson.teacher ? { teacher: { ...(lesson.teacher.id ? { id: lesson.teacher.id } : {}), name: lesson.teacher.name } } : {}),
                        ...(lesson.room ? { room: { ...(lesson.room.id ? { id: lesson.room.id } : {}), name: lesson.room.name } } : {}),
                        ...(lesson.subgroup ? { subgroup: { ...(lesson.subgroup.id ? { id: lesson.subgroup.id } : {}), name: lesson.subgroup.name, ...(lesson.subgroup.number !== undefined ? { number: lesson.subgroup.number } : {}) } } : {}),
                        ...(lesson.jointGroups ? { jointGroups: lesson.jointGroups.map(({ id, name }) => ({ id, name })) } : {}),
                    })),
                }));
                return {
                    value: {
                        source, quarter: { id: quarter.id, name: quarter.name, startDate: quarter.startDate, endDate: quarter.endDate },
                        weekStart, weekEnd, ...(publication ? { publication } : {}), ...(draftRevision !== undefined ? { draftRevision } : {}),
                        groups: (groups as Array<{
                            id: string;
                            name: string;
                        }>).map((group) => ({ group, days: daysFor(group.id) })),
                    } satisfies SchedulePrintPreview,
                };
            });
            if ("error" in result && typeof result.error === "number")
                return reply.code(result.error).send({ error: result.message });
            return reply.send(result.value);
        }
        catch {
            return reply.code(400).send({ error: "Не удалось подготовить расписание к печати" });
        }
    });
    app.get("/api/state", async (request, reply): Promise<StateResponse | unknown> => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        reply.header("cache-control", "no-store");
        return await fullState(db);
    });
    app.get("/api/editor/bootstrap", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const catalog = await readCatalog(db);
        const meta = await db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get() as {
            revision: number;
            updated_at: string;
        };
        reply.header("cache-control", "no-store");
        return reply.send({
            schedule: {}, revision: meta.revision, updatedAt: meta.updated_at, baseline: [], catalog,
            quarters: await readQuarters(db), studyPlans: [], calendar: await readSchoolCalendar(db, catalog),
            bellSettings: await readBellSettings(db, catalog), displaySettings: await readDisplaySettings(db), editorBootstrap: true,
        } satisfies StateResponse);
    });
    app.get<{
        Querystring: {
            groupId?: string;
            quarterId?: string;
            weekOffset?: string;
        };
    }>("/api/editor/week", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const { groupId, quarterId } = request.query;
        const weekOffset = Number(request.query.weekOffset);
        if (!validText(groupId, 120) || !validText(quarterId, 120) || !Number.isInteger(weekOffset) || Math.abs(weekOffset) > 10000)
            return reply.code(400).send({ error: "Некорректный запрос недели" });
        return await db.readTransaction(async () => {
            const catalog = await readCatalog(db);
            const quarter = (await readQuarters(db)).find((entry) => entry.id === quarterId);
            if (!catalog.groups.some((entry) => entry.id === groupId) || !quarter)
                return reply.code(404).send({ error: "Группа или четверть не найдена" });
            if (!quarterWeeks(quarter).includes(weekOffset))
                return reply.code(400).send({ error: "Неделя не входит в выбранную четверть" });
            reply.header("cache-control", "no-store");
            return reply.send(await editorWeekState(db, groupId, quarter, weekOffset, undefined, catalog));
        });
    });
    app.post<{
        Body: EditorPreviewRequest;
    }>("/api/editor/preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body: unknown = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || !validText(body.groupId, 120) || !validText(body.quarterId, 120) || !Number.isInteger(body.weekOffset) || Math.abs(Number(body.weekOffset)) > 10000 || typeof body.autoRoom !== "boolean" || !isRecord(body.payload) || !isRecord(body.payload.lesson))
            return reply.code(400).send({ error: "Некорректный запрос размещения" });
        const revision = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (revision.revision !== body.revision)
            return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю" });
        const groupId = body.groupId as string;
        const weekOffset = Number(body.weekOffset);
        const quarter = (await readQuarters(db)).find((entry) => entry.id === body.quarterId);
        const catalog = await readCatalog(db);
        if (!quarter || !catalog.groups.some((entry) => entry.id === groupId))
            return reply.code(404).send({ error: "Группа или четверть не найдена" });
        const dates = weekDates(weekOffset);
        if (!dates.some((date) => inQuarter(date, quarter)))
            return reply.code(400).send({ error: "Неделя не входит в выбранную четверть" });
        const payload = structuredClone(body.payload) as unknown as EditorPlacement;
        const candidate = payload.lesson;
        const source = payload.from;
        if (!validText(candidate.subjectId, 80) || (candidate.teacherId !== undefined && !validText(candidate.teacherId, 120)) || (candidate.roomId !== undefined && !validText(candidate.roomId, 120)) || (candidate.subgroupId !== undefined && !validText(candidate.subgroupId, 120)))
            return reply.code(400).send({ error: "Некорректный урок" });
        if (source && (!validText(source.id, 120) || !isRecord(source.location) || !validText(source.location.groupId, 120) || !validText(source.location.date, 10) || !Number.isInteger(source.location.weekOffset) || !Number.isInteger(source.location.slot)))
            return reply.code(400).send({ error: "Некорректный исходный урок" });
        const contextDates = [...new Set([...dates, ...(source ? [source.location.date] : [])])];
        const schedule = await readSchedule(db, catalog, contextDates);
        const weekKey = scheduleKey(groupId, weekOffset);
        const targetDays = schedule[weekKey] ?? [];
        const targets = [];
        for (const day of targetDays) {
            if (!dates.includes(day.date))
                continue;
            for (let slot = 0; slot < day.slots.length; slot += 1) {
                const location: Location = { groupId, weekOffset, date: day.date, slot };
                let effectivePayload = payload;
                if (!source && body.autoRoom && candidate.subjectId !== "event" && !candidate.event)
                    effectivePayload = { ...payload, lesson: choosePlacementRoom(schedule, location, candidate, catalog) };
                const entries = day.slots[slot] ?? [];
                const fromLocation = source?.location;
                const self = Boolean(fromLocation && fromLocation.groupId === groupId && fromLocation.date === day.date && fromLocation.slot === slot);
                const swap = Boolean(source && !self && entries.length > 0 && !candidate.subgroup && !candidate.subgroupId && entries.every((lesson) => !lesson.subgroup && !lesson.subgroupId));
                let reason: string | null;
                try {
                    if (self)
                        reason = null;
                    else if (!inQuarter(day.date, quarter) || (fromLocation && !inQuarter(fromLocation.date, quarter)))
                        reason = "Перемещение доступно только внутри выбранной четверти";
                    else if (candidate.event || candidate.subjectId === "event") {
                        reason = entries.length === 0 ? null : entries.some((lesson) => lesson.event || lesson.subjectId === "event")
                            ? "Ячейка занята мероприятием" : "Ячейка занята уроком";
                    }
                    else if (swap && source)
                        reason = canSwapLessons(schedule, fromLocation!, source.id, location, catalog);
                    else
                        reason = canPlace(schedule, location, effectivePayload.lesson, source?.id, catalog);
                }
                catch {
                    return reply.code(400).send({ error: "Не удалось проверить размещение урока" });
                }
                const lesson = effectivePayload.lesson;
                targets.push({
                    date: day.date, slot, self, swap, reason, payload: effectivePayload,
                    label: self ? "Исходный урок" : reason ?? (candidate.event || candidate.subjectId === "event" ? "Настроить мероприятие" : swap ? "Поменять уроки местами" : source ? "Перенести в свободное место" : `Разместить занятие · кабинет ${lesson.room || "не выбран"}`),
                });
            }
        }
        reply.header("cache-control", "no-store");
        return reply.send({ revision: revision.revision, targets });
    });
    app.put<{
        Body: EditorDaysRequest;
    }>("/api/editor/days", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body: unknown = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > 32)
            return reply.code(400).send({ error: "Некорректная команда расписания" });
        const changes = body.changes as EditorDayChange[];
        if (changes.some((change) => !isRecord(change) || !validText(change.key, 200) || !Number.isInteger(change.dayIndex) || change.dayIndex < 0 || !isRecord(change.before) || !isRecord(change.after) || typeof change.before.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(change.before.date) || change.before.date !== change.after.date))
            return reply.code(400).send({ error: "Некорректные изменения дней" });
        const fingerprint = hash(stableJson(body));
        const oldReplay = await db.prepare("SELECT fingerprint,response_json FROM editor_request_replays WHERE request_id=?").get(body.requestId) as {
            fingerprint: string;
            response_json: string;
        } | undefined;
        if (oldReplay)
            return oldReplay.fingerprint === fingerprint ? reply.send(JSON.parse(oldReplay.response_json)) : reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision)
            return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю" });
        const allDates = new Set<string>();
        for (const change of changes) {
            const split = change.key.lastIndexOf(":");
            const offset = Number(change.key.slice(split + 1));
            if (split < 1 || !Number.isInteger(offset) || Math.abs(offset) > 10000 || weekOffsetFor(change.before.date) !== offset)
                return reply.code(400).send({ error: "Некорректный ключ дня" });
            weekDates(offset).forEach((date) => allDates.add(date));
        }
        const dates = [...allDates].sort();
        const catalog = await readCatalog(db);
        const current = await readSchedule(db, catalog, dates);
        const next = structuredClone(current);
        // Names are display values derived from stable catalog references. A new card
        // can carry a surname while the database reads the teacher's full name.
        const teacherNames = new Map(catalog.teachers.map((entry) => [entry.id, entry.name]));
        const roomNames = new Map(catalog.rooms.map((entry) => [entry.id, entry.name]));
        const daySignature = (day: EditorDayChange["before"]) => stableJson({ ...day,
            slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson,
                ...(lesson.teacherId ? { teacher: teacherNames.get(lesson.teacherId) ?? lesson.teacher } : {}),
                ...(lesson.roomId ? { room: roomNames.get(lesson.roomId) ?? lesson.room } : {}),
            }))),
        });
        const seen = new Set<string>();
        for (const change of changes) {
            const identity = `${change.key}\u0000${change.before.date}`;
            if (seen.has(identity))
                return reply.code(400).send({ error: "День передан несколько раз" });
            seen.add(identity);
            const days = current[change.key];
            if (!days || days[change.dayIndex]?.date !== change.before.date || !Array.isArray(change.before.slots) ||
                change.before.slots.some((slot) => !Array.isArray(slot) || slot.some((lesson) => !isRecord(lesson))) ||
                daySignature(days[change.dayIndex]) !== daySignature(change.before))
                return reply.code(409).send({ error: "День расписания изменился. Обновите неделю" });
            next[change.key]![change.dayIndex] = change.after;
        }
        const existingIds = new Set(locatedLessons(current).map((item) => item.lesson.id));
        const currentLessons = locatedLessons(current);
        const nextLessons = locatedLessons(next);
        const currentById = new Map(currentLessons.map((item) => [item.lesson.id, item]));
        const nextById = new Map(nextLessons.map((item) => [item.lesson.id, item]));
        const quarters = await readQuarters(db);
        for (const [id, after] of nextById) {
            const before = currentById.get(id);
            if (!before || before.groupId === after.groupId && before.date === after.date)
                continue;
            const beforeQuarter = quarters.find((quarter) => inQuarter(before.date, quarter));
            const afterQuarter = quarters.find((quarter) => inQuarter(after.date, quarter));
            if (before.groupId !== after.groupId || beforeQuarter?.id !== afterQuarter?.id)
                return reply.code(400).send({ error: "Перемещение возможно только внутри группы и четверти" });
        }
        const proposedIds = [...new Set(nextLessons.map((item) => item.lesson.id))];
        const externalIds = proposedIds.filter((id) => !existingIds.has(id));
        if (externalIds.length) {
            const found = await db.prepare(`SELECT id FROM lessons WHERE id IN (${externalIds.map(() => "?").join(",")}) LIMIT 1`).get(...externalIds);
            if (found)
                return reply.code(400).send({ error: "Идентификатор урока уже используется" });
        }
        const oldJointSignatures = jointSignatures(current);
        const nextJointSignatures = jointSignatures(next);
        const jointIds = [...new Set([...currentLessons, ...nextLessons].map((item) => item.lesson.jointId).filter((id): id is string => Boolean(id)))];
        const changedJointIds = jointIds.filter((id) => oldJointSignatures.get(id) !== nextJointSignatures.get(id));
        if (changedJointIds.length) {
            const membersByJoint = new Map<string, Set<string>>();
            for (const item of nextLessons)
                if (item.lesson.jointId) {
                    const members = membersByJoint.get(item.lesson.jointId) ?? new Set<string>();
                    members.add(item.groupId);
                    membersByJoint.set(item.lesson.jointId, members);
                }
            if (changedJointIds.some((id) => (membersByJoint.get(id)?.size ?? 0) < 2 && nextJointSignatures.has(id)))
                return reply.code(400).send({ error: "Совместный урок нужно менять целиком" });
            const jointRows = await db.prepare(`SELECT DISTINCT l.joint_id AS jointId,d.date FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.joint_id IN (${changedJointIds.map(() => "?").join(",")})`)
                .all(...changedJointIds) as Array<{
                jointId: string;
                date: string;
            }>;
            if (jointRows.some((row) => !dates.includes(row.date)))
                return reply.code(400).send({ error: "Совместный урок нужно менять целиком" });
        }
        const quarterIds = new Set(quarters.filter((quarter) => dates.some((date) => inQuarter(date, quarter))).map((quarter) => quarter.id));
        const plans = (await Promise.all([...quarterIds].map(async (quarterId) => await readStudyPlans(db, undefined, quarterId)))).flat();
        if (!validateSchedule(next, current, catalog, quarters, plans))
            return reply.code(400).send({ error: "Изменения содержат недопустимые данные" });
        const resolved = roomResolvedSchedule(next, current, catalog);
        if (!resolved)
            return reply.code(400).send({ error: "Укажите кабинет для нового урока" });
        const resolvedCurrent = roomResolvedSchedule(current, current, catalog);
        if (!resolvedCurrent)
            return reply.code(400).send({ error: "Не удалось проверить исходные кабинеты" });
        const unavailable = newUnavailabilityViolation(resolved, resolvedCurrent, catalog);
        if (unavailable)
            return reply.code(400).send({ error: unavailabilityViolationMessage(unavailable, catalog) });
        const roomConflict = newRoomConflict(resolved, resolvedCurrent);
        if (roomConflict)
            return reply.code(400).send({ error: roomConflictMessage(roomConflict, catalog) });
        const suitability = newRoomSuitabilityViolation(resolved, resolvedCurrent, catalog);
        if (suitability)
            return reply.code(400).send({ error: roomSuitabilityViolationMessage(suitability, catalog) });
        const teacherConflict = newTeacherConflict(resolved, resolvedCurrent);
        if (teacherConflict)
            return reply.code(400).send({ error: teacherConflictMessage(teacherConflict, catalog) });
        const updatedAt = nowIso();
        try {
            const result = await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint,response_json FROM editor_request_replays WHERE request_id=?").get(body.requestId) as {
                    fingerprint: string;
                    response_json: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("editor-idempotency-conflict");
                    return JSON.parse(replay.response_json) as {
                        revision: number;
                        updatedAt: string;
                    };
                }
                const latest = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (latest.revision !== body.revision)
                    throw new Error("editor-revision-conflict");
                const normalizedChanges = changes.map((change) => ({ ...change, after: resolved[change.key]!.find((day) => day.date === change.after.date)! }));
                await replaceEditorDays(db, resolved, normalizedChanges);
                const revision = latest.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(revision, updatedAt);
                const response = { revision, updatedAt };
                await db.prepare("INSERT INTO editor_request_replays(request_id,fingerprint,response_json) VALUES(?,?,?)").run(body.requestId, fingerprint, JSON.stringify(response));
                return response;
            })();
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof Error && error.message === "editor-revision-conflict")
                return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю" });
            if (error instanceof Error && error.message === "editor-idempotency-conflict")
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            if (error instanceof Error && error.message === "editor-day-missing")
                return reply.code(409).send({ error: "День расписания больше не существует" });
            throw error;
        }
    });
    app.get<{
        Querystring: {
            quarterId?: string;
            subjectId?: string;
            teacherId?: string;
            groupIds?: string;
            startDate?: string;
            endDate?: string;
            availability?: string;
        };
    }>("/api/admin/reassignments", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const { quarterId, subjectId, teacherId } = request.query;
        const catalog = await readCatalog(db);
        if (teacherId && !catalog.teachers.some(item => item.id === teacherId))
            return reply.code(400).send({ error: "Преподаватель не найден" });
        const groupIds = request.query.groupIds ? [...new Set(request.query.groupIds.split(",").filter(Boolean))] : undefined;
        if (groupIds && (groupIds.length > 500 || groupIds.some(id => !catalog.groups.some(group => group.id === id))))
            return reply.code(400).send({ error: "Список групп некорректен" });
        if (request.query.availability === "1") {
            if (!teacherId || !request.query.startDate || !request.query.endDate)
                return reply.code(400).send({ error: "Не указан преподаватель или период" });
            const dates = await scheduleDatesInRange(db, request.query.startDate, request.query.endDate);
            const availabilityCatalog = catalog;
            const availabilitySchedule = await readSchedule(db, availabilityCatalog, dates, groupIds);
            const availabilityLessonIds = locatedLessons(availabilitySchedule).map(item => item.lesson.id);
            const origins = await readTeacherLessonOrigins(db, availabilityLessonIds);
            const originById = new Map(origins.map(origin => [origin.lessonId, origin]));
            const matching = locatedLessons(availabilitySchedule).filter(item => item.lesson.teacherId === teacherId || originById.get(item.lesson.id)?.sourceTeacherId === teacherId);
            const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                revision: number;
            };
            return reply.send({ revision: meta.revision,
                availableGroupIds: [...new Set(matching.map(item => item.groupId))],
                availableSubjectIds: [...new Set(matching.map(item => item.lesson.subjectId))] });
        }
        if (!validText(quarterId, 120) || !quarterId)
            return reply.code(400).send({ error: "Не указана четверть" });
        const quarter = (await readQuarters(db)).find(item => item.id === quarterId);
        if (!quarter)
            return reply.code(404).send({ error: "Четверть не найдена" });
        if (subjectId && !catalog.subjects.some(item => item.id === subjectId))
            return reply.code(400).send({ error: "Предмет не найден" });
        const dates = await scheduleDatesInRange(db, quarter.startDate, quarter.endDate);
        const allScopedSchedule = await readSchedule(db, catalog, dates, groupIds);
        const lessonIds = new Set(locatedLessons(allScopedSchedule).map(item => item.lesson.id));
        const origins = await readTeacherLessonOrigins(db, [...lessonIds]);
        const originByLesson = new Map(origins.map(origin => [origin.lessonId, origin]));
        const taughtSubjectIds = [...new Set(locatedLessons(allScopedSchedule)
                .filter(item => !teacherId || item.lesson.teacherId === teacherId || originByLesson.get(item.lesson.id)?.sourceTeacherId === teacherId)
                .map(item => item.lesson.subjectId))].sort((a, b) => a.localeCompare(b, "ru"));
        const schedule: Schedule = {};
        if (subjectId)
            for (const [key, days] of Object.entries(allScopedSchedule)) {
                const filtered = days.map(day => ({ ...day, slots: day.slots.map(slot => slot.filter(lesson => lesson.subjectId === subjectId && (!teacherId || lesson.teacherId === teacherId || originByLesson.get(lesson.id)?.sourceTeacherId === teacherId))) }));
                if (filtered.some(day => day.slots.some(slot => slot.length)))
                    schedule[key] = filtered;
            }
        const visibleIds = new Set(locatedLessons(schedule).map(item => item.lesson.id));
        const meta = await db.prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1").get() as {
            revision: number;
            updated_at: string;
        };
        reply.header("cache-control", "no-store");
        return reply.send({ revision: meta.revision, updatedAt: meta.updated_at, schedule,
            teacherLessonOrigins: origins.filter(origin => visibleIds.has(origin.lessonId)),
            teachingAssignments: [], taughtSubjectIds });
    });
    app.post<{
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            request?: unknown;
        };
    }>("/api/teacher-replacements/preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 || !isRecord(body.request))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (current.revision !== body.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите страницу и повторите подбор" });
        try {
            const replacementRequest = body.request as import("../shared/automaticTeacherReplacement.ts").ReplacementRequest;
            const dates = await scheduleDatesInRange(db, replacementRequest.startDate, replacementRequest.endDate);
            const catalog = await readCatalog(db);
            const preview = previewAutomaticTeacherReplacement(await readSchedule(db, catalog, dates), catalog, replacementRequest);
            const responsePreview = request.query.response === "compact" ? (({ schedule: _schedule, ...rest }) => rest)(preview) : preview;
            reply.header("cache-control", "no-store");
            return reply.send({ revision: current.revision, preview: responsePreview });
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "Некорректный запрос" });
        }
    });
    app.post<{
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            requestId?: unknown;
            request?: unknown;
            expectedAssignments?: unknown;
        };
    }>("/api/teacher-replacements/apply", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !isRecord(body.request) ||
            !Array.isArray(body.expectedAssignments) || body.expectedAssignments.some((item) => !isRecord(item) || !validText(item.unitId, 200) || !validText(item.teacherId, 120)))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const requestId = body.requestId;
        const expectedAssignments = body.expectedAssignments as Array<{
            unitId: string;
            teacherId: string;
        }>;
        if (new Set(expectedAssignments.map((item) => item.unitId)).size !== expectedAssignments.length || expectedAssignments.length === 0)
            return reply.code(400).send({ error: "Выберите хотя бы одну замену без повторов" });
        const fingerprint = hash(JSON.stringify({ revision: body.revision, request: body.request, expectedAssignments }));
        const prior = await db.prepare("SELECT apply_fingerprint,apply_response_json FROM teacher_replacement_operations WHERE apply_request_id=?").get(requestId) as {
            apply_fingerprint: string;
            apply_response_json: string;
        } | undefined;
        if (prior) {
            if (prior.apply_fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(JSON.parse(prior.apply_response_json));
        }
        const currentMeta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (currentMeta.revision !== body.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите предпросмотр замен" });
        const requested = body.request as import("../shared/automaticTeacherReplacement.ts").ReplacementRequest;
        const dates = await scheduleDatesInRange(db, requested.startDate, requested.endDate);
        const catalog = await readCatalog(db);
        const originalSchedule = await readSchedule(db, catalog, dates);
        let preview;
        try {
            preview = previewAutomaticTeacherReplacement(originalSchedule, catalog, requested);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "Некорректный запрос" });
        }
        const proposed = new Map(preview.units.filter((unit) => unit.teacherId).map((unit) => [unit.id, unit.teacherId!]));
        if (expectedAssignments.some((item) => proposed.get(item.unitId) !== item.teacherId))
            return reply.code(409).send({ error: "Предложения изменились. Просмотрите обновлённый результат" });
        const selectedUnitIds = new Set(expectedAssignments.map((item) => item.unitId));
        const selectedLessonIds = new Set(preview.units.filter((unit) => selectedUnitIds.has(unit.id)).flatMap((unit) => unit.lessonIds));
        const previewLessons = new Map(Object.values(preview.schedule).flatMap((days) => days.flatMap((day) => day.slots.flat())).map((lesson) => [lesson.id, lesson]));
        const nextSchedule = Object.fromEntries(Object.entries(originalSchedule).map(([key, days]) => [key, days.map((day) => ({
                ...day,
                slots: day.slots.map((slot) => slot.map((lesson) => selectedLessonIds.has(lesson.id) ? previewLessons.get(lesson.id) ?? lesson : lesson)),
            }))]));
        const quarters = await readQuarters(db);
        const changedGroupIds = [...new Set(preview.units.filter((unit) => selectedUnitIds.has(unit.id)).flatMap((unit) => unit.groupIds))];
        const plans = await readReplacementStudyPlans(db, changedGroupIds, quarters, dates);
        if (!validateSchedule(nextSchedule, originalSchedule, catalog, quarters, plans))
            return reply.code(400).send({ error: "Предложения содержат недопустимые данные" });
        const resolved = roomResolvedSchedule(nextSchedule, originalSchedule, catalog);
        const previousResolved = roomResolvedSchedule(originalSchedule, originalSchedule, catalog);
        if (!resolved || !previousResolved)
            return reply.code(400).send({ error: "Не удалось проверить кабинеты заменяемых уроков" });
        const unavailability = newUnavailabilityViolation(resolved, previousResolved, catalog);
        if (unavailability)
            return reply.code(409).send({ error: unavailabilityViolationMessage(unavailability, catalog) });
        const roomConflict = newRoomConflict(resolved, previousResolved);
        if (roomConflict)
            return reply.code(409).send({ error: roomConflictMessage(roomConflict, catalog) });
        const suitability = newRoomSuitabilityViolation(resolved, previousResolved, catalog);
        if (suitability)
            return reply.code(409).send({ error: roomSuitabilityViolationMessage(suitability, catalog) });
        const teacherConflict = newTeacherConflict(resolved, previousResolved);
        if (teacherConflict)
            return reply.code(409).send({ error: teacherConflictMessage(teacherConflict, catalog) });
        const previousOrigins = await readTeacherLessonOrigins(db);
        const previousPolicies = await readTemporaryTeacherReplacements(db);
        const policies = [...previousPolicies];
        const policyTeacherCounts = new Map<string, Map<string, number>>();
        const chosenByLesson = new Map<string, string>();
        for (const unit of preview.units)
            if (selectedUnitIds.has(unit.id) && unit.teacherId)
                for (const lessonId of unit.lessonIds)
                    chosenByLesson.set(lessonId, unit.teacherId);
        for (const [scheduleKey, days] of Object.entries(originalSchedule)) {
            const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
            for (const day of days)
                for (const slot of day.slots)
                    for (const lesson of slot) {
                        const teacherId = chosenByLesson.get(lesson.id);
                        if (!teacherId)
                            continue;
                        const key = [groupId, lesson.subjectId, lesson.subgroupId ?? "", lesson.subgroup ?? ""].join("\0");
                        const counts = policyTeacherCounts.get(key) ?? new Map<string, number>();
                        counts.set(teacherId, (counts.get(teacherId) ?? 0) + 1);
                        policyTeacherCounts.set(key, counts);
                    }
        }
        for (const [key, counts] of policyTeacherCounts) {
            const [groupId, subjectId, subgroupId, subgroup] = key.split("\0");
            const teacherIds = [...counts].sort(([a, countA], [b, countB]) => countB - countA ||
                (catalog.teachers.find((teacher) => teacher.id === a)?.name ?? a).localeCompare(catalog.teachers.find((teacher) => teacher.id === b)?.name ?? b, "ru") || a.localeCompare(b)).map(([id]) => id);
            policies.push({ id: randomToken(12), sourceTeacherId: requested.teacherId, groupId: groupId!, subjectId: subjectId!,
                ...(subgroupId ? { subgroupId } : {}), ...(subgroup ? { subgroup } : {}),
                startDate: requested.startDate, endDate: requested.endDate, ...(requested.ruleId ? { unavailabilityRuleId: requested.ruleId } : {}),
                teacherIds });
        }
        const afterById = new Map(locatedLessons(resolved).map((item) => [item.lesson.id, item]));
        const nextOrigins = [...previousOrigins];
        for (const [lessonId, substituteTeacherId] of chosenByLesson) {
            const after = afterById.get(lessonId);
            const before = locatedLessons(originalSchedule).find((item) => item.lesson.id === lessonId);
            if (!after || !before)
                continue;
            const priorOrigin = previousOrigins.find((origin) => origin.lessonId === lessonId && origin.status === "active");
            const sourceTeacherId = priorOrigin?.sourceTeacherId ?? requested.teacherId;
            nextOrigins.splice(0, nextOrigins.length, ...nextOrigins.filter((origin) => origin.lessonId !== lessonId || origin.status !== "active"));
            const origin: TeacherLessonOrigin = {
                id: `absence:${lessonId}:${randomToken(5)}`, lessonId, groupId: before.groupId, date: before.date,
                sourceTeacherId, substituteTeacherId, kind: "absence", ...(requested.ruleId ? { absenceRuleId: requested.ruleId } : {}),
                startDate: requested.startDate, endDate: requested.endDate, expected: teacherLessonFingerprint(after), status: "active",
            };
            nextOrigins.push(origin);
        }
        const operationId = randomToken(18);
        const updatedAt = nowIso();
        try {
            const response = await db.transaction(async () => {
                const committed = await db.prepare("SELECT apply_fingerprint,apply_response_json FROM teacher_replacement_operations WHERE apply_request_id=?").get(requestId) as {
                    apply_fingerprint: string;
                    apply_response_json: string;
                } | undefined;
                if (committed) {
                    if (committed.apply_fingerprint !== fingerprint)
                        throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
                    return JSON.parse(committed.apply_response_json);
                }
                const revisionNow = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (revisionNow.revision !== body.revision)
                    throw new Error("revision-conflict");
                const teacherSnapshot = await reassignmentTeacherSnapshot(db, originalSchedule, selectedLessonIds);
                await persistScheduleDelta(db, originalSchedule, resolved);
                await writeTeacherLessonOrigins(db, nextOrigins);
                await writeTemporaryTeacherReplacements(db, policies);
                const nextRevision = revisionNow.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                const result = request.query.response === "receipt" ? { revision: nextRevision, updatedAt, operationId }
                    : { state: request.query.response === "compact"
                        ? await adminState(db, { view: "operation", dates }) : await fullState(db), operationId };
                await db.prepare(`INSERT INTO teacher_replacement_operations(operation_id,apply_request_id,apply_fingerprint,apply_response_json,applied_revision,previous_schedule_json,previous_policies_json,previous_origins_json,previous_assignments_json)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(operationId, requestId, fingerprint, JSON.stringify(result), nextRevision, JSON.stringify(teacherSnapshot), JSON.stringify(previousPolicies), JSON.stringify(previousOrigins), JSON.stringify(await readTeacherTeachingAssignments(db)));
                return result;
            })();
            reply.header("cache-control", "no-store");
            return reply.send(response);
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "Данные изменились. Обновите предпросмотр замен" });
            throw error;
        }
    });
    app.post<{
        Params: {
            operationId: string;
        };
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            requestId?: unknown;
        };
    }>("/api/teacher-replacements/:operationId/undo", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !validText(request.params.operationId, 100))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ operationId: request.params.operationId, revision: body.revision }));
        const replay = await db.prepare("SELECT operation_id,undo_fingerprint,undo_response_json FROM teacher_replacement_operations WHERE undo_request_id=?").get(requestId) as {
            operation_id: string;
            undo_fingerprint: string | null;
            undo_response_json: string | null;
        } | undefined;
        if (replay) {
            if (replay.operation_id !== request.params.operationId || replay.undo_fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(JSON.parse(replay.undo_response_json!));
        }
        const operation = await db.prepare("SELECT * FROM teacher_replacement_operations WHERE operation_id=?").get(request.params.operationId) as {
            operation_id: string;
            applied_revision: number;
            previous_schedule_json: string;
            previous_policies_json: string;
            previous_origins_json: string;
            previous_assignments_json: string;
            undo_request_id: string | null;
        } | undefined;
        if (!operation)
            return reply.code(404).send({ error: "Операция замены не найдена" });
        if (operation.undo_request_id)
            return reply.code(409).send({ error: "Эта операция уже отменена" });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision || meta.revision !== operation.applied_revision)
            return reply.code(409).send({ error: "После замены данные изменились. Отмена этой операции уже невозможна" });
        const catalog = await readCatalog(db);
        const savedSchedule = JSON.parse(operation.previous_schedule_json) as Schedule | ReassignmentTeacherSnapshot;
        const teacherSnapshot = savedSchedule.format === "teacher-reassignment-v2" ? savedSchedule as ReassignmentTeacherSnapshot : undefined;
        const oldSchedule = teacherSnapshot ? undefined : savedSchedule as Schedule;
        const dates = teacherSnapshot ? teacherSnapshot.dates : scheduleDates(oldSchedule!);
        const current = await readSchedule(db, catalog, dates);
        const previous = teacherSnapshot ? restoreReassignmentTeachers(current, teacherSnapshot) : oldSchedule!;
        const previousPolicies = JSON.parse(operation.previous_policies_json) as TemporaryTeacherReplacement[];
        const previousOrigins = JSON.parse(operation.previous_origins_json) as TeacherLessonOrigin[];
        const previousAssignments = JSON.parse(operation.previous_assignments_json) as TeacherTeachingAssignment[];
        const currentById = new Map(locatedLessons(current).map((item) => [item.lesson.id, item]));
        const changedGroupIds = [...new Set(locatedLessons(previous).filter((item) => {
            const before = currentById.get(item.lesson.id);
            return !before || before.groupId !== item.groupId || before.date !== item.date || JSON.stringify(before.lesson) !== JSON.stringify(item.lesson);
        }).map((item) => item.groupId))];
        const quarters = await readQuarters(db);
        const plans = await readReplacementStudyPlans(db, changedGroupIds, quarters, dates);
        if (!validateSchedule(previous, current, catalog, quarters, plans))
            return reply.code(409).send({ error: "Исходное расписание больше не проходит проверку" });
        const resolved = roomResolvedSchedule(previous, current, catalog);
        const previousResolved = roomResolvedSchedule(previous, previous, catalog);
        if (!resolved || !previousResolved)
            return reply.code(409).send({ error: "Не удалось проверить кабинеты при отмене" });
        const unavailability = newUnavailabilityViolation(resolved, previous, catalog);
        if (unavailability)
            return reply.code(409).send({ error: unavailabilityViolationMessage(unavailability, catalog) });
        // Compare against the exact pre-operation snapshot. This preserves unrelated
        // legacy conflicts while still rejecting any newly introduced conflict.
        const roomConflict = newRoomConflict(resolved, previousResolved);
        if (roomConflict)
            return reply.code(409).send({ error: roomConflictMessage(roomConflict, catalog) });
        const suitability = newRoomSuitabilityViolation(resolved, previousResolved, catalog);
        if (suitability)
            return reply.code(409).send({ error: roomSuitabilityViolationMessage(suitability, catalog) });
        const teacherConflict = newTeacherConflict(resolved, previousResolved);
        if (teacherConflict)
            return reply.code(409).send({ error: teacherConflictMessage(teacherConflict, catalog) });
        const updatedAt = nowIso();
        try {
            const result = await db.transaction(async () => {
                const committed = await db.prepare("SELECT operation_id,undo_fingerprint,undo_response_json FROM teacher_replacement_operations WHERE undo_request_id=?").get(requestId) as {
                    operation_id: string;
                    undo_fingerprint: string | null;
                    undo_response_json: string | null;
                } | undefined;
                if (committed) {
                    if (committed.operation_id !== request.params.operationId || committed.undo_fingerprint !== fingerprint)
                        throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
                    return JSON.parse(committed.undo_response_json!);
                }
                const latest = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (latest.revision !== body.revision || latest.revision !== operation.applied_revision)
                    throw new Error("revision-conflict");
                if (teacherSnapshot) {
                    const restore = db.prepare("UPDATE lessons SET teacher=?,teacher_ref=? WHERE id=?");
                    for (const teacher of teacherSnapshot.teachers)
                        await restore.run(teacher.teacher, teacher.teacher_ref, teacher.id);
                }
                else
                    await persistScheduleDelta(db, current, resolved);
                await writeTeacherLessonOrigins(db, previousOrigins);
                await writeTeacherTeachingAssignments(db, previousAssignments);
                await writeTemporaryTeacherReplacements(db, previousPolicies);
                const nextRevision = latest.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                const response = request.query.response === "receipt" ? { revision: nextRevision, updatedAt }
                    : { state: request.query.response === "compact"
                        ? await adminState(db, { view: "operation", dates }) : await fullState(db) };
                await db.prepare("UPDATE teacher_replacement_operations SET undo_request_id=?,undo_fingerprint=?,undo_response_json=? WHERE operation_id=?")
                    .run(requestId, fingerprint, JSON.stringify(response), operation.operation_id);
                return response;
            })();
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "После замены данные изменились. Отмена этой операции уже невозможна" });
            throw error;
        }
    });
    app.post<{
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            request?: unknown;
        };
    }>("/api/teacher-reassignments/preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 || !isRecord(body.request))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите страницу и повторите" });
        try {
            const requestValue = body.request as TeacherReassignmentRequest;
            const scope = stableJson(requestValue.mode === "assign"
                ? { ...requestValue, targetTeacherId: undefined, unitTeacherIds: undefined }
                : requestValue);
            const sessionKey = hash(request.cookies[COOKIE_NAME]!);
            const now = Date.now();
            for (const [key, entry] of reassignmentPreviews) {
                if (entry.revision !== meta.revision || entry.expires < now)
                    reassignmentPreviews.delete(key);
            }
            let entry = requestValue.mode === "assign" ? reassignmentPreviews.get(sessionKey) : undefined;
            if (!entry || entry.scope !== scope) {
                entry = { revision: meta.revision, scope, expires: now + 90000,
                    state: await readReassignmentState(db, requestValue), calculations: createTeacherReassignmentPreviewCache() };
                if (requestValue.mode === "assign") {
                    reassignmentPreviews.delete(sessionKey);
                    if (reassignmentPreviews.size >= 3)
                        reassignmentPreviews.delete(reassignmentPreviews.keys().next().value!);
                    reassignmentPreviews.set(sessionKey, entry);
                }
            }
            const errors = validateTeacherReassignmentRequest(entry.state, requestValue, entry.calculations);
            if (errors.length)
                return reply.code(400).send({ error: errors.join(" ") });
            const requestKey = stableJson(requestValue);
            const preview = entry.requestKey === requestKey && entry.preview
                ? entry.preview : previewTeacherReassignment(entry.state, requestValue, entry.calculations);
            entry.requestKey = requestKey;
            entry.preview = preview;
            entry.expires = now + 90000;
            reply.header("cache-control", "no-store");
            const responsePreview = request.query.response === "compact" ? (({ schedule: _schedule, catalog: _catalog, ...rest }) => rest)(preview) : preview;
            return reply.send({ revision: meta.revision, preview: responsePreview });
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "Некорректный запрос" });
        }
    });
    app.post<{
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            requestId?: unknown;
            request?: unknown;
            expectedUnits?: unknown;
        };
    }>("/api/teacher-reassignments/apply", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 || !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !isRecord(body.request) || !Array.isArray(body.expectedUnits) || body.expectedUnits.some((item) => !isRecord(item) || !validText(item.unitId, 200) || !validText(item.teacherId, 120)))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const expectedUnits = body.expectedUnits as Array<{
            unitId: string;
            teacherId: string;
        }>;
        if (new Set(expectedUnits.map((item) => item.unitId)).size !== expectedUnits.length)
            return reply.code(400).send({ error: "В списке есть повторяющиеся занятия" });
        const requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ revision: body.revision, request: body.request, expectedUnits }));
        const replay = await db.prepare("SELECT apply_fingerprint,apply_response_json FROM teacher_reassignment_operations WHERE apply_request_id=?").get(requestId) as {
            apply_fingerprint: string;
            apply_response_json: string;
        } | undefined;
        if (replay) {
            if (replay.apply_fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(JSON.parse(replay.apply_response_json));
        }
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите предпросмотр" });
        const requestValue = body.request as TeacherReassignmentRequest;
        const before = await readReassignmentState(db, requestValue);
        let preview;
        try {
            const errors = validateTeacherReassignmentRequest(before, body.request as TeacherReassignmentRequest);
            if (errors.length)
                return reply.code(400).send({ error: errors.join(" ") });
            preview = previewTeacherReassignment(before, body.request as TeacherReassignmentRequest);
        }
        catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "Некорректный запрос" });
        }
        const proposed = new Map(preview.units.filter((unit) => unit.teacherId && !unit.reason).map((unit) => [unit.id, unit.teacherId!]));
        if (expectedUnits.some((item) => proposed.get(item.unitId) !== item.teacherId))
            return reply.code(409).send({ error: "Предложения изменились. Просмотрите обновлённый результат" });
        const selectedUnitIds = new Set(expectedUnits.map((item) => item.unitId));
        const selectedLessonIds = new Set(preview.units.filter((unit) => selectedUnitIds.has(unit.id)).flatMap((unit) => unit.lessonIds));
        const nextSchedule = replaceSelectedLessons(before.schedule, preview.schedule, selectedLessonIds);
        const nextCatalog = preview.catalog;
        const plans = requestValue.mode === "assign" ? await readStudyPlans(db, undefined, requestValue.quarterId) : await readStudyPlans(db);
        if (!validateSchedule(nextSchedule, before.schedule, nextCatalog, before.quarters, plans))
            return reply.code(400).send({ error: "Предложения содержат недопустимые данные" });
        const resolved = roomResolvedSchedule(nextSchedule, before.schedule, nextCatalog);
        const previousResolved = roomResolvedSchedule(before.schedule, before.schedule, await readCatalog(db));
        if (!resolved || !previousResolved)
            return reply.code(400).send({ error: "Не удалось проверить кабинеты переназначаемых уроков" });
        const unavailability = newUnavailabilityViolation(resolved, previousResolved, nextCatalog);
        if (unavailability)
            return reply.code(409).send({ error: unavailabilityViolationMessage(unavailability, nextCatalog) });
        const roomConflict = newRoomConflict(resolved, previousResolved);
        if (roomConflict)
            return reply.code(409).send({ error: roomConflictMessage(roomConflict, nextCatalog) });
        const suitability = newRoomSuitabilityViolation(resolved, previousResolved, nextCatalog);
        if (suitability)
            return reply.code(409).send({ error: roomSuitabilityViolationMessage(suitability, nextCatalog) });
        const teacherConflict = newTeacherConflict(resolved, previousResolved);
        if (teacherConflict)
            return reply.code(409).send({ error: teacherConflictMessage(teacherConflict, nextCatalog) });
        if (requestValue.mode === "return" && !preview.ruleChanged && !selectedLessonIds.size)
            return reply.code(400).send({ error: "Нет доступных будущих уроков для возврата" });
        if (!selectedLessonIds.size && !(requestValue.mode === "return" && preview.ruleChanged))
            return reply.code(400).send({ error: "Выберите хотя бы одно переназначение" });
        const previousOrigins = await readTeacherLessonOrigins(db);
        const nextOrigins = mergeSelectedOrigins(previousOrigins, preview.teacherLessonOrigins, selectedLessonIds);
        const nextAssignments = requestValue.mode === "return" ? preview.teachingAssignments : mergeSelectedAssignments(before.teachingAssignments ?? [], preview.teachingAssignments, selectedUnitIds, preview.units, previousOrigins);
        const previousPolicies = await readTemporaryTeacherReplacements(db);
        const nextPolicies = requestValue.mode === "return" && preview.ruleChanged
            ? trimTemporaryReplacementPolicies(previousPolicies, requestValue)
            : previousPolicies;
        const operationId = randomToken(18);
        const updatedAt = nowIso();
        const teacherSnapshot = await reassignmentTeacherSnapshot(db, before.schedule, selectedLessonIds);
        try {
            const result = await db.transaction(async () => {
                const committed = await db.prepare("SELECT apply_fingerprint,apply_response_json FROM teacher_reassignment_operations WHERE apply_request_id=?").get(requestId) as {
                    apply_fingerprint: string;
                    apply_response_json: string;
                } | undefined;
                if (committed) {
                    if (committed.apply_fingerprint !== fingerprint)
                        throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
                    return JSON.parse(committed.apply_response_json);
                }
                const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (current.revision !== body.revision)
                    throw new Error("revision-conflict");
                await persistReassignmentTeachers(db, resolved, selectedLessonIds, nextCatalog);
                await writeTeacherLessonOrigins(db, nextOrigins);
                await writeTeacherTeachingAssignments(db, nextAssignments);
                await writeTemporaryTeacherReplacements(db, nextPolicies);
                if (requestValue.mode === "return" && preview.ruleChanged)
                    await writeCatalogTeacherAvailability(db, nextCatalog);
                const nextRevision = current.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                const dates = scheduleDates(before.schedule);
                const response = request.query.response === "receipt" ? { revision: nextRevision, updatedAt, operationId } : { state: request.query.response === "compact"
                        ? await adminState(db, { view: "operation", dates }) : await fullState(db), operationId };
                await db.prepare(`INSERT INTO teacher_reassignment_operations(operation_id,apply_request_id,apply_fingerprint,apply_response_json,applied_revision,previous_schedule_json,previous_catalog_json,previous_origins_json,previous_assignments_json,previous_policies_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
                    .run(operationId, requestId, fingerprint, JSON.stringify(response), nextRevision, JSON.stringify(teacherSnapshot), JSON.stringify(before.catalog), JSON.stringify(previousOrigins), JSON.stringify(before.teachingAssignments ?? []), JSON.stringify(previousPolicies));
                return response;
            })();
            reply.header("cache-control", "no-store");
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "Данные изменились. Обновите предпросмотр" });
            throw error;
        }
    });
    app.post<{
        Params: {
            operationId: string;
        };
        Querystring: {
            response?: string;
        };
        Body: {
            revision?: unknown;
            requestId?: unknown;
        };
    }>("/api/teacher-reassignments/:operationId/undo", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 || !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !validText(request.params.operationId, 100))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ operationId: request.params.operationId, revision: body.revision }));
        const replay = await db.prepare("SELECT operation_id,undo_fingerprint,undo_response_json FROM teacher_reassignment_operations WHERE undo_request_id=?").get(requestId) as {
            operation_id: string;
            undo_fingerprint: string | null;
            undo_response_json: string | null;
        } | undefined;
        if (replay) {
            if (replay.operation_id !== request.params.operationId || replay.undo_fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(JSON.parse(replay.undo_response_json!));
        }
        const operation = await db.prepare("SELECT * FROM teacher_reassignment_operations WHERE operation_id=?").get(request.params.operationId) as {
            operation_id: string;
            applied_revision: number;
            previous_schedule_json: string;
            previous_catalog_json: string;
            previous_origins_json: string;
            previous_assignments_json: string;
            previous_policies_json: string;
            undo_request_id: string | null;
        } | undefined;
        if (!operation)
            return reply.code(404).send({ error: "Операция не найдена" });
        if (operation.undo_request_id)
            return reply.code(409).send({ error: "Эта операция уже отменена" });
        const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (current.revision !== body.revision || current.revision !== operation.applied_revision)
            return reply.code(409).send({ error: "После переназначения данные изменились. Отмена уже невозможна" });
        const savedSchedule = JSON.parse(operation.previous_schedule_json) as Schedule | ReassignmentTeacherSnapshot;
        const teacherSnapshot = savedSchedule.format === "teacher-reassignment-v2" ? savedSchedule as ReassignmentTeacherSnapshot : undefined;
        const oldSchedule = teacherSnapshot ? undefined : savedSchedule as Schedule;
        const oldCatalog = JSON.parse(operation.previous_catalog_json) as Catalog;
        const oldOrigins = JSON.parse(operation.previous_origins_json) as TeacherLessonOrigin[];
        const oldAssignments = JSON.parse(operation.previous_assignments_json) as TeacherTeachingAssignment[];
        const oldPolicies = JSON.parse(operation.previous_policies_json) as TemporaryTeacherReplacement[];
        const dates = teacherSnapshot ? teacherSnapshot.dates : scheduleDates(oldSchedule!);
        const currentSchedule = await readSchedule(db, oldCatalog, dates);
        const restoredSchedule = teacherSnapshot ? restoreReassignmentTeachers(currentSchedule, teacherSnapshot) : oldSchedule!;
        const nextSchedule = roomResolvedSchedule(restoredSchedule, currentSchedule, oldCatalog);
        if (!nextSchedule || !validateSchedule(restoredSchedule, currentSchedule, oldCatalog, await readQuarters(db), await readStudyPlans(db)))
            return reply.code(409).send({ error: "Исходное расписание больше не проходит проверку" });
        const updatedAt = nowIso();
        const result = await db.transaction(async () => {
            const committed = await db.prepare("SELECT operation_id,undo_fingerprint,undo_response_json FROM teacher_reassignment_operations WHERE undo_request_id=?").get(requestId) as {
                operation_id: string;
                undo_fingerprint: string | null;
                undo_response_json: string | null;
            } | undefined;
            if (committed) {
                if (committed.operation_id !== request.params.operationId || committed.undo_fingerprint !== fingerprint)
                    throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
                return JSON.parse(committed.undo_response_json!);
            }
            const latest = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                revision: number;
            };
            if (latest.revision !== body.revision || latest.revision !== operation.applied_revision)
                throw Object.assign(new Error("После переназначения данные изменились. Отмена уже невозможна"), { statusCode: 409 });
            if (teacherSnapshot) {
                const restore = db.prepare("UPDATE lessons SET teacher=?,teacher_ref=? WHERE id=?");
                for (const teacher of teacherSnapshot.teachers)
                    await restore.run(teacher.teacher, teacher.teacher_ref, teacher.id);
            }
            else
                await persistScheduleDelta(db, currentSchedule, nextSchedule);
            await writeTeacherLessonOrigins(db, oldOrigins);
            await writeTeacherTeachingAssignments(db, oldAssignments);
            await writeTemporaryTeacherReplacements(db, oldPolicies);
            await writeCatalogTeacherAvailability(db, oldCatalog);
            const nextRevision = latest.revision + 1;
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
            const response = request.query.response === "receipt" ? { revision: nextRevision, updatedAt } : { state: request.query.response === "compact"
                    ? await adminState(db, { view: "operation", dates }) : await fullState(db) };
            await db.prepare("UPDATE teacher_reassignment_operations SET undo_request_id=?,undo_fingerprint=?,undo_response_json=? WHERE operation_id=?").run(requestId, fingerprint, JSON.stringify(response), operation.operation_id);
            return response;
        })();
        return reply.send(result);
    });
    app.get<{
        Querystring: {
            quarterId?: string;
        };
    }>("/api/publication-preview", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const quarterId = request.query.quarterId;
        if (!validText(quarterId, 120) || !quarterId)
            return reply.code(400).send({ error: "Не указана четверть" });
        const state = await publicationState(db, quarterId);
        if (!state.quarters.some((quarter) => quarter.id === quarterId))
            return reply.code(404).send({ error: "Четверть не найдена" });
        const previous = await readPublishedQuarter(db, quarterId);
        reply.header("cache-control", "no-store");
        return analyzePublication(state, quarterId, previous);
    });
    app.get<{
        Params: {
            quarterId: string;
        };
    }>("/api/publications/:quarterId", async (request, reply) => {
        if (!await getSession(request))
            return reply.code(401).send({ error: "Требуется вход администратора" });
        const publication = await readPublishedQuarter(db, request.params.quarterId);
        if (!publication)
            return reply.code(404).send({ error: "Опубликованное расписание не найдено" });
        reply.header("cache-control", "no-store");
        return publication;
    });
    app.post<{
        Body: {
            quarterId?: unknown;
            revision?: unknown;
            requestId?: unknown;
        };
    }>("/api/publications", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !validText(body.quarterId, 120) || !body.quarterId ||
            !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId))
            return reply.code(400).send({ error: "Некорректный запрос публикации" });
        const quarterId = body.quarterId;
        const revision = Number(body.revision);
        const requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ quarterId, revision }));
        const earlyReplay = await db.prepare("SELECT fingerprint,response_json FROM publication_replays WHERE request_id=?")
            .get(requestId) as {
            fingerprint: string;
            response_json: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор публикации уже использован" });
            return reply.send(JSON.parse(earlyReplay.response_json) as PublishResponse);
        }
        try {
            const result = await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint,response_json FROM publication_replays WHERE request_id=?")
                    .get(requestId) as {
                    fingerprint: string;
                    response_json: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("publication-replay-conflict");
                    return { replay: JSON.parse(replay.response_json) as PublishResponse };
                }
                const state = await publicationState(db, quarterId);
                if (state.revision !== revision)
                    throw new Error("publication-revision-conflict");
                if (!state.quarters.some((quarter) => quarter.id === quarterId))
                    throw new Error("publication-quarter-missing");
                const previous = await readPublishedQuarter(db, quarterId);
                const preview = analyzePublication(state, quarterId, previous);
                if (!preview.canPublish)
                    throw Object.assign(new Error("publication-invalid"), { preview });
                const unchanged = Boolean(previous && preview.summary.added === 0 && preview.summary.removed === 0 &&
                    preview.summary.changed === 0 && !preview.summary.settingsChanged);
                if (previous && unchanged) {
                    const response: PublishResponse = { publication: previous.publication, summary: preview.summary, unchanged: true };
                    await db.prepare("INSERT INTO publication_replays(request_id,fingerprint,response_json) VALUES(?,?,?)")
                        .run(requestId, fingerprint, JSON.stringify(response));
                    return { response };
                }
                const nextVersion = (previous?.publication.version ?? 0) + 1;
                const publishedAt = nowIso();
                const publication: PublicationMetadata = {
                    quarterId,
                    version: nextVersion,
                    publishedAt,
                    draftRevision: revision,
                    publishedBy: session.username,
                };
                const snapshot = createPublicationSnapshot(state, quarterId);
                const response: PublishResponse = { publication, summary: preview.summary };
                await db.prepare(`INSERT INTO published_quarters(quarter_id,version,published_at,draft_revision,published_by,snapshot_json,summary_json,print_index_json)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(quarter_id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
          draft_revision=excluded.draft_revision,published_by=excluded.published_by,snapshot_json=excluded.snapshot_json,summary_json=excluded.summary_json,print_index_json=excluded.print_index_json`)
                    .run(quarterId, nextVersion, publishedAt, revision, session.username, JSON.stringify(snapshot), JSON.stringify(preview.summary), JSON.stringify(createPublicationPrintIndex(snapshot)));
                await db.prepare("INSERT INTO publication_replays(request_id,fingerprint,response_json) VALUES(?,?,?)")
                    .run(requestId, fingerprint, JSON.stringify(response));
                return { response };
            })();
            return reply.send("replay" in result ? result.replay : result.response);
        }
        catch (error) {
            if (error instanceof Error && error.message === "publication-replay-conflict")
                return reply.code(409).send({ error: "Этот идентификатор публикации уже использован" });
            if (error instanceof Error && error.message === "publication-revision-conflict")
                return reply.code(409).send({ error: "Черновик изменился. Обновите предпросмотр публикации" });
            if (error instanceof Error && error.message === "publication-quarter-missing")
                return reply.code(404).send({ error: "Четверть не найдена" });
            if (error instanceof Error && error.message === "publication-invalid") {
                const preview = (error as Error & {
                    preview?: unknown;
                }).preview;
                return reply.code(422).send({ error: "Расписание содержит ошибки и не может быть опубликовано", preview });
            }
            throw error;
        }
    });
    app.put<{
        Body: SaveBody;
    }>("/api/state", { bodyLimit: MAX_STATE_BODY_BYTES }, async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) ||
            !Number.isInteger(body.revision) ||
            Number(body.revision) < 0 ||
            !validText(body.requestId, 100) ||
            !/^[\w.-]{8,100}$/.test(body.requestId))
            return reply.code(400).send({ error: "Некорректный запрос" });
        if (body.schedule === undefined)
            return reply.code(400).send({ error: "Некорректное расписание" });
        const earlyFingerprint = hash(JSON.stringify(body.schedule));
        const earlyReplay = await db
            .prepare("SELECT fingerprint,revision,updated_at FROM request_replays WHERE request_id=?")
            .get(body.requestId) as {
            fingerprint: string;
            revision: number;
            updated_at: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== earlyFingerprint)
                return reply
                    .code(409)
                    .send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send({
                revision: earlyReplay.revision,
                updatedAt: earlyReplay.updated_at,
            });
        }
        const currentRevision = await db
            .prepare("SELECT revision FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
        };
        if (currentRevision.revision !== body.revision)
            return reply
                .code(409)
                .send({ error: "Расписание уже изменено. Обновите страницу" });
        const reference = await readSchedule(db);
        const catalog = await readCatalog(db);
        if (!validateSchedule(body.schedule, reference, catalog, await readQuarters(db), await readStudyPlans(db)))
            return reply
                .code(400)
                .send({ error: "Расписание содержит недопустимые данные" });
        const nextRoomSchedule = roomResolvedSchedule(body.schedule as Schedule, reference, catalog);
        const previousRoomSchedule = roomResolvedSchedule(reference, reference, catalog);
        if (!nextRoomSchedule || !previousRoomSchedule)
            return reply
                .code(400)
                .send({ error: "Укажите кабинет для каждого нового урока" });
        const unavailabilityViolation = newUnavailabilityViolation(nextRoomSchedule, previousRoomSchedule, catalog);
        if (unavailabilityViolation)
            return reply.code(400).send({
                error: unavailabilityViolationMessage(unavailabilityViolation, catalog),
            });
        const roomConflict = newRoomConflict(nextRoomSchedule, previousRoomSchedule);
        if (roomConflict)
            return reply
                .code(400)
                .send({ error: roomConflictMessage(roomConflict, catalog) });
        const suitabilityViolation = newRoomSuitabilityViolation(nextRoomSchedule, previousRoomSchedule, catalog);
        if (suitabilityViolation)
            return reply.code(400).send({
                error: roomSuitabilityViolationMessage(suitabilityViolation, catalog),
            });
        const teacherConflict = newTeacherConflict(nextRoomSchedule, previousRoomSchedule);
        if (teacherConflict)
            return reply
                .code(400)
                .send({ error: teacherConflictMessage(teacherConflict, catalog) });
        const fingerprint = hash(JSON.stringify(body.schedule));
        const requestId = body.requestId;
        const updatedAt = nowIso();
        try {
            const result = await db.transaction(async () => {
                const replay = await db
                    .prepare("SELECT fingerprint, revision, updated_at FROM request_replays WHERE request_id = ?")
                    .get(requestId) as {
                    fingerprint: string;
                    revision: number;
                    updated_at: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return { revision: replay.revision, updatedAt: replay.updated_at };
                }
                const meta = await db
                    .prepare("SELECT revision FROM draft_metadata WHERE id = 1")
                    .get() as {
                    revision: number;
                };
                if (meta.revision !== body.revision)
                    throw new Error("revision-conflict");
                await writeSchedule(db, nextRoomSchedule);
                const nextRevision = meta.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision = ?, updated_at = ? WHERE id = 1").run(nextRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id, fingerprint, revision, updated_at) VALUES(?, ?, ?, ?)").run(requestId, fingerprint, nextRevision, updatedAt);
                return { revision: nextRevision, updatedAt };
            })();
            return reply.send(result);
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply
                    .code(409)
                    .send({ error: "Расписание уже изменено. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply
                    .code(409)
                    .send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
    });
    app.post<{
        Body: {
            calendar?: unknown;
            revision?: unknown;
        };
    }>("/api/calendar/preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        const catalog = await readCatalog(db);
        if (!isRecord(body))
            return reply.code(400).send({ error: "Некорректный календарь" });
        const error = validateCalendar(body.calendar, catalog);
        if (error)
            return reply.code(400).send({ error });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (body.revision !== meta.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите календарь" });
        const calendar = body.calendar as SchoolCalendar;
        const { schedule: _schedule, ...preview } = applyCalendar(await readSchedule(db, catalog, await calendarAffectedDates(db, calendar)), calendar);
        reply.header("cache-control", "no-store");
        return preview;
    });
    app.post<{
        Body: {
            settings?: unknown;
            apply?: unknown;
            revision?: unknown;
        };
    }>("/api/bell-settings/preview", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !isRecord(body.apply))
            return reply.code(400).send({ error: "Некорректное применение звонков" });
        const catalog = await readCatalog(db), settings = normalizeBellSettings(body.settings);
        const error = settings ? validateBellSettings(settings, catalog) : "Некорректные настройки звонков";
        if (error)
            return reply.code(400).send({ error });
        const raw = body.apply;
        if (!Array.isArray(raw.groupIds) || !raw.groupIds.length || raw.groupIds.length > catalog.groups.length ||
            raw.groupIds.some((id) => typeof id !== "string" || !catalog.groups.some((entry) => entry.id === id)) ||
            new Set(raw.groupIds).size !== raw.groupIds.length || !validDate(raw.startDate) || !validDate(raw.endDate) ||
            raw.startDate > raw.endDate || typeof raw.replaceStart !== "boolean" || typeof raw.resetBreaks !== "boolean")
            return reply.code(400).send({ error: "Некорректный период или список групп" });
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (body.revision !== meta.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите настройки" });
        const options: BellApplyOptions = { groupIds: raw.groupIds as string[], startDate: raw.startDate, endDate: raw.endDate, replaceStart: raw.replaceStart, resetBreaks: raw.resetBreaks };
        try {
            const { schedule: _schedule, ...preview } = applyBellSettings(await readSchedule(db, catalog, await bellAffectedDates(db, options)), settings!, options, catalog);
            reply.header("cache-control", "no-store");
            return preview;
        }
        catch (reason) {
            return reply.code(400).send({ error: reason instanceof Error ? reason.message : "Не удалось проверить звонки" });
        }
    });
    app.put<{
        Body: CalendarBody;
    }>("/api/calendar", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) ||
            typeof body.confirmLessonRemoval !== "boolean")
            return reply.code(400).send({ error: "Некорректный запрос" });
        const snapshot = { calendar: body.calendar, confirmLessonRemoval: body.confirmLessonRemoval };
        const fingerprint = hash(JSON.stringify(snapshot));
        const requestId = body.requestId;
        const earlyReplay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(await pageState(request, "calendar"));
        }
        const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (current.revision !== body.revision)
            return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
        const catalog = await readCatalog(db);
        const calendarError = validateCalendar(body.calendar, catalog);
        if (calendarError)
            return reply.code(400).send({ error: calendarError });
        const calendar = body.calendar as SchoolCalendar;
        const reference = await readSchedule(db, catalog, await calendarAffectedDates(db, calendar));
        const preview = applyCalendar(reference, calendar);
        if (preview.removedCount && body.confirmLessonRemoval !== true)
            return reply.code(409).send({
                error: "Календарь снимет занятия. Подтвердите удаление и повторите сохранение.",
                removedCount: preview.removedCount,
                changedDays: preview.changedDays.filter((day) => day.removedCount > 0),
                jointChanges: preview.jointChanges,
            });
        const updatedAt = nowIso();
        try {
            await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
                    fingerprint: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return;
                }
                const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (meta.revision !== body.revision)
                    throw new Error("revision-conflict");
                await db.prepare("UPDATE school_calendar SET calendar_json=? WHERE id=1").run(JSON.stringify(calendar));
                await persistScheduleDelta(db, reference, preview.schedule);
                const nextRevision = meta.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, nextRevision, updatedAt);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
        reply.header("cache-control", "no-store");
        return reply.send(await pageState(request, "calendar"));
    });
    app.put<{
        Body: BellSettingsBody;
    }>("/api/bell-settings", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) ||
            body.settings === undefined || (body.apply !== undefined && !isRecord(body.apply)))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const catalog = await readCatalog(db);
        const normalizedSettings = normalizeBellSettings(body.settings);
        const settingsError = !normalizedSettings ? "Настройки звонков должны содержать общие настройки" : validateBellSettings(normalizedSettings, catalog);
        if (settingsError)
            return reply.code(400).send({ error: settingsError });
        const settings = normalizedSettings!;
        let applyOptions: BellApplyOptions | undefined;
        if (body.apply !== undefined) {
            const raw = body.apply as Record<string, unknown>;
            const groupIds = raw.groupIds;
            if (!Array.isArray(groupIds) || groupIds.length < 1 || groupIds.length > catalog.groups.length ||
                groupIds.some(id => typeof id !== "string") || new Set(groupIds).size !== groupIds.length ||
                groupIds.some(id => !catalog.groups.some(group => group.id === id)) ||
                !validDate(raw.startDate) || !validDate(raw.endDate) || raw.startDate > raw.endDate ||
                typeof raw.replaceStart !== "boolean" || typeof raw.resetBreaks !== "boolean")
                return reply.code(400).send({ error: "Некорректный период или список групп для применения звонков" });
            applyOptions = {
                groupIds: groupIds as string[], startDate: raw.startDate, endDate: raw.endDate,
                replaceStart: raw.replaceStart, resetBreaks: raw.resetBreaks,
            };
        }
        const requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ settings, apply: applyOptions }));
        const earlyReplay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            reply.header("cache-control", "no-store");
            return reply.send(await pageState(request, "bells"));
        }
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision)
            return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
        const reference = applyOptions ? await readSchedule(db, catalog, await bellAffectedDates(db, applyOptions)) : {};
        let nextSchedule = reference;
        if (applyOptions) {
            try {
                const applied = applyBellSettings(reference, settings, applyOptions, catalog);
                nextSchedule = applied.schedule;
            }
            catch (error) {
                return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось применить расписание звонков" });
            }
            if (!validateSchedule(nextSchedule, reference, catalog, await readQuarters(db), await readStudyPlans(db)))
                return reply.code(400).send({ error: "Новое расписание звонков создаёт недопустимые интервалы" });
            const resolved = roomResolvedSchedule(nextSchedule, reference, catalog);
            const oldResolved = roomResolvedSchedule(reference, reference, catalog);
            if (!resolved || !oldResolved)
                return reply.code(400).send({ error: "Не удалось проверить кабинеты для нового расписания" });
            const unavailabilityViolation = newUnavailabilityViolation(resolved, oldResolved, catalog);
            if (unavailabilityViolation)
                return reply.code(400).send({ error: unavailabilityViolationMessage(unavailabilityViolation, catalog) });
            const roomConflict = newRoomConflict(resolved, oldResolved);
            if (roomConflict)
                return reply.code(400).send({ error: roomConflictMessage(roomConflict, catalog) });
            const suitabilityViolation = newRoomSuitabilityViolation(resolved, oldResolved, catalog);
            if (suitabilityViolation)
                return reply.code(400).send({ error: roomSuitabilityViolationMessage(suitabilityViolation, catalog) });
            const teacherConflict = newTeacherConflict(resolved, oldResolved);
            if (teacherConflict)
                return reply.code(400).send({ error: teacherConflictMessage(teacherConflict, catalog) });
        }
        const updatedAt = nowIso();
        try {
            await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
                    fingerprint: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return;
                }
                const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (current.revision !== body.revision)
                    throw new Error("revision-conflict");
                await db.prepare("UPDATE bell_settings SET settings_json=? WHERE id=1").run(JSON.stringify(settings));
                if (applyOptions)
                    await persistScheduleDelta(db, reference, nextSchedule);
                const nextRevision = current.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, nextRevision, updatedAt);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
        reply.header("cache-control", "no-store");
        return reply.send(await pageState(request, "bells"));
    });
    app.post<{
        Body: {
            curriculumId?: unknown;
            quarterId?: unknown;
            groupIds?: unknown;
            revision?: unknown;
            requestId?: unknown;
            confirmReplace?: unknown;
        };
    }>("/api/curricula/reuse", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || !validText(body.curriculumId, 120) || !validText(body.quarterId, 120) ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) || !Array.isArray(body.groupIds) ||
            !body.groupIds.length || body.groupIds.length > 500 || body.groupIds.some((id) => typeof id !== "string") ||
            new Set(body.groupIds).size !== body.groupIds.length || (body.confirmReplace !== undefined && typeof body.confirmReplace !== "boolean"))
            return reply.code(400).send({ error: "Проверьте план, четверть и выбранные группы" });
        const quarterId = body.quarterId, requestId = body.requestId;
        const fingerprint = hash(JSON.stringify({ operation: "reuse-curriculum", ...body, requestId: undefined }));
        const replay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (replay) {
            if (replay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(await adminState(db, { view: "plans", quarterId }));
        }
        const revision = (await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        }).revision;
        if (revision !== body.revision)
            return reply.code(409).send({ error: "Данные изменились. Обновите страницу" });
        const previous = await readCurricula(db), catalog = await readCatalog(db), quarters = await readQuarters(db);
        const source = previous.find((item) => item.id === body.curriculumId);
        if (!source || !quarters.some((item) => item.id === quarterId && !item.archived))
            return reply.code(400).send({ error: "Выберите существующий план и активную четверть" });
        const groupIds = body.groupIds as string[];
        const family = source.templateId ?? source.id;
        const existing = previous.find((item) => item.quarterId === quarterId && (item.templateId ?? item.id) === family);
        const currentPlans = await readStudyPlans(db);
        const replacing = groupIds.filter((groupId) => currentPlans.some((plan) => plan.groupId === groupId && plan.quarterId === quarterId) && !existing?.groupIds.includes(groupId));
        if (replacing.length && body.confirmReplace !== true)
            return reply.code(409).send({ error: "Подтвердите замену существующих планов групп", replacementGroupIds: replacing });
        const application: Curriculum = existing ? { ...existing, templateId: family, groupIds: [...new Set([...existing.groupIds, ...groupIds])] } : {
            ...source, id: crypto.randomUUID(), templateId: family, quarterId, groupIds,
            rows: source.rows.map((row) => ({ ...row, id: crypto.randomUUID(), subgroupIdsByGroup: row.subgroupIdsByGroup ? Object.fromEntries(Object.entries(row.subgroupIdsByGroup).filter(([id]) => groupIds.includes(id))) : undefined })),
        };
        const next: Curriculum[] = previous.filter((item) => item.id !== existing?.id).map((item) => {
            const ids = item.quarterId === quarterId ? item.groupIds.filter((id) => !groupIds.includes(id)) : item.groupIds;
            return { ...item, templateId: (item.templateId ?? item.id) === family ? family : item.templateId, groupIds: ids,
                rows: item.rows.map((row) => ({ ...row, subgroupIdsByGroup: row.subgroupIdsByGroup ? Object.fromEntries(Object.entries(row.subgroupIdsByGroup).filter(([id]) => ids.includes(id))) : undefined })) };
        });
        next.push(application);
        const validation = validateCurricula(next, catalog, quarters, previous);
        if (validation)
            return reply.code(400).send({ error: validation });
        const projected = projectCurricula(next, currentPlans, catalog);
        await db.transaction(async () => {
            const committed = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
                fingerprint: string;
            } | undefined;
            if (committed) {
                if (committed.fingerprint !== fingerprint)
                    throw Object.assign(new Error("Этот идентификатор запроса уже использован"), { statusCode: 409 });
                return;
            }
            const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                revision: number;
            };
            if (current.revision !== body.revision)
                throw Object.assign(new Error("Данные изменились. Обновите страницу"), { statusCode: 409 });
            await writeCurriculaProjection(db, next, projected);
            const updatedAt = nowIso();
            await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(current.revision + 1, updatedAt);
            await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, current.revision + 1, updatedAt);
        })();
        return reply.send(await adminState(db, { view: "plans", quarterId }));
    });
    app.put<{
        Body: CurriculaBody;
    }>("/api/curricula", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) || !Number.isInteger(body.revision) || Number(body.revision) < 0 ||
            !validText(body.requestId, 100) || !/^[\w.-]{8,100}$/.test(body.requestId) ||
            (body.confirmGroupReplacement !== undefined && typeof body.confirmGroupReplacement !== "boolean"))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const scopeQuarterId = typeof body.scopeQuarterId === "string" ? body.scopeQuarterId : undefined;
        if (body.scopeQuarterId !== undefined && (!scopeQuarterId || !(await readQuarters(db)).some((quarter) => quarter.id === scopeQuarterId) ||
            !Array.isArray(body.curricula) || body.curricula.some((entry) => !isRecord(entry) || entry.quarterId !== scopeQuarterId)))
            return reply.code(400).send({ error: "Некорректная область учебных планов" });
        const snapshot = { curricula: body.curricula, confirmGroupReplacement: body.confirmGroupReplacement === true, scopeQuarterId };
        const fingerprint = hash(JSON.stringify(snapshot)), requestId = body.requestId;
        const earlyReplay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(await pageState(request, "plans", scopeQuarterId));
        }
        const meta = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
            revision: number;
        };
        if (meta.revision !== body.revision)
            return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
        const previousCurricula = await readCurricula(db);
        const proposedCurricula = scopeQuarterId
            ? [...(await readCurricula(db)).filter((entry) => entry.quarterId !== scopeQuarterId), ...(body.curricula as Curriculum[])]
            : body.curricula as Curriculum[];
        if (!Array.isArray(proposedCurricula))
            return reply.code(400).send({ error: "Некорректный список планов" });
        const inputValidation = validateCurricula(proposedCurricula, await readCatalog(db), await readQuarters(db), previousCurricula);
        if (inputValidation)
            return reply.code(400).send({ error: inputValidation });
        const curricula = syncCurriculumTemplates(proposedCurricula, previousCurricula, scopeQuarterId);
        const validation = validateCurricula(curricula, await readCatalog(db), await readQuarters(db), await readCurricula(db));
        if (validation)
            return reply.code(400).send({ error: validation });
        const currentPlans = await readStudyPlans(db);
        const replacements = replacementGroups(curricula, await readCurricula(db), currentPlans);
        if (replacements.length && body.confirmGroupReplacement !== true)
            return reply.code(409).send({ error: "Назначение плана заменит существующие планы выбранных групп", replacementGroupIds: replacements });
        const projected = projectCurricula(curricula, currentPlans, await readCatalog(db));
        const updatedAt = nowIso();
        try {
            await db.transaction(async () => {
                const replay = await db.prepare("SELECT fingerprint FROM request_replays WHERE request_id=?").get(requestId) as {
                    fingerprint: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return;
                }
                const current = await db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as {
                    revision: number;
                };
                if (current.revision !== body.revision)
                    throw new Error("revision-conflict");
                await writeCurriculaProjection(db, curricula, projected);
                const nextRevision = current.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, nextRevision, updatedAt);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
        reply.header("cache-control", "no-store");
        return reply.send(await pageState(request, "plans", scopeQuarterId));
    });
    app.put<{
        Body: PlansBody;
    }>("/api/plans", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) ||
            !Number.isInteger(body.revision) ||
            Number(body.revision) < 0 ||
            !validText(body.requestId, 100) ||
            !/^[\w.-]{8,100}$/.test(body.requestId))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const scopeQuarterId = typeof body.scopeQuarterId === "string" ? body.scopeQuarterId : undefined;
        const responseQuarterId = typeof body.responseQuarterId === "string" ? body.responseQuarterId : scopeQuarterId;
        if (body.scopeQuarterId !== undefined && (!scopeQuarterId || !(await readQuarters(db)).some((quarter) => quarter.id === scopeQuarterId) ||
            !Array.isArray(body.studyPlans) || body.studyPlans.some((entry) => !isRecord(entry) || entry.quarterId !== scopeQuarterId)))
            return reply.code(400).send({ error: "Некорректная область учебных планов" });
        if (body.responseQuarterId !== undefined && (!responseQuarterId || !Array.isArray(body.quarters) ||
            !body.quarters.some((entry) => isRecord(entry) && entry.id === responseQuarterId)))
            return reply.code(400).send({ error: "Четверть не найдена" });
        if (body.metadataOnly !== undefined && typeof body.metadataOnly !== "boolean")
            return reply.code(400).send({ error: "Некорректный запрос четверти" });
        const snapshot = { quarters: body.quarters, studyPlans: body.studyPlans, scopeQuarterId, responseQuarterId,
            metadataOnly: body.metadataOnly === true ? true : undefined };
        const fingerprint = hash(JSON.stringify(snapshot)), requestId = body.requestId, updatedAt = nowIso();
        const earlyReplay = await db
            .prepare("SELECT fingerprint FROM request_replays WHERE request_id=?")
            .get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (earlyReplay) {
            if (earlyReplay.fingerprint !== fingerprint)
                return reply
                    .code(409)
                    .send({ error: "Этот идентификатор запроса уже использован" });
            return reply.send(await pageState(request, "plans", responseQuarterId));
        }
        const currentRevision = await db
            .prepare("SELECT revision FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
        };
        if (currentRevision.revision !== body.revision)
            return reply
                .code(409)
                .send({ error: "Данные уже изменены. Обновите страницу" });
        const nextPlans = body.metadataOnly === true ? await readStudyPlans(db) : scopeQuarterId
            ? [...(await readStudyPlans(db)).filter((entry) => entry.quarterId !== scopeQuarterId), ...(body.studyPlans as StudyPlan[])]
            : body.studyPlans;
        if (!await validatePlanSnapshot(body.quarters, nextPlans, db))
            return reply
                .code(400)
                .send({ error: "План содержит недопустимые данные" });
        if (await managedPlansChanged(nextPlans, db))
            return reply.code(409).send({ error: "Этот план назначен группе через общий учебный план. Измените его на странице планов групп." });
        try {
            await db.transaction(async () => {
                const replay = await db
                    .prepare("SELECT fingerprint FROM request_replays WHERE request_id=?")
                    .get(requestId) as {
                    fingerprint: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return;
                }
                const meta = await db
                    .prepare("SELECT revision FROM draft_metadata WHERE id=1")
                    .get() as {
                    revision: number;
                };
                if (meta.revision !== body.revision)
                    throw new Error("revision-conflict");
                const qs = body.quarters as Quarter[], plans = nextPlans as StudyPlan[];
                const putQuarter = db.prepare("INSERT INTO quarters(id,name,start_date,end_date,archived) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_date=excluded.start_date,end_date=excluded.end_date,archived=excluded.archived");
                for (const q of qs)
                    await putQuarter.run(q.id, q.name, q.startDate, q.endDate, q.archived ? 1 : 0);
                if (body.metadataOnly !== true) {
                    await db.prepare("DELETE FROM study_plans").run();
                    const putPlan = db.prepare("INSERT INTO study_plans(id,quarter_id,group_id,subject_id,mode,lesson_kind,room_kind) VALUES(?,?,?,?,?,?,NULL)");
                    const putAssignment = db.prepare("INSERT INTO plan_assignments(id,plan_id,subgroup_id,target) VALUES(?,?,?,?)");
                    for (const plan of plans) {
                        await putPlan.run(plan.id, plan.quarterId, plan.groupId, plan.subjectId, plan.mode, plan.lessonKind);
                        for (const a of plan.assignments)
                            await putAssignment.run(a.id, plan.id, a.subgroupId, a.target);
                    }
                    await wrapOrphanPlans(db);
                }
                await fillQuarterWeeks(db, qs);
                const nextRevision = meta.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(nextRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, nextRevision, updatedAt);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply
                    .code(409)
                    .send({ error: "Данные уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply
                    .code(409)
                    .send({ error: "Этот идентификатор запроса уже использован" });
            throw error;
        }
        reply.header("cache-control", "no-store");
        return reply.send(await pageState(request, "plans", responseQuarterId));
    });
    app.put<{
        Body: CatalogBody;
    }>("/api/catalog", async (request, reply) => {
        if (!isSameOrigin(request))
            return reply.code(403).send({ error: "Недопустимый источник запроса" });
        const session = await getSession(request);
        if (!session)
            return reply.code(401).send({ error: "Требуется вход администратора" });
        if (request.headers["x-csrf-token"] !== session.csrfToken)
            return reply.code(403).send({ error: "Проверка запроса не пройдена" });
        const body = request.body;
        if (!isRecord(body) ||
            !Number.isInteger(body.revision) ||
            Number(body.revision) < 0 ||
            !validText(body.requestId, 100) ||
            !/^[\w.-]{8,100}$/.test(body.requestId))
            return reply.code(400).send({ error: "Некорректный запрос" });
        const before = await readCatalog(db);
        const normalizedCatalog = isRecord(body.catalog) && Array.isArray(body.catalog.subjects)
            ? {
                ...body.catalog,
                subjects: body.catalog.subjects.map((subject) => isRecord(subject)
                    ? {
                        ...subject,
                        jointGroupSets: subject.jointGroupSets ?? [],
                        jointSameGrade: subject.jointSameGrade ?? false,
                        maxJointGroups: subject.maxJointGroups ?? 2,
                        iconId: subject.iconId === undefined
                            ? before.subjects.find((entry) => entry.id === subject.id)?.iconId
                            : subject.iconId,
                    }
                    : subject),
                teachers: Array.isArray(body.catalog.teachers)
                    ? body.catalog.teachers.map((teacher) => isRecord(teacher)
                        ? {
                            ...teacher,
                            preferredGroupIds: teacher.preferredGroupIds ?? [],
                            unavailability: teacher.unavailability === undefined
                                ? before.teachers.find((entry) => entry.id === teacher.id)?.unavailability ?? []
                                : teacher.unavailability,
                        }
                        : teacher)
                    : body.catalog.teachers,
                rooms: Array.isArray(body.catalog.rooms)
                    ? body.catalog.rooms.map((room) => isRecord(room)
                        ? {
                            ...room,
                            unavailability: room.unavailability === undefined
                                ? before.rooms.find((entry) => entry.id === room.id)?.unavailability ?? []
                                : room.unavailability,
                        }
                        : room)
                    : body.catalog.rooms,
            }
            : body.catalog;
        const next = normalizedCatalog as Catalog;
        const fingerprint = hash(`catalog:${JSON.stringify(next)}`);
        const requestId = body.requestId;
        const replay = await db
            .prepare("SELECT fingerprint FROM request_replays WHERE request_id=?")
            .get(requestId) as {
            fingerprint: string;
        } | undefined;
        if (replay) {
            if (replay.fingerprint !== fingerprint)
                return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
            reply.header("cache-control", "no-store");
            return reply.send(await pageState(request, "catalog"));
        }
        const currentRevision = await db
            .prepare("SELECT revision FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
        };
        if (currentRevision.revision !== body.revision)
            return reply.code(409).send({ error: "Данные уже изменены. Обновите страницу" });
        if (!isRecord(next) || (["subjects", "teachers", "rooms", "groups", "subgroups"] as const).some((kind) => !Array.isArray(next[kind]) || (next[kind] as unknown[]).some((entry) => !isRecord(entry) || typeof entry.id !== "string")))
            return reply.code(400).send({ error: "Справочники содержат недопустимые данные" });
        const deletionError = async (current: Catalog) => {
            if (current.groups.some((group) => !group.archived) && !next.groups.some((group) => !group.archived))
                return "Нельзя удалить или архивировать последнюю действующую группу";
            const removed = (["subjects", "teachers", "rooms", "groups", "subgroups"] as const)
                .some((kind) => current[kind].some((entry) => !next[kind].some((row) => row.id === entry.id)));
            if (!removed)
                return null;
            const blockers = await catalogDeletionBlockers(db, current);
            for (const kind of ["subjects", "teachers", "rooms", "groups", "subgroups"] as const) {
                const remaining = new Set(next[kind].map((entry) => entry.id));
                for (const entry of current[kind])
                    if (!remaining.has(entry.id)) {
                        const reasons = blockers[kind]?.[entry.id] ?? [];
                        if (reasons.length)
                            return `Нельзя удалить «${entry.name}»: запись используется (${reasons.join(", ")})`;
                    }
            }
            return null;
        };
        const blocked = await deletionError(before);
        if (blocked)
            return reply.code(400).send({ error: blocked });
        if (!validateCatalog(normalizedCatalog, before))
            return reply
                .code(400)
                .send({ error: "Справочники содержат недопустимые данные" });
        const curriculumError = validateCurricula(await readCurricula(db), next, await readQuarters(db), await readCurricula(db));
        if (curriculumError)
            return reply.code(400).send({ error: curriculumError });
        // Availability changes do not affect catalogue links or curriculum
        // assignments. Avoid rebuilding unrelated data for this common dialog save.
        const withoutAvailability = (catalog: Catalog) => ({
            ...catalog,
            subjects: catalog.subjects.map(({ iconId, ...subject }) => iconId === undefined ? subject : { ...subject, iconId }),
            teachers: catalog.teachers.map(({ unavailability: _rules, ...teacher }) => teacher),
            rooms: catalog.rooms.map(({ unavailability: _rules, ...room }) => room),
        });
        const availabilityOnly = stableJson(withoutAvailability(before)) === stableJson(withoutAvailability(next));
        const affectedProjectionGroups = new Set<string>();
        const previousGroups = new Map(before.groups.map(group => [group.id, group]));
        const nextGroups = new Map(next.groups.map(group => [group.id, group]));
        for (const id of new Set([...previousGroups.keys(), ...nextGroups.keys()]))
            if (previousGroups.has(id) !== nextGroups.has(id) || previousGroups.get(id)?.archived !== nextGroups.get(id)?.archived)
                affectedProjectionGroups.add(id);
        const subgroupProjection = (catalog: Catalog, groupId: string) => catalog.subgroups
            .filter(subgroup => subgroup.groupId === groupId)
            .map(subgroup => [subgroup.id, subgroup.archived] as const)
            .sort((a, b) => a[0].localeCompare(b[0]));
        for (const id of new Set([...before.subgroups.map(subgroup => subgroup.groupId), ...next.subgroups.map(subgroup => subgroup.groupId)]))
            if (stableJson(subgroupProjection(before, id)) !== stableJson(subgroupProjection(next, id)))
                affectedProjectionGroups.add(id);
        const updatedAt = nowIso();
        try {
            await db.transaction(async () => {
                const replay = await db
                    .prepare("SELECT fingerprint FROM request_replays WHERE request_id=?")
                    .get(requestId) as {
                    fingerprint: string;
                } | undefined;
                if (replay) {
                    if (replay.fingerprint !== fingerprint)
                        throw new Error("idempotency-conflict");
                    return;
                }
                const meta = await db
                    .prepare("SELECT revision FROM draft_metadata WHERE id=1")
                    .get() as {
                    revision: number;
                };
                if (meta.revision !== body.revision)
                    throw new Error("revision-conflict");
                if (availabilityOnly) {
                    for (const kind of ["teachers", "rooms"] as const) {
                        const previous = new Map(before[kind].map((entry) => [entry.id, entry.unavailability ?? []]));
                        const table = kind === "teachers" ? "catalog_teachers" : "catalog_rooms";
                        const update = db.prepare(`UPDATE ${table} SET unavailability_json=? WHERE id=?`);
                        for (const entry of next[kind]) {
                            const rules = entry.unavailability ?? [];
                            if (stableJson(previous.get(entry.id)) !== stableJson(rules))
                                await update.run(JSON.stringify(rules), entry.id);
                        }
                    }
                }
                else {
                    const blocked = await deletionError(await readCatalog(db));
                    if (blocked)
                        throw new Error(`catalog-deletion-blocked:${blocked}`);
                    const oldGroups = new Map(before.groups.map((entry) => [entry.id, entry]));
                    const upsertSubject = db.prepare("INSERT INTO catalog_subjects(id,name,short_name,color,room_kind,lab_room_kind,joint_group_sets,joint_same_grade,max_joint_groups,icon_id,archived) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,short_name=excluded.short_name,color=excluded.color,room_kind=excluded.room_kind,lab_room_kind=excluded.lab_room_kind,joint_group_sets=excluded.joint_group_sets,joint_same_grade=excluded.joint_same_grade,max_joint_groups=excluded.max_joint_groups,icon_id=excluded.icon_id,archived=excluded.archived");
                    const oldSubjects = new Map(before.subjects.map((entry) => [entry.id, entry]));
                    for (const entry of next.subjects) {
                        if (!oldSubjects.has(entry.id) || stableJson(oldSubjects.get(entry.id)) !== stableJson(entry))
                            await upsertSubject.run(entry.id, entry.name, entry.shortName, entry.color, entry.roomKind, entry.labRoomKind, JSON.stringify(entry.jointGroupSets ?? []), Number(entry.jointSameGrade ?? false), entry.maxJointGroups ?? 2, entry.iconId === null ? "none" : entry.iconId ?? null, Number(entry.archived));
                    }
                    const upsertRoom = db.prepare("INSERT INTO catalog_rooms(id,name,capacity,kind,archived,unavailability_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,capacity=excluded.capacity,kind=excluded.kind,archived=excluded.archived,unavailability_json=excluded.unavailability_json");
                    const oldRooms = new Map(before.rooms.map((entry) => [entry.id, entry]));
                    for (const entry of next.rooms) {
                        if (!oldRooms.has(entry.id) || stableJson(oldRooms.get(entry.id)) !== stableJson(entry))
                            await upsertRoom.run(entry.id, entry.name, entry.capacity, entry.kind, Number(entry.archived), JSON.stringify(entry.unavailability ?? []));
                    }
                    // Rooms must exist before teachers and groups that reference them.
                    // Keep this dependency order inside the transaction so a valid catalog
                    // can introduce linked rows together without a transient FK failure.
                    const upsertTeacher = db.prepare("INSERT INTO catalog_teachers(id,name,archived,default_room_id,preferred_group_ids,preferred_shift,unavailability_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,archived=excluded.archived,default_room_id=excluded.default_room_id,preferred_group_ids=excluded.preferred_group_ids,preferred_shift=excluded.preferred_shift,unavailability_json=excluded.unavailability_json");
                    const oldTeachers = new Map(before.teachers.map((entry) => [entry.id, entry]));
                    for (const entry of next.teachers) {
                        if (!oldTeachers.has(entry.id) || stableJson(oldTeachers.get(entry.id)) !== stableJson(entry))
                            await upsertTeacher.run(entry.id, entry.name, Number(entry.archived), entry.defaultRoomId, JSON.stringify(entry.preferredGroupIds ?? []), entry.preferredShift ?? null, JSON.stringify(entry.unavailability ?? []));
                    }
                    const upsertGroup = db.prepare("INSERT INTO catalog_groups(id,name,students,leader_id,room_id,archived) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,students=excluded.students,leader_id=excluded.leader_id,room_id=excluded.room_id,archived=excluded.archived");
                    for (const entry of next.groups) {
                        if (!oldGroups.has(entry.id) || stableJson(oldGroups.get(entry.id)) !== stableJson(entry))
                            await upsertGroup.run(entry.id, entry.name, entry.students, entry.leaderId, entry.roomId, Number(entry.archived));
                    }
                    const oldGroupsById = new Map(before.groups.map((entry) => [entry.id, entry]));
                    const deleteAutoRoom = db.prepare("DELETE FROM catalog_group_auto_rooms WHERE group_id=? AND room_id=?");
                    const insertAutoRoom = db.prepare("INSERT INTO catalog_group_auto_rooms(group_id,room_id,position) VALUES(?,?,?)");
                    const updateAutoRoom = db.prepare("UPDATE catalog_group_auto_rooms SET position=? WHERE group_id=? AND room_id=?");
                    for (const entry of next.groups) {
                        const oldPositions = new Map((oldGroupsById.get(entry.id)?.autoRoomIds ?? []).map((roomId, position) => [roomId, position]));
                        const newPositions = new Map(entry.autoRoomIds.map((roomId, position) => [roomId, position]));
                        for (const roomId of oldPositions.keys())
                            if (!newPositions.has(roomId)) await deleteAutoRoom.run(entry.id, roomId);
                        for (const [roomId, position] of newPositions) {
                            if (!oldPositions.has(roomId)) await insertAutoRoom.run(entry.id, roomId, position);
                            else if (oldPositions.get(roomId) !== position) await updateAutoRoom.run(position, entry.id, roomId);
                        }
                    }
                    const upsertSubgroup = db.prepare("INSERT INTO catalog_subgroups(id,group_id,name,students,archived) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,students=excluded.students,archived=excluded.archived");
                    const oldSubgroups = new Map(before.subgroups.map((entry) => [entry.id, entry]));
                    for (const entry of next.subgroups) {
                        if (!oldSubgroups.has(entry.id) || stableJson(oldSubgroups.get(entry.id)) !== stableJson(entry))
                            await upsertSubgroup.run(entry.id, entry.groupId, entry.name, entry.students, Number(entry.archived));
                    }
                    for (const entry of next.groups)
                        if (!oldGroups.has(entry.id))
                            await addGroupSchedule(db, entry.id);
                    const renameBaseline = db.prepare("UPDATE plan_baselines SET subgroup=? WHERE group_id=? AND subgroup=?");
                    for (const entry of next.subgroups) {
                        const old = oldSubgroups.get(entry.id);
                        if (old && old.name !== entry.name)
                            await renameBaseline.run(entry.name, old.groupId, old.name);
                    }
                    if (affectedProjectionGroups.size)
                        await reprojectCurriculumAssignments(db, next, affectedProjectionGroups);
                    const oldTeacherSubjects = new Map(before.teachers.map(teacher => [teacher.id, new Set(teacher.subjectIds)]));
                    const nextTeacherSubjects = new Map(next.teachers.map(teacher => [teacher.id, new Set(teacher.subjectIds)]));
                    const deleteTeacherSubject = db.prepare("DELETE FROM catalog_teacher_subjects WHERE teacher_id=? AND subject_id=?");
                    const insertTeacherSubject = db.prepare("INSERT INTO catalog_teacher_subjects(teacher_id,subject_id) VALUES(?,?)");
                    for (const teacherId of new Set([...oldTeacherSubjects.keys(), ...nextTeacherSubjects.keys()])) {
                        const oldSubjects = oldTeacherSubjects.get(teacherId) ?? new Set<string>();
                        const newSubjects = nextTeacherSubjects.get(teacherId) ?? new Set<string>();
                        for (const subjectId of oldSubjects)
                            if (!newSubjects.has(subjectId)) await deleteTeacherSubject.run(teacherId, subjectId);
                        for (const subjectId of newSubjects)
                            if (!oldSubjects.has(subjectId)) await insertTeacherSubject.run(teacherId, subjectId);
                    }
                    for (const [kind, column, reference] of [
                        ["subgroups", "subgroup", "subgroup_ref"],
                        ["teachers", "teacher", "teacher_ref"],
                        ["rooms", "room", "room_ref"],
                    ] as const) {
                        const oldNames = new Map(before[kind].map((entry) => [entry.id, entry.name]));
                        const updateLabel = db.prepare(`UPDATE lessons SET ${column}=? WHERE ${reference}=? AND ${column} IS NOT ?`);
                        for (const entry of next[kind])
                            if (oldNames.get(entry.id) !== entry.name)
                                await updateLabel.run(entry.name, entry.id, entry.name);
                    }
                    for (const kind of ["subjects", "teachers", "rooms", "subgroups"] as const) {
                        const keep = new Set(next[kind].map((entry) => entry.id));
                        const remove = before[kind].filter((entry) => !keep.has(entry.id));
                        const table = ({ subjects: "catalog_subjects", teachers: "catalog_teachers", rooms: "catalog_rooms", subgroups: "catalog_subgroups" } as const)[kind];
                        const del = db.prepare(`DELETE FROM ${table} WHERE id=?`);
                        for (const entry of remove) {
                            await del.run(entry.id);
                        }
                    }
                    const keepGroups = new Set(next.groups.map((entry) => entry.id));
                    const removedGroups = before.groups.filter((entry) => !keepGroups.has(entry.id));
                    const deleteGroupDays = db.prepare("DELETE FROM schedule_days WHERE group_id=?");
                    for (const entry of removedGroups) {
                        await deleteGroupDays.run(entry.id);
                    }
                    const deleteGroup = db.prepare("DELETE FROM catalog_groups WHERE id=?");
                    for (const entry of removedGroups) {
                        await deleteGroup.run(entry.id);
                    }
                }
                const newRevision = meta.revision + 1;
                await db.prepare("UPDATE draft_metadata SET revision=?,updated_at=? WHERE id=1").run(newRevision, updatedAt);
                await db.prepare("INSERT INTO request_replays(request_id,fingerprint,revision,updated_at) VALUES(?,?,?,?)").run(requestId, fingerprint, newRevision, updatedAt);
            })();
        }
        catch (error) {
            if (error instanceof Error && error.message === "revision-conflict")
                return reply
                    .code(409)
                    .send({ error: "Данные уже изменены. Обновите страницу" });
            if (error instanceof Error && error.message === "idempotency-conflict")
                return reply
                    .code(409)
                    .send({ error: "Этот идентификатор запроса уже использован" });
            if (error instanceof Error && error.message.startsWith("catalog-deletion-blocked:"))
                return reply.code(400).send({ error: error.message.slice("catalog-deletion-blocked:".length) });
            throw error;
        }
        if ((request.query as {
            response?: string;
        })?.response === "compact")
            return reply.send(await adminState(db, { view: "catalog" }));
        const meta = await db
            .prepare("SELECT revision,updated_at FROM draft_metadata WHERE id=1")
            .get() as {
            revision: number;
            updated_at: string;
        };
        reply.header("cache-control", "no-store");
        return reply.send({
            schedule: await readSchedule(db),
            baseline: await readBaseline(db),
            catalog: await readCatalog(db),
            catalogDeletionBlockers: await catalogDeletionBlockers(db),
            quarters: await readQuarters(db),
            studyPlans: await readStudyPlans(db),
            curricula: await readCurricula(db),
            calendar: await readSchoolCalendar(db),
            revision: meta.revision,
            updatedAt: meta.updated_at,
        });
    });
    if (options.serveStatic) {
        const root = resolve(options.staticRoot ?? "dist");
        if (existsSync(root)) {
            await app.register(fastifyStatic, {
                root,
                prefix: "/",
                index: ["index.html"],
            });
            app.setNotFoundHandler(async (request, reply) => {
                if (request.method === "GET" &&
                    !request.url.startsWith("/api/") &&
                    request.headers.accept?.includes("text/html"))
                    return reply.type("text/html").sendFile("index.html");
                return reply.code(404).send({ error: "Не найдено" });
            });
        }
    }
    return app;
}
