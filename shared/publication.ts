import type { StateResponse } from "../server/contracts.ts";
import type { EditorDay, EditorLesson, Schedule } from "../src/editor.ts";
import { countPlanLessons } from "../src/catalogAdapter.ts";
import { canShareSubject } from "./catalog.ts";
import { calendarDay } from "./schoolCalendar.ts";
import type { Quarter } from "./plans.ts";
import { isCompatibleJointOccupancy, roomConflictMessage, type RoomConflict, type RoomOccupancy } from "./roomConflicts.ts";
import { roomSuitabilityReason } from "./roomSuitability.ts";
import { teacherConflictMessage } from "./teacherConflicts.ts";
import { lessonUnavailability } from "./unavailability.ts";
import type { PublicationIssue, PublicationPreview, PublicationSnapshot, PublishedQuarterResponse, PublicationSummary } from "./publicationTypes.ts";

type Located = { groupId: string; day: EditorDay; slot: number; lesson: EditorLesson; start: number; end: number };
const clone = <T,>(value: T): T => structuredClone(value);
const groupOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
const timeText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function quarterFor(state: StateResponse, quarterId: string): Quarter {
  const quarter = state.quarters.find((item) => item.id === quarterId);
  if (!quarter) throw new Error("Четверть не найдена");
  return quarter;
}

function quarterSchedule(schedule: Schedule, quarter: Quarter): Schedule {
  const result: Schedule = {};
  for (const [key, days] of Object.entries(schedule)) {
    const selected = days.filter((day) => day.date >= quarter.startDate && day.date <= quarter.endDate);
    if (selected.length) result[key] = clone(selected);
  }
  return result;
}

/** Creates a detached, quarter-only publication image. */
export function createPublicationSnapshot(state: StateResponse, quarterId: string): PublicationSnapshot {
  const quarter = quarterFor(state, quarterId);
  const schedule = quarterSchedule(state.schedule, quarter);
  const plans = state.studyPlans.filter((plan) => plan.quarterId === quarterId);
  const groups = new Set(plans.map((plan) => plan.groupId));
  const subjects = new Set(plans.map((plan) => plan.subjectId));
  const assignmentKeys = new Set(plans.flatMap((plan) => plan.assignments.map((a) => `${plan.groupId}\0${plan.subjectId}\0${a.subgroupId ?? ""}`)));
  const baseline = state.baseline.filter((row) => groups.has(row.groupId) && subjects.has(row.subjectId) && assignmentKeys.has(`${row.groupId}\0${row.subjectId}\0${row.subgroupId ?? row.subgroup ?? ""}`));
  const curricula = (state.curricula ?? []).filter((item) => item.quarterId === quarterId);
  return clone({ schedule, catalog: state.catalog, studyPlans: plans, curricula, baseline, calendar: state.calendar, bellSettings: state.bellSettings, quarter });
}

function flatten(schedule: Schedule): Located[] {
  const result: Located[] = [];
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = groupOf(key);
    for (const day of days) day.slots.forEach((slot, index) => {
      const time = day.times[index];
      if (!time) return;
      for (const lesson of slot) result.push({ groupId, day, slot: index, lesson, start: time.start, end: time.start + time.duration });
    });
  }
  return result;
}

function issue(code: string, message: string, item?: Located): PublicationIssue {
  return { code, message, ...(item ? { groupId: item.groupId, date: item.day.date, lessonId: item.lesson.id } : {}) };
}

