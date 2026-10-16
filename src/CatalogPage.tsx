import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import InfoTooltip from "./InfoTooltip";
import SubjectIcon from "./SubjectIcon";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts";
import {
  roomKinds,
  type Catalog,
  type CatalogEntry,
  type CatalogGroup,
  type CatalogKind,
  type CatalogRoom,
  type CatalogSubject,
  type CatalogSubgroup,
  type CatalogTeacher,
  type RoomKind,
  type SubjectColor,
} from "../shared/catalog";
import { recommendSubjectColor, subjectColors } from "../shared/subjectColors";
import { GROUP_SEARCH_HELP, matchesGroupSearch } from "../shared/groupSearch";
import type { UnavailabilityRule } from "../shared/unavailability";
import AvailabilityDialog from "./AvailabilityDialog";
import type { TeacherReassignmentsContext } from "./TeacherReassignmentsPage";
import "./catalog.css";
import "./subject-colors.css";

type Props = {
  initialState: StateResponse;
  auth: AuthSession;
  onUnauthorized: () => void;
  onBack: () => Promise<void>;
  onOpenReassignments: (context: TeacherReassignmentsContext) => Promise<void>;
};
type Tab = CatalogKind;
type Draft = Record<string, string>;
type Pending = { catalog: Catalog; revision: number; requestId: string };
type SortState = { key: string; direction: "asc" | "desc" };
type AvailabilityTarget = { kind: "teacher" | "room"; entry: CatalogTeacher | CatalogRoom };
type AvailabilityBlockers = { blockers: string[] };
const tabs: { id: Tab; label: string }[] = [
  { id: "groups", label: "Группы" },
  { id: "subgroups", label: "Подгруппы" },
  { id: "teachers", label: "Учителя" },
  { id: "rooms", label: "Кабинеты" },
  { id: "subjects", label: "Предметы" },
];
const filterFields: Record<Tab, { key: string; label: string }[]> = {
  groups: [{ key: "name", label: "Название" }, { key: "leader", label: "Классный руководитель" }, { key: "room", label: "Кабинет" }],
  subgroups: [{ key: "name", label: "Название" }, { key: "group", label: "Группа" }],
  teachers: [{ key: "name", label: "ФИО" }, { key: "subjects", label: "Предметы" }, { key: "room", label: "Кабинет" }, { key: "preferredGroups", label: "Предпочтительные группы" }],
  rooms: [{ key: "name", label: "Название" }],
  subjects: [{ key: "name", label: "Название" }],
};
const filterColumns: Record<Tab, (string | null)[]> = {
  groups: ["name", null, "leader", "room"],
  subgroups: ["name", "group", null],
  teachers: ["name", "subjects", "room", "preferredGroups"],
  rooms: ["name", null, null],
  subjects: ["name", null, null, null, null],
};
const emptyCatalog = (): Catalog => ({
  groups: [],
  subgroups: [],
  teachers: [],
  rooms: [],
  subjects: [],
});
const newId = () => crypto.randomUUID();
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось сохранить изменения.";
const russianSort = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});

function CatalogActionIcon({ kind }: { kind: "edit" | "availability" | "archive" | "restore" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" {...common}>
      {kind === "edit" && <><path d="m14 5 5 5" /><path d="M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z" /><path d="M12 20h8" /></>}
      {kind === "availability" && <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /><path d="M8 2.8 6.5 4.3M16 2.8l1.5 1.5" /></>}
      {kind === "archive" && <><path d="M4 7h16v13H4z" /><path d="M3 4h18v3H3zM9 11h6" /></>}
      {kind === "restore" && <><path d="M4 7h16v13H4z" /><path d="M3 4h18v3H3z" /><path d="M12 16a4 4 0 1 1 3.7-5.5" /><path d="M16 8v3h-3" /></>}
    </svg>
  );
}

function blankDraft(tab: Tab): Draft {
  if (tab === "groups")
    return {
      name: "",
      students: "",
      leaderId: "",
      roomId: "",
      autoRoomIds: "[]",
    };
  if (tab === "subgroups") return { name: "", groupId: "", students: "" };
  if (tab === "rooms") return { name: "", capacity: "", kind: "general" };
  if (tab === "subjects")
    return {
      name: "",
      shortName: "",
      color: "blue",
      roomKind: "",
      labRoomKind: "",
      jointGroupSets: "[]",
      jointSameGrade: "false",
      maxJointGroups: "2",
    };
  if (tab === "teachers")
    return {
      name: "",
      subjectIds: "[]",
      defaultRoomId: "",
      preferredGroupIds: "[]",
      preferredShift: "",
    };
  return { name: "" };
}

function labelOf(catalog: Catalog, id: string | null | undefined) {
  if (!id) return "—";
  return (
    [...catalog.teachers, ...catalog.rooms, ...catalog.groups].find(
      (entry) => entry.id === id,
    )?.name ?? "Архивная запись"
  );
}

function makeEntry(
  tab: Tab,
  draft: Draft,
  original?: CatalogEntry,
): CatalogEntry {
  const base = {
    id: original?.id ?? newId(),
    name: draft.name.trim(),
    archived: original?.archived ?? false,
  };
  if (tab === "groups")
    return {
      ...base,
      students: Number(draft.students),
      leaderId: draft.leaderId || null,
      roomId: draft.roomId || null,
      autoRoomIds: JSON.parse(draft.autoRoomIds || "[]") as string[],
    } as CatalogGroup;
  if (tab === "subgroups")
    return {
      ...base,
      groupId: draft.groupId,
      students: Number(draft.students),
    } as CatalogSubgroup;
  if (tab === "rooms")
    return {
      ...base,
      capacity: draft.capacity ? Number(draft.capacity) : null,
      kind: draft.kind as RoomKind,
      unavailability: (original as CatalogRoom | undefined)?.unavailability,
    } as CatalogRoom;
  if (tab === "subjects")
    return {
      ...base,
      shortName: draft.shortName.trim(),
      iconId: (original as CatalogSubject | undefined)?.iconId,
      color: draft.color as SubjectColor,
      roomKind: (draft.roomKind || null) as RoomKind | null,
      labRoomKind: (draft.labRoomKind || null) as RoomKind | null,
      jointGroupSets: JSON.parse(draft.jointGroupSets || "[]") as string[][],
      jointSameGrade: draft.jointSameGrade === "true",
      maxJointGroups: Math.min(
        50,
        Math.max(2, Number(draft.maxJointGroups) || 2),
      ),
    } as CatalogSubject;
  if (tab === "teachers") {
    let subjectIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(draft.subjectIds || "[]");
      if (Array.isArray(parsed))
        subjectIds = [
          ...new Set(
            parsed.filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        ];
    } catch {
      subjectIds = [];
    }
    return {
      ...base,
      subjectIds,
      defaultRoomId: draft.defaultRoomId || null,
      preferredGroupIds: parseStringIds(draft.preferredGroupIds),
      ...(draft.preferredShift === "morning" || draft.preferredShift === "afternoon" ? { preferredShift: draft.preferredShift } : {}),
      unavailability: (original as CatalogTeacher | undefined)?.unavailability,
    } as CatalogTeacher;
  }
  return base as CatalogTeacher;
}

