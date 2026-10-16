import { roomKinds } from "./catalog.ts";
import type { CatalogRoom, CatalogTeacher, RoomKind } from "./catalog.ts";
import type { Quarter, StudyPlan } from "./plans.ts";
import { inQuarter, weekOffsetFor } from "./plans.ts";
import type { StateResponse } from "../server/contracts.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";
import { lessonUnavailability } from "./unavailability.ts";
import { isPreferredRoom, preferredRoomIds } from "./roomPreferences.ts";
import { temporaryReplacementTeacherIds } from "./temporaryTeacherReplacements.ts";
import type { TeacherTeachingAssignment } from "./teacherReassignment.ts";
import { calculateTeacherGaps } from "./teacherGaps.ts";
import { normalSchoolBreakMinutes } from "./bellSchedule.ts";
import { findGapClosingMoves } from "./generationGapClosing.ts";

export type GeneratedPlacement = {
  groupId: string;
  date: string;
  slot: number;
  lessonId: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
  subgroupId?: string;
  lessonKind: "regular" | "lab";
};
export type GenerationRemainder = {
  groupId: string;
  subjectId: string;
  subgroupId?: string;
  lessonKind: "regular" | "lab";
  target: number;
  placed: number;
  missing: number;
  reason: string;
};
export type GenerationResult = {
  schedule: Schedule;
  added: GeneratedPlacement[];
  remaining: GenerationRemainder[];
  fallbackRoomCount: number;
  removedCount: number;
};

export type GenerationProgress = {
  percent: number;
  phase: "preparing" | "placing" | "joining" | "finalizing" | "done";
};

type State = Pick<
  StateResponse,
  "catalog" | "schedule" | "quarters" | "studyPlans" | "temporaryTeacherReplacements" | "teachingAssignments"
  | "bellSettings"
>;
type Task = {
  plan: StudyPlan;
  assignment: StudyPlan["assignments"][number];
  placed: number;
  initial: number;
  teacherId: string | null;
  sourceTeacherId?: string;
  reasons: Set<string>;
};
type Candidate = {
  date: string;
  slot: number;
  day: EditorDay;
  teacher: CatalogTeacher;
  room: CatalogRoom;
  cost: number;
  roomRank: number;
  jointCapacityRank: number;
  joinLessonIds: string[];
  jointId?: string;
};
type Occupancy = {
  groupId: string;
  date: string;
  start: number;
  end: number;
  subjectId?: string;
  teacherId?: string;
  roomId?: string;
  subgroupId?: string;
  lessonId?: string;
  breakBefore?: number;
  breakAfter?: number;
  groupDayStart?: number;
};

function cloneSchedule(schedule: Schedule): Schedule {
  return Object.fromEntries(
    Object.entries(schedule).map(([key, days]) => [
      key,
      days.map((day) => ({
        ...day,
        breaks: [...day.breaks],
        times: day.times.map((time) => ({ ...time })),
        slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson }))),
      })),
    ]),
  );
}

function lessonSubgroupId(
  lesson: EditorLesson,
  groupId: string,
  catalog: State["catalog"],
): string | undefined {
  if (lesson.subgroupId) return lesson.subgroupId;
  if (!lesson.subgroup) return undefined;
  return catalog.subgroups.find(
    (entry) => entry.groupId === groupId && entry.name === lesson.subgroup,
  )?.id;
}

function actualAdjacentBreaks(day: EditorDay, slot: number): { breakBefore?: number; breakAfter?: number } {
  const current = day.times[slot];
  if (!current) return {};
  const previous = day.times[slot - 1];
  const next = day.times[slot + 1];
  return {
    ...(previous ? { breakBefore: current.start - (previous.start + previous.duration) } : {}),
    ...(next ? { breakAfter: next.start - (current.start + current.duration) } : {}),
  };
}

function occupancyFrom(
  schedule: Schedule,
  catalog: State["catalog"],
): Occupancy[] {
  const entries: Occupancy[] = [];
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days)
      day.slots.forEach((slot, index) => {
        const time = day.times[index];
        if (!time) return;
        for (const lesson of slot) {
          const adjacentBreaks = actualAdjacentBreaks(day, index);
          entries.push({
            groupId,
            date: day.date,
            start: time.start,
            end: time.start + time.duration,
            subjectId: lesson.event ? undefined : lesson.subjectId,
            teacherId: lesson.teacherId,
            roomId: lesson.roomId,
            subgroupId: lessonSubgroupId(lesson, groupId, catalog),
            lessonId: lesson.id,
            ...adjacentBreaks,
            groupDayStart: day.times[0]?.start,
          });
        }
      });
  }
  return entries;
}

function locateScheduleLesson(schedule: Schedule, lessonId: string) {
  for (const [key, days] of Object.entries(schedule))
    for (const day of days)
      for (let slot = 0; slot < day.slots.length; slot += 1) {
        const lesson = day.slots[slot].find((entry) => entry.id === lessonId);
        if (lesson) return { groupId: key.slice(0, key.lastIndexOf(":")), day, slot, lesson };
      }
  return undefined;
}

function jointGroupsForSubject(
  subject: State["catalog"]["subjects"][number],
  groupId: string,
  catalog: State["catalog"],
  selected: Set<string>,
): Set<string> {
  const peers = new Set(
    (subject.jointGroupSets ?? []).filter((set) => set.includes(groupId)).flat(),
  );
  if ((subject as typeof subject & { jointSameGrade?: boolean }).jointSameGrade) {
    const grade = catalog.groups.find((group) => group.id === groupId)?.name.match(/^\s*(\d+)/)?.[1];
    if (grade)
      for (const group of catalog.groups)
        if (group.id !== groupId && !group.archived && selected.has(group.id) && group.name.match(/^\s*(\d+)/)?.[1] === grade)
          peers.add(group.id);
  }
  peers.delete(groupId);
  return peers;
}

function intersects(a: Occupancy, b: Occupancy): boolean {
  return a.date === b.date && a.start < b.end && b.start < a.end;
}

function participantsOverlap(a: Occupancy, b: Occupancy): boolean {
  if (a.groupId !== b.groupId) return false;
  // Two explicitly different subgroups may study in parallel. Whole-group
  // lessons and legacy lessons without a subgroup occupy the whole group.
  return !a.subgroupId || !b.subgroupId || a.subgroupId === b.subgroupId;
}

function requiredRoomKind(kind: RoomKind | null): RoomKind {
  return kind ?? "general";
}

function isPhysicalEducation(subject: { name: string; shortName?: string }): boolean {
  const names = `${subject.name} ${subject.shortName ?? ""}`.toLocaleLowerCase("ru").replaceAll("ё", "е");
  return /физ\s*-?\s*ра|физкультур|физическ.*культур/.test(names);
}

function hasRoomPreference(catalog: State["catalog"], groupId: string, teacherId: string | undefined): boolean {
  const group = catalog.groups.find((entry) => entry.id === groupId);
  const teacher = catalog.teachers.find((entry) => entry.id === teacherId);
  return Boolean(teacher?.defaultRoomId || group?.roomId || group?.autoRoomIds.length);
}

