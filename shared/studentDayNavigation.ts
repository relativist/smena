import type { PublicStudentDay } from "./studentTypes.ts";

export type SchoolStage = "all" | "primary" | "middle" | "high";
type DayGroup = { id: string; name: string; day?: PublicStudentDay };

export function groupGrade(name: string): number | undefined {
  const match = /^\s*(\d+)/u.exec(name);
  return match ? Number(match[1]) : undefined;
}

export function matchesSchoolStage(name: string, stage: SchoolStage): boolean {
  if (stage === "all") return true;
  const grade = groupGrade(name);
  return grade !== undefined && (stage === "primary" ? grade >= 1 && grade <= 4
    : stage === "middle" ? grade >= 5 && grade <= 9 : grade >= 10 && grade <= 11);
}

export function shiftStudentDate(date: string, offset: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

/** Keep grades ascending; place connected same-grade joint lessons together. */
export function sortDayGroups<T extends DayGroup>(groups: T[]): T[] {
  const compare = (a: T, b: T) => {
    const gradeA = groupGrade(a.name) ?? Number.MAX_SAFE_INTEGER;
    const gradeB = groupGrade(b.name) ?? Number.MAX_SAFE_INTEGER;
    return gradeA - gradeB || a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
  };
  const sorted = [...groups].sort(compare);
  const byId = new Map(sorted.map(group => [group.id, group]));
  const edges = new Map(sorted.map(group => [group.id, new Set<string>()]));
  for (const group of sorted) {
    if (group.day?.holiday) continue;
    for (const lesson of group.day?.lessons ?? []) {
      for (const participant of lesson.jointGroups ?? []) {
        const other = byId.get(participant.id);
        if (!other || other.id === group.id || other.day?.holiday || groupGrade(other.name) !== groupGrade(group.name)) continue;
        edges.get(group.id)!.add(other.id);
        edges.get(other.id)!.add(group.id);
      }
    }
  }
  const result: T[] = [];
  const visited = new Set<string>();
  const visit = (group: T) => {
    if (visited.has(group.id)) return;
    visited.add(group.id);
    result.push(group);
    const neighbours = [...edges.get(group.id)!].map(id => byId.get(id)!).sort(compare);
    neighbours.forEach(visit);
  };
  sorted.forEach(visit);
  return result;
}