function draftOf(tab: Tab, entry?: CatalogEntry): Draft {
  if (!entry) return blankDraft(tab);
  if (tab === "groups") {
    const value = entry as CatalogGroup;
    return {
      name: value.name,
      students: String(value.students),
      leaderId: value.leaderId ?? "",
      roomId: value.roomId ?? "",
      autoRoomIds: JSON.stringify(value.autoRoomIds ?? []),
    };
  }
  if (tab === "subgroups") {
    const value = entry as CatalogSubgroup;
    return {
      name: value.name,
      groupId: value.groupId,
      students: String(value.students),
    };
  }
  if (tab === "rooms") {
    const value = entry as CatalogRoom;
    return {
      name: value.name,
      capacity: value.capacity == null ? "" : String(value.capacity),
      kind: value.kind,
    };
  }
  if (tab === "subjects") {
    const value = entry as CatalogSubject;
    return {
      name: value.name,
      shortName: value.shortName,
      color: value.color,
      roomKind: value.roomKind ?? "",
      labRoomKind: value.labRoomKind ?? "",
      jointGroupSets: JSON.stringify(
        (value as CatalogSubject & { jointGroupSets?: string[][] })
          .jointGroupSets ?? [],
      ),
      jointSameGrade: String(
        (value as CatalogSubject & { jointSameGrade?: boolean })
          .jointSameGrade ?? false,
      ),
      maxJointGroups: String(
        (value as CatalogSubject & { maxJointGroups?: number })
          .maxJointGroups ?? 2,
      ),
    };
  }
  if (tab === "teachers") {
    const value = entry as CatalogTeacher;
    return {
      name: entry.name,
      subjectIds: JSON.stringify(value.subjectIds ?? []),
      defaultRoomId:
        (value as CatalogTeacher & { defaultRoomId?: string | null })
          .defaultRoomId ?? "",
      preferredGroupIds: JSON.stringify(
        (value as CatalogTeacher & { preferredGroupIds?: string[] })
          .preferredGroupIds ?? [],
      ),
      preferredShift: value.preferredShift ?? "",
    };
  }
  return { name: entry.name };
}

function parseStringIds(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string"))]
      : [];
  } catch {
    return [];
  }
}

