import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AsyncDatabase } from "./database.ts";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { GenerationProgress, GenerationResult } from "../shared/generateSchedule.ts";
import type { Schedule } from "../src/editor.ts";
import type { StateResponse } from "./contracts.ts";

type Session = { username: string; csrfToken: string };
type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "applied";
type JobRow = {
  id: string;
  owner_username: string;
  status: JobStatus;
  revision: number;
  quarter_id: string;
  progress_json: string;
  result_json: string | null;
  comfort_json: string | null;
  error: string | null;
  apply_request_id: string | null;
  apply_fingerprint: string | null;
  apply_response_json: string | null;
  created_at: string;
  updated_at: string;
};
type CommitResult = { revision: number; updatedAt: string };

export type GenerationApiDeps = {
  db: AsyncDatabase;
  getSession(request: FastifyRequest): Promise<Session | null>;
  isSameOrigin(request: FastifyRequest): boolean;
  /** Returns only the requested quarter, with all groups needed for conflict checks. */
  readState(quarterId: string): Promise<StateResponse>;
  /** Applies the generated quarter atomically after checking the global revision. */
  commit(before: Schedule, after: Schedule, revision: number, requestId: string, quarterId: string): Promise<CommitResult>;
};

export type GenerationApiControl = {
  drainWrites(): Promise<void>;
};

const validId = (value: unknown, max = 120): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const validRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w.-]{8,100}$/.test(value);
const now = () => new Date().toISOString();

