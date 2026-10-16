import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AsyncDatabase } from "./database.ts";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import { planCoverageDetails, planCoverageSummary } from "../shared/planCoverage.ts";

type LessonCountRow = {
  groupId: string; subjectId: string; lessonKind: "regular" | "lab";
  subgroupId: string | null; subgroupLabel: string | null; count: number;
};

async function readLessonCounts(db: AsyncDatabase, quarter: Quarter, groupId?: string): Promise<LessonCountRow[]> {
  const groupClause = groupId ? " AND d.group_id=?" : "";
  const params = groupId ? [quarter.startDate, quarter.endDate, groupId] : [quarter.startDate, quarter.endDate];
  return await db.prepare(`
    SELECT d.group_id AS groupId, l.subject_id AS subjectId,
      COALESCE(l.lesson_kind,'regular') AS lessonKind,
      l.subgroup_ref AS subgroupId, l.subgroup AS subgroupLabel,
      COUNT(DISTINCT l.id) AS count
    FROM lessons l
    JOIN schedule_slots s ON s.id=l.slot_id
    JOIN schedule_days d ON d.id=s.day_id
    WHERE d.date BETWEEN ? AND ? AND (l.event IS NULL OR l.event='')
      AND l.subject_id<>'event'${groupClause}
    GROUP BY d.group_id,l.subject_id,COALESCE(l.lesson_kind,'regular'),l.subgroup_ref,l.subgroup
  `).all(...params) as LessonCountRow[];
}

export type PlanCoverageApiDeps = {
  db: AsyncDatabase;
  getSession(request: FastifyRequest): Promise<unknown | null>;
  readCatalog(): Promise<Catalog>;
  readQuarters(): Promise<Quarter[]>;
  readStudyPlans(quarterId: string): Promise<StudyPlan[]>;
};

export async function registerPlanCoverageApi(app: FastifyInstance, deps: PlanCoverageApiDeps): Promise<void> {
  app.get<{ Querystring: { quarterId?: string } }>("/api/plan-coverage", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход" });
    const quarterId = request.query.quarterId;
    if (typeof quarterId !== "string" || !quarterId.trim() || quarterId.length > 120)
      return reply.code(400).send({ error: "Укажите четверть" });
    const quarter = (await deps.readQuarters()).find(item => item.id === quarterId);
    if (!quarter) return reply.code(404).send({ error: "Четверть не найдена" });
    try {
      const catalog = await deps.readCatalog();
      const lessonRows = await readLessonCounts(deps.db, quarter);
      const response = planCoverageSummary(quarter, catalog.groups, await deps.readStudyPlans(quarterId), lessonRows);
      reply.header("cache-control", "no-store");
      return response;
    } catch {
      return reply.code(400).send({ error: "Не удалось рассчитать выполнение учебных планов" });
    }
  });

  app.get<{ Querystring: { quarterId?: string; groupId?: string } }>("/api/plan-coverage/details", async (request, reply) => {
    if (!await deps.getSession(request)) return reply.code(401).send({ error: "Требуется вход" });
    const { quarterId, groupId } = request.query;
    if (typeof quarterId !== "string" || !quarterId.trim() || quarterId.length > 120
      || typeof groupId !== "string" || !groupId.trim() || groupId.length > 120)
      return reply.code(400).send({ error: "Укажите четверть и класс" });
    const quarter = (await deps.readQuarters()).find(item => item.id === quarterId);
    if (!quarter) return reply.code(404).send({ error: "Четверть не найдена" });
    try {
      const catalog = await deps.readCatalog();
      const group = catalog.groups.find(item => item.id === groupId);
      if (!group) return reply.code(404).send({ error: "Класс не найден" });
      const lessonRows = await readLessonCounts(deps.db, quarter, groupId);
      const response = planCoverageDetails(
        quarter,
        { id: group.id, name: group.name, archived: group.archived },
        await deps.readStudyPlans(quarterId),
        lessonRows,
        catalog.subjects,
        catalog.subgroups.filter(item => item.groupId === groupId),
      );
      reply.header("cache-control", "no-store");
      return response;
    } catch {
      return reply.code(400).send({ error: "Не удалось рассчитать выполнение учебных планов" });
    }
  });
}
