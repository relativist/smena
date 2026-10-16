import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { Pool, types, type PoolClient, type QueryResult } from "pg";

export type DbRunResult = { changes: number; lastInsertRowid: number | bigint };
export type AsyncStatement = {
  get(...args: unknown[]): Promise<any>;
  all(...args: unknown[]): Promise<any[]>;
  run(...args: unknown[]): Promise<DbRunResult>;
};
export type AsyncDatabase = {
  readonly dialect: "sqlite" | "postgres";
  readonly native?: Database.Database;
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  pragma(sql: string): Promise<any>;
  transaction<T>(fn: (...args: any[]) => T | Promise<T>): (...args: any[]) => Promise<T>;
  readTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
};

type TxContext = { client?: PoolClient };

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

function sqliteTableInfoName(sql: string): string | undefined {
  const match = /^\s*(?:pragma\s+)?table_info\s*\(\s*["'`]?([a-zA-Z_][\w]*)["'`]?\s*\)\s*;?\s*$/i.exec(sql);
  return match?.[1];
}

function quoteMixedCaseAliases(sql: string): string {
  let out = "";
  let i = 0;
  let state: "normal" | "single" | "double" | "backtick" | "line" | "block" = "normal";
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (state === "single" || state === "double" || state === "backtick") {
      out += ch;
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "backtick" && ch === "`")) {
        if (next === ch) { out += next; i += 2; continue; }
        state = "normal";
      }
      if (ch === "\\" && next) { out += next; i += 2; continue; }
      i++; continue;
    }
    if (state === "line") { out += ch; if (ch === "\n") state = "normal"; i++; continue; }
    if (state === "block") { out += ch; if (ch === "*" && next === "/") { out += "/"; i += 2; state = "normal"; } else i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { state = ch === "'" ? "single" : ch === '"' ? "double" : "backtick"; out += ch; i++; continue; }
    if (ch === "-" && next === "-") { state = "line"; out += "--"; i += 2; continue; }
    if (ch === "/" && next === "*") { state = "block"; out += "/*"; i += 2; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (/[A-Za-z0-9_$]/.test(sql[end] ?? "")) end++;
      const word = sql.slice(i, end);
      out += word;
      i = end;
      if (word.toUpperCase() !== "AS") continue;
      let whitespaceEnd = i;
      while (/\s/.test(sql[whitespaceEnd] ?? "")) whitespaceEnd++;
      const aliasStart = whitespaceEnd;
      if (!/[A-Za-z_]/.test(sql[aliasStart] ?? "")) continue;
      let aliasEnd = aliasStart + 1;
      while (/[A-Za-z0-9_$]/.test(sql[aliasEnd] ?? "")) aliasEnd++;
      const alias = sql.slice(aliasStart, aliasEnd);
      if (/[a-z]/.test(alias) && /[A-Z]/.test(alias)) {
        out += sql.slice(i, whitespaceEnd) + `"${alias.replace(/"/g, '""')}"`;
        i = aliasEnd;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function pgTableInfo(): string {
  // The table name is a single identifier extracted from a fixed PRAGMA form.
  return "SELECT column_name AS name, ordinal_position AS cid, data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position";
}

function convertSql(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  const named = args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0])
    ? args[0] as Record<string, unknown> : undefined;
  const values: unknown[] = [];
  let out = "";
  let i = 0;
  let state: "normal" | "single" | "double" | "backtick" | "line" | "block" = "normal";
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (state === "single" || state === "double" || state === "backtick") {
      out += ch;
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "backtick" && ch === "`")) {
        if (next === ch) { out += next; i += 2; continue; }
        state = "normal";
      }
      if (ch === "\\" && next) { out += next; i += 2; continue; }
      i++; continue;
    }
    if (state === "line") { out += ch; if (ch === "\n") state = "normal"; i++; continue; }
    if (state === "block") { out += ch; if (ch === "*" && next === "/") { out += "/"; i += 2; state = "normal"; } else i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { state = ch === "'" ? "single" : ch === '"' ? "double" : "backtick"; out += ch; i++; continue; }
    if (ch === "-" && next === "-") { state = "line"; out += "--"; i += 2; continue; }
    if (ch === "/" && next === "*") { state = "block"; out += "/*"; i += 2; continue; }
    if (ch === "?") { values.push(args[values.length]); out += `$${values.length}`; i++; continue; }
    if (ch === "@" && /[A-Za-z_]/.test(next ?? "")) {
      let end = i + 2;
      while (/[A-Za-z0-9_]/.test(sql[end] ?? "")) end++;
      const key = sql.slice(i + 1, end);
      if (!named) throw new Error(`Named SQL parameter @${key} requires an object argument`);
      values.push(named[key]); out += `$${values.length}`; i = end; continue;
    }
    out += ch; i++;
  }
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(sql) && !/\bON\s+CONFLICT\b/i.test(out)) {
    const returning = /\s+RETURNING\s+.+$/i.exec(out);
    const insertionPoint = returning?.index ?? out.length;
    out = `${out.slice(0, insertionPoint).trimEnd()} ON CONFLICT DO NOTHING${returning ? out.slice(insertionPoint) : ""}`;
  }
  out = out.replace(/\bIS\s+NOT\s+(\$\d+)/gi, "IS DISTINCT FROM $1")
    .replace(/\bIS\s+(\$\d+)/gi, "IS NOT DISTINCT FROM $1");
  if (/\bFROM\s+sqlite_master\b/i.test(out)) {
    out = out.replace(/\bFROM\s+sqlite_master\b/gi, "FROM information_schema.tables")
      .replace(/\btype\s*=\s*'table'/gi, "table_type='BASE TABLE'")
      .replace(/\bname\s*=/gi, "table_name=");
    out = out.replace(/\bWHERE\s+table_type\s*=\s*'BASE TABLE'/i,
      "WHERE table_schema=current_schema() AND table_type='BASE TABLE'");
  }
  out = out.replace(/\browid\b/gi, "insertion_order");
  out = quoteMixedCaseAliases(out);
  return { sql: out, args: values };
}

