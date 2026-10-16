import type { Catalog, CatalogTeacher } from "./catalog.ts";
import { teacherLabel } from "./catalog.ts";
import { findUnavailability } from "./unavailability.ts";
import { findTeacherConflicts, type TeacherOccupancy } from "./teacherConflicts.ts";
import { findRoomConflict, type RoomOccupancy } from "./roomConflicts.ts";
import { roomSuitabilityReason } from "./roomSuitability.ts";
import type { EditorLesson, Schedule } from "../src/editor.ts";

export type ReplacementRequest = {
  teacherId: string;
  startDate: string;
  endDate: string;
  groupId?: string;
  subjectId?: string;
  ruleId?: string;
};

type Located = {
  groupId: string;
  lesson: EditorLesson;
  date: string;
  start: number;
  end: number;
};

type CandidateFailure = {
  kind: "qualification" | "teacher-unavailable" | "room-missing" | "room-unavailable" | "room-suitability" | "conflict";
  reason: string;
};

type Unit = {
  id: string;
  items: Located[];
  lessonIds: string[];
  groupIds: string[];
  subjectId: string;
  date: string;
  start: number;
  end: number;
  candidates: CatalogTeacher[];
  failures: CandidateFailure[];
  reason?: string;
};

export type AutomaticTeacherReplacementPreview = {
  schedule: Schedule;
  changedLessonIds: string[];
  skipped: { lessonId: string; reason: string }[];
  units: {
    id: string;
    lessonIds: string[];
    groupIds: string[];
    subjectId: string;
    date: string;
    start: number;
    end: number;
    teacherId?: string;
    reason?: string;
  }[];
  allocations: {
    groupId: string;
    subjectId: string;
    subgroupId?: string;
    subgroup?: string;
    teacherId: string;
  }[];
};

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function locate(schedule: Schedule): Located[] {
  const result: Located[] = [];
  for (const [key, days] of Object.entries(schedule)) {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    for (const day of days) {
      day.slots.forEach((slot, slotIndex) => {
        const time = day.times[slotIndex];
        if (!time) return;
        for (const lesson of slot) {
          result.push({
            groupId,
            lesson,
            date: day.date,
            start: time.start,
            end: time.start + time.duration,
          });
        }
      });
    }
  }
  return result;
}

function teacherOccupancy(item: Located, teacherId: string): TeacherOccupancy {
  return {
    lessonId: item.lesson.id,
    groupId: item.groupId,
    date: item.date,
    start: item.start,
    end: item.end,
    teacherId,
    jointId: item.lesson.jointId,
    subjectId: item.lesson.subjectId,
    event: item.lesson.event,
    lessonKind: item.lesson.lessonKind,
    roomId: item.lesson.roomId,
  };
}

function roomOccupancy(item: Located): RoomOccupancy {
  return {
    lessonId: item.lesson.id,
    groupId: item.groupId,
    date: item.date,
    start: item.start,
    end: item.end,
    roomId: item.lesson.roomId,
    jointId: item.lesson.jointId,
    subjectId: item.lesson.subjectId,
    event: item.lesson.event,
    lessonKind: item.lesson.lessonKind,
    teacherId: item.lesson.teacherId,
  };
}

function targetKey(item: Located): string {
  return item.lesson.jointId
    ? `joint:${item.date}:${item.lesson.jointId}`
    : `lesson:${item.groupId}:${item.date}:${item.lesson.id}`;
}

function groupKey(groupId: string, subjectId: string, lesson: EditorLesson): string {
  return `${groupId}\0${subjectId}\0${lesson.subgroupId ?? lesson.subgroup ?? ""}`;
}

