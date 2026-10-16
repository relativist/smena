import type { Catalog } from "./catalog.ts";
import { findUnavailability } from "./unavailability.ts";

/** A temporary, date-bounded preference created by accepting a replacement. */
export type TemporaryTeacherReplacement = {
  id: string;
  sourceTeacherId: string;
  groupId: string;
  subjectId: string;
  subgroupId?: string;
  subgroup?: string;
  startDate: string;
  endDate: string;
  unavailabilityRuleId?: string;
  teacherIds: string[];
};

export type TemporaryReplacementLookup = {
  sourceTeacherId: string;
  groupId: string;
  subjectId: string;
  subgroupId?: string;
  subgroup?: string;
  date: string;
  start: number;
  end: number;
};

/**
 * Return the latest matching temporary policy only while the source teacher is
 * actually unavailable for the requested lesson. Undefined means that normal
 * generator selection should proceed.
 */
export function temporaryReplacementTeacherIds(
  rules: TemporaryTeacherReplacement[] | undefined,
  catalog: Catalog,
  lookup: TemporaryReplacementLookup,
): string[] | undefined {
  if (!rules?.length) return undefined;
  const unavailable = findUnavailability(
    catalog,
    "teacher",
    lookup.sourceTeacherId,
    lookup.date,
    lookup.start,
    lookup.end,
  );
  if (!unavailable.length) return undefined;

  const subgroupId = lookup.subgroupId ?? (lookup.subgroup
    ? catalog.subgroups.find((item) => item.groupId === lookup.groupId && item.name === lookup.subgroup)?.id
    : undefined);
  const subgroupIdentityMatches = (rule: TemporaryTeacherReplacement) => {
    const ruleSubgroupId = rule.subgroupId ?? (rule.subgroup
      ? catalog.subgroups.find((item) => item.groupId === rule.groupId && item.name === rule.subgroup)?.id
      : undefined);
    if (subgroupId || ruleSubgroupId) return subgroupId === ruleSubgroupId;
    return (rule.subgroup ?? "") === (lookup.subgroup ?? "");
  };

  const matches = rules.filter((rule) =>
    rule.sourceTeacherId === lookup.sourceTeacherId &&
    rule.groupId === lookup.groupId &&
    rule.subjectId === lookup.subjectId &&
    subgroupIdentityMatches(rule) &&
    rule.startDate <= lookup.date && rule.endDate >= lookup.date &&
    (!rule.unavailabilityRuleId || unavailable.some((item) => item.ruleId === rule.unavailabilityRuleId))
  );
  const latest = matches.at(-1);
  return latest ? [...latest.teacherIds] : undefined;
}
