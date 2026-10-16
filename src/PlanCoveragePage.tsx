import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StateResponse } from "../server/contracts.ts";
import type { PlanCoverageResponse, PlanCoverageGroup, PlanCoverageDetailsResponse } from "../shared/planCoverage.ts";
import { visibleQuarters } from "../shared/plans.ts";
import AdminPageHeader from "./AdminPageHeader";
import GroupSelection, { type SelectableGroup } from "./GroupSelection";
import InfoTooltip from "./InfoTooltip";
import QuarterPlanDialog from "./QuarterPlanDialog";
import { ApiError, api, type AuthSession } from "./api.ts";
import "./plan-coverage.css";

type Props = { initialState: StateResponse; auth: AuthSession; initialQuarterId?: string; onUnauthorized: () => void; onBack: (groupId?: string, quarterId?: string) => Promise<void> };
const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
const label = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
const statusText = (status: PlanCoverageGroup["status"]) => ({ "no-plan": "План не задан", empty: "Не заполнен", partial: "Недобор", complete: "Заполнен" })[status];
const quarterDate = (date: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const groupGrade = (name: string) => name.trim().match(/^(1[01]|[1-9])(?=$|[\s\-–—/\\()[А-ЯЁа-яёA-Za-z])/u)?.[1] ?? "other";

export default function PlanCoveragePage({ initialState, auth, initialQuarterId, onUnauthorized, onBack }: Props) {
  useEffect(() => { document.body.classList.add("plan-coverage-view"); return () => document.body.classList.remove("plan-coverage-view"); }, []);
  const quarters = useMemo(() => visibleQuarters(initialState.quarters), [initialState.quarters]);
  const [quarterId, setQuarterId] = useState(() => {
    if (initialQuarterId && initialState.quarters.some(q => q.id === initialQuarterId)) return initialQuarterId;
    const today = new Date().toLocaleDateString("sv-SE");
    return quarters.find(q => q.startDate <= today && q.endDate >= today)?.id ?? quarters[0]?.id
      ?? [...initialState.quarters].sort((a, b) => b.startDate.localeCompare(a.startDate))[0]?.id ?? "";
  });
  const selectedQuarter = initialState.quarters.find(q => q.id === quarterId);
  const quarterOptions = [...initialState.quarters].sort((a, b) => b.startDate.localeCompare(a.startDate) || collator.compare(a.name, b.name));
  const [data, setData] = useState<PlanCoverageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [grade, setGrade] = useState("all");
  const [filter, setFilter] = useState("all");
  const [backBusy, setBackBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(0);
  const [planGroup, setPlanGroup] = useState<PlanCoverageGroup | null>(null);
  const [details, setDetails] = useState<PlanCoverageDetailsResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [detailsRetry, setDetailsRetry] = useState(0);

  useEffect(() => {
    if (!quarterId) { setData(null); return; }
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(""); setCanRetry(false); setData(null);
    api<PlanCoverageResponse>(`/api/plan-coverage?quarterId=${encodeURIComponent(quarterId)}`, { signal: controller.signal })
      .then(value => { if (active) setData(value); })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return; }
        setCanRetry(true);
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить выполнение планов.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [quarterId, onUnauthorized, requestKey]);

  useEffect(() => {
    if (!planGroup) return;
    const controller = new AbortController();
    let active = true;
    setDetailsLoading(true); setDetailsError(""); setDetails(null);
    const params = new URLSearchParams({ quarterId, groupId: planGroup.id });
    api<PlanCoverageDetailsResponse>(`/api/plan-coverage/details?${params}`, { signal: controller.signal })
      .then(value => { if (active) setDetails(value); })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return; }
        setDetailsError(reason instanceof Error ? reason.message : "Не удалось загрузить план четверти.");
      })
      .finally(() => { if (active) setDetailsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [planGroup, quarterId, detailsRetry, onUnauthorized]);

  const currentData = data?.quarter.id === quarterId ? data : null;
  const groups = currentData?.groups ?? [];
  const grades = [...new Set(groups.map(group => groupGrade(group.name)))].sort((a, b) => a === "other" ? 1 : b === "other" ? -1 : Number(a) - Number(b));
  const groupOptions = groups.filter(group => grade === "all" || groupGrade(group.name) === grade).sort((a, b) => collator.compare(a.name, b.name));
  const selectedIds = new Set(groupIds);
  const filtered = groupOptions.filter(group => {
    if (selectedIds.size && !selectedIds.has(group.id)) return false;
    if (filter === "missing" && (group.status === "complete" || group.status === "no-plan")) return false;
    if (filter === "complete" && group.status !== "complete") return false;
    if (filter === "excess" && group.extra <= 0) return false;
    if (filter === "no-plan" && group.status !== "no-plan") return false;
    return true;
  });
  const totals = { complete: groups.filter(g => g.status === "complete").length, deficit: groups.filter(g => g.status === "empty" || g.status === "partial").length, excess: groups.filter(g => g.extra > 0).length, noPlan: groups.filter(g => g.status === "no-plan").length };
  const back = async (groupId?: string) => {
    if (backBusy) return;
    setBackBusy(true); setError(""); setCanRetry(false);
    try { await onBack(groupId, quarterId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось открыть расписание."); }
    finally { setBackBusy(false); }
  };
  const showPlan = (group: PlanCoverageGroup) => { setDetails(null); setDetailsError(""); setDetailsLoading(true); setPlanGroup(group); };
  const changeQuarter = (id: string) => { setQuarterId(id); setGroupIds([]); setPlanGroup(null); };

  return <div className="plan-coverage-page">
    <AdminPageHeader title="Выполнение учебных планов" username={auth.username} onBack={() => void back()} busy={backBusy} />
    <main className="plan-coverage-main">
      {!loading && currentData && <section className="plan-coverage-summary" aria-label="Итоги по всем группам">
        <article className="pc-summary-complete"><span>Заполнены</span><strong>{totals.complete}</strong></article>
        <article className="pc-summary-deficit"><span>Недобор</span><strong>{totals.deficit}</strong></article>
        <article className="pc-summary-excess"><span>Перебор</span><strong>{totals.excess}</strong></article>
        <article className="pc-summary-none"><span>Без плана</span><strong>{totals.noPlan}</strong></article>
      </section>}
      <section className="plan-coverage-controls" aria-label="Фильтры отчёта">
        <label className="pc-quarter"><span>Четверть</span><select aria-label="Четверть" value={quarterId} disabled={backBusy} onChange={event => changeQuarter(event.target.value)}>
          {quarterOptions.map(q => <option key={q.id} value={q.id}>{q.name}{q.archived ? " · архив" : ""}{/\d{4}/.test(q.name) ? "" : ` · ${q.startDate.slice(0, 4)}${q.startDate.slice(0, 4) === q.endDate.slice(0, 4) ? "" : `–${q.endDate.slice(0, 4)}`}`}</option>)}
        </select></label>
        <label className="pc-grade"><span>Класс</span><select aria-label="Класс" value={grade} disabled={backBusy} onChange={event => { setGrade(event.target.value); setGroupIds([]); }}>
          <option value="all">Все классы</option>{grades.map(item => <option key={item} value={item}>{item === "other" ? "Без номера" : `${item} класс`}</option>)}
        </select></label>
        <GroupFilter groups={groupOptions} value={groupIds} onChange={setGroupIds} disabled={backBusy || loading || !currentData} />
        <label className="pc-filter"><span>Статус</span><select aria-label="Статус" value={filter} disabled={backBusy} onChange={event => setFilter(event.target.value)}>
          <option value="all">Все</option><option value="missing">Недобор</option><option value="excess">Перебор</option><option value="complete">Заполнен</option><option value="no-plan">План не задан</option>
        </select></label>
      </section>
      {selectedQuarter && <p className="plan-coverage-period">{selectedQuarter.name}{selectedQuarter.archived ? " · архив" : ""} · {quarterDate(selectedQuarter.startDate)} — {quarterDate(selectedQuarter.endDate)}</p>}
      {error && <p className="plan-coverage-message is-error" role="alert">{error}{canRetry && <button type="button" onClick={() => setRequestKey(value => value + 1)}>Повторить</button>}</p>}
      {loading && <p className="plan-coverage-message" role="status">Загружаем выполнение планов…</p>}
      {!quarterOptions.length && <p className="plan-coverage-message">Учебные четверти не настроены.</p>}
      {!loading && currentData && <div className="plan-coverage-table-wrap" tabIndex={0} role="region" aria-label="Заполнение учебных планов по группам">
        <table className="plan-coverage-table"><thead><tr>
          <th scope="col">Класс / группа</th>
          <th scope="col">Заполненность плана <InfoTooltip label="Расчёт заполненности">Показаны процент и часы, покрытые расписанием, из нормы за четверть. Каждая подгруппа учитывается по собственной норме. Перебор не компенсирует недобор по другим назначениям.</InfoTooltip></th>
          <th scope="col">Статус</th><th scope="col">Расписание</th>
        </tr></thead><tbody>
          {filtered.map(group => <tr key={group.id} className={`pc-group-row ${group.archived ? "is-archived" : ""}`}>
            <th scope="row"><span className="pc-group-name">{group.name}{group.archived && <small>архив</small>}</span></th>
            <td><CoveragePercent group={group} /></td>
            <td><div className="pc-statuses"><span className={`pc-status pc-status-${group.status}`}>{statusText(group.status)}</span>{group.extra > 0 && <span className="pc-status pc-status-excess">Перебор</span>}</div></td>
            <td><div className="pc-row-actions">
              <button className="pc-icon-button" type="button" title="Открыть расписание" aria-label={`Открыть расписание · ${group.name}`} disabled={backBusy} onClick={() => void back(group.id)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M10 4H4v16h16v-6" /></svg>
              </button>
              <button className="pc-icon-button" type="button" title="Посмотреть план четверти" aria-label={`Посмотреть план четверти · ${group.name}`} disabled={backBusy} onClick={() => showPlan(group)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
              </button>
            </div></td>
          </tr>)}
          {filtered.length === 0 && <tr><td colSpan={4} className="plan-coverage-empty">{groups.length ? "По выбранным фильтрам групп нет." : "В этой четверти нет групп."}</td></tr>}
        </tbody></table>
      </div>}
    </main>
    {planGroup && <QuarterPlanDialog groupName={planGroup.name} quarterName={selectedQuarter?.name ?? ""} rows={details?.rows ?? []}
      loading={detailsLoading} error={detailsError} onRetry={() => setDetailsRetry(value => value + 1)} onClose={() => setPlanGroup(null)} />}
  </div>;
}

function CoveragePercent({ group }: { group: PlanCoverageGroup }) {
  return group.percent === null ? <span className="pc-no-percent">—</span>
    : <span className="pc-percent"><span className="pc-progress" role="progressbar" aria-label={`Заполненность плана: ${label(group.percent)}%, ${group.covered} из ${group.target}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={group.percent}>
      <i style={{ width: `${group.percent}%` }} /></span><strong>{label(group.percent)}% <span className="pc-hours">({group.covered}/{group.target})</span></strong></span>;
}

function GroupFilter({ groups, value, onChange, disabled }: { groups: SelectableGroup[]; value: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open]);
  const caption = value.length === 1 ? groups.find(group => group.id === value[0])?.name ?? "Выбрана 1 группа" : value.length ? `Выбрано групп: ${value.length}` : "Все группы";
  return <div className="pc-group-filter" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <span className="pc-field-label">Класс или группа</span>
    <button className="pc-group-trigger" type="button" ref={trigger} aria-label="Класс или группа" title="Без выбора отображаются все группы" aria-expanded={open && !disabled} aria-controls={popupId} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(value => !value)}>{caption}<span aria-hidden="true">⌄</span></button>
    {open && !disabled && <div className="pc-group-popover" id={popupId} role="dialog" aria-label="Выбор классов и групп">
      <GroupSelection groups={groups} value={value} onChange={onChange} label="Фильтр по группам" />
    </div>}
  </div>;
}
