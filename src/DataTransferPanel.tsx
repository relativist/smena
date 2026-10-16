import { useEffect, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { ApiError, type AuthSession } from "./api";
import { MAX_ARCHIVE_UPLOAD_BYTES, type ArchiveAvailability, type ArchivePreview, type ArchiveRestoreStatus } from "../shared/dataTransfer";
import "./data-transfer.css";

type Props = { auth: AuthSession; disabled?: boolean; onUnauthorized: () => void; onBusyChange?: (busy: boolean) => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Не удалось выполнить операцию.";
const OPERATION_KEY = "smena-data-transfer-operation";

async function checkedFetch(path: string, init: RequestInit = {}, timeout = 15000) {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(timeout) });
  } catch {
    throw new ApiError("Нет связи с сервером. Можно проверить результат или повторить операцию.", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.message ?? body?.error ?? `Ошибка сервера (${response.status})`, response.status);
  }
  return response;
}

function counts(value: ArchivePreview["archive"]["counts"]) {
  const quantity = (number: number, forms: [string, string, string]) => {
    const mod100 = number % 100, mod10 = number % 10;
    return `${number} ${forms[mod100 >= 11 && mod100 <= 14 ? 2 : mod10 === 1 ? 0 : mod10 >= 2 && mod10 <= 4 ? 1 : 2]}`;
  };
  return [quantity(value.groups, ["группа", "группы", "групп"]), quantity(value.teachers, ["учитель", "учителя", "учителей"]), quantity(value.rooms, ["кабинет", "кабинета", "кабинетов"]), quantity(value.lessons, ["урок", "урока", "уроков"])].join(", ");
}

