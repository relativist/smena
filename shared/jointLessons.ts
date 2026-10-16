import { canShareSubject } from "./catalog.ts";
import { countPlanLessons } from "../src/catalogAdapter.ts";
import { key, type EditorDay, type EditorLesson, type Location, type Schedule } from "../src/editor.ts";
import { calendarDay } from "./schoolCalendar.ts";
import { inQuarter, type Quarter } from "./plans.ts";
import { preferredRoomIds } from "./roomPreferences.ts";
import { newRoomConflict, roomConflictMessage } from "./roomConflicts.ts";
import { newTeacherConflict, teacherConflictMessage } from "./teacherConflicts.ts";
import { newRoomSuitabilityViolation, roomSuitabilityReason, roomSuitabilityViolationMessage } from "./roomSuitability.ts";
import { findUnavailability, newUnavailabilityViolation, unavailabilityViolationMessage } from "./unavailability.ts";
import type { StateResponse } from "../server/contracts.ts";

export type JointState = Pick<StateResponse, "schedule" | "catalog" | "quarters" | "studyPlans" | "calendar">;
export type JointLessonOptions = { quarterId: string; sourceGroupId: string; sourceLessonId: string; groupIds: string[]; teacherId: string; roomId?: string; start: number; duration: number; autoTime?: boolean };
export type JointLessonSource = { lesson: EditorLesson; location: Location; date: string; start: number; duration: number; lockedGroupIds: string[] };
export type JointPreview = { schedule: Schedule; groupIds: string[]; students: number; roomId?: string; conflict?: string; undoConflict?: string; time?: { start: number; duration: number }; changes: Array<{ groupId: string; date: string; slot: number; lessonId: string; kind: "existing" | "merge" | "add" }>; timingChanges?: Array<{ groupId: string; before: { start: number; duration: number }; after: { start: number; duration: number }; breaksBefore: number[]; breaksAfter: number[] }>; hours: Array<{ groupId: string; subjectId: string; before: number; after: number; target: number }> };
type Member = { groupId: string; day: EditorDay; slot: number; lesson: EditorLesson; offset: number };
const scheduleKey = (groupId: string, offset: number) => key(groupId, offset);
const randomId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const cloneSchedule = (schedule: Schedule): Schedule => structuredClone(schedule);
const groupOfKey = (value: string) => value.slice(0, value.lastIndexOf(":"));
function members(schedule: Schedule): Member[] {
  return Object.entries(schedule).flatMap(([entryKey, days]) => {
    const groupId = groupOfKey(entryKey), offset = Number(entryKey.slice(entryKey.lastIndexOf(":") + 1));
    return days.flatMap(day => day.slots.flatMap((slot, slotIndex) => slot.map(lesson => ({ groupId, day, slot: slotIndex, lesson, offset }))));
  });
}
function group(state: JointState, id: string) { return state.catalog.groups.find(item => item.id === id && !item.archived); }
function plan(state: JointState, groupId: string, subjectId: string, kind: "regular" | "lab", quarterId: string) { return state.studyPlans.find(item => item.groupId === groupId && item.subjectId === subjectId && item.lessonKind === kind && item.quarterId === quarterId && item.mode === "whole" && item.assignments.some(assignment => assignment.subgroupId === null)); }
function failPreview(state: JointState, groupIds: string[], conflict: string): JointPreview { return { schedule: state.schedule, groupIds, students: groupIds.reduce((sum, id) => sum + (group(state, id)?.students ?? 0), 0), conflict, changes: [], hours: [] }; }
function validTime(start: number, duration: number) { return Number.isInteger(start) && Number.isInteger(duration) && start >= 0 && duration > 0 && duration <= 180 && start + duration <= 1440; }

