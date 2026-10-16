import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AsyncDatabase } from "./database.ts";
import { createHash } from "node:crypto";
import { clearScheduleRange } from "../shared/scheduleMaintenance.ts";
import { previewScheduleCopy, type ScheduleCopyOptions } from "../shared/scheduleCopy.ts";
import { getEligibleJointGroupIds, getJointLessonSource, previewJointLesson, type JointLessonOptions } from "../shared/jointLessons.ts";
import { applyServiceEvent, removeServiceEvent, type ServiceEventInput } from "../shared/serviceEvents.ts";
import { quarterWeeks, weekDates, weekOffsetFor } from "../shared/plans.ts";
import type { Schedule } from "../src/editor.ts";
import type { StateResponse } from "./contracts.ts";
import type { FastifyReply } from "fastify";

export type BulkApiDeps = {
  db: AsyncDatabase;
  getSession(request: FastifyRequest): Promise<{ csrfToken?: string } | null>;
  isSameOrigin(request: FastifyRequest): boolean;
  readState(options: { dates?: string[]; groupIds?: string[]; quarterId?: string; includePlans?: boolean }): Promise<StateResponse>;
  commit(before: StateResponse, next: Schedule, revision: number, requestId: string): Promise<{ revision: number; updatedAt: string }>;
};

