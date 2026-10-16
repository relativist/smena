import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StateResponse } from "../server/contracts";
import type { Quarter } from "../shared/plans";
import { ApiError, api, type AuthSession } from "./api";
import RussianDateInput from "./RussianDateInput";
import "./quarter-editor.css";

type Props = {
  state: StateResponse;
  auth: AuthSession;
  quarterId: string;
  disabled: boolean;
  onUnauthorized: () => void;
  onSaved: (next: StateResponse, quarterId: string) => void;
};
type Request = {
  quarters: Quarter[];
  metadataOnly: true;
  responseQuarterId: string;
  revision: number;
  requestId: string;
};

export default function QuarterEditor({ state, auth, quarterId, disabled, onUnauthorized, onSaved }: Props) {
  const [draft, setDraft] = useState<Quarter | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const current = state.quarters.find((q) => q.id === quarterId);

  useEffect(() => {
    if (draft && !dialog.current?.open) {
      dialog.current?.showModal();
      nameInput.current?.focus();
    } else if (!draft && dialog.current?.open) dialog.current.close();
  }, [draft]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  function open(create: boolean) {
    setCreating(create);
    setError("");
    setConflict(false);
    setDraft(create ? { id: crypto.randomUUID(), name: "", startDate: "", endDate: "" } : current ? { ...current } : null);
  }
  function close() {
    if (busy || pending) return;
    setDraft(null);
    setError("");
  }
  async function persist(request: Request) {
    if (busy || !draft) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<StateResponse>("/api/plans?response=compact", {
        method: "PUT", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify(request),
      });
      setPending(null);
      setDraft(null);
      onSaved({ ...state, ...next }, draft.id);
    } catch (reason) {
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) { setConflict(true); setPending(null); }
      else if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && ![401, 403].includes(reason.status)) setPending(null);
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить четверть.");
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || pending || conflict) return;
    if (!draft.name.trim() || !draft.startDate || !draft.endDate || draft.startDate > draft.endDate) {
      setError("Укажите название и корректные даты четверти."); return;
    }
    if (draft.startDate.slice(0, 4) < "2024" || draft.endDate.slice(0, 4) > "2040") {
      setError("Даты должны быть в пределах 2024–2040 годов."); return;
    }
    if ((Date.parse(draft.endDate) - Date.parse(draft.startDate)) / 86400000 + 1 > 180) {
      setError("Четверть не может длиться больше 180 дней."); return;
    }
    if (state.quarters.some((q) => q.id !== draft.id && draft.startDate <= q.endDate && draft.endDate >= q.startDate)) {
      setError("Даты пересекаются с другой четвертью."); return;
    }
    const quarter = { ...draft, name: draft.name.trim() };
    const request = { quarters: creating ? [...state.quarters, quarter] : state.quarters.map((q) => q.id === draft.id ? quarter : q), metadataOnly: true as const, responseQuarterId: draft.id, revision: state.revision, requestId: crypto.randomUUID() };
    setPending(request);
    void persist(request);
  }

  return <>
    <button className="catalog-button" type="button" disabled={disabled || state.quarters.length >= 100} onClick={() => open(true)}>＋ Четверть</button>
    <button className="catalog-button" type="button" disabled={disabled || !current} onClick={() => open(false)}>Изменить четверть</button>
    <dialog ref={dialog} className="catalog-dialog quarter-editor-dialog" aria-labelledby="quarter-editor-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      <header><h2 id="quarter-editor-title">{creating ? "Добавить четверть" : "Изменить четверть"}</h2><button type="button" aria-label="Закрыть" disabled={busy || Boolean(pending)} onClick={close}>×</button></header>
      <form onSubmit={submit}>
        <fieldset disabled={busy || Boolean(pending) || conflict}>
          <label>Название<input ref={nameInput} maxLength={100} required value={draft?.name ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, name: e.target.value } : d)} /></label>
          <div className="quarter-editor-date"><span>Начало</span><RussianDateInput label="Начало четверти" value={draft?.startDate ?? ""} onChange={(value) => setDraft((d) => d ? { ...d, startDate: value } : d)} /></div>
          <div className="quarter-editor-date"><span>Окончание</span><RussianDateInput label="Окончание четверти" value={draft?.endDate ?? ""} onChange={(value) => setDraft((d) => d ? { ...d, endDate: value } : d)} /></div>
        </fieldset>
        {error && <p className="catalog-validation" role="alert">{error}{conflict ? " Закройте окно и заново откройте учебный календарь, чтобы получить актуальные данные." : ""}</p>}
        <footer>
          {pending && !busy ? <button className="catalog-primary" type="button" onClick={() => void persist(pending)}>Повторить сохранение</button> : <button className="catalog-primary" type="submit" disabled={busy || conflict}>{busy ? "Сохранение…" : "Сохранить"}</button>}
          <button className="catalog-button" type="button" disabled={busy || Boolean(pending)} onClick={close}>Отмена</button>
        </footer>
      </form>
    </dialog>
  </>;
}