export function getJointLessonSource(state: JointState, sourceGroupId: string, sourceLessonId: string): JointLessonSource {
  const entry = members(state.schedule).find(item => item.groupId === sourceGroupId && item.lesson.id === sourceLessonId);
  if (!entry) throw new Error("Исходный урок не найден в выбранной группе");
  const { lesson, day, slot, offset } = entry;
  if (lesson.event || lesson.subjectId === "event") throw new Error("Мероприятие нельзя объединить как урок");
  if (lesson.subgroupId || lesson.subgroup) throw new Error("Объединять можно только урок всей группы");
  const quarter = state.quarters.find(item => inQuarter(day.date, item) && plan(state, sourceGroupId, lesson.subjectId, lesson.lessonKind ?? "regular", item.id));
  if (!quarter) throw new Error("У исходного урока нет плана всей группы в четверти");
  const jointMembers = lesson.jointId ? members(state.schedule).filter(item => item.lesson.jointId === lesson.jointId) : [];
  if (jointMembers.some(item => item.day.date !== day.date)) throw new Error("Связанные записи исходного урока находятся на разных датах");
  const lockedGroupIds = lesson.jointId ? [...new Set(jointMembers.map(item => item.groupId))] : [sourceGroupId];
  return { lesson, location: { groupId: sourceGroupId, weekOffset: offset, date: day.date, slot }, date: day.date, start: day.times[slot]?.start ?? -1, duration: day.times[slot]?.duration ?? -1, lockedGroupIds };
}
function sameSubjectKind(lesson: EditorLesson, source: EditorLesson) { return !lesson.event && !lesson.subgroupId && !lesson.subgroup && lesson.subjectId === source.subjectId && (lesson.lessonKind ?? "regular") === (source.lessonKind ?? "regular"); }
function arrangeDay(day: EditorDay, slot: number, start: number, duration: number): boolean {
  if (slot < 0 || slot >= day.slots.length || !day.times[slot] || !validTime(start, duration)) return false;
  const end = start + duration;
  for (let i = 0; i < day.times.length; i++) if (i !== slot && day.slots[i]?.length) { const t = day.times[i]!; if (start < t.start + t.duration && t.start < end) return false; }
  const times = day.times.map((time, i) => i === slot ? { start, duration } : { ...time });
  if (times.some((time, i) => i > 0 && time.start < times[i - 1]!.start + times[i - 1]!.duration)) return false;
  if (times.some((time, i) => i < times.length - 1 && times[i + 1]!.start - time.start - time.duration > 240)) return false;
  day.times = times;
  if (times.length) day.start = `${String(Math.floor(times[0]!.start / 60)).padStart(2, "0")}:${String(times[0]!.start % 60).padStart(2, "0")}`;
  day.breaks = times.slice(0, -1).map((time, i) => times[i + 1]!.start - time.start - time.duration);
  return true;
}
function findCell(day: EditorDay, start: number, duration: number, originalStart: number, originalDuration: number, source: EditorLesson, autoTime = false) {
  const intervals: Array<[number, number]> = [[start, duration]];
  if (start !== originalStart || duration !== originalDuration) intervals.push([originalStart, originalDuration]);
  for (const [s, d] of intervals) { const slot = day.times.findIndex((time, i) => time.start === s && time.duration === d && day.slots[i]?.some(lesson => sameSubjectKind(lesson, source))); if (slot >= 0) return { slot, kind: "merge" as const }; }
  if (autoTime) {
    const slot = day.times.findIndex((time, i) => day.slots[i]?.some(lesson => sameSubjectKind(lesson, source)) && Math.abs(time.start - start) <= 120 && time.start < start + duration && start < time.start + time.duration);
    if (slot >= 0) return { slot, kind: "merge" as const };
    const empty = day.times.map((time, i) => ({ time, i })).filter(({ time, i }) => day.slots[i]?.length === 0 && Math.abs(time.start - start) <= 120).sort((a, b) => Math.abs(a.time.start - start) - Math.abs(b.time.start - start))[0];
    if (empty) return { slot: empty.i, kind: "add" as const };
  }
  for (const [s, d] of intervals) { const slot = day.times.findIndex((time, i) => time.start === s && time.duration === d && day.slots[i]?.length === 0); if (slot >= 0) return { slot, kind: "add" as const }; }
  return undefined;
}
function jointTimeCandidates(days: EditorDay[], source: JointLessonSource, options: JointLessonOptions): number[] {
  if (!options.autoTime) return [options.start];
  const candidates = new Set<number>([options.start, source.start]);
  for (const day of days) {
    for (let slot = 0; slot < day.times.length; slot++) {
      const time = day.times[slot]!;
      if (day.slots[slot]?.some(lesson => sameSubjectKind(lesson, source.lesson) && (!lesson.jointId || lesson.jointId === source.lesson.jointId))) candidates.add(time.start);
      const previous = day.times[slot - 1], next = day.times[slot + 1];
      const lower = Math.max(0, (previous ? previous.start + previous.duration : 0), (next ? next.start - options.duration - 240 : 0));
      const upper = Math.min(1440 - options.duration, (previous ? previous.start + previous.duration + 240 : 1440), (next ? next.start - options.duration : 1440));
      if (lower <= upper) {
        candidates.add(Math.max(lower, Math.min(upper, source.start)));
        candidates.add(lower);
        candidates.add(upper);
      }
    }
  }
  return [...candidates].filter(start => Math.abs(start - source.start) <= 120).sort((a, b) => Math.abs(a - source.start) - Math.abs(b - source.start));
}
function locallyPlaceable(groupIds: string[], source: JointLessonSource, options: JointLessonOptions, days: Map<string, EditorDay>, membersByGroupDate: Map<string, Member[]>): boolean {
  const used = new Set<string>();
  for (const id of groupIds) {
    const day = days.get(id);
    if (!day) return false;
    const own = (membersByGroupDate.get(`${id}|${source.date}`) ?? []).find(item => source.lesson.jointId
      ? item.lesson.jointId === source.lesson.jointId
      : id === options.sourceGroupId && item.lesson.id === options.sourceLessonId);
    let slot: number;
    if (own) {
      slot = own.slot;
      const items = day.slots[slot] ?? [];
      if (items.length !== 1 || items[0]?.id !== own.lesson.id || used.has(own.lesson.id)) return false;
      used.add(own.lesson.id);
    } else {
      const found = findCell(day, options.start, options.duration, source.start, source.duration, source.lesson, options.autoTime);
      if (!found) return false;
      slot = found.slot;
      const items = day.slots[slot] ?? [];
      if (found.kind === "merge") {
        const lesson = items.find(item => sameSubjectKind(item, source.lesson) && !used.has(item.id));
        if (!lesson || (lesson.jointId && lesson.jointId !== source.lesson.jointId) || items.length !== 1) return false;
        used.add(lesson.id);
      } else if (items.length) return false;
    }
    const trial = structuredClone(day);
    if (!arrangeDay(trial, slot, options.start, options.duration)) return false;
  }
  return true;
}
function hoursFor(state: JointState, schedule: Schedule, groupIds: string[], quarter: Quarter, subjectId: string, kind: "regular" | "lab") {
  return groupIds.flatMap(groupId => { const activePlan = plan(state, groupId, subjectId, kind, quarter.id); if (!activePlan) return []; return [{ groupId, subjectId, before: countPlanLessons(state.schedule, groupId, quarter, subjectId, undefined, kind), after: countPlanLessons(schedule, groupId, quarter, subjectId, undefined, kind), target: activePlan.assignments.reduce((sum, item) => sum + item.target, 0) }]; });
}

