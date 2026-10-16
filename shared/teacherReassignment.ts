import type { Catalog } from "./catalog.ts";
import { teacherLabel } from "./catalog.ts";
import { findUnavailability } from "./unavailability.ts";
import { findTeacherConflicts } from "./teacherConflicts.ts";
import { roomSuitabilityReason } from "./roomSuitability.ts";
import type { Quarter } from "./plans.ts";
import type { EditorLesson, Schedule } from "../src/editor.ts";

export type TeacherTeachingAssignment = {
  id: string;
  sourceTeacherId: string;
  targetTeacherId: string;
  groupId: string;
  subjectId: string;
  subgroupId?: string;
  subgroup?: string;
  startDate: string;
  endDate: string | null;
  absenceRuleId?: string;
};

export type TeacherLessonOrigin = {
  id: string;
  lessonId: string;
  groupId: string;
  date: string;
  sourceTeacherId: string;
  substituteTeacherId: string;
  kind: "absence" | "transfer";
  absenceRuleId?: string;
  startDate: string;
  endDate: string | null;
  expected: string;
  status: "active" | "manual" | "returned";
};

export type TeacherReassignmentRequest =
  | {
      mode: "assign";
      quarterId: string;
      subjectId: string;
      sourceTeacherId?: string;
      groupIds?: string[];
      scope: "lesson" | "week" | "period";
      lessonId?: string;
      lessonIds?: string[];
      weekStart?: string;
      startDate?: string;
      endDate?: string | null;
      targetTeacherId?: string;
      unitTeacherIds?: Record<string, string | null>;
      persist?: boolean;
    }
  | {
      mode: "return";
      sourceTeacherId: string;
      returnDate: string;
      ruleId?: string;
      subjectId?: string;
      groupIds?: string[];
    };

export type TeacherReassignmentState = {
  schedule: Schedule;
  catalog: Catalog;
  quarters: Quarter[];
  /** Injectable clock for deterministic previews and tests; defaults to local today. */
  today?: string;
  teachingAssignments?: TeacherTeachingAssignment[];
  teacherLessonOrigins?: TeacherLessonOrigin[];
};

export type ReassignmentLesson = {
  id: string;
  lessonIds: string[];
  groupIds: string[];
  subjectId: string;
  date: string;
  start: number;
  end: number;
  teacherId?: string;
  originalTeacherId?: string;
  subgroupIds: string[];
  subgroups: string[];
  roomIds: string[];
  jointId?: string;
};

export type TeacherReassignmentUnit = {
  id: string;
  lessonIds: string[];
  groupIds: string[];
  subjectId: string;
  date: string;
  start: number;
  end: number;
  sourceTeacherId?: string;
  teacherId?: string;
  subgroupIds?: string[];
  subgroups?: string[];
  reason?: string;
  availableTeacherIds?: string[];
};

export type TeacherReassignmentCandidate = {
  id: string;
  name: string;
  available: number;
  total: number;
  reason?: string;
};

export type TeacherReassignmentPreview = {
  schedule: Schedule;
  catalog: Catalog;
  units: TeacherReassignmentUnit[];
  changedLessonIds: string[];
  skipped: { lessonId: string; reason: string }[];
  candidates: TeacherReassignmentCandidate[];
  canApply: boolean;
  policyWarnings?: string[];
  ruleChanged?: boolean;
  teachingAssignments: TeacherTeachingAssignment[];
  teacherLessonOrigins: TeacherLessonOrigin[];
};

export type TeacherReassignmentPreviewCache = {
  candidateSummaries: Map<string, TeacherReassignmentCandidate[]>;
  rowAvailability: Map<string, string[]>;
};

export function createTeacherReassignmentPreviewCache(): TeacherReassignmentPreviewCache {
  return { candidateSummaries: new Map(), rowAvailability: new Map() };
}

// The caller discards its cache on a draft revision change. A different state
// instance also invalidates all calculations, even when the scope is identical.
const preparedIndexes = new WeakMap<TeacherReassignmentPreviewCache, { state: TeacherReassignmentState; index: ReassignmentIndex }>();
function requestIndex(state: TeacherReassignmentState, cache?: TeacherReassignmentPreviewCache): ReassignmentIndex {
  const prepared = cache && preparedIndexes.get(cache);
  if (prepared?.state === state) return prepared.index;
  const index = createIndex(state.schedule, state.teacherLessonOrigins);
  if (cache) {
    if (prepared) { cache.candidateSummaries.clear(); cache.rowAvailability.clear(); }
    preparedIndexes.set(cache, { state, index });
  }
  return index;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  if (map.size > 128) map.delete(map.keys().next().value!);
  return value;
}

type Located = {
  groupId: string;
  dayKey: string;
  dayIndex: number;
  slotIndex: number;
  date: string;
  start: number;
  end: number;
  lesson: EditorLesson;
};

type ReassignmentIndex = {
  located: Located[];
  units: ReassignmentLesson[];
  membersByUnit: Map<string, Located[]>;
  locatedByLesson: Map<string, Located[]>;
  occupancyByDateTeacher: Map<string, ReturnType<typeof occupancyOf>[]>;
  occupancyByDate: Map<string, ReturnType<typeof occupancyOf>[]>;
  unitsByGroupStream: Map<string, ReassignmentLesson[]>;
};

type CurrentTeachers = Map<string, string | undefined> & { movedIn: Map<string, ReturnType<typeof occupancyOf>[]> };

function currentTeachersFor(index: ReassignmentIndex): CurrentTeachers {
  const teachers = new Map(index.located.map(item => [item.lesson.id, item.lesson.teacherId])) as CurrentTeachers;
  teachers.movedIn = new Map();
  return teachers;
}

function setCurrentTeacher(index: ReassignmentIndex, teachers: CurrentTeachers, lessonId: string, teacherId: string | undefined): void {
  teachers.set(lessonId, teacherId);
  for (const item of index.locatedByLesson.get(lessonId) ?? []) {
    if (!teacherId || teacherId === item.lesson.teacherId) continue;
    const key = `${item.date}\0${teacherId}`;
    const bucket = teachers.movedIn.get(key) ?? [];
    bucket.push(occupancyOf(item));
    teachers.movedIn.set(key, bucket);
  }
}

function occupancyOf(item: Located) {
  return { lessonId: item.lesson.id, groupId: item.groupId, date: item.date, roomId: item.lesson.roomId, start: item.start, end: item.end, jointId: item.lesson.jointId, subjectId: item.lesson.subjectId, event: item.lesson.event, lessonKind: item.lesson.lessonKind, teacherId: item.lesson.teacherId };
}

