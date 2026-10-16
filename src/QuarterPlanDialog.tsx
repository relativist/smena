import { useEffect, useId, useRef } from "react";
import type { PlanCoverageDetailRow } from "../shared/planCoverage.ts";
import InfoTooltip from "./InfoTooltip";

type Props = {
  groupName: string;
  quarterName: string;
  rows: PlanCoverageDetailRow[];
  onClose: () => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
};

export default function QuarterPlanDialog({ groupName, quarterName, rows, onClose, loading, error, onRetry }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".modal-head .icon-button")?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const bySubject = new Map<string, PlanCoverageDetailRow[]>();
  for (const row of rows) bySubject.set(row.subjectId, [...(bySubject.get(row.subjectId) ?? []), row]);

  return <dialog ref={dialogRef} className="modal" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-head">
      <h2 id={titleId}>План четверти · {groupName}<InfoTooltip label="План четверти">Фактически поставленные уроки и заданный план. Сокращённый урок считается как один час.</InfoTooltip></h2>
      <button className="icon-button" type="button" autoFocus onClick={onClose} aria-label="Закрыть"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
    <p className="modal-intro">{quarterName}</p>
    {loading ? <p className="modal-intro" role="status">Загружаем план четверти…</p>
      : error ? <p className="modal-intro" role="alert">{error}{onRetry && <> <button type="button" onClick={onRetry}>Повторить</button></>}</p>
      : rows.length === 0 ? <p className="modal-intro">Для группы не задан учебный план.</p>
      : <div className="hours-table">
        <div className="hours-table-header"><span>Предмет / участники</span><span>Поставлено</span><span>План</span></div>
        {[...bySubject.entries()].map(([subjectId, subjectRows]) => <div key={subjectId} className="hours-table-group">
          {subjectRows.map((row, index) => {
            const difference = row.scheduled - row.target;
            const status = difference > 0 ? "excess" : difference === 0 ? "complete" : row.target > 0 && difference / row.target >= -0.3 ? "near" : "short";
            const description = status === "excess" ? `перебор на ${difference}` : status === "complete" ? "план выполнен" : `недобор ${Math.abs(difference)}`;
            return <div className="hours-table-row" key={row.id}>
              <span><b>{index === 0 ? row.subjectName : ""}</b>
                {row.subgroupId && <small className="hours-participant">{row.subgroupName}</small>}
                {row.lessonKind === "lab" && <small className="hours-participant">Лабораторные</small>}
              </span>
              <span className={`hours-actual hours-${status}`} aria-label={`${row.scheduled}, ${description}`}>
                {row.scheduled}
              </span>
              <span>{row.target}</span>
            </div>;
          })}
        </div>)}
      </div>}
  </dialog>;
}