function previewAtTime(state: JointState, options: JointLessonOptions): JointPreview {
  const selected = [...new Set(options.groupIds)];
  const fail = (message: string) => failPreview(state, selected, message);
  let source: JointLessonSource;
  try { source = getJointLessonSource(state, options.sourceGroupId, options.sourceLessonId); } catch (error) { return fail(error instanceof Error ? error.message : "Исходный урок недоступен"); }
  const quarter = state.quarters.find(item => item.id === options.quarterId);
  if (!quarter || !inQuarter(source.date, quarter)) return fail("Исходный урок находится за пределами выбранной четверти");
  if (selected.length < 2) return fail("Выберите не менее двух групп");
  if (!selected.includes(options.sourceGroupId)) return fail("Оставьте исходную группу в выборе");
  if (source.lockedGroupIds.some(id => !selected.includes(id))) return fail("Исходный урок уже объединён. Оставьте все связанные группы в выборе");
  if (selected.some(id => !group(state, id))) return fail("Выбрана отсутствующая или архивная группа");
  if (!validTime(options.start, options.duration)) return fail("Проверьте время и длительность урока");
  const kind = source.lesson.lessonKind ?? "regular", subject = state.catalog.subjects.find(item => item.id === source.lesson.subjectId && !item.archived);
  if (!subject || !canShareSubject(subject, selected, state.catalog.groups)) return fail("Совместный урок не разрешён для выбранных групп или превышен лимит групп");
  for (const groupId of selected) {
    if (!plan(state, groupId, subject.id, kind, quarter.id)) return fail(`У группы «${group(state, groupId)?.name ?? groupId}» нет плана всей группы по этому предмету и виду занятия`);
    const day = state.schedule[scheduleKey(groupId, source.location.weekOffset)]?.find(item => item.date === source.date);
    if (!day) return fail(`У группы «${group(state, groupId)?.name ?? groupId}» нет этой даты в расписании`);
    if (day.holiday || (state.calendar && calendarDay(state.calendar, groupId, source.date).holiday)) return fail(`В группе «${group(state, groupId)?.name ?? groupId}» на эту дату занятия отменены`);
  }
  const teacher = state.catalog.teachers.find(item => item.id === options.teacherId && !item.archived);
  if (!teacher || !teacher.subjectIds.includes(subject.id)) return fail("Выберите действующего преподавателя, у которого есть этот предмет");
  const base = cloneSchedule(state.schedule);
  const sourceEntries = source.lesson.jointId ? members(base).filter(item => item.day.date === source.date && item.lesson.jointId === source.lesson.jointId) : [members(base).find(item => item.groupId === options.sourceGroupId && item.lesson.id === options.sourceLessonId)!];
  const used = new Set<string>(), placements: Array<{ groupId: string; day: EditorDay; slot: number; lesson: EditorLesson; kind: "existing" | "merge" | "add"; before: { start: number; duration: number }; breaksBefore: number[] }> = [];
  for (const groupId of selected) {
    const day = base[scheduleKey(groupId, source.location.weekOffset)]?.find(item => item.date === source.date)!;
    const own = sourceEntries.find(item => item.groupId === groupId);
    let slot: number, changeKind: "existing" | "merge" | "add", lesson: EditorLesson;
    if (own) {
      slot = own.slot;
      lesson = day.slots[slot]?.find(item => item.id === own.lesson.id)!;
      if (!lesson) return fail("Связанная запись исходного урока изменилась");
      if (day.slots[slot]!.some(item => item.id !== lesson.id)) return fail(`В ячейке группы «${group(state, groupId)?.name ?? groupId}» вместе с исходным зеркалом есть другие записи`);
      changeKind = "existing";
      used.add(lesson.id);
    }
    else {
      const found = findCell(day, options.start, options.duration, source.start, source.duration, source.lesson, options.autoTime);
      if (!found) return fail(`У группы «${group(state, groupId)?.name ?? groupId}» нет свободной ячейки или совместимого урока на выбранное время`);
      slot = found.slot; changeKind = found.kind;
      if (found.kind === "merge") {
        lesson = day.slots[slot]!.find(item => sameSubjectKind(item, source.lesson) && !used.has(item.id))!;
        if (!lesson) return fail(`В группе «${group(state, groupId)?.name ?? groupId}» уже выбрана эта запись`);
        if (lesson.jointId && lesson.jointId !== source.lesson.jointId) return fail(`В группе «${group(state, groupId)?.name ?? groupId}» уже есть другое совместное занятие`);
        if (day.slots[slot]!.some(item => item.id !== lesson.id)) return fail(`В ячейке группы «${group(state, groupId)?.name ?? groupId}» есть другие записи помимо объединяемого урока`);
        used.add(lesson.id);
      }
      else lesson = { ...source.lesson, id: randomId("joint-lesson"), jointId: undefined };
    }
    if (day.holiday || (state.calendar && calendarDay(state.calendar, groupId, source.date).holiday)) return fail(`В группе «${group(state, groupId)?.name ?? groupId}» на эту дату занятия отменены`);
    const before = { ...(day.times[slot] ?? { start: -1, duration: -1 }) }, breaksBefore = [...day.breaks];
    if (!arrangeDay(day, slot, options.start, options.duration)) return fail(`Время урока пересекается с другим занятием или нарушает сетку у группы «${group(state, groupId)?.name ?? groupId}»`);
    if (changeKind === "add") day.slots[slot]!.push(lesson);
    lesson.subjectId = subject.id; lesson.teacherId = teacher.id; lesson.teacher = teacher.name;
    lesson.roomId = options.roomId; lesson.room = options.roomId ? state.catalog.rooms.find(room => room.id === options.roomId)?.name : undefined;
    placements.push({ groupId, day, slot, lesson, kind: changeKind, before, breaksBefore });
  }
  const jointId = source.lesson.jointId ?? randomId("joint");
  for (const item of placements) item.lesson.jointId = jointId;
  const roomIds = options.roomId ? [options.roomId] : preferredRoomIds(state.catalog, selected, teacher.id);
  const candidates = options.roomId ? roomIds : roomIds.filter(roomId => !roomSuitabilityReason(state.catalog, { subjectId: subject.id, lessonKind: kind, groupId: selected[0]!, groupIds: selected, roomId }));
  if (!candidates.length && roomIds.length) {
    const reason = roomSuitabilityReason(state.catalog, { subjectId: subject.id, lessonKind: kind, groupId: selected[0]!, groupIds: selected, roomId: roomIds[0] });
    return fail(reason ?? "Нет подходящего кабинета для совместного урока");
  }
  let chosenRoom: string | undefined, lastReason: string | undefined;
  for (const roomId of candidates) {
    const room = state.catalog.rooms.find(item => item.id === roomId && !item.archived);
    if (!room) { lastReason = "Выбранный кабинет отсутствует или архивирован"; continue; }
    const suitability = roomSuitabilityReason(state.catalog, { subjectId: subject.id, lessonKind: kind, groupId: selected[0]!, groupIds: selected, roomId });
    if (suitability) { lastReason = suitability; continue; }
    const unavailable = findUnavailability(state.catalog, "teacher", teacher.id, source.date, options.start, options.start + options.duration)[0] ?? findUnavailability(state.catalog, "room", room.id, source.date, options.start, options.start + options.duration)[0];
    if (unavailable) { lastReason = `${unavailable.kind === "teacher" ? "Преподаватель" : "Кабинет"} «${unavailable.resourceName}» недоступен${unavailable.reason ? `: ${unavailable.reason}` : ""}`; continue; }
    const trial = cloneSchedule(base);
    for (const item of placements) { const entry = members(trial).find(member => member.groupId === item.groupId && member.lesson.id === item.lesson.id)!; entry.lesson.roomId = room.id; entry.lesson.room = room.name; }
    const rc = newRoomConflict(trial, state.schedule), tc = newTeacherConflict(trial, state.schedule), uv = newUnavailabilityViolation(trial, state.schedule, state.catalog), sv = newRoomSuitabilityViolation(trial, state.schedule, state.catalog);
    if (rc || tc || uv || sv) { lastReason = rc ? roomConflictMessage(rc, state.catalog) : tc ? teacherConflictMessage(tc, state.catalog) : uv ? unavailabilityViolationMessage(uv, state.catalog) : roomSuitabilityViolationMessage(sv!, state.catalog); continue; }
    chosenRoom = roomId;
    for (const item of placements) { item.lesson.roomId = room.id; item.lesson.room = room.name; }
    break;
  }
  if (!chosenRoom) return fail(lastReason ?? "Нет подходящего свободного кабинета для совместного урока");
  const rc = newRoomConflict(base, state.schedule), tc = newTeacherConflict(base, state.schedule), uv = newUnavailabilityViolation(base, state.schedule, state.catalog), sv = newRoomSuitabilityViolation(base, state.schedule, state.catalog);
  if (rc || tc || uv || sv) return fail(rc ? roomConflictMessage(rc, state.catalog) : tc ? teacherConflictMessage(tc, state.catalog) : uv ? unavailabilityViolationMessage(uv, state.catalog) : roomSuitabilityViolationMessage(sv!, state.catalog));
  const rrc = newRoomConflict(state.schedule, base), rtc = newTeacherConflict(state.schedule, base), ruv = newUnavailabilityViolation(state.schedule, base, state.catalog), rsv = newRoomSuitabilityViolation(state.schedule, base, state.catalog);
  const undoConflict = rrc ? roomConflictMessage(rrc, state.catalog) : rtc ? teacherConflictMessage(rtc, state.catalog) : rsv ? roomSuitabilityViolationMessage(rsv, state.catalog) : ruv ? unavailabilityViolationMessage(ruv, state.catalog) : undefined;
  const changes = placements.map(item => ({ groupId: item.groupId, date: source.date, slot: item.slot, lessonId: item.lesson.id, kind: item.kind }));
  const schedule = JSON.stringify(base) === JSON.stringify(state.schedule) ? state.schedule : base;
  const timingChanges = placements.filter(item => item.before.start !== options.start || item.before.duration !== options.duration).map(item => ({ groupId: item.groupId, before: item.before, after: { start: options.start, duration: options.duration }, breaksBefore: item.breaksBefore, breaksAfter: [...item.day.breaks] }));
  return { schedule, groupIds: selected, students: selected.reduce((sum, id) => sum + (group(state, id)?.students ?? 0), 0), roomId: chosenRoom, time: { start: options.start, duration: options.duration }, ...(undoConflict ? { undoConflict } : {}), changes, ...(timingChanges.length ? { timingChanges } : {}), hours: hoursFor(state, schedule, selected, quarter, subject.id, kind) };
}