class PostgresDatabase implements AsyncDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<TxContext>();
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      application_name: "smena",
      connectionTimeoutMillis: 5000,
      types: {
        getTypeParser(oid, format) {
          if (oid === 20 && format === "text") return (value: string) => {
            const number = Number(value);
            return Number.isSafeInteger(number) ? number : value;
          };
          return types.getTypeParser(oid, format);
        },
      },
    });
    this.pool.on("error", (error: Error) => {
      console.error(`PostgreSQL: потеряно свободное соединение: ${error.message}`);
    });
  }

  private async query(sql: string, args: unknown[] = []): Promise<QueryResult> {
    const infoName = sqliteTableInfoName(sql);
    if (infoName) return (this.context.getStore()?.client ?? this.pool).query(pgTableInfo(), [infoName]);
    const converted = convertSql(sql, args);
    return (this.context.getStore()?.client ?? this.pool).query(converted.sql, converted.args);
  }
  prepare(sql: string): AsyncStatement {
    return {
      get: async (...args) => (await this.query(sql, args)).rows[0],
      all: async (...args) => (await this.query(sql, args)).rows,
      run: async (...args) => {
        let querySql = sql;
        const wantsId = /^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(schedule_days|schedule_slots)\b/i.test(querySql);
        if (wantsId && !/\bRETURNING\b/i.test(querySql)) querySql = querySql.replace(/;\s*$/, "") + " RETURNING id";
        const result = await this.query(querySql, args);
        const inserted = result.rows[0]?.id;
        return { changes: result.rowCount ?? 0, lastInsertRowid: inserted === undefined ? 0 : Number(inserted) };
      },
    };
  }
  async exec(sql: string): Promise<void> {
    const statements = sql.split(/;\s*(?:\n|$)/).map(part => part.trim()).filter(Boolean);
    const client = this.context.getStore()?.client;
    for (const statement of statements) {
      // DDL is internal application SQL. Keep its accepted dialect changes explicit.
      const converted = convertSql(statement, []);
      await (client ?? this.pool).query(converted.sql);
    }
  }
  async pragma(sql: string): Promise<any> {
    const name = sqliteTableInfoName(sql);
    if (!name) throw new Error(`Unsupported pragma for PostgreSQL: ${sql}`);
    return (await this.query(sql)).rows;
  }
  transaction<T>(fn: (...args: any[]) => T | Promise<T>): (...args: any[]) => Promise<T> {
    return async (...args: any[]) => {
      if (this.context.getStore()) return await fn(...args);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1397572178, 1)");
        const result = await this.context.run({ client }, () => fn(...args));
        const committed = await client.query("COMMIT");
        if (committed.command !== "COMMIT") throw new Error("Транзакция PostgreSQL была отменена");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* retain original failure */ }
        throw error;
      } finally { client.release(); }
    };
  }
  async readTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return await fn();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.context.run({ client }, fn);
      const committed = await client.query("COMMIT");
      if (committed.command !== "COMMIT") throw new Error("Транзакция чтения PostgreSQL была отменена");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* retain original failure */ }
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

class SqliteDatabase implements AsyncDatabase {
  readonly dialect = "sqlite" as const;
  readonly native: Database.Database;
  private readonly mutex = new AsyncMutex();
  private readonly context = new AsyncLocalStorage<boolean>();
  constructor(path: string | Database.Database) {
    this.native = typeof path === "string" ? new Database(path) : path;
    this.native.pragma("foreign_keys = ON");
    this.native.pragma("journal_mode = WAL");
    this.native.pragma("busy_timeout = 5000");
  }
  private async locked<T>(fn: () => T): Promise<T> {
    if (this.context.getStore()) return fn();
    return this.mutex.run(async () => fn());
  }
  prepare(sql: string): AsyncStatement {
    const statement = this.native.prepare(sql);
    return {
      get: async (...args) => this.locked(() => statement.get(...args)),
      all: async (...args) => this.locked(() => statement.all(...args)),
      run: async (...args) => this.locked(() => statement.run(...args)),
    };
  }
  async exec(sql: string): Promise<void> { await this.locked(() => { this.native.exec(sql); }); }
  async pragma(sql: string): Promise<any> { return this.locked(() => this.native.pragma(sql)); }
  transaction<T>(fn: (...args: any[]) => T | Promise<T>): (...args: any[]) => Promise<T> {
    return async (...args: any[]) => {
      if (this.context.getStore()) return await fn(...args);
      return this.mutex.run(async () => {
        this.native.exec("BEGIN IMMEDIATE");
        try {
          const result = await this.context.run(true, () => fn(...args));
          this.native.exec("COMMIT");
          return result;
        } catch (error) {
          this.native.exec("ROLLBACK");
          throw error;
        }
      });
    };
  }
  async readTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return await this.transaction(fn)();
  }
  async close(): Promise<void> { await this.mutex.run(async () => { this.native.close(); }); }
}

export function openPostgresDatabase(connectionString: string): AsyncDatabase {
  return new PostgresDatabase(connectionString);
}

export function openSqliteDatabase(path: string): AsyncDatabase {
  return new SqliteDatabase(path);
}

export function wrapSqliteDatabase(native: Database.Database): AsyncDatabase {
  return new SqliteDatabase(native);
}