export default function CatalogPage({
  initialState,
  auth,
  onUnauthorized,
  onBack,
  onOpenReassignments,
}: Props) {
  const [state, setState] = useState(initialState);
  const [tab, setTab] = useState<Tab>("groups");
  const [showArchived, setShowArchived] = useState(false);
  const [onlyUnavailableTeachers, setOnlyUnavailableTeachers] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState>({
    key: "name",
    direction: "asc",
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preferredGroupSearch, setPreferredGroupSearch] = useState("");
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<CatalogEntry | null>(
    null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const [availabilityTarget, setAvailabilityTarget] = useState<AvailabilityTarget | null>(null);
  const [availabilityDirty, setAvailabilityDirty] = useState(false);
  const [deleteBlockers, setDeleteBlockers] = useState<Record<string, string[]>>({});
  const [blockersLoading, setBlockersLoading] = useState<string | null>(null);
  const editorDialog = useRef<HTMLDialogElement>(null);
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const archiveCancel = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const catalog = state.catalog ?? emptyCatalog();
  const preferredGroupIds = parseStringIds(draft?.preferredGroupIds);
  const preferredGroups = catalog.groups
    .filter((group) => !group.archived || preferredGroupIds.includes(group.id))
    .filter((group) => matchesGroupSearch(group.name, preferredGroupSearch))
    .sort((a, b) => russianSort.compare(a.name, b.name));
  const entries = catalog[tab] as CatalogEntry[];
  const filtered = useMemo(() => {
    const value = (
      entry: CatalogEntry,
      key: string,
    ): string | number | null => {
      if (key === "name") return entry.name;
      if (tab === "teachers" && key === "subjects") {
        const ids = (entry as CatalogTeacher).subjectIds ?? [];
        return ids
          .map(
            (id) =>
              catalog.subjects.find((subject) => subject.id === id)?.name ??
              "Архивный предмет",
          )
          .sort(russianSort.compare)
          .join(", ");
      }
      if (tab === "teachers" && key === "room")
        return labelOf(
          catalog,
          (entry as CatalogTeacher & { defaultRoomId?: string | null })
            .defaultRoomId,
        );
      if (tab === "teachers" && key === "preferredGroups")
        return ((entry as CatalogTeacher).preferredGroupIds ?? [])
          .map((id) => catalog.groups.find((group) => group.id === id)?.name ?? "")
          .filter(Boolean)
          .sort(russianSort.compare)
          .join(", ");
      if (tab === "groups") {
        const group = entry as CatalogGroup;
        if (key === "students") return group.students;
        if (key === "leader") return labelOf(catalog, group.leaderId);
        if (key === "room") return labelOf(catalog, group.roomId);
      }
      if (tab === "subgroups") {
        const subgroup = entry as CatalogSubgroup;
        if (key === "group")
          return (
            catalog.groups.find((item) => item.id === subgroup.groupId)?.name ??
            "Архивная запись"
          );
        if (key === "students") return subgroup.students;
      }
      if (tab === "subjects") {
        const subject = entry as CatalogSubject;
        if (key === "shortName") return subject.shortName;
        if (key === "roomKind")
          return subject.roomKind ? roomKinds[subject.roomKind] : "Общий";
        if (key === "labRoomKind")
          return subject.labRoomKind
            ? roomKinds[subject.labRoomKind]
            : "Как обычно";
        if (key === "color")
          return (
            subjectColors.find(({ id }) => id === subject.color)?.name ??
            subject.color
          );
      }
      if (tab === "rooms") {
        const room = entry as CatalogRoom;
        if (key === "kind") return roomKinds[room.kind];
        if (key === "capacity") return room.capacity;
      }
      return "";
    };
    const visible = entries.filter((entry) => entry.archived === showArchived &&
      !(tab === "teachers" && onlyUnavailableTeachers && !((entry as CatalogTeacher).unavailability?.length)) &&
      filterFields[tab].every(({ key }) => {
        const query = filters[key] ?? "";
        const needle = query.trim().toLocaleLowerCase("ru");
        if (!needle) return true;
        if (tab === "groups" && key === "name")
          return matchesGroupSearch(entry.name, query);
        if (tab === "subgroups" && key === "name")
          return matchesGroupSearch(entry.name, query);
        if (tab === "subgroups" && key === "group") {
          const subgroup = entry as CatalogSubgroup;
          const parentName = catalog.groups.find((group) => group.id === subgroup.groupId)?.name ?? "";
          return matchesGroupSearch(parentName, query);
        }
        if (tab === "teachers" && key === "preferredGroups") {
          const teacher = entry as CatalogTeacher;
          return (teacher.preferredGroupIds ?? []).some((id) => {
            const groupName = catalog.groups.find((group) => group.id === id)?.name;
            return groupName ? matchesGroupSearch(groupName, query) : false;
          });
        }
        const candidate = key === "name" ? entry.name : value(entry, key);
        return String(candidate ?? "").toLocaleLowerCase("ru").includes(needle);
      }));
    return visible.sort((a, b) => {
      const left = value(a, sort.key);
      const right = value(b, sort.key);
      // Empty capacities remain at the bottom in either direction.
      if (left == null || right == null)
        return left == null ? (right == null ? 0 : 1) : -1;
      const compared =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : russianSort.compare(String(left), String(right));
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [entries, filters, filterFields, showArchived, onlyUnavailableTeachers, sort, tab, catalog]);
  function sortHeader(key: string, label: string) {
    const active = sort.key === key;
    return (
      <th
        key={key}
        aria-sort={
          active
            ? sort.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button
          className="catalog-sort"
          type="button"
          onClick={() =>
            setSort((current) => ({
              key,
              direction:
                current.key === key && current.direction === "asc"
                  ? "desc"
                  : "asc",
            }))
          }
        >
          {label}
          <span aria-hidden="true">
            {active ? (sort.direction === "asc" ? " ↑" : " ↓") : " ↕"}
          </span>
        </button>
      </th>
    );
  }
  const subgroupCount = draft?.groupId
    ? catalog.subgroups
        .filter(
          (item) =>
            !item.archived &&
            item.groupId === draft.groupId &&
            item.id !== editing?.id,
        )
        .reduce((sum, item) => sum + item.students, 0)
    : 0;
  const subgroupOverflow =
    tab === "subgroups" &&
    draft &&
    draft.groupId &&
    Number(draft.students) + subgroupCount >
      (catalog.groups.find((group) => group.id === draft.groupId)?.students ??
        0);
  const groupSubgroupStudents =
    editing && tab === "groups"
      ? catalog.subgroups
          .filter((item) => !item.archived && item.groupId === editing.id)
          .reduce((sum, item) => sum + item.students, 0)
      : 0;
  const groupSubgroupOverflow =
    tab === "groups" &&
    draft !== null &&
    Number(draft.students) < groupSubgroupStudents;
  useEffect(() => {
    const dialog = editorDialog.current;
    if (!dialog) return;
    if (draft && !dialog.open) {
      dialog.showModal();
      const input = nameInput.current;
      input?.focus();
      if (editing && input) {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
    if (!draft && dialog.open) dialog.close();
  }, [draft]);

  useEffect(() => {
    const dialog = archiveDialog.current;
    if (!dialog) return;
    if (confirmArchive && !dialog.open) {
      dialog.showModal();
      archiveCancel.current?.focus();
    }
    if (!confirmArchive && dialog.open) dialog.close();
  }, [confirmArchive]);

  useEffect(() => {
    if (!draft && !pending && !availabilityDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, pending, availabilityDirty]);

  async function persist(nextCatalog: Catalog, request?: Pending): Promise<boolean> {
    if (busy) return false;
    // An uncertain write must always be retried byte-for-byte before any new write.
    const operation = pending ??
      request ?? {
        catalog: nextCatalog,
        revision: state.revision,
        requestId: newId(),
      };
    setPending(operation);
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const next = await api<StateResponse>("/api/catalog?response=compact", {
        method: "PUT",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify(operation),
      });
      setState(next);
      setPending(null);
      setDraft(null);
      setEditing(null);
      setConfirmArchive(null);
      return true;
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        (reason.status === 401 || reason.status === 403)
      )
        onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409)
        setConflict(true);
      // A definite client rejection cannot have committed this write. Let the
      // administrator correct validation errors without replaying stale data.
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        ![401, 403, 409].includes(reason.status)
      ) {
        setPending(null);
      }
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveAvailability(rules: UnavailabilityRule[]) {
    if (!availabilityTarget || pending) return false;
    const { kind, entry } = availabilityTarget;
    const key = kind === "teacher" ? "teachers" : "rooms";
    const next = {
      ...catalog,
      [key]: catalog[key].map((item) =>
        item.id === entry.id ? { ...item, unavailability: rules } : item,
      ),
    } as Catalog;
    const saved = await persist(next);
    if (saved) {
      setAvailabilityTarget(null);
      setAvailabilityDirty(false);
    }
    return saved;
  }

  async function openTeacherReassignments(teacherId: string, rule: UnavailabilityRule, mode: "absence") {
    setBusy(true);
    setError("");
    try {
      await onOpenReassignments({ teacherId, ruleId: rule.id, mode });
      setAvailabilityTarget(null);
      setAvailabilityDirty(false);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  function openEditor(entry?: CatalogEntry) {
    if (busy || pending) return;
    setPreferredGroupSearch("");
    setEditing(entry ?? null);
    const nextDraft = draftOf(tab, entry);
    if (tab === "subjects" && !entry)
      nextDraft.color = recommendSubjectColor(catalog.subjects);
    setDraft(nextDraft);
    setError("");
    if (entry?.archived) void loadDeleteBlockers(entry);
  }

  function blockerKey(entry: CatalogEntry) { return `${tab}:${entry.id}`; }

  async function loadDeleteBlockers(entry: CatalogEntry) {
    const key = blockerKey(entry);
    if (deleteBlockers[key] || blockersLoading === key) return;
    setBlockersLoading(key);
    try {
      const result = await api<AvailabilityBlockers>(`/api/catalog/blockers?kind=${encodeURIComponent(tab)}&id=${encodeURIComponent(entry.id)}`);
      setDeleteBlockers((current) => ({ ...current, [key]: result.blockers }));
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      setDeleteBlockers((current) => ({ ...current, [key]: [message(reason)] }));
    } finally {
      setBlockersLoading((current) => current === key ? null : current);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Укажите название.");
      return;
    }
    const duplicate = entries.some(
      (entry) =>
        entry.id !== editing?.id &&
        !entry.archived &&
        entry.name.trim().toLocaleLowerCase("ru") ===
          name.toLocaleLowerCase("ru") &&
        (tab !== "subgroups" ||
          (entry as CatalogSubgroup).groupId === draft.groupId),
    );
    if (duplicate) {
      setError("Запись с таким названием уже существует.");
      return;
    }
    if (
      (tab === "groups" || tab === "subgroups") &&
      (!Number.isInteger(Number(draft.students)) || Number(draft.students) < 0)
    ) {
      setError("Количество учеников должно быть целым числом не меньше нуля.");
      return;
    }
    if (groupSubgroupOverflow) {
      setError(
        "Количество учеников не может быть меньше суммы активных подгрупп.",
      );
      return;
    }
    if (tab === "subjects" && !draft.shortName.trim()) {
      setError("Укажите короткое название предмета.");
      return;
    }
    if (
      tab === "subjects" &&
      draft.jointSameGrade === "true" &&
      (!Number.isInteger(Number(draft.maxJointGroups)) ||
        Number(draft.maxJointGroups) < 2 ||
        Number(draft.maxJointGroups) > 50)
    ) {
      setError("Укажите от 2 до 50 групп в одном совместном уроке.");
      return;
    }
    if (pending) {
      setError("Сначала повторите проверку предыдущего сохранения.");
      return;
    }
    if (tab === "subgroups" && (!draft.groupId || subgroupOverflow)) {
      setError(
        subgroupOverflow
          ? "В подгруппах учеников больше, чем во всей группе."
          : "Выберите группу.",
      );
      return;
    }
    if (
      tab === "rooms" &&
      draft.capacity &&
      (!Number.isInteger(Number(draft.capacity)) || Number(draft.capacity) < 1)
    ) {
      setError("Вместимость должна быть целым числом больше нуля.");
      return;
    }
    const value = makeEntry(tab, draft, editing ?? undefined);
    const next = {
      ...catalog,
      [tab]: editing
        ? entries.map((entry) => (entry.id === editing.id ? value : entry))
        : [...entries, value],
    } as Catalog;
    await persist(next);
  }

  async function toggleArchive(entry: CatalogEntry, archived: boolean) {
    if (pending) {
      await retry();
      return;
    }
    if (
      tab === "groups" &&
      archived &&
      catalog.groups.filter((group) => !group.archived).length <= 1
    ) {
      setError("Нельзя архивировать последнюю активную группу.");
      setConfirmArchive(null);
      return;
    }
    const next = {
      ...catalog,
      [tab]: entries.map((item) =>
        item.id === entry.id ? { ...item, archived } : item,
      ),
    } as Catalog;
    await persist(next);
  }

  function deletionReasons(entry: CatalogEntry): string[] | undefined {
    return deleteBlockers[blockerKey(entry)];
  }

  async function deleteEntry(entry: CatalogEntry) {
    if (busy || pending) return;
    const reasons = deletionReasons(entry);
    if (reasons === undefined) {
      await loadDeleteBlockers(entry);
      return;
    }
    if (reasons.length) {
      setError(`Нельзя удалить запись: ${reasons.join("; ")}`);
      return;
    }
    if (!window.confirm(`Удалить «${entry.name}» навсегда? Восстановить запись после удаления нельзя.`)) return;
    await persist({ ...catalog, [tab]: entries.filter(item => item.id !== entry.id) } as Catalog);
  }

  function deleteAction(entry: CatalogEntry) {
    const reasons = deletionReasons(entry);
    const loading = blockersLoading === blockerKey(entry) || reasons === undefined;
    return <span className="catalog-delete-action">
      <button className="catalog-danger" type="button" disabled={busy || Boolean(pending) || loading || Boolean(reasons?.length)} onClick={() => void deleteEntry(entry)}><ActionLabel action="delete">{loading ? "Проверяем…" : "Удалить"}</ActionLabel></button>
      <InfoTooltip label="Удаление записи">{loading ? "Проверяем ссылки на запись…" : reasons?.length ? `Удаление недоступно: ${reasons.join("; ")}.` : "Ссылок на запись нет. Можно удалить её навсегда."}</InfoTooltip>
    </span>;
  }

  async function reloadLatest() {
    if (
      !window.confirm("Перезагрузить справочники? Текущая форма будет закрыта.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      const next = await api<StateResponse>("/api/admin/state?view=catalog");
      setState(next);
      setDeleteBlockers({});
      setPending(null);
      setDraft(null);
      setEditing(null);
      setConfirmArchive(null);
      setConflict(false);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized();
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (pending) {
      const wasAvailability = Boolean(availabilityTarget);
      const saved = await persist(pending.catalog, pending);
      if (saved && wasAvailability) {
        setAvailabilityTarget(null);
        setAvailabilityDirty(false);
      }
    }
  }

  async function back() {
    if (busy || pending) return;
    if ((draft || availabilityDirty) && !window.confirm("Закрыть форму без сохранения?")) return;
    setBackBusy(true);
    try {
      await onBack();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBackBusy(false);
    }
  }

  return (
    <main className="catalog-page">
      <AdminPageHeader title="Справочники" onBack={() => void back()} disabled={busy || Boolean(pending)} busy={backBusy} />
      <section className="catalog-body">
        <div className="catalog-toolbar">
          <nav className="catalog-tabs" aria-label="Справочники">
            {tabs.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={busy || Boolean(pending)}
                className={tab === item.id ? "selected" : ""}
                onClick={() => {
                  if (busy || pending) return;
                  setTab(item.id);
                  setFilters({});
                  setError("");
                  setDraft(null);
                  setEditing(null);
                }}
              >
                {item.label}
                <small>
                  {catalog[item.id].filter((entry) => !entry.archived).length}
                </small>
              </button>
            ))}
          </nav>
          <div className="catalog-controls">
            <label className="catalog-archived">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                disabled={Boolean(pending)}
              />{" "}
              Архив
            </label>
            {tab === "teachers" && (
              <label className="catalog-archived">
                <input
                  type="checkbox"
                  checked={onlyUnavailableTeachers}
                  onChange={(event) => setOnlyUnavailableTeachers(event.target.checked)}
                  disabled={Boolean(pending)}
                />{" "}
                Есть недоступность
              </label>
            )}
            <button
              className="catalog-primary"
              type="button"
              onClick={() => openEditor()}
              disabled={busy || Boolean(pending)}
            >
              <ActionLabel action="add">Добавить</ActionLabel>
            </button>
          </div>
        </div>
        {error && !draft && (
          <div
            className={`catalog-alert ${conflict ? "conflict" : ""}`}
            role="alert"
          >
            <span>{error}</span>
            {pending ? (
              <button
                type="button"
                onClick={() => void retry()}
                disabled={busy}
              >
                Повторить сохранение
              </button>
            ) : null}
            {conflict && (
              <button
                type="button"
                onClick={() => void reloadLatest()}
                disabled={busy}
              >
                Загрузить актуальные данные
              </button>
            )}
          </div>
        )}
        <div className="catalog-table-wrap">
          <table className={`catalog-table catalog-table-${tab}`}>
            <thead>
              <tr>
                <th scope="col" className="catalog-row-number-heading" aria-label="Номер">№</th>
                {sortHeader(
                  "name",
                  tab === "teachers" ? "ФИО" : "Название",
                )}
                {tab === "groups" && (
                  <>
                    {sortHeader("students", "Ученики")}
                    {sortHeader("leader", "Классный руководитель")}
                    {sortHeader("room", "Кабинет")}
                  </>
                )}
                {tab === "teachers" && (
                  <>
                    {sortHeader("subjects", "Предметы")}
                    {sortHeader("room", "Кабинет по умолчанию")}
                    {sortHeader("preferredGroups", "Предпочтительные группы")}
                  </>
                )}
                {tab === "subgroups" && (
                  <>
                    {sortHeader("group", "Группа")}
                    {sortHeader("students", "Ученики")}
                  </>
                )}
                {tab === "subjects" && (
                  <>
                    {sortHeader("shortName", "Короткое название")}
                    {sortHeader("roomKind", "Обычные уроки")}
                    {sortHeader("labRoomKind", "Лабораторные")}
                    {sortHeader("color", "Цвет")}
                  </>
                )}
                {tab === "rooms" && (
                  <>
                    {sortHeader("kind", "Тип")}
                    {sortHeader("capacity", "Вместимость")}
                  </>
                )}
                <th className="actions-heading">Действия</th>
              </tr>
              <tr className="catalog-filter-row">
                <th aria-hidden="true" />
                {filterColumns[tab].map((key, index) => {
                  const field = filterFields[tab].find((item) => item.key === key);
                  return (
                    <th key={key ?? `empty-${index}`}>
                      {field ? (
                        <div className="catalog-filter-control">
                          <input
                            type="search"
                            className={key === "group" || key === "preferredGroups" || (key === "name" && (tab === "groups" || tab === "subgroups")) ? "school-code" : undefined}
                            aria-label={`Фильтр: ${field.label}`}
                            placeholder={field.label}
                            value={filters[field.key] ?? ""}
                            onChange={(event) => setFilters((current) => ({ ...current, [field.key]: event.target.value }))}
                            disabled={Boolean(pending)}
                          />
                          {((tab === "groups" && key === "name") ||
                            (tab === "subgroups" && (key === "name" || key === "group")) ||
                            (tab === "teachers" && key === "preferredGroups")) &&
                            <InfoTooltip label="Поиск групп">{tab === "subgroups" && key === "name" ? "Обычный поиск — по части названия. Добавьте ! для поиска полного названия подгруппы, например !Немецкий 5А. Регистр не учитывается." : GROUP_SEARCH_HELP}</InfoTooltip>}
                        </div>
                      ) : null}
                    </th>
                  );
                })}
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry, index) => (
                <tr
                  key={entry.id}
                  className={entry.archived ? "archived-row" : ""}
                >
                  <td className="catalog-row-number" aria-label={`Запись ${index + 1}`}>{index + 1}</td>
                  <td>
                    <strong className={tab === "subjects" ? "catalog-subject-name" : tab === "groups" || tab === "subgroups" ? "school-code" : undefined}>{tab === "subjects" && <SubjectIcon subject={entry as CatalogSubject} />}<span>{entry.name}</span></strong>
                    {tab === "teachers" && (entry as CatalogTeacher).preferredShift && <small className="catalog-shift-preference">Предпочтение: {(entry as CatalogTeacher).preferredShift === "morning" ? "1-я смена" : "2-я смена"}</small>}
                  </td>
                  {tab === "teachers" && (
                    <>
                      <td>
                        {((entry as CatalogTeacher).subjectIds ?? [])
                          .map(
                            (id) =>
                              catalog.subjects.find(
                                (subject) => subject.id === id,
                              )?.name ?? "Архивный предмет",
                          )
                          .sort(russianSort.compare)
                          .join(", ") || "—"}
                      </td>
                      <td>
                        {labelOf(
                          catalog,
                          (
                            entry as CatalogTeacher & {
                              defaultRoomId?: string | null;
                            }
                          ).defaultRoomId,
                        )}
                      </td>
                      <td className="school-code">{((entry as CatalogTeacher).preferredGroupIds ?? [])
                        .map((id) => catalog.groups.find((group) => group.id === id)?.name)
                        .filter((name): name is string => Boolean(name))
                        .sort(russianSort.compare)
                        .join(", ") || "—"}</td>
                    </>
                  )}
                  {tab === "groups" && (
                    <>
                      <td>{(entry as CatalogGroup).students}</td>
                      <td>
                        {labelOf(catalog, (entry as CatalogGroup).leaderId)}
                      </td>
                      <td>
                        {labelOf(catalog, (entry as CatalogGroup).roomId)}
                      </td>
                    </>
                  )}
                  {tab === "subgroups" && (
                    <>
                      <td className="school-code">
                        {labelOf(
                          catalog,
                          catalog.groups.find(
                            (group) =>
                              group.id === (entry as CatalogSubgroup).groupId,
                          )?.id,
                        )}
                      </td>
                      <td>{(entry as CatalogSubgroup).students}</td>
                    </>
                  )}
                  {tab === "subjects" && (
                    <>
                      <td>{(entry as CatalogSubject).shortName}</td>
                      <td>
                        {(entry as CatalogSubject).roomKind
                          ? roomKinds[(entry as CatalogSubject).roomKind!]
                          : "Общий"}
                      </td>
                      <td>
                        {(entry as CatalogSubject).labRoomKind
                          ? roomKinds[(entry as CatalogSubject).labRoomKind!]
                          : "Как обычно"}
                      </td>
                      <td className="catalog-color-cell">
                        <span
                          className={`catalog-color ${(entry as CatalogSubject).color}`}
                        />
                        {subjectColors.find(
                          ({ id }) => id === (entry as CatalogSubject).color,
                        )?.name ?? (entry as CatalogSubject).color}
                      </td>
                    </>
                  )}
                  {tab === "rooms" && (
                    <>
                      <td>{roomKinds[(entry as CatalogRoom).kind]}</td>
                      <td>{(entry as CatalogRoom).capacity ?? "—"}</td>
                    </>
                  )}
                  <td className="catalog-actions">
                    <button
                      className="catalog-icon-action"
                      type="button"
                      aria-label={`Изменить: ${entry.name}`}
                      title="Изменить"
                      onClick={() => openEditor(entry)}
                      disabled={Boolean(pending)}
                    >
                      <CatalogActionIcon kind="edit" />
                    </button>
                    {(tab === "teachers" || tab === "rooms") && (
                      <button
                        className="catalog-icon-action"
                        type="button"
                        aria-label={`Недоступность: ${entry.name}`}
                        title="Недоступность"
                        onClick={() => {
                          setAvailabilityTarget({
                            kind: tab === "teachers" ? "teacher" : "room",
                            entry: entry as CatalogTeacher | CatalogRoom,
                          });
                          setAvailabilityDirty(false);
                        }}
                        disabled={Boolean(pending)}
                      >
                        <CatalogActionIcon kind="availability" />
                      </button>
                    )}
                    <button
                      className={`catalog-icon-action ${entry.archived ? "restore" : "archive"}`}
                      type="button"
                      aria-label={`${entry.archived ? "Восстановить" : "В архив"}: ${entry.name}`}
                      title={entry.archived ? "Восстановить" : "В архив"}
                      onClick={() =>
                        entry.archived
                          ? void toggleArchive(entry, false)
                          : (void loadDeleteBlockers(entry), setConfirmArchive(entry))
                      }
                      disabled={Boolean(pending)}
                    >
                      <CatalogActionIcon kind={entry.archived ? "restore" : "archive"} />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="catalog-empty">
                    {filterFields[tab].some(({ key }) => filters[key]?.trim())
                      ? "Ничего не найдено."
                      : showArchived
                        ? "Архив пуст."
                        : "Записей пока нет."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {tab === "subgroups" && (
          <p className="catalog-footnote">
            Подгруппы задаются внутри группы. Сумма учеников подгрупп не должна
            превышать размер группы.
          </p>
        )}
      </section>

      <dialog
        ref={editorDialog}
        className={`catalog-dialog${tab === "teachers" ? " catalog-teacher-dialog" : ""}`}
        aria-labelledby="catalog-dialog-title"
        onCancel={(event) => {
          if (busy || pending) {
            event.preventDefault();
            return;
          }
          setDraft(null);
          setEditing(null);
          setError("");
        }}
      >
        {draft && (
          <>
            <header>
              <h2 id="catalog-dialog-title">
                {editing ? "Изменить запись" : "Новая запись"}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                  setError("");
                }}
                disabled={busy || Boolean(pending)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </header>
            <form onSubmit={(event) => void submit(event)}>
              <fieldset
                className="catalog-fields"
                disabled={busy || Boolean(pending)}
              >
                <label className={tab === "teachers" ? "catalog-teacher-field-row" : undefined}>
                  <span>{tab === "teachers" ? "Фамилия, имя и отчество" : "Название"}</span>
                  <input
                    ref={nameInput}
                    className={tab === "groups" || tab === "subgroups" ? "school-code" : undefined}
                    maxLength={tab === "teachers" ? 160 : undefined}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                    placeholder={
                      tab === "teachers"
                        ? "Иванова Мария Петровна"
                        : tab === "groups"
                          ? "5А"
                          : "Название"
                    }
                    required
                  />
                </label>
                {tab === "groups" && (
                  <>
                    <label>
                      Количество учеников
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={draft.students}
                        onChange={(event) =>
                          setDraft({ ...draft, students: event.target.value })
                        }
                        required
                      />
                      {groupSubgroupOverflow && (
                        <span className="catalog-validation">
                          В активных подгруппах {groupSubgroupStudents}{" "}
                          учеников. Размер группы не может быть меньше.
                        </span>
                      )}
                    </label>
                    <div className="catalog-form-grid">
                      <label>
                        Классный руководитель
                        <select
                          value={draft.leaderId}
                          onChange={(event) =>
                            setDraft({ ...draft, leaderId: event.target.value })
                          }
                        >
                          <option value="">Не назначен</option>
                          {catalog.teachers
                            .filter(
                              (teacher) =>
                                !teacher.archived ||
                                teacher.id === draft.leaderId,
                            )
                            .sort((a, b) => russianSort.compare(a.name, b.name))
                            .map((teacher) => (
                              <option key={teacher.id} value={teacher.id}>
                                {teacher.name}
                                {teacher.archived ? " · архив" : ""}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Основной кабинет
                        <select
                          value={draft.roomId}
                          onChange={(event) =>
                            setDraft({ ...draft, roomId: event.target.value })
                          }
                        >
                          <option value="">Не задан</option>
                          {catalog.rooms
                            .filter(
                              (room) =>
                                !room.archived || room.id === draft.roomId,
                            )
                            .sort((a, b) => russianSort.compare(a.name, b.name))
                            .map((room) => (
                              <option key={room.id} value={room.id}>
                                {room.name}
                                {room.archived ? " · архив" : ""}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <fieldset className="catalog-room-pool">
                      <legend>Предпочтительные кабинеты</legend>
                      <p>
                        Сначала используется кабинет учителя, затем основной
                        кабинет группы, отмеченные здесь и остальные подходящие
                        свободные кабинеты. Можно отметить 2–4 ближайших
                        кабинета и специализированные помещения; лимита нет.
                      </p>
                      <div>
                        {catalog.rooms
                          .filter(
                            (room) =>
                              !room.archived ||
                              (
                                JSON.parse(
                                  draft.autoRoomIds || "[]",
                                ) as string[]
                              ).includes(room.id),
                          )
                          .sort((a, b) => russianSort.compare(a.name, b.name))
                          .map((room) => {
                            const ids = JSON.parse(
                              draft.autoRoomIds || "[]",
                            ) as string[];
                            return (
                              <label key={room.id}>
                                <input
                                  type="checkbox"
                                  checked={ids.includes(room.id)}
                                  disabled={room.archived}
                                  onChange={(event) =>
                                    setDraft({
                                      ...draft,
                                      autoRoomIds: JSON.stringify(
                                        event.target.checked
                                          ? [...ids, room.id]
                                          : ids.filter((id) => id !== room.id),
                                      ),
                                    })
                                  }
                                />
                                <span>
                                  {room.name}
                                  {room.archived ? " · архив" : ""}
                                </span>
                              </label>
                            );
                          })}
                        {!catalog.rooms.some((room) => !room.archived) && (
                          <span className="catalog-muted">
                            Сначала добавьте кабинеты.
                          </span>
                        )}
                      </div>
                    </fieldset>
                  </>
                )}
                {tab === "teachers" && (
                  <>
                    <div className="catalog-teacher-details">
                      <div className="catalog-teacher-field-row">
                        <span className="catalog-teacher-field-label">
                          <label htmlFor="catalog-teacher-room">Кабинет по умолчанию</label>
                          <InfoTooltip label="Кабинет по умолчанию">Имеет первый приоритет при ручном добавлении и автосоставлении, если подходит и свободен. Кабинет урока можно выбрать вручную.</InfoTooltip>
                        </span>
                        <select
                          id="catalog-teacher-room"
                          value={draft.defaultRoomId ?? ""}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              defaultRoomId: event.target.value,
                            })
                          }
                        >
                          <option value="">Не задан</option>
                          {catalog.rooms
                            .filter(
                              (room) =>
                                !room.archived || room.id === draft.defaultRoomId,
                            )
                            .sort((a, b) => russianSort.compare(a.name, b.name))
                            .map((room) => (
                              <option key={room.id} value={room.id}>
                                {room.name}
                                {room.archived ? " · архив" : ""}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div className="catalog-teacher-field-row">
                        <span className="catalog-teacher-field-label">
                          <label htmlFor="catalog-teacher-shift">Предпочтительная смена</label>
                          <InfoTooltip label="Предпочтительная смена">Автосоставление предпочитает выбранную смену. Занятия в обеих сменах допустимы.</InfoTooltip>
                        </span>
                        <select id="catalog-teacher-shift" value={draft.preferredShift ?? ""} onChange={event => setDraft({ ...draft, preferredShift: event.target.value })}>
                          <option value="">Без предпочтения</option>
                          <option value="morning">Первая смена</option>
                          <option value="afternoon">Вторая смена</option>
                        </select>
                      </div>
                    </div>
                    <div className="catalog-teacher-options">
                      <fieldset className="catalog-teacher-subjects">
                        <legend><span className="catalog-teacher-legend">Специальности <InfoTooltip label="Специальности">Выберите предметы, чтобы преподаватель появился в расписании.</InfoTooltip></span></legend>
                        <div className="catalog-teacher-specialty-list">
                          {catalog.subjects
                            .filter(
                              (subject) =>
                                !subject.archived ||
                                JSON.parse(draft.subjectIds || "[]").includes(
                                  subject.id,
                                ),
                            )
                            .sort((a, b) => russianSort.compare(a.name, b.name))
                            .map((subject) => {
                              const selected = (
                                JSON.parse(draft.subjectIds || "[]") as string[]
                              ).includes(subject.id);
                              return (
                                <label
                                  key={subject.id}
                                  className={
                                    subject.archived ? "archived-specialty" : ""
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    disabled={subject.archived}
                                    onChange={(event) => {
                                      const ids = JSON.parse(
                                        draft.subjectIds || "[]",
                                      ) as string[];
                                      setDraft({
                                        ...draft,
                                        subjectIds: JSON.stringify(
                                          event.target.checked
                                            ? [...ids, subject.id]
                                            : ids.filter(
                                                (id) => id !== subject.id,
                                              ),
                                        ),
                                      });
                                    }}
                                  />
                                  <span>
                                    {subject.name}
                                    {subject.archived ? " · архив" : ""}
                                  </span>
                                </label>
                              );
                            })}
                          {!catalog.subjects.some(
                            (subject) => !subject.archived,
                          ) && (
                            <span className="catalog-muted">
                              Сначала добавьте предметы в справочник.
                            </span>
                          )}
                        </div>
                      </fieldset>
                      <fieldset className="catalog-teacher-preferred-groups">
                        <legend><span className="catalog-teacher-legend">Предпочтительные группы <InfoTooltip label="Предпочтительные группы">Автосоставление предпочитает этого учителя для выбранных групп, если он свободен.</InfoTooltip></span></legend>
                        <div className="catalog-preferred-group-search">
                          <div className="catalog-preferred-group-search-label">
                            <label htmlFor="catalog-preferred-group-search">Поиск групп</label>
                            <InfoTooltip label="Поиск групп">{GROUP_SEARCH_HELP}</InfoTooltip>
                          </div>
                          <input id="catalog-preferred-group-search" type="search" placeholder="Название группы" value={preferredGroupSearch} onChange={(event) => setPreferredGroupSearch(event.target.value)} />
                        </div>
                        <p className="catalog-preferred-group-count" aria-live="polite">Выбрано: {preferredGroupIds.length}</p>
                        <div className="catalog-preferred-group-list">
                          {preferredGroups.map((group) => {
                            const selected = preferredGroupIds.includes(group.id);
                            return (
                              <label
                                key={group.id}
                                className={group.archived ? "archived-specialty" : ""}
                              >
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  disabled={group.archived}
                                  onChange={(event) => {
                                    const ids = parseStringIds(draft.preferredGroupIds);
                                    setDraft({
                                      ...draft,
                                      preferredGroupIds: JSON.stringify(
                                        event.target.checked
                                          ? [...ids, group.id]
                                          : ids.filter((id) => id !== group.id),
                                      ),
                                    });
                                  }}
                                />
                                <span className="school-code">
                                  {group.name}
                                  {group.archived ? " · архив" : ""}
                                </span>
                              </label>
                            );
                          })}
                          {!preferredGroups.length && (
                            <span className="catalog-muted">
                              {preferredGroupSearch.trim() ? "Группы не найдены." : "Сначала добавьте группы."}
                            </span>
                          )}
                        </div>
                      </fieldset>
                    </div>
                  </>
                )}
                {tab === "subgroups" && (
                  <>
                    <label>
                      Родительская группа
                      <select
                        className="school-code"
                        value={draft.groupId}
                        onChange={(event) =>
                          setDraft({ ...draft, groupId: event.target.value })
                        }
                        disabled={Boolean(editing) || Boolean(pending)}
                        required
                      >
                        <option value="">Выберите группу</option>
                        {catalog.groups
                          .filter(
                            (group) =>
                              !group.archived || group.id === draft.groupId,
                          )
                          .sort((a, b) => russianSort.compare(a.name, b.name))
                          .map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                              {group.archived ? " · архив" : ""}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Количество учеников
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={draft.students}
                        onChange={(event) =>
                          setDraft({ ...draft, students: event.target.value })
                        }
                        required
                      />
                    </label>
                    {subgroupOverflow && (
                      <p className="catalog-validation">
                        В подгруппах уже {subgroupCount} учеников, в группе
                        меньше мест.
                      </p>
                    )}
                  </>
                )}
                {tab === "subjects" && (
                  <div className="catalog-subject-form">
                    <label>
                      Короткое название
                      <input
                        maxLength={40}
                        value={draft.shortName}
                        onChange={(event) =>
                          setDraft({ ...draft, shortName: event.target.value })
                        }
                        required
                      />
                    </label>
                    <div className="catalog-form-grid">
                      <label>
                        Кабинет для обычных уроков
                        <select
                          value={draft.roomKind}
                          onChange={(event) =>
                            setDraft({ ...draft, roomKind: event.target.value })
                          }
                        >
                          <option value="">Общий</option>
                          {Object.entries(roomKinds)
                            .filter(([id]) => id !== "general")
                            .map(([id, title]) => (
                              <option key={id} value={id}>
                                {title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Кабинет для лабораторных
                        <select
                          value={draft.labRoomKind}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              labRoomKind: event.target.value,
                            })
                          }
                        >
                          <option value="">Как для обычных</option>
                          {Object.entries(roomKinds)
                            .filter(([id]) => id !== "general")
                            .map(([id, title]) => (
                              <option key={id} value={id}>
                                {title}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <label className="catalog-joint-same-grade">
                      <span>
                        Объединять группы одной параллели
                        <InfoTooltip label="Объединять группы одной параллели">Параллель определяется по номеру в начале названия: 5А и 5Б. Если номера нет, группа не объединяется автоматически.</InfoTooltip>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.jointSameGrade === "true"}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            jointSameGrade: String(event.target.checked),
                          })
                        }
                      />
                    </label>
                    {draft.jointSameGrade === "true" && (
                      <label>
                        Групп в одном совместном уроке
                        <input
                          type="number"
                          min="2"
                          max="50"
                          step="1"
                          value={draft.maxJointGroups}
                          onChange={(event) =>
                            setDraft({ ...draft, maxJointGroups: event.target.value })
                          }
                        />
                      </label>
                    )}
                    <div className="subject-color-picker">
                      <div className="subject-color-heading">
                        <span>Цвет</span>
                        <button
                          className="catalog-button"
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              color: recommendSubjectColor(
                                catalog.subjects,
                                draft.color as SubjectColor,
                                editing?.id,
                                true,
                              ),
                            })
                          }
                        >
                          Подобрать цвет
                        </button>
                      </div>
                      <div
                        className={`subject-color-preview ${draft.color}`}
                        aria-live="polite"
                      >
                        <SubjectIcon subject={{ id: editing?.id, name: draft.name, shortName: draft.shortName, iconId: (editing as CatalogSubject | null)?.iconId }} />
                        <strong>
                          {draft.shortName.trim() ||
                            draft.name.trim() ||
                            "Предмет"}
                        </strong>
                        <small>
                          {
                            subjectColors.find(({ id }) => id === draft.color)
                              ?.name
                          }
                        </small>
                      </div>
                    </div>
                  </div>
                )}
                {tab === "rooms" && (
                  <div className="catalog-form-grid">
                    <label>
                      Тип кабинета
                      <select
                        value={draft.kind}
                        onChange={(event) =>
                          setDraft({ ...draft, kind: event.target.value })
                        }
                      >
                        {Object.entries(roomKinds).map(([id, title]) => (
                          <option key={id} value={id}>
                            {title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Вместимость
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={draft.capacity}
                        onChange={(event) =>
                          setDraft({ ...draft, capacity: event.target.value })
                        }
                        placeholder="Не задана"
                      />
                    </label>
                  </div>
                )}
              </fieldset>
              {error && (
                <div
                  className={`catalog-alert ${conflict ? "conflict" : ""}`}
                  role="alert"
                >
                  <span>{error}</span>
                  {pending && (
                    <button
                      type="button"
                      onClick={() => void retry()}
                      disabled={busy}
                    >
                      Повторить сохранение
                    </button>
                  )}
                  {conflict && (
                    <button
                      type="button"
                      onClick={() => void reloadLatest()}
                      disabled={busy}
                    >
                      Загрузить актуальные данные
                    </button>
                  )}
                </div>
              )}
              <footer>
                <button
                  className="catalog-primary"
                  type="submit"
                  disabled={
                    busy ||
                    Boolean(pending) ||
                    Boolean(subgroupOverflow) ||
                    Boolean(groupSubgroupOverflow)
                  }
                >
                  <ActionLabel action="save">{busy ? "Сохраняем…" : "Сохранить"}</ActionLabel>
                </button>
                <button
                  className="catalog-button"
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setEditing(null);
                    setError("");
                  }}
                  disabled={busy || Boolean(pending)}
                >
                  Отмена
                </button>
                {editing?.archived && deleteAction(editing)}
              </footer>
            </form>
          </>
        )}
      </dialog>
      {availabilityTarget && (
        <AvailabilityDialog
          kind={availabilityTarget.kind}
          resource={availabilityTarget.entry}
          auth={auth}
          revision={state.revision}
          onUnauthorized={onUnauthorized}
          busy={busy || Boolean(pending)}
          pending={Boolean(pending)}
          onDirtyChange={setAvailabilityDirty}
          onSave={saveAvailability}
          onTeacherReplacement={availabilityTarget.kind === "teacher" ? rule => {
            void openTeacherReassignments(availabilityTarget.entry.id, rule, "absence");
          } : undefined}
          onRetry={retry}
          onClose={() => {
            if (busy || pending) return;
            if (availabilityDirty && !window.confirm("Закрыть без сохранения ограничений?")) return;
            setAvailabilityTarget(null);
            setAvailabilityDirty(false);
          }}
        />
      )}
      <dialog
        ref={archiveDialog}
        className="catalog-dialog catalog-confirm"
        aria-labelledby="archive-title"
        onCancel={(event) => {
          if (busy || pending) {
            event.preventDefault();
            return;
          }
          setConfirmArchive(null);
          setError("");
        }}
      >
        {confirmArchive && (
          <>
            <h2 className="catalog-confirm-title"><span id="archive-title">Перенести в архив?</span> <InfoTooltip label="Архивирование">Архивирование скрывает запись из выбора для новых уроков. Уже назначенные уроки, включая будущие, сохраняются. Архив можно отменить.</InfoTooltip></h2>
            <p>
              «{confirmArchive.name}»
            </p>
            {error && (
              <div
                className={`catalog-alert ${conflict ? "conflict" : ""}`}
                role="alert"
              >
                <span>{error}</span>
                {pending && (
                  <button
                    type="button"
                    onClick={() => void retry()}
                    disabled={busy}
                  >
                    Повторить сохранение
                  </button>
                )}
                {conflict && (
                  <button
                    type="button"
                    onClick={() => void reloadLatest()}
                    disabled={busy}
                  >
                    Загрузить актуальные данные
                  </button>
                )}
              </div>
            )}
            <footer>
              <button
                ref={archiveCancel}
                className="catalog-button"
                type="button"
                onClick={() => {
                  setConfirmArchive(null);
                  setError("");
                }}
                disabled={busy || Boolean(pending)}
              >
                Отмена
              </button>
              {deleteAction(confirmArchive)}
              <button
                className="catalog-primary"
                type="button"
                disabled={busy || Boolean(pending)}
                onClick={() => void toggleArchive(confirmArchive, true)}
              >
                {busy ? "Сохраняем…" : "В архив"}
              </button>
            </footer>
          </>
        )}
      </dialog>
    </main>
  );
}
