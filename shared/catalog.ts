import type { SubjectColor } from "./subjectColors.ts";
import type { SubjectIconId } from "./subjectIcons.ts";
import type { UnavailabilityRule } from "./unavailability.ts";
export type { SubjectColor } from "./subjectColors.ts";
export type RoomKind =
  | "general"
  | "informatics"
  | "physics-lab"
  | "chemistry-lab"
  | "gym"
  | "assembly"
  | "other";
export type CatalogEntry = { id: string; name: string; archived: boolean };
export type CatalogSubject = CatalogEntry & {
  shortName: string;
  color: SubjectColor;
  roomKind: RoomKind | null;
  labRoomKind: RoomKind | null;
  jointGroupSets?: string[][];
  jointSameGrade?: boolean;
  maxJointGroups?: number;
  /** `undefined`/`auto` uses the inferred icon; `null` hides it. */
  iconId?: SubjectIconId | "auto" | null;
};
export type CatalogTeacher = CatalogEntry & {
  subjectIds: string[];
  defaultRoomId: string | null;
  preferredGroupIds?: string[];
  preferredShift?: "morning" | "afternoon";
  unavailability?: UnavailabilityRule[];
};
export type CatalogRoom = CatalogEntry & {
  capacity: number | null;
  kind: RoomKind;
  unavailability?: UnavailabilityRule[];
};
export type CatalogGroup = CatalogEntry & {
  students: number;
  leaderId: string | null;
  roomId: string | null;
  autoRoomIds: string[];
};
export type CatalogSubgroup = CatalogEntry & {
  groupId: string;
  students: number;
};
export type Catalog = {
  subjects: CatalogSubject[];
  teachers: CatalogTeacher[];
  rooms: CatalogRoom[];
  groups: CatalogGroup[];
  subgroups: CatalogSubgroup[];
};
export type CatalogKind = keyof Catalog;
export const roomKinds: Record<RoomKind, string> = {
  general: "Обычный",
  informatics: "Информатика",
  "physics-lab": "Лаборатория физики",
  "chemistry-lab": "Лаборатория химии",
  gym: "Спортзал",
  assembly: "Актовый зал",
  other: "Другой",
};
export function teacherLabel(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function teacherInitials(fullName: string) {
  const [surname, ...names] = fullName.trim().split(/\s+/u);
  const initials = names.slice(0, 2).map(name => `${name[0].toLocaleUpperCase("ru")}.`).join("");
  return [surname, initials].filter(Boolean).join(" ");
}

/** Whether a subject may be scheduled jointly for all supplied groups. */
export function canShareSubject(
  subject: CatalogSubject | undefined,
  groupIds: string[],
  groups: CatalogGroup[],
): boolean {
  if (!subject || !groupIds.length) return false;
  const maxJointGroups = subject.maxJointGroups ?? 2;
  if (new Set(groupIds).size > maxJointGroups) return false;
  const byId = new Map(groups.map((group) => [group.id, group]));
  if (
    subject.jointGroupSets?.some((set) =>
      groupIds.every((groupId) => set.includes(groupId)),
    )
  ) return true;
  if (!subject.jointSameGrade) return false;
  const grades = groupIds.map((groupId) => {
    const group = byId.get(groupId);
    return group?.name.match(/^\s*(\d+)/)?.[1];
  });
  return grades.every((grade) => grade !== undefined && grade === grades[0]);
}