function checkCandidate(
  candidate: CatalogTeacher,
  unit: Unit,
  catalog: Catalog,
  targetLessonIds: Set<string>,
  teacherIndex: Map<string, Located[]>,
  roomIndex: Map<string, Located[]>,
): CandidateFailure | undefined {
  if (unit.items.some(item => !candidate.subjectIds.includes(item.lesson.subjectId))) {
    return { kind: "qualification", reason: "У преподавателя нет специальности для этого предмета." };
  }

  for (const item of unit.items) {
    if (findUnavailability(catalog, "teacher", candidate.id, item.date, item.start, item.end).length) {
      return { kind: "teacher-unavailable", reason: "Преподаватель недоступен в это время." };
    }

    const room = item.lesson.roomId
      ? catalog.rooms.find(entry => entry.id === item.lesson.roomId)
      : undefined;
    if (!room || room.archived) {
      return {
        kind: "room-missing",
        reason: "Кабинет урока отсутствует или архивирован; автоматически менять кабинет нельзя.",
      };
    }
    if (findUnavailability(catalog, "room", room.id, item.date, item.start, item.end).length) {
      return { kind: "room-unavailable", reason: `Кабинет «${room.name}» недоступен в это время.` };
    }

    const suitability = roomSuitabilityReason(catalog, {
      subjectId: item.lesson.subjectId,
      lessonKind: item.lesson.lessonKind,
      roomId: room.id,
      groupId: item.groupId,
      subgroupId: item.lesson.subgroupId,
      subgroup: item.lesson.subgroup,
      groupIds: unit.groupIds,
    });
    if (suitability) return { kind: "room-suitability", reason: suitability };

    const peers = (teacherIndex.get(`${candidate.id}\0${item.date}`) ?? [])
      .filter(peer => !targetLessonIds.has(peer.lesson.id))
      .map(peer => teacherOccupancy(peer, peer.lesson.teacherId ?? ""));
    const teacherConflict = findTeacherConflicts(
      peers,
      teacherOccupancy(item, candidate.id),
      item.lesson.id,
    )[0];
    if (teacherConflict) {
      const groupName = catalog.groups.find(group => group.id === teacherConflict.b.groupId)?.name
        ?? teacherConflict.b.groupId;
      return { kind: "conflict", reason: `Уже занят уроком группы «${groupName}».` };
    }

    const roomPeers = (roomIndex.get(`${room.id}\0${item.date}`) ?? [])
      .filter(peer => !targetLessonIds.has(peer.lesson.id))
      .map(roomOccupancy);
    if (findRoomConflict(roomPeers, roomOccupancy(item), item.lesson.id)) {
      return { kind: "conflict", reason: `Кабинет «${room.name}» уже занят другой группой.` };
    }
  }
  return undefined;
}

function rejectionReason(failures: CandidateFailure[]): string {
  const kinds = new Set(failures.map(failure => failure.kind));
  if (kinds.has("qualification") && kinds.size === 1) {
    return "Нет активного преподавателя с нужной специальностью.";
  }
  if (kinds.has("teacher-unavailable") && kinds.size === 1) {
    return "Все преподаватели с нужной специальностью недоступны в это время.";
  }
  if (kinds.size === 1) return failures[0]!.reason;
  if (kinds.has("room-unavailable") && kinds.size === 1) {
    return failures[0]!.reason;
  }
  if (kinds.has("room-missing") && kinds.size === 1) return failures[0]!.reason;
  if (kinds.has("room-suitability") && kinds.size === 1) return failures[0]!.reason;
  if (kinds.has("conflict") && kinds.size === 1) {
    return "Все подходящие преподаватели заняты одновременно с уроком.";
  }
  const firstByPriority = ["room-missing", "room-unavailable", "room-suitability", "teacher-unavailable", "conflict", "qualification"];
  return firstByPriority.map(kind => failures.find(failure => failure.kind === kind)?.reason).find(Boolean)
    ?? "Нет свободного преподавателя, подходящего для этого урока.";
}

function lessonOccurrenceKey(item: Located): string {
  return item.lesson.jointId
    ? `joint:${item.date}:${item.lesson.jointId}`
    : `lesson:${item.date}:${item.groupId}:${item.lesson.id}`;
}

function teacherLoad(teacherId: string, accepted: Located[]): number {
  return new Set(accepted
    .filter(item => item.lesson.teacherId === teacherId)
    .map(lessonOccurrenceKey)).size;
}

