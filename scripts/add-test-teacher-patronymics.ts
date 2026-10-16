import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseBackup } from "./database-backup.ts";

type NameMap = Record<string, string>;
type Teacher = { id: string; name: string };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mappingPath = resolve(root, "scripts/full-school-teacher-names.json");

function loadMapping(): NameMap {
  const raw: unknown = JSON.parse(readFileSync(mappingPath, "utf8"));
  if (!Array.isArray(raw) || raw.some(name => typeof name !== "string" || !name.trim()))
    throw new Error("Teacher-name mapping must be a JSON array of full names.");
  const mapping: NameMap = {};
  for (const value of raw as string[]) {
    const newName = value.trim().replace(/\s+/gu, " ");
    const parts = newName.split(" ");
    if (parts.length !== 3) throw new Error(`Expected a three-part mapped name: ${newName}`);
    const oldName = parts.slice(0, 2).join(" ");
    if (mapping[oldName]) throw new Error(`Duplicate two-part teacher name: ${oldName}`);
    mapping[oldName] = newName;
  }
  return mapping;
}

async function main() {
  const dbPath = resolve(process.env.SMENA_DB_PATH ?? resolve(root, "data/smena.sqlite"));
  const backupDir = resolve(root, "backups");
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const backupPath = resolve(backupDir, `smena-before-teacher-patronymics-${day}.sqlite`);
  const mapping = loadMapping();

  const db = new Database(dbPath, { fileMustExist: true });
  let backupCreated = false;
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_teachers'").get();
    if (!table) throw new Error("Database has no catalog_teachers table.");
    const columns = new Set((db.pragma("table_info(catalog_teachers)") as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("id") || !columns.has("name")) throw new Error("catalog_teachers must contain id and name columns.");

    const teachers = db.prepare("SELECT id,name FROM catalog_teachers ORDER BY id").all() as Teacher[];
    const changes = teachers.flatMap(teacher => {
      const parts = teacher.name.trim().split(/\s+/u);
      if (parts.length !== 2) return [];
      const mapped = mapping[teacher.name.trim()];
      return mapped ? [{ id: teacher.id, oldName: teacher.name, newName: mapped }] : [];
    });

    if (changes.length === 0) {
      console.log(JSON.stringify({
        database: dbPath,
        backup: null,
        matched: 0,
        updated: 0,
        skippedAlreadyThreePartOrUnmapped: teachers.length,
        idempotence: "passed",
      }, null, 2));
      return;
    }

    mkdirSync(backupDir, { recursive: true });
    const saved = await createDatabaseBackup({ db: dbPath, to: backupPath });
    backupCreated = true;

    const update = db.prepare("UPDATE catalog_teachers SET name=? WHERE id=? AND name=?");
    const updateAll = db.transaction(() => {
      let updated = 0;
      for (const change of changes) updated += update.run(change.newName, change.id, change.oldName).changes;
      const metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='draft_metadata'").get();
      if (updated > 0 && metadata) {
        const columns = new Set((db.pragma("table_info(draft_metadata)") as Array<{ name: string }>).map(row => row.name));
        if (columns.has("revision") && columns.has("updated_at") && columns.has("id"))
          db.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1").run(new Date().toISOString());
      }
      return updated;
    });
    const updated = updateAll();
    const remaining = db.prepare("SELECT id,name FROM catalog_teachers WHERE name IN (" +
      Object.keys(mapping).map(() => "?").join(",") + ")").all(...Object.keys(mapping)) as Teacher[];
    if (remaining.length) throw new Error(`Idempotence check failed: ${remaining.length} mapped old names remain.`);
    const result = {
      database: dbPath,
      backup: saved,
      matched: changes.length,
      updated,
      skippedAlreadyThreePartOrUnmapped: teachers.length - changes.length,
      idempotence: "passed",
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (backupCreated) console.error(`Backup retained at ${backupPath}`);
    throw error;
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
