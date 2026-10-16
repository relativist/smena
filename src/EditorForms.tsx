import ActionLabel from "./ActionLabel";
import InfoTooltip from "./InfoTooltip";
import RussianTimeInput from "./RussianTimeInput";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  formatTime,
  parseTime,
  roomOccupancies,
  type Schedule,
  type EditorDay,
  type EditorLesson,
} from "./editor";
import type { Catalog } from "../shared/catalog";
import { newRoomConflict, roomConflictMessage } from "../shared/roomConflicts";
import { newTeacherConflict, teacherConflictMessage } from "../shared/teacherConflicts";
import { teacherLabel, roomKinds } from "../shared/catalog";
import { roomSuitabilityReason } from "../shared/roomSuitability";
import { lessonUnavailability, newUnavailabilityViolation, unavailabilityViolationMessage } from "../shared/unavailability";
import { scopeAvailabilityPreview } from "./availabilityPreview";

export type TimeValues = {
  start: number;
  duration: number;
  shiftFollowing: boolean;
};
export type LessonValues = TimeValues & {
  teacher: string;
  teacherId?: string;
  room: string;
  roomId?: string;
  note: string;
};

export function LessonForm({
  day,
  slot,
  lesson,
  catalog,
  schedule,
  groupId,
  onSave,
  onDelete,
  onMove,
  onRepeat,
  onJoint,
  close,
}: {
  day: EditorDay;
  slot: number;
  lesson: EditorLesson;
  catalog: Catalog;
  schedule: Schedule;
  groupId: string;
  onSave: (value: LessonValues) => void;
  onDelete: () => void;
  onMove: () => void;
  onRepeat: () => void;
  onJoint: () => void;
  close: () => void;
}) {
  const fieldId = useId();
  const subject = catalog.subjects.find((item) => item.id === lesson.subjectId);
  const matchedTeacher = lesson.teacherId
    ? catalog.teachers.find((item) => item.id === lesson.teacherId)
    : catalog.teachers.find(
        (item) => teacherLabel(item.name) === lesson.teacher,
      );
  const matchedRoom = lesson.roomId
    ? catalog.rooms.find((item) => item.id === lesson.roomId)
    : catalog.rooms.find((item) => item.name === lesson.room);
  const [teacherId, setTeacherId] = useState(matchedTeacher?.id ?? "");
  const [roomId, setRoomId] = useState(matchedRoom?.id ?? "");
  // Notes do not affect resource availability. Keep typing local to the native
  // field instead of rerunning every teacher/room conflict check per character.
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [start, setStart] = useState(formatTime(day.times[slot].start));
  const [duration, setDuration] = useState(day.times[slot].duration);
  const [shiftFollowing, setShiftFollowing] = useState(false);
  const [error, setError] = useState("");
  const [confirmJointDelete, setConfirmJointDelete] = useState(false);
  const hasUnsavedChanges = () => teacherId !== (matchedTeacher?.id ?? "") || roomId !== (matchedRoom?.id ?? "") || (noteRef.current?.value ?? "") !== (lesson.note ?? "") || start !== formatTime(day.times[slot].start) || duration !== day.times[slot].duration || shiftFollowing;
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (!Number.isFinite(parseTime(start)))
        throw new Error("Укажите начало урока в 24-часовом формате ЧЧ:ММ.");
      const selectedTeacher = catalog.teachers.find(
        (item) => item.id === teacherId,
      );
      const selectedRoom = catalog.rooms.find((item) => item.id === roomId);
      if (
        !lesson.event &&
        (!selectedTeacher ||
          ((selectedTeacher.archived ||
            !selectedTeacher.subjectIds.includes(lesson.subjectId)) &&
            selectedTeacher.id !== matchedTeacher?.id))
      )
        throw new Error("Выберите действующего преподавателя из списка");
      if (
        !selectedRoom ||
        (selectedRoom.archived && selectedRoom.id !== matchedRoom?.id)
      )
        throw new Error("Выберите действующий кабинет");
      if (roomReasons.has(roomId)) throw new Error(roomReasons.get(roomId));
      if (teacherReasons.has(teacherId)) throw new Error(teacherReasons.get(teacherId));
      onSave({
        teacher: selectedTeacher ? teacherLabel(selectedTeacher.name) : "",
        teacherId: teacherId || undefined,
        room: selectedRoom?.name ?? "",
        roomId: roomId || undefined,
        note: (noteRef.current?.value ?? "").trim(),
        start: parseTime(start),
        duration,
        shiftFollowing,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось изменить занятие",
      );
    }
  }
  const selectedTeacher = catalog.teachers.find(
    (item) => item.id === teacherId,
  );
  const selectedRoom = catalog.rooms.find((item) => item.id === roomId);
  const jointGroupIds = lesson.jointId
    ? [...new Set(Object.entries(schedule).flatMap(([scheduleKey, days]) => {
        const groupIdForLesson = scheduleKey.slice(0, scheduleKey.lastIndexOf(":"));
        return days.some((entry) => entry.slots.some((items) => items.some((item) => item.jointId === lesson.jointId)))
          ? [groupIdForLesson]
          : [];
      }))]
    : [];
  const jointGroups = jointGroupIds.map((id) => catalog.groups.find((item) => item.id === id)?.name ?? id);
  const teachers = [...catalog.teachers]
    .filter(
      (item) =>
        item.id === matchedTeacher?.id ||
        (!item.archived && item.subjectIds.includes(lesson.subjectId)),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  const allRooms = [...catalog.rooms]
    .filter((item) => !item.archived || item.id === roomId)
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  const dayOccupancies = useMemo(
    () => roomOccupancies(schedule, day.date),
    [schedule, day.date],
  );
  const roomReasons = new Map<string, string>();
  const roomSuitabilityReasons = new Map<string, string>();
  const suitabilityReason = (nextRoomId: string | undefined) => roomSuitabilityReason(catalog, {
    subjectId: lesson.subjectId, lessonKind: lesson.lessonKind, groupId,
    subgroupId: lesson.subgroupId, subgroup: lesson.subgroup, roomId: nextRoomId,
    ...(jointGroupIds.length ? { groupIds: jointGroupIds } : {}),
  });
  const originalRoomReason = suitabilityReason(matchedRoom?.id);
  for (const room of allRooms) {
    const reason = suitabilityReason(room.id);
    if (reason && room.id !== matchedRoom?.id) {
      roomReasons.set(room.id, reason);
      roomSuitabilityReasons.set(room.id, reason);
    }
  }
  const teacherReasons = new Map<string, string>();
  const originalUnavailability = lessonUnavailability(catalog, {
    date: day.date, start: day.times[slot].start, end: day.times[slot].start + day.times[slot].duration,
    teacherId: matchedTeacher?.id, roomId: matchedRoom?.id,
  });
  try {
    const startMinute = parseTime(start);
    if (Number.isFinite(startMinute) && Number.isFinite(duration) && duration > 0) {
      const originalTime = day.times[slot];
      const changedOccupancies = (nextTeacherId: string, nextRoomId: string) =>
        dayOccupancies.flatMap((entry) => {
          const isEdited = entry.lessonId === lesson.id || Boolean(lesson.jointId && entry.jointId === lesson.jointId);
          if (isEdited) return [{ previous: entry, next: { ...entry, start: startMinute, end: startMinute + duration, teacherId: nextTeacherId, roomId: nextRoomId } }];
          if (entry.groupId !== groupId) return [];
          if (entry.start === originalTime.start && entry.end === originalTime.start + originalTime.duration)
            return [{ previous: entry, next: { ...entry, start: startMinute, end: startMinute + duration } }];
          if (shiftFollowing && entry.start > originalTime.start) {
            const delta = startMinute - originalTime.start;
            return [{ previous: entry, next: { ...entry, start: entry.start + delta, end: entry.end + delta } }];
          }
          return [];
        });
      for (const teacher of teachers) {
        const scoped = scopeAvailabilityPreview(dayOccupancies, changedOccupancies(teacher.id, roomId), "teacher");
        const unavailable = newUnavailabilityViolation(scoped.next.map(entry => ({ ...entry, roomId: undefined })), scoped.previous, catalog);
        const conflict = newTeacherConflict(scoped.next, scoped.previous);
        if (conflict) teacherReasons.set(teacher.id, teacherConflictMessage(conflict, catalog));
        if (unavailable?.kind === "teacher") teacherReasons.set(teacher.id, unavailabilityViolationMessage(unavailable, catalog));
      }
      for (const room of allRooms) {
        const scoped = scopeAvailabilityPreview(dayOccupancies, changedOccupancies(teacherId, room.id), "room");
        const conflict = newRoomConflict(scoped.next, scoped.previous);
        if (conflict && !roomReasons.has(room.id))
          roomReasons.set(room.id, roomConflictMessage(conflict, catalog));
        const unavailable = newUnavailabilityViolation(
          scoped.next.map(entry => ({ ...entry, teacherId: undefined })),
          scoped.previous.map(entry => ({ ...entry, teacherId: undefined })),
          catalog,
        );
        if (unavailable?.kind === "room" && !roomSuitabilityReasons.has(room.id))
          roomReasons.set(room.id, unavailabilityViolationMessage(unavailable, catalog));
      }
    }
  } catch {
    /* Time fields are validated on submit. */
  }
  const rooms = allRooms.filter((room) => room.id === roomId || !roomReasons.has(room.id));
  // Group repeated suitability explanations so the hint fits without a scrolling list.
  const roomHintParts = new Map<string, number>();
  const busyRoomNames: string[] = [];
  const unavailableRoomNames: string[] = [];
  for (const [id, reason] of roomReasons) {
    if (roomSuitabilityReasons.has(id)) {
      const explanation = reason.replace(/^Кабинет «[^»]+» /, "")
        .replace(/^имеет тип /, "тип ").replace(/^рассчитан на /, "вместимость — ");
      roomHintParts.set(explanation, (roomHintParts.get(explanation) ?? 0) + 1);
    } else {
      const names = reason.includes("уже занят группой") ? busyRoomNames : unavailableRoomNames;
      names.push(catalog.rooms.find((room) => room.id === id)?.name ?? id);
    }
  }
  const roomAvailabilityHint = [
    ...[...roomHintParts].map(([reason, count]) => `Кабинеты (${count}): ${reason}.`),
    busyRoomNames.length ? `Заняты другими занятиями в выбранное время: ${busyRoomNames.join(", ")}.` : "",
    unavailableRoomNames.length ? `Недоступны по графику в выбранное время: ${unavailableRoomNames.join(", ")}.` : "",
  ].filter(Boolean).join("\n\n");
  return (
    <form className="editor-form lesson-form" onSubmit={submit}>
      <p className="form-hint">
        {subject?.name ?? lesson.subjectId} · <span className="school-code">{lesson.subgroup ?? "Вся группа"}</span>{" "}
        ·{" "}
        {new Date(`${day.date}T12:00:00`).toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "long",
        })}{" "}
        · урок {slot + 1}
      </p>
      {originalUnavailability.length > 0 && <div className="room-legacy-hint" role="status">
        {originalUnavailability.map((item) => <p key={`${item.kind}:${item.ruleId}`}>
          {item.kind === "teacher" ? "Нужна замена учителя" : "Нужен другой кабинет"}: {item.resourceName}{item.reason ? ` · ${item.reason}` : ""}.
        </p>)}
        <span>Сохранённый урок останется в расписании. Возврат к недоступному ресурсу после замены будет запрещён.</span>
      </div>}
      {lesson.jointId && (
        <p className="form-hint" role="status">
          Общее занятие для групп: {jointGroups.join(", ")}. Сохранение применится ко всем группам.
        </p>
      )}
      {lesson.lessonKind === "lab" && (
        <p className="form-hint">
          Лабораторная работа · тип урока задаётся учебным планом
        </p>
      )}
      <div className="lesson-fields">
        <div className="lesson-field-row">
          <label className="field-label" htmlFor={`${fieldId}-start`}>Начало урока</label>
          <RussianTimeInput id={`${fieldId}-start`} value={start}
            onChange={(value) => { setStart(value); setError(""); }} />
        </div>
        <label className="lesson-field-row">
          <span className="field-label">Длительность, мин</span>
          <input
            type="number"
            min="1"
            max="1440"
            required
            value={Number.isFinite(duration) ? duration : ""}
            onChange={(e) => setDuration(e.target.valueAsNumber)}
          />
        </label>
        <div className="lesson-field-row">
          <span className="field-label">Окончание</span>
          <output className="lesson-end-time">
            {Number.isFinite(duration) && start
              ? formatTime(parseTime(start) + duration)
              : "—"}
          </output>
        </div>
        <label className="lesson-field-row">
          <span className="field-label">Следующие уроки</span>
          <span className="lesson-shift-control">
            <input
              type="checkbox"
              checked={shiftFollowing}
              onChange={(e) => setShiftFollowing(e.target.checked)}
            />
            Сдвинуть вместе с этим
          </span>
        </label>
      </div>
      {day.slots[slot].length > 1 && (
        <p className="form-hint">
          Время изменится у обеих подгрупп в этой ячейке.
        </p>
      )}
      {lesson.jointId && (
        <p className="form-hint">Время общего занятия изменится сразу для всех участвующих групп.</p>
      )}
      <div className="lesson-fields">
        {!lesson.event && (
          <div className="lesson-field-row">
            <span className="lesson-field-caption">
              <label className="field-label" htmlFor={`${fieldId}-teacher`}>Преподаватель</label>
              {teacherReasons.size > 0 && <InfoTooltip label="Почему преподаватели недоступны">
                {[...new Set(teacherReasons.values())].join("\n\n")}
              </InfoTooltip>}
            </span>
            <select
              id={`${fieldId}-teacher`}
              aria-label="Преподаватель"
              value={teacherId}
              required
              onChange={(e) => setTeacherId(e.target.value)}
              aria-describedby={selectedTeacher?.archived ? "teacher-choice-hint" : undefined}
            >
              <option value="" disabled>
                Выберите преподавателя
              </option>
              {teachers.map((item) => (
                <option key={item.id} value={item.id} disabled={teacherReasons.has(item.id)} title={teacherReasons.get(item.id)}>
                  {item.name}
                  {item.archived
                    ? " · архив"
                    : !item.subjectIds.includes(lesson.subjectId)
                      ? " · текущий"
                      : ""}
                  {teacherReasons.has(item.id) ? " · недоступен" : ""}
                </option>
              ))}
            </select>
            {selectedTeacher?.archived && (
              <span id="teacher-choice-hint" className="form-hint">
                Архивный преподаватель: можно сохранить текущий урок
              </span>
            )}
            {teacherReasons.has(teacherId) && (
              <span className="room-conflict-hint" role="status">{teacherReasons.get(teacherId)}</span>
            )}
          </div>
        )}
        <div className="lesson-field-row">
          <span className="lesson-field-caption">
            <label className="field-label" htmlFor={`${fieldId}-room`}>Кабинет</label>
            {roomReasons.size > 0 && <InfoTooltip label="Почему кабинеты недоступны">
              {roomAvailabilityHint}
            </InfoTooltip>}
          </span>
          <select
            id={`${fieldId}-room`}
            aria-label="Кабинет"
            value={roomId}
            required
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="" disabled>
              {lesson.room && !matchedRoom
                ? `Выберите кабинет (сейчас: ${lesson.room})`
                : "Выберите кабинет"}
            </option>
            {rooms.map((item) => (
              <option
                key={item.id}
                value={item.id}
                disabled={roomReasons.has(item.id)}
                title={roomReasons.get(item.id)}
              >
                {item.name} · {roomKinds[item.kind]}{item.capacity !== null ? ` · ${item.capacity} мест` : ""}
                {item.archived ? " · архив" : ""}
                {roomReasons.has(item.id) ? roomSuitabilityReasons.has(item.id) ? " · не подходит" : " · недоступен" : ""}
              </option>
            ))}
          </select>
          {roomReasons.has(roomId) && (
            <span className="room-conflict-hint" role="status">
              {roomReasons.get(roomId)}
            </span>
          )}
          {selectedRoom?.archived && (
            <span className="field-label">
              Архивный кабинет сохранится у этого урока
            </span>
          )}
          {originalRoomReason && roomId === matchedRoom?.id && (
            <span className="room-legacy-hint" role="status">
              {originalRoomReason}. Сохранённое несоответствие: текущий кабинет можно оставить без усиления нарушения.
            </span>
          )}
          {originalRoomReason && roomId !== matchedRoom?.id && !suitabilityReason(roomId) && (
            <span className="room-legacy-hint" role="status">
              Исправляется сохранённое несоответствие кабинета. Отмена этой правки будет запрещена, поскольку вернула бы прежнее нарушение.
            </span>
          )}
        </div>
      </div>
      <label>
        <span className="field-label">Примечание</span>
        <textarea
          rows={2}
          maxLength={500}
          placeholder="Например, лабораторная работа"
          ref={noteRef}
          defaultValue={lesson.note ?? ""}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className={`form-actions${lesson.jointId ? " joint-form-actions" : ""}`}>
        <button type="button" className="danger-button" onClick={() => lesson.jointId ? setConfirmJointDelete(true) : onDelete()}
          title={lesson.jointId ? "Удалить урок только у этой группы" : undefined}>
          <ActionLabel action="delete">{lesson.jointId ? "Удалить у этой группы" : "Удалить урок"}</ActionLabel>
        </button>
        {!lesson.event && !lesson.jointId && (
            <button type="button" className="secondary-button" onClick={onMove}>
              Переместить
            </button>
        )}
        {!lesson.event && <button type="button" className="secondary-button" onClick={() => {
          if (hasUnsavedChanges()) {
            setError("Сначала примените изменения урока, затем повторите его на другие недели.");
            return;
          }
          onRepeat();
        }}>Повторить урок</button>}
        {subject?.jointSameGrade && !lesson.event && !lesson.subgroup && !lesson.subgroupId && <button type="button" className="secondary-button" onClick={() => {
          if (hasUnsavedChanges()) { setError("Сначала примените изменения урока, затем объедините группы."); return; }
          onJoint();
        }}>Объединить группы</button>}
        <button type="button" className="secondary-button" onClick={close}>
          Отмена
        </button>
        <button type="submit" className="primary-button">
          <ActionLabel action={lesson.jointId ? "save" : "apply"}>{lesson.jointId ? "Сохранить для всех" : "Применить"}</ActionLabel>
        </button>
      </div>
      {confirmJointDelete && <div className="joint-delete-confirm" role="alert">
        <p>Урок будет удалён только у этой группы. У остальных участников занятие сохранится. Если останется одна группа, связь объединения снимется.</p>
        <button type="button" className="danger-button" onClick={onDelete}><ActionLabel action="delete">Удалить у этой группы</ActionLabel></button>
        <button type="button" className="secondary-button" onClick={() => setConfirmJointDelete(false)}>Оставить</button>
      </div>}
    </form>
  );
}