type BulkOperation = "clear" | "copy" | "joint" | "event";
type BulkRequest = { revision: number; requestId?: string; operation: BulkOperation; options: Record<string, unknown> };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : isRecord(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const fingerprint = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 120;
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const validWeek = (value: unknown): value is number => Number.isInteger(value) && Number.isFinite(value) && Math.abs(value as number) <= 10000;
class BulkApiError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; }
}
const dateRange = (from: string, to: string): string[] => {
  const first = Date.parse(`${from}T00:00:00Z`), last = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new BulkApiError("Укажите корректный период");
  if ((last - first) / 86400000 > 3659) throw new BulkApiError("Период очистки не может превышать 10 лет");
  const dates: string[] = [];
  for (let time = first; time <= last; time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
};
const weekDateRange = (offset: number) => weekDates(offset);
const operationContext = (request: BulkRequest, state: StateResponse) => {
  const options = request.options;
  if (request.operation === "clear") {
    if (!Array.isArray(options.groupIds) || !options.groupIds.length || options.groupIds.some(id => !validId(id)) || !options.groupIds.every(id => state.catalog.groups.some(group => group.id === id)) || !validDate(options.startDate) || !validDate(options.endDate) || options.startDate > options.endDate) throw new BulkApiError("Укажите группы и корректный период очистки");
    return { dates: dateRange(options.startDate, options.endDate), groupIds: options.groupIds as string[], includePlans: false };
  }
  if (request.operation === "copy") {
    const value = options as unknown as ScheduleCopyOptions;
    const quarter = state.quarters.find(item => item.id === value.quarterId);
    if (!quarter || !validId(value.sourceGroupId) || !state.catalog.groups.some(group => group.id === value.sourceGroupId) || !validWeek(value.sourceWeekOffset) || !Array.isArray(value.targetWeekOffsets) || value.targetWeekOffsets.some(offset => !validWeek(offset))) throw new BulkApiError("Некорректные параметры копирования расписания");
    const offsets = [value.sourceWeekOffset, ...value.targetWeekOffsets];
    const dates = [...new Set(offsets.flatMap(weekDateRange).filter(date => date >= quarter.startDate && date <= quarter.endDate))];
    return { dates, quarterId: value.quarterId, includePlans: true };
  }
  if (request.operation === "joint") {
    const value = options as unknown as JointLessonOptions;
    if (!validId(value.quarterId) || !validId(value.sourceGroupId) || !validId(value.sourceLessonId)) throw new BulkApiError("Некорректные параметры объединения групп");
    const quarter = state.quarters.find(item => item.id === value.quarterId);
    // The source date comes from the bounded editor week; only that date is needed.
    const date = typeof options.sourceDate === "string" && validDate(options.sourceDate) ? options.sourceDate : undefined;
    const offset = typeof options.sourceWeekOffset === "number" && validWeek(options.sourceWeekOffset) ? options.sourceWeekOffset : undefined;
    if (!quarter || !date || offset === undefined) throw new BulkApiError("Не удалось определить дату исходного урока");
    return { dates: [date], quarterId: value.quarterId, includePlans: true };
  }
  const value = options as unknown as ServiceEventInput;
  if (!Array.isArray(value.groupIds) || !value.groupIds.length || value.groupIds.some(id => !validId(id)) || !value.groupIds.every(id => state.catalog.groups.some(group => group.id === id)) || !validDate(value.date)) throw new BulkApiError("Некорректные параметры мероприятия");
  for (const flag of [options.replaceLessons, options.preserveLessonRemainder]) {
    if (flag !== undefined && typeof flag !== "boolean") throw new BulkApiError("Некорректный режим размещения мероприятия");
  }
  if (options.replaceLessons && options.preserveLessonRemainder) throw new BulkApiError("Выберите один режим: заменить уроки или сохранить остаток урока");
  return { dates: [value.date], includePlans: false };
};

function eventLessonChanges(before: StateResponse, after: Schedule) {
  const remaining = new Map(Object.values(after).flatMap(days => days.flatMap(day =>
    day.slots.flatMap((slot, index) => slot.map(lesson => [lesson.id, day.times[index]!] as const)),
  )));
  return Object.entries(before.schedule).flatMap(([scheduleKey, days]) => {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    const groupName = before.catalog.groups.find(group => group.id === groupId)?.name ?? groupId;
    return days.flatMap(day => day.slots.flatMap((slot, index) => slot.flatMap(lesson => {
      if (lesson.event || lesson.subjectId === "event") return [];
      const original = day.times[index]!;
      const next = remaining.get(lesson.id);
      if (next && next.start === original.start && next.duration === original.duration) return [];
      return [{
        lessonId: lesson.id, groupId, groupName, date: day.date,
        subjectName: before.catalog.subjects.find(subject => subject.id === lesson.subjectId)?.name ?? lesson.subjectId,
        subgroup: lesson.subgroup,
        before: { start: original.start, duration: original.duration },
        ...(next ? { after: { start: next.start, duration: next.duration } } : {}),
      }];
    })));
  });
}

function resultFor(request: BulkRequest, before: StateResponse) {
  const options = request.options;
  if (request.operation === "clear") {
    const result = clearScheduleRange(before.schedule, options.groupIds as string[], options.startDate as string, options.endDate as string);
    return { schedule: result.schedule, preview: { removedCount: result.removedCount } };
  }
  if (request.operation === "event" && options.remove === true) {
    const result = removeServiceEvent(before.schedule, String(options.lessonId ?? ""), before.catalog);
    return { schedule: result, preview: { removed: true, affectedLessons: eventLessonChanges(before, result) } };
  }
  if (request.operation === "copy") {
    const result = previewScheduleCopy(before, options as unknown as ScheduleCopyOptions);
    const { schedule, ...preview } = result;
    const details = preview.added.flatMap(row => {
      const day = schedule[`${row.groupId}:${weekOffsetFor(row.date)}`]?.find(item => item.date === row.date);
      const time = day?.times[row.slot];
      const lesson = day?.slots[row.slot]?.find(item => item.id === row.lessonId);
      return time ? [{ lessonId: row.lessonId, start: time.start, duration: time.duration, teacherId: lesson?.teacherId, roomId: lesson?.roomId }] : [];
    });
    return { schedule, preview: { ...preview, details } };
  }
  if (request.operation === "joint") {
    const result = previewJointLesson(before, options as unknown as JointLessonOptions);
    if (result.conflict) throw new Error(result.conflict);
    const { schedule, ...preview } = result;
    return { schedule, preview };
  }
  const result = applyServiceEvent(before.schedule, before.catalog, options as unknown as ServiceEventInput);
  return { schedule: result, preview: {
    date: (options as ServiceEventInput).date,
    groupIds: (options as ServiceEventInput).groupIds,
    affectedLessons: eventLessonChanges(before, result),
  } };
}

function changedDays(before: Schedule, after: Schedule) {
  const rows: Array<{ groupId: string; weekOffset: number; date: string }> = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldDays = before[key] ?? [], newDays = after[key] ?? [];
    const days = newDays.filter(day => {
      const previous = oldDays.find(item => item.date === day.date);
      return !previous || JSON.stringify(previous) !== JSON.stringify(day);
    });
    const split = key.lastIndexOf(":");
    rows.push(...days.map(day => ({ groupId: key.slice(0, split), weekOffset: Number(key.slice(split + 1)), date: day.date })));
  }
  return rows;
}

