import { createId } from "../shared/createId.ts";
import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import InfoTooltip from "./InfoTooltip";
import GroupSelection from "./GroupSelection";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, api, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts";
import { visibleQuarters, type StudyPlan } from "../shared/plans";
import {
  fromGroupPlan,
  validateCurricula,
  type Curriculum,
  type CurriculumRow,
} from "../shared/curricula";
import "./catalog.css";
import "./curricula.css";

type Props = {
  initialState: StateResponse;
  auth: AuthSession;
  onUnauthorized: () => void;
  onBack: (groupId: string, quarterId: string) => Promise<void>;
  initialGroupId?: string;
  initialQuarterId?: string;
};
type RowDraft = Omit<CurriculumRow, "id"> & { id?: string };
type PendingSave = {
  curricula: Curriculum[];
  revision: number;
  requestId: string;
  confirmGroupReplacement: boolean;
};

const newId = () => createId();
const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
const emptyRow = (): RowDraft => ({ subjectId: "", lessonKind: "regular", mode: "whole", hours: 1 });
const errorText = (error: unknown) => error instanceof Error ? error.message : "Не удалось сохранить учебные планы.";
const emptyCurricula = (state: StateResponse) => state.curricula ?? [];
const plansScopeOf = (state: StateResponse) => state.plansScope?.quarterId;
type ReplacementTarget = { groupId: string; quarterId: string };
type ReplacementDraft = { curricula: Curriculum[]; groups: ReplacementTarget[] };
type SortColumn = "subject" | "kind" | "scope" | "hours";

function activeSubgroupIds(catalog: StateResponse["catalog"], groupId: string) {
  return catalog.subgroups.filter((subgroup) => subgroup.groupId === groupId && !subgroup.archived).map((subgroup) => subgroup.id);
}

function subgroupScope(row: CurriculumRow, groupIds: string[], catalog: StateResponse["catalog"]) {
  if (row.mode === "whole") return { label: "—", title: undefined };
  if (!row.subgroupIdsByGroup) return { label: "Каждой подгруппе", title: undefined };
  const names = groupIds.flatMap(groupId => {
    const selected = row.subgroupIdsByGroup?.[groupId];
    return catalog.subgroups.filter(s => s.groupId === groupId && (selected ? selected.includes(s.id) : !s.archived)).map(s => s.name);
  });
  return { label: names.length <= 2 ? names.join(", ") : `Выбранным (${names.length})`, title: names.join(", ") };
}

