export type SubgroupLanguage = "german" | "chinese";

export interface NamedSubgroup {
  id: string;
  groupName: string;
  language: SubgroupLanguage;
}

/** Build stable, readable names and disambiguate repeated language groups. */
export function makeSubgroupNames(rows: readonly NamedSubgroup[]): Map<string, string> {
  const ordered = [...rows].sort((a, b) =>
    a.groupName.localeCompare(b.groupName, "ru") || a.language.localeCompare(b.language) || a.id.localeCompare(b.id),
  );
  const totals = new Map<string, number>();
  for (const row of ordered) {
    const key = `${row.groupName}\u0000${row.language}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const indexes = new Map<string, number>();
  const labels: Record<SubgroupLanguage, string> = { german: "Немецкий", chinese: "Китайский" };
  const result = new Map<string, string>();
  for (const row of ordered) {
    const key = `${row.groupName}\u0000${row.language}`;
    const index = (indexes.get(key) ?? 0) + 1;
    indexes.set(key, index);
    const suffix = (totals.get(key) ?? 0) > 1 ? `-${index}` : "";
    result.set(row.id, `${labels[row.language]} ${row.groupName}${suffix}`);
  }
  return result;
}