export default function DataTransferPanel({ auth, disabled = false, onUnauthorized, onBusyChange }: Props) {
  const [availability, setAvailability] = useState<ArchiveAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<"export" | "inspect" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restoreToken, setRestoreToken] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = disabled || busy || restoreBusy;

  useEffect(() => { onBusyChange?.(busy || restoreBusy); }, [busy, restoreBusy, onBusyChange]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await checkedFetch("/api/data-transfer");
        setAvailability(await response.json() as ArchiveAvailability);
      } catch (reason) {
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
        else setError(errorText(reason));
      }
    })();
    const completed = sessionStorage.getItem("smena-data-transfer-success");
    if (completed) {
      sessionStorage.removeItem("smena-data-transfer-success");
      setNotice(`Данные восстановлены. Резервная копия сохранена: ${completed}`);
    }
    const savedToken = sessionStorage.getItem(OPERATION_KEY);
    if (savedToken) {
      setRestoreToken(savedToken);
      void status(savedToken);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (preview && dialog && !dialog.open) dialog.showModal();
    else if (!preview && dialog?.open) dialog.close();
  }, [preview]);

  function handleAuthError(reason: unknown) {
    if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
  }

  async function exportArchive() {
    setBusy(true); setBusyKind("export"); setError(""); setNotice("");
    try {
      const response = await checkedFetch("/api/data-transfer/export", { method: "POST", headers: { "x-csrf-token": auth.csrfToken } }, 10 * 60 * 1000);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
      const filename = encoded ? decodeURIComponent(encoded) : plain ?? "smena-data.smena.gz";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Архив данных скачан.");
    } catch (reason) { handleAuthError(reason); setError(errorText(reason)); }
    finally { setBusy(false); setBusyKind(null); }
  }

  async function inspectArchive(selected: File | null) {
    if (!selected) return;
    setFile(selected); setError(""); setNotice(""); setBusy(true); setBusyKind("inspect");
    try {
      if (selected.size > MAX_ARCHIVE_UPLOAD_BYTES) throw new ApiError("Архив слишком большой. Максимальный размер — 128 МиБ.", 413);
      const response = await checkedFetch("/api/data-transfer/inspect", { method: "POST", headers: { "x-csrf-token": auth.csrfToken, "Content-Type": "application/octet-stream" }, body: selected }, 10 * 60 * 1000);
      setPreview(await response.json() as ArchivePreview); setConfirm(false);
    } catch (reason) { handleAuthError(reason); setError(errorText(reason)); }
    finally { setBusy(false); setBusyKind(null); }
  }

  async function status(token = restoreToken) {
    if (!token) return;
    setRestoreBusy(true); setError("");
    try {
      const response = await checkedFetch(`/api/data-transfer/status/${encodeURIComponent(token)}`);
      const result = await response.json() as ArchiveRestoreStatus;
      if (result.state === "complete" && result.result) {
        sessionStorage.removeItem(OPERATION_KEY);
        sessionStorage.setItem("smena-data-transfer-success", result.result.backupFilename);
        window.location.reload(); return;
      }
      if (result.state === "failed") {
        sessionStorage.removeItem(OPERATION_KEY); setRestoreToken("");
        setError(result.error ?? "Не удалось восстановить архив. Текущие данные сохранены.");
      }
      else if (result.state === "restoring") setNotice("Восстановление ещё выполняется. Проверьте результат через несколько минут.");
      else {
        sessionStorage.removeItem(OPERATION_KEY); setRestoreToken("");
        setNotice("Архив был проверен, но восстановление не запускалось. Загрузите файл снова, чтобы продолжить.");
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 410) {
        sessionStorage.removeItem(OPERATION_KEY); setRestoreToken("");
        setError("Срок проверки архива истёк. Загрузите файл снова.");
      } else { handleAuthError(reason); setError(errorText(reason)); }
    }
    finally { setRestoreBusy(false); }
  }

  async function restore() {
    if (!preview || !confirm || restoreBusy) return;
    setRestoreToken(preview.token); sessionStorage.setItem(OPERATION_KEY, preview.token); setRestoreBusy(true); setError(""); setNotice("");
    try {
      await checkedFetch("/api/data-transfer/restore", { method: "POST", headers: { "x-csrf-token": auth.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ token: preview.token, confirm: true }) }, 10 * 60 * 1000);
      setPreview(null);
      await status(preview.token);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
        // A completed restore rotates the CSRF token; query its owner-bound status before treating this as an auth failure.
        try {
          const response = await checkedFetch(`/api/data-transfer/status/${encodeURIComponent(preview.token)}`);
          const result = await response.json() as ArchiveRestoreStatus;
          if (result.state === "complete" && result.result) {
            sessionStorage.removeItem(OPERATION_KEY);
            sessionStorage.setItem("smena-data-transfer-success", result.result.backupFilename);
            window.location.reload(); return;
          }
          onUnauthorized();
        } catch (statusError) { handleAuthError(statusError); setError(errorText(statusError)); }
      } else { handleAuthError(reason); setError(errorText(reason)); }
    } finally { setRestoreBusy(false); }
  }

  function closePreview() {
    if (restoreBusy) return;
    const token = preview?.token;
    setPreview(null); setConfirm(false);
    if (token) void checkedFetch("/api/data-transfer/discard", { method: "POST", headers: { "x-csrf-token": auth.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => undefined);
  }

  return <>
    <section className="display-settings-card data-transfer-card" aria-labelledby="data-transfer-heading">
      <div className="display-settings-card-heading"><h2 id="data-transfer-heading">Перенос данных <InfoTooltip label="Архив данных">Архив содержит школьные данные для переноса и отладки. Перед восстановлением текущая база автоматически сохраняется.</InfoTooltip></h2></div>
      {availability && !availability.supported && <p className="data-transfer-warning" role="status">{availability.reason ?? "Перенос данных сейчас недоступен."}</p>}
      <div className="data-transfer-actions">
        <button className="catalog-button" type="button" onClick={() => void exportArchive()} disabled={locked || availability?.supported === false}>{busyKind === "export" ? "Скачиваем архив…" : "Скачать архив"}</button>
        <button className="catalog-button" type="button" onClick={() => inputRef.current?.click()} disabled={locked || availability?.supported === false}>{busyKind === "inspect" ? "Проверяем архив…" : "Загрузить архив"}</button>
        <input ref={inputRef} className="data-transfer-file-input" type="file" accept=".gz,.smena.gz,application/gzip" aria-label="Выбрать архив данных" onChange={event => { const selected = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void inspectArchive(selected); }} />
      </div>
      {disabled && <p className="data-transfer-muted">Сначала сохраните или отмените изменения общих настроек.</p>}
      {busy && <p className="display-settings-status" role="status">{busyKind === "inspect" ? `Проверяем ${file?.name ?? "архив"}…` : "Подготавливаем архив…"}</p>}
      {restoreToken && !preview && <div className="data-transfer-actions"><button className="catalog-button" type="button" onClick={() => void status()} disabled={locked}>{restoreBusy ? "Проверяем…" : "Проверить результат восстановления"}</button></div>}
      {error && <p className="catalog-validation data-transfer-error" role="alert">{error}</p>}
      {notice && <p className="display-settings-success" role="status">{notice}</p>}
    </section>
    <dialog className="catalog-dialog data-transfer-dialog" ref={dialogRef} aria-labelledby="data-transfer-dialog-title" onCancel={event => { event.preventDefault(); closePreview(); }}>
      {preview && <>
        <h2 id="data-transfer-dialog-title">Восстановить данные из архива?</h2>
        <dl className="data-transfer-preview"><dt>Файл</dt><dd>{file?.name}</dd><dt>Дата архива</dt><dd>{new Date(preview.archive.createdAt).toLocaleString("ru-RU")}</dd><dt>Школа</dt><dd>{preview.archive.schoolName || "Без названия"}</dd><dt>Сейчас</dt><dd>{counts(preview.current.counts)}</dd><dt>В архиве</dt><dd>{counts(preview.archive.counts)}</dd></dl>
        <p className="data-transfer-replace-warning">Все текущие школьные данные будут заменены.</p>
        <p className="data-transfer-muted">Перед заменой будет сохранена резервная копия. Ваш логин и пароль сохранятся.</p>
        <label className="data-transfer-confirm"><input type="checkbox" checked={confirm} disabled={restoreBusy} onChange={event => setConfirm(event.target.checked)} />Подтверждаю замену школьных данных</label>
        {error && <p className="catalog-validation" role="alert">{error}</p>}
        <footer><button className="catalog-danger" type="button" onClick={() => void restore()} disabled={!confirm || restoreBusy}>{restoreBusy ? "Восстановление…" : "Заменить данные"}</button><button className="catalog-button" type="button" onClick={closePreview} disabled={restoreBusy}>Отмена</button></footer>
      </>}
    </dialog>
  </>;
}