function createIndex(schedule: Schedule, origins: TeacherLessonOrigin[] = []): ReassignmentIndex {
  const located = locate(schedule);
  const units = buildUnitsFromLocated(located, origins);
  const membersByUnit = new Map<string, Located[]>();
  const unitsByGroupStream = new Map<string, ReassignmentLesson[]>();
  const byLesson = new Map<string, Located[]>();
  for (const item of located) {
    const entries = byLesson.get(item.lesson.id) ?? [];
    entries.push(item);
    byLesson.set(item.lesson.id, entries);
  }
  for (const unit of units) {
    const members = unit.lessonIds.flatMap(id => byLesson.get(id) ?? []);
    membersByUnit.set(unit.id, members);
    for (const groupId of unit.groupIds) {
      const member = members.find(item => item.groupId === groupId);
      if (!member) continue;
      const key = [groupId, unit.subjectId, member.lesson.subgroupId ?? member.lesson.subgroup ?? ""].join("\0");
      const bucket = unitsByGroupStream.get(key) ?? [];
      bucket.push(unit);
      unitsByGroupStream.set(key, bucket);
    }
  }
  const occupancyByDateTeacher = new Map<string, ReturnType<typeof occupancyOf>[]>();
  const occupancyByDate = new Map<string, ReturnType<typeof occupancyOf>[]>();
  for (const item of located) {
    const occupancy = occupancyOf(item);
    const key = `${item.date}\0${item.lesson.teacherId ?? ""}`;
    const bucket = occupancyByDateTeacher.get(key) ?? [];
    bucket.push(occupancy);
    occupancyByDateTeacher.set(key, bucket);
    const dateBucket = occupancyByDate.get(item.date) ?? [];
    dateBucket.push(occupancy);
    occupancyByDate.set(item.date, dateBucket);
  }
  return { located, units, membersByUnit, locatedByLesson: byLesson, occupancyByDateTeacher, occupancyByDate, unitsByGroupStream };
}

function locate(schedule: Schedule): Located[] {
  const out: Located[] = [];
  for (const [dayKey, days] of Object.entries(schedule)) {
    const groupId = dayKey.slice(0, dayKey.lastIndexOf(":"));
    days.forEach((day, dayIndex) => day.slots.forEach((slot, slotIndex) => {
      const time = day.times[slotIndex];
      if (!time) return;
      slot.forEach(lesson => out.push({ groupId, dayKey, dayIndex, slotIndex, date: day.date, start: time.start, end: time.start + time.duration, lesson }));
    }));
  }
  return out;
}

function unitKey(item: Located): string {
  return item.lesson.jointId ? `joint:${item.date}:${item.lesson.jointId}` : `lesson:${item.groupId}:${item.date}:${item.lesson.id}`;
}

function lessonFingerprint(item: Pick<Located, "groupId" | "date" | "start" | "end" | "lesson">): string {
  const l = item.lesson;
  return JSON.stringify([item.groupId, item.date, item.start, item.end, l.id, l.subjectId, l.lessonKind ?? "regular", l.teacherId || l.teacher || "", l.roomId || l.room || "", l.subgroupId || l.subgroup || "", l.event ?? "", l.jointId ?? "", l.note ?? ""]);
}

export function teacherLessonFingerprint(input: { groupId: string; date: string; start: number; end: number; lesson: EditorLesson }): string {
  return lessonFingerprint(input);
}

