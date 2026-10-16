import { createId } from "../shared/createId.ts";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.ts";
import InfoTooltip from "./InfoTooltip.tsx";
import type { PublicationIssue, PublicationPreview, PublishResponse } from "../shared/publicationTypes.ts";
import "./publication.css";

type Props = {
  quarterId: string;
  csrfToken: string;
  groupNames: Record<string, string>;
  onClose: () => void;
  onPublished: (response: PublishResponse) => void;
  onUnauthorized: () => void;
};

const dateTime = (value: string) => new Intl.DateTimeFormat("ru", {
  dateStyle: "short", timeStyle: "short",
}).format(new Date(value));
const dateLabel = (value: string) => new Intl.DateTimeFormat("ru", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));

export default function PublicationDialog({ quarterId, csrfToken, groupNames, onClose, onPublished, onUnauthorized }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [published, setPublished] = useState<PublishResponse | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>(".publication-header button[aria-label='Закрыть']")?.focus();
  }, []);
  useEffect(() => { void loadPreview(); }, [quarterId]);

  async function loadPreview() {
    setLoading(true);
    setError("");
    setStale(false);
    setPreview(null);
    setPublished(null);
    requestIdRef.current = null;
    try {
      const result = await api<PublicationPreview>(`/api/publication-preview?quarterId=${encodeURIComponent(quarterId)}`);
      setPreview(result);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось проверить расписание.");
    } finally {
      setLoading(false);
    }
  }

  async function publish() {
    if (!preview?.canPublish || busy || stale || published) return;
    setBusy(true);
    setError("");
    const requestId = requestIdRef.current ?? createId();
    requestIdRef.current = requestId;
    try {
      const result = await api<PublishResponse>("/api/publications", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ quarterId, revision: preview.revision, requestId }),
      });
      setPublished(result);
      setPreview(null);
      onPublished(result);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) setStale(true);
      setError(reason instanceof Error ? reason.message : "Не удалось опубликовать расписание.");
    } finally {
      setBusy(false);
    }
  }

  const issueContext = (issue: PublicationIssue) => {
    const name = issue.groupId ? groupNames[issue.groupId] ?? "Группа" : "";
    return [name && !issue.message.includes(name) ? name : "", issue.date && !issue.message.includes(issue.date) ? dateLabel(issue.date) : ""].filter(Boolean).join(" · ");
  };
  const groupList = preview?.summary.affectedGroupIds.map(id => groupNames[id] ?? "Группа удалена") ?? [];
  const hasChanges = !preview?.previous || preview.summary.added > 0 || preview.summary.removed > 0 ||
    preview.summary.changed > 0 || preview.summary.settingsChanged;
  const unchanged = Boolean(preview?.previous && !hasChanges);
  const close = () => { if (!busy) onClose(); };

  return <dialog ref={dialogRef} className="publication-dialog" aria-labelledby="publication-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="publication-header">
      <div>
        <h2 id="publication-title">{published ? (published.unchanged ? "Расписание уже опубликовано" : "Расписание опубликовано") : <>Публикация расписания <InfoTooltip label="Публикация расписания">После публикации дальнейшие правки останутся в черновике до следующей публикации.</InfoTooltip></>}</h2>
        <p>{preview ? `${preview.quarter.name} · ${dateLabel(preview.quarter.startDate)} — ${dateLabel(preview.quarter.endDate)}` : "Вся четверть · все группы"}</p>
      </div>
      <button type="button" aria-label="Закрыть" autoFocus disabled={busy} onClick={close}>×</button>
    </header>

    <div className="publication-content" aria-live="polite">
      {loading && <p className="publication-muted">Проверяем расписание всей четверти…</p>}
      {preview && <>
        <p className="publication-scope">Будет опубликована вся четверть. Групп: {preview.summary.groupCount}.</p>
        {preview.previous
          ? <p className="publication-muted">Последняя публикация: {dateTime(preview.previous.publishedAt)} · версия {preview.previous.version}.</p>
          : <p className="publication-muted">Это первая публикация расписания для этой четверти.</p>}

        <section className="publication-change-section" aria-label="Изменения">
          <h3>Изменения с последней публикации</h3>
          <div className="publication-counts">
            <span><strong>{preview.summary.added}</strong> добавлено</span>
            <span><strong>{preview.summary.removed}</strong> удалено</span>
            <span><strong>{preview.summary.changed}</strong> изменено</span>
            <span>Всего занятий: <strong>{preview.summary.lessonCount}</strong></span>
          </div>
          {preview.summary.settingsChanged && <p className="publication-muted">{preview.previous ? "Также изменились общие настройки расписания." : "Настройки и подписи будут сохранены вместе с расписанием."}</p>}
          {!!groupList.length && <details className="publication-groups">
            <summary>Затронутые группы: {groupList.length}</summary>
            <ul>{groupList.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul>
          </details>}
        </section>
        {unchanged && <p className="publication-ready">Изменений с последней публикации нет. Новая версия не потребуется.</p>}

        {!!preview.errors.length && <section className="publication-issues is-error" aria-label="Ошибки">
          <h3>Сначала исправьте ошибки ({preview.errors.length})</h3>
          <ul>{preview.errors.slice(0, 50).map((issue, index) => <li key={`${issue.code}-${issue.lessonId ?? index}`}>{issue.message}{issueContext(issue) && <span> · {issueContext(issue)}</span>}</li>)}</ul>
          {preview.errors.length > 50 && <p>Показаны первые 50 ошибок.</p>}
        </section>}

        {!!preview.warnings.length && <section className="publication-issues is-warning" aria-label="Предупреждения">
          <h3>Предупреждения ({preview.warnings.length})</h3>
          <ul>{preview.warnings.slice(0, 50).map((issue, index) => <li key={`${issue.code}-${issue.lessonId ?? index}`}>{issue.message}{issueContext(issue) && <span> · {issueContext(issue)}</span>}</li>)}</ul>
          {preview.warnings.length > 50 && <p>Показаны первые 50 предупреждений.</p>}
        </section>}
        {!preview.errors.length && <p className="publication-ready">{preview.warnings.length ? "Ошибок нет. Предупреждения не блокируют публикацию." : "Ошибок и предупреждений нет."}</p>}
      </>}

      {published && <section className="publication-success" role="status">
        <p>{published.unchanged ? `Изменений нет. Сохраняется версия ${published.publication.version}.` : `Создана публикация версии ${published.publication.version}.`}</p>
        <p>{dateTime(published.publication.publishedAt)} · групп: {published.summary.groupCount} · занятий: {published.summary.lessonCount}.</p>
      </section>}
      {error && <p className="publication-error" role="alert">{error}</p>}
      {stale && <p className="publication-stale">Черновик изменился после проверки. Обновите проверку перед публикацией.</p>}
    </div>

    <footer className="publication-footer">
      <span>{published ? "Опубликованный снимок сохранён" : stale ? "Проверка устарела" : preview ? `Групп: ${preview.summary.groupCount} · вся четверть` : "Проверьте состояние сервера"}</span>
      {stale && <button type="button" onClick={() => void loadPreview()} disabled={busy || loading}>Обновить проверку</button>}
      {!stale && error && !preview && <button type="button" onClick={() => void loadPreview()} disabled={busy || loading}>Повторить проверку</button>}
      <button type="button" onClick={close} disabled={busy}>{published ? "Закрыть" : "Отмена"}</button>
      {!published && !stale && <button type="button" className="publication-primary" onClick={() => void publish()} disabled={busy || loading || !preview?.canPublish || unchanged}>{busy ? "Публикуем…" : unchanged ? "Нет изменений" : error && preview ? "Повторить публикацию" : preview?.previous ? "Опубликовать изменения" : "Опубликовать"}</button>}
      {!published && stale && <button type="button" className="publication-primary" disabled>Опубликовать</button>}
    </footer>
  </dialog>;
}
