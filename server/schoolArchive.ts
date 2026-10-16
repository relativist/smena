import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Transform } from "node:stream";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Pool, types, type PoolClient } from "pg";
import type { ArchiveManifest, ArchivePreview } from "../shared/dataTransfer.ts";
import { openPostgresDatabase } from "./database.ts";
import { initializePostgresSchema } from "./postgresSchema.ts";

const TABLES = [
  "draft_metadata", "schedule_days", "schedule_slots", "lessons", "plan_baselines", "request_replays",
  "catalog_subjects", "catalog_rooms", "catalog_groups", "catalog_teachers", "catalog_subgroups",
  "catalog_teacher_subjects", "catalog_group_auto_rooms", "quarters", "study_plans", "plan_assignments",
  "curricula", "published_quarters", "publication_replays", "bell_settings", "school_calendar",
  "school_display_settings", "school_display_setting_replays", "editor_request_replays",
  "schedule_operation_replays", "generation_jobs", "teacher_lesson_origins", "teacher_teaching_assignments",
  "teacher_reassignment_operations", "teacher_replacement_operations", "temporary_teacher_replacements",
] as const;
type Table = typeof TABLES[number];
const PARENTS_FIRST: readonly Table[] = TABLES;
const CHILDREN_FIRST = [...TABLES].reverse();
const MAX_COMPRESSED = 128 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const FETCH_SIZE = 5000;
const MAX_INSERT_ROWS = 500;
const MAX_INSERT_PARAMS = 59000;

export type PreparedArchive = { schema: string; manifest: ArchiveManifest };
type ServiceOptions = { backupDirectory?: string; applicationVersion?: string };
type Column = { column_name: string; ordinal_position: number };
type TypedColumn = { column_name: string; data_type: string };

export class ArchiveServiceError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.name = "ArchiveServiceError"; this.statusCode = statusCode; }
}

function quoteId(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function scalar(value: unknown): value is string | number | null { return value === null || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)); }
function clientError(message: string): ArchiveServiceError { return new ArchiveServiceError(400, message); }
function safeFilename(date: Date): string { return `smena-${date.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.smena.gz`; }

export class SchoolArchiveService {
  private readonly pool: Pool;
  private readonly backupDirectory: string;
  private readonly appVersion: string;
  private readonly databaseUrl: string;
  private readonly ownedExports = new Map<string, string>();
  private readonly ownedStages = new Set<string>();

  constructor(databaseUrl: string, options: ServiceOptions = {}) {
    this.databaseUrl = databaseUrl;
    this.backupDirectory = options.backupDirectory ?? resolve("backups/restore");
    this.appVersion = options.applicationVersion ?? "0.1.0";
    this.pool = new Pool({ connectionString: databaseUrl, max: 4, application_name: "smena-archive", connectionTimeoutMillis: 5000,
      types: { getTypeParser(oid, format) { if (oid === 20 && format === "text") return (s: string) => { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }; return types.getTypeParser(oid, format); } },
    });
    this.pool.on("error", () => console.error("PostgreSQL: потеряно свободное соединение архива"));
  }