function analyze(snapshot: PublicationSnapshot): { errors: PublicationIssue[]; warnings: PublicationIssue[] } {
  const errors: PublicationIssue[] = [];
  const warnings: PublicationIssue[] = [];
  const quarter = snapshot.quarter;
  const groupById = new Map(snapshot.catalog.groups.map((item) => [item.id, item]));
  const subjectById = new Map(snapshot.catalog.subjects.map((item) => [item.id, item]));
  const teacherById = new Map(snapshot.catalog.teachers.map((item) => [item.id, item]));
  const roomById = new Map(snapshot.catalog.rooms.map((item) => [item.id, item]));
  const plans = new Map(snapshot.studyPlans.map((plan) => [`${plan.groupId}\0${plan.subjectId}\0${plan.lessonKind}`, plan]));
  const located = flatten(snapshot.schedule);
  const lessonCount = located.length;
  if (!lessonCount) warnings.push(issue("empty", "В четверти нет занятий для публикации."));

  for (const [key, days] of Object.entries(snapshot.schedule)) {
    const groupId = groupOf(key);
    const group = groupById.get(groupId);
    if (!group) errors.push({ code: "unknown-group", groupId, message: `В расписании есть неизвестная группа «${groupId}».` });
    for (const day of days) {
      const closed = day.holiday || Boolean(snapshot.calendar && calendarDay(snapshot.calendar, groupId, day.date).holiday);
      if (closed && day.slots.some((slot) => slot.length)) errors.push({ code: "holiday-lessons", groupId, date: day.date, message: `В выходной или праздничный день ${day.date} у группы «${group?.name ?? groupId}» оставлены занятия.` });
      if (!Number.isInteger(day.duration) || day.duration < 1 || day.duration > 180 || !Array.isArray(day.breaks) || day.breaks.some((gap) => !Number.isInteger(gap) || gap < 0 || gap > 240))
        errors.push({ code: "invalid-grid", groupId, date: day.date, message: `У группы «${group?.name ?? groupId}» ${day.date}: некорректная длительность урока или перемены.` });
      if (day.times.length !== day.slots.length) errors.push({ code: "invalid-grid", groupId, date: day.date, message: `У группы «${group?.name ?? groupId}» ${day.date}: число временных интервалов не совпадает с числом ячеек.` });
      let previousEnd = -1;
      for (let index = 0; index < day.slots.length; index++) {
        const time = day.times[index];
        if (!time || !Number.isInteger(time.start) || !Number.isInteger(time.duration) || time.start < 0 || time.duration < 1 || time.duration > 180 || time.start + time.duration > 1440 || time.start < previousEnd) {
          if (day.slots[index]?.length || time) errors.push({ code: "invalid-grid", groupId, date: day.date, message: `У группы «${group?.name ?? groupId}» ${day.date}: обнаружено некорректное или пересекающееся время уроков.` });
        }
        if (time) previousEnd = time.start + time.duration;
        const slot = day.slots[index] ?? [];
        if (slot.length > 1) {
          const ordinary = slot.filter((lesson) => !lesson.subgroupId && !lesson.subgroup);
          const subgroupKeys = slot.map((lesson) => lesson.subgroupId ?? lesson.subgroup ?? "");
          if (ordinary.length || subgroupKeys.some((value, i) => !value || subgroupKeys.indexOf(value) !== i)) errors.push({ code: "cell-overlap", groupId, date: day.date, message: `У группы «${group?.name ?? groupId}» ${day.date}, урок ${index + 1}: в одной ячейке пересекаются занятия.` });
        }
      }
    }
  }

  const occupancy: RoomOccupancy[] = located.map((item) => ({ lessonId: item.lesson.id, groupId: item.groupId, date: item.day.date, roomId: item.lesson.roomId, start: item.start, end: item.end, jointId: item.lesson.jointId, subjectId: item.lesson.subjectId, event: item.lesson.event, lessonKind: item.lesson.lessonKind, teacherId: item.lesson.teacherId }));
  // Strict resource sweeps include inherited conflicts without a quadratic all-school scan.
  const locatedById = new Map(located.map((item) => [item.lesson.id, item]));
  const roomBuckets = new Map<string, RoomOccupancy[]>();
  const teacherBuckets = new Map<string, RoomOccupancy[]>();
  for (const entry of occupancy) {
    if (entry.roomId && entry.end > entry.start) {
      const key = `${entry.date}\0${entry.roomId}`; const bucket = roomBuckets.get(key) ?? []; bucket.push(entry); roomBuckets.set(key, bucket);
    }
    if (entry.teacherId && entry.end > entry.start) {
      const key = `${entry.date}\0${entry.teacherId}`; const bucket = teacherBuckets.get(key) ?? []; bucket.push(entry); teacherBuckets.set(key, bucket);
    }
  }
  const reportedRoomPairs = new Set<string>();
  for (const bucket of roomBuckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: RoomOccupancy[] = [];
    for (const current of bucket) {
      for (let index = active.length - 1; index >= 0; index--) if (active[index]!.end <= current.start) active.splice(index, 1);
      for (const peer of active) if (current.start < peer.end && !isCompatibleJointOccupancy(current, peer)) {
        const pair = [current.lessonId, peer.lessonId].sort().join("\0"); if (reportedRoomPairs.has(pair)) continue; reportedRoomPairs.add(pair);
        const conflict: RoomConflict = { a: current, b: peer };
        errors.push(issue("room-conflict", roomConflictMessage(conflict, snapshot.catalog), locatedById.get(current.lessonId)));
      }
      active.push(current);
    }
  }
  const reportedTeacherPairs = new Set<string>();
  for (const bucket of teacherBuckets.values()) {
    bucket.sort((a, b) => a.start - b.start || a.end - b.end);
    const active: RoomOccupancy[] = [];
    for (const current of bucket) {
      for (let index = active.length - 1; index >= 0; index--) if (active[index]!.end <= current.start) active.splice(index, 1);
      for (const peer of active) if (current.start < peer.end && !isCompatibleJointOccupancy(current, peer)) {
        const pair = [current.lessonId, peer.lessonId].sort().join("\0"); if (reportedTeacherPairs.has(pair)) continue; reportedTeacherPairs.add(pair);
        errors.push(issue("teacher-conflict", teacherConflictMessage({ a: current, b: peer }, snapshot.catalog), locatedById.get(current.lessonId)));
      }
      active.push(current);
    }
  }

  const jointGroups = new Map<string, Located[]>();
  for (const item of located) {
    const { lesson } = item;
    const group = groupById.get(item.groupId);
    if (!group) continue;
    if (lesson.event || lesson.subjectId === "event") {
      if (!lesson.event?.trim()) errors.push(issue("invalid-event", "У мероприятия не указано название.", item));
      if (lesson.teacherId && !teacherById.has(lesson.teacherId)) errors.push(issue("unknown-teacher", `У мероприятия указан неизвестный преподаватель «${lesson.teacherId}».`, item));
      if (lesson.roomId && !roomById.has(lesson.roomId)) errors.push(issue("unknown-room", `У мероприятия указан неизвестный кабинет «${lesson.roomId}».`, item));
      if (!lesson.teacherId && lesson.teacher?.trim()) errors.push(issue("unknown-teacher", `У мероприятия указан преподаватель «${lesson.teacher}», но он не связан со справочником.`, item));
      if (!lesson.roomId && lesson.room?.trim()) errors.push(issue("unknown-room", `У мероприятия указан кабинет «${lesson.room}», но он не связан со справочником.`, item));
      if (lesson.roomId) {
        const reason = roomSuitabilityReason(snapshot.catalog, { subjectId: "event", roomId: lesson.roomId, groupId: item.groupId });
        if (reason) errors.push(issue("room-suitability", `${reason} (группа «${group.name}», ${item.day.date}).`, item));
      }
    } else {
      const subject = subjectById.get(lesson.subjectId);
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      const kind = lesson.lessonKind ?? "regular";
      if (!subject) errors.push(issue("unknown-subject", `Урок ссылается на неизвестный предмет «${lesson.subjectId}».`, item));
      if (!lesson.teacherId || !teacher) errors.push(issue("unknown-teacher", `Для предмета «${subject?.name ?? lesson.subjectId}» не найден преподаватель.`, item));
      else if (!teacher.subjectIds.includes(lesson.subjectId)) errors.push(issue("teacher-unqualified", `Преподаватель «${teacher.name}» не ведёт предмет «${subject?.name ?? lesson.subjectId}».`, item));
      if (!lesson.roomId || !room) errors.push(issue("unknown-room", `Для предмета «${subject?.name ?? lesson.subjectId}» не найден кабинет.`, item));
      if (subject && !plans.has(`${item.groupId}\0${lesson.subjectId}\0${kind}`)) errors.push(issue("missing-plan", `Для группы «${group.name}» нет плана по предмету «${subject.name}».`, item));
      const plan = plans.get(`${item.groupId}\0${lesson.subjectId}\0${kind}`);
      if (plan && lesson.subgroupId) {
        const subgroup = snapshot.catalog.subgroups.find((entry) => entry.id === lesson.subgroupId);
        if (!subgroup || subgroup.groupId !== item.groupId || !plan.assignments.some((assignment) => assignment.subgroupId === lesson.subgroupId)) errors.push(issue("invalid-subgroup", `Подгруппа у урока «${subject?.name ?? lesson.subjectId}» не входит в план группы «${group.name}».`, item));
      } else if (lesson.subgroup && !lesson.subgroupId) errors.push(issue("invalid-subgroup", `Подгруппа «${lesson.subgroup}» не связана со справочником.`, item));
      if (plan?.mode === "whole" && (lesson.subgroupId || lesson.subgroup)) errors.push(issue("invalid-plan-mode", `Предмет «${subject?.name ?? lesson.subjectId}» запланирован для всей группы «${group.name}».`, item));
      if (room && subject) {
        const reason = roomSuitabilityReason(snapshot.catalog, { subjectId: lesson.subjectId, lessonKind: kind, roomId: room.id, groupId: item.groupId, subgroupId: lesson.subgroupId, subgroup: lesson.subgroup });
        if (reason) errors.push(issue("room-suitability", `${reason} (группа «${group.name}», ${item.day.date}).`, item));
      }
    }
    for (const conflict of lessonUnavailability(snapshot.catalog, { date: item.day.date, start: item.start, end: item.end, teacherId: lesson.teacherId, roomId: lesson.roomId, teacher: lesson.teacher, room: lesson.room })) errors.push(issue("unavailable", `${conflict.kind === "teacher" ? "Преподаватель" : "Кабинет"} «${conflict.resourceName}» недоступен ${timeText(conflict.start)}–${timeText(conflict.end)}${conflict.reason ? `: ${conflict.reason}` : ""} (группа «${group.name}», ${item.day.date}).`, item));
    if (lesson.jointId) {
      const entries = jointGroups.get(lesson.jointId) ?? [];
      entries.push(item); jointGroups.set(lesson.jointId, entries);
    }
  }
  for (const [jointId, entries] of jointGroups) {
    const first = entries[0]!;
    const ids = [...new Set(entries.map((entry) => entry.groupId))];
    const matching = entries.every((entry) => entry.day.date === first.day.date && entry.start === first.start && entry.end === first.end && entry.lesson.subjectId === first.lesson.subjectId && (entry.lesson.lessonKind ?? "regular") === (first.lesson.lessonKind ?? "regular") && entry.lesson.teacherId === first.lesson.teacherId && entry.lesson.roomId === first.lesson.roomId && entry.lesson.event === first.lesson.event);
    const subject = subjectById.get(first.lesson.subjectId);
    const hasSubgroup = entries.some((entry) => entry.lesson.subgroupId || entry.lesson.subgroup);
    if (entries.length !== ids.length || !matching || hasSubgroup || (!first.lesson.event && !canShareSubject(subject, ids, snapshot.catalog.groups))) errors.push(issue("invalid-joint", `Объединённый урок «${subject?.name ?? first.lesson.event ?? first.lesson.subjectId}» (${jointId}) заполнен несогласованно или группы не могут заниматься вместе.`, first));
    if (matching && ids.length > 1 && first.lesson.roomId) {
      const reason = roomSuitabilityReason(snapshot.catalog, { subjectId: first.lesson.subjectId, lessonKind: first.lesson.lessonKind ?? "regular", roomId: first.lesson.roomId, groupId: ids[0]!, groupIds: ids });
      if (reason) errors.push(issue("room-suitability", `${reason} (объединённые группы: ${ids.map((id) => groupById.get(id)?.name ?? id).join(", ")}, ${first.day.date}).`, first));
    }
  }

  for (const plan of snapshot.studyPlans) for (const assignment of plan.assignments) {
    const actual = countPlanLessons(snapshot.schedule, plan.groupId, quarter, plan.subjectId, assignment.subgroupId ?? undefined, plan.lessonKind);
    const assignmentLabel = assignment.subgroupId
      ? snapshot.catalog.subgroups.find((entry) => entry.id === assignment.subgroupId)?.name ?? assignment.subgroupId
      : plan.mode === "subgroups" ? "все подгруппы" : "вся группа";
    const lessonType = plan.lessonKind === "lab" ? "лабораторные" : "обычные";
    if (actual < assignment.target) warnings.push({ code: "hours-deficit", groupId: plan.groupId, message: `Недобор по предмету «${subjectById.get(plan.subjectId)?.name ?? plan.subjectId}» (${assignmentLabel}, ${lessonType}): ${actual} из ${assignment.target} уроков.` });
    else if (actual > assignment.target) warnings.push({ code: "hours-excess", groupId: plan.groupId, message: `Перебор по предмету «${subjectById.get(plan.subjectId)?.name ?? plan.subjectId}» (${assignmentLabel}, ${lessonType}): ${actual} из ${assignment.target} уроков.` });
  }
  return { errors, warnings };
}

