import { useId, useMemo, useState, type FormEvent } from "react";
import type { Catalog } from "../shared/catalog";
import type { BellProfile } from "../shared/bellSchedule";
import { previewDayTiming, type DayTimingOptions } from "../shared/dayTiming";
import { formatTime, parseTime, uniformDayBreak, type EditorDay, type Location, type Schedule } from "./editor";

type Scope = "current" | "selected" | "all";

export default function DayTimeForm({ day, location, schedule, catalog, schoolProfile, onSave, close }: {
  day: EditorDay;
  location: Location;
  schedule: Schedule;
  catalog: Catalog;
  schoolProfile: BellProfile;
  onSave: (options: DayTimingOptions) => void;
  close: () => void;
}) {
  const [start, setStart] = useState(formatTime(day.times[0].start));
  const [duration, setDuration] = useState(day.times[0].duration);
  const uniformBreak = uniformDayBreak(day, schoolProfile);
  const [customBreaks, setCustomBreaks] = useState(uniformBreak !== undefined);
  const [breakMinutes, setBreakMinutes] = useState(uniformBreak ?? 5);
  const [scope, setScope] = useState<Scope>("current");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([location.groupId]);
  const [error, setError] = useState("");
  const breakInputId = useId();
  const groups = useMemo(() => catalog.groups.filter((group) => !group.archived).slice()
    .sort((left, right) => left.name.localeCompare(right.name, "ru", { numeric: true })), [catalog.groups]);
  const currentGroup = catalog.groups.find((group) => group.id === location.groupId);
  const groupIds = useMemo(() => scope === "all" ? groups.map((group) => group.id)
    : scope === "selected" ? selectedGroups : [location.groupId], [scope, selectedGroups, groups, location.groupId]);
  const currentSelected = groupIds.includes(location.groupId);
  const options = useMemo<DayTimingOptions>(() => ({
    date: day.date, groupIds, currentGroupId: location.groupId,
    start: parseTime(start), duration, schoolProfile,
    ...(customBreaks ? { uniformBreak: breakMinutes } : {}),
  }), [day.date, groupIds, location.groupId, start, duration, schoolProfile, customBreaks, breakMinutes]);
  const preview = useMemo(() => {
    try { return { result: previewDayTiming(schedule, options, catalog), error: "" }; }
    catch (reason) { return { result: null, error: reason instanceof Error ? reason.message : "Не удалось рассчитать время" }; }
  }, [schedule, options, catalog]);
  const groupDays = useMemo(() => new Map(Object.entries(schedule).flatMap(([scheduleKey, days]) => {
    const groupId = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
    return days.filter((entry) => entry.date === day.date).map((entry) => [groupId, entry] as const);
  })), [schedule, day.date]);
  const skipped = new Map(preview.result?.skippedGroups.map((entry) => [entry.groupId, entry.reason]));
  const changed = new Map(preview.result?.changedDays.map((entry) => [entry.groupId, entry]));
  const problem = error || preview.error || preview.result?.conflict;
  const dateLabel = new Date(`${day.date}T12:00:00`).toLocaleDateString("ru-RU");
  const groupName = (id: string) => catalog.groups.find((group) => group.id === id)?.name ?? id;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem || !preview.result?.changedDays.length) return;
    try { onSave(options); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить время"); }
  }

  return <form className="editor-form" onSubmit={submit}>
    <label className="day-time-row">
      <span className="field-label">Начало учебного дня</span>
      <input type="text" inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5}
        pattern="([01][0-9]|2[0-3]):[0-5][0-9]" title="Время в 24-часовом формате, например 14:00"
        required={currentSelected} disabled={!currentSelected} value={start}
        onChange={(event) => { setStart(event.target.value); setError(""); }} />
    </label>
    <div className="day-time-fields">
      <label className="day-time-row">
        <span className="field-label">Длительность урока, мин</span>
        <input type="number" required min={1} max={180} step={1}
          value={Number.isFinite(duration) ? duration : ""}
          onChange={(event) => { setDuration(event.target.valueAsNumber); setError(""); }} />
      </label>
      <div className="day-time-row">
        <label htmlFor={breakInputId} className="field-label">Длительность всех перемен, мин</label>
        <input id={breakInputId} type="number" required={customBreaks} disabled={!customBreaks}
          min={0} max={240} step={1} value={Number.isFinite(breakMinutes) ? breakMinutes : ""}
          onChange={(event) => { setBreakMinutes(event.target.valueAsNumber); setError(""); }} />
        <input className="day-break-checkbox" type="checkbox" checked={customBreaks}
          aria-label="Длительность всех перемен, мин" title="Задать одинаковую длительность всех перемен"
          onChange={(event) => { setCustomBreaks(event.target.checked); setError(""); }} />
      </div>
    </div>
    <label className="day-apply-scope">
      <span className="field-label">Применить на эту дату · {dateLabel}</span>
      <select className="school-code" value={scope} onChange={(event) => { setScope(event.target.value as Scope); setError(""); }}>
        <option value="current">Только к текущей группе ({currentGroup?.name})</option>
        <option value="selected">К выбранным группам</option>
        <option value="all">Ко всем группам</option>
      </select>
    </label>
    {scope === "selected" && <fieldset className="day-group-picker">
      <legend>Группы</legend>
      <div className="day-group-list">{groups.map((group) => <label key={group.id}>
        <input type="checkbox" checked={selectedGroups.includes(group.id)}
          onChange={(event) => {
            setSelectedGroups((current) => event.target.checked ? [...current, group.id] : current.filter((id) => id !== group.id));
            setError("");
          }} />
        <span className="school-code">{group.name}</span>
      </label>)}</div>
    </fieldset>}
    <p className="form-hint">
      {scope === "current" ? "Изменится только этот день текущей группы." : currentSelected
        ? <>Начало выше применяется только к группе «<span className="school-code">{currentGroup?.name}</span>». Остальные группы сохраняют своё начало дня.</>
        : "Выбранные группы сохраняют своё начало дня."}{" "}
      {customBreaks ? "Все перемены будут одинаковыми." : "Перемены — по школьным настройкам."}
    </p>
    {problem && <p className="form-error" role="alert">{problem}</p>}
    {preview.result?.undoConflict && <p className="day-undo-warning" role="status">
      Отмена этого изменения недоступна: она восстановит старый конфликт. {preview.result.undoConflict}
    </p>}
    {preview.result && <section className="day-timing-preview" aria-label="Предварительное расписание">
      <h3>Предварительное расписание</h3>
      {groupIds.filter((id) => !skipped.has(id)).map((id) => {
        const original = groupDays.get(id);
        if (!original?.times.length) return null;
        const change = changed.get(id);
        const before = change?.before ?? original.times;
        const after = change?.after ?? original.times;
        const last = after.at(-1)!;
        return <details className="day-group-preview" key={id} open={id === location.groupId || groupIds.length === 1}>
          <summary>
            <strong className="school-code">{groupName(id)}</strong>
            <span>{formatTime(after[0].start)}–{formatTime(last.start + last.duration)}</span>
            <small>{change ? `${after.length} уроков · ${duration} мин` : "Без изменений"}</small>
          </summary>
          <table aria-label={`Время уроков группы ${groupName(id)}`}>
            <thead><tr><th>Урок</th><th>Было</th><th>Станет</th></tr></thead>
            <tbody>{after.map((time, index) => <tr key={index}>
              <td>{index + 1}</td>
              <td>{formatTime(before[index].start)}–{formatTime(before[index].start + before[index].duration)}</td>
              <td>{formatTime(time.start)}–{formatTime(time.start + time.duration)}</td>
            </tr>)}</tbody>
          </table>
        </details>;
      })}
      {preview.result.skippedGroups.map((entry) => <p className="day-group-skipped" key={entry.groupId}>
        <strong className="school-code">{groupName(entry.groupId)}</strong> · {entry.reason}
      </p>)}
    </section>}
    <div className="form-actions">
      <button type="button" className="secondary-button" onClick={close}>Отмена</button>
      <button type="submit" className="primary-button" disabled={Boolean(problem) || !preview.result?.changedDays.length}>Применить</button>
    </div>
  </form>;
}
