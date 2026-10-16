import ActionLabel from "./ActionLabel";
import GroupSelection from "./GroupSelection";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Catalog } from "../shared/catalog.ts";
import type { Quarter } from "../shared/plans.ts";
import "./clear-schedule.css";

type Props = {
  catalog: Catalog;
  revision: number;
  csrfToken: string;
  onUnauthorized: () => void;
  currentGroupId: string;
  weekDates: string[];
  quarter: Quarter;
  onClose: () => void;
  onApply: (options: { groupIds: string[]; startDate: string; endDate: string }) => void | Promise<void>;
};

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

export default function ClearScheduleDialog({
  catalog,
  revision,
  csrfToken,
  onUnauthorized,
  currentGroupId,
  weekDates,
  quarter,
  onClose,
  onApply,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const groups = useMemo(
    () => catalog.groups.filter((group) => !group.archived).sort((a, b) => collator.compare(a.name, b.name)),
    [catalog.groups],
  );
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() =>
    groups.some((group) => group.id === currentGroupId)
      ? [currentGroupId]
      : groups.slice(0, 1).map((group) => group.id),
  );
  const [scope, setScope] = useState<"week" | "quarter">("week");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const dates = scope === "week" ? weekDates : [quarter.startDate, quarter.endDate];
  const startDate = dates.length ? [...dates].sort()[0] : "";
  const endDate = dates.length ? [...dates].sort().at(-1)! : "";
  const [removedCount, setRemovedCount] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate || !selectedGroups.length) {
      setRemovedCount(0);
      return;
    }
    const controller = new AbortController();
    setPreviewBusy(true);
    void api<{ removedCount: number }>("/api/schedule-operations/preview", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: JSON.stringify({ revision, operation: "clear", options: { groupIds: selectedGroups, startDate, endDate } }),
      signal: controller.signal,
    }).then(result => { if (!controller.signal.aborted) setRemovedCount(result.removedCount); })
      .catch(reason => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
        setError(reason instanceof Error ? reason.message : "Не удалось проверить очистку.");
      }).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [revision, csrfToken, selectedGroups, startDate, endDate, onUnauthorized]);

  async function apply() {
    if (!removedCount || busy || previewBusy) return;
    setBusy(true);
    setError("");
    try {
      await onApply({ groupIds: selectedGroups, startDate, endDate });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось очистить расписание.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      className="clear-schedule-dialog"
      ref={dialogRef}
      aria-labelledby="clear-schedule-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="clear-schedule-header">
        <div>
          <h2 id="clear-schedule-title">Очистка расписания · {quarter.name}</h2>
          <p>{startDate && endDate ? `${dateLabel(startDate)} — ${dateLabel(endDate)}` : "Нет дат для очистки"}</p>
        </div>
        <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button>
      </header>
      <div className="clear-schedule-content">
        <fieldset>
          <legend>Период</legend>
          <label><input type="radio" checked={scope === "week"} onChange={() => setScope("week")} disabled={busy} /> Текущая неделя</label>
          <label><input type="radio" checked={scope === "quarter"} onChange={() => setScope("quarter")} disabled={busy} /> Четверть</label>
        </fieldset>
        <GroupSelection groups={groups} value={selectedGroups} onChange={setSelectedGroups} disabled={busy} label="Группы" />
        <button type="button" className="clear-schedule-current" onClick={() => setSelectedGroups([currentGroupId])} disabled={busy || !groups.some((group) => group.id === currentGroupId)}>Только текущая группа</button>
        <p className="clear-schedule-preview" aria-live="polite">
          {previewBusy ? "Подсчёт…" : <>Будет очищено занятий: <strong>{removedCount}</strong></>}
        </p>
        {error && <p className="clear-schedule-error" role="alert">{error}</p>}
      </div>
      <footer className="clear-schedule-footer">
        <button type="button" onClick={onClose} disabled={busy}>Отмена</button>
        <button type="button" className="clear-schedule-primary" onClick={() => void apply()} disabled={busy || previewBusy || !removedCount}>
          <ActionLabel action="delete">Очистить {removedCount} занятий</ActionLabel>
        </button>
      </footer>
    </dialog>
  );
}
