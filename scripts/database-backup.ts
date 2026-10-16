import Database from "better-sqlite3";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BackupOptions {
  db?: string;
  to: string;
}

export interface RestoreOptions {
  from: string;
  to: string;
}

function integrityCheck(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<Record<string, string>>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}`);
    }
  } finally {
    db.close();
  }
}

function validateSource(path: string): string {
  const absolute = resolve(path);
  const sourceStat = statSync(absolute);
  if (!sourceStat.isFile()) throw new Error(`SQLite source is not a file: ${absolute}`);
  const real = realpathSync(absolute);
  integrityCheck(real);
  return real;
}

function absoluteTarget(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const realParent = realpathSync(parent);
  return join(realParent, basename(absolute));
}

function assertNewTarget(target: string, source: string): void {
  if (target === source) throw new Error("Source and destination must be different files");
  for (const candidate of [target, `${target}-wal`, `${target}-shm`, `${target}-journal`]) {
    try {
      lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (candidate === target) throw new Error(`Destination already exists: ${target}`);
    throw new Error(`SQLite sidecar already exists beside destination: ${candidate}`);
  }
}

async function writeNewDatabase(source: string, targetPath: string): Promise<string> {
  const target = absoluteTarget(targetPath);
  assertNewTarget(target, source);

  const temporaryDirectory = mkdtempSync(join(dirname(target), `.${basename(target)}.tmp-`));
  const temporaryDatabase = join(temporaryDirectory, "database.sqlite");
  try {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(temporaryDatabase);
    } finally {
      db.close();
    }
    chmodSync(temporaryDatabase, 0o600);
    integrityCheck(temporaryDatabase);

    // Reject orphaned SQLite state files again immediately before publishing.
    assertNewTarget(target, source);
    // A hard link publishes the fully written file atomically and fails if a
    // destination appeared after the initial existence check.
    linkSync(temporaryDatabase, target);
    return target;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function createDatabaseBackup(options: BackupOptions): Promise<string> {
  const configuredPath = options.db ?? process.env.SMENA_DB_PATH ?? "data/smena.sqlite";
  const source = validateSource(configuredPath);
  return writeNewDatabase(source, options.to);
}

export async function restoreDatabaseBackup(options: RestoreOptions): Promise<string> {
  const source = validateSource(options.from);
  return writeNewDatabase(source, options.to);
}

function parseArguments(args: string[]): { command: string; values: Map<string, string> } {
  const command = args[0];
  if (command !== "backup" && command !== "restore") {
    throw new Error("Usage: node scripts/database-backup.ts backup --to PATH [--db PATH] | restore --from PATH --to PATH");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    const value = args[index + 1];
    if ((key !== "--db" && key !== "--from" && key !== "--to") || !value || value.startsWith("--") || values.has(key)) {
      throw new Error("Usage: node scripts/database-backup.ts backup --to PATH [--db PATH] | restore --from PATH --to PATH");
    }
    values.set(key, value);
    index++;
  }
  return { command, values };
}

async function main(args: string[]): Promise<void> {
  const { command, values } = parseArguments(args);
  const target = values.get("--to");
  if (!target) throw new Error("A new destination is required with --to");
  let result: string;
  if (command === "backup") {
    if (values.has("--from")) throw new Error("--from is only valid for restore");
    result = await createDatabaseBackup({ db: values.get("--db"), to: target });
  } else {
    if (values.has("--db")) throw new Error("--db is only valid for backup");
    const from = values.get("--from");
    if (!from) throw new Error("An offline backup is required with --from");
    result = await restoreDatabaseBackup({ from, to: target });
  }
  console.log(`${command === "backup" ? "Backup" : "Restored database"} created: ${result}`);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
