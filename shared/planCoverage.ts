import type { Quarter, StudyPlan } from "./plans.ts";

export type PlanCoverageGroup = {
  id: string;
  name: string;
  archived: boolean;
  hasPlan: boolean;
  target: number;
  scheduled: number;
  covered: number;
  missing: number;
  extra: number;
  percent: number | null;
  status: "no-plan" | "empty" | "partial" | "complete";
};

export type PlanCoverageResponse = { quarter: Quarter; groups: PlanCoverageGroup[] };

export type PlanCoverageDetailRow = {
  id: string;
  subjectId: string;
  subjectName: string;
  subgroupId: string | null;
  subgroupName: string | null;
  lessonKind: "regular" | "lab";
  target: number;
  scheduled: number;
};

export type PlanCoverageDetailsResponse = {
  quarter: Quarter;
  group: { id: string; name: string; archived: boolean };
  rows: PlanCoverageDetailRow[];
};

type LessonCountRow = {
  groupId: string;
  subjectId: string;
  lessonKind: "regular" | "lab";
  subgroupId: string | null;
  subgroupLabel: string | null;
  count: number;
};

function createLessonCounter(lessonRows: LessonCountRow[]) {
  const wholeCounts = new Map<string, number>();
  const subgroupCounts = new Map<string, number>();
  const baseKey = (groupId: string, subjectId: string, lessonKind: string) => JSON.stringify([groupId, subjectId, lessonKind]);
  const idKey = (groupId: string, subjectId: string, lessonKind: string, subgroupId: string) => JSON.stringify([groupId, subjectId, lessonKind, subgroupId]);
  for (const row of lessonRows) {
    if (!row.subgroupId && row.subgroupLabel) continue;
    const counts = row.subgroupId ? subgroupCounts : wholeCounts;
    const key = row.subgroupId ? idKey(row.groupId, row.subjectId, row.lessonKind, row.subgroupId) : baseKey(row.groupId, row.subjectId, row.lessonKind);
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }
  return (groupId: string, subjectId: string, lessonKind: string, subgroupId: string | null) => {
    const whole = wholeCounts.get(baseKey(groupId, subjectId, lessonKind)) ?? 0;
    return subgroupId ? whole + (subgroupCounts.get(idKey(groupId, subjectId, lessonKind, subgroupId)) ?? 0) : whole;
  };
}

export function planCoverageSummary(
  quarter: Quarter,
  groups: Array<{ id: string; name: string; archived: boolean }>,
  plans: StudyPlan[],
  lessonRows: Array<{
    groupId: string;
    subjectId: string;
    lessonKind: "regular" | "lab";
    subgroupId: string | null;
    subgroupLabel: string | null;
    count: number;
  }>,
): PlanCoverageResponse {
  const countLessons = createLessonCounter(lessonRows);
  const groupPlans = new Map<string, StudyPlan[]>();
  for (const plan of plans.filter(item => item.quarterId === quarter.id)) {
    const list = groupPlans.get(plan.groupId) ?? [];
    list.push(plan);
    groupPlans.set(plan.groupId, list);
  }
  const visibleGroups = groups.filter(group => !group.archived || (groupPlans.get(group.id)?.length ?? 0) > 0);

  const result = visibleGroups.map(group => {
    const assignments = (groupPlans.get(group.id) ?? []).flatMap(plan => plan.assignments.map(assignment => {
      const scheduled = countLessons(group.id, plan.subjectId, plan.lessonKind, assignment.subgroupId);
      const target = assignment.target;
      const covered = Math.min(target, scheduled);
      return {
        id: assignment.id,
        subjectId: plan.subjectId,
        lessonKind: plan.lessonKind,
        subgroupId: assignment.subgroupId,
        target,
        scheduled,
        covered,
        missing: Math.max(0, target - scheduled),
        extra: Math.max(0, scheduled - target),
      };
    }));
    const hasPlan = assignments.some(item => item.target > 0);
    const totals = assignments.reduce((acc, item) => ({
      target: acc.target + item.target,
      scheduled: acc.scheduled + item.scheduled,
      covered: acc.covered + item.covered,
      missing: acc.missing + item.missing,
      extra: acc.extra + item.extra,
    }), { target: 0, scheduled: 0, covered: 0, missing: 0, extra: 0 });
    const status = !hasPlan ? "no-plan" : totals.scheduled === 0 ? "empty" : totals.missing === 0 ? "complete" : "partial";
    return {
      id: group.id,
      name: group.name,
      archived: group.archived,
      ...totals,
      hasPlan,
      percent: hasPlan && totals.target > 0
        ? Math.min(totals.missing > 0 ? 99.9 : 100, Math.floor(totals.covered / totals.target * 1000) / 10)
        : null,
      status,
    } satisfies PlanCoverageGroup;
  });
  return { quarter, groups: result };
}

export function planCoverageDetails(
  quarter: Quarter,
  group: { id: string; name: string; archived: boolean },
  plans: StudyPlan[],
  lessonRows: LessonCountRow[],
  subjects: Array<{ id: string; name: string }>,
  subgroups: Array<{ id: string; name: string }>,
): PlanCoverageDetailsResponse {
  const countLessons = createLessonCounter(lessonRows);
  const subjectNames = new Map(subjects.map(item => [item.id, item.name]));
  const subgroupNames = new Map(subgroups.map(item => [item.id, item.name]));
  const rows = plans.filter(plan => plan.quarterId === quarter.id && plan.groupId === group.id)
    .flatMap(plan => plan.assignments.map(assignment => ({
      id: assignment.id,
      subjectId: plan.subjectId,
      subjectName: subjectNames.get(plan.subjectId) ?? plan.subjectId,
      subgroupId: assignment.subgroupId,
      subgroupName: assignment.subgroupId ? subgroupNames.get(assignment.subgroupId) ?? assignment.subgroupId : null,
      lessonKind: plan.lessonKind,
      target: assignment.target,
      scheduled: countLessons(group.id, plan.subjectId, plan.lessonKind, assignment.subgroupId),
    } satisfies PlanCoverageDetailRow)));
  const collator = new Intl.Collator("ru");
  rows.sort((left, right) => collator.compare(left.subjectName, right.subjectName)
    || collator.compare(left.subgroupName ?? "", right.subgroupName ?? "")
    || collator.compare(left.lessonKind, right.lessonKind)
    || collator.compare(left.id, right.id));
  return { quarter, group, rows };
}
