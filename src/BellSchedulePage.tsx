import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import GroupSelection from "./GroupSelection";
import InfoTooltip from "./InfoTooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts";
import { visibleQuarters } from "../shared/plans";
import RussianDateInput from "./RussianDateInput";
import {
  defaultBellSettings,
  validateBellSettings,
  type BellApplyOptions,
  type BellProfile,
  type BellSettings,
} from "../shared/bellSchedule";
import "./bell-schedule.css";

type Props = {
  initialState: StateResponse;
  auth: AuthSession;
  onUnauthorized: () => void;
  onBack: () => Promise<void>;
  initialGroupId?: string;
  initialQuarterId?: string;
};
type Pending = { settings: BellSettings; apply?: BellApplyOptions; revision: number; requestId: string };
type Preview = Omit<import("../shared/bellSchedule.ts").BellApplyResult, "schedule">;

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const makeId = () => crypto.randomUUID();
const dateText = (date: string) => new Intl.DateTimeFormat("ru", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const timeValue = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const timeSpan = (times: Array<{ start: number; duration: number }>) => times.length
  ? `${timeValue(times[0].start)}–${timeValue(times[times.length - 1].start + times[times.length - 1].duration)}`
  : "—";
const timeList = (times: Array<{ start: number; duration: number }>) => times.map((time) => `${timeValue(time.start)}–${timeValue(time.start + time.duration)}`);
const parseTime = (value: string) => {
  if (!/^\d{1,2}:\d{2}$/.test(value)) return Number.NaN;
  const [hours, minutes] = value.split(":").map(Number);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : Number.NaN;
};

function BellTimeInput({ value, disabled, onChange }: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? timeValue(value) : "");
  useEffect(() => {
    if (Number.isFinite(value)) setText(timeValue(value));
  }, [value]);
  return <input type="text" inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5}
    className="bell-time-input" value={text} disabled={disabled}
    onChange={(event) => {
      setText(event.target.value);
      onChange(parseTime(event.target.value));
    }} />;
}

