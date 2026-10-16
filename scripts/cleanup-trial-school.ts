// Remove only a disposable PostgreSQL school created by trial:prepare:postgres.
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Pool } from "pg";

const testUrl = process.env.SMENA_TEST_DATABASE_URL;
if (!testUrl) throw new Error("Укажите SMENA_TEST_DATABASE_URL; рабочее подключение не используется");
if (process.argv.length !== 3) throw new Error("Укажите каталог из результата trial:prepare:postgres");
const root = resolve(process.argv[2]!);
if (dirname(root) !== resolve(tmpdir()) || !/^smena-trial-scale-[A-Za-z0-9]+$/.test(basename(root)) || lstatSync(root).isSymbolicLink())
  throw new Error("Можно удалить только временную пробную школу в системном временном каталоге");
const context = JSON.parse(readFileSync(join(root, "context.json"), "utf8")) as { root?: string; schema?: string };
if (context.root !== root || typeof context.schema !== "string" || !/^smena_trial_\d+_[0-9a-f]{32}$/.test(context.schema))
  throw new Error("Каталог не содержит контекст пробной школы PostgreSQL");
const connection = readFileSync(join(root, ".env.local"), "utf8").split("\n").find(line => line.startsWith("SMENA_DATABASE_URL="))?.slice("SMENA_DATABASE_URL=".length);
if (!connection) throw new Error("Нет подключения пробной школы");
const scoped = new URL(connection), base = new URL(testUrl);
if (scoped.host !== base.host || scoped.pathname !== base.pathname || !scoped.searchParams.get("options")?.endsWith(`-c search_path=${context.schema},public`))
  throw new Error("Контекст пробы относится к другой тестовой базе");
const pool = new Pool({ connectionString: testUrl, max: 1, application_name: "smena-trial-school-cleanup" });
try {
  await pool.query(`DROP SCHEMA IF EXISTS "${context.schema}" CASCADE`);
  rmSync(root, { recursive: true });
  console.info("Пробная схема PostgreSQL и её временные файлы удалены");
} finally { await pool.end(); }
