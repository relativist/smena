import Database from "better-sqlite3";
import { Pool, types as pgTypes } from "pg";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicationPrintIndex } from "../server/publicationPrintIndex.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";

/** Tables whose application data is copied from a schema-23 SQLite database. */
const TABLES = [
  "admin_users", "sessions", "draft_metadata", "schedule_days", "schedule_slots", "lessons",
  "plan_baselines", "request_replays", "catalog_subjects", "catalog_teachers", "catalog_rooms",
  "catalog_groups", "catalog_subgroups", "catalog_teacher_subjects", "catalog_group_auto_rooms",
  "quarters", "study_plans", "plan_assignments", "bell_settings", "school_calendar", "curricula",
  "published_quarters", "publication_replays", "temporary_teacher_replacements",
  "teacher_replacement_operations", "teacher_lesson_origins", "teacher_teaching_assignments",
  "teacher_reassignment_operations", "school_display_settings", "school_display_setting_replays",
  "editor_request_replays", "schedule_operation_replays", "generation_jobs",
] as const;

const ROWID_TABLES = new Set([
  "teacher_replacement_operations", "curricula", "catalog_subjects", "catalog_teacher_subjects",
  "catalog_teachers", "catalog_rooms", "catalog_groups", "catalog_subgroups", "plan_assignments",
  "teacher_lesson_origins", "teacher_teaching_assignments", "temporary_teacher_replacements", "lessons",
  // Present in the current PostgreSQL baseline and preserves SQLite rowid semantics if later queries need it.
  "teacher_reassignment_operations",
]);

// Foreign-key order: parents first for inserts and children first for deletes.
const INSERT_ORDER = [
  "admin_users", "sessions", "draft_metadata", "catalog_rooms", "catalog_subjects", "catalog_groups",
  "catalog_teachers", "catalog_subgroups", "catalog_teacher_subjects", "catalog_group_auto_rooms",
  "schedule_days", "schedule_slots", "lessons", "plan_baselines", "request_replays",
  "quarters", "study_plans", "plan_assignments", "bell_settings", "school_calendar", "curricula",
  "published_quarters", "publication_replays", "temporary_teacher_replacements",
  "teacher_replacement_operations", "teacher_lesson_origins", "teacher_teaching_assignments",
  "teacher_reassignment_operations", "school_display_settings", "school_display_setting_replays",
  "editor_request_replays", "schedule_operation_replays", "generation_jobs",
] as const;

const BASELINE_TABLES = new Set(["draft_metadata", "bell_settings", "school_calendar", "school_display_settings"]);
const MAX_PARAMETERS = 60_000;

export interface MigrationOptions {
  from: string;
  databaseUrl: string;
}

function quoteIdentifier(identifier: string): string {
  // Identifiers come only from our fixed table list or the inspected schema.
  return `"${identifier.replaceAll('"', '""')}"`;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Buffer.isBuffer(value)) return `buffer:${value.toString("base64")}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function tableDigest(rows: Array<Record<string, unknown>>): string {
  const lines = rows.map(canonical).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function validateSourceSchema(db: Database.Database): Map<string, string[]> {
  const version = db.prepare("SELECT 1 FROM schema_migrations WHERE version=23").get();
  if (!version) throw new Error("SQLite source must have schema migration 23 applied");

  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  const supported = new Set<string>([...TABLES, "schema_migrations"]);
  const unexpected = [...tables].filter((table) => !table.startsWith("sqlite_") && !supported.has(table));
  if (unexpected.length) throw new Error(`SQLite source has unsupported tables: ${unexpected.sort().join(", ")}`);
  const columns = new Map<string, string[]>();
  for (const table of TABLES) {
    if (!tables.has(table)) throw new Error(`SQLite source is missing required table: ${table}`);
    columns.set(table, (db.pragma(`table_info(${quoteIdentifier(table)})`) as Array<{ name: string }>).map((column) => column.name));
  }
  return columns;
}

function verifyIntegrity(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("integrity_check") as Array<Record<string, string>>;
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") throw new Error("SQLite snapshot failed integrity_check");
  } finally {
    db.close();
  }
}

async function createSnapshot(sourcePath: string): Promise<{ directory: string; path: string }> {
  const source = realpathSync(resolve(sourcePath));
  if (!statSync(source).isFile()) throw new Error("--from must point to a SQLite database file");
  const directory = mkdtempSync(join(tmpdir(), `.${basename(source)}.pg-migration-`));
  const path = join(directory, "snapshot.sqlite");
  try {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      validateSourceSchema(db);
      // better-sqlite3's backup API captures a consistent database including committed WAL content.
      await awaitBackup(db, path);
    } finally {
      db.close();
    }
    verifyIntegrity(path);
    return { directory, path };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function awaitBackup(db: Database.Database, destination: string): Promise<void> {
  return db.backup(destination).then(() => undefined);
}

function readSourceRows(db: Database.Database, table: string, columns: string[]): Array<Record<string, unknown>> {
  const selectedColumns = columns.map((column) => column === "insertion_order" && ROWID_TABLES.has(table)
    ? `rowid AS ${quoteIdentifier(column)}`
    : quoteIdentifier(column)).join(",");
  return db.prepare(`SELECT ${selectedColumns} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
}

