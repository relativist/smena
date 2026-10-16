import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSubgroupNames, type SubgroupLanguage } from "../shared/subgroup-names.ts";

interface Row {
  id: string;
  group_id: string;
  group_name: string;
  name: string;
  subject_id: string;
}

const subjectLanguages: Record<string, SubgroupLanguage> = {
  "school:german": "german",
  "school:chinese": "chinese",
};

export function buildRenamePlan(rows: readonly Row[]): Array<{ id: string; groupId: string; subjectId: string; oldName: string; newName: string }> {
  const languages = new Map<string, SubgroupLanguage>();
  const unique = new Map<string, Row>();
  for (const row of rows) {
    const language = subjectLanguages[row.subject_id];
    if (!language) throw new Error(`Unexpected subject for language subgroup ${row.id}: ${row.subject_id}`);
    const key = `${row.id}\u0000${row.subject_id}`;
    unique.set(key, row);
    const prior = languages.get(row.id);
    if (prior && prior !== language) throw new Error(`Subgroup ${row.id} is assigned to multiple languages`);
    languages.set(row.id, language);
  }
  const distinct = [...new Map([...unique.values()].map(row => [row.id, row])).values()];
  const names = makeSubgroupNames(distinct.map(row => ({ id: row.id, groupName: row.group_name, language: languages.get(row.id)! })));
  return distinct.map(row => ({ id: row.id, groupId: row.group_id, subjectId: row.subject_id, oldName: row.name, newName: names.get(row.id)! }));
}

export function renameLanguageSubgroups(dbPath = "data/smena.sqlite"): { renamed: number; lessons: number; baselines: number; revision: number } {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    const transaction = db.transaction(() => {
      const revision = (db.prepare("SELECT revision FROM draft_metadata WHERE id=1").get() as { revision: number }).revision;
      const rows = db.prepare(`
        SELECT sg.id,sg.group_id,g.name AS group_name,sg.name,sp.subject_id
        FROM catalog_subgroups sg
        JOIN catalog_groups g ON g.id=sg.group_id
        JOIN plan_assignments pa ON pa.subgroup_id=sg.id
        JOIN study_plans sp ON sp.id=pa.plan_id
        WHERE sp.subject_id IN ('school:german','school:chinese')
        ORDER BY sg.group_id,sg.id
      `).all() as Row[];
      const plan = buildRenamePlan(rows);
      if (plan.length !== 92) throw new Error(`Expected 92 language subgroups; found ${plan.length}`);
      const all = db.prepare("SELECT id,name FROM catalog_subgroups ORDER BY id").all() as Array<{ id: string; name: string }>;
      if (all.length !== 92 || new Set(plan.map(row => row.id)).size !== 92) throw new Error("Language subgroup inventory changed; refusing to rename");
      for (const row of plan) {
        if (row.oldName !== row.newName && row.oldName !== (row.subjectId === "school:german" ? "Немецкий язык" : "Китайский язык")) {
          throw new Error(`Unexpected current name for ${row.id}: ${row.oldName}`);
        }
      }
      const changed = plan.filter(row => row.oldName !== row.newName);
      if (!changed.length) return { renamed: 0, lessons: 0, baselines: 0, revision };
      const updateCatalog = db.prepare("UPDATE catalog_subgroups SET name=? WHERE id=? AND name=?");
      const updateLessons = db.prepare("UPDATE lessons SET subgroup=? WHERE subgroup_ref=?");
      const updateBaselines = db.prepare("UPDATE plan_baselines SET subgroup=? WHERE group_id=? AND subject_id=? AND subgroup=?");
      let lessons = 0, baselines = 0;
      for (const row of changed) {
        const catalogResult = updateCatalog.run(row.newName, row.id, row.oldName);
        assert.equal(catalogResult.changes, 1, `Subgroup ${row.id} changed during rename`);
        lessons += updateLessons.run(row.newName, row.id).changes;
        baselines += updateBaselines.run(row.newName, row.groupId, row.subjectId, row.oldName).changes;
      }
      const updatedAt = new Date().toISOString();
      const revisionResult = db.prepare("UPDATE draft_metadata SET revision=revision+1,updated_at=? WHERE id=1 AND revision=?").run(updatedAt, revision);
      assert.equal(revisionResult.changes, 1, "Draft revision changed during rename");
      return { renamed: changed.length, lessons, baselines, revision: revision + 1 };
    });
    return transaction.immediate();
  } finally {
    db.close();
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    const dbPath = process.argv[2] ?? "data/smena.sqlite";
    if (process.argv.length > 3) throw new Error("Usage: node scripts/rename-language-subgroups.ts [DB_PATH]");
    console.log(JSON.stringify({ database: resolve(dbPath), ...renameLanguageSubgroups(dbPath) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
