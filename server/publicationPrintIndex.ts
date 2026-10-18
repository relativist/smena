import type { AsyncDatabase } from "./database.ts";
import type { PublicationSnapshot } from "../shared/publicationTypes.ts";

export type PublicationPrintIndex = {
  formatVersion: 1;
  quarter: Pick<PublicationSnapshot["quarter"], "id" | "name" | "startDate" | "endDate">;
  groups: Array<{ id: string; name: string }>;
};

/** Derived exclusively from the immutable publication, never the current catalog. */
export function createPublicationPrintIndex(snapshot: PublicationSnapshot): PublicationPrintIndex {
  const { id, name, startDate, endDate } = snapshot.quarter;
  return {
    formatVersion: 1,
    quarter: { id, name, startDate, endDate },
    groups: snapshot.catalog.groups.filter(group => !group.archived)
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true })),
  };
}

export function readPublicationPrintIndex(json: string): PublicationPrintIndex {
  const index = JSON.parse(json) as PublicationPrintIndex;
  if (index?.formatVersion !== 1 || !index.quarter ||
    [index.quarter.id, index.quarter.name, index.quarter.startDate, index.quarter.endDate].some(value => typeof value !== "string") ||
    !Array.isArray(index.groups) || index.groups.some(group => typeof group?.id !== "string" || typeof group?.name !== "string"))
    throw new Error("Некорректный индекс опубликованного расписания");
  return index;
}

/** The marker makes snapshot reads a one-time migration cost, not a startup cost. */
export async function migratePublicationPrintIndex(db: AsyncDatabase): Promise<void> {
  const table = db.dialect === "postgres" ? "postgres_schema_migrations" : "schema_migrations";
  const version = db.dialect === "postgres" ? 5 : 24;
  if (await db.prepare(`SELECT 1 FROM ${table} WHERE version=?`).get(version)) return;
  const columns = await db.pragma("table_info(published_quarters)") as Array<{ name: string }>;
  if (!columns.some(column => column.name === "print_index_json"))
    await db.exec(`ALTER TABLE published_quarters ADD COLUMN print_index_json TEXT${db.dialect === "postgres" ? ' COLLATE "C"' : ""} NOT NULL DEFAULT ''`);
  const rows = await db.prepare("SELECT quarter_id,snapshot_json FROM published_quarters").all() as Array<{ quarter_id: string; snapshot_json: string }>;
  const update = db.prepare("UPDATE published_quarters SET print_index_json=? WHERE quarter_id=?");
  for (const row of rows) {
    const index = createPublicationPrintIndex(JSON.parse(row.snapshot_json) as PublicationSnapshot);
    await update.run(JSON.stringify(index), row.quarter_id);
  }
  if (db.dialect === "postgres") await db.prepare(`INSERT INTO ${table}(version) VALUES(?)`).run(version);
  else await db.prepare(`INSERT INTO ${table}(version,applied_at) VALUES(?,CURRENT_TIMESTAMP)`).run(version);
}