function dayGapMinutes(items: Array<{ start: number; end: number }>): number {
  const unique = new Map(items.map(item => [`${item.start}:${item.end}`, item]));
  const sorted = [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let end = -1;
  for (const item of sorted) {
    if (end >= 0 && item.start > end) {
      const gap = item.start - end;
      if (gap > 20) total += gap;
    }
    end = Math.max(end, item.end);
  }
  return total;
}

function addedGapMinutes(candidateId: string, unit: Unit, accepted: Located[]): number {
  const dates = new Set(unit.items.map(item => item.date));
  let increase = 0;
  for (const date of dates) {
    const existing = accepted
      .filter(item => item.date === date && item.lesson.teacherId === candidateId)
      .map(item => ({ start: item.start, end: item.end }));
    const proposed = unit.items
      .filter(item => item.date === date)
      .map(item => ({ start: item.start, end: item.end }));
    increase += Math.max(0, dayGapMinutes([...existing, ...proposed]) - dayGapMinutes(existing));
  }
  return increase;
}

function surname(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function candidateScore(
  teacher: CatalogTeacher,
  unit: Unit,
  streams: Map<string, Unit[]>,
  streamTeachers: Map<string, string>,
  accepted: Located[],
): number {
  const preferred = unit.groupIds.filter(id => teacher.preferredGroupIds?.includes(id)).length;
  const continuityKeys = unit.items.map(item => groupKey(item.groupId, item.lesson.subjectId, item.lesson));
  const alreadyAssigned = continuityKeys.some(key => streamTeachers.get(key) === teacher.id);
  const stream = streams.get(continuityKeys[0] ?? "") ?? [];
  const canContinue = stream.length > 1 && stream.every(entry => entry.candidates.some(option => option.id === teacher.id));
  const continuityBonus = alreadyAssigned ? -10_000_000 : canContinue ? -100_000 : 0;
  return -preferred * 100_000_000 + continuityBonus
    + teacherLoad(teacher.id, accepted) * 100
    + addedGapMinutes(teacher.id, unit, accepted);
}

/** Proposes safe teacher substitutions for lessons covered by a selected absence rule. */
export function previewAutomaticTeacherReplacement(
  schedule: Schedule,
  catalog: Catalog,
  request: ReplacementRequest,
): AutomaticTeacherReplacementPreview {
  if (!request || !catalog.teachers.some(teacher => teacher.id === request.teacherId)) {
    throw new Error("Укажите существующего исходного преподавателя.");
  }
  if (!isValidDate(request.startDate) || !isValidDate(request.endDate) || request.startDate > request.endDate) {
    throw new Error("Укажите корректный период замены.");
  }
  if (request.groupId && !catalog.groups.some(group => group.id === request.groupId)) {
    throw new Error("Выбранная группа не найдена в справочнике.");
  }
  if (request.subjectId && !catalog.subjects.some(subject => subject.id === request.subjectId)) {
    throw new Error("Выбранный предмет не найден в справочнике.");
  }

  const source = catalog.teachers.find(teacher => teacher.id === request.teacherId)!;
  if (request.ruleId && !source.unavailability?.some(rule => rule.id === request.ruleId)) {
    throw new Error("Ограничение недоступности не найдено у выбранного преподавателя.");
  }

  const all = locate(schedule);
  const byTeacherDay = new Map<string, Located[]>();
  const byRoomDay = new Map<string, Located[]>();
  for (const item of all) {
    if (item.lesson.teacherId) {
      const key = `${item.lesson.teacherId}\0${item.date}`;
      const entries = byTeacherDay.get(key) ?? [];
      entries.push(item);
      byTeacherDay.set(key, entries);
    }
    if (item.lesson.roomId) {
      const key = `${item.lesson.roomId}\0${item.date}`;
      const entries = byRoomDay.get(key) ?? [];
      entries.push(item);
      byRoomDay.set(key, entries);
    }
  }

  const matching = all.filter(item =>
    item.date >= request.startDate
    && item.date <= request.endDate
    && item.lesson.teacherId === request.teacherId
    && (!request.groupId || request.groupId === item.groupId)
    && (!request.subjectId || request.subjectId === item.lesson.subjectId)
    && (source.unavailability ?? []).some(rule =>
      (!request.ruleId || rule.id === request.ruleId)
      && item.date >= rule.startDate
      && item.date <= rule.endDate
      && (!rule.weekdays || rule.weekdays.includes(new Date(`${item.date}T00:00:00.000Z`).getUTCDay() || 7))
      && item.start < rule.end
      && rule.start < item.end));

  const targetKeys = new Set(matching.map(targetKey));
  const targetLessonIds = new Set<string>();
  const unitItems = [...targetKeys].map(key => {
    const entries = key.startsWith("joint:")
      ? all.filter(item => targetKey(item) === key)
      : matching.filter(item => targetKey(item) === key);
    for (const item of entries) targetLessonIds.add(item.lesson.id);
    return entries;
  });

  const activeCandidates = catalog.teachers.filter(teacher => !teacher.archived && teacher.id !== source.id);
  const units: Unit[] = unitItems.map((items, index) => {
    const first = items[0]!;
    const unit: Unit = {
      id: `replacement-${index + 1}`,
      items,
      lessonIds: items.map(item => item.lesson.id),
      groupIds: [...new Set(items.map(item => item.groupId))],
      subjectId: first.lesson.subjectId,
      date: first.date,
      start: first.start,
      end: first.end,
      candidates: [],
      failures: [],
    };

    if (items.some(item => item.lesson.event || item.lesson.subjectId === "event")) {
      unit.reason = "Общее мероприятие: назначьте ответственного в карточке мероприятия.";
      return unit;
    }
    if (items.some(item => item.lesson.teacherId !== source.id)) {
      unit.reason = "В объединённом уроке указаны разные преподаватели; сначала проверьте его состав.";
      return unit;
    }
    if (items.some(item => item.date !== first.date || item.start !== first.start || item.end !== first.end
      || item.lesson.subjectId !== first.lesson.subjectId)) {
      unit.reason = "У объединённых записей не совпадают предмет или время; сначала проверьте расписание.";
      return unit;
    }

    for (const candidate of activeCandidates) {
      const failure = checkCandidate(candidate, unit, catalog, targetLessonIds, byTeacherDay, byRoomDay);
      if (failure) unit.failures.push(failure);
      else unit.candidates.push(candidate);
    }
    if (!unit.candidates.length) {
      const qualified = activeCandidates.some(teacher => items.every(item => teacher.subjectIds.includes(item.lesson.subjectId)));
      unit.reason = qualified
        ? rejectionReason(unit.failures)
        : "Нет активного преподавателя со специальностью для всех предметов этого урока.";
    }
    return unit;
  });

  const streams = new Map<string, Unit[]>();
  for (const unit of units) {
    for (const item of unit.items) {
      const key = groupKey(item.groupId, item.lesson.subjectId, item.lesson);
      const stream = streams.get(key) ?? [];
      if (!stream.includes(unit)) stream.push(unit);
      streams.set(key, stream);
    }
  }

  // Most constrained units are decided first. Continuity influences ranking, while every
  // selected lesson immediately updates occupancy, workload, and gap costs for later choices.
  const pending = units
    .filter(unit => !unit.reason)
    .sort((a, b) => a.candidates.length - b.candidates.length
      || a.date.localeCompare(b.date)
      || a.start - b.start
      || a.id.localeCompare(b.id));
  const accepted = all.filter(item => !targetLessonIds.has(item.lesson.id));
  const streamTeachers = new Map<string, string>();
  const assigned = new Map<string, CatalogTeacher>();
  for (const unit of pending) {
    const ranked = [...unit.candidates].sort((a, b) =>
      candidateScore(a, unit, streams, streamTeachers, accepted)
        - candidateScore(b, unit, streams, streamTeachers, accepted)
      || surname(a.name).localeCompare(surname(b.name), "ru")
      || a.id.localeCompare(b.id));
    const chosen = ranked.find(candidate => unit.items.every(item => {
      const sameDay = accepted
        .filter(peer => peer.date === item.date)
        .map(peer => teacherOccupancy(peer, peer.lesson.teacherId ?? ""));
      return findTeacherConflicts(sameDay, teacherOccupancy(item, candidate.id), item.lesson.id).length === 0;
    }));
    if (!chosen) {
      unit.reason = "Подходящие преподаватели уже заняты другими выбранными заменами.";
      continue;
    }
    assigned.set(unit.id, chosen);
    for (const item of unit.items) {
      accepted.push({ ...item, lesson: { ...item.lesson, teacherId: chosen.id } });
      streamTeachers.set(groupKey(item.groupId, item.lesson.subjectId, item.lesson), chosen.id);
    }
  }

  const changedLessonIds: string[] = [];
  const skipped: { lessonId: string; reason: string }[] = [];
  const replacements = new Map<string, EditorLesson>();
  for (const unit of units) {
    const teacher = assigned.get(unit.id);
    if (!teacher) {
      for (const lessonId of unit.lessonIds) {
        skipped.push({ lessonId, reason: unit.reason ?? "Не удалось подобрать замену." });
      }
      continue;
    }
    changedLessonIds.push(...unit.lessonIds);
    for (const item of unit.items) {
      replacements.set(item.lesson.id, {
        ...item.lesson,
        teacherId: teacher.id,
        teacher: teacherLabel(teacher.name),
      });
    }
  }

  const next: Schedule = Object.fromEntries(Object.entries(schedule).map(([key, days]) => [
    key,
    days.map(day => ({
      ...day,
      slots: day.slots.map(slot => slot.map(lesson => replacements.get(lesson.id) ?? lesson)),
    })),
  ]));

  const allocationMap = new Map<string, AutomaticTeacherReplacementPreview["allocations"][number]>();
  for (const unit of units) {
    const teacher = assigned.get(unit.id);
    if (!teacher) continue;
    for (const item of unit.items) {
      const subgroup = item.lesson.subgroupId ?? item.lesson.subgroup ?? "";
      const key = `${item.groupId}\0${item.lesson.subjectId}\0${subgroup}\0${teacher.id}`;
      allocationMap.set(key, {
        groupId: item.groupId,
        subjectId: item.lesson.subjectId,
        ...(item.lesson.subgroupId ? { subgroupId: item.lesson.subgroupId } : {}),
        ...(item.lesson.subgroup ? { subgroup: item.lesson.subgroup } : {}),
        teacherId: teacher.id,
      });
    }
  }

  return {
    schedule: next,
    changedLessonIds,
    skipped,
    units: units.map(unit => {
      const teacher = assigned.get(unit.id);
      return {
        id: unit.id,
        lessonIds: unit.lessonIds,
        groupIds: unit.groupIds,
        subjectId: unit.subjectId,
        date: unit.date,
        start: unit.start,
        end: unit.end,
        ...(teacher ? { teacherId: teacher.id } : {}),
        ...(unit.reason ? { reason: unit.reason } : {}),
      };
    }),
    allocations: [...allocationMap.values()],
  };
}
