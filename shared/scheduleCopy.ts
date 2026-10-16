import type { Catalog, CatalogEntry } from "./catalog.ts";
import { canShareSubject } from "./catalog.ts";
import { calendarDay } from "./schoolCalendar.ts";
import { newRoomConflict, roomConflictMessage } from "./roomConflicts.ts";
import { newTeacherConflict, teacherConflictMessage } from "./teacherConflicts.ts";
import { newRoomSuitabilityViolation, roomSuitabilityViolationMessage } from "./roomSuitability.ts";
import { newUnavailabilityViolation, unavailabilityViolationMessage } from "./unavailability.ts";
import { inQuarter, quarterWeeks, weekDates, type Quarter, type StudyPlan } from "./plans.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";
import type { StateResponse } from "../server/contracts.ts";
import { countPlanLessons } from "../src/catalogAdapter.ts";

export type ScheduleCopyOptions = {
  mode: "week" | "lesson";
  quarterId: string;
  sourceGroupId: string;
  sourceWeekOffset: number;
  sourceLessonId?: string;
  targetWeekOffsets: number[];
};
export type CopyState = Pick<StateResponse, "schedule" | "catalog" | "quarters" | "studyPlans" | "calendar">;
export type ScheduleCopyPreview = {
  schedule: Schedule;
  sourceLessonCount: number;
  linkedGroupIds: string[];
  added: Array<{ groupId: string; date: string; slot: number; lessonId: string; sourceLessonId: string; subjectId: string; event?: string; jointId?: string }>;
  skipped: Array<{ groupId: string; date: string; slot: number; sourceLessonId: string; subjectId: string; event?: string; reason: string }>;
  hours: Array<{ groupId: string; subjectId: string; subgroupId?: string; lessonKind: "regular" | "lab"; before: number; after: number; target: number }>;
};