function lessonMap(snapshot: PublicationSnapshot): { signatures: Map<string, string>; groups: Map<string, string> } {
  const result = new Map<string, string>();
  const groups = new Map<string, string>();
  const teacher = new Map(snapshot.catalog.teachers.map((item) => [item.id, item.name]));
  const room = new Map(snapshot.catalog.rooms.map((item) => [item.id, item.name]));
  const subject = new Map(snapshot.catalog.subjects.map((item) => [item.id, item.name]));
  const group = new Map(snapshot.catalog.groups.map((item) => [item.id, item.name]));
  for (const [key, days] of Object.entries(snapshot.schedule)) for (const day of days) day.slots.forEach((slot, index) => slot.forEach((lesson) => {
    const when = day.times[index];
    const location = JSON.stringify([group.get(groupOf(key)) ?? groupOf(key), day.date, index, when?.start, when?.duration]);
    const details = JSON.stringify([lesson.subjectId, lesson.event ?? subject.get(lesson.subjectId) ?? lesson.subjectId, lesson.lessonKind ?? "regular", lesson.teacherId ?? "", lesson.teacherId ? teacher.get(lesson.teacherId) ?? lesson.teacherId : lesson.teacher ?? "", lesson.roomId ?? "", lesson.roomId ? room.get(lesson.roomId) ?? lesson.roomId : lesson.room ?? "", lesson.subgroupId ?? "", lesson.subgroup ?? "", lesson.jointId ?? "", lesson.note ?? ""]);
    const signature = `${location}\0${details}`;
    result.set(lesson.id, result.has(lesson.id) ? `${result.get(lesson.id)}\n${signature}` : signature);
    groups.set(lesson.id, groupOf(key));
  }));
  return { signatures: result, groups };
}

