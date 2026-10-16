import type { Catalog } from "./catalog.ts";
import type { Quarter, StudyPlan, LessonKind } from "./plans.ts";

export type CurriculumRow = {
  id: string;
  subjectId: string;
  lessonKind: LessonKind;
  mode: "whole" | "subgroups";
  hours: number;
  /** When omitted, every active subgroup of each assigned group participates. */
  subgroupIdsByGroup?: Record<string, string[]>;
};
export type Curriculum = {
  id: string;
  name: string;
  /** Shared composition/name; applications keep their own quarter-hour totals. */
  templateId?: string;
  quarterId: string;
  groupIds: string[];
  rows: CurriculumRow[];
};

const idPattern = /^[\p{L}\p{N}_:./-]+$/u;
const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 120 && idPattern.test(v);

export function validateCurricula(value: unknown, catalog: Catalog, quarters: Quarter[], previous: Curriculum[] = []): string | null {
  if (!Array.isArray(value) || value.length > 1500) return "Список планов заполнен некорректно";
  const groups = new Map(catalog.groups.map(x => [x.id, x]));
  const subjects = new Map(catalog.subjects.map(x => [x.id, x]));
  const quarterIds = new Set(quarters.map(x => x.id));
  const prior = new Map(previous.map(x => [x.id, x]));
  const ids = new Set<string>(), names = new Set<string>(), ownership = new Set<string>();
  const templateNames = new Map<string, string>();
  let rowCount = 0;
  for (const item of value) {
    if (!isRecord(item) || !isId(item.id) || ids.has(item.id) ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 ||
      (item.templateId !== undefined && !isId(item.templateId)) ||
      !isId(item.quarterId) || !quarterIds.has(item.quarterId) ||
      !Array.isArray(item.groupIds) || item.groupIds.length > 500 ||
      !Array.isArray(item.rows) || item.rows.length > 1000 || Object.hasOwn(item, "bindings"))
      return "Проверьте название, четверть и состав плана";
    ids.add(item.id);
    const normalizedName = item.name.trim().toLocaleLowerCase("ru");
    const family = item.templateId ?? item.id;
    if (templateNames.has(normalizedName) && templateNames.get(normalizedName) !== family)
      return "Название общего плана уже используется";
    templateNames.set(normalizedName, family);
    const nameKey = JSON.stringify([item.quarterId, item.name.trim().toLocaleLowerCase("ru")]);
    if (names.has(nameKey)) return "Названия планов в одной четверти должны различаться";
    names.add(nameKey);
    const old = prior.get(item.id);
    const groupIds = new Set<string>();
    for (const groupId of item.groupIds) {
      if (typeof groupId !== "string" || !groups.has(groupId) || groupIds.has(groupId))
        return "В плане указана неизвестная или повторная группа";
      const group = groups.get(groupId)!;
      if (group.archived && !old?.groupIds.includes(groupId)) return "Нельзя назначить план архивной группе";
      groupIds.add(groupId);
      const owner = JSON.stringify([item.quarterId, groupId]);
      if (ownership.has(owner)) return "Для группы в четверти можно выбрать только один план";
      ownership.add(owner);
    }
    const rowIds = new Set<string>(), uniqueness = new Set<string>();
    for (const row of item.rows) {
      rowCount++;
      if (!isRecord(row) || !isId(row.id) || rowIds.has(row.id) ||
        typeof row.subjectId !== "string" || !subjects.has(row.subjectId) ||
        !(row.lessonKind === "regular" || row.lessonKind === "lab") ||
        !(row.mode === "whole" || row.mode === "subgroups") ||
        !Number.isInteger(row.hours) || row.hours < 1 || row.hours > 1000)
        return "В плане есть некорректный предмет или количество часов";
      rowIds.add(row.id);
      const key = JSON.stringify([row.subjectId, row.lessonKind]);
      if (uniqueness.has(key)) return "Предмет и вид занятия не должны повторяться в плане";
      uniqueness.add(key);
      const subject = subjects.get(row.subjectId)!;
      const oldRow = old?.rows.find(entry => entry.id === row.id);
      if (subject.archived && oldRow?.subjectId !== subject.id)
        return "Проверьте архивные предметы и число часов по подгруппам";
      if (row.subgroupIdsByGroup !== undefined) {
        if (row.mode !== "subgroups" || !isRecord(row.subgroupIdsByGroup)) return "Проверьте выбранные подгруппы в плане";
        for (const [groupId, subgroupIds] of Object.entries(row.subgroupIdsByGroup)) {
          if (!groupIds.has(groupId) || !Array.isArray(subgroupIds) || !subgroupIds.length || subgroupIds.length > 100) return "Проверьте выбранные подгруппы в плане";
          const group = groups.get(groupId)!;
          const activeIds = new Set(catalog.subgroups.filter(s => s.groupId === groupId && !s.archived).map(s => s.id));
          const priorIds = new Set(oldRow?.subgroupIdsByGroup?.[groupId] ?? []);
          if (new Set(subgroupIds).size !== subgroupIds.length || subgroupIds.some(id => !isId(id) || (!activeIds.has(id) && !(group.archived && priorIds.has(id))))) return "В плане выбрана неизвестная подгруппа";
        }
      }
      if (row.mode === "subgroups") for (const groupId of groupIds) {
        const group = groups.get(groupId)!;
        const active = catalog.subgroups.filter(s => s.groupId === groupId && !s.archived);
        if (!active.length && !group.archived)
          return `У группы «${group.name}» нет активных подгрупп для строки плана`;
      }
    }
    if (rowCount > 25000) return "В плане слишком много строк";
  }
  return null;
}