async function targetColumns(client: import("pg").PoolClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

function assertCompatibleColumns(table: string, source: string[], target: string[]): void {
  const sourceSorted = [...source].sort();
  const targetSorted = [...target].sort();
  if (canonical(sourceSorted) !== canonical(targetSorted)) {
    throw new Error(`Schema mismatch for ${table}; source and PostgreSQL columns differ`);
  }
}

async function readTargetRows(client: import("pg").PoolClient, table: string, columns: string[]): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(`SELECT ${columns.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table)}`);
  return result.rows as Array<Record<string, unknown>>;
}

async function assertFreshTarget(client: import("pg").PoolClient): Promise<void> {
  for (const table of TABLES) {
    const result = await client.query(`SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`);
    const count = Number(result.rows[0]?.count ?? 0);
    if (!count) continue;
    if (!BASELINE_TABLES.has(table)) throw new Error(`PostgreSQL target is not empty: ${table} contains data`);
    // A fresh database may have only the driver's singleton defaults. They are replaced by source rows.
    const expectedId = table === "draft_metadata" ? 1 : 1;
    const rows = await readTargetRows(client, table, await targetColumns(client, table));
    if (rows.length !== 1 || Number(rows[0]?.id) !== expectedId) {
      throw new Error(`PostgreSQL target is not fresh: unexpected rows in ${table}`);
    }
    if (table === "draft_metadata" && (Number(rows[0]?.revision) !== 0 || Number(rows[0]?.initialized) !== 0)) {
      throw new Error("PostgreSQL target draft metadata is not at its fresh default");
    }
  }
}

async function insertRows(client: import("pg").PoolClient, table: string, columns: string[], rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const quotedColumns = columns.map(quoteIdentifier).join(",");
  const batchSize = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await client.query(`INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES ${tuples.join(",")}`, values);
  }
}

async function setSequence(client: import("pg").PoolClient, table: string, column: string): Promise<void> {
    await client.query(
      `SELECT setval(pg_get_serial_sequence(current_schema() || '.' || $1, $2), GREATEST(COALESCE((SELECT MAX(${quoteIdentifier(column)}) FROM ${quoteIdentifier(table)}), 1), 1), EXISTS(SELECT 1 FROM ${quoteIdentifier(table)}))`,
      [table, column],
    );
}

async function setIdentitySequences(client: import("pg").PoolClient): Promise<void> {
  for (const table of ["schedule_days", "schedule_slots"] as const) {
    await setSequence(client, table, "id");
  }
  for (const table of ROWID_TABLES) {
    await setSequence(client, table, "insertion_order");
  }
}

