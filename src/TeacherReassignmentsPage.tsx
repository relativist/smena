import { teacherInitials } from "../shared/catalog";
import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import InfoTooltip from "./InfoTooltip";
import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type AuthSession } from "./api.ts";
import type { StateResponse, TeacherReassignmentReceipt } from "../server/contracts.ts";
import { collectReassignmentLessons, type ReassignmentLesson, type TeacherReassignmentRequest, type TeacherReassignmentPreview } from "../shared/teacherReassignment.ts";
import type { ReplacementRequest } from "../shared/automaticTeacherReplacement.ts";
import { visibleQuarters } from "../shared/plans.ts";
import AutomaticTeacherReplacementDialog from "./AutomaticTeacherReplacementDialog.tsx";
import RussianDateInput from "./RussianDateInput.tsx";
import SearchSelect from "./SearchSelect.tsx";
import { loadPercent } from "../shared/teacherLoadPeriods.ts";
import "./teacher-reassignments.css";

export type TeacherReassignmentsContext = { teacherId?: string; ruleId?: string; subjectId?: string; groupIds?: string[]; mode?: "absence" };
type Props = { initialState: StateResponse; auth: AuthSession; onUnauthorized: () => void; onBack: () => Promise<void>; initialQuarterId?: string; initialContext?: TeacherReassignmentsContext };
type CompactPreview = Omit<TeacherReassignmentPreview, "schedule" | "catalog">;
type PreviewResponse = { revision: number; preview: CompactPreview };
type ReassignmentPageData = Pick<StateResponse, "revision" | "updatedAt" | "schedule" | "teacherLessonOrigins" | "teachingAssignments"> & { taughtSubjectIds: string[] };
type QuarterLoad = Record<string, { lessons: number; target: number; percent: number | null }>;
type QuarterLoadResponse = { target: number; teachers: Array<{ id: string; lessons: number; percent: number | null }> };
type ApplyResponse = (TeacherReassignmentReceipt & { operationId: string }) | { state: StateResponse; operationId: string };
type UndoResponse = TeacherReassignmentReceipt | { state: StateResponse };
type AssignRequest = Extract<TeacherReassignmentRequest, { mode: "assign" }>;
type DialogState = { request: AssignRequest; title: string };
type Pending = { path: string; body: Record<string, unknown>; kind: "apply" | "undo" };