export function projectCurricula(curricula: Curriculum[], currentPlans: StudyPlan[], catalog: Catalog): StudyPlan[] {
  const result = [...currentPlans];
  for (const curriculum of curricula) for (const groupId of curriculum.groupIds) {
    const prior = currentPlans.filter(plan => plan.groupId === groupId && plan.quarterId === curriculum.quarterId);
    const keys = new Set(curriculum.rows.map(row => JSON.stringify([row.subjectId, row.lessonKind])));
    for (const row of curriculum.rows) {
      const previous = prior.find(plan => plan.subjectId === row.subjectId && plan.lessonKind === row.lessonKind);
      const bySubgroup = new Map(previous?.assignments.filter(a => a.subgroupId).map(a => [a.subgroupId!, a]));
      const active = catalog.subgroups.filter(s => s.groupId === groupId && !s.archived).sort((a,b) => a.id.localeCompare(b.id));
      const groupArchived = catalog.groups.find(g => g.id === groupId)?.archived;
      const selectedIds = row.subgroupIdsByGroup?.[groupId];
      const participants: (string | null)[] = row.mode === "whole" ? [null] :
        active.length ? active.filter(s => !selectedIds || selectedIds.includes(s.id)).map(s => s.id) : groupArchived ? [...bySubgroup.keys()] : [];
      const assignments = participants.map((subgroupId, i) => {
        const old = subgroupId ? bySubgroup.get(subgroupId) : previous?.assignments[i];
        return { id: old?.id ?? crypto.randomUUID(), subgroupId, target: row.hours };
      });
      const plan: StudyPlan = { id: previous?.id ?? crypto.randomUUID(), quarterId: curriculum.quarterId, groupId, subjectId: row.subjectId, mode: row.mode, lessonKind: row.lessonKind, assignments };
      const index = result.findIndex(p => p.groupId === groupId && p.quarterId === curriculum.quarterId && p.subjectId === row.subjectId && p.lessonKind === row.lessonKind);
      if (index < 0) result.push(plan); else result[index] = plan;
    }
    for (let i = result.length - 1; i >= 0; i--) {
      const p = result[i]!;
      if (p.groupId === groupId && p.quarterId === curriculum.quarterId && !keys.has(JSON.stringify([p.subjectId, p.lessonKind]))) result.splice(i, 1);
    }
  }
  return result;
}

export function replacementGroups(next: Curriculum[], previous: Curriculum[], currentPlans: StudyPlan[]): string[] {
  const owners = new Map<string, Map<string, string>>();
  const newOwners = new Map<string, Map<string, string>>();
  const addOwners = (target: Map<string, Map<string, string>>, plans: Curriculum[]) => {
    for (const curriculum of plans) {
      let quarter = target.get(curriculum.quarterId);
      if (!quarter) target.set(curriculum.quarterId, quarter = new Map());
      for (const groupId of curriculum.groupIds) quarter.set(groupId, curriculum.id);
    }
  };
  addOwners(owners, previous); addOwners(newOwners, next);
  const populated = new Map<string, Set<string>>();
  for (const plan of currentPlans) {
    let quarter = populated.get(plan.quarterId);
    if (!quarter) populated.set(plan.quarterId, quarter = new Set());
    quarter.add(plan.groupId);
  }
  const replacing = new Set<string>();
  for (const [quarterId, groups] of newOwners) for (const [groupId, curriculumId] of groups)
    if (populated.get(quarterId)?.has(groupId) && owners.get(quarterId)?.get(groupId) !== curriculumId) replacing.add(groupId);
  return [...replacing].sort();
}

export function fromGroupPlan(name: string, groupId: string, quarterId: string, studyPlans: StudyPlan[], catalog: Catalog): Curriculum {
  const plans = studyPlans.filter(p => p.groupId === groupId && p.quarterId === quarterId);
  const rows = plans.map(p => {
    const row: CurriculumRow = { id: crypto.randomUUID(), subjectId: p.subjectId, lessonKind: p.lessonKind, mode: p.mode, hours: Math.max(...p.assignments.map(a => a.target)) };
    if (p.mode === "subgroups") {
      const active = catalog.subgroups.filter(subgroup => subgroup.groupId === groupId && !subgroup.archived).map(subgroup => subgroup.id);
      const assigned = p.assignments.map(assignment => assignment.subgroupId).filter((id): id is string => id !== null && active.includes(id));
      if (assigned.length > 0 && (assigned.length !== active.length || active.some(id => !assigned.includes(id)))) row.subgroupIdsByGroup = { [groupId]: assigned };
    }
    return row;
  });
  return { id: crypto.randomUUID(), name, quarterId, groupIds: [groupId], rows };
}