export function previewJointLesson(state: JointState, options: JointLessonOptions): JointPreview {
  if (!options.autoTime) return previewAtTime(state, options);
  let source: JointLessonSource;
  try { source = getJointLessonSource(state, options.sourceGroupId, options.sourceLessonId); }
  catch { return previewAtTime(state, options); }
  const selected = new Set(options.groupIds);
  const days = [...selected].flatMap(id => state.schedule[scheduleKey(id, source.location.weekOffset)]?.filter(day => day.date === source.date) ?? []);
  const candidates = jointTimeCandidates(days, source, options);
  let last: JointPreview | undefined;
  for (const start of candidates) {
    last = previewAtTime(state, { ...options, start, autoTime: true });
    if (!last.conflict) return last;
  }
  return last ?? previewAtTime(state, options);
}

export function getEligibleJointGroupIds(state: JointState, options: JointLessonOptions): string[] {
  let source: JointLessonSource;
  try { source = getJointLessonSource(state, options.sourceGroupId, options.sourceLessonId); } catch { return []; }
  const selected = [...new Set(options.groupIds)];
  const quarter = state.quarters.find(item => item.id === options.quarterId);
  const subject = state.catalog.subjects.find(item => item.id === source.lesson.subjectId && !item.archived);
  if (!quarter || !inQuarter(source.date, quarter) || !subject || !selected.includes(options.sourceGroupId) || source.lockedGroupIds.some(id => !selected.includes(id))) return [];
  const kind = source.lesson.lessonKind ?? "regular";
  const membersByGroupDate = new Map<string, Member[]>();
  for (const member of members(state.schedule)) {
    const mapKey = `${member.groupId}|${member.day.date}`;
    const list = membersByGroupDate.get(mapKey) ?? [];
    list.push(member);
    membersByGroupDate.set(mapKey, list);
  }
  const candidates = state.catalog.groups.filter(item => !item.archived && !selected.includes(item.id));
  const eligible: string[] = [];
  for (const candidate of candidates) {
    const groupIds = [...selected, candidate.id];
    if (!canShareSubject(subject, groupIds, state.catalog.groups) || groupIds.some(id => !group(state, id) || !plan(state, id, subject.id, kind, quarter.id))) continue;
    let daysOk = true;
    const days = new Map<string, EditorDay>();
    for (const id of groupIds) {
      const day = state.schedule[scheduleKey(id, source.location.weekOffset)]?.find(item => item.date === source.date);
      if (!day || day.holiday || (state.calendar && calendarDay(state.calendar, id, source.date).holiday)) { daysOk = false; break; }
      days.set(id, day);
    }
    if (!daysOk) continue;
    const dayList = groupIds.map(id => days.get(id)!);
    const starts = jointTimeCandidates(dayList, source, options);
    const feasible = starts.some(start => validTime(start, options.duration) && locallyPlaceable(groupIds, source, { ...options, start }, days, membersByGroupDate));
    if (feasible) eligible.push(candidate.id);
  }
  return eligible;
}