type SourceMember = { groupId: string; day: EditorDay; slot: number; lesson: EditorLesson };
type CopyUnit = { members: SourceMember[]; joint: boolean };
const scheduleKey = (groupId: string, offset: number) => `${groupId}:${offset}`;
const weekdayIndex = (date: string) => (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
const randomId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

function allLessons(schedule: Schedule): SourceMember[] {
  const result: SourceMember[] = [];
  for (const [key, days] of Object.entries(schedule)) {
    const split = key.lastIndexOf(":");
    const groupId = key.slice(0, split);
    for (const day of days) day.slots.forEach((slot, slotIndex) => slot.forEach((lesson) => result.push({ groupId, day, slot: slotIndex, lesson })));
  }
  return result;
}

function unitsFor(source: SourceMember[], schedule: Schedule): CopyUnit[] {
  const all = allLessons(schedule);
  const used = new Set<string>();
  const units: CopyUnit[] = [];
  for (const member of source) {
    if (used.has(member.lesson.id)) continue;
    if (!member.lesson.jointId) {
      used.add(member.lesson.id);
      units.push({ members: [member], joint: false });
      continue;
    }
    const peers = all.filter((entry) => entry.day.date === member.day.date && entry.lesson.jointId === member.lesson.jointId);
    for (const peer of peers) used.add(peer.lesson.id);
    units.push({ members: peers, joint: peers.length > 1 });
  }
  return units;
}

function byIdOrLegacy<T extends CatalogEntry>(entries: T[], id: string | undefined, legacy: string | undefined): T | undefined {
  if (id) return entries.find((entry) => entry.id === id);
  if (!legacy?.trim()) return undefined;
  const normalized = legacy.trim().toLocaleLowerCase("ru");
  const matches = entries.filter((entry) => entry.name.trim().toLocaleLowerCase("ru") === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function teacherByIdOrLegacy(catalog: Catalog, id: string | undefined, legacy: string | undefined) {
  if (id) return catalog.teachers.find((entry) => entry.id === id);
  if (!legacy?.trim()) return undefined;
  const value = legacy.trim().toLocaleLowerCase("ru");
  const exact = catalog.teachers.find((entry) => entry.name.trim().toLocaleLowerCase("ru") === value);
  if (exact) return exact;
  const matches = catalog.teachers.filter((entry) => entry.name.trim().split(/\s+/)[0]?.toLocaleLowerCase("ru") === value);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveLesson(member: SourceMember, catalog: Catalog, plans: StudyPlan[], quarterId: string): { lesson?: EditorLesson; reason?: string } {
  const { lesson } = member;
  const group = catalog.groups.find((entry) => entry.id === member.groupId);
  if (!group || group.archived) return { reason: "Группа отсутствует в справочнике или архивирована" };
  const subject = catalog.subjects.find((entry) => entry.id === lesson.subjectId);
  if (!lesson.event && (!subject || subject.archived)) return { reason: "Предмет отсутствует в справочнике или архивирован" };
  let teacher: Catalog["teachers"][number] | undefined;
  let room: Catalog["rooms"][number] | undefined;
  if (lesson.teacherId || lesson.teacher?.trim()) {
    teacher = teacherByIdOrLegacy(catalog, lesson.teacherId, lesson.teacher);
    if (!teacher || teacher.archived) return { reason: "Преподаватель отсутствует в справочнике, архивирован или не разрешается по имени" };
    if (!lesson.event && !teacher.subjectIds.includes(lesson.subjectId)) return { reason: `У преподавателя «${teacher.name}» нет этого предмета в справочнике` };
  } else if (!lesson.event) return { reason: "У урока не назначен преподаватель" };
  if (lesson.roomId || lesson.room?.trim()) {
    room = byIdOrLegacy(catalog.rooms, lesson.roomId, lesson.room);
    if (!room || room.archived) return { reason: "Кабинет отсутствует в справочнике, архивирован или не разрешается по названию" };
  } else if (!lesson.event) return { reason: "Уроку не назначен кабинет" };

  let normalizedSubgroupId = lesson.subgroupId;
  let normalizedSubgroupName = lesson.subgroup;
  if (!lesson.event) {
    if (lesson.subgroup || lesson.subgroupId) {
      const subgroup = lesson.subgroupId
        ? catalog.subgroups.find((entry) => entry.id === lesson.subgroupId && entry.groupId === member.groupId)
        : catalog.subgroups.find((entry) => entry.groupId === member.groupId && entry.name.toLocaleLowerCase("ru") === lesson.subgroup?.trim().toLocaleLowerCase("ru"));
      if (!subgroup || subgroup.archived) return { reason: "Подгруппа отсутствует в справочнике или архивирована" };
      if (lesson.subgroup && lesson.subgroup.toLocaleLowerCase("ru") !== subgroup.name.toLocaleLowerCase("ru")) return { reason: "Название подгруппы не совпадает со справочником" };
      normalizedSubgroupId = subgroup.id;
      normalizedSubgroupName = subgroup.name;
    }
    const plan = plans.find((entry) => entry.quarterId === quarterId && entry.groupId === member.groupId && entry.subjectId === lesson.subjectId && entry.lessonKind === (lesson.lessonKind ?? "regular"));
    if (!plan) return { reason: "Для предмета нет учебного плана в выбранной четверти" };
    if (plan.mode === "whole" && (lesson.subgroupId || lesson.subgroup)) return { reason: "Урок подгруппы не соответствует плану для всей группы" };
    if (plan.mode === "subgroups" && !normalizedSubgroupId) return { reason: "Урок всей группы не соответствует плану по подгруппам" };
    const assignment = plan.assignments.find((item) => item.subgroupId === (normalizedSubgroupId ?? null));
    if (!assignment) return { reason: "Назначение группы или подгруппы отсутствует в плане" };
  }
  return { lesson: { ...lesson, ...(teacher ? { teacherId: teacher.id } : {}), ...(room ? { roomId: room.id } : {}), ...(normalizedSubgroupId ? { subgroupId: normalizedSubgroupId, subgroup: normalizedSubgroupName } : {}) } };
}

function targetDay(schedule: Schedule, groupId: string, offset: number, date: string): EditorDay | undefined {
  return schedule[scheduleKey(groupId, offset)]?.find((day) => day.date === date);
}

function cellOverlapReason(day: EditorDay, slot: number, candidate: EditorLesson, catalog: Catalog, groupId: string): string | undefined {
  const entries = day.slots[slot] ?? [];
  for (const current of entries) {
    const existingSubgroup = current.subgroupId
      ? catalog.subgroups.find((entry) => entry.id === current.subgroupId && entry.groupId === groupId)
      : current.subgroup
        ? catalog.subgroups.find((entry) => entry.groupId === groupId && entry.name.toLocaleLowerCase("ru") === current.subgroup?.trim().toLocaleLowerCase("ru"))
        : undefined;
    if (!candidate.subgroupId || !existingSubgroup || candidate.subgroupId === existingSubgroup.id)
      return "В ячейке уже есть занятие этой группы или подгруппы";
  }
  return undefined;
}

function timeOverlapReason(day: EditorDay, slot: number): string | undefined {
  const time = day.times[slot];
  if (!time) return "Для урока не задано время";
  const end = time.start + time.duration;
  for (let index = 0; index < day.slots.length; index += 1) {
    if (index === slot) continue;
    const otherTime = day.times[index];
    if (!otherTime || time.start >= otherTime.start + otherTime.duration || otherTime.start >= end) continue;
    if (day.slots[index]?.length) return `Время пересекается с занятием №${index + 1} этой группы`;
  }
  return undefined;
}

function copyOnSchedule(schedule: Schedule, additions: Array<{ groupId: string; offset: number; date: string; slot: number; lesson: EditorLesson }>): Schedule {
  const next = { ...schedule };
  const cloned = new Map<string, EditorDay[]>();
  for (const addition of additions) {
    const key = scheduleKey(addition.groupId, addition.offset);
    let days = cloned.get(key);
    if (!days) {
      days = (schedule[key] ?? []).map((day) => ({ ...day, breaks: [...day.breaks], times: day.times.map((time) => ({ ...time })), slots: day.slots.map((slot) => slot.map((lesson) => ({ ...lesson }))) }));
      cloned.set(key, days);
    }
    const day = days.find((entry) => entry.date === addition.date)!;
    day.slots[addition.slot].push(addition.lesson);
  }
  for (const [key, days] of cloned) next[key] = days;
  return next;
}

function quarterHours(schedule: Schedule, plans: StudyPlan[], quarter: Quarter, groupIds: Set<string>) {
  const rows = new Map<string, ScheduleCopyPreview["hours"][number]>();
  for (const plan of plans) {
    if (plan.quarterId !== quarter.id || !groupIds.has(plan.groupId)) continue;
    for (const assignment of plan.assignments) {
      const subgroupId = assignment.subgroupId ?? undefined;
      const key = `${plan.groupId}\0${plan.subjectId}\0${subgroupId ?? ""}\0${plan.lessonKind}`;
      rows.set(key, {
        groupId: plan.groupId, subjectId: plan.subjectId, ...(subgroupId ? { subgroupId } : {}), lessonKind: plan.lessonKind,
        before: countPlanLessons(schedule, plan.groupId, quarter, plan.subjectId, subgroupId, plan.lessonKind),
        after: countPlanLessons(schedule, plan.groupId, quarter, plan.subjectId, subgroupId, plan.lessonKind), target: assignment.target,
      });
    }
  }
  return rows;
}

export function previewScheduleCopy(state: CopyState, options: ScheduleCopyOptions): ScheduleCopyPreview {
  if (options.mode !== "week" && options.mode !== "lesson") throw new Error("Неизвестный режим копирования");
  if (!Number.isInteger(options.sourceWeekOffset) || !options.sourceGroupId || !options.quarterId) throw new Error("Укажите исходную группу, неделю и четверть");
  if (!Array.isArray(options.targetWeekOffsets) || options.targetWeekOffsets.some((offset) => !Number.isFinite(offset) || !Number.isInteger(offset))) throw new Error("Номера недель назначения должны быть целыми числами");
  const quarter = state.quarters.find((entry) => entry.id === options.quarterId);
  if (!quarter) throw new Error("Четверть не найдена");
  const validWeeks = new Set(quarterWeeks(quarter));
  if (!validWeeks.has(options.sourceWeekOffset)) throw new Error("Исходная неделя не входит в четверть");
  const targetOffsets = [...new Set(options.targetWeekOffsets)].filter((offset) => offset !== options.sourceWeekOffset);
  const sourceDays = state.schedule[scheduleKey(options.sourceGroupId, options.sourceWeekOffset)] ?? [];
  const source = allLessons(state.schedule).filter((member) => member.groupId === options.sourceGroupId && member.day === sourceDays.find((day) => day.date === member.day.date) && weekDates(options.sourceWeekOffset).includes(member.day.date) && inQuarter(member.day.date, quarter));
  let selected: SourceMember[];
  if (options.mode === "lesson") {
    if (!options.sourceLessonId) throw new Error("Выберите урок для повторения");
    const item = source.find((member) => member.lesson.id === options.sourceLessonId);
    if (!item) throw new Error("Исходный урок не найден в выбранной группе и неделе");
    selected = [item];
  } else selected = source;
  const units = unitsFor(selected, state.schedule);
  const linked = new Set<string>();
  for (const unit of units) for (const member of unit.members) if (member.groupId !== options.sourceGroupId) linked.add(member.groupId);
  const added: ScheduleCopyPreview["added"] = [];
  const skipped: ScheduleCopyPreview["skipped"] = [];
  let next = state.schedule;
  const affectedGroups = new Set<string>([options.sourceGroupId, ...linked]);
  const rowsBeforeAfter = quarterHours(state.schedule, state.studyPlans, quarter, affectedGroups);
  const calendar = state.calendar;

  const skipUnit = (members: SourceMember[], offset: number, dates: Map<string, { date: string; day?: EditorDay }>, reason: string) => {
    for (const member of members) {
      const dest = dates.get(member.groupId);
      const date = dest?.date ?? weekDates(offset)[weekdayIndex(member.day.date)]!;
      skipped.push({ groupId: member.groupId, date, slot: member.slot, sourceLessonId: member.lesson.id, subjectId: member.lesson.subjectId, ...(member.lesson.event ? { event: member.lesson.event } : {}), reason });
    }
  };

  for (const offset of targetOffsets) {
    for (const unit of units) {
      const destinations = new Map<string, { date: string; day?: EditorDay }>();
      let reason: string | undefined;
      const resolved: Array<{ source: SourceMember; lesson: EditorLesson; date: string; day: EditorDay }> = [];
      for (const member of unit.members) {
        const date = weekDates(offset)[weekdayIndex(member.day.date)]!;
        const day = targetDay(next, member.groupId, offset, date);
        destinations.set(member.groupId, { date, day });
        if (!inQuarter(date, quarter)) { reason = "Дата назначения находится за пределами выбранной четверти"; break; }
        if (!day) { reason = `Для группы «${member.groupId}» нет даты ${date} в расписании`; break; }
        const isHoliday = day.holiday || (calendar ? calendarDay(calendar, member.groupId, date).holiday : false);
        if (isHoliday) { reason = "В этот день у группы нет занятий по календарю"; break; }
        const sourceResolution = resolveLesson(member, state.catalog, state.studyPlans, quarter.id);
        if (!sourceResolution.lesson) { reason = sourceResolution.reason; break; }
        const lesson = sourceResolution.lesson;
        if (member.slot >= day.slots.length || !day.times[member.slot]) { reason = `В расписании группы «${member.groupId}» нет урока №${member.slot + 1}`; break; }
        const occupied = cellOverlapReason(day, member.slot, lesson, state.catalog, member.groupId);
        if (occupied) { reason = occupied; break; }
        const timeOverlap = timeOverlapReason(day, member.slot);
        if (timeOverlap) { reason = timeOverlap; break; }
        resolved.push({ source: member, lesson, date, day });
      }
      if (!reason && unit.joint && resolved.length > 1) {
        const groupIds = resolved.map((entry) => entry.source.groupId);
        const first = resolved[0]!;
        if (new Set(groupIds).size !== groupIds.length || resolved.some((entry) => entry.lesson.subgroupId || entry.lesson.subgroup)) reason = "Совместный урок должен включать по одной записи всей группы";
        const sameSlotTimes = resolved.every((entry) => entry.day.times[entry.source.slot]?.start === first.day.times[first.source.slot]?.start && entry.day.times[entry.source.slot]?.duration === first.day.times[first.source.slot]?.duration);
        const sameSourceShape = resolved.every((entry) => entry.lesson.subjectId === first.lesson.subjectId && entry.lesson.teacherId === first.lesson.teacherId && entry.lesson.roomId === first.lesson.roomId && (entry.lesson.lessonKind ?? "regular") === (first.lesson.lessonKind ?? "regular") && entry.lesson.event === first.lesson.event);
        if (!reason && !sameSlotTimes) reason = "В целевых группах отличаются времена связанных уроков";
        else if (!reason && !sameSourceShape) reason = "Связанные исходные уроки имеют разные предметы или ресурсы";
        else if (!reason && !first.lesson.event && !canShareSubject(state.catalog.subjects.find((subject) => subject.id === first.lesson.subjectId), groupIds, state.catalog.groups)) reason = "Совместный урок больше не разрешён для этих групп";
      }
      if (reason) { skipUnit(unit.members, offset, destinations, reason); continue; }

      const jointId = unit.joint && resolved.length > 1 ? randomId("copy-joint") : undefined;
      const pending = resolved.map(({ source: member, lesson, date }) => ({
        groupId: member.groupId, offset, date, slot: member.slot,
        lesson: { ...lesson, id: randomId("copy"), ...(jointId ? { jointId } : { jointId: undefined }) } as EditorLesson,
      }));
      const trial = copyOnSchedule(next, pending);
      const roomConflict = newRoomConflict(trial, next);
      const teacherConflict = newTeacherConflict(trial, next);
      const suitability = newRoomSuitabilityViolation(trial, next, state.catalog);
      const unavailable = newUnavailabilityViolation(trial, next, state.catalog);
      const conflictReason = roomConflict ? roomConflictMessage(roomConflict, state.catalog)
        : teacherConflict ? teacherConflictMessage(teacherConflict, state.catalog)
        : suitability ? roomSuitabilityViolationMessage(suitability, state.catalog)
        : unavailable ? unavailabilityViolationMessage(unavailable, state.catalog) : undefined;
      if (conflictReason) { skipUnit(unit.members, offset, destinations, conflictReason); continue; }
      next = trial;
      for (const addition of pending) {
        added.push({ groupId: addition.groupId, date: addition.date, slot: addition.slot, lessonId: addition.lesson.id, sourceLessonId: unit.members.find((m) => m.groupId === addition.groupId)?.lesson.id ?? unit.members[0]!.lesson.id, subjectId: addition.lesson.subjectId, ...(addition.lesson.event ? { event: addition.lesson.event } : {}), ...(addition.lesson.jointId ? { jointId: addition.lesson.jointId } : {}) });
      }
    }
  }

  const hours = [...rowsBeforeAfter.values()].map((row) => ({ ...row, after: countPlanLessons(next, row.groupId, quarter, row.subjectId, row.subgroupId, row.lessonKind) }));
  return { schedule: next, sourceLessonCount: selected.length, linkedGroupIds: [...linked].sort(), added, skipped, hours };
}