function ProfileFields({ profile, onChange, disabled, idPrefix }: {
  profile: BellProfile;
  onChange: (next: BellProfile) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const setBreak = (index: number, value: number) => onChange({ ...profile, breaks: profile.breaks.map((item, i) => i === index ? value : item) });
  return <div className="bell-profile-fields">
    <label><span>Начало первого урока</span><BellTimeInput value={profile.start} disabled={disabled} onChange={(start) => onChange({ ...profile, start })} /></label>
    <label><span>Урок, минут</span><input type="number" min={1} max={180} step={1} value={profile.duration} disabled={disabled} onChange={(event) => onChange({ ...profile, duration: Number(event.target.value) })} /></label>
    <div className="bell-breaks-field"><span>Перемены</span><div className="bell-break-list">
      {profile.breaks.map((minutes, index) => <label key={`${idPrefix}-${index}`}><span>{index + 1} → {index + 2}</span><input aria-label={`Перемена ${index + 1} → ${index + 2}, минут`} type="number" min={0} max={240} step={1} value={minutes} disabled={disabled} onChange={(event) => setBreak(index, Number(event.target.value))} /><span>мин</span><button type="button" aria-label={`Удалить перемену ${index + 1} → ${index + 2}`} disabled={disabled || profile.breaks.length <= 1} onClick={() => onChange({ ...profile, breaks: profile.breaks.filter((_, i) => i !== index) })}>×</button></label>)}
      {profile.breaks.length < 11 && <button type="button" className="bell-add-break" disabled={disabled} onClick={() => onChange({ ...profile, breaks: [...profile.breaks, 10] })}><ActionLabel action="add">Перемена</ActionLabel></button>}
    </div></div>
  </div>;
}

export default function BellSchedulePage({ initialState, auth, onUnauthorized, onBack, initialGroupId, initialQuarterId }: Props) {
  const [state, setState] = useState(initialState);
  const [settings, setSettings] = useState<BellSettings>(initialState.bellSettings ?? defaultBellSettings());
  const groups = useMemo(() => state.catalog.groups.filter((group) => !group.archived).slice().sort((a, b) => collator.compare(a.name, b.name)), [state.catalog.groups]);
  const quarters = useMemo(() => visibleQuarters(state.quarters), [state.quarters]);
  const today = new Date().toLocaleDateString("sv-SE");
  const activeQuarter = quarters.find((quarter) => quarter.startDate <= today && quarter.endDate >= today) ?? quarters[0];
  const contextGroupId = groups.some((group) => group.id === initialGroupId) ? initialGroupId! : groups[0]?.id ?? "";
  const contextQuarter = quarters.find((quarter) => quarter.id === initialQuarterId) ?? activeQuarter;
  const [selectedGroups, setSelectedGroups] = useState<string[]>(contextGroupId ? [contextGroupId] : []);
  const [startDate, setStartDate] = useState(contextQuarter?.startDate ?? today);
  const [endDate, setEndDate] = useState(contextQuarter?.endDate ?? today);
  const [replaceStart, setReplaceStart] = useState(false);
  const [resetBreaks, setResetBreaks] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const dateFields = useRef<HTMLFieldSetElement>(null);

  const persistedSettings = state.bellSettings ?? defaultBellSettings();
  const dirty = JSON.stringify(settings) !== JSON.stringify(persistedSettings);
  const validationError = validateBellSettings(settings, state.catalog);
  useEffect(() => {
    setSelectedGroups((current) => current.filter((id) => groups.some((group) => group.id === id)));
  }, [groups]);

  useEffect(() => {
    const dialog = discardDialog.current;
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

  function invalidate() {
    previewController.current?.abort();
    previewController.current = null;
    setPreview(null);
    setPreviewBusy(false);
    setError("");
    setConflict(false);
    setSaved(false);
  }

  function updateSettings(next: BellSettings) {
    if (pending) return;
    setSettings(next);
    invalidate();
  }

  function updateSchool(profile: BellProfile) {
    updateSettings({ ...settings, school: profile });
  }

  function options(): BellApplyOptions {
    return { groupIds: [...selectedGroups], startDate, endDate, replaceStart, resetBreaks };
  }

  async function calculatePreview() {
    invalidate();
    const invalidDate = [...(dateFields.current?.querySelectorAll("input") ?? [])]
      .find((input) => !input.checkValidity());
    if (invalidDate) {
      invalidDate.reportValidity();
      setError("Проверьте даты периода применения.");
      return;
    }
    if (validationError) { setError(validationError); return; }
    if (!selectedGroups.length) { setError("Выберите хотя бы одну группу."); return; }
    if (!startDate || !endDate || endDate < startDate) { setError("Проверьте начало и конец периода."); return; }
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewBusy(true);
    try {
      const result = await api<Preview>("/api/bell-settings/preview", {
        method: "POST",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify({ settings, apply: options(), revision: state.revision }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(result);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось рассчитать применение звонков.");
    } finally {
      if (!controller.signal.aborted) setPreviewBusy(false);
    }
  }

  async function persist(request?: Pending, includeApply = false) {
    if (busy) return;
    const operation = pending ?? request ?? {
      settings,
      ...(includeApply && preview ? { apply: options() } : {}),
      revision: state.revision,
      requestId: makeId(),
    };
    setPending(operation);
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const next = await api<Partial<StateResponse> & { revision: number; updatedAt?: string; bellSettings?: BellSettings }>("/api/bell-settings?response=compact", {
        method: "PUT",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify(operation),
      });
      setState(current => ({ ...current, ...next }));
      setSettings(next.bellSettings ?? operation.settings);
      setPending(null);
      setPreview(null);
      setSaved(true);
      setDiscardPrompt(false);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && ![401, 403, 409].includes(reason.status)) setPending(null);
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить настройки звонков.");
    } finally { setBusy(false); }
  }

  async function leave() {
    if (busy || pending || backBusy) return;
    setBackBusy(true);
    try { await onBack(); setDiscardPrompt(false); }
    catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось вернуться к расписанию.");
    } finally { setBackBusy(false); }
  }

  function back() {
    if (busy || pending || backBusy) return;
    if (dirty) { setError(""); setDiscardPrompt(true); return; }
    void leave();
  }

  async function reloadLatest() {
    setBusy(true);
    try {
      const latest = await api<Partial<StateResponse> & { revision: number; bellSettings?: BellSettings }>("/api/admin/state?view=bells");
      setState(current => ({ ...current, ...latest }));
      setSettings(latest.bellSettings ?? defaultBellSettings());
      setPending(null);
      setPreview(null);
      setConflict(false);
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить актуальные настройки.");
    } finally { setBusy(false); }
  }

  async function returnAfterConflict() {
    setPending(null);
    setConflict(false);
    if (dirty) { setDiscardPrompt(true); return; }
    setBackBusy(true);
    try { await onBack(); }
    catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось вернуться к расписанию.");
    } finally { setBackBusy(false); }
  }

  const applyPreview = preview;
  return <main className="catalog-page bell-page">
    <AdminPageHeader title="Время и перемены" username={auth.username} onBack={back} disabled={busy || Boolean(pending)} busy={backBusy} />
    <section className="catalog-body bell-body">
      <div className="bell-heading"><div><h1>Время и перемены <InfoTooltip label="Общие настройки звонков">Настройте общее расписание звонков; существующее расписание меняется только при применении.</InfoTooltip></h1></div><button className="catalog-primary" type="button" onClick={() => void persist()} disabled={!dirty || busy || Boolean(pending) || Boolean(validationError)}><ActionLabel action="save">Сохранить настройки</ActionLabel></button></div>

      <section className="bell-panel" aria-labelledby="bell-school-heading">
        <div className="bell-panel-heading"><div><h2 id="bell-school-heading">Общие настройки звонков <InfoTooltip label="Общие настройки звонков">Эти настройки используются для всех групп и новых дней.</InfoTooltip></h2></div><span>Общие</span></div>
        <ProfileFields profile={settings.school} onChange={updateSchool} disabled={busy || Boolean(pending)} idPrefix="school" />
      </section>

      <details className="bell-apply-panel">
        <summary>Применить настройки к расписанию <InfoTooltip label="О применении настроек">Применение изменит время существующих занятий в выбранном периоде. Перед записью можно проверить список изменений.</InfoTooltip></summary>
        <div className="bell-apply-content">
          <div className="bell-apply-grid">
          <div className="bell-apply-groups"><GroupSelection groups={groups} value={selectedGroups} onChange={(ids) => { setSelectedGroups(ids); invalidate(); }} disabled={busy || Boolean(pending)} label="Группы" /></div>
          <div className="bell-apply-settings"><fieldset ref={dateFields} className="bell-date-range" onInputCapture={invalidate} disabled={busy || Boolean(pending)}><legend className="bell-visually-hidden">Период применения</legend><label><span>С даты</span><RussianDateInput label="С даты" value={startDate} onChange={(value) => { setStartDate(value); invalidate(); }} /></label><label><span>По дату</span><RussianDateInput label="По дату" value={endDate} onChange={(value) => { setEndDate(value); invalidate(); }} /></label><span className="bell-quarter-hint">Четверть: {contextQuarter ? `${contextQuarter.name}, ${dateText(contextQuarter.startDate)} — ${dateText(contextQuarter.endDate)}` : "не задана"}</span></fieldset>
          <div className="bell-apply-options"><label><input type="checkbox" checked={replaceStart} disabled={busy || Boolean(pending)} onChange={(event) => { setReplaceStart(event.target.checked); invalidate(); }} /> Заменить начало уроков в заполненных днях</label><label><input type="checkbox" checked={resetBreaks} disabled={busy || Boolean(pending)} onChange={(event) => { setResetBreaks(event.target.checked); invalidate(); }} /> Заменить перемены в заполненных днях</label></div></div></div>
          <div className="bell-action-row"><button className="catalog-button" type="button" onClick={() => void calculatePreview()} disabled={busy || previewBusy || Boolean(pending) || Boolean(validationError)}><ActionLabel action="preview">{previewBusy ? "Расчёт…" : "Проверить изменения"}</ActionLabel></button>{dirty && <button className="catalog-primary" type="button" onClick={() => void persist()} disabled={busy || previewBusy || Boolean(pending) || Boolean(validationError)}><ActionLabel action="save">Сохранить только настройки</ActionLabel></button>}</div>
        </div>
      </details>

      <div className={`catalog-alert ${error || validationError ? "conflict" : dirty ? "" : "bell-status"}`} role={error || validationError ? "alert" : "status"}>{error || validationError || (saved ? "Настройки сохранены." : dirty ? "Есть несохранённые настройки." : "Школьные настройки применяются к новым дням автоматически.")}</div>
      {pending && !busy && <div className={`catalog-alert ${conflict ? "conflict" : ""}`} role="alert">{conflict ? <><span>Настройки изменились в другом окне. Загрузите актуальные данные перед повтором.</span><button className="catalog-button" type="button" onClick={() => void reloadLatest()} disabled={busy}>Загрузить актуальные</button><button className="catalog-button" type="button" onClick={() => void returnAfterConflict()} disabled={busy || backBusy}>К расписанию</button></> : <><span>Не удалось подтвердить сохранение. Можно повторить тот же запрос.</span><button className="catalog-button" type="button" onClick={() => void persist(pending)} disabled={busy}>Повторить</button></>}</div>}

      {applyPreview && <section className="bell-preview" aria-live="polite">
        <div className="bell-preview-heading"><h2>Предварительный просмотр</h2><span>Дней: {applyPreview.changedDays.length} · занятий: {applyPreview.changedLessons}</span></div>
        {applyPreview.manualChanges > 0 && <p className="bell-warning">Затронуто уроков с ручными настройками времени: {applyPreview.manualChanges}.</p>}
        {applyPreview.changedDays.length ? <div className="bell-table-wrap"><table><thead><tr><th>Дата</th><th>Группа</th><th>Занятий</th><th>Было</th><th>Станет</th><th>Ячеек вручную</th></tr></thead><tbody>{applyPreview.changedDays.map((change, index) => <tr key={`${change.groupId}-${change.date}-${index}`}>
          <td>{dateText(change.date)}</td><td>{state.catalog.groups.find((group) => group.id === change.groupId)?.name ?? "Группа"}</td><td>{change.lessonCount}</td>
          <td><details className="bell-time-details"><summary>{timeSpan(change.before)}</summary><ol>{timeList(change.before).map((time, timeIndex) => <li key={timeIndex}>{time}</li>)}</ol></details></td>
          <td><details className="bell-time-details"><summary>{timeSpan(change.after)}</summary><ol>{timeList(change.after).map((time, timeIndex) => <li key={timeIndex}>{time}</li>)}</ol></details></td>
          <td>{change.manualChanges || "—"}</td>
        </tr>)}</tbody></table></div> : <p className="bell-muted">В этом диапазоне нет дней, требующих изменения.</p>}
        <button className="catalog-primary" type="button" onClick={() => void persist(undefined, true)} disabled={busy || Boolean(pending) || Boolean(validationError) || !selectedGroups.length}><ActionLabel action="apply">{busy ? "Применение…" : "Сохранить и применить"}</ActionLabel></button>
      </section>}
    </section>
    <dialog ref={discardDialog} className="catalog-dialog bell-discard-dialog" aria-labelledby="bell-discard-title" onCancel={(event) => { if (backBusy) event.preventDefault(); else setDiscardPrompt(false); }}><h2 id="bell-discard-title">Есть несохранённые изменения</h2><p>При возврате к расписанию общие настройки не сохранятся.</p>{error && <p className="bell-error" role="alert">{error}</p>}<footer><button className="catalog-button" type="button" onClick={() => setDiscardPrompt(false)} autoFocus disabled={backBusy}>Остаться</button><button className="catalog-primary" type="button" onClick={() => void leave()} disabled={backBusy}>{backBusy ? "Выход…" : "Не сохранять"}</button></footer></dialog>
  </main>;
}