export async function migrateSqliteToPostgres(options: MigrationOptions): Promise<Map<string, { count: number; sha256: string }>> {
  const snapshot = await createSnapshot(options.from);
  const source = new Database(snapshot.path, { readonly: true, fileMustExist: true });
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 1,
    application_name: "smena-sqlite-migration",
    types: {
      getTypeParser: (oid, format) => {
        if (oid === 20 && format !== "binary") {
          return (value: string) => {
            const integer = Number(value);
            return Number.isSafeInteger(integer) ? integer : value;
          };
        }
        return pgTypes.getTypeParser(oid, format);
      },
    },
  });
  try {
    const sourceColumns = validateSourceSchema(source);
    const migrationColumns = new Map([...sourceColumns].map(([table, columns]) => [
      table,
      ROWID_TABLES.has(table) ? [...columns, "insertion_order"] : columns,
    ]));
    const sourceRows = new Map<string, Array<Record<string, unknown>>>();
    const expected = new Map<string, { count: number; sha256: string }>();
    for (const table of TABLES) {
      const rows = readSourceRows(source, table, migrationColumns.get(table)!);
      sourceRows.set(table, rows);
      expected.set(table, { count: rows.length, sha256: tableDigest(rows) });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(1397572178, 1)");
        await assertFreshTarget(client);
        for (const table of TABLES) {
          const pgColumns = await targetColumns(client, table);
          const columns = migrationColumns.get(table)!;
          const legacyPublication = table === "published_quarters" && !columns.includes("print_index_json");
          assertCompatibleColumns(table, columns, legacyPublication ? pgColumns.filter(column => column !== "print_index_json") : pgColumns);
        }
        for (const table of [...INSERT_ORDER].reverse()) await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
        for (const table of INSERT_ORDER) {
          const columns = migrationColumns.get(table)!;
          await insertRows(client, table, columns, sourceRows.get(table)!);
        }
        if (!migrationColumns.get("published_quarters")!.includes("print_index_json")) {
          // v23 sources predate this derived column. Keep the source-column
          // digest comparison below intact and verify the new data separately.
          for (const row of sourceRows.get("published_quarters")!) {
            const compact = JSON.stringify(createPublicationPrintIndex(JSON.parse(String(row.snapshot_json)) as PublicationSnapshot));
            await client.query("UPDATE published_quarters SET print_index_json=$1 WHERE quarter_id=$2", [compact, row.quarter_id]);
            const persisted = await client.query("SELECT print_index_json FROM published_quarters WHERE quarter_id=$1", [row.quarter_id]);
            if (persisted.rows[0]?.print_index_json !== compact) throw new Error("Verification failed for imported publication print index");
          }
        }
        await setIdentitySequences(client);
        for (const table of TABLES) {
          const rows = await readTargetRows(client, table, migrationColumns.get(table)!);
          const actual = { count: rows.length, sha256: tableDigest(rows) };
          const wanted = expected.get(table)!;
          if (actual.count !== wanted.count || actual.sha256 !== wanted.sha256) {
            throw new Error(`Verification failed after importing ${table}; PostgreSQL transaction will be rolled back`);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
    return expected;
  } catch (error) {
    // pg can include connection details in uncommon errors; never surface the provided URL.
    if (error instanceof Error) {
      const safe = error.message.replaceAll(options.databaseUrl, "[database URL]");
      throw new Error(safe);
    }
    throw new Error("SQLite to PostgreSQL migration failed");
  } finally {
    source.close();
    await pool.end();
    rmSync(snapshot.directory, { recursive: true, force: true });
  }
}

function parseArguments(args: string[]): { from: string; databaseUrl?: string } {
  let from: string | undefined;
  let databaseUrl: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    const value = args[index + 1];
    if ((key !== "--from" && key !== "--database-url") || !value || value.startsWith("--")) {
      throw new Error("Usage: node scripts/migrate-sqlite-to-postgres.ts --from SQLITE_PATH [--database-url URL]");
    }
    if (key === "--from") {
      if (from) throw new Error("--from may be supplied once");
      from = value;
    } else {
      if (databaseUrl) throw new Error("--database-url may be supplied once");
      databaseUrl = value;
    }
    index++;
  }
  if (!from) throw new Error("A SQLite source is required with --from");
  return { from, databaseUrl: databaseUrl ?? process.env.SMENA_DATABASE_URL };
}

async function main(args: string[]): Promise<void> {
  const { from, databaseUrl } = parseArguments(args);
  if (!databaseUrl) throw new Error("Set SMENA_DATABASE_URL or provide --database-url");
  const report = await migrateSqliteToPostgres({ from, databaseUrl });
  const total = [...report.values()].reduce((sum, table) => sum + table.count, 0);
  console.log(`Imported ${report.size} tables and ${total} rows; row counts and SHA-256 digests match.`);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "SQLite to PostgreSQL migration failed");
    process.exitCode = 1;
  });
}
