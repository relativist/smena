import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AsyncDatabase } from "./database.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter } from "../shared/plans.ts";
import type { SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { PublishedQuarterResponse } from "../shared/publicationTypes.ts";
import type { Schedule } from "../src/editor.ts";
import { collectTeacherLoad, summarizeTeacherLoad, type TeacherLoadRow, type TeacherLoadSummary } from "../shared/teacherLoad.ts";
import { loadPercent, teacherLoadMonth, WEEKLY_LOAD_TARGET, type LoadPeriod } from "../shared/teacherLoadPeriods.ts";
import { calendarDay, studyWeekdays } from "../shared/schoolCalendar.ts";

export type TeacherLoadSource = "draft" | "published";
export type TeacherLoadApiDeps = {
  db: AsyncDatabase;
  getSession(request: FastifyRequest): Promise<unknown | null>;
  readCatalog(): Promise<Catalog>;
  readQuarters(): Promise<Quarter[]>;
  readCalendar(): Promise<SchoolCalendar>;
  readSchedule(catalog: Catalog, dates?: string[], groupIds?: string[]): Promise<Schedule>;
  readPublishedQuarter(id: string): Promise<PublishedQuarterResponse | null>;
};

export type TeacherLoadPeriod = LoadPeriod & { incomplete: boolean };
export type TeacherLoadSummaryResponse = {
  source: TeacherLoadSource;
  month: string;
  periods: { start: string; end: string; weeks: TeacherLoadPeriod[]; studyDays: number; target: number; nonStudyLabel?: string };
  rows: Array<{ id: string; name: string; archived: boolean; month: TeacherLoadSummary; weeks: TeacherLoadSummary[] }>;
  missingQuarters: Array<{ id: string; name: string }>;
  publications: Array<{ quarterId: string; quarterName: string; version: number; publishedAt: string }>;
};
export type TeacherQuarterLoadResponse = { quarterId: string; target: number; teachers: Array<{ id: string; name: string; lessons: number; percent: number | null }> };

const validMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const datesBetween = (start: string, end: string) => {
  const dates: string[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
};
const clipSchedule = (schedule: Schedule, start: string, end: string): Schedule => Object.fromEntries(
  Object.entries(schedule).flatMap(([key, days]) => {
    const selected = days.filter(day => day.date >= start && day.date <= end);
    return selected.length ? [[key, selected]] : [];
  }),
);

async function resolveSources(source: TeacherLoadSource, month: string, deps: TeacherLoadApiDeps) {
  const quarters = (await deps.readQuarters()).filter(quarter => quarter.startDate <= monthEnd(month) && quarter.endDate >= `${month}-01`);
  const missingQuarters: Array<{ id: string; name: string }> = [];
  const publications: TeacherLoadSummaryResponse["publications"] = [];
  const calendars: Array<{ quarter: Quarter; calendar?: SchoolCalendar }> = [];
  const snapshots: PublishedQuarterResponse[] = [];
  if (source === "draft") {
    const calendar = await deps.readCalendar();
    quarters.forEach(quarter => calendars.push({ quarter, calendar }));
  } else {
    for (const quarter of quarters) {
      const publication = await deps.readPublishedQuarter(quarter.id);
      if (!publication) { missingQuarters.push({ id: quarter.id, name: quarter.name }); continue; }
      snapshots.push(publication);
      calendars.push({ quarter: publication.snapshot.quarter, calendar: publication.snapshot.calendar });
      publications.push({ quarterId: quarter.id, quarterName: publication.snapshot.quarter.name, version: publication.publication.version, publishedAt: publication.publication.publishedAt });
    }
  }
  const periods = teacherLoadMonth(month, calendars);
  const incomplete = (start: string, end: string) => source === "published" && missingQuarters.some(quarter => {
    const original = quarters.find(item => item.id === quarter.id)!;
    return original.startDate <= end && original.endDate >= start;
  });
  const resolvedCatalog: Catalog = source === "draft" ? await deps.readCatalog() : { subjects: [], teachers: [], rooms: [], groups: [], subgroups: [] };
  if (source === "published") {
    const seen = new Map<keyof Catalog, Set<string>>();
    for (const kind of Object.keys(resolvedCatalog) as (keyof Catalog)[]) seen.set(kind, new Set());
    for (const { snapshot } of snapshots) for (const kind of Object.keys(resolvedCatalog) as (keyof Catalog)[]) {
      const ids = seen.get(kind)!;
      for (const entry of snapshot.catalog[kind]) if (!ids.has(entry.id)) {
        ids.add(entry.id);
        (resolvedCatalog[kind] as unknown[]).push(entry);
      }
    }
  }
  return { quarters, missingQuarters, publications, calendars, snapshots, periods, incomplete, resolvedCatalog };
}

async function scheduleForRange(source: TeacherLoadSource, start: string, end: string, details: Awaited<ReturnType<typeof resolveSources>>, catalog: Catalog, deps: TeacherLoadApiDeps): Promise<Schedule> {
  if (source === "draft") return await deps.readSchedule(catalog, datesBetween(start, end));
  const merged: Schedule = {};
  for (const { snapshot } of details.snapshots) {
    const clipped = clipSchedule(snapshot.schedule, start, end);
    for (const [key, days] of Object.entries(clipped)) merged[key] = [...(merged[key] ?? []), ...days];
  }
  return merged;
}

// Kept separate from the route builder so unit tests can validate summary parity.
export async function calculateTeacherLoadSummary(source: TeacherLoadSource, month: string, catalog: Catalog, deps: TeacherLoadApiDeps): Promise<TeacherLoadSummaryResponse> {
  const details = await resolveSources(source, month, deps);
  const effectiveCatalog = source === "draft" ? catalog : details.resolvedCatalog;
  const schedule = await scheduleForRange(source, details.periods.start, details.periods.end, details, effectiveCatalog, deps);
  const rows = collectTeacherLoad(schedule, effectiveCatalog).map(row => ({
    id: row.id, name: row.name, archived: row.archived,
    month: summarizeTeacherLoad(row.lessons, details.periods.start, details.periods.end),
    weeks: details.periods.weeks.map(week => summarizeTeacherLoad(row.lessons, week.start, week.end)),
  }));
  return {
    source, month,
    periods: { ...details.periods, weeks: details.periods.weeks.map(week => ({ ...week, incomplete: details.incomplete(week.start, week.end) })) },
    rows, missingQuarters: details.missingQuarters, publications: details.publications,
  };
}

// Get the row for a single teacher with just the requested detail range.
export async function calculateTeacherLoadDetails(source: TeacherLoadSource, month: string, teacherId: string, start: string, end: string, catalog: Catalog, deps: TeacherLoadApiDeps): Promise<TeacherLoadRow | null> {
  const periods = await resolveSources(source, month, deps);
  const startDate = start < periods.periods.start ? periods.periods.start : start;
  const endDate = end > periods.periods.end ? periods.periods.end : end;
  if (startDate > endDate) return null;
  const effectiveCatalog = source === "draft" ? catalog : periods.resolvedCatalog;
  const schedule = await scheduleForRange(source, startDate, endDate, periods, effectiveCatalog, deps);
  return collectTeacherLoad(schedule, effectiveCatalog).find(row => row.id === teacherId) ?? null;
}

export async function calculateTeacherQuarterLoad(quarterId: string, catalog: Catalog, deps: TeacherLoadApiDeps): Promise<TeacherQuarterLoadResponse | null> {
  const quarter = (await deps.readQuarters()).find(item => item.id === quarterId);
  if (!quarter) return null;
  const calendar = await deps.readCalendar();
  const weekdays = studyWeekdays(calendar, "").length;
  let target = 0;
  if (weekdays) for (const date of datesBetween(quarter.startDate, quarter.endDate)) {
    if (!calendarDay(calendar, "", date).holiday) target += WEEKLY_LOAD_TARGET / weekdays;
  }
  const schedule = await deps.readSchedule(catalog, datesBetween(quarter.startDate, quarter.endDate));
  const teachers = collectTeacherLoad(schedule, catalog).map(row => {
    const lessons = summarizeTeacherLoad(row.lessons, quarter.startDate, quarter.endDate).lessons;
    return { id: row.id, name: row.name, lessons, percent: loadPercent(lessons, target) };
  });
  return { quarterId, target, teachers };
}

export async function registerTeacherLoadApi(app: FastifyInstance, deps: TeacherLoadApiDeps): Promise<void> {
  app.get<{ Querystring: { quarterId?: string } }>("/api/teacher-load/quarter", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход" });
    const quarterId = request.query.quarterId;
    if (typeof quarterId !== "string" || !quarterId.trim() || quarterId.length > 120) return reply.code(400).send({ error: "Укажите четверть" });
    try {
      const result = await calculateTeacherQuarterLoad(quarterId, await deps.readCatalog(), deps);
      if (!result) return reply.code(404).send({ error: "Четверть не найдена" });
      reply.header("cache-control", "no-store");
      return result;
    } catch { return reply.code(400).send({ error: "Не удалось рассчитать нагрузку за четверть" }); }
  });
  app.get<{ Querystring: { source?: string; month?: string } }>("/api/teacher-load", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход" });
    const source = request.query.source;
    const month = request.query.month;
    if ((source !== "draft" && source !== "published") || !validMonth(month)) return reply.code(400).send({ error: "Укажите источник и месяц в формате ГГГГ-ММ" });
    try { return await calculateTeacherLoadSummary(source, month, await deps.readCatalog(), deps); }
    catch { return reply.code(400).send({ error: "Не удалось рассчитать нагрузку за выбранный месяц" }); }
  });
  app.get<{ Querystring: { source?: string; month?: string; teacherId?: string; startDate?: string; endDate?: string } }>("/api/teacher-load/details", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход" });
    const { source, month, teacherId, startDate, endDate } = request.query;
    if ((source !== "draft" && source !== "published") || !validMonth(month) || !teacherId || teacherId.length > 200 || !validDate(startDate) || !validDate(endDate) || startDate > endDate) return reply.code(400).send({ error: "Некорректные параметры подробностей нагрузки" });
    try { return { teacher: await calculateTeacherLoadDetails(source, month, teacherId, startDate, endDate, await deps.readCatalog(), deps) }; }
    catch { return reply.code(400).send({ error: "Не удалось загрузить уроки учителя" }); }
  });
}