export async function registerBulkApi(app: FastifyInstance, deps: BulkApiDeps): Promise<void> {
  await deps.db.exec(`CREATE TABLE IF NOT EXISTS schedule_operation_replays (
    request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL
  )`);
  app.get<{ Querystring: { date?: string } }>("/api/schedule-operations/event-context", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (!validDate(request.query.date)) return reply.code(400).send({ error: "Укажите корректную дату мероприятия" });
    const context = await deps.readState({ dates: [request.query.date], includePlans: false });
    reply.header("cache-control", "no-store");
    return { revision: context.revision, schedule: context.schedule };
  });
  app.post<{ Body: { revision: number; options: JointLessonOptions & { sourceDate?: string; sourceWeekOffset?: number } } }>("/api/schedule-operations/joint-candidates", async (request, reply) => {
    if (!deps.isSameOrigin(request)) return reply.code(403).send({ error: "Недопустимый источник запроса" });
    const session = await deps.getSession(request);
    if (!session) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (request.headers["x-csrf-token"] !== session.csrfToken) return reply.code(403).send({ error: "Проверка запроса не пройдена" });
    const options = request.body?.options;
    if (!Number.isInteger(request.body?.revision) || !options || !validId(options.quarterId) || !validId(options.sourceGroupId) || !validId(options.sourceLessonId)) return reply.code(400).send({ error: "Некорректный запрос подходящих групп" });
    try {
      const found = await deps.db.prepare("SELECT d.date, d.week_offset FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id=? AND d.group_id=?")
        .get(options.sourceLessonId, options.sourceGroupId) as { date: string; week_offset: number } | undefined;
      if (!found) return reply.code(404).send({ error: "Исходный урок не найден" });
      const before = await deps.readState({ quarterId: options.quarterId, dates: [found.date], includePlans: true });
      if (before.revision !== request.body.revision) return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю и повторите действие." });
      const jointOptions: JointLessonOptions = {
        quarterId: options.quarterId, sourceGroupId: options.sourceGroupId, sourceLessonId: options.sourceLessonId,
        groupIds: options.groupIds, teacherId: options.teacherId, roomId: options.roomId,
        start: options.start, duration: options.duration, autoTime: options.autoTime,
      };
      const eligibleGroupIds = getEligibleJointGroupIds(before, jointOptions);
      let source;
      try { source = getJointLessonSource(before, options.sourceGroupId, options.sourceLessonId); }
      catch (error) { throw new BulkApiError(error instanceof Error ? error.message : "Исходный урок недоступен"); }
      return { revision: before.revision, eligibleGroupIds, lockedGroupIds: source.lockedGroupIds };
    } catch (error) {
      const statusCode = error instanceof BulkApiError ? error.statusCode : isRecord(error) && Number.isInteger(error.statusCode) && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Не удалось подобрать подходящие группы" });
    }
  });
  const run = (kind: "preview" | "apply") => async (request: FastifyRequest<{ Body: BulkRequest }>, reply: FastifyReply) => {
    if (!deps.isSameOrigin(request)) return reply.code(403).send({ error: "Недопустимый источник запроса" });
    const session = await deps.getSession(request);
    if (!session) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (request.headers["x-csrf-token"] !== session.csrfToken) return reply.code(403).send({ error: "Проверка запроса не пройдена" });
    const body = request.body;
    if (!isRecord(body) || !Number.isInteger(body.revision) || !isRecord(body.options) || !["clear", "copy", "joint", "event"].includes(String(body.operation)) || (kind === "apply" && !validId(body.requestId))) return reply.code(400).send({ error: "Некорректный запрос массового изменения расписания" });
    reply.header("cache-control", "no-store");
    try {
      const requestData = body as BulkRequest;
      const operationFingerprint = fingerprint({ revision: requestData.revision, operation: requestData.operation, options: requestData.options });
      if (kind === "apply") {
        const replay = await deps.db.prepare("SELECT fingerprint,response_json FROM schedule_operation_replays WHERE request_id=?")
          .get(requestData.requestId) as { fingerprint: string; response_json: string } | undefined;
        if (replay) {
          if (replay.fingerprint !== operationFingerprint) return reply.code(409).send({ error: "Этот идентификатор запроса уже использован" });
          return JSON.parse(replay.response_json) as unknown;
        }
      }
      if (requestData.operation === "joint") {
        const options = requestData.options;
        const found = await deps.db.prepare("SELECT d.date, d.week_offset FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id=? AND d.group_id=?")
          .get(options.sourceLessonId, options.sourceGroupId) as { date: string; week_offset: number } | undefined;
        if (!found) return reply.code(404).send({ error: "Исходный урок не найден" });
        requestData.options = { ...options, sourceDate: found.date, sourceWeekOffset: found.week_offset };
      }
      if (requestData.operation === "event") {
        const options = requestData.options;
        if (typeof options.lessonId === "string") {
          const found = await deps.db.prepare("SELECT d.date, d.group_id FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.id=?")
            .get(options.lessonId) as { date: string; group_id: string } | undefined;
          if (!found) return reply.code(404).send({ error: "Мероприятие уже удалено из расписания" });
          const linked = await deps.db.prepare("SELECT DISTINCT d.group_id FROM lessons l JOIN schedule_slots s ON s.id=l.slot_id JOIN schedule_days d ON d.id=s.day_id WHERE l.joint_id=(SELECT joint_id FROM lessons WHERE id=?) OR l.id=?")
            .all(options.lessonId, options.lessonId) as Array<{ group_id: string }>;
          requestData.options = {
            ...options, date: found.date,
            ...(options.remove === true ? { groupIds: [...new Set(linked.map(item => item.group_id))] } : {}),
          };
        }
      }
      const metadataOptions = requestData.operation === "clear"
        ? { dates: [], includePlans: false }
        : requestData.operation === "event"
          ? { dates: [], includePlans: false }
          : { quarterId: String(requestData.options.quarterId ?? ""), dates: [], includePlans: true };
      const metadata = await deps.readState(metadataOptions);
      const context = operationContext(requestData, metadata);
      const before = await deps.readState(context);
      if (before.revision !== requestData.revision) return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю и повторите действие." });
      let operationState = before;
      if (requestData.operation === "copy") {
        const copyOptions = requestData.options as unknown as ScheduleCopyOptions;
        const initial = previewScheduleCopy(before, copyOptions);
        const quarter = before.quarters.find(item => item.id === copyOptions.quarterId)!;
        const groupIds = [...new Set([copyOptions.sourceGroupId, ...initial.linkedGroupIds])];
        const quarterDates = [...new Set(quarterWeeks(quarter).flatMap(weekDates).filter(date => date >= quarter.startDate && date <= quarter.endDate))];
        const quarterState = await deps.readState({ quarterId: quarter.id, dates: quarterDates, groupIds, includePlans: true });
        if (quarterState.revision !== requestData.revision) return reply.code(409).send({ error: "Расписание изменилось. Обновите неделю и повторите действие." });
        // Keep the complete selected-group quarter for plan counts, but also keep
        // every group's lessons on source/target dates so global teacher/room
        // conflicts are evaluated against the actual destination context.
        operationState = { ...before, studyPlans: quarterState.studyPlans, schedule: { ...before.schedule, ...quarterState.schedule } };
      }
      const result = resultFor(requestData, operationState);
      if (requestData.operation === "copy") {
        const dates = new Set(Object.values(before.schedule).flatMap(days => days.map(day => day.date)));
        result.schedule = Object.fromEntries(Object.entries(result.schedule).flatMap(([key, days]) => {
          const selected = days.filter(day => dates.has(day.date));
          return selected.length ? [[key, selected]] : [];
        }));
      }
      if (kind === "preview") return { revision: before.revision, ...result.preview };
      const changed = changedDays(before.schedule, result.schedule);
      return await deps.db.transaction(async () => {
        const saved = await deps.commit(before, result.schedule, requestData.revision, requestData.requestId!);
        const response = { ...saved, changedDays: changed, preview: result.preview };
        await deps.db.prepare("INSERT INTO schedule_operation_replays(request_id,fingerprint,response_json) VALUES(?,?,?)")
          .run(requestData.requestId!, operationFingerprint, JSON.stringify(response));
        return response;
      })();
    } catch (error) {
      const statusCode = error instanceof BulkApiError ? error.statusCode : isRecord(error) && Number.isInteger(error.statusCode) && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Не удалось обработать изменение расписания" });
    }
  };
  app.post<{ Body: BulkRequest }>("/api/schedule-operations/preview", run("preview"));
  app.post<{ Body: BulkRequest }>("/api/schedule-operations/apply", run("apply"));
}
