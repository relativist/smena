import { randomBytes, createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { AsyncDatabase } from "./database.ts";
import { MaintenanceGate } from "./maintenanceGate.ts";
import { ArchiveServiceError, SchoolArchiveService, type PreparedArchive } from "./schoolArchive.ts";
import { MAX_ARCHIVE_UPLOAD_BYTES, type ArchivePreview, type ArchiveRestoreResult, type ArchiveRestoreStatus } from "../shared/dataTransfer.ts";

type Session = { username: string; csrfToken: string };
type Receipt = { username: string; completed_at: string; result_json: string };
type Entry = {
  owner: string;
  username: string;
  preview: ArchivePreview;
  prepared?: PreparedArchive;
  state: ArchiveRestoreStatus["state"];
  result?: ArchiveRestoreResult;
  error?: string;
  renewedCookie?: string;
  uncertain?: boolean;
};
type Deps = {
  db: AsyncDatabase;
  service?: SchoolArchiveService;
  gate: MaintenanceGate;
  getSession(request: FastifyRequest): Promise<Session | null>;
  isSameOrigin(request: FastifyRequest): boolean;
  sessionKey(request: FastifyRequest): string;
  setCookie(reply: FastifyReply, token: string, secure: boolean): void;
  drainGenerationWrites(): Promise<void>;
  onRestored(): void;
  beforeWrite?: () => Promise<void>;
};
const TTL_MS = 30 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pathOf = (request: FastifyRequest) => request.url.split("?")[0]!;
const statusToken = (request: FastifyRequest) => pathOf(request).match(/^\/api\/data-transfer\/status\/([A-Za-z0-9_-]{43})$/)?.[1];
const friendlyError = (error: unknown): { status: number; message: string } => {
  const status = Number((error as { statusCode?: number } | null)?.statusCode);
  if (error instanceof ArchiveServiceError || [400, 409, 413, 503].includes(status))
    return { status: status || 400, message: error instanceof Error ? error.message : "Не удалось выполнить операцию с архивом" };
  return { status: 503, message: "Не удалось выполнить операцию с архивом. Проверьте соединение с сервером" };
};

export async function registerDataTransferApi(app: FastifyInstance, deps: Deps): Promise<void> {
  const entries = new Map<string, Entry>();
  const sessions = new WeakMap<FastifyRequest, Session>();
  let inspecting = false;
  const errorReply = (reply: FastifyReply, error: unknown) => {
    const failure = friendlyError(error);
    return reply.code(failure.status).send({ error: failure.message });
  };
  const requireService = (): SchoolArchiveService => {
    if (!deps.service) throw new ArchiveServiceError(503, "Перенос архивов доступен при использовании PostgreSQL");
    return deps.service;
  };
  const receipt = async (token: string): Promise<Receipt | undefined> => {
    if (!deps.service) return undefined;
    return await deps.db.prepare("SELECT username,completed_at,result_json FROM data_transfer_receipts WHERE token=?").get(token) as Receipt | undefined;
  };
  const expiry = (entry: Entry) => Date.parse(entry.preview.expiresAt);
  const removeEntry = async (token: string, entry: Entry) => {
    if (entry.prepared) await deps.service?.disposePrepared(entry.prepared);
    entries.delete(token);
  };
  const cleanup = async () => {
    for (const [token, entry] of entries) {
      if (entry.state !== "restoring" && expiry(entry) <= Date.now())
        await removeEntry(token, entry).catch(() => undefined);
    }
  };
  const timer = setInterval(() => { void cleanup(); }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const [token, entry] of entries) await removeEntry(token, entry).catch(() => undefined);
    await deps.service?.close();
  });

  // The body remains a stream; authentication runs before any upload is read.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  app.addHook("onRequest", async (request, reply) => {
    if (!pathOf(request).startsWith("/api/data-transfer")) return;
    reply.header("cache-control", "no-store");
    if (!deps.isSameOrigin(request)) return reply.code(403).send({ error: "Недопустимый источник запроса" });
    const session = await deps.getSession(request);
    const token = statusToken(request);
    const entry = token ? entries.get(token) : undefined;
    // A lost restore response may also lose Set-Cookie. Only the original
    // initiating cookie plus its random operation token can recover the receipt.
    if (!session && request.method === "GET" && entry && expiry(entry) > Date.now()
      && deps.sessionKey(request) === entry.owner) return;
    if (!session) return reply.code(401).send({ error: "Требуется вход администратора" });
    sessions.set(request, session);
    if (request.method !== "GET" && request.headers["x-csrf-token"] !== session.csrfToken)
      return reply.code(403).send({ error: "Проверка запроса не пройдена" });
    if (pathOf(request) === "/api/data-transfer/inspect") {
      const length = Number(request.headers["content-length"]);
      if (Number.isFinite(length) && length > MAX_ARCHIVE_UPLOAD_BYTES)
        return reply.code(413).send({ error: "Архив слишком большой. Максимальный размер — 128 МиБ" });
    }
  });

  app.get("/api/data-transfer", async () => deps.service
    ? { supported: true }
    : { supported: false, reason: "Перенос архивов доступен при использовании PostgreSQL" });

  app.post("/api/data-transfer/export", async (_request, reply) => {
    try {
      const service = requireService();
      const archive = await service.exportArchive();
      const stream = createReadStream(archive.path);
      const dispose = () => { void service.disposeExport(archive.path).catch(() => undefined); };
      stream.once("close", dispose);
      reply.raw.once("close", () => { stream.destroy(); dispose(); });
      return reply.header("content-type", "application/gzip")
        .header("content-disposition", `attachment; filename="${archive.filename}"`)
        .header("content-length", (await fs.stat(archive.path)).size)
        .send(stream);
    } catch (error) { return errorReply(reply, error); }
  });

  app.post<{ Body: Readable }>("/api/data-transfer/inspect", { bodyLimit: MAX_ARCHIVE_UPLOAD_BYTES }, async (request, reply) => {
    let directory: string | undefined;
    let prepared: PreparedArchive | undefined;
    let claimed = false;
    try {
      const service = requireService();
      if (!request.headers["content-type"]?.startsWith("application/octet-stream"))
        throw new ArchiveServiceError(400, "Выберите файл архива данных Смены");
      if (inspecting) throw new ArchiveServiceError(409, "Другой архив ещё проверяется. Повторите попытку позже");
      inspecting = true;
      claimed = true;
      await cleanup();
      if (entries.size >= 4) throw new ArchiveServiceError(409, "Слишком много открытых архивов. Закройте предыдущие проверки");
      directory = await fs.mkdtemp(join(tmpdir(), "smena-upload-"));
      const file = join(directory, "archive.smena.gz");
      const output = await fs.open(file, "wx", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of request.body.iterator({ destroyOnReturn: false })) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_ARCHIVE_UPLOAD_BYTES) throw new ArchiveServiceError(413, "Архив слишком большой. Максимальный размер — 128 МиБ");
          let offset = 0;
          while (offset < buffer.length) offset += (await output.write(buffer, offset, buffer.length - offset, null)).bytesWritten;
        }
      } finally { await output.close(); }
      prepared = await service.prepareArchive(file);
      const current = await service.currentSummary();
      const token = randomBytes(32).toString("base64url");
      const preview: ArchivePreview = { token, expiresAt: new Date(Date.now() + TTL_MS).toISOString(), archive: prepared.manifest, current };
      entries.set(token, { owner: deps.sessionKey(request), username: sessions.get(request)!.username, preview, prepared, state: "ready" });
      prepared = undefined;
      return preview;
    } catch (error) {
      request.body?.resume?.();
      if (prepared) await deps.service?.disposePrepared(prepared).catch(() => undefined);
      return errorReply(reply, error);
    } finally {
      if (claimed) inspecting = false;
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.post<{ Body: { token?: unknown; confirm?: unknown } }>("/api/data-transfer/restore", async (request, reply) => {
    const token = request.body?.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token) || request.body?.confirm !== true)
      return reply.code(400).send({ error: "Подтвердите полную замену школьных данных" });
    const session = sessions.get(request)!;
    const entry = entries.get(token);
    if (!entry) {
      const saved = await receipt(token);
      if (saved && saved.username === session.username && Date.now() - Date.parse(saved.completed_at) < TTL_MS)
        return JSON.parse(saved.result_json) as ArchiveRestoreResult;
    }
    if (!entry || entry.username !== session.username || expiry(entry) <= Date.now())
      return reply.code(410).send({ error: "Проверка архива истекла. Выберите файл повторно" });
    if (entry.state === "complete" && entry.result) return entry.result;
    if (entry.state === "restoring") return reply.code(409).send({ error: "Восстановление ещё выполняется. Проверьте его результат" });
    if (deps.sessionKey(request) !== entry.owner || !entry.prepared)
      return reply.code(410).send({ error: "Выберите архив повторно в этом сеансе" });
    entry.state = "restoring";
    entry.preview.expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    entry.error = undefined;
    try {
      const service = requireService();
      await deps.gate.run(request, async () => {
        await deps.drainGenerationWrites();
        await service.restorePrepared(entry.prepared!, {
          expectedRevision: entry.preview.current.revision,
          expectedDisplayRevision: entry.preview.current.displayRevision,
          beforeWrite: deps.beforeWrite,
          rotateSession: async (client: PoolClient, backupFilename: string) => {
            const authorized = await client.query("SELECT token_hash FROM sessions WHERE token_hash=$1 AND csrf_token=$2 AND expires_at>$3 FOR UPDATE", [entry.owner, session.csrfToken, Date.now()]);
            if (!authorized.rows.length) throw new ArchiveServiceError(409, "Сеанс входа изменился. Выберите архив повторно после входа");
            const renewed = randomBytes(32).toString("base64url");
            const csrf = randomBytes(24).toString("base64url");
            await client.query("DELETE FROM sessions");
            await client.query("INSERT INTO sessions(token_hash,csrf_token,expires_at,username) VALUES($1,$2,$3,$4)", [digest(renewed), csrf, Date.now() + 24 * 60 * 60 * 1000, session.username]);
            const result: ArchiveRestoreResult = { restored: true, backupFilename, counts: entry.preview.archive.counts };
            await client.query("INSERT INTO data_transfer_receipts(token,username,completed_at,result_json) VALUES($1,$2,$3,$4)", [token, session.username, new Date().toISOString(), JSON.stringify(result)]);
            entry.renewedCookie = renewed;
          },
        });
        deps.onRestored();
        entry.prepared = undefined;
      });
      const saved = await receipt(token);
      if (!saved) throw new Error("Missing restore receipt");
      entry.result = JSON.parse(saved.result_json) as ArchiveRestoreResult;
      entry.state = "complete"; entry.preview.expiresAt = new Date(Date.now() + TTL_MS).toISOString();
      deps.setCookie(reply, entry.renewedCookie!, request.protocol === "https");
      return entry.result;
    } catch (error) {
      deps.onRestored();
      const failure = friendlyError(error);
      try {
        const saved = await receipt(token);
        if (saved) {
          entry.result = JSON.parse(saved.result_json) as ArchiveRestoreResult;
          entry.state = "complete"; entry.preview.expiresAt = new Date(Date.now() + TTL_MS).toISOString();
          entry.prepared = undefined;
          if (entry.renewedCookie) deps.setCookie(reply, entry.renewedCookie, request.protocol === "https");
          return entry.result;
        }
        entry.state = "failed";
        entry.error = failure.message;
      } catch {
        entry.uncertain = true;
        entry.error = "Связь с PostgreSQL прервалась. Проверьте результат восстановления";
      }
      return reply.code(failure.status).send({ error: entry.error });
    }
  });

  app.get<{ Params: { token: string } }>("/api/data-transfer/status/:token", async (request, reply) => {
    const token = request.params.token;
    if (!TOKEN_RE.test(token)) return reply.code(404).send({ error: "Операция не найдена" });
    const entry = entries.get(token);
    const session = sessions.get(request);
    if (entry && expiry(entry) > Date.now() && (session?.username === entry.username || deps.sessionKey(request) === entry.owner)) {
      if (entry.uncertain) {
        try {
          const saved = await receipt(token);
          if (saved) { entry.state = "complete"; entry.preview.expiresAt = new Date(Date.now() + TTL_MS).toISOString(); entry.result = JSON.parse(saved.result_json) as ArchiveRestoreResult; }
          else { entry.state = "failed"; entry.error = "Восстановление не было зафиксировано. Текущие данные сохранены"; }
          entry.uncertain = false;
        } catch { return reply.code(503).send({ error: "PostgreSQL пока недоступен. Проверьте результат позднее" }); }
      }
      if (entry.state === "complete" && entry.renewedCookie && !session) {
        const renewed = await deps.db.prepare("SELECT expires_at FROM sessions WHERE token_hash=?").get(digest(entry.renewedCookie)) as { expires_at: number } | undefined;
        if (renewed && renewed.expires_at > Date.now()) deps.setCookie(reply, entry.renewedCookie, request.protocol === "https");
      }
      return { state: entry.state, result: entry.result, error: entry.error } satisfies ArchiveRestoreStatus;
    }
    const saved = session ? await receipt(token) : undefined;
    if (saved && saved.username === session?.username && Date.now() - Date.parse(saved.completed_at) < TTL_MS)
      return { state: "complete", result: JSON.parse(saved.result_json) as ArchiveRestoreResult } satisfies ArchiveRestoreStatus;
    return reply.code(410).send({ error: "Операция не найдена или срок проверки истёк" });
  });

  app.post<{ Body: { token?: unknown } }>("/api/data-transfer/discard", async (request, reply) => {
    const token = request.body?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "Укажите проверенный архив" });
    const entry = entries.get(token);
    if (entry && entry.username === sessions.get(request)?.username && deps.sessionKey(request) === entry.owner) {
      if (entry.state === "restoring") return reply.code(409).send({ error: "Архив уже восстанавливается" });
      await removeEntry(token, entry);
    }
    return { discarded: true };
  });
}
