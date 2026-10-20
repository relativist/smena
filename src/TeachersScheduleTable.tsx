import { useLayoutEffect, useRef, useState } from "react";
import type { PublicTeacherDay, PublicTeacherGroup, PublicTeacherLesson } from "../shared/teacherTypes.ts";
import { subjectColors } from "../shared/subjectColors.ts";

export type TeacherScheduleColumn = { id: string; name: string; title?: string; day?: PublicTeacherDay; isToday?: boolean };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const shiftFor = (group: PublicTeacherGroup, lesson: PublicTeacherLesson) => (group.dayStart ?? lesson.start) < 720 ? "morning" : "afternoon";

function CompactTeacherLesson({ lesson }: { lesson: PublicTeacherLesson }) {
  const color = subjectColors.find(item => item.id === lesson.subject?.color)?.dot;
  const title = lesson.event || lesson.subject?.shortName?.trim() || lesson.subject?.name || "Занятие";
  const numbers = [...new Map(lesson.groups.map(group => {
    const shift = shiftFor(group, lesson);
    return [`${group.slot}:${shift}`, { slot: group.slot, shift }] as const;
  })).values()].sort((a, b) => a.slot - b.slot || a.shift.localeCompare(b.shift));
  const room = lesson.room?.name.replace(/^\s*кабинет\s*/iu, "").trim();
  return <article className="teachers-table-lesson" style={color ? { borderLeftColor: color } : undefined} title={`${clock(lesson.start)}–${clock(lesson.start + lesson.duration)}`}>
    <div className="teachers-table-subject">
      <span className="teachers-table-numbers">{numbers.map((number, index) => <span key={`${number.slot}:${number.shift}`} className={`teachers-shift-${number.shift}`} title={number.shift === "morning" ? "Первая смена" : "Вторая смена"}>{index ? "/" : "№"}{number.slot}</span>)}</span>
      <strong title={lesson.event || lesson.subject?.name}>{title}</strong>
      {lesson.lessonKind === "lab" && <span className="teachers-table-tag">лаб.</span>}
    </div>
    <div className="teachers-table-resources">
      <span className="teachers-table-groups" aria-label="Классы и подгруппы">{lesson.groups.map((group, index) => {
        const number = group.subgroup?.number ?? Number(group.subgroup?.name.match(/\d+/u)?.[0]);
        const name = group.subgroup ? `${group.name}/${number > 0 ? number : group.subgroup.name}` : group.name;
        return <span key={`${group.id}:${group.subgroup?.id ?? group.subgroup?.name ?? ""}:${index}`} title={group.subgroup?.name}><span className="school-code">{name}</span>{numbers.length > 1 && <span className={`teachers-shift-${shiftFor(group, lesson)}`}> · №{group.slot}</span>}</span>;
      })}</span>
      {room && <span className="teachers-table-room" title={`Кабинет: ${lesson.room!.name}`}>{room}</span>}
    </div>
  </article>;
}

function TableBand({ columns, capacity, ariaLabel }: { columns: TeacherScheduleColumn[]; capacity: number; ariaLabel: string }) {
  const rows = [...new Set(columns.flatMap(column => column.day?.holiday ? [] : (column.day?.lessons ?? []).map(lesson => lesson.start)))].sort((a, b) => a - b);
  const cells = columns.map(column => {
    const byStart = new Map<number, PublicTeacherLesson[]>();
    for (const lesson of column.day?.lessons ?? []) byStart.set(lesson.start, [...(byStart.get(lesson.start) ?? []), lesson]);
    return byStart;
  });
  const displayRows: Array<number | undefined> = rows.length ? rows : [undefined];
  const width = `calc(var(--teachers-time-width) + 2px + (100% - var(--teachers-time-width) - 2px) / ${capacity} * ${columns.length})`;
  return <div className="teachers-table-wrap" style={{ width }}><table className="teachers-schedule-table" aria-label={`${ariaLabel}: ${columns.map(column => column.title || column.name).join(", ")}`}>
    <colgroup><col className="teachers-table-time-col" />{columns.map(column => <col key={column.id} />)}</colgroup>
    <thead><tr><th scope="col" className="teachers-table-corner">Время</th>{columns.map(column => <th scope="col" className={column.isToday ? "is-today" : undefined} title={column.title} aria-current={column.isToday ? "date" : undefined} key={column.id}>{column.name}</th>)}</tr></thead>
    <tbody>{displayRows.map((start, index) => <tr key={start ?? "empty"}>
      <th scope="row" className="teachers-table-time">{start === undefined ? "—" : <time dateTime={clock(start)}>{clock(start)}</time>}</th>
      {columns.map((column, columnIndex) => {
        const day = column.day;
        if (day?.holiday || !day?.lessons.length) return index === 0 ? <td className="teachers-table-empty-day" rowSpan={displayRows.length} key={column.id}>{day?.holiday ? day.calendarLabel || (day.holidayKind === "vacation" ? "Каникулы" : "Занятий нет") : "Занятий нет"}</td> : null;
        const lessons = start === undefined ? [] : cells[columnIndex].get(start) ?? [];
        const gap = day.gaps?.find(item => item.end === start);
        return <td key={column.id}>{lessons.length ? <div className="teachers-table-lessons">
          {gap && <div className="teachers-table-gap" title={`${clock(gap.start)}–${clock(gap.end)}. Перерыв дольше обычной перемены (${gap.normalBreakMinutes} мин).`}>Перерыв {gap.minutes} мин</div>}
          {lessons.map(lesson => <CompactTeacherLesson key={lesson.id} lesson={lesson} />)}
        </div> : <span className="teachers-table-empty" aria-label="Нет урока">—</span>}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

export default function TeachersScheduleTable({ columns, ariaLabel = "Расписание преподавателей", centered = false }: { columns: TeacherScheduleColumn[]; ariaLabel?: string; centered?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(1);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth) return;
      const styles = getComputedStyle(element);
      const timeWidth = parseFloat(styles.getPropertyValue("--teachers-time-width"));
      const columnWidth = parseFloat(styles.getPropertyValue("--teachers-column-width"));
      setCapacity(Math.max(1, Math.floor((element.clientWidth - timeWidth - 2) / columnWidth)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const bands = Array.from({ length: Math.ceil(columns.length / capacity) }, (_, index) => columns.slice(index * capacity, (index + 1) * capacity));
  return <div className={`teachers-schedule-tables${centered ? " is-centered" : ""}`} ref={container}>{bands.map(band => <TableBand key={band[0].id} columns={band} capacity={capacity} ariaLabel={ariaLabel} />)}</div>;
}