function gridMap(snapshot: PublicationSnapshot): Map<string, { signature: string; groupId: string }> {
  const result = new Map<string, { signature: string; groupId: string }>();
  for (const [key, days] of Object.entries(snapshot.schedule)) {
    const groupId = groupOf(key);
    for (const day of days) result.set(`${groupId}\0${day.date}`, {
      groupId,
      signature: JSON.stringify({ start: day.start, duration: day.duration, breaks: day.breaks, times: day.times, holiday: day.holiday, note: day.note, bellProfile: day.bellProfile }),
    });
  }
  return result;
}

function settingsSignature(snapshot: PublicationSnapshot): string {
  return JSON.stringify({ quarter: snapshot.quarter, catalog: snapshot.catalog, studyPlans: snapshot.studyPlans, curricula: snapshot.curricula, baseline: snapshot.baseline, calendar: snapshot.calendar, bellSettings: snapshot.bellSettings });
}

function diff(current: PublicationSnapshot, previous: PublishedQuarterResponse | null): PublicationSummary {
  const currentLessons = lessonMap(current);
  const oldLessons = previous ? lessonMap(previous.snapshot) : { signatures: new Map<string, string>(), groups: new Map<string, string>() };
  const currentGrid = gridMap(current);
  const oldGrid = previous ? gridMap(previous.snapshot) : new Map<string, { signature: string; groupId: string }>();
  const now = currentLessons.signatures;
  const old = oldLessons.signatures;
  let added = 0, removed = 0, changed = 0;
  const affected = new Set<string>();
  for (const [id, signature] of now) {
    const prior = old.get(id);
    if (prior === undefined) { added++; const group = currentLessons.groups.get(id); if (group) affected.add(group); }
    else if (prior !== signature) { changed++; const beforeGroup = oldLessons.groups.get(id); const afterGroup = currentLessons.groups.get(id); if (beforeGroup) affected.add(beforeGroup); if (afterGroup) affected.add(afterGroup); }
  }
  for (const id of old.keys()) if (!now.has(id)) { removed++; const group = oldLessons.groups.get(id); if (group) affected.add(group); }
  let gridChanged = !previous;
  for (const [key, entry] of currentGrid) if (oldGrid.get(key)?.signature !== entry.signature) { gridChanged = true; affected.add(entry.groupId); }
  for (const [key, entry] of oldGrid) if (!currentGrid.has(key)) { gridChanged = true; affected.add(entry.groupId); }
  const groups = new Set([...current.catalog.groups.filter((entry) => !entry.archived).map((entry) => entry.id), ...currentLessons.groups.values()]);
  return { groupCount: groups.size, lessonCount: flatten(current.schedule).length, added, removed, changed, affectedGroupIds: [...affected].sort(), settingsChanged: gridChanged || (previous ? settingsSignature(current) !== settingsSignature(previous.snapshot) : true) };
}

/** Runs strict publication checks and creates the review summary against the last published image. */
export function analyzePublication(state: StateResponse, quarterId: string, previous: PublishedQuarterResponse | null = null): PublicationPreview {
  const snapshot = createPublicationSnapshot(state, quarterId);
  const { errors, warnings } = analyze(snapshot);
  const summary = diff(snapshot, previous);
  return { quarter: snapshot.quarter, revision: state.revision, previous: previous?.publication ?? null, summary, errors, warnings, canPublish: errors.length === 0 };
}
