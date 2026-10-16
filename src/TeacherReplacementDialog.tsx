import { useEffect, useMemo, useRef, useState } from "react";
import ActionLabel from "./ActionLabel";
import type { Catalog } from "../shared/catalog.ts";
import { previewTeacherReplacement } from "../shared/teacherReplacement.ts";
import { newUnavailabilityViolation, unavailabilityViolationMessage } from "../shared/unavailability.ts";
import type { Schedule } from "./editor.ts";
import "./teacher-replacement.css";

type Props = {
  schedule: Schedule;
  catalog: Catalog;
  lessonIds: string[];
  onApply: (schedule: Schedule) => void | Promise<void>;
  close: () => void;
};

type Row = { id: string; groupId: string; date: string; start: number; end: number; lesson: { subjectId: string; teacherId?: string; event?: string; jointId?: string } };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (date: string) => new Intl.DateTimeFormat("ru", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export default function TeacherReplacementDialog({ schedule, catalog, lessonIds, onApply, close }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const rows = useMemo<Row[]>(() => Object.entries(schedule).flatMap(([key, days]) => {
    const groupId = key.slice(0, key.lastIndexOf(":"));
    return days.flatMap(day => day.slots.flatMap((slot, slotIndex) => {
      const time = day.times[slotIndex];
      return time ? slot.map(lesson => ({ id: lesson.id, groupId, date: day.date, start: time.start, end: time.start + time.duration, lesson })) : [];
    }));
  }), [schedule]);
  const targetIds = useMemo(() => {
    const targets = new Set(lessonIds);
    const jointKeys = new Set(rows.filter(row => targets.has(row.id) && row.lesson.jointId).map(row => `${row.date}:${row.lesson.jointId}`));
    for (const row of rows) if (row.lesson.jointId && jointKeys.has(`${row.date}:${row.lesson.jointId}`)) targets.add(row.id);
    return [...targets];
  }, [lessonIds, rows]);
  const [selected, setSelected] = useState<string[]>(() => targetIds);
  const [teacherId, setTeacherId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const teachers = useMemo(() => {
    const subjectIds = new Set(rows.filter(row => selected.includes(row.id) && !row.lesson.event && row.lesson.subjectId !== "event").map(row => row.lesson.subjectId));
    return catalog.teachers.filter(teacher => !teacher.archived && [...subjectIds].some(subjectId => teacher.subjectIds.includes(subjectId)))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [catalog.teachers, rows, selected]);
  const byId = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const preview = useMemo(() => previewTeacherReplacement(schedule, catalog, selected, teacherId), [schedule, catalog, selected, teacherId]);
  const undoViolation = useMemo(() => newUnavailabilityViolation(schedule, preview.schedule, catalog), [schedule, preview.schedule, catalog]);
  const changed = new Set(preview.changedLessonIds);
  const skipped = new Map(preview.skipped.map(item => [item.lessonId, item.reason]));
  const relevantRows = rows.filter(row => targetIds.includes(row.id));
  const teacherName = (id?: string) => catalog.teachers.find(teacher => teacher.id === id)?.name ?? "не назначен";
  const groupName = (id: string) => catalog.groups.find(group => group.id === id)?.name ?? id;
  const subjectName = (id: string) => catalog.subjects.find(subject => subject.id === id)?.name ?? "Предмет удалён";
  const selectedSubjectIds = [...new Set(relevantRows.filter(row => selected.includes(row.id) && !row.lesson.event && row.lesson.subjectId !== "event").map(row => row.lesson.subjectId))];

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  function toggle(id: string) {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    setError("");
  }
  async function apply() {
    if (!preview.changedLessonIds.length || busy) return;
    setBusy(true);
    setError("");
    try { await onApply(preview.schedule); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить замену учителя."); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="teacher-replacement-dialog" aria-labelledby="teacher-replacement-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header>
      <div><h2 id="teacher-replacement-title">Замена учителя</h2><p>Занятия останутся на своих местах. Недоступные для замены уроки будут перечислены отдельно.</p></div>
      <button type="button" aria-label="Закрыть" onClick={close} disabled={busy}>×</button>
    </header>
    <label className="teacher-replacement-choice">Новый учитель
      <select value={teacherId} onChange={event => { setTeacherId(event.target.value); setError(""); }}>
        <option value="">Выберите преподавателя</option>
        {teachers.map(teacher => {
          const matching = selectedSubjectIds.filter(subjectId => teacher.subjectIds.includes(subjectId));
          return <option key={teacher.id} value={teacher.id}>{teacher.name}{selectedSubjectIds.length > 1 ? ` — подходит: ${matching.map(subjectName).join(", ")} (${matching.length}/${selectedSubjectIds.length})` : ""}</option>;
        })}
      </select>
    </label>
    {!teachers.length && <p role="status">Нет активных преподавателей.</p>}
    {selected.length > 0 && <p className="teacher-replacement-hint">В списке преподаватели, подходящие хотя бы к одному выбранному предмету. При замене нескольких предметов неподходящие уроки будут пропущены с пояснением.</p>}
    <div className="teacher-replacement-list" aria-label="Занятия для замены">
      {relevantRows.length ? relevantRows.map(row => {
        const reason = skipped.get(row.id);
        return <label className="teacher-replacement-row" key={row.id}>
          <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggle(row.id)} />
          <span className="teacher-replacement-detail">
            <strong><span className="school-code">{groupName(row.groupId)}</span> · {subjectName(row.lesson.subjectId)}</strong>
            <span>{dateLabel(row.date)} · {clock(row.start)}–{clock(row.end)} · сейчас: {teacherName(row.lesson.teacherId)}</span>
            {changed.has(row.id) && <span className="teacher-replacement-ok">Будет вести: {teacherName(teacherId)}</span>}
            {reason && <span className="teacher-replacement-skip">{reason}</span>}
          </span>
        </label>;
      }) : <p className="teacher-replacement-empty">Выберите уроки для замены.</p>}
    </div>
    {preview.skipped.some(item => !byId.has(item.lessonId)) && <p className="teacher-replacement-skip">Некоторые выбранные уроки не найдены и будут пропущены.</p>}
    {undoViolation && <p className="teacher-replacement-undo" role="status">Отмена этой замены будет запрещена: она вернула бы недоступного учителя. {unavailabilityViolationMessage(undoViolation, catalog)}.</p>}
    {error && <p className="teacher-replacement-error" role="alert">{error}</p>}
    <footer>
      <span>Готово к замене: {preview.changedLessonIds.length}{preview.skipped.length ? `; пропущено: ${new Set(preview.skipped.map(item => item.lessonId)).size}` : ""}</span>
      <button type="button" className="teacher-replacement-primary" onClick={() => void apply()} disabled={!preview.changedLessonIds.length || busy}><ActionLabel action="replace">{busy ? "Сохранение…" : "Применить замену"}</ActionLabel></button>
      <button type="button" onClick={close} disabled={busy}>Отмена</button>
    </footer>
  </dialog>;
}
