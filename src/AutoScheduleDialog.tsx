import ActionLabel from "./ActionLabel";
import GroupSelection from "./GroupSelection";
import InfoTooltip from "./InfoTooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { Catalog } from "../shared/catalog.ts";
import type { BellSettings } from "../shared/bellSchedule.ts";
import type { SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { TeacherComfortSummary } from "../shared/teacherScheduleComfort.ts";
import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { TemporaryTeacherReplacement } from "../shared/temporaryTeacherReplacements.ts";
import type { TeacherTeachingAssignment } from "../shared/teacherReassignment.ts";
import type { Schedule } from "./editor.ts";
import { formatTime } from "./editor.ts";
import type { GenerationProgress, GenerationResult } from "../shared/generateSchedule.ts";
import "./auto-schedule.css";

type Props = {
  catalog: Catalog;
  quarter: Quarter;
  schedule: Schedule;
  studyPlans: StudyPlan[];
  temporaryTeacherReplacements?: TemporaryTeacherReplacement[];
  teachingAssignments?: TeacherTeachingAssignment[];
  bellSettings?: BellSettings;
  calendar?: SchoolCalendar;
  currentGroupId: string;
  revision: number;
  csrfToken: string;
  onUnauthorized: () => void;
  onClose: () => void;
  onJobApplied: () => void | Promise<void>;
};

type GeneratedPlacementView = GenerationResult["added"][number] & { start: number | null; duration: number | null };
type GeneratedTeacherComfort = {
  before: TeacherComfortSummary;
  after: TeacherComfortSummary;
  teachers: Array<{ teacherId: string; name: string; before: TeacherComfortSummary; after: TeacherComfortSummary }>;
};
type Generated = Omit<GenerationResult, "schedule" | "added"> & {
  added: GeneratedPlacementView[];
  teacherComfort: GeneratedTeacherComfort;
};
const collator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("ru", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

export default function AutoScheduleDialog({
  catalog,
  quarter,
  schedule,
  studyPlans,
  temporaryTeacherReplacements,
  teachingAssignments,
  bellSettings,
  calendar,
  currentGroupId,
  revision,
  csrfToken,
  onUnauthorized,
  onClose,
  onJobApplied,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(
    () =>
      catalog.groups
        .filter((group) => !group.archived)
        .sort((a, b) => collator.compare(a.name, b.name)),
    [catalog.groups],
  );
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() =>
    groups.some((group) => group.id === currentGroupId)
      ? [currentGroupId]
      : groups.slice(0, 1).map((group) => group.id),
  );
  const [filterGroup, setFilterGroup] = useState("all");
  const [result, setResult] = useState<Generated | null>(null);
  const [preserveExisting, setPreserveExisting] = useState(true);
  const [allowJointLessons, setAllowJointLessons] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState("");
  const jobIdRef = useRef<string | null>(null);
  const generatedRevisionRef = useRef<number | null>(null);
  const applyRequestRef = useRef<{ jobId: string; revision: number; requestId: string } | null>(null);
  const requestIdRef = useRef(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => generateRef.current?.focus());
  }, []);

  function terminateGeneration() {
    requestIdRef.current += 1;
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    if (jobId) void api(`/api/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST", headers: { "x-csrf-token": csrfToken }, body: "{}",
    }).catch(() => undefined);
    setGenerating(false);
    setBusy(false);
    setProgress(null);
  }

  useEffect(() => () => {
    requestIdRef.current += 1;
    const jobId = jobIdRef.current;
    if (jobId) void api(`/api/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST", headers: { "x-csrf-token": csrfToken }, body: "{}",
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!generating) return;
    terminateGeneration();
    setResult(null);
    setError("Исходные данные изменились. Запустите составление ещё раз.");
    // A calculation belongs to the exact props snapshot used to start it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, quarter.id, schedule, studyPlans, temporaryTeacherReplacements, teachingAssignments, bellSettings, calendar]);

  const groupName = (id: string) =>
    catalog.groups.find((group) => group.id === id)?.name ?? "Группа удалена";
  const subjectName = (id: string) =>
    catalog.subjects.find((subject) => subject.id === id)?.name ??
    "Предмет удалён";
  const teacherName = (id: string) =>
    catalog.teachers.find((teacher) => teacher.id === id)?.name ??
    "Преподаватель удалён";
  const roomName = (id: string | null) =>
    id
      ? (catalog.rooms.find((room) => room.id === id)?.name ?? "Кабинет удалён")
      : "—";
  const subgroupName = (id?: string | null) =>
    id
      ? (catalog.subgroups.find((subgroup) => subgroup.id === id)?.name ??
        "Подгруппа")
      : "";

  const visibleAdded = (result?.added ?? [])
    .filter((item) => filterGroup === "all" || item.groupId === filterGroup)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.slot - b.slot ||
        groupName(a.groupId).localeCompare(groupName(b.groupId), "ru"),
    );
  const visibleRemaining = (result?.remaining ?? []).filter(
    (item) => filterGroup === "all" || item.groupId === filterGroup,
  );
  const shownAdded = showAll ? visibleAdded : visibleAdded.slice(0, 100);
  const teacherComfort = result?.teacherComfort ?? null;

  function changeSelectedGroups(ids: string[]) {
    setSelectedGroups(ids);
    setResult(null);
    setError("");
  }
  async function generate() {
    if (!selectedGroups.length || busy) return;
    setBusy(true);
    setGenerating(true);
    setError("");
    setResult(null);
    setProgress({ percent: 0, phase: "preparing" });
    setShowAll(false);
    const id = ++requestIdRef.current;
    try {
      const started = await api<{ id: string; revision: number }>("/api/generation-jobs", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: JSON.stringify({ revision, quarterId: quarter.id, groupIds: selectedGroups, options: { preserveExisting, allowJointLessons } }),
      });
      if (id !== requestIdRef.current) {
        void api(`/api/generation-jobs/${encodeURIComponent(started.id)}/cancel`, {
          method: "POST", headers: { "x-csrf-token": csrfToken }, body: "{}",
        }).catch(() => undefined);
        return;
      }
      jobIdRef.current = started.id;
      generatedRevisionRef.current = started.revision;
      while (id === requestIdRef.current) {
        const status = await api<{
          status: "running" | "complete" | "failed" | "cancelled" | "applied";
          progress: GenerationProgress;
          result?: Generated;
          error?: string;
        }>(`/api/generation-jobs/${encodeURIComponent(started.id)}`);
        if (id !== requestIdRef.current) return;
        setProgress(status.progress);
        if (status.status === "complete" && status.result) {
          jobIdRef.current = started.id;
          setResult(status.result);
          setProgress({ percent: 100, phase: "done" });
          setGenerating(false);
          setBusy(false);
          return;
        }
        if (status.status === "failed" || status.status === "cancelled" || status.status === "applied")
          throw new Error(status.error ?? "Составление завершилось без результата.");
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
    } catch (reason) {
      if (id !== requestIdRef.current) return;
      jobIdRef.current = null;
      setGenerating(false);
      setBusy(false);
      setProgress(null);
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось составить расписание.");
    }
  }
  async function apply() {
    if (!result || (!result.added.length && result.removedCount === 0) || busy) return;
    setBusy(true);
    setError("");
    try {
      const jobId = jobIdRef.current;
      const generatedRevision = generatedRevisionRef.current;
      if (!jobId || generatedRevision === null) throw new Error("Расчёт устарел. Запустите его ещё раз.");
      const pending = applyRequestRef.current?.jobId === jobId && applyRequestRef.current.revision === generatedRevision
        ? applyRequestRef.current
        : { jobId, revision: generatedRevision, requestId: `generation-${crypto.randomUUID()}` };
      applyRequestRef.current = pending;
      await api(`/api/generation-jobs/${encodeURIComponent(jobId)}/apply`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: JSON.stringify({ revision: pending.revision, requestId: pending.requestId }),
      });
      applyRequestRef.current = null;
      jobIdRef.current = null;
      await onJobApplied();
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      if (reason instanceof ApiError && reason.status === 409) applyRequestRef.current = null;
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось применить расписание.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      className={`auto-schedule-dialog${result ? "" : " auto-schedule-dialog--compact"}`}
      ref={dialogRef}
      aria-labelledby="auto-schedule-title"
      onCancel={(event) => {
        event.preventDefault();
        if (generating) {
          terminateGeneration();
          setError("Составление отменено.");
          return;
        }
        if (!busy) onClose();
      }}
    >
      <header className="auto-schedule-header">
        <div>
          <h2 id="auto-schedule-title">Автосоставление · {quarter.name} <InfoTooltip label="Расчёт расписания">Расчёт заполняет всю четверть: до 7 уроков в день, с распределением нагрузки по учебным дням и неделям. Уроки подгрупп в одной ячейке считаются одним. Число уроков в отдельной неделе может измениться.</InfoTooltip></h2>
          <p>
            {quarter.startDate} — {quarter.endDate}
          </p>
        </div>
        <button
          type="button"
          className="auto-schedule-close"
          aria-label="Закрыть"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="auto-schedule-controls">
        <GroupSelection groups={groups} value={selectedGroups} onChange={changeSelectedGroups} disabled={busy} label="Группы" />
        <div className="auto-schedule-options">
          <label className="auto-schedule-preserve">
            <input
              type="checkbox"
              checked={preserveExisting}
              onChange={(event) => {
                setPreserveExisting(event.target.checked);
                setResult(null);
                setError("");
              }}
              disabled={busy}
            />
            Сохранить уже заполненные уроки
          </label>
          <label className="auto-schedule-preserve">
            <input
              type="checkbox"
              checked={allowJointLessons}
              onChange={(event) => {
                setAllowJointLessons(event.target.checked);
                setResult(null);
                setProgress(null);
                setError("");
              }}
              disabled={busy}
            />
            Объединять уроки параллельных классов
          </label>
        </div>

      </div>
      {progress && (generating || result) && (
        <div className="auto-schedule-progress" role="status" aria-live="polite">
          <div className="auto-schedule-progress-copy">
            <span>
              {progress.phase === "preparing" && "Подготавливаю данные"}
              {progress.phase === "placing" && "Распределяю уроки"}
              {progress.phase === "joining" && "Объединяю совместные уроки"}
              {progress.phase === "finalizing" && "Завершаю расчёт"}
              {progress.phase === "done" && "Расписание рассчитано"}
            </span>
            <strong>{progress.percent}%</strong>
          </div>
          <progress max={100} value={progress.percent} aria-label="Ход составления расписания" />
          {generating && <button type="button" className="auto-schedule-cancel-generation" onClick={() => {
            terminateGeneration();
            setResult(null);
            setError("Составление отменено.");
          }}>
            Отменить расчёт
          </button>}
        </div>
      )}
      {!preserveExisting && (
        <p className="auto-schedule-clear-warning" role="alert">
          При применении предложения будут заменены все занятия выбранных групп за четверть
          ({quarter.startDate} — {quarter.endDate}), включая мероприятия. До применения расписание не меняется.
        </p>
      )}
      {error && (
        <p className="auto-schedule-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="auto-schedule-summary" aria-live="polite">
            <strong>Добавлено: {result.added.length}</strong>
            <span>Будет удалено: {result.removedCount}</span>
            <span>
              Не распределено:{" "}
              {result.remaining.reduce((sum, item) => sum + item.missing, 0)} ч
            </span>
            <span>
              Уроков вне предпочтительных кабинетов: {result.fallbackRoomCount}
            </span>
            <label>
              Показать{" "}
              <select
                value={filterGroup}
                onChange={(event) => {
                  setFilterGroup(event.target.value);
                  setShowAll(false);
                }}
              >
                <option value="all">Все группы</option>
                {selectedGroups.map((id) => (
                  <option key={id} value={id}>
                    {groupName(id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="auto-schedule-note">
            Автосоставление старается уменьшить перерывы учителей и учесть предпочтительную смену.
            Занятия в обеих сменах допустимы; распределение может быть не оптимальным.
            Проверьте назначения перед применением.
          </p>
          {result.removedCount > 0 && result.added.length === 0 && (
            <p className="auto-schedule-clear-warning" role="alert">
              Новые уроки не составлены. Применение очистит {result.removedCount} существующих занятий.
            </p>
          )}
          <section
            className="auto-schedule-results"
            aria-label="Предварительный просмотр расписания"
          >
            {teacherComfort && teacherComfort.teachers.length > 0 && <section className="auto-schedule-comfort" aria-label="Перерывы и смены учителей">
              <h3>Перерывы и смены учителей</h3>
              <p>Сумма за четверть по затронутым учителям, включая их занятия в других группах. Дни работы суммируются по учителям.</p>
              <div className="auto-schedule-comfort-scroll"><table>
                <thead><tr><th>Показатель</th><th><span className="auto-schedule-comfort-full-label">Черновик сейчас</span><span className="auto-schedule-comfort-short-label">Сейчас</span></th><th><span className="auto-schedule-comfort-full-label">Предложение</span><span className="auto-schedule-comfort-short-label">Расчёт</span></th></tr></thead>
                <tbody>
                  <tr><th>Длительные перерывы, мин</th><td>{teacherComfort.before.gapMinutes}</td><td>{teacherComfort.after.gapMinutes}</td></tr>
                  <tr><th>Количество перерывов</th><td>{teacherComfort.before.gapCount}</td><td>{teacherComfort.after.gapCount}</td></tr>
                  <tr><th>Дни работы в обеих сменах</th><td>{teacherComfort.before.bothShiftDays}</td><td>{teacherComfort.after.bothShiftDays}</td></tr>
                </tbody>
              </table></div>
              <details><summary>По учителям · {teacherComfort.teachers.length}</summary>
                <div className="auto-schedule-comfort-scroll auto-schedule-comfort-teachers"><table>
                  <thead><tr><th>Учитель</th><th>Перерывы, мин<br/>до → после</th><th>Обе смены, дней<br/>до → после</th></tr></thead>
                  <tbody>{teacherComfort.teachers.map(teacher => <tr key={teacher.teacherId}><td>{teacher.name}</td><td>{teacher.before.gapMinutes} → {teacher.after.gapMinutes}</td><td>{teacher.before.bothShiftDays} → {teacher.after.bothShiftDays}</td></tr>)}</tbody>
                </table></div>
              </details>
              <p>Обычные перемены не включены. Полностью убрать длительные перерывы получается не всегда.</p>
            </section>}
            <h3>
              Новые уроки <span>{visibleAdded.length}</span>
            </h3>
            {visibleAdded.length ? (
              <div className="auto-schedule-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>День</th>
                      <th>Время</th>
                      <th>Группа</th>
                      <th>Предмет</th>
                      <th>Учитель</th>
                      <th>Кабинет</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownAdded.map((item) => {
                      return (
                        <tr key={item.lessonId}>
                          <td>{dateLabel(item.date)}</td>
                          <td>{item.start === null || item.duration === null ? "—" : `${formatTime(item.start)}–${formatTime(item.start + item.duration)}`}</td>
                          <td>{groupName(item.groupId)}</td>
                          <td>
                            {subjectName(item.subjectId)}
                            {item.lessonKind === "lab" ? " · лаб." : ""}
                            {item.subgroupId
                              ? ` · ${subgroupName(item.subgroupId)}`
                              : ""}
                          </td>
                          <td>{teacherName(item.teacherId)}</td>
                          <td>{roomName(item.roomId)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="auto-schedule-empty">Новых уроков нет.</p>
            )}
            {visibleAdded.length > 100 && (
              <button
                type="button"
                className="auto-schedule-more"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll
                  ? "Свернуть список"
                  : `Показать все (${visibleAdded.length})`}
              </button>
            )}
            <h3>
              Осталось распределить{" "}
              <span>
                {visibleRemaining.reduce((sum, item) => sum + item.missing, 0)}{" "}
                ч
              </span>
            </h3>
            {visibleRemaining.length ? (
              <div className="auto-schedule-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Группа</th>
                      <th>Предмет</th>
                      <th>Назначено</th>
                      <th>Не хватает</th>
                      <th>Причина</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRemaining.map((item, index) => (
                      <tr
                        key={`${item.groupId}-${item.subjectId}-${item.subgroupId ?? "all"}-${item.lessonKind}-${index}`}
                      >
                        <td>{groupName(item.groupId)}</td>
                        <td>
                          {subjectName(item.subjectId)}
                          {item.lessonKind === "lab" ? " · лаб." : ""}
                          {item.subgroupId
                            ? ` · ${subgroupName(item.subgroupId)}`
                            : ""}
                        </td>
                        <td>
                          {item.placed} / {item.target}
                        </td>
                        <td>{item.missing}</td>
                        <td>{item.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="auto-schedule-empty">Все часы распределены.</p>
            )}
          </section>
        </>
      )}
      <footer className="auto-schedule-footer">
        <button type="button" onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button
          ref={generateRef}
          type="button"
          className="auto-schedule-primary"
          onClick={generate}
          disabled={busy || !selectedGroups.length}
        >
          {busy
            ? "Составляю…"
            : result
              ? "Пересчитать"
              : "Составить расписание"}
        </button>
        {result && (
          <button
            type="button"
            className="auto-schedule-primary"
            onClick={() => void apply()}
            disabled={busy || (result.added.length === 0 && result.removedCount === 0)}
          >
            <ActionLabel action="apply">{result.removedCount > 0
              ? "Очистить и применить"
              : "Применить в черновик"}</ActionLabel>
          </button>
        )}
      </footer>
    </dialog>
  );
}
