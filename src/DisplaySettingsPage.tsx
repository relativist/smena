import { createId } from "../shared/createId.ts";
import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import InfoTooltip from "./InfoTooltip";
import DataTransferPanel from "./DataTransferPanel";
import { useSchoolSettings } from "./SchoolSettings";
import { ApiError, api, type AuthSession } from "./api";
import { defaultDisplaySettings, type DisplaySettings, type DisplaySettingsResponse } from "../shared/displaySettings";
import { useEffect, useRef, useState } from "react";
import "./display-settings.css";

type Props = { auth: AuthSession; onUnauthorized: () => void; onBack: () => Promise<void> };
type PendingWrite = { settings: DisplaySettings; revision: number; requestId: string };
const makeId = () => createId();
const message = (error: unknown) => error instanceof Error ? error.message : "Не удалось загрузить общие настройки.";
const same = (a: DisplaySettings, b: DisplaySettings) => a.schoolName === b.schoolName && a.adminSubjectIcons === b.adminSubjectIcons && a.studentSubjectIcons === b.studentSubjectIcons;

export default function DisplaySettingsPage({ auth, onUnauthorized, onBack }: Props) {
  const { update: updateSchoolSettings } = useSchoolSettings();
  const [settings, setSettings] = useState<DisplaySettings>(defaultDisplaySettings());
  const [savedSettings, setSavedSettings] = useState<DisplaySettings>(defaultDisplaySettings());
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const pendingRef = useRef<PendingWrite | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const loadSequence = useRef(0);
  const dirty = loaded && !same(settings, savedSettings);

  useEffect(() => {
    const controller = new AbortController();
    void loadLatest(controller.signal);
    return () => { controller.abort(); loadSequence.current += 1; };
    // The page loads once on mount; retry and conflict refresh call loadLatest directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dialog = leaveDialog.current;
    if (!dialog) return;
    if (leavePrompt && !dialog.open) dialog.showModal();
    if (!leavePrompt && dialog.open) dialog.close();
  }, [leavePrompt]);

  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  async function loadLatest(signal?: AbortSignal) {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<DisplaySettingsResponse>("/api/display-settings", { signal });
      if (signal?.aborted || sequence !== loadSequence.current) return;
      setSettings(result.settings);
      setSavedSettings(result.settings);
      setRevision(result.revision);
      updateSchoolSettings({ schoolName: result.settings.schoolName, studentSubjectIcons: result.settings.studentSubjectIcons });
      setLoaded(true);
      setPending(null);
      pendingRef.current = null;
      setConflict(false);
      setSaved(false);
    } catch (reason) {
      if (signal?.aborted || sequence !== loadSequence.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(message(reason));
    } finally {
      if (!signal?.aborted && sequence === loadSequence.current) setLoading(false);
    }
  }

  async function persist(operation?: PendingWrite) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const write = pendingRef.current ?? operation ?? { settings, revision, requestId: makeId() };
      pendingRef.current = write;
      setPending(write);
      const result = await api<DisplaySettingsResponse>("/api/display-settings", {
        method: "PUT",
        headers: { "x-csrf-token": auth.csrfToken },
        body: JSON.stringify(write),
      });
      setSettings(result.settings);
      setSavedSettings(result.settings);
      setRevision(result.revision);
      updateSchoolSettings({ schoolName: result.settings.schoolName, studentSubjectIcons: result.settings.studentSubjectIcons });
      pendingRef.current = null;
      setPending(null);
      setConflict(false);
      setSaved(true);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && ![401, 403, 409].includes(reason.status)) {
        pendingRef.current = null;
        setPending(null);
      }
      setError(message(reason));
    } finally { setBusy(false); }
  }

  async function back(force = false) {
    if (busy || pendingRef.current) return;
    if (dirty && !force) { setLeavePrompt(true); return; }
    setBackBusy(true);
    setError("");
    try { await onBack(); }
    catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось вернуться к расписанию.");
    } finally { setBackBusy(false); setLeavePrompt(false); }
  }

  const [transferBusy, setTransferBusy] = useState(false);
  const controlsDisabled = !loaded || loading || busy || Boolean(pending) || backBusy || transferBusy;
  return <main className="catalog-page display-settings-page">
    <AdminPageHeader title="Общие настройки" username={auth.username} onBack={() => void back()} disabled={busy || Boolean(pending) || backBusy || transferBusy} busy={backBusy} />
    <section className="catalog-body display-settings-body">
      <h1>Общие настройки</h1>
      <section className="display-settings-card" aria-labelledby="display-settings-heading">
        <label className="display-settings-school-row" htmlFor="school-name">
          <span>Название школы <InfoTooltip label="Название школы">Отображается на страницах учеников, учителей, администратора и в печати. Повторно публиковать расписание не нужно. Пустое поле скрывает название.</InfoTooltip></span>
          <input id="school-name" aria-label="Название школы" type="text" autoComplete="organization" maxLength={200} placeholder="Например, Школа № 12" value={settings.schoolName} disabled={controlsDisabled} onChange={event => { setSettings(current => ({ ...current, schoolName: event.target.value })); setSaved(false); setError(""); }} />
        </label>
        <div className="display-settings-card-heading">
          <h2 id="display-settings-heading">Значки предметов</h2>
          <InfoTooltip label="Значки расписания">Эти два независимых параметра влияют только на отображение: отдельно в расписании администратора и в расписании учеников. Сохранённые изменения сразу применяются для учеников — повторно публиковать расписание не нужно. Значки не меняют данные уроков.</InfoTooltip>
        </div>
        <div className="display-settings-rows" aria-busy={loading || busy}>
          <label className="display-settings-row"><span>В расписании администратора</span><input type="checkbox" checked={settings.adminSubjectIcons} disabled={controlsDisabled} onChange={(event) => { setSettings((current) => ({ ...current, adminSubjectIcons: event.target.checked })); setSaved(false); setError(""); }} /></label>
          <label className="display-settings-row"><span>В расписании учеников</span><input type="checkbox" checked={settings.studentSubjectIcons} disabled={controlsDisabled} onChange={(event) => { setSettings((current) => ({ ...current, studentSubjectIcons: event.target.checked })); setSaved(false); setError(""); }} /></label>
        </div>
        {loading && <p className="display-settings-status" role="status">Загружаем настройки…</p>}
        {error && <div className={`catalog-alert ${conflict ? "conflict" : ""}`} role="alert"><span>{error}</span>{conflict ? <button className="catalog-button" type="button" onClick={() => void loadLatest()} disabled={busy || loading}>Загрузить актуальные настройки</button> : pending ? <button className="catalog-button" type="button" onClick={() => void persist(pending)} disabled={busy || loading}>Повторить сохранение</button> : <button className="catalog-button" type="button" onClick={() => void loadLatest()} disabled={busy || loading}>Повторить загрузку</button>}</div>}
        {saved && <p className="display-settings-success" role="status">Настройки сохранены.</p>}
        <footer className="display-settings-footer"><button className="catalog-primary" type="button" onClick={() => void persist()} disabled={!dirty || controlsDisabled}><ActionLabel action="save">{busy ? "Сохранение…" : "Сохранить"}</ActionLabel></button></footer>
      </section>
      <DataTransferPanel auth={auth} disabled={dirty || busy || Boolean(pending) || backBusy} onUnauthorized={onUnauthorized} onBusyChange={setTransferBusy} />
    </section>
    <dialog className="catalog-dialog display-settings-confirm" ref={leaveDialog} aria-labelledby="display-settings-leave-title" onCancel={(event) => { event.preventDefault(); setLeavePrompt(false); }}>
      <h2 id="display-settings-leave-title">Есть несохранённые изменения</h2>
      <p>Если вернуться к расписанию сейчас, изменения настроек будут потеряны.</p>
      <footer><button className="catalog-button" type="button" onClick={() => setLeavePrompt(false)}>Остаться</button><button className="catalog-danger" type="button" onClick={() => void back(true)}>Не сохранять</button></footer>
    </dialog>
  </main>;
}