  private async columns(client: PoolClient, table: string, schema?: string): Promise<string[]> {
    const result = await client.query<Column>("SELECT column_name,ordinal_position FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", [schema ?? (await client.query("SELECT current_schema() AS s")).rows[0].s, table]);
    return result.rows.map(r => r.column_name);
  }
  private async columnTypes(client: PoolClient, table: string, schema: string): Promise<string[]> {
    const result = await client.query<TypedColumn>("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", [schema, table]);
    return result.rows.map(row => row.data_type);
  }
  private async orderingColumns(client: PoolClient, table: string, columns: string[], schema: string): Promise<string[]> {
    if (columns.includes("insertion_order")) return ["insertion_order"];
    const pk = await client.query<{ column_name: string; ordinal_position: number }>(`
      SELECT kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
      WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=$1 AND tc.table_name=$2
      ORDER BY kcu.ordinal_position
    `, [schema, table]);
    return pk.rows.length ? pk.rows.map(row => row.column_name) : [columns[0]!];
  }
  private async inspectSchema(client: PoolClient, schema?: string): Promise<Map<Table, string[]>> {
    const result = new Map<Table, string[]>();
    for (const table of TABLES) {
      const cols = await this.columns(client, table, schema);
      if (!cols.length) throw new ArchiveServiceError(503, `В схеме PostgreSQL отсутствует таблица ${table}`);
      result.set(table, cols);
    }
    return result;
  }
  private async querySummary(client: PoolClient, targetSchema?: string): Promise<ArchivePreview["current"]> {
    const schema = targetSchema ?? (await client.query("SELECT current_schema() AS s")).rows[0].s as string;
    const revision = Number((await client.query(`SELECT revision FROM ${quoteId(schema)}.draft_metadata WHERE id=1`)).rows[0]?.revision ?? 0);
    const displayRevision = Number((await client.query(`SELECT revision FROM ${quoteId(schema)}.school_display_settings WHERE id=1`)).rows[0]?.revision ?? 0);
    const schoolName = await this.schoolName(client, schema);
    const count = async (table: string) => Number((await client.query(`SELECT count(*) AS n FROM ${quoteId(schema)}.${quoteId(table)}`)).rows[0].n);
    return { revision, displayRevision, schoolName, counts: { groups: await count("catalog_groups"), teachers: await count("catalog_teachers"), rooms: await count("catalog_rooms"), lessons: await count("lessons") } };
  }
  private async schoolName(client: PoolClient, schema?: string): Promise<string> {
    const result = await client.query(`SELECT settings_json FROM ${schema ? `${quoteId(schema)}.` : ""}${quoteId("school_display_settings")} WHERE id=1`);
    const value = result.rows[0]?.settings_json;
    if (typeof value === "string") { try { const parsed = JSON.parse(value); return typeof parsed.schoolName === "string" ? parsed.schoolName : ""; } catch { return ""; } }
    return "";
  }
  async currentSummary(client?: PoolClient): Promise<ArchivePreview["current"]> {
    if (client) return this.querySummary(client);
    const own = await this.pool.connect();
    try {
      await own.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const summary = await this.querySummary(own);
      const committed = await own.query("COMMIT");
      if (committed.command !== "COMMIT") throw new ArchiveServiceError(503, "Транзакция чтения PostgreSQL была отменена");
      return summary;
    } catch (error) {
      try { await own.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { own.release(); }
  }

  async exportArchive(destination?: string, suppliedClient?: PoolClient): Promise<{ path: string; filename: string; manifest: ArchiveManifest }> {
    const filename = safeFilename(new Date());
    const temporaryDirectory = destination ? undefined : await fs.mkdtemp(join(tmpdir(), "smena-export-"));
    const path = destination ?? join(temporaryDirectory!, filename);
    if (temporaryDirectory) this.ownedExports.set(path, temporaryDirectory);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const client = suppliedClient ?? await this.pool.connect();
    let transaction = false;
    let writePipeline: Promise<void> | undefined;
    let abortPipeline: (() => void) | undefined;
    let fileCreated = false;
    try {
      if (!suppliedClient) { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true; }
      const schema = (await client.query("SELECT current_schema() AS s")).rows[0].s as string;
      const defs = await this.inspectSchema(client, schema);
      const orderings = new Map<Table, string[]>();
      const tables: ArchiveManifest["tables"] = [];
      for (const table of TABLES) {
        const columns = defs.get(table)!;
        orderings.set(table, await this.orderingColumns(client, table, columns, schema));
        const result = await client.query(`SELECT count(*)::bigint AS n FROM ${quoteId(schema)}.${quoteId(table)}`);
        tables.push({ name: table, columns, rows: Number(result.rows[0].n) });
      }
      const summary = await this.querySummary(client);
      const versions = (await client.query("SELECT version FROM postgres_schema_migrations ORDER BY version")).rows.map(r => Number(r.version));
      const pgMajor = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000 | 0;
      const manifest: ArchiveManifest = { format: "smena-school-archive", formatVersion: 1, applicationVersion: this.appVersion,
        postgresMajorVersion: pgMajor, schemaVersions: versions, createdAt: new Date().toISOString(), schoolName: summary.schoolName, counts: summary.counts, tables };
      const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
      output.once("open", () => { fileCreated = true; });
      const gzip = createGzip({ level: 6 });
      abortPipeline = () => { gzip.destroy(); };
      let compressedBytes = 0;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        compressedBytes += chunk.length;
        callback(compressedBytes > MAX_COMPRESSED ? new ArchiveServiceError(413, "Архив превышает допустимый размер 128 МиБ") : null, chunk);
      } });
      const pump = writePipeline = pipeline(gzip, guard, output);
      let pumpError: unknown;
      void pump.catch(error => { pumpError = error; });
      const hash = createHash("sha256");
      const writeLine = async (line: unknown, hashed: boolean) => {
        const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
        if (hashed) hash.update(bytes);
        if (pumpError) throw pumpError;
        if (!gzip.write(bytes)) await Promise.race([once(gzip, "drain").then(() => undefined), pump]);
      };
      await writeLine({ type: "manifest", manifest }, true);
      for (const table of TABLES) {
        const columns = defs.get(table)!;
        const cursor = await client.query(`DECLARE smena_archive_cursor NO SCROLL CURSOR FOR SELECT ${columns.map(quoteId).join(",")} FROM ${quoteId(schema)}.${quoteId(table)} ORDER BY ${orderings.get(table)!.map(quoteId).join(",")}`);
        void cursor;
        try {
          while (true) {
            const batch = await client.query(`FETCH ${FETCH_SIZE} FROM smena_archive_cursor`);
            if (!batch.rows.length) break;
            for (const row of batch.rows) {
              const values = columns.map(c => row[c]);
              if (!values.every(scalar)) throw new ArchiveServiceError(503, `В таблице ${table} есть неподдерживаемый тип данных`);
              await writeLine({ type: "row", table, values }, true);
            }
          }
        } finally { await client.query("CLOSE smena_archive_cursor"); }
      }
      await writeLine({ type: "end", sha256: hash.digest("hex") }, false);
      gzip.end(); await pump;
      const stat = await fs.stat(path);
      if (stat.size > MAX_COMPRESSED) { await fs.rm(path, { force: true }); throw new ArchiveServiceError(413, "Архив превышает допустимый размер 128 МиБ"); }
      if (transaction) { await client.query("COMMIT"); transaction = false; }
      return { path, filename, manifest };
    } catch (error) {
      abortPipeline?.();
      if (writePipeline) await writePipeline.catch(() => {});
      if (transaction) try { await client.query("ROLLBACK"); } catch { /* preserve source error */ }
      if (!destination) await this.disposeExport(path).catch(() => {});
      else if (fileCreated) await fs.rm(path, { force: true }).catch(() => {});
      if (error instanceof ArchiveServiceError) throw error;
      throw new ArchiveServiceError(503, "Не удалось создать архив данных");
    } finally { if (!suppliedClient) client.release(); }
  }

  private async lines(path: string): Promise<AsyncGenerator<string>> {
    const stat = await fs.stat(path).catch(() => undefined);
    if (!stat || !stat.isFile()) throw clientError("Не удалось прочитать файл архива");
    if (stat.size > MAX_COMPRESSED) throw new ArchiveServiceError(413, "Архив превышает допустимый размер 128 МиБ");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const generator = async function* (): AsyncGenerator<string> {
      let expanded = 0;
      let pending = Buffer.alloc(0);
      const source = createReadStream(path);
      const input = createGunzip();
      source.on("error", error => input.destroy(error));
      source.pipe(input);
      try {
        for await (const chunk of input) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          expanded += bytes.length;
          if (expanded > MAX_EXPANDED) throw new ArchiveServiceError(413, "Распакованный архив превышает 1 ГиБ");
          let start = 0;
          while (start < bytes.length) {
            const newline = bytes.indexOf(10, start);
            const end = newline < 0 ? bytes.length : newline;
            const part = bytes.subarray(start, end);
            if (pending.length + part.length > MAX_LINE) throw new ArchiveServiceError(413, "Строка архива превышает допустимый размер");
            if (newline < 0) pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
            else {
              const complete = pending.length ? Buffer.concat([pending, part]) : part;
              const text = decoder.decode(complete);
              if (text.includes("\r")) throw clientError("В архиве используется неверный формат строк");
              yield text;
              pending = Buffer.alloc(0);
            }
            start = newline < 0 ? bytes.length : newline + 1;
          }
        }
        if (pending.length) throw clientError("Последняя строка архива не завершена переводом строки");
      } finally {
        source.destroy();
        input.destroy();
      }
    };
    return generator();
  }
  private validateManifest(manifest: unknown): ArchiveManifest {
    if (!manifest || typeof manifest !== "object") throw clientError("В архиве отсутствует описание данных");
    const m = manifest as ArchiveManifest;
    if (m.format !== "smena-school-archive" || m.formatVersion !== 1) throw clientError("Формат архива не поддерживается");
    if (m.applicationVersion !== this.appVersion) throw clientError("Архив создан другой версией приложения");
    if (!Number.isInteger(m.postgresMajorVersion) || !Array.isArray(m.schemaVersions) || !Array.isArray(m.tables)) throw clientError("Описание архива повреждено");
    const expected = new Set<string>(TABLES);
    if (m.tables.length !== TABLES.length || m.tables.some(t => !expected.delete(t.name) || !Array.isArray(t.columns) || !Number.isSafeInteger(t.rows) || t.rows < 0) || expected.size) throw clientError("Состав таблиц архива не соответствует приложению");
    if (typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)) || typeof m.schoolName !== "string" || !m.counts
      || [m.counts.groups, m.counts.teachers, m.counts.rooms, m.counts.lessons].some(n => !Number.isSafeInteger(n) || n < 0))
      throw clientError("Описание архива повреждено");
    return m;
  }
  private makeStageUrl(schema: string): string {
    const u = new URL(this.databaseUrl);
    u.searchParams.set("options", `-c search_path=${schema}`);
    return u.toString();
  }
  async prepareArchive(inputPath: string): Promise<PreparedArchive> {
    let schema: string | undefined;
    let client: PoolClient | undefined;
    let stagedDb: ReturnType<typeof openPostgresDatabase> | undefined;
    let transaction = false;
    try {
      const lines = await this.lines(inputPath);
      const hash = createHash("sha256");
      let manifest: ArchiveManifest | undefined;
      let endSeen = false;
      let lineIndex = 0;
      let currentTableIndex = 0;
      const rowCounts = new Map<string, number>();
      client = await this.pool.connect();
      const dbSchema = (await client.query("SELECT current_schema() AS s")).rows[0].s as string;
      schema = `smena_restore_${randomUUID().replace(/-/g, "")}`;
      await client.query("CREATE SCHEMA " + quoteId(schema));
      this.ownedStages.add(schema);
      client.release();
      stagedDb = openPostgresDatabase(this.makeStageUrl(schema));
      await initializePostgresSchema(stagedDb);
      client = await this.pool.connect();
      await client.query("BEGIN"); transaction = true;
      const stageClient = client;
      const schemaVersions = (await stageClient.query("SELECT version FROM postgres_schema_migrations ORDER BY version")).rows.map(r => Number(r.version));
      const pgMajor = (Number((await stageClient.query("SHOW server_version_num")).rows[0].server_version_num) / 10000) | 0;
      const sourceColumns = await this.inspectSchema(stageClient, dbSchema);
      const stageColumns = await this.inspectSchema(stageClient, schema);
      const sourceTypes = new Map<Table, string[]>();
      for (const table of TABLES) sourceTypes.set(table, await this.columnTypes(stageClient, table, dbSchema));
      for (const table of TABLES) if (stageColumns.get(table)!.join("\0") !== sourceColumns.get(table)!.join("\0"))
        throw new ArchiveServiceError(503, `Схема приёмника таблицы ${table} несовместима`);
      let pendingTable: Table | undefined;
      let pendingRows: unknown[][] = [];
      const flushInsert = async () => {
        if (!pendingTable || !pendingRows.length) return;
        const cols = sourceColumns.get(pendingTable)!;
        const params: unknown[] = [];
        const tuples = pendingRows.map(values => `(${values.map(value => { params.push(value); return `$${params.length}`; }).join(",")})`);
        await stageClient.query(`INSERT INTO ${quoteId(schema!)}.${quoteId(pendingTable)} (${cols.map(quoteId).join(",")}) VALUES ${tuples.join(",")}`, params);
        pendingRows = [];
      };
      for await (const line of lines) {
        lineIndex++;
        let item: any;
        try { item = JSON.parse(line); } catch { throw clientError("В архиве обнаружена повреждённая строка"); }
        if (endSeen) throw clientError("После контрольной строки в архиве есть лишние данные");
        if (lineIndex === 1) {
          if (item?.type !== "manifest") throw clientError("Первая строка архива не содержит описание данных");
          manifest = this.validateManifest(item.manifest);
          if (manifest.postgresMajorVersion !== pgMajor) throw clientError("Архив создан для другой основной версии PostgreSQL");
          if (JSON.stringify(manifest.schemaVersions) !== JSON.stringify(schemaVersions)) throw clientError("Версия схемы архива не совместима с приложением");
          for (const t of manifest.tables) if (JSON.stringify(t.columns) !== JSON.stringify(sourceColumns.get(t.name as Table))) throw clientError(`Столбцы таблицы ${t.name} не соответствуют текущей схеме`);
          hash.update(`${line}\n`); continue;
        }
        if (!manifest) throw clientError("Описание архива отсутствует");
        if (item?.type === "end") {
          endSeen = true;
          if (item.sha256 !== hash.digest("hex")) throw clientError("Контрольная сумма архива не совпала");
          continue;
        }
        if (item?.type !== "row" || !TABLES.includes(item.table) || !Array.isArray(item.values)) throw clientError("В архиве обнаружена неизвестная запись");
        const table = item.table as Table;
        const idx = TABLES.indexOf(table);
        if (idx < currentTableIndex) throw clientError("Записи таблиц идут в неверном порядке");
        if (pendingTable !== table) { await flushInsert(); pendingTable = table; }
        currentTableIndex = idx;
        const cols = sourceColumns.get(table)!;
        if (item.values.length !== cols.length || !item.values.every(scalar)) throw clientError(`Запись таблицы ${table} имеет неверный формат`);
        const types = sourceTypes.get(table)!;
        for (let i = 0; i < types.length; i++) {
          const value = item.values[i];
          if (value === null) continue;
          const valid = ["text", "character varying", "character"].includes(types[i]!)
            ? typeof value === "string"
            : ["smallint", "integer", "bigint"].includes(types[i]!)
              ? typeof value === "number" && Number.isSafeInteger(value)
              : false;
          if (!valid) throw clientError(`Значение в столбце ${cols[i]} таблицы ${table} имеет неверный тип`);
        }
        hash.update(`${line}\n`);
        const count = rowCounts.get(table) ?? 0; rowCounts.set(table, count + 1);
        if (count >= manifest.tables.find(t => t.name === table)!.rows) throw clientError(`В таблице ${table} больше строк, чем указано в описании`);
        pendingRows.push(item.values);
        if (pendingRows.length >= MAX_INSERT_ROWS || pendingRows.length * cols.length >= MAX_INSERT_PARAMS) await flushInsert();
      }
      await flushInsert();
      if (!manifest || !endSeen) throw clientError("Архив не завершён или не содержит контрольной суммы");
      for (const t of manifest.tables) if ((rowCounts.get(t.name) ?? 0) !== t.rows) throw clientError(`Количество строк таблицы ${t.name} не совпало`);
      const required = await client.query(`SELECT (SELECT count(*) FROM ${quoteId(schema)}."draft_metadata" WHERE id=1) AS draft,(SELECT count(*) FROM ${quoteId(schema)}."school_display_settings" WHERE id=1) AS display`);
      if (Number(required.rows[0].draft) !== 1 || Number(required.rows[0].display) !== 1) throw clientError("В архиве отсутствуют обязательные настройки школы");
      const actualCounts = await this.querySummary(client, schema);
      if (JSON.stringify(actualCounts.counts) !== JSON.stringify(manifest.counts)) throw clientError("Сводные количества строк не совпадают с содержимым архива");
      if (actualCounts.schoolName !== manifest.schoolName) throw clientError("Название школы в описании архива не совпало с данными");
      await client.query("COMMIT"); transaction = false; client.release(); client = undefined; await stagedDb.close(); stagedDb = undefined;
      return { schema, manifest };
    } catch (error) {
      if (transaction && client) try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      client?.release();
      if (stagedDb) await stagedDb.close().catch(() => {});
      if (schema) await this.dropStage(schema).catch(() => {});
      if (error instanceof ArchiveServiceError) throw error;
      throw new ArchiveServiceError(400, "Не удалось проверить архив данных");
    }
  }
  private async dropStage(schema: string): Promise<void> {
    if (!/^smena_restore_[a-f0-9]{32}$/.test(schema)) return;
    const client = await this.pool.connect();
    try { await client.query(`DROP SCHEMA IF EXISTS ${quoteId(schema)} CASCADE`); } finally { client.release(); }
    this.ownedStages.delete(schema);
  }
  async disposePrepared(prepared: PreparedArchive): Promise<void> { await this.dropStage(prepared.schema); }
  async disposeExport(path: string): Promise<void> {
    const directory = this.ownedExports.get(path);
    if (!directory) return;
    await fs.rm(path, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
    this.ownedExports.delete(path);
  }

  async restorePrepared(prepared: PreparedArchive, args: { expectedRevision: number; expectedDisplayRevision: number; beforeWrite?: () => void | Promise<void>; rotateSession?: (client: PoolClient, backupFilename: string) => void | Promise<void> }): Promise<{ backupFilename: string }> {
    const client = await this.pool.connect();
    let tx = false;
    try {
      await client.query("BEGIN"); tx = true;
      await client.query("SELECT pg_advisory_xact_lock(1397572178,1)");
      const liveSchema = (await client.query("SELECT current_schema() AS s")).rows[0].s as string;
      await client.query(`LOCK TABLE ${TABLES.map(table => `${quoteId(liveSchema)}.${quoteId(table)}`).join(",")} IN ACCESS EXCLUSIVE MODE`);
      const summary = await this.querySummary(client);
      if (summary.revision !== args.expectedRevision || summary.displayRevision !== args.expectedDisplayRevision) throw new ArchiveServiceError(409, "Данные школы изменились после проверки архива. Загрузите архив повторно");
      const running = await client.query("SELECT count(*)::int AS n FROM generation_jobs WHERE status IN ('queued','running')");
      if (running.rows[0].n) throw new ArchiveServiceError(409, "Сейчас выполняется создание расписания. Повторите загрузку позже");
      const backup = await this.exportArchive(join(this.backupDirectory, safeFilename(new Date())), client);
      for (const table of CHILDREN_FIRST) await client.query(`DELETE FROM ${quoteId(liveSchema)}.${quoteId(table)}`);
      await args.beforeWrite?.();
      for (const table of PARENTS_FIRST) {
        const columns = (await this.columns(client, table, liveSchema));
        if (table === "generation_jobs") {
          await client.query(`INSERT INTO ${quoteId(liveSchema)}.${quoteId(table)} (${columns.map(quoteId).join(",")}) SELECT ${columns.map(c => c === "status" ? "CASE WHEN s.status IN ('queued','running') THEN 'failed' ELSE s.status END" : c === "error" ? "CASE WHEN s.status IN ('queued','running') THEN 'Задача не перенесена из архива' ELSE s.error END" : `s.${quoteId(c)}`).join(",")} FROM ${quoteId(prepared.schema)}.${quoteId(table)} s`);
        } else await client.query(`INSERT INTO ${quoteId(liveSchema)}.${quoteId(table)} (${columns.map(quoteId).join(",")}) SELECT ${columns.map(c => `s.${quoteId(c)}`).join(",")} FROM ${quoteId(prepared.schema)}.${quoteId(table)} s`);
        const identityColumns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_identity='YES'", [liveSchema, table]);
        for (const row of identityColumns.rows) {
          const max = await client.query(`SELECT max(${quoteId(row.column_name)}) AS n FROM ${quoteId(liveSchema)}.${quoteId(table)}`);
          const next = max.rows[0].n === null ? 1 : Number(max.rows[0].n) + 1;
          await client.query(`ALTER TABLE ${quoteId(liveSchema)}.${quoteId(table)} ALTER COLUMN ${quoteId(row.column_name)} RESTART WITH ${next}`);
        }
      }
      await args.rotateSession?.(client, backup.filename);
      const committed = await client.query("COMMIT"); tx = false;
      if (committed.command !== "COMMIT") throw new ArchiveServiceError(503, "PostgreSQL отменил восстановление данных");
      await this.dropStage(prepared.schema).catch(() => {
        console.error("Не удалось удалить временную схему архива; очистка повторится при завершении сервиса");
      });
      return { backupFilename: backup.filename };
    } catch (error) {
      if (tx) try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      if (error instanceof ArchiveServiceError) throw error;
      throw new ArchiveServiceError(503, "Не удалось восстановить архив; текущие данные сохранены");
    } finally { client.release(); }
  }

  async close(): Promise<void> {
    for (const schema of [...this.ownedStages]) await this.dropStage(schema).catch(() => {});
    for (const path of [...this.ownedExports.keys()]) await this.disposeExport(path).catch(() => {});
    await this.pool.end();
  }
}