function dateOrdinal(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function id(): string {
  return globalThis.crypto.randomUUID();
}

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function unavailabilityReason(conflict: ReturnType<typeof lessonUnavailability>[number]): string {
  const resource = conflict.kind === "teacher" ? "Учитель" : "Кабинет";
  return `${resource} «${conflict.resourceName}» недоступен ${formatTime(conflict.start)}–${formatTime(conflict.end)}${conflict.reason ? `: ${conflict.reason}` : ""}`;
}

function temporaryPolicyFor(
  state: State,
  lookup: {
    groupId: string;
    subjectId: string;
    subgroupId?: string;
    subgroup?: string;
    date: string;
    start: number;
    end: number;
    sourceTeacherId?: string;
    requiredUnavailabilityRuleId?: string;
  },
): { sourceTeacherId: string; teacherIds: string[] } | undefined {
  const rules = state.temporaryTeacherReplacements;
  if (!rules?.length) return undefined;
  const matching = rules.filter((rule) =>
    rule.groupId === lookup.groupId && rule.subjectId === lookup.subjectId &&
    (!lookup.requiredUnavailabilityRuleId || rule.unavailabilityRuleId === lookup.requiredUnavailabilityRuleId) &&
    temporarySubgroupMatches(state.catalog, rule.groupId, rule.subgroupId, rule.subgroup, lookup.subgroupId, lookup.subgroup),
  );
  const sources = [...new Set([...matching.map((rule) => rule.sourceTeacherId), ...(lookup.sourceTeacherId ? [lookup.sourceTeacherId] : [])])];
  // If multiple source teachers have policies for the same plan, the most
  // recently recorded active policy owns this date and time.
  let active: { sourceTeacherId: string; teacherIds: string[]; index: number } | undefined;
  for (const sourceTeacherId of sources) {
    const teacherIds = temporaryReplacementTeacherIds(rules, state.catalog, {
      ...lookup,
      sourceTeacherId,
    });
    if (!teacherIds) continue;
    let index = -1;
    for (let ruleIndex = 0; ruleIndex < matching.length; ruleIndex += 1) {
      const rule = matching[ruleIndex];
      if (rule?.sourceTeacherId === sourceTeacherId &&
          rule.startDate <= lookup.date && rule.endDate >= lookup.date &&
          JSON.stringify(rule.teacherIds) === JSON.stringify(teacherIds)) index = ruleIndex;
    }
    if (index >= 0 && (!active || index > active.index))
      active = { sourceTeacherId, teacherIds, index };
  }
  return active;
}

function temporarySubgroupMatches(
  catalog: State["catalog"], groupId: string,
  ruleSubgroupId: string | undefined, ruleSubgroup: string | undefined,
  lookupSubgroupId: string | undefined, lookupSubgroup: string | undefined,
): boolean {
  const normalize = (id: string | undefined, name: string | undefined) =>
    id ?? (name ? catalog.subgroups.find((entry) => entry.groupId === groupId && entry.name === name)?.id : undefined);
  const ruleId = normalize(ruleSubgroupId, ruleSubgroup);
  const lookupId = normalize(lookupSubgroupId, lookupSubgroup);
  return ruleId || lookupId ? ruleId === lookupId : (ruleSubgroup ?? "") === (lookupSubgroup ?? "");
}

function teachingAssignmentFor(
  state: State,
  lookup: { groupId: string; subjectId: string; subgroupId?: string; subgroup?: string; date: string; start: number; end: number },
): TeacherTeachingAssignment | undefined {
  const entries = state.teachingAssignments ?? [];
  const matching = entries.flatMap((entry, index) => {
    if (entry.groupId !== lookup.groupId || entry.subjectId !== lookup.subjectId ||
        entry.startDate > lookup.date || (entry.endDate !== null && entry.endDate < lookup.date)) return [];
    if (entry.absenceRuleId) {
      const source = state.catalog.teachers.find((teacher) => teacher.id === entry.sourceTeacherId);
      const ruleExists = source?.unavailability?.some((rule) => rule.id === entry.absenceRuleId);
      const exactAbsence = lessonUnavailability(state.catalog, {
        date: lookup.date, start: lookup.start, end: lookup.end, teacherId: entry.sourceTeacherId,
      }).some((conflict) => conflict.ruleId === entry.absenceRuleId);
      if (!ruleExists || !exactAbsence) return [];
    }
    const hasSubgroup = Boolean(entry.subgroupId || entry.subgroup);
    if (hasSubgroup && !temporarySubgroupMatches(state.catalog, entry.groupId, entry.subgroupId, entry.subgroup, lookup.subgroupId, lookup.subgroup)) return [];
    return [{ entry, index, specificity: hasSubgroup ? 1 : 0 }];
  });
  matching.sort((a, b) => a.specificity - b.specificity || a.index - b.index);
  return matching.at(-1)?.entry;
}

function teacherPolicyFor(
  state: State,
  lookup: { groupId: string; subjectId: string; subgroupId?: string; subgroup?: string; date: string; start: number; end: number },
): { assignment?: TeacherTeachingAssignment; policy?: { sourceTeacherId: string; teacherIds: string[] }; allowed?: Set<string>; preferred?: string } {
  const assignment = teachingAssignmentFor(state, lookup);
  const policySourceTeacherId = assignment
    ? assignment.absenceRuleId ? assignment.sourceTeacherId : assignment.targetTeacherId
    : undefined;
  const policy = temporaryPolicyFor(state, assignment ? {
    ...lookup,
    sourceTeacherId: policySourceTeacherId,
    ...(assignment.absenceRuleId ? { requiredUnavailabilityRuleId: assignment.absenceRuleId } : {}),
  } : lookup);
  if (assignment) {
    const allowed = new Set([assignment.targetTeacherId]);
    // An absence policy for the original teacher can temporarily cover an
    // explicit target when that target is itself unavailable.
    if (policy && policy.sourceTeacherId === policySourceTeacherId)
      policy.teacherIds.forEach((id) => allowed.add(id));
    return { assignment, policy, allowed, preferred: assignment.targetTeacherId };
  }
  return policy
    ? { policy, allowed: new Set(policy.teacherIds), preferred: policy.sourceTeacherId }
    : {};
}

function sourceTeacherForPlan(
  state: State,
  groupId: string,
  subjectId: string,
  subgroupId?: string,
  subgroup?: string,
  date?: string,
): string | undefined {
  const rules = state.temporaryTeacherReplacements ?? [];
  const quarter = date ? state.quarters.find((entry) => inQuarter(date, entry)) : undefined;
  const relevant = rules.filter((rule) =>
    rule.groupId === groupId && rule.subjectId === subjectId &&
    temporarySubgroupMatches(state.catalog, groupId, rule.subgroupId, rule.subgroup, subgroupId, subgroup) &&
    (!quarter || (rule.startDate <= quarter.endDate && rule.endDate >= quarter.startDate)),
  );
  if (relevant.length) return relevant.at(-1)?.sourceTeacherId;
  const assignment = (state.teachingAssignments ?? []).find((entry) =>
    entry.groupId === groupId && entry.subjectId === subjectId &&
    (!(entry.subgroupId || entry.subgroup) || temporarySubgroupMatches(state.catalog, groupId, entry.subgroupId, entry.subgroup, subgroupId, subgroup)) &&
    (!quarter || entry.startDate <= quarter.endDate && (entry.endDate === null || entry.endDate >= quarter.startDate)),
  );
  return assignment?.sourceTeacherId;
}

function lessonCount(
  state: State,
  quarter: Quarter,
  groupId: string,
  subjectId: string,
  subgroupId: string | null,
  kind: "regular" | "lab",
  schedule: Schedule = state.schedule,
): number {
  let count = 0;
  for (const [key, days] of Object.entries(schedule)) {
    if (key.slice(0, key.lastIndexOf(":")) !== groupId) continue;
    for (const day of days) {
      if (!inQuarter(day.date, quarter)) continue;
      for (const slot of day.slots)
        for (const lesson of slot) {
          if (lesson.event) continue;
          if (
            lesson.subjectId !== subjectId ||
            (lesson.lessonKind ?? "regular") !== kind
          )
            continue;
          const actualSubgroup = lessonSubgroupId(
            lesson,
            groupId,
            state.catalog,
          );
          if (
            subgroupId
              ? !actualSubgroup || actualSubgroup === subgroupId
              : !actualSubgroup
          )
            count += 1;
        }
    }
  }
  return count;
}

/** Create a client-side draft. The input schedule and catalog are never mutated. */
export function generateQuarter(
  state: State,
  quarterId: string,
  groupIds: string[],
  options: {
    preserveExisting?: boolean;
    allowJointLessons?: boolean;
    onProgress?: (progress: GenerationProgress) => void;
    shouldCancel?: () => boolean;
  } = {},
): GenerationResult {
  const allowJointLessons = options.allowJointLessons !== false;
  let lastProgressPercent = -1;
  let lastProgressAt = 0;
  const reportProgress = (percent: number, phase: GenerationProgress["phase"], force = false) => {
    if (!options.onProgress) return;
    const bounded = phase === "done"
      ? 100
      : Math.min(99, Math.max(0, Math.floor(percent)));
    const now = Date.now();
    if (!force && bounded - lastProgressPercent < 1 && now - lastProgressAt < 100) return;
    if (bounded < lastProgressPercent) return;
    lastProgressPercent = bounded;
    lastProgressAt = now;
    options.onProgress({ percent: bounded, phase });
  };
  reportProgress(0, "preparing", true);
  const quarter = state.quarters.find((entry) => entry.id === quarterId);
  if (!quarter) throw new Error("Выбранная четверть не найдена");
  const selected = new Set(groupIds);
  const catalog = state.catalog;
  const schedule = cloneSchedule(state.schedule);
  let removedCount = 0;
  if (options.preserveExisting === false) {
    for (const [key, days] of Object.entries(schedule)) {
      const groupId = key.slice(0, key.lastIndexOf(":"));
      if (!selected.has(groupId)) continue;
      for (const day of days) {
        if (!inQuarter(day.date, quarter)) continue;
        for (const slot of day.slots) {
          removedCount += slot.length;
          slot.length = 0;
        }
      }
    }
  }
  const occupancies = occupancyFrom(schedule, catalog);
  const occupancyByLessonId = new Map(occupancies.flatMap((entry) => entry.lessonId ? [[entry.lessonId, entry] as const] : []));
  const byDate = new Map<string, Occupancy[]>();
  const byTeacherDate = new Map<string, Occupancy[]>();
  const byRoomDate = new Map<string, Occupancy[]>();
  const indexOccupancy = (entry: Occupancy) => {
    const dateEntries = byDate.get(entry.date) ?? [];
    dateEntries.push(entry);
    byDate.set(entry.date, dateEntries);
    if (entry.teacherId) {
      const key = `${entry.date}|${entry.teacherId}`;
      const rows = byTeacherDate.get(key) ?? [];
      rows.push(entry);
      byTeacherDate.set(key, rows);
    }
    if (entry.roomId) {
      const key = `${entry.date}|${entry.roomId}`;
      const rows = byRoomDate.get(key) ?? [];
      rows.push(entry);
      byRoomDate.set(key, rows);
    }
  };
  occupancies.forEach(indexOccupancy);
  const groupById = new Map(catalog.groups.map((entry) => [entry.id, entry]));
  const subjects = new Map(catalog.subjects.map((entry) => [entry.id, entry]));
  const teachers = catalog.teachers.filter((entry) => !entry.archived);
  const activeRooms = catalog.rooms.filter((entry) => !entry.archived);
  const added: GeneratedPlacement[] = [];
  const addedByDateSubject = new Map<string, GeneratedPlacement[]>();
  const addedBySubject = new Map<string, GeneratedPlacement[]>();
  const indexAdded = (placement: GeneratedPlacement) => {
    const dateKey = `${placement.date}|${placement.subjectId}`;
    const dateRows = addedByDateSubject.get(dateKey) ?? [];
    dateRows.push(placement);
    addedByDateSubject.set(dateKey, dateRows);
    const subjectRows = addedBySubject.get(placement.subjectId) ?? [];
    subjectRows.push(placement);
    addedBySubject.set(placement.subjectId, subjectRows);
  };
  let fallbackRoomCount = 0;
  const tasks: Task[] = [];
  const isShareableTask = (task: Task) => {
    if (task.plan.lessonKind !== "regular" || task.assignment.subgroupId) return false;
    const group = groupById.get(task.plan.groupId);
    const subject = subjects.get(task.plan.subjectId);
    if (!group || !subject) return false;
    return jointGroupsForSubject(subject, group.id, catalog, selected).size > 0;
  };

  for (const plan of state.studyPlans) {
    if (plan.quarterId !== quarterId || !selected.has(plan.groupId)) continue;
    const group = groupById.get(plan.groupId);
    const subject = subjects.get(plan.subjectId);
    if (!group || group.archived || !subject || subject.archived) continue;
    for (const assignment of plan.assignments) {
      const assignmentSubgroup = assignment.subgroupId
        ? catalog.subgroups.find((entry) => entry.id === assignment.subgroupId && entry.groupId === group.id)
        : undefined;
      const sourceTeacherId = sourceTeacherForPlan(
        state, group.id, subject.id, assignment.subgroupId ?? undefined,
        assignmentSubgroup?.name, quarter.startDate,
      );
      const initial = lessonCount(
        state,
        quarter,
        plan.groupId,
        plan.subjectId,
        assignment.subgroupId,
        plan.lessonKind,
        schedule,
      );
      tasks.push({
        plan,
        assignment,
        placed: 0,
        initial,
        teacherId: sourceTeacherId ?? null,
        sourceTeacherId,
        reasons: new Set(),
      });
    }
  }

  // Specialized work is scheduled first because it has fewer valid rooms.
  tasks.sort(
    (a, b) =>
      Number(b.plan.lessonKind === "lab") -
        Number(a.plan.lessonKind === "lab") ||
      Number(isShareableTask(b)) - Number(isShareableTask(a)) ||
      a.plan.groupId.localeCompare(b.plan.groupId) ||
      a.plan.subjectId.localeCompare(b.plan.subjectId),
  );
  const totalLessonWork = tasks.reduce(
    (sum, task) => sum + Math.max(0, task.assignment.target - task.initial),
    0,
  );
  let completedLessonWork = 0;
  const completeLessonWork = (count = 1) => {
    completedLessonWork = Math.min(totalLessonWork, completedLessonWork + count);
    reportProgress(totalLessonWork ? (completedLessonWork / totalLessonWork) * 90 : 90, "placing");
  };
  reportProgress(0, "placing", true);
  const teacherLoad = new Map<string, number>();
  const weekSubjectOccupancies = new Map<string, Occupancy[]>();
  const teacherSubjectCounts = new Map<string, number>();
  const fallbackNormalBreakMinutes = normalSchoolBreakMinutes(state.bellSettings);
  const shiftForStart = (start: number | undefined): "morning" | "afternoon" | undefined =>
    start === undefined ? undefined : start < 720 ? "morning" : "afternoon";
  const teacherGapMinutes = (rows: Occupancy[]): number =>
    calculateTeacherGaps(rows.map((row, index) => ({
      id: row.lessonId ?? `activity-${index}`,
      start: row.start,
      duration: row.end - row.start,
      breakBefore: row.breakBefore,
      breakAfter: row.breakAfter,
    })), fallbackNormalBreakMinutes).reduce((sum, gap) => sum + gap.minutes, 0);
  const teacherGapDeltaCost = (teacherId: string, date: string, proposed: Occupancy | Occupancy[], replacedLessonIds: string[] = []): number => {
    const rows = byTeacherDate.get(`${date}|${teacherId}`) ?? [];
    const before = teacherGapMinutes(rows);
    const remaining = replacedLessonIds.length ? rows.filter(row => !replacedLessonIds.includes(row.lessonId ?? "")) : rows;
    const after = teacherGapMinutes([...remaining, ...(Array.isArray(proposed) ? proposed : [proposed])]);
    return Math.max(-3, Math.min(3, (after - before) / 60));
  };
  const weekSubjectKey = (groupId: string, week: number, subjectId: string) =>
    `${groupId}|${week}|${subjectId}`;
  for (const item of occupancies) {
    if (item.teacherId)
      teacherLoad.set(
        item.teacherId,
        (teacherLoad.get(item.teacherId) ?? 0) + 1,
      );
    if (item.subjectId) {
      const week = weekOffsetFor(item.date);
      const weekKey = weekSubjectKey(item.groupId, week, item.subjectId);
      const weeklyRows = weekSubjectOccupancies.get(weekKey) ?? [];
      weeklyRows.push(item);
      weekSubjectOccupancies.set(weekKey, weeklyRows);
      if (item.teacherId) {
        const policy = temporaryPolicyFor(state, {
          groupId: item.groupId,
          subjectId: item.subjectId,
          subgroupId: item.subgroupId,
          subgroup: item.subgroupId
            ? catalog.subgroups.find((entry) => entry.id === item.subgroupId && entry.groupId === item.groupId)?.name
            : undefined,
          date: item.date,
          start: item.start,
          end: item.end,
        });
        const continuityTeacherId = policy && item.teacherId !== policy.sourceTeacherId && policy.teacherIds.includes(item.teacherId)
          ? policy.sourceTeacherId
          : item.teacherId;
        const countKey = `${item.groupId}|${item.subjectId}|${continuityTeacherId}`;
        teacherSubjectCounts.set(countKey, (teacherSubjectCounts.get(countKey) ?? 0) + 1);
      }
    }
  }
  const quarterDays = Object.entries(schedule)
    .flatMap(([key, days]) => {
      const groupId = key.slice(0, key.lastIndexOf(":"));
      if (!selected.has(groupId)) return [];
      return days
        .filter(
          (day) =>
            inQuarter(day.date, quarter) &&
            !day.holiday &&
            day.slots.length > 0,
        )
        .map((day) => ({ groupId, day, week: weekOffsetFor(day.date) }));
    })
    .sort(
      (a, b) =>
        dateOrdinal(a.day.date) - dateOrdinal(b.day.date) ||
        a.groupId.localeCompare(b.groupId),
    );
  const availableDaysPerWeek = new Map<string, number>();
  const occupiedCellsPerDay = new Map<string, number>();
  const initialOccupiedCellsPerDay = new Map<string, number>();
  const occupiedCellsPerWeek = new Map<string, number>();
  const usableWeekCapacity = new Map<string, number>();
  const groupDayKey = (groupId: string, date: string) => `${groupId}|${date}`;
  const groupWeekKey = (groupId: string, week: number) => `${groupId}|${week}`;
  for (const { groupId, week } of quarterDays) {
    const weekKey = groupWeekKey(groupId, week);
    availableDaysPerWeek.set(weekKey, (availableDaysPerWeek.get(weekKey) ?? 0) + 1);
  }
  for (const { groupId, day, week } of quarterDays) {
    const dayKey = groupDayKey(groupId, day.date);
    const occupiedCells = day.slots.reduce((count, slot) => count + Number(slot.length > 0), 0);
    occupiedCellsPerDay.set(dayKey, occupiedCells);
    initialOccupiedCellsPerDay.set(dayKey, occupiedCells);
    const weekKey = groupWeekKey(groupId, week);
    occupiedCellsPerWeek.set(weekKey, (occupiedCellsPerWeek.get(weekKey) ?? 0) + occupiedCells);
    const usableSlots = Math.min(7, day.slots.filter((_, index) => Boolean(day.times[index])).length);
    usableWeekCapacity.set(weekKey, (usableWeekCapacity.get(weekKey) ?? 0) + usableSlots);
  }

  for (const task of tasks) {
    const { plan, assignment } = task;
    const group = groupById.get(plan.groupId)!;
    const subject = subjects.get(plan.subjectId)!;
    const subgroup = assignment.subgroupId
      ? catalog.subgroups.find(
          (entry) =>
            entry.id === assignment.subgroupId &&
            entry.groupId === group.id &&
            !entry.archived,
        )
      : undefined;
    if (assignment.subgroupId && !subgroup) {
      task.reasons.add("Подгруппа отсутствует или архивирована.");
      completeLessonWork(Math.max(0, assignment.target - task.initial));
      continue;
    }
    const participantCount = subgroup?.students ?? group.students;
    const qualified = teachers.filter((teacher) =>
      teacher.subjectIds.includes(subject.id),
    );
    if (!qualified.length) {
      task.reasons.add("Нет активного преподавателя, связанного с предметом.");
      completeLessonWork(Math.max(0, assignment.target - task.initial));
      continue;
    }
    const requiredKind =
      plan.lessonKind === "lab"
        ? requiredRoomKind(subject.labRoomKind ?? subject.roomKind)
        : requiredRoomKind(subject.roomKind);
    const compatibleRooms = activeRooms.filter(
      (room) =>
        room.kind === requiredKind &&
        (room.capacity === null || room.capacity >= participantCount),
    );
    if (!compatibleRooms.length) {
      const hasRequiredRoomKind = activeRooms.some(
        (room) => room.kind === requiredKind,
      );
      task.reasons.add(
        hasRequiredRoomKind
          ? `Нет кабинета типа «${roomKinds[requiredKind]}» с достаточной вместимостью для ${participantCount} учащихся.`
          : `Нет кабинетов типа «${roomKinds[requiredKind]}». Проверьте тип кабинетов в справочнике.`,
      );
      completeLessonWork(Math.max(0, assignment.target - task.initial));
      continue;
    }
    const dominantTeacher = new Map<string, number>();
    const teacherCountPrefix = `${group.id}|${subject.id}|`;
    for (const [key, count] of teacherSubjectCounts) {
      if (key.startsWith(teacherCountPrefix))
        dominantTeacher.set(key.slice(teacherCountPrefix.length), count);
    }
    const preferredTeacher = [...dominantTeacher].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    const jointPeers = jointGroupsForSubject(subject, group.id, catalog, selected);
    const jointCapacityTarget = Math.min(
      ...[...jointPeers].filter((peerId) => state.studyPlans.some((peerPlan) =>
        peerPlan.quarterId === quarterId && peerPlan.groupId === peerId && peerPlan.subjectId === subject.id &&
        peerPlan.lessonKind === "regular" && peerPlan.assignments.some((entry) => !entry.subgroupId && entry.target > 0),
      )).map((peerId) => group.students + (groupById.get(peerId)?.students ?? 0)),
    );
    const hasJointPeerPlan = Number.isFinite(jointCapacityTarget);
    // The order only depends on this task's group, teacher and compatible
    // room set. Hoisting it avoids sorting the same list for every slot.
    const orderedRoomsByTeacher = new Map(qualified.map((teacher) => [
      teacher.id,
      preferredRoomIds(catalog, group.id, teacher.id)
        .map((roomId) => compatibleRooms.find((room) => room.id === roomId))
        .filter((room): room is CatalogRoom => Boolean(room)),
    ]));

    for (
      let lessonNo = task.initial;
      lessonNo < assignment.target;
      lessonNo += 1
    ) {
      // Teacher preferences are a soft, but higher-priority, cost tier. Keep
      // the ordinary cost ordering within each tier so load and room choices
      // still decide between equally preferred candidates.
      let bestPreferred: Candidate | undefined;
      let bestFallback: Candidate | undefined;
      let bestAssigned: Candidate | undefined;
      const betterCandidate = (candidate: Candidate, current: Candidate | undefined) =>
        !current || candidate.jointCapacityRank < current.jointCapacityRank ||
        (candidate.jointCapacityRank === current.jointCapacityRank &&
          (candidate.roomRank < current.roomRank ||
            (candidate.roomRank === current.roomRank && candidate.cost < current.cost)));
      let sawFreeSlot = false;
      let sawDailyCap = false;
      const unavailableReasons = new Set<string>();
      for (const { day, groupId, week } of quarterDays) {
        if (groupId !== group.id) continue;
        const dayKey = groupDayKey(group.id, day.date);
        const groupDayLoad = occupiedCellsPerDay.get(dayKey) ?? 0;
        for (let slot = 0; slot < day.slots.length; slot += 1) {
          const time = day.times[slot];
          if (!time) continue;
          const candidateBase: Occupancy = {
            groupId: group.id,
            date: day.date,
            start: time.start,
            end: time.start + time.duration,
            subgroupId: assignment.subgroupId ?? undefined,
            ...actualAdjacentBreaks(day, slot),
            groupDayStart: day.times[0]?.start,
          };
          const teacherSelection = teacherPolicyFor(state, {
            groupId: group.id,
            subjectId: subject.id,
            subgroupId: assignment.subgroupId ?? undefined,
            subgroup: subgroup?.name,
            date: day.date,
            start: time.start,
            end: time.start + time.duration,
          });
          const occupiedSubjectToday = (byDate.get(day.date) ?? []).filter(
            (entry) => entry.subjectId === subject.id &&
              entry.groupId === group.id && participantsOverlap(candidateBase, entry),
          ).length;
          if (occupiedSubjectToday >= 2) continue;
          if (isPhysicalEducation(subject) && (byDate.get(day.date) ?? []).some((entry) => {
            const otherSubject = entry.subjectId ? subjects.get(entry.subjectId) : undefined;
            return entry.groupId === group.id && participantsOverlap(candidateBase, entry) &&
              Boolean(otherSubject && isPhysicalEducation(otherSubject));
          })) continue;
          if (
            (byDate.get(day.date) ?? []).some(
              (item) =>
                intersects(candidateBase, item) &&
                participantsOverlap(candidateBase, item),
            )
          )
            continue;
          sawFreeSlot = true;
          const fillsNewCell = day.slots[slot].length === 0;
          if ((initialOccupiedCellsPerDay.get(dayKey) ?? 0) > 7 ||
              (fillsNewCell && groupDayLoad >= 7)) {
            sawDailyCap = true;
            continue;
          }
          if (!compatibleRooms.length) continue;
          const jointOptions = allowJointLessons && plan.lessonKind === "regular" && !assignment.subgroupId
            ? (addedByDateSubject.get(`${day.date}|${subject.id}`) ?? []).flatMap((placement) => {
                if (!jointPeers.has(placement.groupId) || placement.lessonKind !== "regular" || placement.subgroupId) return [];
                const peer = locateScheduleLesson(schedule, placement.lessonId);
                if (!peer || peer.day.times[peer.slot]?.start !== time.start || peer.day.times[peer.slot]?.duration !== time.duration) return [];
                const jointId = (peer.lesson as EditorLesson & { jointId?: string }).jointId;
                const session = jointId
                  ? (addedByDateSubject.get(`${day.date}|${subject.id}`) ?? []).filter((entry) => {
                      const located = locateScheduleLesson(schedule, entry.lessonId);
                      const locatedTime = located?.day.times[located.slot];
                      return entry.subjectId === subject.id && entry.date === day.date &&
                        Boolean(located && locatedTime?.start === time.start && locatedTime.duration === time.duration && (located.lesson as EditorLesson & { jointId?: string }).jointId === jointId);
                    })
                  : [placement];
                if (session.some((entry) => entry.groupId === group.id || !jointPeers.has(entry.groupId))) return [];
                const sessionGroupIds = new Set(session.map((entry) => entry.groupId));
                const maxJointGroups = subject.maxJointGroups ?? 2;
                if (
                  sessionGroupIds.size !== session.length ||
                  new Set([...sessionGroupIds, group.id]).size > maxJointGroups
                ) return [];
                const combinedStudents = [...sessionGroupIds].reduce((sum, id) => sum + (groupById.get(id)?.students ?? 0), group.students);
                return [{
                  teacherId: peer.lesson.teacherId,
                  roomId: peer.lesson.roomId,
                  lessonIds: session.map((entry) => entry.lessonId),
                  jointId,
                  combinedStudents,
                }];
              })
            : [];
          for (const teacher of qualified) {
            if (teacherSelection.allowed && !teacherSelection.allowed.has(teacher.id)) continue;
            let teacherComfortCost: number | undefined;
            const orderedRooms = orderedRoomsByTeacher.get(teacher.id) ?? [];
            for (let roomRank = 0; roomRank < orderedRooms.length; roomRank += 1) {
              const room = orderedRooms[roomRank];
              const unavailability = lessonUnavailability(catalog, {
                date: day.date,
                start: time.start,
                end: time.start + time.duration,
                teacherId: teacher.id,
                roomId: room.id,
              });
              if (unavailability.length) {
                for (const conflict of unavailability)
                  if (unavailableReasons.size < 3)
                    unavailableReasons.add(unavailabilityReason(conflict));
                continue;
              }
              const joining = jointOptions.find((option) =>
                option.teacherId === teacher.id && option.roomId === room.id &&
                (room.capacity === null || room.capacity >= option.combinedStudents),
              );
              const joinedIds = new Set(joining?.lessonIds ?? []);
              const conflicts = (rows: Occupancy[] | undefined) =>
                Boolean(rows?.some((item) => intersects(candidateBase, item) && !joinedIds.has(item.lessonId ?? "")));
              if (
                conflicts(byTeacherDate.get(`${day.date}|${teacher.id}`)) ||
                conflicts(byRoomDate.get(`${day.date}|${room.id}`))
              )
                continue;
              if (teacherComfortCost === undefined) {
                const teacherProposal: Occupancy = {
                  ...candidateBase,
                  subjectId: subject.id,
                  teacherId: teacher.id,
                };
                const groupShift = shiftForStart(day.times[0]?.start);
                const dayTeacherRows = byTeacherDate.get(`${day.date}|${teacher.id}`) ?? [];
                const existingShifts = new Set(dayTeacherRows.map((entry) => shiftForStart(entry.groupDayStart)).filter(Boolean));
                const mixedShiftDayPenalty = groupShift && existingShifts.size === 1 && !existingShifts.has(groupShift) ? 0.5 : 0;
                const shiftPreferencePenalty = teacher.preferredShift && groupShift && teacher.preferredShift !== groupShift ? 0.5 : 0;
                teacherComfortCost = teacherGapDeltaCost(teacher.id, day.date, teacherProposal) + mixedShiftDayPenalty + shiftPreferencePenalty;
              }
              const currentWeekLoad = (weekSubjectOccupancies.get(
                weekSubjectKey(group.id, week, subject.id),
              ) ?? []).filter((entry) => participantsOverlap(candidateBase, entry)).length;
              const weekDayCount = availableDaysPerWeek.get(`${group.id}|${week}`) ?? 1;
              const projectedDayCells = groupDayLoad + Number(fillsNewCell);
              const projectedWeekCells = (occupiedCellsPerWeek.get(groupWeekKey(group.id, week)) ?? 0) + Number(fillsNewCell);
              const weekCapacity = Math.max(1, usableWeekCapacity.get(groupWeekKey(group.id, week)) ?? 0);
              const dayBalanceCost = 24 * (projectedDayCells / 7) ** 2;
              const weekBalanceCost = 24 * (projectedWeekCells / weekCapacity) ** 2;
              const jointAlignment = Boolean(joining);
              const neighboringGroupLesson = day.slots.some((rows, index) => {
                if (index === slot) return false;
                const touches = index === slot - 1 || index === slot + 1;
                return touches && rows.some((lesson) => {
                  const subgroupId = lessonSubgroupId(lesson, group.id, catalog);
                  return !assignment.subgroupId || !subgroupId || subgroupId === assignment.subgroupId;
                });
              });
              const teacherPenalty =
                (teacherLoad.get(teacher.id) ?? 0) * 0.015 +
                (teacher.id === preferredTeacher ? -0.08 : 0) +
                (teacher.id === task.teacherId ? -0.15 : 0);
              const cost =
                occupiedSubjectToday * 18 +
                dayBalanceCost +
                weekBalanceCost +
                (currentWeekLoad / weekDayCount) * 7.5 +
                (neighboringGroupLesson ? -0.5 : 6) +
                (jointAlignment ? -6 : 0) +
                teacherPenalty +
                teacherComfortCost +
                slot * 0.003 +
                dateOrdinal(day.date) / 1e14;
              const candidate: Candidate = {
                date: day.date,
                slot,
                day,
                teacher,
                room,
                cost,
                roomRank,
                jointCapacityRank: allowJointLessons && hasJointPeerPlan && room.capacity !== null && room.capacity < jointCapacityTarget ? 1 : 0,
                joinLessonIds: joining?.lessonIds ?? [],
                ...(joining?.jointId ? { jointId: joining.jointId } : {}),
              };
              const preferred =
                (teacher.preferredGroupIds?.includes(group.id) ?? false) ||
                teacher.id === task.sourceTeacherId ||
                teacher.id === teacherSelection.preferred;
              if (teacherSelection.assignment && teacher.id === teacherSelection.assignment.targetTeacherId) {
                if (betterCandidate(candidate, bestAssigned)) bestAssigned = candidate;
              } else if (preferred) {
                if (betterCandidate(candidate, bestPreferred)) bestPreferred = candidate;
              } else if (betterCandidate(candidate, bestFallback)) {
                bestFallback = candidate;
              }
            }
          }
        }
      }
      const best = bestAssigned ?? bestPreferred ?? bestFallback;
      if (!best) {
        if (!sawFreeSlot)
          task.reasons.add(
            "Нет свободного времени для этой группы или подгруппы.",
          );
        else if (unavailableReasons.size)
          task.reasons.add(
            `Недоступны подходящие ресурсы: ${[...unavailableReasons].join("; ")}.`,
          );
        else if (sawDailyCap)
          task.reasons.add("Достигнут лимит 7 занятых ячеек в день.");
        else
          task.reasons.add(
            "На свободное время группы не удалось подобрать преподавателя и кабинет.",
          );
        completeLessonWork(Math.max(1, assignment.target - lessonNo));
        break;
      }
      const { date, slot, day, teacher, room } = best;
      const addedToNewCell = day.slots[slot].length === 0;
      const lessonId = id();
      const lesson: EditorLesson = {
        id: lessonId,
        subjectId: subject.id,
        lessonKind: plan.lessonKind,
        teacherId: teacher.id,
        teacher: teacher.name.split(/\s+/)[0],
        roomId: room.id,
        room: room.name,
        ...(assignment.subgroupId && subgroup
          ? { subgroupId: subgroup.id, subgroup: subgroup.name }
          : {}),
      };
      if (best.joinLessonIds.length) {
        const jointId = best.jointId ?? id();
        (lesson as EditorLesson & { jointId?: string }).jointId = jointId;
        for (const joinedLessonId of best.joinLessonIds) {
          const joinedLesson = locateScheduleLesson(schedule, joinedLessonId)?.lesson;
          if (joinedLesson) (joinedLesson as EditorLesson & { jointId?: string }).jointId = jointId;
        }
      }
      day.slots[slot].push(lesson);
      const placement: GeneratedPlacement = {
        groupId: group.id,
        date,
        slot,
        lessonId,
        subjectId: subject.id,
        teacherId: teacher.id,
        roomId: room.id,
        lessonKind: plan.lessonKind,
        ...(assignment.subgroupId ? { subgroupId: assignment.subgroupId } : {}),
      };
      added.push(placement);
      indexAdded(placement);
      const time = day.times[slot];
      const newOccupancy = {
        groupId: group.id,
        date,
        start: time.start,
        end: time.start + time.duration,
        teacherId: teacher.id,
        roomId: room.id,
        subgroupId: assignment.subgroupId ?? undefined,
        subjectId: subject.id,
        lessonId,
        ...actualAdjacentBreaks(day, slot),
        groupDayStart: day.times[0]?.start,
      };
      occupancies.push(newOccupancy);
      occupancyByLessonId.set(newOccupancy.lessonId, newOccupancy);
      indexOccupancy(newOccupancy);
      const weeklyKey = weekSubjectKey(group.id, weekOffsetFor(date), subject.id);
      const weeklyRows = weekSubjectOccupancies.get(weeklyKey) ?? [];
      weeklyRows.push(newOccupancy);
      weekSubjectOccupancies.set(weeklyKey, weeklyRows);
      const placementPolicy = temporaryPolicyFor(state, {
        groupId: group.id,
        subjectId: subject.id,
        subgroupId: assignment.subgroupId ?? undefined,
        subgroup: subgroup?.name,
        date,
        start: time.start,
        end: time.start + time.duration,
      });
      const continuityTeacherId = placementPolicy?.teacherIds.includes(teacher.id)
        ? placementPolicy.sourceTeacherId
        : teacher.id;
      const teacherSubjectKey = `${group.id}|${subject.id}|${continuityTeacherId}`;
      teacherSubjectCounts.set(teacherSubjectKey, (teacherSubjectCounts.get(teacherSubjectKey) ?? 0) + 1);
      teacherLoad.set(teacher.id, (teacherLoad.get(teacher.id) ?? 0) + 1);
      if (addedToNewCell) {
        const dayKey = groupDayKey(group.id, date);
        occupiedCellsPerDay.set(dayKey, (occupiedCellsPerDay.get(dayKey) ?? 0) + 1);
        const weekKey = groupWeekKey(group.id, weekOffsetFor(date));
        occupiedCellsPerWeek.set(weekKey, (occupiedCellsPerWeek.get(weekKey) ?? 0) + 1);
      }
      if (
        hasRoomPreference(catalog, group.id, teacher.id) &&
        !isPreferredRoom(catalog, group.id, teacher.id, room.id) &&
        plan.lessonKind === "regular" &&
        requiredKind === "general"
      )
        fallbackRoomCount += 1;
      task.placed += 1;
      if (!task.sourceTeacherId) task.teacherId = teacher.id;
      completeLessonWork();
    }
  }

  // Close gaps using only generated, single lessons. A chain moves at most
  // three lessons, so runtime stays bounded while allowing two lessons to be
  // displaced on the way to a previously empty slot.
  const addedByGroupDate = new Map<string, GeneratedPlacement[]>();
  for (const placement of added) {
    const key = `${placement.groupId}|${placement.date}`;
    const rows = addedByGroupDate.get(key) ?? [];
    rows.push(placement);
    addedByGroupDate.set(key, rows);
  }
  for (const { groupId, day } of quarterDays) {
    if (options.shouldCancel?.()) throw new Error("Составление расписания отменено");
    const dayPlacements = addedByGroupDate.get(`${groupId}|${day.date}`) ?? [];
    if (!dayPlacements.length) continue;
    const locatedByLessonId = new Map(day.slots.flatMap((rows, slot) => rows.map((lesson) =>
      [lesson.id, { groupId, day, slot, lesson }] as const,
    )));
    const isMovable = (placement: GeneratedPlacement) => {
      const located = locatedByLessonId.get(placement.lessonId);
      return Boolean(located && !(located.lesson as EditorLesson & { jointId?: string }).jointId);
    };
    const solution = findGapClosingMoves({
      day,
      placements: dayPlacements,
      isMovable,
      shouldCancel: options.shouldCancel,
      canMove: (placement, destination, positions, chain) => {
        const located = locatedByLessonId.get(placement.lessonId);
        const time = day.times[destination];
        if (!located || !time) return false;
        const subgroupId = placement.subgroupId;
        const candidate: Occupancy = {
          groupId, date: day.date, start: time.start, end: time.start + time.duration,
          teacherId: placement.teacherId, roomId: placement.roomId, subjectId: placement.subjectId,
          subgroupId, lessonId: placement.lessonId, ...actualAdjacentBreaks(day, destination),
          groupDayStart: day.times[0]?.start,
        };
        const policy = teacherPolicyFor(state, { groupId, subjectId: placement.subjectId, subgroupId,
          date: day.date, start: candidate.start, end: candidate.end });
        if (policy.allowed && !policy.allowed.has(placement.teacherId)) return false;
        const room = activeRooms.find((entry) => entry.id === placement.roomId);
        const subject = subjects.get(placement.subjectId);
        const group = groupById.get(groupId);
        const subgroup = subgroupId ? catalog.subgroups.find((entry) => entry.id === subgroupId) : undefined;
        const requiredKind = placement.lessonKind === "lab" ? subject?.labRoomKind ?? subject?.roomKind ?? null : subject?.roomKind ?? null;
        if (!room || !subject || !group || room.kind !== requiredRoomKind(requiredKind) ||
            (room.capacity !== null && room.capacity < (subgroup?.students ?? group.students)) ||
            lessonUnavailability(catalog, { date: day.date, start: candidate.start, end: candidate.end,
              teacherId: placement.teacherId, roomId: placement.roomId }).length) return false;
        const moving = new Set([...chain, placement.lessonId]);
        const virtualMoved = [...positions.entries()]
          .filter(([lessonId]) => chain.has(lessonId) && lessonId !== placement.lessonId)
          .flatMap(([lessonId, movedSlot]) => {
            const entry = occupancyByLessonId.get(lessonId);
            const movedTime = day.times[movedSlot];
            return entry && movedTime ? [{ ...entry, start: movedTime.start, end: movedTime.start + movedTime.duration } as Occupancy] : [];
          });
        const externalConflict = [
          ...(byDate.get(day.date) ?? []).filter((entry) => !moving.has(entry.lessonId ?? "")),
          ...virtualMoved,
        ].some((entry) => intersects(candidate, entry) &&
          (entry.groupId === groupId && participantsOverlap(candidate, entry) || entry.teacherId === candidate.teacherId || entry.roomId === candidate.roomId));
        return !externalConflict;
      },
    });
    if (!solution) continue;
    const changedIds = new Set(dayPlacements.filter((entry) => (solution.get(entry.lessonId) ?? entry.slot) !== entry.slot).map((entry) => entry.lessonId));
    const changedTeachers = new Set(dayPlacements.filter((entry) => changedIds.has(entry.lessonId)).map((entry) => entry.teacherId));
    let worsensTeacherGaps = false;
    for (const teacherId of changedTeachers) {
      const originalRows = byTeacherDate.get(`${day.date}|${teacherId}`) ?? [];
      const afterRows = originalRows.filter((entry) => !changedIds.has(entry.lessonId ?? ""));
      for (const placement of dayPlacements) {
        if (placement.teacherId !== teacherId || !changedIds.has(placement.lessonId)) continue;
        const target = solution.get(placement.lessonId)!;
        const time = day.times[target]!;
        const row = occupancyByLessonId.get(placement.lessonId);
        if (row) afterRows.push({ ...row, start: time.start, end: time.start + time.duration,
          ...actualAdjacentBreaks(day, target) });
      }
      if (teacherGapMinutes(afterRows) > teacherGapMinutes(originalRows) + 0.001) {
        worsensTeacherGaps = true;
        break;
      }
    }
    if (worsensTeacherGaps) continue;
    for (const placement of dayPlacements) {
      const target = solution.get(placement.lessonId) ?? placement.slot;
      if (target === placement.slot) continue;
      const lesson = day.slots[placement.slot]!.find((entry) => entry.id === placement.lessonId);
      if (!lesson) continue;
      day.slots[placement.slot] = day.slots[placement.slot]!.filter((entry) => entry.id !== placement.lessonId);
      day.slots[target]!.push(lesson);
      placement.slot = target;
      const occupancy = occupancyByLessonId.get(placement.lessonId);
      const time = day.times[target]!;
      if (occupancy) Object.assign(occupancy, { start: time.start, end: time.start + time.duration,
        ...actualAdjacentBreaks(day, target), groupDayStart: day.times[0]?.start });
    }
  }

  // Merge newly generated whole-group lessons for explicitly configured cohorts.
  // Existing/manual lessons are never moved or rewritten by this pass.
  const locateAdded = (lessonId: string) => {
    for (const [key, days] of Object.entries(schedule))
      for (const day of days)
        for (let slot = 0; slot < day.slots.length; slot += 1) {
          const lesson = day.slots[slot].find((entry) => entry.id === lessonId);
          if (lesson) return { groupId: key.slice(0, key.lastIndexOf(":")), day, slot, lesson };
        }
    return undefined;
  };
  const gapCount = (day: EditorDay) => {
    const occupied = day.slots.map((slot) => slot.length > 0);
    const first = occupied.indexOf(true);
    const last = occupied.lastIndexOf(true);
    return first < 0 ? 0 : occupied.slice(first, last + 1).filter((value) => !value).length;
  };
  const jointUsed = new Set(
    added.flatMap((entry) => {
      const lesson = locateScheduleLesson(schedule, entry.lessonId)?.lesson as (EditorLesson & { jointId?: string }) | undefined;
      return lesson?.jointId ? [entry.lessonId] : [];
    }),
  );
  const jointCohortSizes = (allowJointLessons ? catalog.subjects : []).flatMap((subject) => {
    if ((subject.maxJointGroups ?? 2) < 2) return [];
    const cohorts = [...(subject.jointGroupSets ?? [])];
    if ((subject as typeof subject & { jointSameGrade?: boolean }).jointSameGrade) {
      const byGrade = new Map<string, string[]>();
      for (const group of catalog.groups) {
        if (group.archived || !selected.has(group.id)) continue;
        const grade = group.name.match(/^\s*(\d+)/)?.[1];
        if (!grade) continue;
        const peers = byGrade.get(grade) ?? [];
        peers.push(group.id);
        byGrade.set(grade, peers);
      }
      cohorts.push(...[...byGrade.values()].filter((entries) => entries.length > 1));
    }
    return cohorts.map((cohort) => new Set(cohort.filter((groupId) => selected.has(groupId))).size)
      .filter((size) => size >= 2);
  });
  const totalJointPairs = jointCohortSizes.reduce((sum, size) => sum + size * (size - 1) / 2, 0);
  let completedJointPairs = 0;
  reportProgress(90, "joining", true);
  for (const subject of allowJointLessons ? catalog.subjects : []) {
    const cohorts = [...(subject.jointGroupSets ?? [])];
    if ((subject as typeof subject & { jointSameGrade?: boolean }).jointSameGrade) {
      const byGrade = new Map<string, string[]>();
      for (const group of catalog.groups) {
        if (group.archived || !selected.has(group.id)) continue;
        const grade = group.name.match(/^\s*(\d+)/)?.[1];
        if (!grade) continue;
        const peers = byGrade.get(grade) ?? [];
        peers.push(group.id);
        byGrade.set(grade, peers);
      }
      cohorts.push(...[...byGrade.values()].filter((entries) => entries.length > 1));
    }
    for (const cohort of cohorts) {
      const cohortIds = [...new Set(cohort.filter((groupId) => selected.has(groupId)))];
      if ((subject.maxJointGroups ?? 2) < 2) continue;
      if (cohortIds.length < 2) continue;
      for (let leftIndex = 0; leftIndex < cohortIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < cohortIds.length; rightIndex += 1) {
          completedJointPairs += 1;
          reportProgress(
            90 + (totalJointPairs ? (completedJointPairs / totalJointPairs) * 9 : 9),
            "joining",
          );
          const leftGroup = groupById.get(cohortIds[leftIndex]);
          const rightGroup = groupById.get(cohortIds[rightIndex]);
          if (!leftGroup || !rightGroup) continue;
          const pairs = (addedBySubject.get(subject.id) ?? []).filter((entry) =>
            entry.subjectId === subject.id &&
            entry.lessonKind === "regular" &&
            (entry.groupId === leftGroup.id || entry.groupId === rightGroup.id) &&
            !entry.subgroupId && !jointUsed.has(entry.lessonId),
          );
          const leftRows = pairs.filter((entry) => entry.groupId === leftGroup.id);
          const rightRows = pairs.filter((entry) => entry.groupId === rightGroup.id);
          for (const left of leftRows) {
            const first = locateAdded(left.lessonId);
            if (!first) continue;
            const firstTime = first.day.times[first.slot];
            if (!firstTime) continue;
          const right = rightRows.find((entry) => {
            if (jointUsed.has(entry.lessonId)) return false;
              const second = locateAdded(entry.lessonId);
              return Boolean(second && second.day.date === first.day.date && second.day.times[second.slot]?.duration === firstTime.duration);
            });
            if (!right) continue;
            const second = locateAdded(right.lessonId);
            if (!second) continue;
            const secondTime = second.day.times[second.slot];
            if (!secondTime) continue;
            const destination = Object.entries(schedule)
              .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === second.groupId)
              .flatMap(([, days]) => days)
              .find((day) => day.date === first.day.date);
            const targetSlot = destination?.times.findIndex((time) => time.start === firstTime.start && time.duration === firstTime.duration) ?? -1;
            if (!destination || targetSlot < 0) continue;
            const targetTime = destination.times[targetSlot];
            if (!targetTime) continue;
            const freePreferredGroups = [leftGroup.id, rightGroup.id].filter(
              (groupId) => teachers.some((teacher) =>
                teacher.subjectIds.includes(subject.id) &&
                teacher.preferredGroupIds?.includes(groupId) &&
                lessonUnavailability(catalog, {
                  date: first.day.date,
                  start: firstTime.start,
                  end: firstTime.start + firstTime.duration,
                  teacherId: teacher.id,
                }).length === 0 &&
                !occupancies.some((entry) =>
                  ![left.lessonId, right.lessonId].includes(entry.lessonId ?? "") &&
                  entry.teacherId === teacher.id && entry.date === first.day.date &&
                  entry.start < firstTime.start + firstTime.duration && firstTime.start < entry.end,
                ),
              ),
            );
            const leftPolicy = teacherPolicyFor(state, {
              groupId: leftGroup.id, subjectId: subject.id, date: first.day.date,
              start: firstTime.start, end: firstTime.start + firstTime.duration,
            });
            const rightPolicy = teacherPolicyFor(state, {
              groupId: rightGroup.id, subjectId: subject.id, date: first.day.date,
              start: firstTime.start, end: firstTime.start + firstTime.duration,
            });
            const commonTeachers = teachers.filter((teacher) =>
              teacher.subjectIds.includes(subject.id) &&
              (!leftPolicy.allowed || leftPolicy.allowed.has(teacher.id)) &&
              (!rightPolicy.allowed || rightPolicy.allowed.has(teacher.id)) &&
              lessonUnavailability(catalog, {
                date: first.day.date,
                start: firstTime.start,
                end: firstTime.start + firstTime.duration,
                teacherId: teacher.id,
              }).length === 0 &&
              freePreferredGroups.every((groupId) =>
                teacher.preferredGroupIds?.includes(groupId),
              ) &&
              !occupancies.some((entry) =>
                ![left.lessonId, right.lessonId].includes(entry.lessonId ?? "") &&
                entry.teacherId === teacher.id && entry.date === first.day.date &&
                entry.start < firstTime.start + firstTime.duration && firstTime.start < entry.end,
              ),
            );
            const commonShiftA = shiftForStart(first.day.times[0]?.start);
            const commonShiftB = shiftForStart(destination.times[0]?.start);
            const commonTeachersByComfort = commonTeachers.map((teacher, index) => {
              const existing = byTeacherDate.get(`${first.day.date}|${teacher.id}`) ?? [];
              const modes = new Set(existing.map((entry) => shiftForStart(entry.groupDayStart)).filter(Boolean));
              const requestedModes = new Set([commonShiftA, commonShiftB].filter(Boolean));
              const remainingModes = existing.filter(entry => ![left.lessonId, right.lessonId].includes(entry.lessonId ?? "")).map(entry => shiftForStart(entry.groupDayStart)).filter(Boolean);
              const afterModes = new Set([...remainingModes, ...requestedModes]);
              const newMixedShift = (Number(afterModes.size > 1) - Number(modes.size > 1)) * 0.5;
              const shiftMismatch = teacher.preferredShift && !requestedModes.has(teacher.preferredShift) ? 0.5 : 0;
              const proposedActivities: Occupancy[] = [
                {
                  groupId: leftGroup.id, date: first.day.date,
                  start: firstTime.start, end: firstTime.start + firstTime.duration,
                  teacherId: teacher.id, subjectId: subject.id,
                  ...actualAdjacentBreaks(first.day, first.slot),
                  groupDayStart: first.day.times[0]?.start,
                },
                {
                  groupId: rightGroup.id, date: first.day.date,
                  start: firstTime.start, end: firstTime.start + firstTime.duration,
                  teacherId: teacher.id, subjectId: subject.id,
                  ...actualAdjacentBreaks(destination, targetSlot),
                  groupDayStart: destination.times[0]?.start,
                },
              ];
              return {
                teacher,
                score: teacherGapDeltaCost(teacher.id, first.day.date, proposedActivities, [left.lessonId, right.lessonId]) + newMixedShift + shiftMismatch,
                index,
              };
            }).sort((a, b) => a.score - b.score || a.index - b.index);
            const commonTeacher = commonTeachersByComfort[0]?.teacher;
            const requiredKind = requiredRoomKind(subject.roomKind);
            const commonRoom = preferredRoomIds(catalog, [leftGroup.id, rightGroup.id], commonTeacher?.id)
              .map((roomId) => activeRooms.find((room) => room.id === roomId))
              .find((room) => Boolean(room && room.kind === requiredKind &&
                (room.capacity === null || room.capacity >= leftGroup.students + rightGroup.students) &&
                lessonUnavailability(catalog, {
                  date: first.day.date,
                  start: firstTime.start,
                  end: firstTime.start + firstTime.duration,
                  roomId: room.id,
                }).length === 0 &&
                !occupancies.some((entry) =>
                  ![left.lessonId, right.lessonId].includes(entry.lessonId ?? "") &&
                  entry.roomId === room.id && entry.date === first.day.date &&
                  entry.start < firstTime.start + firstTime.duration && firstTime.start < entry.end,
                )));
            if (!commonTeacher || !commonRoom) continue;
            const participantBusy = second.day.date === first.day.date && second.slot === first.slot
              ? false
              : second.day.slots.some((rows, slot) => {
                  if (second.day.date !== first.day.date) return false;
                  const time = second.day.times[slot];
                  return Boolean(time && time.start < firstTime.start + firstTime.duration && firstTime.start < time.start + time.duration && rows.some((lesson) => lesson.id !== right.lessonId));
                });
            if (participantBusy) continue;
            const destinationConflicts = destination.slots.some((rows, slot) => {
              const time = destination.times[slot];
              return Boolean(time && time.start < targetTime.start + targetTime.duration && targetTime.start < time.start + time.duration && rows.some((lesson) => lesson.id !== right.lessonId));
            });
            if (destinationConflicts) continue;
            const sameCell = second.day === destination && second.slot === targetSlot;
            const sourceCellFreed = !sameCell && second.day.slots[second.slot].every((lesson) => lesson.id === right.lessonId);
            const destinationCellWasOccupied = destination.slots[targetSlot].some((lesson) => lesson.id !== right.lessonId);
            const destinationAddsCell = !sameCell && !destinationCellWasOccupied;
            const sourceDayKey = groupDayKey(second.groupId, second.day.date);
            const destinationDayKey = groupDayKey(second.groupId, destination.date);
            const sourceWeekKey = groupWeekKey(second.groupId, weekOffsetFor(second.day.date));
            const destinationWeekKey = groupWeekKey(second.groupId, weekOffsetFor(destination.date));
            const destinationBaseline = initialOccupiedCellsPerDay.get(destinationDayKey) ?? 0;
            const destinationCurrent = occupiedCellsPerDay.get(destinationDayKey) ?? 0;
            const sameDay = sourceDayKey === destinationDayKey;
            const destinationAfter = destinationCurrent + Number(destinationAddsCell) - Number(sameDay && sourceCellFreed);
            if (
              (destinationAddsCell && destinationBaseline > 7) ||
              destinationAfter > Math.max(7, destinationBaseline)
            ) continue;
            const dayDelta = new Map<string, number>();
            if (sourceCellFreed) dayDelta.set(sourceDayKey, (dayDelta.get(sourceDayKey) ?? 0) - 1);
            if (destinationAddsCell) dayDelta.set(destinationDayKey, (dayDelta.get(destinationDayKey) ?? 0) + 1);
            const weekDelta = new Map<string, number>();
            if (sourceCellFreed) weekDelta.set(sourceWeekKey, (weekDelta.get(sourceWeekKey) ?? 0) - 1);
            if (destinationAddsCell) weekDelta.set(destinationWeekKey, (weekDelta.get(destinationWeekKey) ?? 0) + 1);
            const dailyBalanceCost = (count: number) => 24 * (count / 7) ** 2;
            const weeklyBalanceCost = (key: string, count: number) =>
              24 * (count / Math.max(1, usableWeekCapacity.get(key) ?? 0)) ** 2;
            const beforeBalanceCost =
              [...new Set([sourceDayKey, destinationDayKey])].reduce((sum, key) =>
                sum + dailyBalanceCost(occupiedCellsPerDay.get(key) ?? 0), 0) +
              [...new Set([sourceWeekKey, destinationWeekKey])].reduce((sum, key) =>
                sum + weeklyBalanceCost(key, occupiedCellsPerWeek.get(key) ?? 0), 0);
            const afterBalanceCost =
              [...new Set([sourceDayKey, destinationDayKey])].reduce((sum, key) =>
                sum + dailyBalanceCost((occupiedCellsPerDay.get(key) ?? 0) + (dayDelta.get(key) ?? 0)), 0) +
              [...new Set([sourceWeekKey, destinationWeekKey])].reduce((sum, key) =>
                sum + weeklyBalanceCost(key, (occupiedCellsPerWeek.get(key) ?? 0) + (weekDelta.get(key) ?? 0)), 0);
            if (afterBalanceCost > beforeBalanceCost + 0.001) continue;
            const dailySubjectCount = destination.slots.flat().filter((lesson) => lesson.id !== right.lessonId && !lesson.event && lesson.subjectId === subject.id).length;
            if (dailySubjectCount >= 2) continue;
            const beforeGaps = gapCount(second.day);
            const afterSource = second.day.slots.map((rows) => rows.filter((lesson) => lesson.id !== right.lessonId));
            const sourcePreview = { ...second.day, slots: afterSource };
            const destinationPreview = {
              ...destination,
              slots: destination.slots.map((rows, index) => [
                ...rows.filter((lesson) => lesson.id !== right.lessonId),
                ...(index === targetSlot ? [second.lesson] : []),
              ]),
            };
            const gapsBefore = destination === second.day ? beforeGaps : beforeGaps + gapCount(destination);
            const gapsAfter = destination === second.day ? gapCount(destinationPreview) : gapCount(sourcePreview) + gapCount(destinationPreview);
            if (gapsAfter > gapsBefore) continue;
            const jointId = id();
            const jointFields = { teacherId: commonTeacher.id, teacher: commonTeacher.name.split(/\s+/)[0], roomId: commonRoom.id, room: commonRoom.name, jointId };
            Object.assign(first.lesson, jointFields);
            Object.assign(second.lesson, jointFields);
            const secondMirror = { ...second.lesson };
            second.day.slots[second.slot] = second.day.slots[second.slot].filter((entry) => entry.id !== right.lessonId);
            destination.slots[targetSlot].push(secondMirror);
            for (const [key, delta] of dayDelta)
              occupiedCellsPerDay.set(key, (occupiedCellsPerDay.get(key) ?? 0) + delta);
            for (const [key, delta] of weekDelta)
              occupiedCellsPerWeek.set(key, (occupiedCellsPerWeek.get(key) ?? 0) + delta);
            jointUsed.add(left.lessonId);
            jointUsed.add(right.lessonId);
            const moved = added.find((entry) => entry.lessonId === right.lessonId)!;
            if (requiredKind === "general") {
              const wasFallback = (group: typeof leftGroup, placement: GeneratedPlacement) =>
                hasRoomPreference(catalog, group.id, placement.teacherId) &&
                !isPreferredRoom(catalog, group.id, placement.teacherId, placement.roomId);
              const newFallback = (group: typeof leftGroup) =>
                hasRoomPreference(catalog, group.id, commonTeacher.id) &&
                !isPreferredRoom(catalog, group.id, commonTeacher.id, commonRoom.id);
              fallbackRoomCount += Number(newFallback(leftGroup)) - Number(wasFallback(leftGroup, left));
              fallbackRoomCount += Number(newFallback(rightGroup)) - Number(wasFallback(rightGroup, moved));
            }
            Object.assign(moved, { date: first.day.date, slot: targetSlot, teacherId: commonTeacher.id, roomId: commonRoom.id });
            Object.assign(left, { teacherId: commonTeacher.id, roomId: commonRoom.id });
            const priorOccupancy = occupancies.findIndex((entry) => entry.lessonId === right.lessonId);
            const leftOccupancy = occupancies.find((entry) => entry.lessonId === left.lessonId);
            const previousTeacherIds = new Set([
              leftOccupancy?.teacherId,
              priorOccupancy >= 0 ? occupancies[priorOccupancy]?.teacherId : undefined,
            ].filter((teacherId): teacherId is string => Boolean(teacherId)));
            if (leftOccupancy) {
              leftOccupancy.teacherId = commonTeacher.id;
              leftOccupancy.roomId = commonRoom.id;
            }
            const movedOccupancy: Occupancy = {
              groupId: right.groupId,
              date: first.day.date,
              start: targetTime.start,
              end: targetTime.start + targetTime.duration,
              subjectId: subject.id,
              teacherId: commonTeacher.id,
              roomId: commonRoom.id,
              lessonId: right.lessonId,
              ...actualAdjacentBreaks(destination, targetSlot),
              groupDayStart: destination.times[0]?.start,
            };
            if (priorOccupancy >= 0) occupancies.splice(priorOccupancy, 1);
            occupancies.push(movedOccupancy);
            const changedLessonIds = new Set([left.lessonId, right.lessonId]);
            const affectedTeacherIds = new Set([...previousTeacherIds, commonTeacher.id]);
            for (const teacherId of affectedTeacherIds) {
              const key = `${first.day.date}|${teacherId}`;
              const rows = (byTeacherDate.get(key) ?? []).filter((entry) => !changedLessonIds.has(entry.lessonId ?? ""));
              if (leftOccupancy?.teacherId === teacherId) rows.push(leftOccupancy);
              if (movedOccupancy.teacherId === teacherId) rows.push(movedOccupancy);
              byTeacherDate.set(key, rows);
            }
            for (const task of tasks) {
              if (task.plan.groupId === right.groupId && task.plan.subjectId === subject.id && task.plan.lessonKind === "regular" && !task.sourceTeacherId) task.teacherId = commonTeacher.id;
            }
          }
        }
      }
    }
  }

  const remaining: GenerationRemainder[] = tasks.flatMap((task) => {
    const missing = Math.max(
      0,
      task.assignment.target - task.initial - task.placed,
    );
    if (!missing) return [];
    return [
      {
        groupId: task.plan.groupId,
        subjectId: task.plan.subjectId,
        ...(task.assignment.subgroupId
          ? { subgroupId: task.assignment.subgroupId }
          : {}),
        lessonKind: task.plan.lessonKind,
        target: task.assignment.target,
        placed: task.initial + task.placed,
        missing,
        reason:
          [...task.reasons][0] ??
          "Не удалось подобрать свободное место в расписании.",
      },
    ];
  });
  reportProgress(99, "finalizing", true);
  reportProgress(100, "done", true);
  return { schedule, added, remaining, fallbackRoomCount, removedCount };
}
