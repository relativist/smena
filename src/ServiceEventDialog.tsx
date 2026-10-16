import ActionLabel from "./ActionLabel";
import { ApiError, api } from "./api";
import type { ServiceEventInput } from "../shared/serviceEvents.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog } from "../shared/catalog.ts";
import { roomKinds } from "../shared/catalog.ts";
import { roomSuitabilityReason } from "../shared/roomSuitability.ts";
import { findRoomConflict, roomConflictMessage, type RoomOccupancy } from "../shared/roomConflicts.ts";
import { findUnavailability } from "../shared/unavailability.ts";
import type { Location, Schedule } from "./editor.ts";
import { key, roomOccupancies } from "./editor.ts";
import GroupSelection from "./GroupSelection.tsx";
import InfoTooltip from "./InfoTooltip.tsx";
import SearchSelect from "./SearchSelect.tsx";
import "./service-event.css";

type Props = {
  catalog: Catalog;
  schedule: Schedule;
  revision: number;
  csrfToken: string;
  onUnauthorized: () => void;
  currentGroupId: string;
  location?: Location;
  lessonId?: string;
  onClose: () => void;
  onApply: (options: ServiceEventInput | { remove: true; lessonId: string }) => void | Promise<void>;
};

type AffectedLesson = {
  lessonId: string;
  groupId: string;
  groupName: string;
  subjectName: string;
  subgroup?: string;
  date: string;
  before: { start: number; duration: number };
  after?: { start: number; duration: number };
};

type PreparedPreview = { options: ServiceEventInput; affectedLessons: AffectedLesson[] };

const collator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});

