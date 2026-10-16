import ActionLabel from "./ActionLabel";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { StateResponse } from "../server/contracts.ts";
import { roomKinds } from "../shared/catalog.ts";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";
import { findUnavailability } from "../shared/unavailability.ts";
import { getJointLessonSource, type JointLessonOptions, type JointPreview } from "../shared/jointLessons.ts";
import "./joint-lesson.css";

type Props = {
  state: StateResponse;
  revision: number;
  csrfToken: string;
  onUnauthorized: () => void;
  currentQuarterId: string;
  sourceGroupId: string;
  sourceLessonId: string;
  onApply: (options: JointLessonOptions & { sourceDate: string; sourceWeekOffset: number }) => void | Promise<void>;
  onClose: () => void;
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (date: string) => new Intl.DateTimeFormat("ru", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const groupNameForSort = (state: StateResponse, id: string) => state.catalog.groups.find(group => group.id === id)?.name ?? id;

export default function JointLessonDialog({ state, revision, csrfToken, onUnauthorized, currentQuarterId, sourceGroupId, sourceLessonId, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sourceResult = useMemo(() => {
    try { return { value: getJointLessonSource(state, sourceGroupId, sourceLessonId), error: "" }; }
    catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : "Не удалось открыть урок." }; }
  }, [state, sourceGroupId, sourceLessonId]);
  const source = sourceResult.value;
  const subject = source ? state.catalog.subjects.find(item => item.id === source.lesson.subjectId) : undefined;
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [teacherId, setTeacherId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [startText, setStartText] = useState("");
  const [duration, setDuration] = useState(45);
  const [autoTime, setAutoTime] = useState(true);
  const [groupToAdd, setGroupToAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const teachers = useMemo(() => state.catalog.teachers.filter(teacher => !teacher.archived && (!subject || teacher.subjectIds.includes(subject.id))).sort((a, b) => a.name.localeCompare(b.name, "ru")), [state.catalog.teachers, subject]);
  useEffect(() => {
    if (!source) return;
    setGroupIds(source.lockedGroupIds);
    setTeacherId(teachers.some(teacher => teacher.id === source.lesson.teacherId) ? source.lesson.teacherId ?? "" : "");
    setRoomId("");
    setStartText(clock(source.start));
    setDuration(source.duration);
    setAutoTime(true);
    setGroupToAdd("");
  }, [source, teachers]);

  const requestedStart = /^\d{2}:\d{2}$/.test(startText) ? Number(startText.slice(0, 2)) * 60 + Number(startText.slice(3)) : source?.start ?? 0;
  const [eligibleIds, setEligibleIds] = useState<string[]>([]);
  const [lockedGroupIds, setLockedGroupIds] = useState<string[]>([]);
  const [eligibleBusy, setEligibleBusy] = useState(false);
  const [preview, setPreview] = useState<Omit<JointPreview, "schedule"> | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const jointOptions = useMemo(() => source ? ({
    quarterId: currentQuarterId, sourceGroupId, sourceLessonId, groupIds, teacherId,
    roomId: roomId || undefined, start: requestedStart, duration, autoTime,
    sourceDate: source.date, sourceWeekOffset: source.location.weekOffset,
  }) : null, [source, currentQuarterId, sourceGroupId, sourceLessonId, groupIds, teacherId, roomId, requestedStart, duration, autoTime]);
  useEffect(() => {
    setPreview(null); setPreviewError("");
    if (!jointOptions || groupIds.length < 1) { setEligibleIds([]); return; }
    const controller = new AbortController();
    setEligibleBusy(true);
    void api<{ eligibleGroupIds: string[]; lockedGroupIds: string[] }>("/api/schedule-operations/joint-candidates", {
      method: "POST", headers: { "x-csrf-token": csrfToken },
      body: JSON.stringify({ revision, options: jointOptions }), signal: controller.signal,
    }).then(result => {
      if (!controller.signal.aborted) {
        setEligibleIds(result.eligibleGroupIds.slice().sort((left, right) => groupNameForSort(state, left).localeCompare(groupNameForSort(state, right), "ru", { numeric: true })));
        setLockedGroupIds(result.lockedGroupIds);
        setGroupIds(current => [...new Set([...current, ...result.lockedGroupIds])]);
      }
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setPreviewError(reason instanceof Error ? reason.message : "Не удалось подобрать группы.");
      setEligibleIds([]);
    }).finally(() => { if (!controller.signal.aborted) setEligibleBusy(false); });
    return () => controller.abort();
  }, [jointOptions, groupIds.length, revision, csrfToken, state, onUnauthorized]);
  useEffect(() => {
    setPreview(null); setPreviewError("");
    if (!jointOptions || groupIds.length < 2 || !/^\d{2}:\d{2}$/.test(startText)) return;
    const controller = new AbortController();
    setPreviewBusy(true);
    void api<{ revision: number } & Omit<JointPreview, "schedule">>("/api/schedule-operations/preview", {
      method: "POST", headers: { "x-csrf-token": csrfToken },
      body: JSON.stringify({ revision, operation: "joint", options: jointOptions }), signal: controller.signal,
    }).then(result => { if (!controller.signal.aborted) setPreview(result); }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setPreviewError(reason instanceof Error ? reason.message : "Не удалось построить предпросмотр.");
    }).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [jointOptions, groupIds.length, startText, revision, csrfToken, onUnauthorized]);
  const eligible = eligibleIds.map(id => state.catalog.groups.find(group => group.id === id)).filter((group): group is NonNullable<typeof group> => !!group);

  const selectedCount = groupIds.reduce((sum, id) => sum + (state.catalog.groups.find(group => group.id === id)?.students ?? 0), 0);
  const resolvedStart = autoTime ? preview?.time?.start ?? requestedStart : requestedStart;
  const roomReasons = new Map(state.catalog.rooms.map(room => {
    const suitability = room.archived ? null : roomSuitabilityReason(state.catalog, {
      subjectId: subject?.id ?? source?.lesson.subjectId ?? "",
      lessonKind: source?.lesson.lessonKind,
      groupId: groupIds[0] ?? sourceGroupId,
      groupIds,
      roomId: room.id,
    });
    const unavailable = findUnavailability(state.catalog, "room", room.id, source?.date ?? "", resolvedStart, resolvedStart + duration).length > 0;
    return [room.id, suitability ?? (unavailable ? "Кабинет недоступен в это время" : "")] as const;
  }));
  const rooms = state.catalog.rooms.filter(room => !room.archived && (!roomReasons.get(room.id) || room.id === roomId))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const groupName = (id: string) => state.catalog.groups.find(group => group.id === id)?.name ?? id;
  const previewRoom = preview?.roomId ? rooms.find(room => room.id === preview.roomId) : undefined;
  const ready = !!preview && preview.changes.length > 0 && !preview.conflict && !previewBusy;

  function toggleGroup(id: string) {
    if (lockedGroupIds.includes(id)) return;
    setGroupIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    setError("");
  }
  async function apply() {
    if (!preview || !ready || busy) return;
    setBusy(true); setError("");
    try { if (!jointOptions) return; await onApply(jointOptions); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить общий урок."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="joint-lesson-dialog" aria-labelledby="joint-lesson-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="joint-lesson-header"><div><h2 id="joint-lesson-title">Объединить группы</h2><p>{source && <>{subject?.name ?? source.lesson.event ?? "Урок"} · {dateLabel(source.date)} · {groupName(sourceGroupId)}</>}</p></div><button type="button" aria-label="Закрыть" onClick={onClose} disabled={busy}>×</button></header>
    <div className="joint-lesson-content">
      {sourceResult.error && <p className="joint-lesson-error" role="alert">{sourceResult.error}</p>}
      {source && <>
        <p className="joint-lesson-policy">Выберите подходящие группы. При автоматическом согласовании время урока и перемены подстроятся в пределах свободной сетки; другие занятия останутся без изменений.</p>
        <div className="joint-lesson-grid">
          <label>Начало урока <input aria-label="Начало урока" inputMode="numeric" placeholder="08:30" value={autoTime ? clock(preview?.time?.start ?? requestedStart) : startText} disabled={autoTime || busy} onChange={event => setStartText(event.target.value)} onBlur={() => { const match = startText.match(/^(\d{1,2}):(\d{2})$/); if (match) setStartText(`${match[1].padStart(2, "0")}:${match[2]}`); }} /></label>
          <label>Длительность, мин <input type="number" min={1} max={180} step={1} disabled={busy} value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>
          <label>Учитель <select disabled={busy} value={teacherId} onChange={event => setTeacherId(event.target.value)}><option value="">Не назначен</option>{teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select></label>
          <label>Кабинет <select disabled={busy} value={roomId} onChange={event => setRoomId(event.target.value)}><option value="">Автоматически</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name} · {room.capacity == null ? "вместимость не задана" : `${room.capacity} мест`} · {roomKinds[room.kind]}{roomReasons.get(room.id) ? " · текущий, не подходит" : ""}</option>)}</select></label>
        </div>
        <section className="joint-lesson-groups"><h3>Группы · {selectedCount} учеников</h3>
          <div className="joint-lesson-add-group"><label htmlFor="joint-lesson-group-select">Добавить группу</label><select id="joint-lesson-group-select" value={groupToAdd} disabled={busy || eligibleBusy || !eligible.length} onChange={event => { const id = event.target.value; setGroupToAdd(id); if (id) { toggleGroup(id); setGroupToAdd(""); } }}><option value="">{eligibleBusy ? "Подбор…" : eligible.length ? "Выберите группу…" : groupIds.length > 1 ? "Других подходящих групп нет" : "Подходящих групп нет"}</option>{eligible.map(group => <option key={group.id} value={group.id}>{group.name} · {group.students} уч.</option>)}</select></div>
          <div className="joint-lesson-selected-groups" aria-label="Выбранные группы">{groupIds.map(id => <div className="joint-lesson-selected-group" key={id}><span><strong>{groupName(id)}</strong><small>{sourceGroupId === id ? "Исходная группа" : lockedGroupIds.includes(id) ? "Уже участвует в общем уроке" : `${state.catalog.groups.find(group => group.id === id)?.students ?? "?"} учеников`}</small></span>{!lockedGroupIds.includes(id) && <button type="button" aria-label={`Убрать группу ${groupName(id)}`} disabled={busy} onClick={() => toggleGroup(id)}>×</button>}</div>)}</div>
          {groupIds.length === 1 && <p className="joint-lesson-empty-groups">Добавьте группу с планом по этому предмету и разрешённым совместным занятием.</p>}
        </section>
        <label className="joint-lesson-auto-time"><input type="checkbox" checked={autoTime} disabled={busy} onChange={event => { if (!event.target.checked && preview?.time) setStartText(clock(preview.time.start)); setAutoTime(event.target.checked); }} /><span><strong>Согласовать время автоматически</strong><small>Подберём общее время урока и подстроим соседние перемены.</small></span></label>
        {autoTime && preview?.time && <p className="joint-lesson-resolved-time">Общее время: <strong>{clock(preview.time.start)}–{clock(preview.time.start + preview.time.duration)}</strong></p>}
        {preview && <section className="joint-lesson-preview"><h3>Предпросмотр</h3><p>Всего учеников: <strong>{preview.students}</strong> · Кабинет: <strong>{previewRoom?.name ?? (roomId ? "не выбран" : "не удалось подобрать")}</strong></p>
          <div className="joint-lesson-changes">{preview.changes.map((change, index) => <div key={`${change.groupId}:${change.date}:${change.slot}:${change.lessonId ?? index}`}><strong>{groupName(change.groupId)}</strong><span>{clock(preview.time?.start ?? requestedStart)} · {preview.time?.duration ?? duration} мин</span><em>{change.kind === "existing" ? "Общий урок" : change.kind === "merge" ? "Объединить существующий" : "Добавить урок"}</em></div>)}</div>
          {!!preview.timingChanges?.length && <div className="joint-lesson-timing-changes"><h4>Изменится расписание</h4>{preview.timingChanges.map(change => <p key={change.groupId}><strong>{groupName(change.groupId)}</strong><span>{clock(change.before.start)}–{clock(change.before.start + change.before.duration)} → {clock(change.after.start)}–{clock(change.after.start + change.after.duration)}</span>{change.breaksBefore.some((value, index) => value !== change.breaksAfter[index]) && <small>Перемены: {change.breaksBefore.join(", ")} → {change.breaksAfter.join(", ")} мин</small>}</p>)}</div>}
          <div className="joint-lesson-hours">{preview.hours.map(item => <p key={`${item.groupId}:${item.subjectId}`}><strong>{groupName(item.groupId)}</strong> · план {item.target} ч. · {item.before} → {item.after} ч. ({item.after - item.before >= 0 ? "+" : ""}{item.after - item.before})</p>)}</div>
          {preview.conflict && <p className="joint-lesson-error" role="alert">{preview.conflict}</p>}
          {preview.undoConflict && <p className="joint-lesson-warning" role="status">Отмена этого действия будет запрещена: {preview.undoConflict}</p>}
        </section>}
        {(previewError || (groupIds.length > 1 && previewBusy)) && <p className="joint-lesson-error" role={previewError ? "alert" : "status"}>{previewError || "Проверяем доступность…"}</p>}
        {lockedGroupIds.length > 1 && <p className="joint-lesson-policy">Участники исходного общего урока отмечены и закреплены.</p>}
      </>}
      {error && <p className="joint-lesson-error" role="alert">{error}</p>}
    </div>
    <footer className="joint-lesson-footer"><span>{groupIds.length < 2 ? "Выберите минимум две группы" : preview?.conflict ? "Исправьте конфликт перед применением" : "Проверьте изменения перед применением"}</span><button type="button" onClick={onClose} disabled={busy}>Отмена</button><button type="button" className="joint-lesson-primary" onClick={() => void apply()} disabled={!ready || busy}><ActionLabel action="apply">{busy ? "Применение…" : "Применить"}</ActionLabel></button></footer>
  </dialog>;
}
