import { createId } from "../shared/createId.ts";
import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts";
import RussianDateInput from "./RussianDateInput";
import QuarterEditor from "./QuarterEditor";
import GroupSelection from "./GroupSelection";
import InfoTooltip from "./InfoTooltip";
import { visibleQuarters } from "../shared/plans";
import {
  defaultSchoolCalendar,
  validateCalendar,
  type CalendarPeriod,
  type SchoolCalendar,
} from "../shared/schoolCalendar";
import "./calendar.css";

type Props = {
  initialState: StateResponse;
  auth: AuthSession;
  onUnauthorized: () => void;
  onBack: () => Promise<void>;
};
type PeriodDraft = Omit<CalendarPeriod, "id" | "groupIds"> & {
  id?: string;
  allGroups: boolean;
  groupIds: string[];
};
type Pending = {
  calendar: SchoolCalendar;
  revision: number;
  requestId: string;
  confirmLessonRemoval: boolean;
};
const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const id = () => createId();
const formatDate = (date: string) =>
  new Intl.DateTimeFormat("ru", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const kindLabel = (kind: CalendarPeriod["kind"]) =>
  kind === "holiday" ? "Каникулы" : kind === "day-off" ? "Неучебные дни" : "Учебные дни";

function blankPeriod(): PeriodDraft {
  return {
    name: "",
    kind: "holiday",
    startDate: "",
    endDate: "",
    allGroups: true,
    groupIds: [],
  };
}

export default function CalendarPage({ initialState, auth, onUnauthorized, onBack }: Props) {
  const [state, setState] = useState(initialState);
  const [quarterId, setQuarterId] = useState(() => {
    const today = new Date().toLocaleDateString("sv-SE");
    return visibleQuarters(initialState.quarters).find((q) => q.startDate <= today && q.endDate >= today)?.id
      ?? visibleQuarters(initialState.quarters)[0]?.id ?? "";
  });
  const [quarterSaved, setQuarterSaved] = useState(false);
  const [quarterBusy, setQuarterBusy] = useState(false);
  const [calendar, setCalendar] = useState<SchoolCalendar>(initialState.calendar ?? defaultSchoolCalendar());
  const [periodDraft, setPeriodDraft] = useState<PeriodDraft | null>(null);
  const [preview, setPreview] = useState<Omit<ReturnType<typeof import("../shared/schoolCalendar.ts").applyCalendar>, "schedule"> | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [groupWeekdaysDialog, setGroupWeekdaysDialog] = useState(false);
  const [selectedOverrideGroups, setSelectedOverrideGroups] = useState<string[]>([]);
  const [editingOverrideGroups, setEditingOverrideGroups] = useState<string[]>([]);
  const [selectedOverrideDays, setSelectedOverrideDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [returnToSchoolDefaults, setReturnToSchoolDefaults] = useState(false);
  const periodDialog = useRef<HTMLDialogElement>(null);
  const groupWeekdaysDialogRef = useRef<HTMLDialogElement>(null);
  const discardDialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => state.catalog.groups.filter((group) => !group.archived).sort((a, b) => collator.compare(a.name, b.name)), [state.catalog.groups]);
  const groupChoices = useMemo(() => state.catalog.groups.slice().sort((a, b) => collator.compare(a.name, b.name)), [state.catalog.groups]);
  const sortedPeriods = useMemo(() => [...calendar.periods].sort((a, b) => a.startDate.localeCompare(b.startDate) || collator.compare(a.name, b.name)), [calendar.periods]);
  const quarters = useMemo(() => visibleQuarters(state.quarters), [state.quarters]);
  const archivedQuarters = useMemo(() => state.quarters.filter((quarter) => quarter.archived).sort((a, b) => b.startDate.localeCompare(a.startDate)), [state.quarters]);
  const selectedQuarter = quarters.find((q) => q.id === quarterId) ?? quarters[0];
  const calculated = preview;
  const persistedCalendar = state.calendar ?? defaultSchoolCalendar();
  const dirty = JSON.stringify(calendar) !== JSON.stringify(persistedCalendar);
  const overriddenGroups = useMemo(() => {
    const byDays = new Map<string, string[]>();
    for (const groupId of Object.keys(calendar.groupWeekdays ?? {})) {
      const days = [...(calendar.groupWeekdays?.[groupId] ?? [])].sort((a, b) => a - b);
      const key = days.join(",");
      byDays.set(key, [...(byDays.get(key) ?? []), groupId]);
    }
    return [...byDays.entries()].map(([key, groupIds]) => ({
      key,
      groupIds: groupIds.sort((a, b) => collator.compare(
        state.catalog.groups.find((group) => group.id === a)?.name ?? a,
        state.catalog.groups.find((group) => group.id === b)?.name ?? b,
      )),
      days: key ? key.split(",").map(Number) : [],
    })).sort((a, b) => collator.compare(
      state.catalog.groups.find((group) => group.id === a.groupIds[0])?.name ?? a.groupIds[0],
      state.catalog.groups.find((group) => group.id === b.groupIds[0])?.name ?? b.groupIds[0],
    ));
  }, [calendar.groupWeekdays, state.catalog.groups]);
  useEffect(() => {
    const dialog = periodDialog.current;
    if (!dialog) return;
    if (periodDraft && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => nameRef.current?.focus());
    }
    if (!periodDraft && dialog.open) dialog.close();
  }, [periodDraft]);
  useEffect(() => {
    const dialog = groupWeekdaysDialogRef.current;
    if (!dialog) return;
    if (groupWeekdaysDialog && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => groupWeekdaysDialogRef.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus());
    }
    if (!groupWeekdaysDialog && dialog.open) dialog.close();
  }, [groupWeekdaysDialog]);
  useEffect(() => {
    const dialog = discardDialogRef.current;
    if (!dialog) return;
    if (discardPrompt && !dialog.open) dialog.showModal();
    if (!discardPrompt && dialog.open) dialog.close();
  }, [discardPrompt]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  function changeCalendar(next: SchoolCalendar) {
    previewController.current?.abort();
    previewController.current = null;
    setPreviewBusy(false);
    setCalendar(next);
    setPreview(null);
    setConfirmRemoval(false);
    setError("");
    setConflict(false);
    setSaved(false);
  }

  async function calculatePreview() {
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setPreview(null);
    setConfirmRemoval(false);
    setError("");
    setPreviewBusy(true);
    if (validationError) {
      setError(validationError);
      setPreviewBusy(false);
      return;
    }
    try {
      const result = await api<NonNullable<typeof preview>>("/api/calendar/preview", {
        method: "POST",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify({ calendar, revision: state.revision }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(result);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось проверить календарь.");
    } finally {
      if (!controller.signal.aborted) setPreviewBusy(false);
    }
  }

  function editPeriod(period?: CalendarPeriod) {
    if (pending) return;
    setError("");
    setPeriodDraft(period ? {
      ...period,
      allGroups: period.groupIds === null,
      groupIds: period.groupIds ?? [],
    } : blankPeriod());
  }

  function savePeriod() {
    if (!periodDraft) return;
    const trimmedName = periodDraft.name.trim();
    const proposed: CalendarPeriod = {
      id: periodDraft.id ?? id(),
      name: trimmedName,
      kind: periodDraft.kind,
      startDate: periodDraft.startDate,
      endDate: periodDraft.endDate,
      groupIds: periodDraft.allGroups ? null : periodDraft.groupIds,
    };
    const next = { ...calendar, periods: periodDraft.id
      ? calendar.periods.map((period) => period.id === periodDraft.id ? proposed : period)
      : [...calendar.periods, proposed] };
    const validation = validateCalendar(next, state.catalog);
    if (!trimmedName) return setError("Укажите название периода.");
    if (validation) return setError(validation);
    changeCalendar(next);
    setPeriodDraft(null);
  }

  async function persist(request?: Pending) {
    if (busy) return;
    const operation = pending ?? request ?? {
      calendar,
      revision: state.revision,
      requestId: id(),
      confirmLessonRemoval: Boolean(calculated?.removedCount && confirmRemoval),
    };
    setPending(operation);
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const next = await api<Partial<StateResponse> & { revision: number; calendar?: SchoolCalendar }>("/api/calendar?response=compact", {
        method: "PUT",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify(operation),
      });
      setState(current => ({ ...current, ...next }));
      setCalendar(next.calendar ?? operation.calendar);
      setPending(null);
      setPreview(null);
      setConfirmRemoval(false);
      setSaved(true);
      setDiscardPrompt(false);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && ![401, 403, 409].includes(reason.status)) setPending(null);
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить календарь.");
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    if (busy || pending || backBusy) return;
    if (dirty && !discardPrompt) {
      setError("");
      setDiscardPrompt(true);
      return;
    }
    await leaveCalendar();
  }

  async function leaveCalendar() {
    if (busy || pending || backBusy) return;
    setBackBusy(true);
    try {
      await onBack();
      setDiscardPrompt(false);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось вернуться к расписанию.");
    } finally { setBackBusy(false); }
  }

  function openGroupWeekdaysDialog() {
    setEditingOverrideGroups([]);
    setSelectedOverrideGroups([]);
    setSelectedOverrideDays([...calendar.weekdays]);
    setReturnToSchoolDefaults(false);
    setGroupWeekdaysDialog(true);
  }

  function editGroupWeekdays(groupIds: string[], days: number[]) {
    setEditingOverrideGroups(groupIds);
    setSelectedOverrideGroups(groupIds);
    setSelectedOverrideDays(days);
    setReturnToSchoolDefaults(false);
    setGroupWeekdaysDialog(true);
  }

  function applyGroupWeekdays() {
    if ((!selectedOverrideGroups.length && !editingOverrideGroups.length) || (!returnToSchoolDefaults && !selectedOverrideDays.length)) return;
    const groupWeekdays = { ...calendar.groupWeekdays };
    for (const groupId of editingOverrideGroups) delete groupWeekdays[groupId];
    for (const groupId of selectedOverrideGroups) {
      if (returnToSchoolDefaults) delete groupWeekdays[groupId];
      else groupWeekdays[groupId] = [...selectedOverrideDays];
    }
    changeCalendar({ ...calendar, groupWeekdays });
    setGroupWeekdaysDialog(false);
  }

  async function setQuarterArchived(quarterId: string, archived: boolean) {
    if (quarterBusy || busy || pending) return;
    const nextQuarters = state.quarters.map((quarter) => quarter.id === quarterId ? { ...quarter, archived } : quarter);
    setQuarterBusy(true);
    setError("");
    setQuarterSaved(false);
    try {
      const next = await api<Partial<StateResponse> & { revision: number; quarters: StateResponse["quarters"] }>("/api/plans?response=compact", {
        method: "PUT",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify({ quarters: nextQuarters, metadataOnly: true, responseQuarterId: quarterId, revision: state.revision, requestId: id() }),
      });
      const merged = { ...state, ...next };
      setState(merged);
      if (archived && selectedQuarter?.id === quarterId) {
        const replacement = visibleQuarters(merged.quarters)[0];
        setQuarterId(replacement?.id ?? "");
      }
      setQuarterSaved(true);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      setError(reason instanceof Error ? reason.message : "Не удалось изменить архив четвертей.");
    } finally { setQuarterBusy(false); }
  }

  const validationError = validateCalendar(calendar, state.catalog);

  return (
    <main className="catalog-page calendar-page">
      <AdminPageHeader title="Календарь школы" username={auth.username} onBack={back} disabled={busy || Boolean(pending)} busy={backBusy} />
      <section className="catalog-body calendar-body">
        <div className="calendar-heading"><div><h1>Календарь школы</h1><p>Четверти, каникулы и учебные дни</p></div><button className="catalog-primary" type="button" onClick={() => editPeriod()} disabled={busy || Boolean(pending)}><ActionLabel action="add">Период</ActionLabel></button></div>

        <section className="school-calendar-panel" aria-labelledby="calendar-quarters-title">
          <div className="calendar-panel-title"><strong id="calendar-quarters-title">Учебные четверти</strong><span>Для всей школы</span></div>
          <div className="calendar-quarter-controls">
            <label>Четверть<select aria-label="Четверть" value={selectedQuarter?.id ?? ""} disabled={busy || Boolean(pending) || backBusy} onChange={(event) => { setQuarterId(event.target.value); setQuarterSaved(false); }}>
              {quarters.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select></label>
            {selectedQuarter && <span className="calendar-quarter-dates">{formatDate(selectedQuarter.startDate)} — {formatDate(selectedQuarter.endDate)}</span>}
            {selectedQuarter && <button className="catalog-button calendar-quarter-archive-button" type="button" onClick={() => void setQuarterArchived(selectedQuarter.id, true)} disabled={busy || quarterBusy || Boolean(pending) || backBusy || conflict} title="Скрыть четверть в архиве">В архив</button>}
            <QuarterEditor state={state} auth={auth} onUnauthorized={onUnauthorized} quarterId={selectedQuarter?.id ?? ""}
              disabled={busy || Boolean(pending) || backBusy || conflict || quarterBusy}
              onSaved={(next, savedQuarterId) => {
                setState(next);
                setQuarterId(savedQuarterId);
                setQuarterSaved(true);
                // Keep the local calendar draft; a changed quarter invalidates its schedule preview.
                setPreview(null);
                setConfirmRemoval(false);
                setError("");
              }} />
          </div>
          <details className="calendar-active-quarters">
            <summary>Все четверти <span>· {quarters.length}</span></summary>
            <ul>{quarters.map((quarter) => <li key={quarter.id} className={quarter.id === selectedQuarter?.id ? "selected" : ""}>
              <button className="calendar-quarter-name" type="button" onClick={() => { setQuarterId(quarter.id); setQuarterSaved(false); }} disabled={busy || Boolean(pending) || backBusy} aria-current={quarter.id === selectedQuarter?.id ? "true" : undefined}>
                <strong>{quarter.name}</strong><small>{formatDate(quarter.startDate)} — {formatDate(quarter.endDate)}</small>
              </button>
              <button className="calendar-quarter-archive-button" type="button" onClick={() => void setQuarterArchived(quarter.id, true)} disabled={quarterBusy || busy || Boolean(pending) || backBusy || conflict} title={`Архивировать: ${quarter.name}`}>В архив</button>
            </li>)}</ul>
          </details>
          {archivedQuarters.length > 0 && <details className="calendar-archived-quarters">
            <summary>Архив четвертей <span>{archivedQuarters.length}</span></summary>
            <ul>{archivedQuarters.map((quarter) => <li key={quarter.id}>
              <span><strong>{quarter.name}</strong><small>{formatDate(quarter.startDate)} — {formatDate(quarter.endDate)}</small></span>
              <button type="button" onClick={() => void setQuarterArchived(quarter.id, false)} disabled={quarterBusy || busy || Boolean(pending) || backBusy}>Восстановить</button>
            </li>)}</ul>
          </details>}
          {quarterSaved && <p className="calendar-hint calendar-saved" role="status">Четверть сохранена{dirty ? ". Изменения учебных дней и каникул ещё не применены" : ""}.</p>}
        </section>

        <section className="school-calendar-panel" aria-labelledby="calendar-weekdays-title">
          <div className="calendar-panel-title"><strong id="calendar-weekdays-title">Учебные дни недели</strong><span>Общий график по умолчанию <InfoTooltip label="Общий график">Эти дни применяются ко всем группам, если для группы не задан отдельный график.</InfoTooltip></span></div>
          <div className="calendar-weekdays">
            {weekdays.map((label, index) => <label key={label} className={calendar.weekdays.includes(index + 1) ? "selected" : ""}>
              <input type="checkbox" checked={calendar.weekdays.includes(index + 1)} disabled={busy || Boolean(pending)} onChange={() => {
                const selected = new Set(calendar.weekdays);
                selected.has(index + 1) ? selected.delete(index + 1) : selected.add(index + 1);
                changeCalendar({ ...calendar, weekdays: [...selected].sort((a, b) => a - b) });
              }} />{label}
            </label>)}
          </div>
        </section>
        <section className="school-calendar-panel calendar-private-panel" aria-labelledby="calendar-private-title">
          <div className="calendar-group-weekdays">
            <div className="calendar-group-weekdays-heading"><strong id="calendar-private-title">Частные графики групп</strong><InfoTooltip label="Частные графики групп">Выбранные здесь учебные дни заменяют общий график только для указанных групп. Остальные группы используют общий график по умолчанию.</InfoTooltip></div>
            {overriddenGroups.map(({ key, groupIds, days: selectedDays }) => {
              const names = groupIds.map((groupId) => {
                const group = state.catalog.groups.find((item) => item.id === groupId);
                return `${group?.name ?? "Архивная группа"}${group?.archived ? " · архив" : ""}`;
              });
              return <div className="calendar-group-weekday-row" key={key}>
                <strong title={names.join(", ")}><span className="school-code">{names.join(", ")}</span></strong>
                <div className="calendar-weekdays compact" aria-label={`Учебные дни групп ${names.join(", ")}`}>
                  {weekdays.map((label, index) => <label key={label} className={selectedDays.includes(index + 1) ? "selected" : ""}>
                    <input type="checkbox" checked={selectedDays.includes(index + 1)} disabled={busy || Boolean(pending)} onChange={() => {
                      const selected = new Set(selectedDays);
                      selected.has(index + 1) ? selected.delete(index + 1) : selected.add(index + 1);
                      const groupWeekdays = { ...calendar.groupWeekdays };
                      for (const groupId of groupIds) groupWeekdays[groupId] = [...selected].sort((a, b) => a - b);
                      changeCalendar({ ...calendar, groupWeekdays });
                    }} />{label}
                  </label>)}
                </div>
                <button type="button" className="calendar-inherit-button" onClick={() => editGroupWeekdays(groupIds, selectedDays)} disabled={busy || Boolean(pending)}>Изменить группы</button>
                <button type="button" className="calendar-inherit-button" onClick={() => {
                  const groupWeekdays = { ...calendar.groupWeekdays };
                  for (const groupId of groupIds) delete groupWeekdays[groupId];
                  changeCalendar({ ...calendar, groupWeekdays });
                }} disabled={busy || Boolean(pending)}>По умолчанию</button>
              </div>;
            })}
            {groups.length > 0 && <div className="calendar-add-override">
              <button type="button" onClick={openGroupWeekdaysDialog} disabled={busy || Boolean(pending)}><ActionLabel action="add">Настроить график групп</ActionLabel></button>
            </div>}
          </div>
        </section>

        <section className="school-calendar-panel calendar-period-panel" aria-labelledby="calendar-period-title">
          <div className="calendar-panel-title"><strong id="calendar-period-title">Периоды</strong><span>{sortedPeriods.length}</span></div>
          {sortedPeriods.length ? <div className="calendar-table-wrap"><table className="catalog-table calendar-table"><thead><tr><th>Название</th><th>Тип</th><th>Даты</th><th>Группы</th><th /></tr></thead><tbody>
            {sortedPeriods.map((period) => <tr key={period.id}>
              <td><strong>{period.name}</strong></td><td>{kindLabel(period.kind)}</td><td>{formatDate(period.startDate)} — {formatDate(period.endDate)}</td>
              <td>{period.groupIds === null ? "Вся школа" : period.groupIds.map((groupId) => state.catalog.groups.find((group) => group.id === groupId)?.name ?? "Удалённая группа").sort(collator.compare).map((name, index, names) => <span key={`${name}-${index}`}><span className="school-code">{name}</span>{index < names.length - 1 ? ", " : ""}</span>)}</td>
              <td className="catalog-actions"><button type="button" onClick={() => editPeriod(period)} disabled={busy || Boolean(pending)}><ActionLabel action="edit">Изменить</ActionLabel></button><button type="button" className="archive" onClick={() => changeCalendar({ ...calendar, periods: calendar.periods.filter((item) => item.id !== period.id) })} disabled={busy || Boolean(pending)}><ActionLabel action="delete">Удалить</ActionLabel></button></td>
            </tr>)}
          </tbody></table></div> : <p className="calendar-empty">Периодов пока нет. Добавьте каникулы, выходные даты или дополнительные учебные дни.</p>}
        </section>

        <div className={`catalog-alert ${conflict ? "conflict" : ""}`} role="status">
          {error || (conflict ? "Данные календаря изменились. Обновите страницу и повторите изменения." : validationError || "Изменения учебных дней и каникул сохраняются после проверки и применения.")}
        </div>
        <div className="school-calendar-actions">
          <button className="catalog-button" type="button" onClick={() => void calculatePreview()} disabled={busy || previewBusy || Boolean(pending) || Boolean(validationError)}><ActionLabel action="preview">{previewBusy ? "Расчёт…" : "Проверить изменения"}</ActionLabel></button>
          {calculated && <span className="calendar-preview-summary">Изменится дней: {calculated.changedDays.length}; занятий к снятию: {calculated.removedCount}</span>}
          {saved && !dirty && <span className="calendar-saved">Календарь сохранён</span>}
        </div>

        {pending && <div className={`catalog-alert ${conflict ? "conflict" : ""}`} role="alert">
          {conflict ? <><span>Данные календаря изменились. Загрузите актуальные данные перед повторной проверкой.</span><button className="catalog-button" type="button" onClick={async () => { setBusy(true); try { const latest = await api<Partial<StateResponse> & { revision: number; calendar?: SchoolCalendar }>("/api/admin/state?view=calendar"); setState(current => ({ ...current, ...latest })); setCalendar(latest.calendar ?? defaultSchoolCalendar()); setPending(null); setPreview(null); setConflict(false); setError(""); } catch (reason) { if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized(); setError(reason instanceof Error ? reason.message : "Не удалось загрузить календарь."); } finally { setBusy(false); } }}>Загрузить актуальный календарь</button></>
            : <><span>Не удалось подтвердить сохранение. Повторите попытку.</span><button className="catalog-button" type="button" onClick={() => void persist(pending)} disabled={busy}>Повторить сохранение</button></>}
        </div>}

        {calculated && <section className="school-calendar-preview" aria-live="polite">
          <div className="calendar-preview-head"><strong>Предварительный просмотр</strong><span>Снятые занятия не восстанавливаются автоматически</span></div>
          {calculated.changedDays.length ? <div className="calendar-table-wrap"><table className="catalog-table calendar-table"><thead><tr><th>Дата</th><th>Группа</th><th>Результат</th><th>Снимется</th></tr></thead><tbody>
            {calculated.changedDays.map((change, index) => <tr key={`${change.groupId}-${change.date}-${index}`}><td>{formatDate(change.date)}</td><td><span className="school-code">{state.catalog.groups.find((group) => group.id === change.groupId)?.name ?? "Группа"}</span></td><td>{change.label}</td><td>{change.removedCount || "—"}</td></tr>)}
          </tbody></table></div> : <p className="calendar-empty">Текущее расписание не изменится. Настройки сохранятся для будущих дат и групп.</p>}
          {calculated.studyOverrideCount > 0 && <p className="calendar-override-warning">Открывается учебных дат: {calculated.studyOverrideCount}. Это включает даты, которые раньше были выходными или каникулами.</p>}
          {calculated.jointChanges.length > 0 && <div className="calendar-joint-notes">{calculated.jointChanges.map((joint) => <p key={joint.jointId}>Совместный урок: после снятия останутся {joint.remainingGroupIds.length ? joint.remainingGroupIds.map((groupId, index) => <span key={groupId}><span className="school-code">{state.catalog.groups.find((group) => group.id === groupId)?.name ?? "группа"}</span>{index < joint.remainingGroupIds.length - 1 ? ", " : ""}</span>) : "ни одной группы"}.</p>)}</div>}
          {calculated.removedCount > 0 && <label className="calendar-confirm-removal"><input type="checkbox" checked={confirmRemoval} onChange={(event) => setConfirmRemoval(event.target.checked)} /> Подтверждаю снятие {calculated.removedCount} занятий</label>}
          <button className="catalog-primary" type="button" onClick={() => void persist()} disabled={busy || Boolean(pending) || (calculated.removedCount > 0 && !confirmRemoval)}><ActionLabel action="apply">{busy ? "Применение…" : calculated.removedCount ? `Применить и снять ${calculated.removedCount} занятий` : "Применить календарь"}</ActionLabel></button>
        </section>}
      </section>

      <dialog ref={periodDialog} className="catalog-dialog calendar-dialog" aria-labelledby="calendar-dialog-title" onCancel={(event) => { if (busy || pending) event.preventDefault(); else setPeriodDraft(null); }}>
        <header><h2 id="calendar-dialog-title">{periodDraft?.id ? "Изменить период" : "Новый период"}</h2><button type="button" aria-label="Закрыть" onClick={() => setPeriodDraft(null)} disabled={busy || Boolean(pending)}>×</button></header>
        {periodDraft && <form onSubmit={(event) => { event.preventDefault(); savePeriod(); }}>
          <div className="calendar-form-fields">
            <label><span>Название</span><input ref={nameRef} maxLength={120} value={periodDraft.name} onChange={(event) => setPeriodDraft({ ...periodDraft, name: event.target.value })} placeholder="Например, осенние каникулы" /></label>
            <label><span>Тип</span><select aria-label="Тип" value={periodDraft.kind} onChange={(event) => setPeriodDraft({ ...periodDraft, kind: event.target.value as CalendarPeriod["kind"] })}><option value="holiday">Каникулы</option><option value="day-off">Неучебные дни</option><option value="study">Дополнительные учебные дни</option></select></label>
            <div className="calendar-date-field"><span>С</span><RussianDateInput label="С" value={periodDraft.startDate} onChange={(value) => setPeriodDraft({ ...periodDraft, startDate: value })} /></div>
            <div className="calendar-date-field"><span>По</span><RussianDateInput label="По" value={periodDraft.endDate} onChange={(value) => setPeriodDraft({ ...periodDraft, endDate: value })} /></div>
            <fieldset className="calendar-group-picker"><legend>Применение</legend>
              <label><input type="radio" name="calendar-scope" checked={periodDraft.allGroups} onChange={() => setPeriodDraft({ ...periodDraft, allGroups: true })} /> Вся школа, включая будущие группы</label>
              <label><input type="radio" name="calendar-scope" checked={!periodDraft.allGroups} onChange={() => setPeriodDraft({ ...periodDraft, allGroups: false, groupIds: periodDraft.groupIds.length ? periodDraft.groupIds : groups.slice(0, 1).map((group) => group.id) })} /> Выбранные группы</label>
              {!periodDraft.allGroups && <div className="calendar-group-list">{groupChoices.map((group) => <label key={group.id}><input type="checkbox" checked={periodDraft.groupIds.includes(group.id)} onChange={() => setPeriodDraft({ ...periodDraft, groupIds: periodDraft.groupIds.includes(group.id) ? periodDraft.groupIds.filter((groupId) => groupId !== group.id) : [...periodDraft.groupIds, group.id] })} /><span className="school-code">{group.name}</span>{group.archived ? " (архив)" : ""}</label>)}{periodDraft.groupIds.filter((groupId) => !state.catalog.groups.some((group) => group.id === groupId)).map((groupId) => <label key={groupId}><input type="checkbox" checked onChange={() => setPeriodDraft({ ...periodDraft, groupIds: periodDraft.groupIds.filter((item) => item !== groupId) })} />Архивная группа</label>)}</div>}
            </fieldset>
          </div>
          {error && <p className="calendar-dialog-error" role="alert">{error}</p>}
          <footer><button className="catalog-primary" type="submit" disabled={busy || Boolean(pending)}><ActionLabel action="save">Сохранить период</ActionLabel></button><button className="catalog-button" type="button" onClick={() => setPeriodDraft(null)} disabled={busy || Boolean(pending)}>Отмена</button></footer>
        </form>}
      </dialog>

      <dialog ref={groupWeekdaysDialogRef} className="catalog-dialog calendar-dialog calendar-group-weekdays-dialog" aria-labelledby="calendar-groups-dialog-title" onCancel={(event) => { if (busy || pending) event.preventDefault(); else setGroupWeekdaysDialog(false); }}>
        <header><h2 id="calendar-groups-dialog-title">{editingOverrideGroups.length ? "Изменить график групп" : "График для групп"}</h2><button type="button" aria-label="Закрыть" onClick={() => setGroupWeekdaysDialog(false)} disabled={busy || Boolean(pending)}>×</button></header>
        <div className="calendar-bulk-group-body">
          <GroupSelection groups={groups} value={selectedOverrideGroups} onChange={setSelectedOverrideGroups} disabled={busy || Boolean(pending)} label="Выберите группы" />
          <label className="calendar-return-defaults"><input type="checkbox" checked={returnToSchoolDefaults} disabled={busy || Boolean(pending)} onChange={(event) => setReturnToSchoolDefaults(event.target.checked)} /> Вернуть выбранные группы к графику школы</label>
          <div className="calendar-bulk-days"><strong>Учебные дни</strong><div className="calendar-weekdays compact">{weekdays.map((label, index) => <label key={label} className={selectedOverrideDays.includes(index + 1) ? "selected" : ""}><input type="checkbox" checked={selectedOverrideDays.includes(index + 1)} disabled={busy || Boolean(pending) || returnToSchoolDefaults} onChange={() => setSelectedOverrideDays((current) => current.includes(index + 1) ? current.filter((day) => day !== index + 1) : [...current, index + 1].sort((a, b) => a - b))} />{label}</label>)}</div></div>
          {!selectedOverrideGroups.length && !editingOverrideGroups.length && <p className="calendar-dialog-error" role="status">Выберите хотя бы одну группу.</p>}
          {!returnToSchoolDefaults && !selectedOverrideDays.length && <p className="calendar-dialog-error" role="status">Выберите хотя бы один учебный день.</p>}
        </div>
        <footer><button className="catalog-primary" type="button" onClick={applyGroupWeekdays} disabled={busy || Boolean(pending) || (!selectedOverrideGroups.length && !editingOverrideGroups.length) || (!returnToSchoolDefaults && !selectedOverrideDays.length)}><ActionLabel action="apply">Применить к выбранным</ActionLabel></button><button className="catalog-button" type="button" onClick={() => setGroupWeekdaysDialog(false)} disabled={busy || Boolean(pending)}>Отмена</button></footer>
      </dialog>

      <dialog ref={discardDialogRef} className="catalog-dialog calendar-discard-dialog" aria-labelledby="calendar-discard-title" onCancel={(event) => { if (backBusy) event.preventDefault(); else setDiscardPrompt(false); }}>
        <h2 id="calendar-discard-title">Есть несохранённые изменения</h2>
        <p>При возврате к расписанию эти изменения не сохранятся.</p>
        {error && <p className="calendar-discard-error" role="alert">{error}</p>}
        <footer><button className="catalog-button" type="button" onClick={() => setDiscardPrompt(false)} autoFocus disabled={backBusy}>Остаться</button><button className="catalog-primary" type="button" onClick={() => void leaveCalendar()} disabled={backBusy}>{backBusy ? "Выход…" : "Не сохранять"}</button></footer>
      </dialog>
    </main>
  );
}
