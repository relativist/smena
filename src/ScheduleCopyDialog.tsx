import ActionLabel from "./ActionLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { StateResponse } from "../server/contracts.ts";
import { quarterWeeks, weekDates } from "../shared/plans.ts";
import type { ScheduleCopyOptions, ScheduleCopyPreview } from "../shared/scheduleCopy.ts";
import "./schedule-copy.css";

type Props = {
  state: StateResponse;
  revision: number;
  csrfToken: string;
  onUnauthorized: () => void;
  quarterId: string;
  sourceGroupId: string;
  sourceWeekOffset: number;
  sourceLessonId?: string;
  onApply: (options: ScheduleCopyOptions) => void | Promise<void>;
  onClose: () => void;
};
type CopyPreview = Omit<ScheduleCopyPreview, "schedule"> & { details?: Array<{ lessonId: string; start: number; duration: number; teacherId?: string; roomId?: string }> };

const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short" }) =>
  new Intl.DateTimeFormat("ru", { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export default function ScheduleCopyDialog({ state, revision, csrfToken, onUnauthorized, quarterId, sourceGroupId, sourceWeekOffset, sourceLessonId, onApply, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [targetWeekOffsets, setTargetWeekOffsets] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mode = sourceLessonId ? "lesson" : "week";
  const quarter = state.quarters.find((item) => item.id === quarterId);
  const offsets = useMemo(() => quarter ? quarterWeeks(quarter).filter((offset) => offset !== sourceWeekOffset) : [], [quarter, sourceWeekOffset]);
  const datesForWeek = (offset: number) => weekDates(offset).filter((date) => !!quarter && date >= quarter.startDate && date <= quarter.endDate);
  const sourceDates = weekDates(sourceWeekOffset);
  const sourceDay = sourceLessonId
    ? (state.schedule[`${sourceGroupId}:${sourceWeekOffset}`] ?? []).find((day) => day.date && sourceDates.includes(day.date) && day.slots.some((slot) => slot.some((lesson) => lesson.id === sourceLessonId)))
    : undefined;
  const sourceLesson = sourceDay?.slots.flat().find((lesson) => lesson.id === sourceLessonId);
  const sourceSubject = sourceLesson ? sourceLesson.event ?? state.catalog.subjects.find((item) => item.id === sourceLesson.subjectId)?.name ?? "Предмет удалён" : "";
  const sourceWeekLabel = `${dateLabel(sourceDates[0], { day: "numeric", month: "long" })} — ${dateLabel(sourceDates[6], { day: "numeric", month: "long", year: "numeric" })}`;
  const groupName = (id: string) => state.catalog.groups.find((group) => group.id === id)?.name ?? "Группа удалена";
  const subjectName = (id: string) => state.catalog.subjects.find((subject) => subject.id === id)?.name ?? "Предмет удалён";
  const teacherName = (id?: string) => id ? state.catalog.teachers.find((teacher) => teacher.id === id)?.name ?? "Преподаватель удалён" : "учитель не назначен";
  const roomName = (id?: string | null) => id ? state.catalog.rooms.find((room) => room.id === id)?.name ?? "кабинет удалён" : "кабинет не назначен";
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const selectedWeeks = useMemo(() => new Set(targetWeekOffsets), [targetWeekOffsets]);
  const allSelected = offsets.length > 0 && offsets.every((offset) => selectedWeeks.has(offset));

  useEffect(() => { if (!dialogRef.current?.open) dialogRef.current?.showModal(); }, []);
  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (!quarter || !targetWeekOffsets.length || (mode === "lesson" && !sourceLessonId)) return;
    const controller = new AbortController();
    setPreviewBusy(true);
    const options: ScheduleCopyOptions = { mode, quarterId, sourceGroupId, sourceWeekOffset, ...(sourceLessonId ? { sourceLessonId } : {}), targetWeekOffsets };
    void api<{ revision: number } & CopyPreview>("/api/schedule-operations/preview", {
      method: "POST", headers: { "x-csrf-token": csrfToken },
      body: JSON.stringify({ revision, operation: "copy", options }), signal: controller.signal,
    }).then(result => { if (!controller.signal.aborted) setPreview(result); })
      .catch(reason => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
        setPreviewError(reason instanceof Error ? reason.message : "Не удалось построить предпросмотр.");
      }).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [state, revision, csrfToken, onUnauthorized, quarter, mode, quarterId, sourceGroupId, sourceWeekOffset, sourceLessonId, targetWeekOffsets]);
  function toggleWeek(offset: number) {
    setTargetWeekOffsets((current) => current.includes(offset) ? current.filter((item) => item !== offset) : [...current, offset].sort((a, b) => a - b));
    setError("");
  }
  async function apply() {
    if (!preview?.added.length || busy || previewBusy) return;
    setBusy(true);
    setError("");
    try { await onApply({ mode, quarterId, sourceGroupId, sourceWeekOffset, ...(sourceLessonId ? { sourceLessonId } : {}), targetWeekOffsets }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить расписание."); }
    finally { setBusy(false); }
  }
  const hourGroups = useMemo(() => {
    if (!preview) return [];
    const groups = new Map<string, typeof preview.hours>();
    for (const item of preview.hours.filter((row) => row.before !== row.after)) {
      const list = groups.get(item.groupId) ?? [];
      list.push(item);
      groups.set(item.groupId, list);
    }
    return [...groups.entries()];
  }, [preview]);

  return <dialog ref={dialogRef} className="schedule-copy-dialog" aria-labelledby="schedule-copy-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="schedule-copy-header">
      <div><h2 id="schedule-copy-title">{mode === "week" ? "Копировать неделю" : "Повторить урок"}</h2><p>{quarter?.name ?? "Четверть не найдена"} · {groupName(sourceGroupId)} · {sourceWeekLabel}</p></div>
      <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>×</button>
    </header>
    <main className="schedule-copy-content">
      {mode === "lesson" && <p className="schedule-copy-source"><strong>{sourceSubject || "Исходный урок не найден"}</strong>{sourceLesson && sourceDay ? ` · ${dateLabel(sourceDay.date, { weekday: "long" })} · урок ${sourceDay.slots.findIndex((slot) => slot.some((lesson) => lesson.id === sourceLessonId)) + 1}` : ""}</p>}
      <p className="schedule-copy-policy">Время и длительность берутся из расписания каждого дня назначения. Уже занятые места сохраняются, каникулы и конфликты будут показаны в пропусках. Совместные занятия учитываются вместе.</p>
      {!!preview?.linkedGroupIds?.length && <p className="schedule-copy-linked">Совместный урок также затронет: {preview.linkedGroupIds.map(groupName).join(", ")}.</p>}
      <section className="schedule-copy-weeks" aria-label="Недели назначения">
        <div className="schedule-copy-section-title"><strong>Куда копировать</strong><button type="button" disabled={busy || !offsets.length} onClick={() => setTargetWeekOffsets(allSelected ? [] : offsets)}>{allSelected ? "Снять выбор" : "Выбрать все"}</button></div>
        <div className="schedule-copy-week-list">
          {offsets.map((offset) => {
            const dates = datesForWeek(offset);
            const label = dates.length ? `${dateLabel(dates[0], { day: "numeric", month: "short" })} — ${dateLabel(dates[dates.length - 1], { day: "numeric", month: "short" })}` : "Нет учебных дат";
            return <label key={offset}><input type="checkbox" checked={selectedWeeks.has(offset)} disabled={busy} onChange={() => toggleWeek(offset)} /><span>{label}</span></label>;
          })}
          {!offsets.length && <p>В этой четверти нет других недель для назначения.</p>}
        </div>
      </section>
      {preview && <section className="schedule-copy-results" aria-live="polite">
        <div className="schedule-copy-counts"><span><strong>{preview.added.length}</strong> добавится</span><span><strong>{preview.skipped.length}</strong> будет пропущено</span><span><strong>{preview.sourceLessonCount}</strong> в источнике</span></div>
        {preview.added.length + preview.skipped.length > 0 && <div className="schedule-copy-row-list">
          {preview.added.map((row, index) => {
            const detail = preview.details?.find(item => item.lessonId === row.lessonId);
            return <article className="schedule-copy-row" key={`a-${row.groupId}-${row.date}-${row.slot}-${row.sourceLessonId}-${index}`}>
              <span className="schedule-copy-status is-added">Добавится</span><div><strong>{dateLabel(row.date, { weekday: "short", day: "2-digit", month: "short" })} · урок {row.slot + 1} · {groupName(row.groupId)}</strong><span>{row.event ?? subjectName(row.subjectId)}{detail ? ` · ${clock(detail.start)}–${clock(detail.start + detail.duration)} · ${teacherName(detail.teacherId)} · ${roomName(detail.roomId)}` : ""}</span></div>
            </article>;
          })}
          {preview.skipped.map((row, index) => <article className="schedule-copy-row" key={`s-${row.groupId}-${row.date}-${row.slot}-${row.sourceLessonId}-${index}`}>
            <span className="schedule-copy-status is-skipped">Пропуск</span><div><strong>{dateLabel(row.date, { weekday: "short", day: "2-digit", month: "short" })} · урок {row.slot + 1} · {groupName(row.groupId)}</strong><span>{row.event ?? subjectName(row.subjectId)} · {row.reason}</span></div>
          </article>)}
        </div>}
        {!!hourGroups.length && <details className="schedule-copy-hours"><summary>Часы за четверть · {hourGroups.reduce((count, [, entries]) => count + entries.length, 0)} изменений</summary>
          {hourGroups.map(([groupId, entries]) => <div key={groupId} className="schedule-copy-hour-group"><strong>{groupName(groupId)}</strong>{entries.map((item, index) => <p key={`${item.subjectId}-${item.subgroupId ?? ""}-${index}`}>{subjectName(item.subjectId)}{item.subgroupId ? ` · ${state.catalog.subgroups.find((subgroup) => subgroup.id === item.subgroupId)?.name ?? "Подгруппа"}` : ""}: {item.before} → {item.after} из {item.target}{item.after > item.target ? " · выше плана" : ""}</p>)}</div>)}
        </details>}
      </section>}
      {!targetWeekOffsets.length && <p className="schedule-copy-empty">Выберите недели назначения, чтобы посмотреть результат.</p>}
      {(previewError || error) && <p className="schedule-copy-error" role="alert">{previewError || error}</p>}
    </main>
    <footer className="schedule-copy-footer"><span>{previewBusy ? "Расчёт…" : preview ? `${preview.added.length} добавится · ${preview.skipped.length} пропусков` : "Выберите недели для предпросмотра"}</span><button type="button" onClick={onClose} disabled={busy}>Отмена</button><button type="button" className="schedule-copy-primary" onClick={() => void apply()} disabled={busy || previewBusy || !preview?.added.length || !!previewError}><ActionLabel action="apply">{busy ? "Сохранение…" : "Применить"}</ActionLabel></button></footer>
  </dialog>;
}