export function TimeForm({ day, slot, onSave, close }: {
  day: EditorDay;
  slot: number;
  onSave: (value: TimeValues) => void;
  close: () => void;
}) {
  const [start, setStart] = useState(formatTime(day.times[slot].start));
  const [duration, setDuration] = useState(day.times[slot].duration);
  const [shiftFollowing, setShiftFollowing] = useState(false);
  const [error, setError] = useState("");
  const startMinute = parseTime(start);
  const delta = startMinute - day.times[slot].start;
  const valid = Number.isInteger(startMinute) && Number.isInteger(duration) && duration > 0;
  const preview = valid ? day.times.slice(slot, shiftFollowing ? undefined : slot + 1).map((time, index) => ({
    start: index === 0 ? startMinute : time.start + (shiftFollowing ? delta : 0),
    duration: index === 0 ? duration : time.duration,
  })) : [];
  const jointAffected = preview.some((time, index) => {
    const original = day.times[slot + index];
    return (time.start !== original.start || time.duration !== original.duration) &&
      day.slots[slot + index].some((lesson) => lesson.jointId);
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (!valid) throw new Error("Укажите корректное время и длительность урока");
      onSave({ start: startMinute, duration, shiftFollowing });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить время"); }
  }
  return <form className="editor-form" onSubmit={submit}>
    <div className="form-grid">
      <label>
        <span className="field-label">Начало урока</span>
        <input type="text" inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5}
          pattern="([01][0-9]|2[0-3]):[0-5][0-9]" title="Время в 24-часовом формате, например 14:00"
          required value={start} onChange={(event) => { setStart(event.target.value); setError(""); }} />
      </label>
      <label>
        <span className="field-label">Длительность урока, мин</span>
        <input type="number" required min={1} max={1440} step={1} value={Number.isFinite(duration) ? duration : ""}
          onChange={(event) => { setDuration(event.target.valueAsNumber); setError(""); }} />
      </label>
    </div>
    <label className="inline-choice">
      <input type="checkbox" checked={shiftFollowing} onChange={(event) => setShiftFollowing(event.target.checked)} />
      Сдвинуть все последующие уроки
    </label>
    <div className="time-preview" aria-label="Предварительное время">
      {preview.map((time, index) => <div key={index}>
        <span>Урок {slot + index + 1}</span><b>{formatTime(time.start)}–{formatTime(time.start + time.duration)}</b>
      </div>)}
    </div>
    <p className="form-hint">Длительность меняется только у выбранного урока. При сдвиге начала остальные уроки сохраняют свою длительность. Все занятия в ячейке используют одно время.</p>
    {jointAffected && <p className="form-hint">Изменение затронет общее занятие. Используйте его редактор, чтобы сохранить одинаковое время во всех группах.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">
      <button type="button" className="secondary-button" onClick={close}>Отмена</button>
      <button type="submit" className="primary-button"><ActionLabel action="apply">Применить</ActionLabel></button>
    </div>
  </form>;
}

export function BreakForm({
  day,
  slot,
  defaultGap,
  onSave,
  close,
}: {
  day: EditorDay;
  slot: number;
  defaultGap: number;
  onSave: (minutes: number) => void;
  close: () => void;
}) {
  const [minutes, setMinutes] = useState(day.breaks[slot]);
  const [error, setError] = useState("");
  const jointAffected = day.slots.slice(slot + 1).some((items) => items.some((lesson) => lesson.jointId));
  const difference = minutes - day.breaks[slot];
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onSave(minutes);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось изменить перемену",
      );
    }
  }
  return (
    <form className="editor-form" onSubmit={submit}>
      <p className="form-hint">
        Между {slot + 1}-м и {slot + 2}-м уроками. Только для этой группы на
        выбранную дату.
      </p>
      {jointAffected && (
        <p className="form-hint">Изменение затронет общее занятие. Сначала измените его время в редакторе общего занятия.</p>
      )}
      <label>
        <span className="field-label">Перемена, мин</span>
        <input
          type="number"
          required
          min="0"
          max="240"
          value={Number.isFinite(minutes) ? minutes : ""}
          onChange={(e) => setMinutes(e.target.valueAsNumber)}
        />
      </label>
      <button
        type="button"
        className="text-button"
        onClick={() => setMinutes(defaultGap)}
      >
        Вернуть по настройкам · {defaultGap} мин
      </button>
      <p className="form-hint">
        {Number.isFinite(difference) && difference !== 0
          ? `Уроки с ${slot + 2}-го сдвинутся на ${Math.abs(difference)} мин ${difference > 0 ? "позже" : "раньше"}.`
          : "Начало следующих уроков не изменится."}{" "}
        Другие дни и глобальные перемены сохранятся.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={close}>
          Отмена
        </button>
        <button type="submit" className="primary-button">
          <ActionLabel action="apply">Применить</ActionLabel>
        </button>
      </div>
    </form>
  );
}