function buildUnitsFromLocated(located: Located[], origins: TeacherLessonOrigin[] = []): ReassignmentLesson[] {
  const byLesson = new Map(origins.map(origin => [origin.lessonId, origin]));
  const groups = new Map<string, Located[]>();
  for (const item of located) {
    const key = unitKey(item);
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  return [...groups.values()].map(items => {
    const first = items[0]!;
    const teacherIds = new Set(items.map(item => item.lesson.teacherId ?? ""));
    const originalIds = new Set(items.map(item => byLesson.get(item.lesson.id)?.sourceTeacherId ?? item.lesson.teacherId ?? ""));
    return {
      id: unitKey(first), lessonIds: items.map(item => item.lesson.id), groupIds: [...new Set(items.map(item => item.groupId))],
      subjectId: first.lesson.subjectId, date: first.date, start: first.start, end: first.end,
      teacherId: teacherIds.size === 1 ? first.lesson.teacherId : undefined,
      originalTeacherId: originalIds.size === 1 ? (first.lesson.teacherId ? byLesson.get(first.lesson.id)?.sourceTeacherId ?? first.lesson.teacherId : undefined) : undefined,
      subgroupIds: [...new Set(items.flatMap(item => item.lesson.subgroupId ? [item.lesson.subgroupId] : []))],
      subgroups: [...new Set(items.flatMap(item => item.lesson.subgroup ? [item.lesson.subgroup] : []))],
      roomIds: [...new Set(items.flatMap(item => item.lesson.roomId ? [item.lesson.roomId] : []))],
      jointId: first.lesson.jointId,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.id.localeCompare(b.id));
}

function buildUnits(schedule: Schedule, origins: TeacherLessonOrigin[] = []): ReassignmentLesson[] {
  return buildUnitsFromLocated(locate(schedule), origins);
}

export function collectReassignmentLessons(schedule: Schedule, _catalog: Catalog, origins?: TeacherLessonOrigin[]): ReassignmentLesson[] {
  return buildUnits(schedule, origins);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateTeacherReassignmentRequest(state: TeacherReassignmentState, request: TeacherReassignmentRequest, cache = createTeacherReassignmentPreviewCache()): string[] {
  const errors: string[] = [];
  if (!request || typeof request !== "object" || !["assign", "return"].includes((request as { mode?: string }).mode ?? "")) return ["Неизвестный тип переназначения."];
  const groupValue = (request as { groupIds?: unknown }).groupIds;
  const groupIds = Array.isArray(groupValue) ? groupValue : [];
  if (groupValue !== undefined && !Array.isArray(groupValue)) errors.push("Список групп должен быть массивом идентификаторов.");
  if (groupIds.some(id => typeof id !== "string" || !id.trim()) || new Set(groupIds).size !== groupIds.length || groupIds.some(id => !state.catalog.groups.some(group => group.id === id))) errors.push("Список групп содержит неизвестные или повторяющиеся идентификаторы.");
  if (request.mode === "assign") {
    if (typeof request.quarterId !== "string" || !request.quarterId.trim()) errors.push("Укажите четверть.");
    if (typeof request.subjectId !== "string" || !request.subjectId.trim()) errors.push("Укажите предмет.");
    if (request.sourceTeacherId !== undefined && (typeof request.sourceTeacherId !== "string" || !request.sourceTeacherId.trim())) errors.push("Идентификатор исходного преподавателя некорректен.");
    if (request.targetTeacherId !== undefined && (typeof request.targetTeacherId !== "string" || !request.targetTeacherId.trim())) errors.push("Идентификатор преподавателя для замены некорректен.");
    const quarter = state.quarters.find(item => item.id === request.quarterId);
    if (!quarter) errors.push("Четверть не найдена.");
    if (!state.catalog.subjects.some(subject => subject.id === request.subjectId)) errors.push("Предмет не найден.");
    if (request.sourceTeacherId && !state.catalog.teachers.some(teacher => teacher.id === request.sourceTeacherId)) errors.push("Исходный преподаватель не найден.");
    if (!(["lesson", "week", "period"] as string[]).includes(request.scope)) errors.push("Неизвестная область переназначения.");
    if (request.targetTeacherId && !state.catalog.teachers.some(teacher => teacher.id === request.targetTeacherId && !teacher.archived)) errors.push("Преподаватель для замены отсутствует или архивирован.");
    if (request.scope === "lesson" && !(request.lessonId || request.lessonIds?.length)) errors.push("Для переназначения урока укажите его идентификатор.");
    if (request.lessonIds !== undefined && (!Array.isArray(request.lessonIds) || request.lessonIds.some(id => typeof id !== "string" || !id.trim()) || new Set(request.lessonIds).size !== request.lessonIds.length)) errors.push("Список уроков содержит некорректные или повторяющиеся идентификаторы.");
    if (request.lessonId && !requestIndex(state, cache).locatedByLesson.has(request.lessonId)) errors.push("Выбранный урок не найден в расписании.");
    if (Array.isArray(request.lessonIds) && request.lessonIds.some(id => !requestIndex(state, cache).locatedByLesson.has(id))) errors.push("Список содержит уроки, которых нет в расписании.");
    if (request.scope === "week" && (!isIsoDate(request.weekStart) || dateOfMonday(request.weekStart) !== request.weekStart)) errors.push("Укажите корректную дату понедельника выбранной недели.");
    if (request.scope !== "period" && (request.startDate !== undefined || request.endDate !== undefined)) errors.push("Начало и конец периода допустимы только для переназначения периода.");
    if (request.scope === "week" && request.endDate !== undefined) errors.push("Конец периода допустим только для переназначения периода.");
    if (request.scope === "period") {
      const start = request.startDate ?? quarter?.startDate;
      const end = request.endDate === undefined ? quarter?.endDate : request.endDate;
      if (request.startDate !== undefined && !isIsoDate(request.startDate)) errors.push("Укажите корректную дату начала периода.");
      if (request.endDate !== undefined && request.endDate !== null && !isIsoDate(request.endDate)) errors.push("Укажите корректную дату окончания периода.");
      if (start && end && end !== null && start > end) errors.push("Дата окончания периода раньше даты начала.");
      if (request.startDate && quarter && (request.startDate < quarter.startDate || request.startDate > quarter.endDate)) errors.push("Начало периода должно находиться внутри выбранной четверти.");
      if (typeof end === "string" && quarter && (end < quarter.startDate || end > quarter.endDate)) errors.push("Окончание периода должно находиться внутри выбранной четверти.");
    }
    if (request.persist !== undefined && typeof request.persist !== "boolean") errors.push("Признак сохранения переназначения некорректен.");
    if (request.unitTeacherIds !== undefined) {
      const map = request.unitTeacherIds as unknown;
      const isPlainObject = Boolean(map && typeof map === "object" && !Array.isArray(map) && (Object.getPrototypeOf(map) === Object.prototype || Object.getPrototypeOf(map) === null));
      if (!isPlainObject) errors.push("Список преподавателей для уроков должен быть объектом.");
      else {
        const eligible = requestIndex(state, cache).units.filter(unit => {
          if (unit.subjectId !== request.subjectId || !quarter || !dateInQuarter(unit.date, quarter)) return false;
          if (request.sourceTeacherId && unit.teacherId !== request.sourceTeacherId) return false;
          if (groupIds.length && !unit.groupIds.some(id => groupIds.includes(id))) return false;
          if (request.scope === "lesson" && !unit.lessonIds.includes(request.lessonId ?? "") && !unit.lessonIds.some(id => request.lessonIds?.includes(id))) return false;
          if (request.lessonIds?.length && !unit.lessonIds.some(id => request.lessonIds!.includes(id))) return false;
          if (request.scope === "week" && (unit.date < (request.weekStart ?? "") || unit.date > addDays(request.weekStart ?? "", 6))) return false;
          if (request.scope === "period" && (unit.date < (request.startDate ?? quarter.startDate) || (request.endDate !== null && unit.date > (request.endDate ?? quarter.endDate)))) return false;
          return true;
        });
        const eligibleIds = new Set(eligible.map(unit => unit.id));
        for (const [unitId, teacherId] of Object.entries(map as Record<string, unknown>)) {
          if (!unitId.trim() || !eligibleIds.has(unitId)) { errors.push("Выбран урок вне области переназначения."); continue; }
          if (teacherId !== null && (typeof teacherId !== "string" || !teacherId.trim())) { errors.push("Идентификатор преподавателя для урока некорректен."); continue; }
          if (typeof teacherId === "string") {
            const teacher = state.catalog.teachers.find(item => item.id === teacherId && !item.archived);
            if (!teacher) errors.push("Преподаватель для замены отсутствует или архивирован.");
            else if (!teacher.subjectIds.includes(request.subjectId)) errors.push("Преподаватель не ведёт предмет одного из уроков.");
          }
        }
        if (!request.targetTeacherId && Object.keys(map as object).length === 0) errors.push("Укажите преподавателя для замены уроков.");
      }
    }
    const selectedIds = new Set([...(request.lessonId ? [request.lessonId] : []), ...(Array.isArray(request.lessonIds) ? request.lessonIds : [])]);
    if (selectedIds.size) {
      const selectedUnits = requestIndex(state, cache).units.filter(unit => unit.lessonIds.some(id => selectedIds.has(id)));
      const quarter = state.quarters.find(item => item.id === request.quarterId);
      if (selectedUnits.some(unit => unit.subjectId !== request.subjectId || !quarter || !dateInQuarter(unit.date, quarter))) errors.push("Выбранные уроки не соответствуют предмету или четверти.");
      if (request.sourceTeacherId && selectedUnits.some(unit => unit.teacherId !== request.sourceTeacherId)) errors.push("Выбранные уроки ведут не выбранные сейчас преподавателем.");
      if (groupIds.length && selectedUnits.some(unit => !unit.groupIds.some(id => groupIds.includes(id)))) errors.push("Выбранные уроки не относятся к указанным группам.");
      if (request.scope === "week" && isIsoDate(request.weekStart) && selectedUnits.some(unit => unit.date < request.weekStart! || unit.date > addDays(request.weekStart!, 6))) errors.push("Выбранные уроки находятся вне указанной недели.");
    }
  } else {
    if (typeof request.sourceTeacherId !== "string" || !request.sourceTeacherId.trim()) errors.push("Укажите исходного преподавателя.");
    const teacher = state.catalog.teachers.find(item => item.id === request.sourceTeacherId);
    if (!teacher) errors.push("Исходный преподаватель не найден.");
    if (!isIsoDate(request.returnDate)) errors.push("Укажите корректную дату возвращения.");
    if (request.ruleId && !teacher?.unavailability?.some(rule => rule.id === request.ruleId) &&
      !(state.teacherLessonOrigins ?? []).some(origin => origin.sourceTeacherId === request.sourceTeacherId && origin.kind === "absence" && origin.absenceRuleId === request.ruleId) &&
      !(state.teachingAssignments ?? []).some(assignment => assignment.sourceTeacherId === request.sourceTeacherId && assignment.absenceRuleId === request.ruleId))
      errors.push("Период недоступности не найден у выбранного преподавателя.");
    if (request.subjectId && !state.catalog.subjects.some(subject => subject.id === request.subjectId)) errors.push("Предмет не найден.");
  }
  return errors;
}

function cloneSchedule(schedule: Schedule): Schedule {
  return Object.fromEntries(Object.entries(schedule).map(([key, days]) => [key, days.map(day => ({ ...day, slots: day.slots.map(slot => slot.map(lesson => ({ ...lesson }))) }))]));
}

function updateIndexedLessons(schedule: Schedule, members: Located[], teacher: { id: string; name: string } | undefined): void {
  for (const item of members) {
    const lesson = schedule[item.dayKey]?.[item.dayIndex]?.slots[item.slotIndex]?.find(entry => entry.id === item.lesson.id);
    if (lesson) {
      lesson.teacherId = teacher?.id;
      lesson.teacher = teacher ? teacherLabel(teacher.name) : undefined;
    }
  }
}

function dateOfMonday(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday);
  return day.toISOString().slice(0, 10);
}

function addDays(date: string, amount: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
}

function localToday(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function policyFor(request: Extract<TeacherReassignmentRequest, { mode: "assign" }>, unit: ReassignmentLesson, targetTeacherId: string, quarter: Quarter, catalog: Catalog, index: ReassignmentIndex, origins: TeacherLessonOrigin[]): TeacherTeachingAssignment[] {
  if (request.persist === false || request.scope === "lesson") return [];
  // Per-unit choices can differ within one stream; persist them only for the
  // selected date so a later row cannot overwrite a broader future rule.
  const perUnit = request.unitTeacherIds !== undefined;
  const startDate = perUnit ? unit.date : request.scope === "week" ? request.weekStart! : request.startDate ?? quarter.startDate;
  const endDate = perUnit ? unit.date : request.scope === "week" ? addDays(startDate, 6) : request.endDate === undefined ? quarter.endDate : request.endDate;
  const permanentTransfer = request.scope === "period" && request.endDate === null;
  const located = index.membersByUnit.get(unit.id) ?? [];
  return unit.groupIds.map(groupId => {
    const member = located.find(item => item.groupId === groupId);
    const subgroupId = member?.lesson.subgroupId;
    const subgroup = member?.lesson.subgroup;
    const linkedOrigins = origins.filter(origin => unit.lessonIds.includes(origin.lessonId) && origin.groupId === groupId && origin.status === "active" && origin.kind === "absence" && origin.substituteTeacherId === targetTeacherId && origin.absenceRuleId);
    const linkedSources = new Set(linkedOrigins.map(origin => origin.sourceTeacherId));
    const linkedRules = new Set(linkedOrigins.map(origin => origin.absenceRuleId!));
    const memberIds = located.filter(item => unit.lessonIds.includes(item.lesson.id) && item.groupId === groupId).map(item => item.lesson.id);
    const hasCompleteAbsenceLineage = memberIds.length > 0 && memberIds.every(id => linkedOrigins.some(origin => origin.lessonId === id));
    const sourceTeacherId = !permanentTransfer && hasCompleteAbsenceLineage && linkedSources.size === 1 && linkedRules.size === 1
      ? [...linkedSources][0]!
      : request.sourceTeacherId ?? unit.teacherId ?? "";
    const absenceRuleId = permanentTransfer ? undefined : hasCompleteAbsenceLineage && linkedSources.size === 1 && linkedRules.size === 1
      ? [...linkedRules][0]!
      : findUnavailability(catalog, "teacher", sourceTeacherId, unit.date, unit.start, unit.end)[0]?.ruleId;
    return {
      id: `reassign:${request.quarterId}:${sourceTeacherId}:${groupId}:${unit.subjectId}:${subgroupId ?? subgroup ?? ""}:${startDate}:${endDate ?? "open"}`,
      sourceTeacherId, targetTeacherId, groupId, subjectId: unit.subjectId,
      ...(subgroupId ? { subgroupId } : {}), ...(subgroup ? { subgroup } : {}), startDate, endDate,
      ...(absenceRuleId ? { absenceRuleId } : {}),
    };
  });
}

function policyIdentity(item: TeacherTeachingAssignment): string {
  return [item.sourceTeacherId, item.groupId, item.subjectId, item.subgroupId ?? item.subgroup ?? "", item.startDate, item.endDate ?? "open", item.absenceRuleId ?? ""].join("\0");
}

function unitsForStream(assignment: TeacherTeachingAssignment, index: ReassignmentIndex): ReassignmentLesson[] {
  const key = [assignment.groupId, assignment.subjectId, assignment.subgroupId ?? assignment.subgroup ?? ""].join("\0");
  return (index.unitsByGroupStream.get(key) ?? []).filter(unit => unit.date >= assignment.startDate && (assignment.endDate === null || unit.date <= assignment.endDate));
}

function skippedUnit(unit: ReassignmentLesson, reason: string): TeacherReassignmentUnit {
  return { id: unit.id, lessonIds: unit.lessonIds, groupIds: unit.groupIds, subjectId: unit.subjectId, date: unit.date, start: unit.start, end: unit.end, sourceTeacherId: unit.teacherId, teacherId: unit.teacherId, subgroupIds: unit.subgroupIds, subgroups: unit.subgroups, reason };
}

function roomReason(unit: ReassignmentLesson, located: Located[], catalog: Catalog): string | undefined {
  const members = located.filter(item => unit.lessonIds.includes(item.lesson.id));
  return members.map(item => roomSuitabilityReason(catalog, {
    subjectId: item.lesson.subjectId, lessonKind: item.lesson.lessonKind, roomId: item.lesson.roomId,
    groupId: item.groupId, groupIds: unit.groupIds, subgroupId: item.lesson.subgroupId, subgroup: item.lesson.subgroup,
  })).find(Boolean) ?? undefined;
}

function mainReason(unit: ReassignmentLesson, teacherId: string, catalog: Catalog, index: ReassignmentIndex, currentTeachers: CurrentTeachers): string | undefined {
  const members = index.membersByUnit.get(unit.id) ?? [];
  if (members.some(item => item.lesson.event || item.lesson.subjectId === "event")) return "Мероприятия нельзя переназначить как обычные уроки.";
  const teacher = catalog.teachers.find(entry => entry.id === teacherId && !entry.archived);
  if (!teacher) return "Преподаватель отсутствует или архивирован.";
  if (members.some(item => !teacher.subjectIds.includes(item.lesson.subjectId))) return "Преподаватель не ведёт предмет одного из уроков.";
  if (unit.jointId && (members.length !== unit.lessonIds.length || members.some(item => item.start !== unit.start || item.end !== unit.end || item.lesson.subjectId !== unit.subjectId || (currentTeachers.get(item.lesson.id) ?? item.lesson.teacherId) !== (currentTeachers.get(members[0]?.lesson.id ?? "") ?? members[0]?.lesson.teacherId)))) return "Объединённые уроки имеют разные время, предмет или текущего преподавателя; исправьте их вместе в расписании.";
  const unavailable = members.flatMap(item => findUnavailability(catalog, "teacher", teacherId, item.date, item.start, item.end));
  if (unavailable.length) return `Преподаватель недоступен${unavailable[0]?.reason ? `: ${unavailable[0].reason}` : " в это время"}.`;
  const movingIds = new Set(unit.lessonIds);
  const conflict = members.flatMap(item => {
    const known = new Map<string, ReturnType<typeof occupancyOf>>();
    for (const entry of [...(index.occupancyByDateTeacher.get(`${item.date}\0${teacherId}`) ?? []), ...(currentTeachers.movedIn.get(`${item.date}\0${teacherId}`) ?? [])]) {
      if (movingIds.has(entry.lessonId) || currentTeachers.get(entry.lessonId) !== teacherId) continue;
      known.set(entry.lessonId, entry);
    }
    const peers = [...known.values()].map(entry => ({ ...entry, teacherId }));
    return findTeacherConflicts(peers, { ...occupancyOf(item), teacherId }, item.lesson.id);
  })[0];
  if (conflict) return "У преподавателя уже есть занятие в это время.";
  return roomReason(unit, members, catalog);
}

function applyTeacher(state: TeacherReassignmentState, units: ReassignmentLesson[], targetTeacherId: string, request: TeacherReassignmentRequest, sourceTeacherId?: string, index = createIndex(state.schedule, state.teacherLessonOrigins)) {
  const schedule = cloneSchedule(state.schedule);
  const currentTeachers = currentTeachersFor(index);
  const changed: string[] = [];
  const skipped: { lessonId: string; reason: string }[] = [];
  const previewUnits: TeacherReassignmentUnit[] = [];
  let assignments = [...(state.teachingAssignments ?? [])];
  let origins = (state.teacherLessonOrigins ?? []).map(origin => ({ ...origin }));
  const succeeded: ReassignmentLesson[] = [];
  for (const unit of units) {
    const teacherId = request.mode === "assign" && request.unitTeacherIds && Object.hasOwn(request.unitTeacherIds, unit.id)
      ? request.unitTeacherIds[unit.id] ?? undefined
      : targetTeacherId;
    if (!teacherId) {
      previewUnits.push({ id: unit.id, lessonIds: unit.lessonIds, groupIds: unit.groupIds, subjectId: unit.subjectId, date: unit.date, start: unit.start, end: unit.end, sourceTeacherId: unit.teacherId, subgroupIds: unit.subgroupIds, subgroups: unit.subgroups });
      unit.lessonIds.forEach(lessonId => skipped.push({ lessonId, reason: "Преподаватель для этого урока не выбран." }));
      continue;
    }
    const teacher = state.catalog.teachers.find(item => item.id === teacherId);
    if (!teacher) continue;
    if (unit.teacherId === teacherId) {
      previewUnits.push({ id: unit.id, lessonIds: unit.lessonIds, groupIds: unit.groupIds, subjectId: unit.subjectId, date: unit.date, start: unit.start, end: unit.end, sourceTeacherId: unit.teacherId, teacherId, subgroupIds: unit.subgroupIds, subgroups: unit.subgroups, reason: "Преподаватель не меняется." });
      continue;
    }
    const members = index.membersByUnit.get(unit.id) ?? [];
    const reason = mainReason(unit, teacherId, state.catalog, index, currentTeachers);
    if (reason) {
      previewUnits.push(skippedUnit(unit, reason));
      unit.lessonIds.forEach(lessonId => skipped.push({ lessonId, reason }));
      continue;
    }
    const oldTeacher = sourceTeacherId ?? unit.teacherId;
    updateIndexedLessons(schedule, members, teacher);
    for (const item of members) {
      setCurrentTeacher(index, currentTeachers, item.lesson.id, teacherId);
      if (!oldTeacher || oldTeacher === teacherId) continue;
      if (request.mode === "assign") {
        const permanentTransfer = request.scope === "period" && request.endDate === null;
        const previousOrigin = permanentTransfer ? undefined : origins.find(origin => origin.lessonId === item.lesson.id && origin.status === "active" && origin.substituteTeacherId === oldTeacher);
        const originSource = previousOrigin?.sourceTeacherId ?? oldTeacher;
        const absenceRuleId = permanentTransfer ? undefined : previousOrigin?.absenceRuleId ?? findUnavailability(state.catalog, "teacher", originSource, item.date, item.start, item.end)[0]?.ruleId;
        origins = origins.map(origin => origin.lessonId === item.lesson.id && origin.status === "active" ? { ...origin, status: "returned" as const } : origin);
        origins.push({ id: `origin:${item.lesson.id}:${item.date}:${teacherId}`, lessonId: item.lesson.id, groupId: item.groupId, date: item.date, sourceTeacherId: originSource, substituteTeacherId: teacherId, kind: absenceRuleId ? "absence" : "transfer", ...(absenceRuleId ? { absenceRuleId } : {}), startDate: item.date, endDate: item.date, expected: teacherLessonFingerprint({ ...item, lesson: { ...item.lesson, teacherId, teacher: teacherLabel(teacher.name) } }), status: "active" });
      }
    }
    changed.push(...unit.lessonIds);
    previewUnits.push({ id: unit.id, lessonIds: unit.lessonIds, groupIds: unit.groupIds, subjectId: unit.subjectId, date: unit.date, start: unit.start, end: unit.end, sourceTeacherId: oldTeacher, teacherId, subgroupIds: unit.subgroupIds, subgroups: unit.subgroups });
    succeeded.push(unit);
  }
  if (request.mode === "assign") {
    const quarter = state.quarters.find(item => item.id === request.quarterId);
    // Stream identity is unchanged by the proposed teacher edits; lineage is
    // supplied separately to policy construction.
    const policyIndex = index;
    const policyWarnings: string[] = [];
    const conflictingPolicyStreams = new Set<string>();
    if (request.unitTeacherIds !== undefined && request.persist !== false && request.scope !== "lesson") {
      const targetsByStream = new Map<string, Set<string>>();
      for (const unit of units) {
        const targetId = Object.hasOwn(request.unitTeacherIds, unit.id) ? request.unitTeacherIds[unit.id] : request.targetTeacherId ?? null;
        for (const groupId of unit.groupIds) {
          const member = (policyIndex.membersByUnit.get(unit.id) ?? []).find(item => item.groupId === groupId);
          const stream = [groupId, unit.subjectId, unit.date, member?.lesson.subgroupId ?? member?.lesson.subgroup ?? ""].join("\0");
          const targets = targetsByStream.get(stream) ?? new Set<string>();
          targets.add(targetId ?? "");
          targetsByStream.set(stream, targets);
        }
      }
      for (const [stream, targets] of targetsByStream) if (targets.size > 1) conflictingPolicyStreams.add(stream);
    }
    const succeededIds = new Set(succeeded.flatMap(candidate => candidate.lessonIds));
    if (quarter) for (const unit of succeeded) {
      const teacherId = request.mode === "assign" && request.unitTeacherIds && Object.hasOwn(request.unitTeacherIds, unit.id) ? request.unitTeacherIds[unit.id] : targetTeacherId;
      if (!teacherId) continue;
      if (conflictingPolicyStreams.size) {
        const hasConflict = unit.groupIds.some(groupId => {
          const member = (policyIndex.membersByUnit.get(unit.id) ?? []).find(item => item.groupId === groupId);
          const stream = [groupId, unit.subjectId, unit.date, member?.lesson.subgroupId ?? member?.lesson.subgroup ?? ""].join("\0");
          return conflictingPolicyStreams.has(stream);
        });
        if (hasConflict) {
          policyWarnings.push("Уроки одной группы по одному предмету в один день назначены разным преподавателям. Изменения будут применены, но автоматически повторить эти назначения для будущих занятий не получится.");
          continue;
        }
      }
      for (const policy of policyFor(request, unit, teacherId, quarter, state.catalog, policyIndex, origins)) {
      const sameStream = unitsForStream(policy, policyIndex);
      if (sameStream.some(candidate => candidate.teacherId !== teacherId && candidate.lessonIds.some(id => !succeededIds.has(id)))) continue;
      const identity = policyIdentity(policy);
      const existing = assignments.findIndex(item => policyIdentity(item) === identity);
      if (existing >= 0) assignments[existing] = policy;
      else assignments.push(policy);
      }
    }
    return { schedule, changed, skipped, previewUnits, assignments, origins, policyWarnings: [...new Set(policyWarnings)] };
  }
  return { schedule, changed, skipped, previewUnits, assignments, origins, policyWarnings: [] as string[] };
}

function dateInQuarter(date: string, quarter: Quarter): boolean { return date >= quarter.startDate && date <= quarter.endDate; }

function assignPreview(state: TeacherReassignmentState, request: Extract<TeacherReassignmentRequest, { mode: "assign" }>, cache?: TeacherReassignmentPreviewCache): TeacherReassignmentPreview {
  const quarter = state.quarters.find(item => item.id === request.quarterId);
  const index = requestIndex(state, cache);
  const all = index.units;
  const allLocated = index.located;
  let selected = all.filter(unit => unit.subjectId === request.subjectId && dateInQuarter(unit.date, quarter ?? { id: "", name: "", startDate: "0000-01-01", endDate: "9999-12-31" }));
  if (request.sourceTeacherId) selected = selected.filter(unit => unit.teacherId === request.sourceTeacherId);
  if (request.groupIds?.length) selected = selected.filter(unit => unit.groupIds.some(group => request.groupIds!.includes(group)));
  if (request.scope === "lesson" && request.lessonId) selected = selected.filter(unit => unit.lessonIds.includes(request.lessonId!));
  if (request.lessonIds?.length) {
    const requested = new Set(request.lessonIds);
    selected = selected.filter(unit => unit.lessonIds.some(id => requested.has(id)));
  }
  if (request.scope === "week") {
    const start = request.weekStart ?? "";
    const end = addDays(start, 6);
    selected = selected.filter(unit => unit.date >= start && unit.date <= end);
  }
  if (request.scope === "period") {
    const start = request.startDate ?? quarter?.startDate ?? "0000-01-01";
    const end = request.endDate ?? quarter?.endDate ?? "9999-12-31";
    selected = selected.filter(unit => unit.date >= start && unit.date <= end);
    if (request.endDate === null) {
      const streams = new Map<string, { groupId: string; subjectId: string; subgroupId?: string; subgroup?: string; sourceTeacherId: string; startDate: string }>();
      for (const anchor of selected) for (const groupId of anchor.groupIds) {
        const member = allLocated.find(item => anchor.lessonIds.includes(item.lesson.id) && item.groupId === groupId);
        if (!member) continue;
        const sourceTeacherId = request.sourceTeacherId ?? anchor.teacherId ?? "";
        if (!sourceTeacherId) continue;
        const stream = { groupId, subjectId: anchor.subjectId, ...(member.lesson.subgroupId ? { subgroupId: member.lesson.subgroupId } : {}), ...(member.lesson.subgroup ? { subgroup: member.lesson.subgroup } : {}), sourceTeacherId, startDate: start };
        streams.set([groupId, anchor.subjectId, member.lesson.subgroupId ?? member.lesson.subgroup ?? "", sourceTeacherId].join("\0"), stream);
      }
      const future = all.filter(unit => unit.date >= start && [...streams.values()].some(stream => {
        if (unit.date === start && unit.lessonIds.some(id => request.lessonIds?.includes(id))) return true;
        if (!unit.groupIds.includes(stream.groupId) || unit.subjectId !== stream.subjectId) return false;
        if (unit.teacherId !== stream.sourceTeacherId && unit.originalTeacherId !== stream.sourceTeacherId) return false;
        const member = allLocated.find(item => unit.lessonIds.includes(item.lesson.id) && item.groupId === stream.groupId);
        if (!member) return false;
        if (stream.subgroupId || member.lesson.subgroupId) return stream.subgroupId === member.lesson.subgroupId;
        return (stream.subgroup ?? "") === (member.lesson.subgroup ?? "");
      }));
      selected = [...new Map([...selected, ...future].map(unit => [unit.id, unit])).values()];
    }
  }
  const guard = request.scope === "week" && !request.sourceTeacherId && !request.groupIds?.length;
  if (guard) selected = [];
  const scopeKey = JSON.stringify([request.quarterId, request.subjectId, request.sourceTeacherId ?? "", request.groupIds ?? [], request.scope, request.lessonId ?? "", request.lessonIds ?? [], request.weekStart ?? "", request.startDate ?? "", request.endDate === undefined ? "undefined" : request.endDate, request.persist ?? "undefined", selected.map(unit => unit.id)]);
  const cachedCandidates = cache?.candidateSummaries.get(scopeKey);
  const candidates = cachedCandidates ?? state.catalog.teachers.filter(teacher => !teacher.archived && teacher.subjectIds.includes(request.subjectId) && selected.some(unit => unit.teacherId !== teacher.id)).map(teacher => {
    const candidateTeachers = currentTeachersFor(index);
    let available = 0;
    let firstReason: string | undefined;
    const candidateUnits = selected.filter(unit => unit.teacherId !== teacher.id);
    for (const unit of candidateUnits) {
      const reason = mainReason(unit, teacher.id, state.catalog, index, candidateTeachers);
      if (reason) { firstReason ??= reason; continue; }
      for (const id of unit.lessonIds) setCurrentTeacher(index, candidateTeachers, id, teacher.id);
      available += 1;
    }
    return { id: teacher.id, name: teacher.name, available, total: candidateUnits.length, ...(available === candidateUnits.length ? {} : { reason: firstReason ?? "Есть конфликт на части уроков." }) };
  });
  if (!cachedCandidates && cache) remember(cache.candidateSummaries, scopeKey, candidates);
  const target = request.targetTeacherId;
  const hasUnitTargets = request.unitTeacherIds !== undefined;
  const applied = target || hasUnitTargets ? applyTeacher(state, hasUnitTargets ? selected : selected.filter(unit => unit.teacherId !== target), target ?? "", request, undefined, index) : undefined;
  const appliedTeachers = currentTeachersFor(index);
  if (applied) for (const id of applied.changed) {
    const location = index.locatedByLesson.get(id)?.[0];
    const teacherId = location ? applied.schedule[location.dayKey]?.[location.dayIndex]?.slots[location.slotIndex]?.find(item => item.id === id)?.teacherId : undefined;
    setCurrentTeacher(index, appliedTeachers, id, teacherId);
  }
  const unitCandidates = selected.map(unit => {
    const occupancySignature = JSON.stringify([unit.lessonIds.map(id => [id, appliedTeachers.get(id)]), (index.occupancyByDate.get(unit.date) ?? []).filter(item => item.start < unit.end && unit.start < item.end).map(item => [item.lessonId, item.start, item.end, appliedTeachers.get(item.lessonId) ?? item.teacherId, item.jointId])]);
    const rowKey = `${scopeKey}\0${unit.id}\0${occupancySignature}`;
    const cachedAvailability = cache?.rowAvailability.get(rowKey);
    const availableTeacherIds = cachedAvailability ?? state.catalog.teachers.filter(teacher => {
      if (teacher.archived || !teacher.subjectIds.includes(unit.subjectId) || teacher.id === unit.teacherId) return false;
      return !mainReason(unit, teacher.id, state.catalog, index, appliedTeachers);
    }).map(teacher => teacher.id);
    if (!cachedAvailability && cache) remember(cache.rowAvailability, rowKey, availableTeacherIds);
    return { unit, availableTeacherIds };
  });
  const unitAvailability = new Map(unitCandidates.map(({ unit, availableTeacherIds }) => [unit.id, availableTeacherIds]));
  const previewUnits = (applied?.previewUnits ?? selected.map(unit => ({ id: unit.id, lessonIds: unit.lessonIds, groupIds: unit.groupIds, subjectId: unit.subjectId, date: unit.date, start: unit.start, end: unit.end, sourceTeacherId: unit.teacherId, subgroupIds: unit.subgroupIds, subgroups: unit.subgroups }))).map(unit => ({ ...unit, availableTeacherIds: [...(unitAvailability.get(unit.id) ?? [])] }));
  const skipped = [...(applied?.skipped ?? []), ...(guard ? [{ lessonId: "", reason: "Для переназначения всей недели выберите преподавателя или хотя бы одну группу." }] : [])];
  return {
    schedule: applied?.schedule ?? state.schedule, catalog: state.catalog, units: previewUnits,
    changedLessonIds: applied?.changed ?? [], skipped, candidates: candidates.map(candidate => ({ ...candidate })),
    canApply: Boolean((target || hasUnitTargets) && applied?.changed.length),
    ...(applied?.policyWarnings?.length ? { policyWarnings: applied.policyWarnings } : {}),
    teachingAssignments: applied?.assignments ?? [...(state.teachingAssignments ?? [])],
    teacherLessonOrigins: applied?.origins ?? [...(state.teacherLessonOrigins ?? [])],
  };
}

function returnPreview(state: TeacherReassignmentState, request: Extract<TeacherReassignmentRequest, { mode: "return" }>): TeacherReassignmentPreview {
  const effectiveDate = request.returnDate > (state.today ?? localToday())
    ? request.returnDate
    : state.today ?? localToday();
  const origins = (state.teacherLessonOrigins ?? []).map(origin => ({ ...origin }));
  const sourceAtStart = state.catalog.teachers.find(teacher => teacher.id === request.sourceTeacherId);
  const relevantRules = new Set([
    ...(sourceAtStart?.unavailability ?? []).filter(rule => rule.startDate <= request.returnDate && rule.endDate >= request.returnDate).map(rule => rule.id),
    ...origins.filter(origin => (origin.status === "active" || origin.status === "manual") && origin.kind === "absence" && origin.sourceTeacherId === request.sourceTeacherId && origin.date >= effectiveDate && origin.absenceRuleId).map(origin => origin.absenceRuleId!),
  ]);
  if (!request.ruleId && relevantRules.size > 1) {
    return {
      schedule: state.schedule, catalog: state.catalog, units: [], changedLessonIds: [],
      skipped: [{ lessonId: "", reason: "У учителя несколько периодов недоступности. Выберите, после какого больничного вернуть уроки." }],
      candidates: [], canApply: false, teachingAssignments: [...(state.teachingAssignments ?? [])], teacherLessonOrigins: origins,
    };
  }
  const selectedRuleId = request.ruleId ?? [...relevantRules][0];
  const matchingOrigins = origins.filter(origin => (origin.status === "active" || origin.status === "manual") && origin.kind === "absence" && origin.sourceTeacherId === request.sourceTeacherId && (!selectedRuleId || origin.absenceRuleId === selectedRuleId) && origin.date >= effectiveDate && (!request.groupIds?.length || request.groupIds.includes(origin.groupId)));
  const lessons = locate(state.schedule);
  const picked: { origin: TeacherLessonOrigin; item?: Located; reason?: string }[] = matchingOrigins.map(origin => {
    if (origin.status === "manual") return { origin, reason: "Замена уже изменялась вручную; проверьте и верните урок отдельно." };
    const item = lessons.find(entry => entry.lesson.id === origin.lessonId && entry.groupId === origin.groupId && entry.date === origin.date);
    if (!item) return { origin, reason: "Занятие удалено или перемещено." };
    if (lessonFingerprint(item) !== origin.expected) return { origin, item, reason: "После замены занятие изменено вручную; проверьте его отдельно." };
    if (item.lesson.teacherId !== origin.substituteTeacherId) return { origin, item, reason: "Урок уже ведёт другой преподаватель." };
    return { origin, item };
  });
  const eligibleIds = new Set(picked.filter(entry => !entry.reason).map(entry => entry.origin.lessonId));
  const allUnits = buildUnits(state.schedule, origins);
  const selectedUnits = allUnits.filter(unit => unit.lessonIds.every(id => eligibleIds.has(id)) && (!request.subjectId || unit.subjectId === request.subjectId));
  const selectedIds = new Set(selectedUnits.flatMap(unit => unit.lessonIds));
  const skipped = picked.filter(entry => entry.reason || !selectedIds.has(entry.origin.lessonId)).map(entry => ({ lessonId: entry.origin.lessonId, reason: entry.reason ?? "Связанный объединённый урок нельзя вернуть отдельно." }));
  const catalog = structuredClone(state.catalog) as Catalog;
  let ruleChanged = false;
  const closedRuleIds = new Set<string>();
  const hasTrackedSelectedRule = Boolean(selectedRuleId && (
    origins.some(origin => origin.sourceTeacherId === request.sourceTeacherId && origin.kind === "absence" && origin.absenceRuleId === selectedRuleId) ||
    (state.teachingAssignments ?? []).some(assignment => assignment.sourceTeacherId === request.sourceTeacherId && assignment.absenceRuleId === selectedRuleId)
  ));
  if (selectedRuleId && hasTrackedSelectedRule) closedRuleIds.add(selectedRuleId);
  const source = catalog.teachers.find(teacher => teacher.id === request.sourceTeacherId);
  if (source?.unavailability) {
    source.unavailability = source.unavailability.flatMap(rule => {
      if (selectedRuleId && rule.id !== selectedRuleId) return [rule];
      const hasMatchingOrigin = rule.id === selectedRuleId || matchingOrigins.some(origin => origin.absenceRuleId === rule.id);
      if (!hasMatchingOrigin) return [rule];
      closedRuleIds.add(rule.id);
      if (request.returnDate <= rule.startDate) { ruleChanged = true; return []; }
      if (request.returnDate > rule.endDate) return [rule];
      ruleChanged = true;
      closedRuleIds.add(rule.id);
      return [{ ...rule, endDate: addDays(request.returnDate, -1) }];
    });
  }
  const returnState: TeacherReassignmentState = { ...state, catalog, teacherLessonOrigins: origins };
  const applied = applyTeacher(returnState, selectedUnits, request.sourceTeacherId, request, request.sourceTeacherId);
  const returnedIds = new Set(applied.changed);
  for (const id of returnedIds) origins.forEach(origin => { if (origin.lessonId === id && origin.status === "active" && origin.sourceTeacherId === request.sourceTeacherId) origin.status = "returned"; });
  for (const entry of picked) if ((entry.reason || !selectedIds.has(entry.origin.lessonId))) {
    const origin = origins.find(item => item.id === entry.origin.id);
    if (origin?.status === "active") origin.status = "manual";
  }
  // Re-check the whole proposed set against the source teacher, allowing joint mirrors together.
  let assignmentsChanged = false;
  const nextAssignments = (state.teachingAssignments ?? []).flatMap(assignment => {
    if (assignment.sourceTeacherId !== request.sourceTeacherId || !assignment.absenceRuleId || !closedRuleIds.has(assignment.absenceRuleId)) return [assignment];
    if (request.returnDate <= assignment.startDate) { assignmentsChanged = true; return []; }
    if (!assignment.endDate || request.returnDate <= assignment.endDate) { assignmentsChanged = true; return [{ ...assignment, endDate: addDays(request.returnDate, -1) }]; }
    return [assignment];
  });
  ruleChanged ||= assignmentsChanged;
  const canApply = applied.changed.length > 0 || ruleChanged;
  return {
    schedule: applied.schedule, catalog, units: applied.previewUnits, changedLessonIds: applied.changed,
    skipped: [...skipped, ...applied.skipped], candidates: [], canApply, ruleChanged,
    teachingAssignments: nextAssignments,
    teacherLessonOrigins: origins,
  };
}

export function previewTeacherReassignment(state: TeacherReassignmentState, request: TeacherReassignmentRequest, cache = createTeacherReassignmentPreviewCache()): TeacherReassignmentPreview {
  const errors = validateTeacherReassignmentRequest(state, request, cache);
  if (errors.length) return {
    schedule: state.schedule, catalog: state.catalog, units: [], changedLessonIds: [],
    skipped: errors.map(reason => ({ lessonId: "", reason })), candidates: [], canApply: false,
    teachingAssignments: [...(state.teachingAssignments ?? [])], teacherLessonOrigins: [...(state.teacherLessonOrigins ?? [])],
  };
  return request.mode === "assign" ? assignPreview(state, request, cache) : returnPreview(state, request);
}