export async function registerGenerationApi(app: FastifyInstance, deps: GenerationApiDeps): Promise<GenerationApiControl> {
  await deps.db.exec(`
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      quarter_id TEXT NOT NULL,
      group_ids_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      result_json TEXT,
      comfort_json TEXT,
      error TEXT,
      apply_request_id TEXT,
      apply_fingerprint TEXT,
      apply_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const jobColumns = new Set((await deps.db.prepare("PRAGMA table_info(generation_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, type] of [["apply_request_id", "TEXT"], ["apply_fingerprint", "TEXT"], ["apply_response_json", "TEXT"]] as const)
    if (!jobColumns.has(name)) await deps.db.exec(`ALTER TABLE generation_jobs ADD COLUMN ${name} ${type}`);
  // In-flight calculations cannot survive a process restart because their worker is gone.
  await deps.db.prepare("UPDATE generation_jobs SET status='failed',error=?,updated_at=? WHERE status IN ('queued','running')")
    .run("Расчёт прерван перезапуском сервера. Запустите его ещё раз.", now());

  const workers = new Map<string, Worker>();
  const pendingWrites = new Map<string, Promise<void>>();
  const queueWrite = (id: string, work: () => Promise<void>) => {
    const previous = pendingWrites.get(id) ?? Promise.resolve();
    const next = previous.then(work).catch(() => undefined);
    pendingWrites.set(id, next);
    void next.finally(() => { if (pendingWrites.get(id) === next) pendingWrites.delete(id); });
    return next;
  };
  const drainWrites = async () => {
    // Worker events can queue another write while the current snapshot drains.
    while (pendingWrites.size) await Promise.all([...pendingWrites.values()]);
  };
  app.addHook("onClose", async () => {
    await drainWrites();
    for (const worker of workers.values()) await worker.terminate();
    workers.clear();
    await drainWrites();
  });

  const ownedJob = async (id: string, username: string) => await deps.db.prepare(
    "SELECT * FROM generation_jobs WHERE id=? AND owner_username=?",
  ).get(id, username) as JobRow | undefined;
  const sendJob = (reply: { header(name: string, value: string): unknown; send(value: unknown): unknown }, row: JobRow) => {
    reply.header("cache-control", "no-store");
    return reply.send({
      id: row.id,
      status: row.status,
      revision: row.revision,
      quarterId: row.quarter_id,
      progress: JSON.parse(row.progress_json) as GenerationProgress,
      result: row.result_json ? projectResult(JSON.parse(row.result_json) as GenerationResult, JSON.parse(row.comfort_json ?? "null")) : undefined,
      error: row.error ?? undefined,
      updatedAt: row.updated_at,
    });
  };
  const projectResult = (result: GenerationResult, teacherComfort: unknown) => {
    const days = new Map<string, StateResponse["schedule"][string][number]>();
    for (const [scheduleKey, entries] of Object.entries(result.schedule)) {
      const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
      for (const day of entries) days.set(`${groupId}\0${day.date}`, day);
    }
    return {
      added: result.added.map((placement) => {
        const time = days.get(`${placement.groupId}\0${placement.date}`)?.times[placement.slot];
        return { ...placement, start: time?.start ?? null, duration: time?.duration ?? null };
      }),
      remaining: result.remaining,
      fallbackRoomCount: result.fallbackRoomCount,
      removedCount: result.removedCount,
      teacherComfort,
    };
  };
  const requireWrite = async (request: FastifyRequest, reply: { code(status: number): { send(value: unknown): unknown } }) => {
    if (!deps.isSameOrigin(request)) {
      reply.code(403).send({ error: "Недопустимый источник запроса" });
      return null;
    }
    const session = await deps.getSession(request);
    if (!session) {
      reply.code(401).send({ error: "Требуется вход администратора" });
      return null;
    }
    if (request.headers["x-csrf-token"] !== session.csrfToken) {
      reply.code(403).send({ error: "Проверка запроса не пройдена" });
      return null;
    }
    return session;
  };

  app.post<{ Body: unknown }>("/api/generation-jobs", async (request, reply) => {
    const session = await requireWrite(request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body || !Number.isInteger(body.revision) || !validId(body.quarterId) ||
      !Array.isArray(body.groupIds) || body.groupIds.length < 1 || body.groupIds.length > 500 ||
      body.groupIds.some((id) => !validId(id)) || new Set(body.groupIds).size !== body.groupIds.length ||
      !body.options || typeof body.options !== "object" ||
      typeof (body.options as Record<string, unknown>).preserveExisting !== "boolean" ||
      typeof (body.options as Record<string, unknown>).allowJointLessons !== "boolean")
      return reply.code(400).send({ error: "Некорректные параметры автосоставления" });
    const revision = Number(body.revision);
    const quarterId = body.quarterId;
    const groupIds = body.groupIds as string[];
    const options = body.options as { preserveExisting: boolean; allowJointLessons: boolean };
    const id = randomUUID();
    const timestamp = now();
    const initialProgress: GenerationProgress = { percent: 0, phase: "preparing" };
    let state: StateResponse;
    try {
      state = await deps.db.transaction(async () => {
        if (await deps.db.prepare("SELECT 1 FROM generation_jobs WHERE status IN ('queued','running') LIMIT 1").get())
          throw Object.assign(new Error("Уже выполняется другое автосоставление"), { statusCode: 409 });
        let currentState: StateResponse;
        try { currentState = await deps.readState(quarterId); }
        catch { throw Object.assign(new Error("Учебная четверть не найдена"), { statusCode: 404 }); }
        if (currentState.revision !== revision)
          throw Object.assign(new Error("Расписание изменилось. Обновите данные и запустите расчёт ещё раз"), { statusCode: 409 });
        if (!currentState.quarters.some((quarter) => quarter.id === quarterId) ||
          groupIds.some((groupId) => !currentState.catalog.groups.some((group) => group.id === groupId && !group.archived)))
          throw Object.assign(new Error("Выбрана неизвестная четверть или группа"), { statusCode: 400 });
        await deps.db.prepare(`INSERT INTO generation_jobs
          (id,owner_username,status,revision,quarter_id,group_ids_json,options_json,progress_json,created_at,updated_at)
          VALUES(?,?, 'running', ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, session.username, revision, quarterId, JSON.stringify(groupIds), JSON.stringify(options), JSON.stringify(initialProgress), timestamp, timestamp);
        return currentState;
      })();
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number")
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
    const worker = new Worker(new URL("./generationJobWorker.ts", import.meta.url), {
      workerData: { state, quarterId, groupIds, options },
    });
    workers.set(id, worker);
    const update = deps.db.prepare("UPDATE generation_jobs SET status=?,progress_json=?,result_json=?,comfort_json=?,error=?,updated_at=? WHERE id=? AND status='running'");
    worker.on("message", (message: { type?: string; progress?: GenerationProgress; result?: GenerationResult; teacherComfort?: unknown; error?: string }) => {
      void queueWrite(id, async () => {
        const current = await deps.db.prepare("SELECT status FROM generation_jobs WHERE id=?").get(id) as { status: JobStatus } | undefined;
        if (!current || current.status !== "running") return;
        const updated = now();
        if (message.type === "progress" && message.progress) {
          await deps.db.prepare("UPDATE generation_jobs SET progress_json=?,updated_at=? WHERE id=? AND status='running'")
            .run(JSON.stringify(message.progress), updated, id);
        } else if (message.type === "result" && message.result) {
          await update.run("complete", JSON.stringify({ percent: 100, phase: "done" }), JSON.stringify(message.result), JSON.stringify(message.teacherComfort ?? null), null, updated, id);
          void worker.terminate();
          workers.delete(id);
        } else if (message.type === "error") {
          await update.run("failed", JSON.stringify(initialProgress), null, null, message.error ?? "Не удалось составить расписание.", updated, id);
          void worker.terminate();
          workers.delete(id);
        }
      });
    });
    worker.on("error", (error) => {
      void queueWrite(id, async () => { await update.run("failed", JSON.stringify(initialProgress), null, null, error.message.slice(0, 500), now(), id); });
      workers.delete(id);
    });
    worker.on("exit", (code) => {
      void queueWrite(id, async () => {
        const current = await deps.db.prepare("SELECT status FROM generation_jobs WHERE id=?").get(id) as { status: JobStatus } | undefined;
        if (current?.status === "running") await update.run("failed", JSON.stringify(initialProgress), null, null, `Расчёт завершился с кодом ${code}`, now(), id);
        workers.delete(id);
      });
    });
    reply.header("cache-control", "no-store");
    return reply.code(202).send({ id, status: "running", revision, quarterId, progress: initialProgress });
  });

  app.get<{ Params: { id: string } }>("/api/generation-jobs/:id", async (request, reply) => {
    const session = await deps.getSession(request);
    if (!session) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Некорректный идентификатор расчёта" });
    const row = await ownedJob(request.params.id, session.username);
    if (!row) return reply.code(404).send({ error: "Расчёт не найден" });
    return sendJob(reply, row);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/generation-jobs/:id/cancel", async (request, reply) => {
    const session = await requireWrite(request, reply);
    if (!session) return;
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Некорректный идентификатор расчёта" });
    const row = await ownedJob(request.params.id, session.username);
    if (!row) return reply.code(404).send({ error: "Расчёт не найден" });
    if (row.status === "running" || row.status === "queued" || row.status === "complete") {
      await deps.db.prepare("UPDATE generation_jobs SET status='cancelled',result_json=NULL,comfort_json=NULL,error=?,updated_at=? WHERE id=?")
        .run("Составление отменено.", now(), row.id);
      const worker = workers.get(row.id);
      if (worker) await worker.terminate();
      workers.delete(row.id);
    }
    const updated = await ownedJob(row.id, session.username);
    if (!updated) return reply.code(404).send({ error: "Расчёт не найден" });
    return sendJob(reply, updated);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/generation-jobs/:id/apply", async (request, reply) => {
    const session = await requireWrite(request, reply);
    if (!session) return;
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Некорректный идентификатор расчёта" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || !Number.isInteger(body.revision) || !validRequestId(body.requestId))
      return reply.code(400).send({ error: "Некорректный запрос применения расписания" });
    const row = await ownedJob(request.params.id, session.username);
    if (!row) return reply.code(404).send({ error: "Расчёт не найден" });
    const expectedRevision = Number(body.revision);
    const fingerprint = JSON.stringify({ revision: expectedRevision, requestId: body.requestId });
    if (row.status === "applied") {
      if (row.apply_request_id !== body.requestId || row.apply_fingerprint !== fingerprint || !row.apply_response_json)
        return reply.code(409).send({ error: "Этот результат уже применён другим запросом" });
      reply.header("cache-control", "no-store");
      return reply.send(JSON.parse(row.apply_response_json));
    }
    if (row.status !== "complete" || !row.result_json)
      return reply.code(409).send({ error: "Расчёт ещё не готов к применению" });
    if (expectedRevision !== row.revision)
      return reply.code(409).send({ error: "Расписание изменилось. Пересчитайте предложение" });
    try {
      const response = await deps.db.transaction(async () => {
        const current = await ownedJob(row.id, session.username);
        if (!current || current.status !== "complete" || !current.result_json)
          throw Object.assign(new Error("Расчёт уже обработан"), { statusCode: 409 });
        const state = await deps.readState(current.quarter_id);
        if (state.revision !== current.revision)
          throw Object.assign(new Error("Расписание изменилось. Пересчитайте предложение"), { statusCode: 409 });
        const result = JSON.parse(current.result_json) as GenerationResult;
        const committed = await deps.commit(state.schedule, result.schedule, current.revision, body.requestId as string, current.quarter_id);
        const response = { status: "applied", revision: committed.revision, updatedAt: committed.updatedAt };
        await deps.db.prepare(`UPDATE generation_jobs SET status='applied',revision=?,result_json=NULL,comfort_json=NULL,
          apply_request_id=?,apply_fingerprint=?,apply_response_json=?,updated_at=? WHERE id=? AND status='complete'`)
          .run(committed.revision, body.requestId, fingerprint, JSON.stringify(response), now(), current.id);
        return response;
      })();
      reply.header("cache-control", "no-store");
      return reply.send(response);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number")
        return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof Error && error.message === "revision-conflict")
        return reply.code(409).send({ error: "Расписание изменилось. Пересчитайте предложение" });
      throw error;
    }
  });

  return { drainWrites };
}