export default function ServiceEventDialog({
  catalog,
  schedule,
  revision,
  csrfToken,
  onUnauthorized,
  currentGroupId,
  location,
  lessonId,
  onClose,
  onApply,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const groups = useMemo(
    () =>
      catalog.groups
        .filter((item) => !item.archived)
        .slice()
        .sort((a, b) => collator.compare(a.name, b.name)),
    [catalog.groups],
  );
  const found = lessonId
    ? Object.entries(schedule)
        .flatMap(([scheduleKey, days]) =>
          days.flatMap((day) =>
            day.slots.flatMap((slot, slotIndex) =>
              slot
                .filter((lesson) => lesson.id === lessonId)
                .map((lesson) => ({ scheduleKey, day, slotIndex, lesson })),
            ),
          ),
        )[0]
    : undefined;
  const groupId =
    found?.scheduleKey.slice(0, found.scheduleKey.lastIndexOf(":")) ??
    location?.groupId ??
    currentGroupId;
  const originalGroups = found?.lesson.jointId ? Object.entries(schedule).flatMap(([scheduleKey, days]) =>
    days.some((day) => day.slots.flat().some((lesson) => lesson.jointId === found.lesson.jointId))
      ? [scheduleKey.slice(0, scheduleKey.lastIndexOf(":"))] : [],
  ) : found ? [groupId] : [];
  const [name, setName] = useState(found?.lesson.event ?? "");
  const nameRef = useRef<HTMLInputElement>(null);
  const durationRef = useRef<HTMLInputElement>(null);
  const date = found?.day.date ?? location?.date ?? "";
  const initialTime = found
    ? found.day.times[found.slotIndex]
    : location
      ? schedule[key(location.groupId, location.weekOffset)]
          ?.find((day) => day.date === location.date)
          ?.times[location.slot]
      : undefined;
  const [duration, setDuration] = useState(
    String(initialTime?.duration ?? 45),
  );
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() => {
    if (!found?.lesson.jointId) return [groupId];
    return Object.entries(schedule)
      .flatMap(([scheduleKey, days]) =>
        days.some((day) =>
          day.slots.flat().some((lesson) => lesson.jointId === found.lesson.jointId),
        )
          ? [scheduleKey.slice(0, scheduleKey.lastIndexOf(":"))]
          : [],
      )
      .filter((id, index, ids) => ids.indexOf(id) === index);
  });
  const selectedGroupNames = useMemo(
    () => selectedGroups
      .map((id) => groups.find((group) => group.id === id)?.name)
      .filter((groupName): groupName is string => Boolean(groupName))
      .sort(collator.compare),
    [groups, selectedGroups],
  );
  const [teacherId, setTeacherId] = useState(found?.lesson.teacherId ?? "");
  const [roomId, setRoomId] = useState(found?.lesson.roomId ?? "");
  const [replaceLessons, setReplaceLessons] = useState(false);
  const [preserveLessonRemainder, setPreserveLessonRemainder] = useState(Boolean(found?.lesson.eventRemainder));
  const [preparedPreview, setPreparedPreview] = useState<PreparedPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const confirmRemovalRef = useRef<HTMLDivElement>(null);
  const roomReason = (candidate: string) => selectedGroups.length ? roomSuitabilityReason(catalog, {
    subjectId: "event", groupId, groupIds: selectedGroups, roomId: candidate,
  }) : null;
  const oldEventIds = new Set(found?.lesson.jointId
    ? Object.values(schedule).flatMap((days) => days.flatMap((day) => day.slots.flat()
      .filter((lesson) => lesson.jointId === found.lesson.jointId).map((lesson) => lesson.id)))
    : found ? [found.lesson.id] : []);
  const existingOccupancies = roomOccupancies(schedule).filter((entry) => entry.date === date);
  const eventStart = initialTime?.start;
  const eventEnd = eventStart !== undefined && Number(duration) > 0 ? eventStart + Number(duration) : undefined;
  const releasedGroups = replaceLessons || preserveLessonRemainder ? new Set(selectedGroups) : new Set<string>();
  const retainedOccupancies = existingOccupancies.filter((entry) => {
    if (oldEventIds.has(entry.lessonId)) return false;
    const isAcademicLesson = !entry.event && entry.subjectId !== "event";
    return !(isAcademicLesson && releasedGroups.has(entry.groupId) && eventEnd !== undefined
      && entry.start < eventEnd && eventStart! < entry.end);
  });
  const roomCapacityReasons = new Map(catalog.rooms.map((room) => [room.id, roomReason(room.id)]));
  const roomAvailabilityReasons = new Map(catalog.rooms.map((room) => {
    let reason: string | null = null;
    if (date && eventStart !== undefined && eventEnd !== undefined) {
      const candidate: RoomOccupancy = {
        lessonId: "__service-event-preview__", groupId, date, roomId: room.id,
        start: eventStart, end: eventEnd, event: name || "Мероприятие", subjectId: "event",
      };
      const conflict = findRoomConflict(retainedOccupancies, candidate);
      if (conflict) reason = roomConflictMessage(conflict, catalog);
    }
    if (!reason && date && eventStart !== undefined && eventEnd !== undefined) {
      const unavailable = findUnavailability(catalog, "room", room.id, date, eventStart, eventEnd)[0];
      if (unavailable) reason = `Недоступен по графику${unavailable.reason ? `: ${unavailable.reason}` : ""}`;
    }
    return [room.id, reason] as const;
  }));
  const candidateRoomReasons = new Map(catalog.rooms.map((room) => [
    room.id,
    roomAvailabilityReasons.get(room.id) ?? roomCapacityReasons.get(room.id),
  ]));
  const keepingOriginalGroups = selectedGroups.every((id) => originalGroups.includes(id));
  const originalRoomReason = roomId === found?.lesson.roomId && keepingOriginalGroups
    && !roomAvailabilityReasons.get(roomId)
    ? roomCapacityReasons.get(roomId) ?? null
    : null;
  const roomReasons = new Map([...candidateRoomReasons].map(([id, reason]) => [
    id,
    id === found?.lesson.roomId && keepingOriginalGroups && !roomAvailabilityReasons.get(id)
      ? null
      : reason,
  ]));
  const capacityReasonGroups = new Map<string, number>();
  const unavailableReasonGroups = new Map<string, number>();
  const busyRoomNames: string[] = [];
  for (const room of catalog.rooms) {
    const reason = roomReasons.get(room.id);
    if (reason) {
      const availabilityReason = roomAvailabilityReasons.get(room.id);
      if (availabilityReason?.includes("уже занят")) {
        busyRoomNames.push(room.name);
      } else if (availabilityReason) {
        const key = availabilityReason.replace(/Кабинет «[^»]+»/u, "Кабинет");
        unavailableReasonGroups.set(key, (unavailableReasonGroups.get(key) ?? 0) + 1);
      } else {
        const key = reason.replace(/Кабинет «[^»]+»/u, "Кабинет");
        capacityReasonGroups.set(key, (capacityReasonGroups.get(key) ?? 0) + 1);
      }
    }
  }
  const roomReasonSummary = [
    ...[...capacityReasonGroups].map(([reason, count]) => `Кабинетов ${count}: ${reason}`),
    busyRoomNames.length ? `Заняты другими занятиями: ${busyRoomNames.slice(0, 7).join(", ")}${busyRoomNames.length > 7 ? ` и ещё ${busyRoomNames.length - 7}` : ""}` : "",
    ...[...unavailableReasonGroups].map(([reason, count]) => `Кабинетов ${count}: ${reason}`),
  ].filter(Boolean).join("\n") || "Все активные кабинеты подходят выбранным группам.";
  const restoredRoomReason = found?.lesson.roomId ? roomSuitabilityReason(catalog, {
    subjectId: "event", groupId, groupIds: originalGroups, roomId: found.lesson.roomId,
  }) : null;

  function invalidatePreview() {
    setPreparedPreview(null);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const frame = requestAnimationFrame(() =>
      (lessonId ? durationRef : nameRef).current?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [lessonId]);

  useEffect(() => {
    if (confirmRemoval) confirmRemovalRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirmRemoval]);

  async function save() {
    setError("");
    try {
      if (roomReasons.get(roomId)) throw new Error(roomReasons.get(roomId)!);
      const options: ServiceEventInput = {
        event: name,
        groupIds: selectedGroups,
        date,
        start: initialTime?.start ?? Number.NaN,
        duration: Number(duration),
        teacherId: teacherId || undefined,
        roomId: roomId || undefined,
        location,
        lessonId,
        replaceLessons,
        preserveLessonRemainder,
      };
      setBusy(true);
      if (preparedPreview && JSON.stringify(preparedPreview.options) === JSON.stringify(options)) {
        await onApply(preparedPreview.options);
        onClose();
        return;
      }
      const preview = await api<{ affectedLessons?: AffectedLesson[] }>("/api/schedule-operations/preview", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: JSON.stringify({ revision, operation: "event", options }),
      });
      if (preview.affectedLessons?.length) {
        setPreparedPreview({ options, affectedLessons: preview.affectedLessons });
        return;
      }
      await onApply(options);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onUnauthorized();
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить мероприятие",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!lessonId) return;
    try {
      setBusy(true);
      const options = { remove: true as const, lessonId };
      await api("/api/schedule-operations/preview", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: JSON.stringify({ revision, operation: "event", options }),
      });
      await onApply(options);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onUnauthorized();
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось удалить мероприятие",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="service-event-dialog"
      aria-labelledby="service-event-title"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void save();
        }}
      >
        <header>
          <div>
            <h2 id="service-event-title">
              {lessonId ? "Мероприятие" : "Новое мероприятие"}
            </h2>
            <p>Событие появится в расписании выбранных групп.</p>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <fieldset className="service-event-fields" disabled={busy}>
          <label>
            Название мероприятия
            <input ref={nameRef} type="text" required maxLength={200} value={name}
              placeholder="Например, поход в музей, линейка"
              onChange={(changeEvent) => { setName(changeEvent.target.value); invalidatePreview(); }} />
          </label>
          <label className="service-event-duration">
            Длительность, мин
            <input ref={durationRef} type="number" required min="1" max="180" step="1" value={duration}
              onChange={(changeEvent) => { setDuration(changeEvent.target.value); invalidatePreview(); }} />
          </label>
          <section className="service-event-group-selection">
            <div className="service-event-group-actions">
              <button type="button" onClick={() => { setSelectedGroups([groupId]); invalidatePreview(); }}>Текущая группа</button>
            </div>
            <p className="service-event-selected-groups" aria-live="polite">
              <strong>Выбранные группы:</strong> <span className="school-code">{selectedGroupNames.length ? selectedGroupNames.join(", ") : "не выбраны"}</span>
            </p>
            <GroupSelection
              groups={groups}
              value={selectedGroups}
              onChange={(ids) => { setSelectedGroups(ids); invalidatePreview(); }}
              disabled={busy}
              label="Группы"
            />
          </section>
          <section className="service-event-placement-options" aria-label="Параметры размещения">
            <div className="service-event-option">
              <input id="service-event-replace-lessons" type="checkbox" checked={replaceLessons} onChange={(changeEvent) => {
                setReplaceLessons(changeEvent.target.checked);
                if (changeEvent.target.checked) setPreserveLessonRemainder(false);
                invalidatePreview();
              }} />
              <label htmlFor="service-event-replace-lessons">С заменой уроков</label>
              <InfoTooltip label="С заменой уроков">Если мероприятие пересекается с уроком, урок будет удалён и заменён мероприятием.</InfoTooltip>
            </div>
            <div className="service-event-option">
              <input id="service-event-preserve-remainder" type="checkbox" checked={preserveLessonRemainder} onChange={(changeEvent) => {
                setPreserveLessonRemainder(changeEvent.target.checked);
                if (changeEvent.target.checked) setReplaceLessons(false);
                invalidatePreview();
              }} />
              <label htmlFor="service-event-preserve-remainder">С сохранением остатка урока</label>
              <InfoTooltip label="С сохранением остатка урока">Короткое мероприятие занимает начало урока, затем урок продолжается без перемены. После удаления мероприятия исходное время восстанавливается. Если мероприятие занимает урок целиком или длится дольше, пересекающиеся уроки заменяются полностью и при удалении мероприятия не восстанавливаются.</InfoTooltip>
            </div>
          </section>
          <div className="service-event-row">
            <SearchSelect
              label="Ответственный"
              floating
              value={teacherId}
              placeholder="Найти преподавателя"
              options={[
                { id: "", label: "Не выбран" },
                ...catalog.teachers
                  .filter((item) => !item.archived)
                  .slice()
                  .sort((a, b) => collator.compare(a.name, b.name))
                  .map((item) => ({ id: item.id, label: item.name })),
              ]}
              onChange={(id) => { setTeacherId(id); invalidatePreview(); }}
            />
            <div className="service-event-room-field">
              <span className="service-event-field-label">Кабинет <InfoTooltip label="Почему кабинеты недоступны">{roomReasonSummary}</InfoTooltip></span>
              <select
                aria-label="Кабинет"
                value={roomId}
                onChange={(changeEvent) => { setRoomId(changeEvent.target.value); invalidatePreview(); }}
              >
                <option value="">Не выбран</option>
                {roomReasons.get(roomId) && <option value={roomId} disabled>Выберите другой кабинет</option>}
                {catalog.rooms
                  .filter((item) => !item.archived)
                  .slice()
                  .sort((a, b) => collator.compare(a.name, b.name))
                  .filter((item) => !roomReasons.get(item.id))
                  .map((item) => <option key={item.id} value={item.id}>
                    {item.name} · {roomKinds[item.kind]}{item.capacity !== null ? ` · ${item.capacity} мест` : ""}
                  </option>)}
              </select>
              {roomReasons.get(roomId) && <span className="room-conflict-hint" role="status">{roomReasons.get(roomId)}</span>}
              {originalRoomReason && <span className="room-legacy-hint" role="status">
                {originalRoomReason}. Это сохранённое назначение можно оставить без изменений.
              </span>}
              {restoredRoomReason && !roomReason(roomId) && <span className="room-legacy-hint" role="status">
                Исправляется сохранённое превышение вместимости. Отмена будет запрещена, поскольку вернула бы прежнее нарушение.
              </span>}
            </div>
          </div>
        </fieldset>
        {preparedPreview && <section className="service-event-preview" aria-live="polite">
          <strong>Проверьте изменения уроков</strong>
          <ul>{preparedPreview.affectedLessons.map((item) => <li key={`${item.groupId}-${item.lessonId}`}>
            <span><b className="school-code">{item.groupName}</b>: {item.subjectName}{item.subgroup ? <> · <span className="school-code">{item.subgroup}</span></> : ""}</span>
            <small>{item.after
              ? `${item.after.duration > item.before.duration ? "Восстановление урока" : "Продолжение без перемены"} · ${item.after.duration} мин`
              : "Урок будет заменён мероприятием"}</small>
          </li>)}</ul>
        </section>}
        {error && (
          <p className="service-event-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          {lessonId && (
            <button
              className="service-event-delete"
              type="button"
              disabled={busy}
              onClick={() => setConfirmRemoval(true)}
            >
              <ActionLabel action="delete">Удалить связанные</ActionLabel>
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !date || !initialTime || !selectedGroups.length || Boolean(roomReasons.get(roomId))}
          >
            <ActionLabel action="save">{busy ? "Проверяем…" : preparedPreview ? "Подтвердить и сохранить" : "Сохранить"}</ActionLabel>
          </button>
        </footer>
        {confirmRemoval && (
          <div
            ref={confirmRemovalRef}
            className="service-event-confirm"
            role="alertdialog"
            aria-label="Подтверждение удаления"
          >
            <span>Удалить мероприятие здесь во всех связанных группах?</span>
            {found?.lesson.eventRemainder && <span>Исходное время сокращённых уроков будет восстановлено.</span>}
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRemoval(false)}
            >
              Оставить
            </button>
            <button
              className="service-event-delete"
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              <ActionLabel action="delete">Удалить</ActionLabel>
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}
