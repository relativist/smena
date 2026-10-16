import { groups, subjects } from "../src/demo.ts";
import type {
  Catalog,
  CatalogRoom,
  CatalogSubject,
  CatalogSubgroup,
  CatalogTeacher,
} from "./catalog.ts";

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("ru")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "entry"
  );
}

export function teacherCatalogId(fullName: string): string {
  return `teacher:${slug(fullName)}`;
}

export function roomCatalogId(name: string): string {
  return `room:${slug(name)}`;
}

export function subgroupCatalogId(groupId: string, label: string): string {
  const suffix = label.split("/").at(-1) ?? label;
  return `subgroup:${groupId}:${slug(suffix)}`;
}

export function buildSeedCatalog(): Catalog {
  const teacherNames = new Set<string>();
  const teacherSubjects = new Map<string, Set<string>>();
  const roomNames = new Set<string>();
  const subgroupRows: CatalogSubgroup[] = [];
  for (const subject of subjects) {
    teacherNames.add(subject.fullTeacher);
    const subjectTeachers = [
      subject.fullTeacher,
      ...(subject.subgroups ?? []).map((entry) => entry.fullTeacher),
    ];
    for (const teacherName of subjectTeachers) {
      const id = teacherCatalogId(teacherName);
      const ids = teacherSubjects.get(id) ?? new Set<string>();
      ids.add(subject.id);
      teacherSubjects.set(id, ids);
    }
    roomNames.add(subject.room);
    for (const subgroup of subject.subgroups ?? []) {
      teacherNames.add(subgroup.fullTeacher);
      roomNames.add(subgroup.room);
      for (const group of groups) {
        const scopedName = subgroup.name.startsWith(`${group.name}/`)
          ? subgroup.name
          : subgroup.name.replace(/^5А(?=\/)/, group.name);
        if (
          !scopedName.startsWith(`${group.name}/`) ||
          subgroupRows.some(
            (entry) => entry.id === subgroupCatalogId(group.id, scopedName),
          )
        )
          continue;
        subgroupRows.push({
          id: subgroupCatalogId(group.id, scopedName),
          name: scopedName,
          groupId: group.id,
          students: Math.floor(group.students / 2),
          archived: false,
        });
      }
    }
  }
  for (const group of groups) {
    teacherNames.add(group.leader);
    roomNames.add(group.room);
  }
  const subjectRows: CatalogSubject[] = subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    shortName:
      (
        {
          Математика: "Матем.",
          "Русский язык": "Русс. яз.",
          Литература: "Литерат.",
          "Английский язык": "Англ. яз.",
          Информатика: "Информ.",
          Физкультура: "Физ-ра",
        } as Record<string, string>
      )[subject.name] ?? subject.name,
    color: subject.color,
    archived: false,
    roomKind:
      subject.id === "informatics"
        ? "informatics"
        : subject.id === "pe"
          ? "gym"
          : null,
    labRoomKind: subject.id === "physics" ? "physics-lab" : null,
    jointSameGrade: subject.id === "pe",
    maxJointGroups: 2,
  }));
  const teacherRows: CatalogTeacher[] = [...teacherNames].map((name) => ({
    id: teacherCatalogId(name),
    name,
    archived: false,
    subjectIds: [...(teacherSubjects.get(teacherCatalogId(name)) ?? [])],
    defaultRoomId: null,
    preferredGroupIds: [],
  }));
  const rooms: CatalogRoom[] = [...roomNames].map((name) => ({
    id: roomCatalogId(name),
    name,
    capacity: null,
    kind:
      name === "Спортзал"
        ? "gym"
        : name.startsWith("Комп.")
          ? "informatics"
          : "general",
    archived: false,
  }));
  return {
    subjects: subjectRows,
    teachers: teacherRows,
    rooms,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      students: group.students,
      leaderId: teacherCatalogId(group.leader),
      roomId: roomCatalogId(group.room),
      autoRoomIds: [roomCatalogId(group.room)],
      archived: false,
    })),
    subgroups: subgroupRows,
  };
}