const isoToday = () => new Date().toLocaleDateString("sv-SE");
const addDays = (date: string, count: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
const monday = (date: string) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const clock = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const nameOf = (values: { id: string; name: string }[], id?: string) => id ? values.find(v => v.id === id)?.name ?? id : "Не назначен";
const compactTeacherName = (teachers: { id: string; name: string }[], id?: string) => {
  const teacher = teachers.find(entry => entry.id === id);
  return teacher ? teacherInitials(teacher.name) : nameOf(teachers, id);
};
const id = () => crypto.randomUUID();
const sortRu = (a: string, b: string) => a.localeCompare(b, "ru", { sensitivity: "base", numeric: true });
const percentLabel = (value: number | null) => value === null ? "—" : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)}%`;

function ReassignDialog({ state, auth, initial, onUnauthorized, onClose, onStateChange, onRefresh, quarterLoad }: { state: StateResponse; auth: AuthSession; initial: DialogState; onUnauthorized: () => void; onClose: () => void; onStateChange: (state: StateResponse) => void; onRefresh: () => Promise<StateResponse>; quarterLoad: QuarterLoad }) {
  const ref = useRef<HTMLDialogElement>(null);
  const controlsRef = useRef<HTMLFormElement>(null);
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<Pending | null>(null);
  const [request, setRequest] = useState<AssignRequest>(initial.request);
  const [preview, setPreview] = useState<CompactPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [previewRequest, setPreviewRequest] = useState<AssignRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [ack, setAck] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [applied, setApplied] = useState(false);
  const [success, setSuccess] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [dateEditing, setDateEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showRowTeachers, setShowRowTeachers] = useState(false);

  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => { abort.current?.abort(); if (el?.open) el.close(); }; }, []);
  const candidates = preview?.candidates ?? [];
  const availableCandidates = candidates.filter(candidate => candidate.available > 0);
  const chosenTarget = request.targetTeacherId;
  const resultUnits = preview?.units ?? [];
  const sourceLessons = useMemo(() => collectReassignmentLessons(state.schedule, state.catalog, state.teacherLessonOrigins), [state.schedule, state.catalog, state.teacherLessonOrigins]);
  const skipped = preview?.skipped.length ?? 0;
  const eligible = resultUnits.filter(unit => unit.teacherId && !unit.reason);
  const canClose = !busy && !uncertain;
  const sameSelection = previewRequest && JSON.stringify({ ...previewRequest, unitTeacherIds: undefined }) === JSON.stringify({ ...request, unitTeacherIds: undefined });
  const changedUnits = sameSelection ? resultUnits.filter(unit =>
    Object.hasOwn(previewRequest.unitTeacherIds ?? {}, unit.id) !== Object.hasOwn(request.unitTeacherIds ?? {}, unit.id)
    || previewRequest.unitTeacherIds?.[unit.id] !== request.unitTeacherIds?.[unit.id]) : resultUnits;
  const pendingUnitIds = new Set(resultUnits.filter(unit => !sameSelection || changedUnits.some(changed =>
    changed.id === unit.id || changed.date === unit.date && (changed.start < unit.end && unit.start < changed.end
      || changed.groupIds.some(groupId => unit.groupIds.includes(groupId))))).map(unit => unit.id));

  async function load(next = request, revision = state.revision) {
    if (pending.current || applied || dateEditing || !controlsRef.current?.checkValidity()) return;
    const version = ++seq.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setLoading(true); setError(""); setStale(false); setAck(false);
    try {
      const result = await api<PreviewResponse>("/api/teacher-reassignments/preview?response=compact", { method: "POST", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify({ revision, request: next }), signal: controller.signal });
      if (seq.current !== version) return;
      setPreview(result.preview); setPreviewRevision(result.revision); setPreviewKey(JSON.stringify(next)); setPreviewRequest(next);
    } catch (reason) {
      if (seq.current !== version || reason instanceof ApiError && reason.status === 0 && controller.signal.aborted) return;
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) { onUnauthorized(); return; }
      setError(reason instanceof Error ? reason.message : "Не удалось подготовить предпросмотр.");
      if (reason instanceof ApiError && reason.status === 409) setStale(true);
    } finally { if (seq.current === version) setLoading(false); }
  }
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    // Coalesce quick choices before starting CPU work on the server.
    const timer = setTimeout(() => { if (!applied && !dateEditing) void load(request); }, 60);
    return () => { clearTimeout(timer); abort.current?.abort(); };
  }, [requestKey, state.revision, applied, dateEditing, refreshKey]);

  function update(next: AssignRequest) {
    if (pending.current || busy || applied) return;
    const selectionKeys = ["quarterId", "subjectId", "sourceTeacherId", "scope", "lessonId", "weekStart", "startDate", "endDate"] as const;
    const selectionChanged = selectionKeys.some(key => request[key] !== next[key])
      || JSON.stringify(request.groupIds ?? []) !== JSON.stringify(next.groupIds ?? [])
      || JSON.stringify(request.lessonIds ?? []) !== JSON.stringify(next.lessonIds ?? []);
    if (selectionChanged) next = { ...next, unitTeacherIds: undefined };
    setRequest(next); setError(""); setSuccess(""); setAck(false);
  }
  async function refresh() {
    setBusy(true); setError("");
    try { const fresh = await onRefresh(); onStateChange(fresh); setStale(false); setPreview(null); setPreviewRevision(null); setRefreshKey(current => current + 1); }
    catch (reason) { if (reason instanceof ApiError && [401,403].includes(reason.status)) onUnauthorized(); setError(reason instanceof Error ? reason.message : "Не удалось обновить данные."); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (pending.current || uncertain || !controlsRef.current?.reportValidity() || !preview || previewKey !== requestKey || previewRevision !== state.revision || stale || loading || busy || applied || dateEditing) return;
    const expectedUnits = eligible.map(unit => ({ unitId: unit.id, teacherId: unit.teacherId! }));
    if (preview.skipped.length && !ack) return;
    if (!expectedUnits.length) return;
    pending.current = { kind: "apply", path: "/api/teacher-reassignments/apply", body: { revision: previewRevision, requestId: id(), request, expectedUnits } };
    await send();
  }
  async function undo() {
    if (!operationId || busy || uncertain) return;
    pending.current ??= { kind: "undo", path: `/api/teacher-reassignments/${encodeURIComponent(operationId)}/undo`, body: { revision: state.revision, requestId: id() } };
    await send();
  }
  async function send() {
    const write = pending.current; if (!write) return;
    setBusy(true); setError("");
    try {
      if (write.kind === "apply") {
        const result = await api<ApplyResponse>(`${write.path}?response=receipt`, { method: "POST", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify(write.body) });
        if (!result.operationId) throw new Error("Сервер не подтвердил идентификатор операции.");
        pending.current = null; setUncertain(false); setApplied(true); setOperationId(result.operationId); onStateChange("state" in result ? result.state : { ...state, revision: result.revision, updatedAt: result.updatedAt }); setSuccess("Замены сохранены в черновике."); setPreview(null); setPreviewRevision(null);
      } else {
        const result = await api<UndoResponse>(`${write.path}?response=receipt`, { method: "POST", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify(write.body) });
        pending.current = null; setUncertain(false); setApplied(false); setOperationId(""); onStateChange("state" in result ? result.state : { ...state, revision: result.revision, updatedAt: result.updatedAt }); setSuccess("Операция отменена.");
      }
    } catch (reason) {
      if (reason instanceof ApiError && [401,403].includes(reason.status)) { pending.current = null; setUncertain(false); onUnauthorized(); }
      else if (reason instanceof ApiError && reason.status === 409) { pending.current = null; setUncertain(false); setStale(true); setError(reason.message); }
      else if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) { pending.current = null; setUncertain(false); setError(reason.message); }
      else { setUncertain(true); setError(`${reason instanceof Error ? reason.message : "Результат операции неизвестен"} Повторите тот же запрос.`); }
    } finally { setBusy(false); }
  }

  const projectedLoadChanges = (() => {
    if (!preview) return [];
    const changes = new Map<string, number>();
    for (const unit of eligible) {
      const currentTeacherId = sourceLessons.find(lesson => lesson.lessonIds.some(lessonId => unit.lessonIds.includes(lessonId)))?.teacherId;
      const nextTeacherId = unit.teacherId;
      if (currentTeacherId && currentTeacherId !== nextTeacherId) changes.set(currentTeacherId, (changes.get(currentTeacherId) ?? 0) - 1);
      if (nextTeacherId && currentTeacherId !== nextTeacherId) changes.set(nextTeacherId, (changes.get(nextTeacherId) ?? 0) + 1);
    }
    return [...changes].flatMap(([teacherId, delta]) => {
      const load = quarterLoad[teacherId];
      return load ? [{ teacherId, before: load.percent, after: loadPercent(Math.max(0, load.lessons + delta), load.target) }] : [];
    });
  })();
  return <dialog ref={ref} className="tr-dialog" aria-labelledby="tr-dialog-title" onCancel={event => { event.preventDefault(); if (canClose) onClose(); }}>
    <header className="tr-dialog-head"><div><p>Проверка перед изменением расписания</p><h2 id="tr-dialog-title">{initial.title}</h2></div><button type="button" aria-label="Закрыть" disabled={!canClose} onClick={onClose}>×</button></header>
    <div className="tr-dialog-content" aria-live="polite">
      <form ref={controlsRef} onSubmit={event => event.preventDefault()} onInput={event => {
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== "text") return;
        setDateEditing(true);
        setPreview(null);
        setPreviewRevision(null);
        seq.current += 1;
        abort.current?.abort();
        setLoading(false);
      }}>
      <fieldset className="tr-dialog-controls" disabled={busy || applied || uncertain}>
      <div className="tr-dialog-context"><strong>{nameOf(state.catalog.subjects, request.subjectId)}</strong><span>{(request.groupIds ?? []).map(groupId => nameOf(state.catalog.groups, groupId)).join(", ")}</span></div>
      <div className="tr-dialog-summary"><span>Период: <b>{request.scope === "lesson" ? dayLabel(sourceLessons.find(lesson => lesson.lessonIds.includes(request.lessonId ?? ""))?.date ?? isoToday()) : request.scope === "week" ? `${dayLabel(request.weekStart!)} – ${dayLabel(addDays(request.weekStart!, 6))}` : request.endDate === null ? `${dayLabel(request.startDate!)} · без конечной даты` : `${dayLabel(request.startDate!)} – ${dayLabel(request.endDate ?? state.quarters.find(q => q.id === request.quarterId)?.endDate ?? request.startDate!)}`}</b></span><span>Уроков: <b>{preview?.units.length ?? "…"}</b></span></div>
      {request.scope === "period" && <div className="tr-period-controls">
        <div className="tr-date-pair">{(["startDate", "endDate"] as const).filter(field => field !== "endDate" || request.endDate !== null).map(field => <div key={field} className="tr-field"><span>{field === "startDate" ? "С даты" : "По дату"}</span><div onInput={event => { if (event.target instanceof HTMLInputElement && event.target.type === "text") { setDateEditing(true); setPreview(null); setPreviewRevision(null); setAck(false); seq.current += 1; abort.current?.abort(); setLoading(false); } }}><RussianDateInput label={field === "startDate" ? "С даты" : "По дату"} value={request[field] ?? ""} onChange={value => { if (field === "startDate" && !value) { setDateEditing(true); return; } setDateEditing(false); update({ ...request, [field]: value || null }); }} /></div></div>)}</div>
        <div className="tr-period-options"><label className="tr-check"><input type="checkbox" checked={request.endDate === null} disabled={busy || applied} onChange={event => update({ ...request, endDate: event.target.checked ? null : state.quarters.find(q => q.id === request.quarterId)?.endDate ?? request.startDate ?? "" })}/>Без конечной даты</label><InfoTooltip label="Срок назначения">Конечная дата включается в период замены. Без конечной даты передача продолжится в следующих четвертях до нового назначения.</InfoTooltip><button type="button" className="tr-secondary tr-quarter-shortcut" disabled={busy || applied} onClick={() => update({ ...request, startDate: state.quarters.find(q => q.id === request.quarterId)?.startDate ?? request.startDate, endDate: state.quarters.find(q => q.id === request.quarterId)?.endDate ?? request.endDate })}>Вся четверть</button></div>
        {request.endDate === null && <p className="tr-policy-warning" role="status">Замена затрагивает и следующие четверти.</p>}
      </div>}
      <div className="tr-field"><span className="tr-inline-help">Новый преподаватель<InfoTooltip label="Выбор нового преподавателя">Проверяются предмет, недоступность и занятость в других группах. Дата, время и кабинет уроков сохраняются.</InfoTooltip></span><select aria-label="Новый преподаватель" value={chosenTarget ?? ""} disabled={busy || applied || availableCandidates.length === 0} onChange={event => update({ ...request, targetTeacherId: event.target.value || undefined, unitTeacherIds: undefined })}><option value="">Выберите преподавателя</option>{chosenTarget && !availableCandidates.some(candidate => candidate.id === chosenTarget) && <option value={chosenTarget} disabled>{nameOf(state.catalog.teachers, chosenTarget)} · нет доступных занятий</option>}{availableCandidates.map(candidate => { const load = quarterLoad[candidate.id]; const after = load ? loadPercent(load.lessons + candidate.available, load.target) : null; const fmt = (pct: number | null) => pct === null ? "—" : `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(pct)}%`; return <option key={candidate.id} value={candidate.id}>{candidate.name}{load ? ` · ${fmt(load.percent)} → ${fmt(after)}` : " · нагрузка загружается"} · подходит для {candidate.available} из {candidate.total}</option>; })}</select></div>
      {skipped > 0 && candidates.find(candidate => candidate.id === chosenTarget)?.reason && <p className="tr-policy-warning" role="status">{candidates.find(candidate => candidate.id === chosenTarget)?.reason}</p>}
      {projectedLoadChanges.length > 0 && <div className="tr-load-delta" aria-live="polite"><span>Нагрузка за четверть после замены</span>{projectedLoadChanges.map(change => <strong key={change.teacherId}>{nameOf(state.catalog.teachers, change.teacherId)}: {percentLabel(change.before)} → {percentLabel(change.after)}</strong>)}</div>}
      {request.scope !== "lesson" && <div className="tr-inline-help"><label className="tr-check"><input type="checkbox" checked={request.persist !== false} disabled={busy || applied} onChange={event => update({ ...request, persist: event.target.checked })}/>Учитывать при автосоставлении</label><InfoTooltip label="Учитывать замену при автосоставлении">Повторное составление использует принятое назначение в его датах. Без галочки меняются только уже выбранные уроки.</InfoTooltip></div>}
      {request.scope !== "lesson" && request.persist !== false && request.unitTeacherIds !== undefined && <p className="tr-dialog-hint">Назначения по урокам будут учитываться только в даты этих уроков.</p>}
      {preview?.policyWarnings?.map((warning, index) => <p key={`policy-${index}`} className="tr-dialog-hint tr-policy-warning" role="status">{warning}</p>)}
      </fieldset>
      </form>
      {loading && <p className="tr-loading">Проверяем выбранные занятия…</p>}
      {error && <p className="tr-error" role="alert">{error}</p>}
      {stale && <button className="tr-secondary" type="button" disabled={busy} onClick={() => void refresh()}>Обновить данные</button>}
      {preview && previewRevision === state.revision && <>
        <div className="tr-counts"><span>{!chosenTarget && !Object.values(request.unitTeacherIds ?? {}).some(Boolean) ? "Найдено занятий" : "Готово к применению"}: <b>{!chosenTarget && !Object.values(request.unitTeacherIds ?? {}).some(Boolean) ? resultUnits.length : eligible.length}</b></span><span>Нужно проверить: <b>{skipped}</b></span>{!chosenTarget && <span>Доступных преподавателей: <b>{availableCandidates.length}</b></span>}</div>
        {skipped > 0 && <label className="tr-check"><input type="checkbox" checked={ack} disabled={busy || applied} onChange={event => setAck(event.target.checked)}/>Применить подходящие уроки, оставив пропущенные без изменений</label>}
        <div className="tr-inline-help tr-individual-controls"><button type="button" className="tr-secondary" aria-expanded={showRowTeachers} aria-controls="tr-individual-choices" disabled={busy || uncertain || applied} onClick={() => setShowRowTeachers(value => !value)}>Назначить по урокам{Object.keys(request.unitTeacherIds ?? {}).length > 0 ? ` · ${Object.keys(request.unitTeacherIds ?? {}).length}` : ""}</button><InfoTooltip label="Разные преподаватели по урокам">Раскройте выбор, если отдельным урокам нужны другие преподаватели. Общий выбор используется для остальных уроков. Сворачивание сохраняет сделанные назначения.</InfoTooltip></div>
        <div id="tr-individual-choices" className="tr-preview-scroll" role="region" aria-label="Предпросмотр переназначений" aria-busy={loading || previewKey !== requestKey} tabIndex={0}><table><thead><tr><th>Дата и время</th><th>Группа</th><th>Было</th><th>Станет</th><th>{showRowTeachers ? "Выбор по урокам" : "Проверка"}</th></tr></thead><tbody>{preview.units.map(unit => {
          const current = sourceLessons.find(lesson => lesson.lessonIds.some(lessonId => unit.lessonIds.includes(lessonId)))?.teacherId;
          const hasManual = Object.prototype.hasOwnProperty.call(request.unitTeacherIds ?? {}, unit.id);
          const manualTarget = hasManual ? request.unitTeacherIds?.[unit.id] : chosenTarget;
          const rowTarget = !hasManual ? "__default__" : manualTarget === null ? "__skip__" : manualTarget ?? "";
          const availableIds = unit.availableTeacherIds ?? [];
          const assigned = Boolean(unit.teacherId && !unit.reason);
          const after = unit.reason || !unit.teacherId ? "Без изменений" : compactTeacherName(state.catalog.teachers, unit.teacherId);
          const status = hasManual && manualTarget === null ? "Оставлено без изменений" : unit.reason ?? (!assigned ? "Ожидает выбора" : "Готово");
          const checking = previewKey !== requestKey && pendingUnitIds.has(unit.id);
          return <tr key={unit.id} className={unit.reason || !assigned ? "is-skipped" : ""}>
            <td>{dayLabel(unit.date, { day: "numeric", month: "short", weekday: "short" })}<small>{clock(unit.start)}–{clock(unit.end)}</small></td>
            <td>{unit.groupIds.map(groupId => nameOf(state.catalog.groups, groupId)).join(" / ")}</td>
            <td title={nameOf(state.catalog.teachers, current ?? unit.sourceTeacherId ?? unit.teacherId)}>{compactTeacherName(state.catalog.teachers, current ?? unit.sourceTeacherId ?? unit.teacherId)}</td>
            <td>{after}</td>
            <td>{showRowTeachers ? <>
              <select className="tr-row-teacher" aria-busy={checking} aria-label={`Преподаватель для ${dayLabel(unit.date)} ${clock(unit.start)}, ${unit.groupIds.map(groupId => nameOf(state.catalog.groups, groupId)).join(" / ")}`} value={rowTarget} disabled={busy || applied || uncertain || !sameSelection} onChange={event => {
                const value = event.target.value;
                const nextMap = { ...(request.unitTeacherIds ?? {}) };
                if (value === "__default__") delete nextMap[unit.id];
                else nextMap[unit.id] = value === "__skip__" || value === "" ? null : value;
                update({ ...request, unitTeacherIds: Object.keys(nextMap).length ? nextMap : undefined });
              }}>
                <option value="__default__">{chosenTarget ? `Общий выбор: ${nameOf(state.catalog.teachers, chosenTarget)}` : "Общий выбор (не выбран)"}</option>
                {rowTarget && rowTarget !== "__skip__" && rowTarget !== "__default__" && !availableIds.includes(rowTarget) && <option value={rowTarget} disabled>{nameOf(state.catalog.teachers, rowTarget)} · недоступен</option>}
                <option value="">Выберите преподавателя</option>
                {availableIds.map(teacherId => <option key={teacherId} value={teacherId} title={nameOf(state.catalog.teachers, teacherId)}>{nameOf(state.catalog.teachers, teacherId)}</option>)}
                <option value="__skip__">Оставить без изменений</option>
              </select>
              <small className="tr-row-status">{checking ? "Проверяем…" : status}</small>
            </> : checking ? "Проверяем…" : status}</td>
          </tr>;
        })}{preview.skipped.filter(item => !preview!.units.some(unit => unit.lessonIds.includes(item.lessonId))).map((item, index) => { const lesson = sourceLessons.find(unit => unit.lessonIds.includes(item.lessonId)); return <tr key={`skip-${item.lessonId}-${index}`} className="is-skipped"><td>{lesson ? <>{dayLabel(lesson.date, { day: "numeric", month: "short", weekday: "short" })}<small>{clock(lesson.start)}–{clock(lesson.end)}</small></> : "—"}</td><td>{lesson?.groupIds.map(groupId => nameOf(state.catalog.groups, groupId)).join(" / ") ?? "—"}</td><td title={nameOf(state.catalog.teachers, lesson?.teacherId)}>{compactTeacherName(state.catalog.teachers, lesson?.teacherId)}</td><td>Без изменений</td><td>{item.reason}</td></tr>;})}</tbody></table>{preview.units.length === 0 && <p className="tr-empty">Для выбранного действия уроки не найдены.</p>}</div>
      </>}
      {success && <p className="tr-success" role="status">{success}</p>}
    </div>
    <footer className="tr-dialog-footer"><span>{applied ? "Операцию можно отменить, пока черновик не менялся" : "Изменения попадут в черновик; публикация расписания остаётся отдельным действием"}</span><div>{uncertain && <button type="button" className="tr-secondary" disabled={busy} onClick={() => void send()}>Повторить запрос</button>}{applied ? <button type="button" className="tr-secondary" disabled={busy || uncertain} onClick={() => void undo()}>Отменить операцию</button> : <button type="button" disabled={busy || uncertain || loading || stale || !preview || previewKey !== requestKey || previewRevision !== state.revision || (!eligible.length || !chosenTarget && !Object.values(request.unitTeacherIds ?? {}).some(Boolean)) || Boolean(skipped && !ack)} onClick={() => void apply()}><ActionLabel action="apply">Применить</ActionLabel></button>}<button type="button" className="tr-secondary" disabled={!canClose} onClick={onClose}>Закрыть</button></div></footer>
  </dialog>;
}

export default function TeacherReassignmentsPage({ initialState, auth, onUnauthorized, onBack, initialQuarterId, initialContext }: Props) {
  const [state, setState] = useState<StateResponse>(() => ({ ...initialState, schedule: {}, teacherLessonOrigins: [], teachingAssignments: [] }));
  const availableQuarters = useMemo(() => visibleQuarters(state.quarters), [state.quarters]);
  const contextTeacher = initialState.catalog.teachers.find(teacher => teacher.id === initialContext?.teacherId);
  const contextRule = contextTeacher?.unavailability?.find(rule => rule.id === initialContext?.ruleId);
  const contextQuarter = contextRule ? availableQuarters.find(q => q.startDate <= contextRule.endDate && q.endDate >= contextRule.startDate) : undefined;
  const today = isoToday();
  const currentQuarter = availableQuarters.find(q => q.startDate <= today && q.endDate >= today);
  const defaultQuarter = availableQuarters.find(q => q.id === initialQuarterId) ?? contextQuarter ?? currentQuarter ?? availableQuarters[0];
  const [quarterId, setQuarterId] = useState(defaultQuarter?.id ?? "");
  const [subjectId, setSubjectId] = useState(initialContext?.subjectId ?? contextTeacher?.subjectIds.find(id => initialState.catalog.subjects.some(subject => subject.id === id && !subject.archived)) ?? "");
  const [teacherId, setTeacherId] = useState(initialContext?.teacherId ?? "");
  const [groupIds, setGroupIds] = useState<string[]>(initialContext?.groupIds ?? []);
  const [groupSearch, setGroupSearch] = useState("");
  const [absenceRuleId, setAbsenceRuleId] = useState(initialContext?.ruleId ?? "");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [automaticRequest, setAutomaticRequest] = useState<ReplacementRequest | null>(null);
  const [absenceOpen, setAbsenceOpen] = useState(initialContext?.mode === "absence");
  const [pageError, setPageError] = useState("");
  const [availableSubjectIds, setAvailableSubjectIds] = useState<string[]>([]);
  const [quarterLoad, setQuarterLoad] = useState<QuarterLoad>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);

  useEffect(() => { document.body.classList.add("teacher-reassignments-view"); return () => document.body.classList.remove("teacher-reassignments-view"); }, []);
  useEffect(() => { setState(current => ({ ...initialState, schedule: current.schedule, teacherLessonOrigins: current.teacherLessonOrigins, teachingAssignments: current.teachingAssignments })); }, [initialState]);
  const quarter = state.quarters.find(item => item.id === quarterId);
  const groupNames = useMemo(() => Object.fromEntries(state.catalog.groups.map(group => [group.id, group.name])), [state.catalog.groups]);
  const subjects = useMemo(() => state.catalog.subjects.filter(subject => subject.id !== "event").sort((a, b) => sortRu(a.name, b.name)), [state.catalog.subjects]);
  const teachers = useMemo(() => state.catalog.teachers.filter(teacher => !teacher.archived && (!subjectId || teacher.subjectIds.includes(subjectId))).sort((a, b) => sortRu(a.name, b.name)), [state.catalog.teachers, subjectId]);
  const lessons = useMemo(() => collectReassignmentLessons(state.schedule, state.catalog, state.teacherLessonOrigins), [state.schedule, state.catalog, state.teacherLessonOrigins]);
  const availableLessons = useMemo(() => lessons.filter(lesson => lesson.subjectId === subjectId && !!quarter && lesson.date >= quarter.startDate && lesson.date <= quarter.endDate), [lessons, subjectId, quarter]);
  const assignments = useMemo(() => availableLessons.filter(lesson => !teacherId || lesson.teacherId === teacherId).filter(lesson => !groupIds.length || lesson.groupIds.some(groupId => groupIds.includes(groupId))), [availableLessons, teacherId, groupIds]);
  useEffect(() => {
    if (!quarterId) { setQuarterLoad({}); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ quarterId });
    void api<QuarterLoadResponse>(`/api/teacher-load/quarter?${params}`, { signal: controller.signal }).then(result => {
      const next: QuarterLoad = {};
      for (const teacher of result.teachers) next[teacher.id] = { lessons: teacher.lessons, target: result.target, percent: teacher.percent };
      setQuarterLoad(next);
    }).catch(reason => { if (!controller.signal.aborted && reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized(); });
    return () => controller.abort();
  }, [quarterId, state.revision, onUnauthorized]);
  async function refreshPageState(): Promise<StateResponse> {
    const params = new URLSearchParams({ quarterId });
    if (subjectId) params.set("subjectId", subjectId);
    if (teacherId) params.set("teacherId", teacherId);
    const data = await api<ReassignmentPageData>(`/api/admin/reassignments?${params}`);
    setAvailableSubjectIds(data.taughtSubjectIds);
    const next = { ...state, revision: data.revision, updatedAt: data.updatedAt, schedule: data.schedule, teacherLessonOrigins: data.teacherLessonOrigins ?? [], teachingAssignments: data.teachingAssignments ?? [] };
    setState(next);
    return next;
  }
  useEffect(() => {
    if (!quarterId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ quarterId });
    if (subjectId) params.set("subjectId", subjectId);
    if (teacherId) params.set("teacherId", teacherId);
    void api<ReassignmentPageData>(`/api/admin/reassignments?${params}`, { signal: controller.signal }).then(data => {
      setState(current => ({ ...current, revision: data.revision, updatedAt: data.updatedAt, schedule: data.schedule, teacherLessonOrigins: data.teacherLessonOrigins ?? [], teachingAssignments: data.teachingAssignments ?? [] }));
      setAvailableSubjectIds(data.taughtSubjectIds);
      setPageError("");
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && [401,403].includes(reason.status)) onUnauthorized();
      else setPageError(reason instanceof Error ? reason.message : "Не удалось загрузить выбранные занятия.");
    });
    return () => controller.abort();
  }, [quarterId, subjectId, teacherId, state.revision, onUnauthorized]);
  const weeks = useMemo(() => {
    if (!quarter) return [];
    const first = monday(quarter.startDate); const last = monday(quarter.endDate); const result: { start: string; dates: string[] }[] = [];
    for (let week = first; week <= last; week = addDays(week, 7)) result.push({ start: week, dates: Array.from({ length: 7 }, (_, day) => addDays(week, day)) });
    return result;
  }, [quarter]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const calendar = calendarRef.current;
      if (!calendar || !quarter) return;
      const currentWeek = monday(isoToday());
      const firstLessonWeek = assignments[0] ? monday(assignments[0].date) : weeks[0]?.start;
      const target = weeks.some(week => week.start === currentWeek) ? currentWeek : firstLessonWeek;
      const row = calendar.querySelector<HTMLTableRowElement>(`tr[data-week="${target}"]`);
      if (!row) return;
      const headerHeight = calendar.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      calendar.scrollTop += row.getBoundingClientRect().top - calendar.getBoundingClientRect().top - headerHeight - 1;
    });
    return () => cancelAnimationFrame(frame);
  }, [quarterId, subjectId, teacherId, groupIds, weeks]);
  useEffect(() => {
    if (!searchOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !groupsRef.current?.contains(event.target)) setSearchOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSearchOpen(false);
      groupsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [searchOpen]);
  const tableGroupIds = new Set(availableLessons.filter(lesson => !teacherId || lesson.teacherId === teacherId).flatMap(lesson => lesson.groupIds));
  const visibleGroups = state.catalog.groups.filter(group => tableGroupIds.has(group.id) && matchesGroupSearch(group.name, groupSearch)).sort((a, b) => sortRu(a.name, b.name));
  const taughtSubjectIds = useMemo(() => new Set(availableSubjectIds), [availableSubjectIds]);
  const filteredSubjects = subjects.filter(subject => taughtSubjectIds.has(subject.id));
  const selectedTeacher = state.catalog.teachers.find(teacher => teacher.id === teacherId);
  const absenceRules = selectedTeacher?.unavailability ?? [];
  const selectedRule = absenceRules.find(rule => rule.id === absenceRuleId) ?? absenceRules[0];

  useEffect(() => {
    if (!subjectId && filteredSubjects.length) setSubjectId(filteredSubjects[0]!.id);
  }, [filteredSubjects, subjectId]);

  useEffect(() => {
    if (!teacherId || teachers.some(teacher => teacher.id === teacherId)) return;
    setTeacherId("");

    setAbsenceRuleId("");
    setPageError("");
  }, [teacherId, teachers]);

  function openLesson(lesson: ReassignmentLesson) {
    if (!quarter || lesson.teacherId === undefined) return;
    const request: AssignRequest = { mode: "assign", quarterId, subjectId: lesson.subjectId, sourceTeacherId: lesson.teacherId, groupIds: lesson.groupIds, scope: "lesson", lessonId: lesson.lessonIds[0], targetTeacherId: undefined, persist: false };
    setDialog({ request, title: `Заменить занятие · ${dayLabel(lesson.date, { day: "numeric", month: "long" })}` });
  }
  function openWeek(weekStart: string) {
    if (!quarter || (!teacherId && groupIds.length === 0)) return;
    const selectedUnits = assignments.filter(lesson => lesson.date >= weekStart && lesson.date <= addDays(weekStart, 6));
    const selectedLessonIds = [...new Set(selectedUnits.flatMap(lesson => lesson.lessonIds))];
    const selectedGroups = groupIds.length ? groupIds : [...new Set(selectedUnits.flatMap(lesson => lesson.groupIds))];
    const request: AssignRequest = { mode: "assign", quarterId, subjectId, ...(teacherId ? { sourceTeacherId: teacherId } : {}), ...(selectedGroups.length ? { groupIds: selectedGroups } : {}), scope: "week", weekStart, lessonIds: selectedLessonIds, persist: true };
    setDialog({ request, title: `Замена на неделю · ${dayLabel(weekStart)} – ${dayLabel(addDays(weekStart, 6))}` });
  }
  function openPeriod() {
    if (!quarter || (!teacherId && groupIds.length === 0)) return;
    const selectedLessonIds = [...new Set(assignments.flatMap(lesson => lesson.lessonIds))];
    const selectedGroups = groupIds.length ? groupIds : [...new Set(assignments.flatMap(lesson => lesson.groupIds))];
    const request: AssignRequest = { mode: "assign", quarterId, subjectId, ...(teacherId ? { sourceTeacherId: teacherId } : {}), ...(selectedGroups.length ? { groupIds: selectedGroups } : {}), scope: "period", startDate: quarter.startDate, endDate: quarter.endDate, lessonIds: selectedLessonIds, persist: true };
    setDialog({ request, title: `Замена преподавателя · ${nameOf(state.catalog.subjects, subjectId)}` });
  }
  const handledContext = useRef(false);
  useEffect(() => {
    if (handledContext.current || initialContext?.mode !== "absence" || !teacherId || !selectedRule) return;
    handledContext.current = true; setAbsenceOpen(true);
    if (groupIds.length <= 1) setAutomaticRequest({
      teacherId, ruleId: selectedRule.id, startDate: selectedRule.startDate, endDate: selectedRule.endDate,
      ...(initialContext.subjectId ? { subjectId: initialContext.subjectId } : {}),
      ...(groupIds.length === 1 ? { groupId: groupIds[0] } : {}),
    });
  }, [initialContext?.mode, teacherId, selectedRule, groupIds.length]);
  function openAutomaticReplacement() {
    if (!teacherId || !selectedRule) { setPageError("Выберите учителя с сохранённым периодом недоступности."); return; }
    if (groupIds.length > 1) return;
    setPageError("");
    setAutomaticRequest({
      teacherId, ruleId: selectedRule.id, startDate: selectedRule.startDate, endDate: selectedRule.endDate,
      ...(subjectId ? { subjectId } : {}), ...(groupIds.length === 1 ? { groupId: groupIds[0] } : {}),
    });
  }
  const groupLabel = groupIds.length ? `Выбрано групп: ${groupIds.length}` : "Все группы";

  return <main className="teacher-reassignments-page">
    <AdminPageHeader title="Замены и переназначения" onBack={() => void onBack()} />
    <section className="tr-main">
      <div className="tr-page-title"><div><p>Выберите группу и предмет</p><h1>Замены и переназначения</h1></div></div>
      <div className="tr-filters">
        <label><span>Четверть</span><select aria-label="Четверть" value={quarterId} onChange={event => { setQuarterId(event.target.value); setGroupIds([]); }} >{availableQuarters.map(q => <option key={q.id} value={q.id}>{q.name} · {dayLabel(q.startDate)}–{dayLabel(q.endDate)}</option>)}</select></label>
        <div ref={groupsRef} className="tr-group-filter"><span className="group-search-label">Группы<GroupSearchHint /></span><button type="button" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>{groupLabel} <span aria-hidden="true">⌄</span></button>{searchOpen && <div className="tr-group-popover"><input aria-label="Поиск групп" placeholder="Найти группу" value={groupSearch} onChange={event => setGroupSearch(event.target.value)}/><div className="tr-group-list" role="group" aria-label="Выбор групп">{visibleGroups.map(group => <label key={group.id}><input type="checkbox" checked={groupIds.includes(group.id)} onChange={event => setGroupIds(old => event.target.checked ? [...old, group.id] : old.filter(value => value !== group.id))}/><span>{group.name}</span></label>)}</div><div className="tr-group-actions"><button type="button" onClick={() => setGroupIds(visibleGroups.map(group => group.id))}>Выбрать видимые</button><button type="button" onClick={() => setGroupIds([])}>Сбросить</button></div></div>}</div>
        <SearchSelect label="Предмет" value={subjectId} placeholder="Найти предмет" options={filteredSubjects.map(subject => ({ id: subject.id, label: subject.name }))} onChange={value => { setSubjectId(value); setGroupIds([]); }}/>
        <SearchSelect label="Текущий преподаватель" value={teacherId} placeholder="Найти учителя" options={[{ id: "", label: "Все учителя" }, ...teachers.map(teacher => ({ id: teacher.id, label: teacher.name, detail: quarterLoad[teacher.id] ? `Нагрузка за четверть: ${percentLabel(quarterLoad[teacher.id]!.percent)}` : "Нагрузка загружается" }))]} onChange={value => { setTeacherId(value); setGroupIds([]);  setAbsenceRuleId(""); setPageError(""); }}/>
      </div>
      <div className="tr-toolbar"><span>{subjectId ? `${assignments.length} занятий по предмету` : "Выберите предмет для просмотра расписания"}</span><div><button type="button" disabled={!subjectId || (!teacherId && !groupIds.length) || !assignments.length} onClick={openPeriod}><ActionLabel action="replace">Заменить преподавателя</ActionLabel></button></div></div>
      <details className="tr-absence-panel" open={absenceOpen} onToggle={event => setAbsenceOpen(event.currentTarget.open)}>
        <summary>Подбор на время отсутствия</summary>
        <div className="tr-absence-content">
          <div className="tr-inline-help"><strong>Найти заменяющих</strong><InfoTooltip label="Подбор на время отсутствия">Для сохранённого периода отсутствия сервер предложит доступных преподавателей. Расписание меняется только после проверки предложения и нажатия «Применить замены».</InfoTooltip></div>
          {!teacherId ? <p className="tr-dialog-hint">Выберите текущего преподавателя в фильтре выше.</p> : !absenceRules.length ? <p className="tr-dialog-hint">У преподавателя нет периода отсутствия. Добавьте его в «Справочники → Учителя → Недоступность».</p> : <>
            <div className="tr-absence-scope"><strong>{selectedTeacher?.name}</strong><span>{nameOf(state.catalog.subjects, subjectId)} · {groupIds.length ? groupIds.map(groupId => nameOf(state.catalog.groups, groupId)).join(", ") : "Все группы"}</span></div>
            <label className="tr-rule-select"><span>Период отсутствия</span><select aria-label="Период отсутствия" value={selectedRule?.id ?? ""} onChange={event => setAbsenceRuleId(event.target.value)}>{absenceRules.map(rule => <option key={rule.id} value={rule.id}>{dayLabel(rule.startDate)} – {dayLabel(rule.endDate)}{rule.reason ? ` · ${rule.reason}` : ""}</option>)}</select></label>
            {groupIds.length > 1 && <p className="tr-dialog-hint" role="status">Для подбора выберите одну группу или сбросьте выбор групп.</p>}
          </>}
          <button type="button" className="tr-secondary" disabled={!teacherId || !selectedRule || groupIds.length > 1} onClick={openAutomaticReplacement}><ActionLabel action="replace">Найти заменяющих</ActionLabel></button>
        </div>
      </details>
      {pageError && <p className="tr-error" role="alert">{pageError}</p>}
      {!subjectId ? <div className="tr-empty">Выберите предмет, чтобы увидеть все занятия за четверть.</div> : <div ref={calendarRef} className="tr-calendar-scroll" role="region" aria-label="Недели занятий по предмету" tabIndex={0}><table className="tr-calendar"><thead><tr><th>Неделя</th>{["Пн","Вт","Ср","Чт","Пт","Сб","Вс"].map(day => <th key={day}>{day}</th>)}</tr></thead><tbody>{weeks.map(week => {
        const inQuarter = week.dates.filter(date => date >= quarter!.startDate && date <= quarter!.endDate);
        const count = assignments.filter(item => item.date >= inQuarter[0]! && item.date <= inQuarter[inQuarter.length - 1]!).length;
        return <tr key={week.start} data-week={week.start}>
          <th><span>{dayLabel(inQuarter[0]!, { day: "numeric", month: "short" })} – {dayLabel(inQuarter.at(-1)!, { day: "numeric", month: "short" })}</span><button type="button" disabled={!count || (!teacherId && !groupIds.length)} onClick={() => openWeek(week.start)}>Неделя · {count}</button></th>
          {week.dates.map(date => <td key={date} className={`${date < quarter!.startDate || date > quarter!.endDate ? "is-outside" : ""} ${new Date(`${date}T12:00:00Z`).getUTCDay() === 0 || new Date(`${date}T12:00:00Z`).getUTCDay() === 6 ? "is-weekend" : ""}`}><span className="tr-date">{dayLabel(date, { day: "numeric", month: "short" })}</span><div className="tr-cards">{assignments.filter(item => item.date === date).map(item => <button type="button" key={item.id} className="tr-lesson-card" onClick={() => openLesson(item)} disabled={!item.teacherId} title={`${nameOf(state.catalog.teachers,item.teacherId)} · ${item.groupIds.map(group => groupNames[group] ?? group).join(" / ")}`}><strong>{item.groupIds.map(group => groupNames[group] ?? group).join(" / ")}{item.subgroups.length ? ` · ${item.subgroups.join("/")}` : ""}</strong><span>{clock(item.start)} · {item.roomIds.map(room => nameOf(state.catalog.rooms, room)).join("/") || "без кабинета"}</span><small title={nameOf(state.catalog.teachers, item.teacherId)}>{compactTeacherName(state.catalog.teachers, item.teacherId)}</small></button>)}</div></td>)}
        </tr>;
      })}</tbody></table>{weeks.length === 0 && <p className="tr-empty">В выбранной четверти нет недель для отображения.</p>}</div>}
      <div className="tr-footnote tr-inline-help"><span>Замена урока или недели</span><InfoTooltip label="Замена урока или недели">Нажмите на урок для разовой замены или на кнопку недели для замены выбранных занятий. Для недели выберите группу или текущего преподавателя. Совместные занятия обрабатываются одной карточкой.</InfoTooltip></div>
    </section>
    {dialog && <ReassignDialog state={state} auth={auth} initial={dialog} onUnauthorized={onUnauthorized} onClose={() => setDialog(null)} onStateChange={setState} onRefresh={refreshPageState} quarterLoad={quarterLoad}/>}
    {automaticRequest && <AutomaticTeacherReplacementDialog state={state} auth={auth} initialRequest={automaticRequest} onUnauthorized={onUnauthorized} onRefresh={refreshPageState} onClose={() => setAutomaticRequest(null)} onStateChange={setState}/>}
  </main>;
}