export default function CurriculaPage({ initialState, auth, onUnauthorized, onBack, initialGroupId, initialQuarterId }: Props) {
  const [state, setState] = useState(initialState);
  const groups = useMemo(() => state.catalog.groups.filter((g) => !g.archived).sort((a, b) => collator.compare(a.name, b.name)), [state.catalog.groups]);
  const quarters = useMemo(() => visibleQuarters(state.quarters), [state.quarters]);
  const [quarterId, setQuarterId] = useState(() => {
    const scopedId = plansScopeOf(initialState);
    if (scopedId && quarters.some((q) => q.id === scopedId)) return scopedId;
    return quarters.some((q) => q.id === initialQuarterId) ? initialQuarterId! : quarters.find((q) => {
      const today = new Date().toLocaleDateString("sv-SE");
      return q.startDate <= today && q.endDate >= today;
    })?.id ?? quarters[0]?.id ?? "";
  });
  const [curricula, setCurricula] = useState<Curriculum[]>(() => emptyCurricula(initialState));
  const [selectedId, setSelectedId] = useState(() => {
    const all = emptyCurricula(initialState);
    return all.find((c) => c.quarterId === quarterId && initialGroupId && c.groupIds.includes(initialGroupId))?.id ?? all.find((c) => c.quarterId === quarterId)?.id ?? "";
  });
  const [rowDraft, setRowDraft] = useState<RowDraft | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Curriculum | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [pendingQuarterSwitch, setPendingQuarterSwitch] = useState<string | null>(null);
  const [quarterLoading, setQuarterLoading] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [replacementPreview, setReplacementPreview] = useState<ReplacementDraft | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState("");
  const [navigating, setNavigating] = useState(false);
  const [sort, setSort] = useState<SortColumn>("subject");
  const [sortDesc, setSortDesc] = useState(false);
  const [importSource, setImportSource] = useState(false);
  const [reuseDialog, setReuseDialog] = useState(false);
  const [reuseTemplateId, setReuseTemplateId] = useState("");
  const [reuseGroupIds, setReuseGroupIds] = useState<string[]>([]);
  const [reuseConfirm, setReuseConfirm] = useState(false);
  const [baseJson, setBaseJson] = useState(JSON.stringify(emptyCurricula(initialState)));
  // Last explicit assignment wins even if the administrator switches plans before saving.
  const assignmentChoices = useRef(new Map<string, string>());
  const rowDialog = useRef<HTMLDialogElement>(null);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const replacementDialog = useRef<HTMLDialogElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const reuseDialogRef = useRef<HTMLDialogElement>(null);
  const rowSubjectRef = useRef<HTMLSelectElement>(null);
  const planNameRef = useRef<HTMLInputElement>(null);
  const focusPlanId = useRef<string | null>(null);
  const quarterLoadController = useRef<AbortController | null>(null);
  const plan = curricula.find((c) => c.id === selectedId && c.quarterId === quarterId) ?? null;
  const reusableTemplates = state.curriculumTemplates ?? [];
  const reusableTemplate = reusableTemplates.find((item) => item.id === reuseTemplateId) ?? null;
  const dirty = JSON.stringify(curricula) !== baseJson || rowDraft !== null;
  const rows = useMemo(() => {
    if (!plan) return [];
    return [...plan.rows].sort((a, b) => {
      const subjectA = state.catalog.subjects.find((s) => s.id === a.subjectId)?.name ?? "";
      const subjectB = state.catalog.subjects.find((s) => s.id === b.subjectId)?.name ?? "";
      const valueA = sort === "kind" ? (a.lessonKind === "lab" ? "Лабораторные" : "Обычные") : sort === "scope" ? (a.mode === "whole" ? "Вся группа" : "Подгруппы") : "";
      const valueB = sort === "kind" ? (b.lessonKind === "lab" ? "Лабораторные" : "Обычные") : sort === "scope" ? (b.mode === "whole" ? "Вся группа" : "Подгруппы") : "";
      const compared = sort === "subject" ? collator.compare(subjectA, subjectB) : sort === "hours" ? a.hours - b.hours : collator.compare(valueA, valueB);
      return (sortDesc ? -compared : compared) || collator.compare(subjectA, subjectB);
    });
  }, [plan, sort, sortDesc, state.catalog.subjects]);
  const subjects = [...state.catalog.subjects].filter((s) => !s.archived || s.id === rowDraft?.subjectId).sort((a, b) => collator.compare(a.name, b.name));
  const planList = curricula.filter((c) => c.quarterId === quarterId).sort((a, b) => collator.compare(a.name, b.name));
  const replacementGroups = useMemo(() => reuseGroupIds.filter((groupId) => {
    const owner = curricula.find((item) => item.quarterId === quarterId && item.groupIds.includes(groupId));
    const hasPlans = state.studyPlans.some((item) => item.quarterId === quarterId && item.groupId === groupId);
    const ownerFamily = owner?.templateId ?? owner?.id;
    const selectedFamily = reusableTemplate ? (reusableTemplate.templateId ?? reusableTemplate.id) : undefined;
    return hasPlans && ownerFamily !== selectedFamily;
  }), [reuseGroupIds, curricula, quarterId, state.studyPlans, reusableTemplate]);

  useEffect(() => { if (rowDraft && !rowDialog.current?.open) { rowDialog.current?.showModal(); requestAnimationFrame(() => rowSubjectRef.current?.focus()); } else if (!rowDraft && rowDialog.current?.open) rowDialog.current.close(); }, [rowDraft]);
  useEffect(() => { if (plan && focusPlanId.current === selectedId) { focusPlanId.current = null; requestAnimationFrame(() => planNameRef.current?.focus()); } }, [selectedId, plan]);
  useEffect(() => { if (removeTarget && !removeDialog.current?.open) removeDialog.current?.showModal(); else if (!removeTarget && removeDialog.current?.open) removeDialog.current.close(); }, [removeTarget]);
  useEffect(() => { if (leavePrompt && !leaveDialog.current?.open) leaveDialog.current?.showModal(); else if (!leavePrompt && leaveDialog.current?.open) leaveDialog.current.close(); }, [leavePrompt]);
  useEffect(() => { if (replacementPreview && !replacementDialog.current?.open) replacementDialog.current?.showModal(); else if (!replacementPreview && replacementDialog.current?.open) replacementDialog.current.close(); }, [replacementPreview]);
  useEffect(() => { if (importSource && !importDialog.current?.open) importDialog.current?.showModal(); else if (!importSource && importDialog.current?.open) importDialog.current.close(); }, [importSource]);
  useEffect(() => { if (reuseDialog && !reuseDialogRef.current?.open) reuseDialogRef.current?.showModal(); else if (!reuseDialog && reuseDialogRef.current?.open) reuseDialogRef.current.close(); }, [reuseDialog]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  useEffect(() => () => quarterLoadController.current?.abort(), []);

  function setPlan(next: Curriculum) { setCurricula((all) => all.map((c) => c.id === next.id ? next : c)); }
  function selectPlan(id: string) {
    setSelectedId(id);
    setError("");
  }
  function changePlanGroups(groupIds: string[]) {
    if (!plan) return;
    for (const groupId of groupIds) {
      if (!plan.groupIds.includes(groupId)) assignmentChoices.current.set(JSON.stringify([quarterId, groupId]), plan.id);
    }
    for (const groupId of plan.groupIds) {
      if (!groupIds.includes(groupId) && assignmentChoices.current.get(JSON.stringify([quarterId, groupId])) === plan.id)
        assignmentChoices.current.delete(JSON.stringify([quarterId, groupId]));
    }
    setPlan({ ...plan, groupIds, rows: plan.rows.map((row) => {
      if (row.mode !== "subgroups" || row.subgroupIdsByGroup === undefined) return row;
      const subgroupIdsByGroup = { ...row.subgroupIdsByGroup };
      for (const groupId of groupIds) if (!subgroupIdsByGroup[groupId]) subgroupIdsByGroup[groupId] = activeSubgroupIds(state.catalog, groupId);
      for (const groupId of Object.keys(subgroupIdsByGroup)) if (!groupIds.includes(groupId)) delete subgroupIdsByGroup[groupId];
      return { ...row, subgroupIdsByGroup };
    }) });
  }
  function startPlan(source?: StudyPlan[], groupForSource = initialGroupId ?? groups[0]?.id ?? "", copyOf?: Curriculum) {
    const sourceRows = source ?? [];
    const id = newId();
    const existingNames = new Set([...reusableTemplates.map((item) => item.name), ...curricula.map((item) => item.name)].map((name) => name.trim().toLocaleLowerCase("ru")));
    const uniqueName = (base: string) => {
      let name = base.trim() || "Новый план";
      for (let suffix = 2; existingNames.has(name.toLocaleLowerCase("ru")); suffix++) name = `${base.trim() || "Новый план"} ${suffix}`;
      return name;
    };
    let value: Curriculum = { id, name: uniqueName("Новый план"), quarterId, groupIds: [], rows: [] };
    if (copyOf) {
      const name = uniqueName(`${copyOf.name.slice(0, 86)} (копия)`);
      const copyFields = { ...copyOf };
      delete copyFields.templateId;
      value = { ...copyFields, id, name, quarterId, groupIds: [], rows: copyOf.rows.map((row) => {
        const copy = { ...row, id: newId() };
        delete copy.subgroupIdsByGroup;
        return copy;
      }) };
    } else if (sourceRows.length) {
      const imported = fromGroupPlan(uniqueName("Новый план из плана группы"), groupForSource, quarterId, sourceRows, state.catalog);
      value = { ...imported, id, groupIds: [], rows: imported.rows.map((row) => {
        const copy = { ...row, id: newId() };
        delete copy.subgroupIdsByGroup;
        return copy;
      }) };
    }
    setCurricula((all) => [...all, value]);
    focusPlanId.current = id;
    setSelectedId(id);
    setError("");
  }
  function openReuse() {
    const first = reusableTemplates[0];
    setReuseTemplateId(first?.id ?? "");
    setReuseGroupIds([]);
    setReuseConfirm(false);
    setError("");
    setReuseDialog(true);
  }
  async function applyReusableTemplate() {
    if (!reusableTemplate || !reuseGroupIds.length || busy || !quarterId) return;
    if (replacementGroups.length && !reuseConfirm) { setError("Подтвердите замену планов выбранных групп."); return; }
    setBusy(true);
    setError("");
    try {
      const next = await api<StateResponse>("/api/curricula/reuse?response=compact", {
        method: "POST",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify({ curriculumId: reusableTemplate.id, quarterId, groupIds: reuseGroupIds, revision: state.revision, requestId: newId(), confirmReplace: replacementGroups.length > 0 && reuseConfirm }),
      });
      const nextCurricula = emptyCurricula(next);
      setState(next);
      setCurricula(nextCurricula);
      setBaseJson(JSON.stringify(nextCurricula));
      const reusableFamily = reusableTemplate.templateId ?? reusableTemplate.id;
      const applied = nextCurricula.find((item) => (item.templateId ?? item.id) === reusableFamily && item.groupIds.some((id) => reuseGroupIds.includes(id)))
        ?? nextCurricula.find((item) => item.groupIds.some((id) => reuseGroupIds.includes(id)));
      setSelectedId(applied?.id ?? "");
      setReuseDialog(false);
      setReuseGroupIds([]);
      setReuseConfirm(false);
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      setError(errorText(reason));
    } finally { setBusy(false); }
  }
  function openRow(row?: CurriculumRow) {
    if (!plan) return;
    setEditingRowId(row?.id ?? null);
    setRowDraft(row ? { subjectId: row.subjectId, lessonKind: row.lessonKind, mode: row.mode, hours: row.hours, subgroupIdsByGroup: row.subgroupIdsByGroup ? structuredClone(row.subgroupIdsByGroup) : undefined } : emptyRow());
    setError("");
  }
  function submitRow(event: FormEvent) {
    event.preventDefault();
    if (!plan || !rowDraft) return;
    if (!rowDraft.subjectId || !Number.isInteger(rowDraft.hours) || rowDraft.hours < 1 || rowDraft.hours > 1000) { setError("Выберите предмет и укажите часы от 1 до 1000."); return; }
    if (plan.rows.some((r) => r.id !== editingRowId && r.subjectId === rowDraft.subjectId && r.lessonKind === rowDraft.lessonKind)) {
      setError("Этот предмет с выбранным видом занятий уже есть в плане."); return;
    }
    const row: CurriculumRow = { ...rowDraft, ...(rowDraft.mode === "subgroups" && rowDraft.subgroupIdsByGroup ? { subgroupIdsByGroup: rowDraft.subgroupIdsByGroup } : { subgroupIdsByGroup: undefined }), id: editingRowId ?? newId() };
    const next = { ...plan, rows: editingRowId ? plan.rows.map((r) => r.id === editingRowId ? row : r) : [...plan.rows, row] };
    setPlan(next);
    setRowDraft(null);
    setEditingRowId(null);
    setError("");
  }
  function toggleRowSubgroup(groupId: string, subgroupId: string) {
    setRowDraft((draft) => {
      if (!draft || draft.mode !== "subgroups" || !plan) return draft;
      const subgroupIdsByGroup = draft.subgroupIdsByGroup ? structuredClone(draft.subgroupIdsByGroup) : Object.fromEntries(plan.groupIds.map((id) => [id, activeSubgroupIds(state.catalog, id)]));
      const selected = new Set(subgroupIdsByGroup[groupId] ?? activeSubgroupIds(state.catalog, groupId));
      if (selected.has(subgroupId)) selected.delete(subgroupId); else selected.add(subgroupId);
      subgroupIdsByGroup[groupId] = [...selected];
      return { ...draft, subgroupIdsByGroup };
    });
  }
  function removeRow(rowId: string) {
    if (!plan) return;
    setPlan({ ...plan, rows: plan.rows.filter((row) => row.id !== rowId) });
  }
  function proposeSave() {
    const candidate = plan;
    if (candidate?.name.trim() === "") { setError("Введите название плана."); return; }
    const proposed = curricula.map((c) => {
      const groupIds = c.groupIds.filter((groupId) => {
        const owner = assignmentChoices.current.get(JSON.stringify([c.quarterId, groupId]));
        return !owner || owner === c.id || !curricula.some((other) => other.id === owner && other.groupIds.includes(groupId));
      });
      return { ...c, name: c.name.trim(), groupIds, rows: c.rows.map((row) => {
        if (!row.subgroupIdsByGroup) return row;
        const subgroupIdsByGroup = Object.fromEntries(Object.entries(row.subgroupIdsByGroup).filter(([groupId]) => groupIds.includes(groupId)));
        return { ...row, subgroupIdsByGroup: Object.keys(subgroupIdsByGroup).length ? subgroupIdsByGroup : undefined };
      }) };
    });
    const validation = validateCurricula(proposed, state.catalog, state.quarters, state.curricula ?? []);
    if (validation) { setError(validation); return; }
    const previousOwners = new Map<string, string>();
    const nextOwners = new Map<string, string>();
    const populated = new Set(state.studyPlans.map((p) => JSON.stringify([p.quarterId, p.groupId])));
    for (const item of state.curricula ?? []) for (const groupId of item.groupIds) previousOwners.set(JSON.stringify([item.quarterId, groupId]), item.id);
    for (const item of proposed) for (const groupId of item.groupIds) nextOwners.set(JSON.stringify([item.quarterId, groupId]), item.id);
    const replacing = [...nextOwners].filter(([key, id]) => populated.has(key) && previousOwners.get(key) !== id).map(([key]) => {
      const [targetQuarter, groupId] = JSON.parse(key) as [string, string];
      return { groupId, quarterId: targetQuarter };
    }).sort((a, b) => a.quarterId.localeCompare(b.quarterId) || collator.compare(groups.find((g) => g.id === a.groupId)?.name ?? a.groupId, groups.find((g) => g.id === b.groupId)?.name ?? b.groupId));
    if (!replacing.length) {
      const request: PendingSave = { curricula: proposed, revision: state.revision, requestId: newId(), confirmGroupReplacement: false };
      setPending(request);
      void persist(request);
      return;
    }
    setReplacementPreview({ curricula: proposed, groups: replacing });
    setConfirmReplace(replacing.length === 0);
    setError("");
  }
  function acceptAndSave() {
    if (replacementPreview === null) return;
    const validation = validateCurricula(replacementPreview.curricula, state.catalog, state.quarters, state.curricula ?? []);
    if (validation) { setError(validation); setReplacementPreview(null); return; }
    const request: PendingSave = { curricula: replacementPreview.curricula, revision: state.revision, requestId: newId(), confirmGroupReplacement: confirmReplace };
    setReplacementPreview(null);
    setPending(request);
    void persist(request);
  }
  async function persist(operation: PendingSave) {
    if (busy || conflict) return;
    setBusy(true); setError("");
    try {
      const scopedOperation = { ...operation, scopeQuarterId: quarterId };
      const next = await api<StateResponse>("/api/curricula?response=compact", { method: "PUT", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify(scopedOperation) });
      assignmentChoices.current.clear();
      setState(next); setCurricula(emptyCurricula(next)); setBaseJson(JSON.stringify(emptyCurricula(next))); setPending(null); setConflict(false); setConfirmReplace(false);
      if (!emptyCurricula(next).some((c) => c.id === selectedId && c.quarterId === quarterId)) setSelectedId(emptyCurricula(next).find((c) => c.quarterId === quarterId)?.id ?? "");
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && ![401, 403, 409].includes(reason.status)) setPending(null);
      setError(errorText(reason));
    } finally { setBusy(false); }
  }
  async function reloadLatest() {
    if (!window.confirm("Загрузить актуальные планы? Несохранённые изменения будут отброшены.")) return;
    setBusy(true); setError("");
    try {
      const next = await api<StateResponse>(`/api/admin/state?view=plans&quarterId=${encodeURIComponent(quarterId)}`);
      assignmentChoices.current.clear();
      setState(next); setCurricula(emptyCurricula(next)); setBaseJson(JSON.stringify(emptyCurricula(next))); setPending(null); setConflict(false); setRowDraft(null); setRemoveTarget(null);
      const first = emptyCurricula(next).find((c) => c.quarterId === quarterId);
      setSelectedId(first?.id ?? "");
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) onUnauthorized(); setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  function retry() { if (pending && !conflict) void persist(pending); }

  async function loadQuarter(targetQuarterId: string) {
    if (!targetQuarterId || targetQuarterId === quarterId || pending || busy) return;
    quarterLoadController.current?.abort();
    const controller = new AbortController();
    quarterLoadController.current = controller;
    setQuarterLoading(true);
    setError("");
    try {
      const next = await api<StateResponse>(`/api/admin/state?view=plans&quarterId=${encodeURIComponent(targetQuarterId)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const nextCurricula = emptyCurricula(next);
      setState(next);
      setCurricula(nextCurricula);
      setBaseJson(JSON.stringify(nextCurricula));
      assignmentChoices.current.clear();
      setQuarterId(plansScopeOf(next) ?? targetQuarterId);
      setSelectedId(nextCurricula.find((item) => item.quarterId === targetQuarterId && initialGroupId && item.groupIds.includes(initialGroupId))?.id ?? nextCurricula.find((item) => item.quarterId === targetQuarterId)?.id ?? "");
      setRowDraft(null);
      setRemoveTarget(null);
      setReplacementPreview(null);
      setError("");
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      setError(errorText(reason));
    } finally {
      if (quarterLoadController.current === controller) {
        quarterLoadController.current = null;
        setQuarterLoading(false);
      }
    }
  }

  function requestQuarterChange(target: string) {
    if (dirty) {
      setPendingQuarterSwitch(target);
      setLeavePrompt(true);
      return;
    }
    void loadQuarter(target);
  }

  function discardAndContinue() {
    const target = pendingQuarterSwitch;
    setLeavePrompt(false);
    setPendingQuarterSwitch(null);
    if (target) void loadQuarter(target);
    else void navigateBack(true);
  }
  function removeCurriculum() {
    if (!removeTarget) return;
    setCurricula((all) => all.filter((c) => c.id !== removeTarget.id));
    if (selectedId === removeTarget.id) setSelectedId("");
    setRemoveTarget(null);
  }
  function oldHoursFor(groupId: string, targetQuarter: string) {
    return state.studyPlans.filter((p) => p.quarterId === targetQuarter && p.groupId === groupId).reduce((total, p) => total + p.assignments.reduce((sum, a) => sum + a.target, 0), 0);
  }
  function newHoursFor(groupId: string, targetQuarter: string) {
    const next = replacementPreview?.curricula.find((c) => c.quarterId === targetQuarter && c.groupIds.includes(groupId));
    if (!next) return 0;
    return next.rows.reduce((total, row) => total + row.hours * (row.mode === "whole" ? 1 : row.subgroupIdsByGroup?.[groupId]?.length ?? state.catalog.subgroups.filter((sg) => sg.groupId === groupId && !sg.archived).length), 0);
  }
  async function navigateBack(discard = false) {
    if (busy || pending || navigating) return;
    if (dirty && !discard) { setLeavePrompt(true); return; }
    const groupId = plan?.groupIds[0] ?? initialGroupId ?? groups[0]?.id ?? "";
    setNavigating(true);
    try { await onBack(groupId, quarterId); } catch (reason) { setError(errorText(reason)); } finally { setNavigating(false); setLeavePrompt(false); }
  }
  return <main className="catalog-page curricula-page">
    <AdminPageHeader title="Учебные планы" onBack={() => void navigateBack()} disabled={busy || Boolean(pending)} busy={navigating} />
    <section className="catalog-body curricula-body">
      <div className="catalog-toolbar curricula-toolbar">
        <div className="curricula-selectors"><label>Четверть<select aria-label="Четверть" value={quarterId} onChange={(e) => requestQuarterChange(e.target.value)} disabled={Boolean(pending) || quarterLoading}>{quarters.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>{quarterLoading && <span role="status">Загружаем планы…</span>}</div>
        <div className="curricula-actions"><button className="catalog-button" type="button" onClick={openReuse} disabled={!reusableTemplates.length || Boolean(dirty || pending || busy || quarterLoading)} title={dirty ? "Сначала сохраните изменения текущего плана" : undefined}>Использовать существующий план</button><button className="catalog-button" type="button" onClick={() => setImportSource(true)} disabled={!state.studyPlans.some((p) => p.quarterId === quarterId) || Boolean(pending)} title="Создать план из плана группы">Из плана группы</button><button className="catalog-primary" type="button" onClick={() => startPlan()} disabled={!quarterId || Boolean(pending)}><ActionLabel action="add">Новый план</ActionLabel></button><button className="catalog-primary" type="button" onClick={proposeSave} disabled={!dirty || Boolean(pending || busy)}><ActionLabel action="save">Сохранить планы</ActionLabel></button></div>
      </div>
      {error && <div className={`catalog-alert ${conflict ? "conflict" : ""}`} role="alert"><span>{error}</span>{pending && !conflict && <button type="button" onClick={retry} disabled={busy}>Повторить сохранение</button>}{conflict && <button type="button" onClick={() => void reloadLatest()} disabled={busy}>Загрузить актуальные данные</button>}</div>}

      <div className="curricula-layout">
        <aside className="curricula-list"><h2>Планы четверти <InfoTooltip label="Учебные планы">Создайте план, настройте предметы и часы, затем назначьте его группам. Для предмета по подгруппам задаётся одинаковая норма каждой выбранной подгруппе.</InfoTooltip></h2>{planList.map((item) => <button key={item.id} className={`curricula-list-item ${selectedId === item.id ? "selected" : ""}`} type="button" onClick={() => selectPlan(item.id)}><strong>{item.name}{item.templateId && <span className="curricula-template-badge">Общий план</span>}</strong><span className="school-code">{item.groupIds.map((gid) => groups.find((g) => g.id === gid)?.name ?? "Группа").join(", ") || "Не назначен группам"}</span></button>)}{!planList.length && <p className="curricula-empty">Пока нет планов.</p>}</aside>
        <div className="curricula-editor">
          {!plan ? <div className="curricula-placeholder">Выберите план слева или создайте новый.</div> : <>
            <div className="curricula-plan-heading"><div><input ref={planNameRef} aria-label="Название плана" value={plan.name} onChange={(e) => { setPlan({ ...plan, name: e.target.value }); setError(""); }} disabled={Boolean(pending)} />{plan.templateId && <InfoTooltip label="Переиспользуемый план">Название и список предметов относятся ко всему переиспользуемому плану. Часы редактируются отдельно для выбранной четверти.</InfoTooltip>}<small>{plan.groupIds.length ? <>Назначен группам: <span className="school-code">{plan.groupIds.map((id) => groups.find((g) => g.id === id)?.name ?? "").filter(Boolean).join(", ")}</span></> : "План пока не назначен группам"}</small></div><div className="curricula-plan-actions"><button className="catalog-button" type="button" onClick={() => startPlan(undefined, undefined, plan)} disabled={Boolean(pending)}>Создать копию</button><button className="catalog-button" type="button" onClick={() => openRow()} disabled={Boolean(pending)}><ActionLabel action="add">Предмет</ActionLabel></button><button className="catalog-danger" type="button" onClick={() => setRemoveTarget(plan)} disabled={Boolean(pending)}><ActionLabel action="delete">Удалить план</ActionLabel></button></div></div>
            <section className="curricula-assignment"><h3>Назначить план группам</h3><GroupSelection groups={groups} value={plan.groupIds} onChange={changePlanGroups} disabled={Boolean(pending)} label="Выберите группы" /></section>
            <div className="catalog-table-wrap"><table className="catalog-table curricula-table"><thead><tr>{([["subject", "Предмет"], ["kind", "Вид"], ["scope", "Кому"], ["hours", "Часов"]] as const).map(([column, label]) => <th key={column}><button className="catalog-sort" type="button" onClick={() => { setSortDesc(sort === column ? !sortDesc : false); setSort(column); }}>{label} {sort === column ? (sortDesc ? "↓" : "↑") : "↕"}</button></th>)}<th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{state.catalog.subjects.find((s) => s.id === row.subjectId)?.shortName || state.catalog.subjects.find((s) => s.id === row.subjectId)?.name || "Архивный предмет"}</strong></td><td>{row.lessonKind === "lab" ? "Лабораторные" : "Обычные"}</td><td title={subgroupScope(row, plan.groupIds, state.catalog).title} className={subgroupScope(row, plan.groupIds, state.catalog).title === subgroupScope(row, plan.groupIds, state.catalog).label ? "school-code" : undefined}>{subgroupScope(row, plan.groupIds, state.catalog).label}</td><td>{row.hours}</td><td className="curricula-row-actions"><button type="button" onClick={() => openRow(row)} disabled={Boolean(pending)}><ActionLabel action="edit">Изменить</ActionLabel></button><button type="button" className="archive" onClick={() => removeRow(row.id)} disabled={Boolean(pending)}><ActionLabel action="delete">Удалить</ActionLabel></button></td></tr>)}{!rows.length && <tr><td colSpan={5} className="catalog-empty">Добавьте предметы и часы за четверть.</td></tr>}</tbody></table></div>
          </>}
        </div>
      </div>
    </section>
    <dialog className="catalog-dialog curricula-dialog" ref={rowDialog} aria-labelledby="curricula-row-title" onCancel={(e) => { e.preventDefault(); if (!busy) setRowDraft(null); }}><header><h2 id="curricula-row-title">{editingRowId ? "Изменить предмет" : "Добавить предмет"}</h2><button type="button" aria-label="Закрыть" onClick={() => setRowDraft(null)}>×</button></header><form onSubmit={submitRow}><label>Предмет<select ref={rowSubjectRef} value={rowDraft?.subjectId ?? ""} onChange={(e) => setRowDraft((d) => d ? { ...d, subjectId: e.target.value } : d)}><option value="">Выберите предмет</option>{subjects.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label><label>Вид занятий<select value={rowDraft?.lessonKind ?? "regular"} onChange={(e) => setRowDraft((d) => d ? { ...d, lessonKind: e.target.value as CurriculumRow["lessonKind"] } : d)}><option value="regular">Обычные</option><option value="lab">Лабораторные</option></select></label><label>Кому назначены часы<select value={rowDraft?.mode ?? "whole"} onChange={(e) => setRowDraft((d) => d ? { ...d, mode: e.target.value as CurriculumRow["mode"] } : d)}><option value="whole">Вся группа</option><option value="subgroups">Подгруппы</option></select></label><div className="curricula-hours-editor"><strong>{rowDraft?.mode === "subgroups" ? "Часов каждой выбранной подгруппе" : "Часов за четверть"}{rowDraft?.mode === "subgroups" && <InfoTooltip label="Часы по подгруппам">Указанное количество часов задаётся каждой выбранной подгруппе группы.</InfoTooltip>}</strong><label>{rowDraft?.mode === "subgroups" ? "Каждой подгруппе" : "Всей группе"}<input type="number" min={1} max={1000} step={1} value={rowDraft?.hours ?? 1} onChange={(e) => setRowDraft((d) => d ? { ...d, hours: Number(e.target.value) } : d)} /></label></div>{rowDraft?.mode === "subgroups" && <section className="curricula-row-subgroups"><strong>Подгруппы по группам</strong>{!plan?.groupIds.length ? <p className="curricula-note">Сначала назначьте план хотя бы одной группе.</p> : plan.groupIds.map((groupId) => { const group = state.catalog.groups.find((item) => item.id === groupId); const available = state.catalog.subgroups.filter((subgroup) => subgroup.groupId === groupId && !subgroup.archived).sort((a, b) => collator.compare(a.name, b.name)); const chosen = rowDraft.subgroupIdsByGroup?.[groupId] ?? available.map((subgroup) => subgroup.id); return <fieldset key={groupId}><legend className="school-code">{group?.name ?? groupId}</legend>{available.length ? available.map((subgroup) => <label key={subgroup.id}><input type="checkbox" checked={chosen.includes(subgroup.id)} onChange={() => toggleRowSubgroup(groupId, subgroup.id)} /><span className="school-code">{subgroup.name}</span></label>) : <span className="curricula-note">Нет активных подгрупп</span>}</fieldset>; })}</section>}{error && <p className="catalog-validation" role="alert">{error}</p>}<footer><button className="catalog-primary" type="submit"><ActionLabel action="save">Сохранить предмет</ActionLabel></button><button className="catalog-button" type="button" onClick={() => setRowDraft(null)}>Отмена</button></footer></form></dialog>
    <dialog className="catalog-dialog catalog-confirm" ref={removeDialog} aria-labelledby="curricula-remove-title" onCancel={(e) => { e.preventDefault(); setRemoveTarget(null); }}><h2 id="curricula-remove-title">Удалить план?</h2><p>Назначенные группам часы сохранятся в отдельных копиях планов. Уже расставленные уроки не изменятся.</p><footer><button className="catalog-danger" type="button" onClick={removeCurriculum}><ActionLabel action="delete">Удалить план</ActionLabel></button><button className="catalog-button" type="button" onClick={() => setRemoveTarget(null)}>Отмена</button></footer></dialog>
    <dialog className="catalog-dialog catalog-confirm curricula-confirm" ref={replacementDialog} aria-labelledby="curricula-replacement-title" onCancel={(e) => { e.preventDefault(); setReplacementPreview(null); setConfirmReplace(false); }}><h2 id="curricula-replacement-title">{replacementPreview?.groups.length ? "Заменить планы групп?" : "Сохранить планы?"}</h2><p>{replacementPreview?.groups.length ? `Будут заменены планы следующих групп и четвертей. Уже расставленные уроки сохранятся.` : "Проверьте сохранение изменений плана."}</p>{replacementPreview?.groups.length ? <div className="curricula-replacement-hours">{replacementPreview.groups.map(({ groupId, quarterId: targetQuarter }) => <div key={`${targetQuarter}:${groupId}`}><strong><span className="school-code">{groups.find((g) => g.id === groupId)?.name ?? groupId}</span> · {quarters.find((q) => q.id === targetQuarter)?.name ?? "четверть"}</strong><span>Сейчас: {oldHoursFor(groupId, targetQuarter)} ч.</span><span>В плане: {newHoursFor(groupId, targetQuarter)} ч.</span></div>)}</div> : null}{replacementPreview?.groups.length ? <label className="curricula-confirm-check"><input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} />Подтверждаю замену указанных планов</label> : null}<footer><button className="catalog-primary" type="button" onClick={acceptAndSave} disabled={!confirmReplace || busy}><ActionLabel action="save">{busy ? "Сохранение…" : "Сохранить"}</ActionLabel></button><button className="catalog-button" type="button" onClick={() => setReplacementPreview(null)}>Отмена</button></footer></dialog>
    <dialog className="catalog-dialog catalog-confirm curricula-confirm" ref={leaveDialog} aria-labelledby="curricula-leave-title" onCancel={(e) => { e.preventDefault(); setLeavePrompt(false); setPendingQuarterSwitch(null); }}><h2 id="curricula-leave-title">Есть несохранённые изменения</h2><p>{pendingQuarterSwitch ? "При переключении четверти изменения текущего плана будут потеряны." : "Если вернуться к расписанию сейчас, изменения учебного плана будут потеряны."}</p><footer><button className="catalog-button" type="button" onClick={() => { setLeavePrompt(false); setPendingQuarterSwitch(null); }}>Остаться</button><button className="catalog-danger" type="button" onClick={discardAndContinue}>Не сохранять</button></footer></dialog>
    <dialog className="catalog-dialog curricula-dialog curricula-reuse-dialog" ref={reuseDialogRef} aria-labelledby="curricula-reuse-title" onCancel={(e) => { e.preventDefault(); if (!busy) setReuseDialog(false); }}><header><h2 id="curricula-reuse-title">Использовать существующий план</h2><button type="button" aria-label="Закрыть" onClick={() => setReuseDialog(false)} disabled={busy}>×</button></header><label className="curricula-reuse-source"><span>План</span><select value={reuseTemplateId} onChange={(event) => { setReuseTemplateId(event.target.value); setReuseConfirm(false); setError(""); }} disabled={busy}><option value="">Выберите план</option>{reusableTemplates.slice().sort((a, b) => collator.compare(a.name, b.name)).map((item) => <option key={item.id} value={item.id}>{item.name} · {state.quarters.find((quarter) => quarter.id === item.quarterId)?.name ?? "четверть"}</option>)}</select></label>{reusableTemplate && <p className="curricula-reuse-description">В основе: {state.quarters.find((item) => item.id === reusableTemplate.quarterId)?.name ?? "четверть"}; предметов: {reusableTemplate.rows.length}. <InfoTooltip label="Часы при повторном использовании">Часы исходной четверти копируются как начальные значения. Их можно изменить отдельно для выбранной четверти.</InfoTooltip></p>}<GroupSelection groups={groups} value={reuseGroupIds} onChange={(ids) => { setReuseGroupIds(ids); setReuseConfirm(false); setError(""); }} disabled={busy} label="Назначить группам" />{replacementGroups.length > 0 && <><div className="curricula-reuse-replacements"><strong>У этих групп уже есть план за выбранную четверть:</strong><span className="school-code">{replacementGroups.map((id) => groups.find((group) => group.id === id)?.name ?? id).join(", ")}</span></div><label className="curricula-confirm-check"><input type="checkbox" checked={reuseConfirm} onChange={(event) => setReuseConfirm(event.target.checked)} disabled={busy} />Подтверждаю замену планов этих групп</label></>}{error && reuseDialog && <p className="catalog-validation" role="alert">{error}</p>}<footer><button className="catalog-primary" type="button" onClick={() => void applyReusableTemplate()} disabled={!reusableTemplate || !reuseGroupIds.length || busy || (replacementGroups.length > 0 && !reuseConfirm)}>{busy ? "Применяем…" : "Применить план"}</button><button className="catalog-button" type="button" onClick={() => setReuseDialog(false)} disabled={busy}>Отмена</button></footer></dialog>
    <dialog className="catalog-dialog curricula-dialog" ref={importDialog} aria-labelledby="curricula-import-title" onCancel={(e) => { e.preventDefault(); setImportSource(false); }}><header><h2 id="curricula-import-title">Создать план из плана группы</h2><button type="button" aria-label="Закрыть" onClick={() => setImportSource(false)}>×</button></header><p>Выберите группу, чтобы скопировать предметы и часы в новый неназначенный план.</p><div className="curricula-import-groups">{groups.filter((g) => state.studyPlans.some((p) => p.groupId === g.id && p.quarterId === quarterId)).map((g) => <button className="catalog-button" type="button" key={g.id} onClick={() => { const plans = state.studyPlans.filter((p) => p.groupId === g.id && p.quarterId === quarterId); startPlan(plans, g.id); setImportSource(false); }}><span className="school-code">{g.name}</span> · {state.studyPlans.filter((p) => p.groupId === g.id && p.quarterId === quarterId).length} предметов</button>)}</div>{!state.studyPlans.some((p) => p.quarterId === quarterId) && <p className="curricula-empty">В выбранной четверти пока нет планов групп.</p>}</dialog>
  </main>;
}
