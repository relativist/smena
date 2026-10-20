import { useLayoutEffect, useRef, useState } from "react";
import { teacherInitials } from "../shared/catalog.ts";
import type { PublicStudentLesson, PublicStudentsDaySchedule } from "../shared/studentTypes.ts";
import { subjectColors } from "../shared/subjectColors.ts";
import SubjectIcon from "./SubjectIcon";

type DayGroup = PublicStudentsDaySchedule["groups"][number] & { isToday?: boolean };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const rowKey = (lesson: PublicStudentLesson) => `${lesson.slot}:${lesson.start}`;

function CompactLesson({ lesson, showIcons }: { lesson: PublicStudentLesson; showIcons: boolean }) {
  const title = lesson.event || lesson.subject?.shortName?.trim() || lesson.subject?.name || "Занятие";
  const color = subjectColors.find(item => item.id === lesson.subject?.color)?.dot;
  const room = lesson.room?.name.replace(/^\s*кабинет\s*/i, "");
  const subgroup = lesson.subgroup;
  const subgroupNumber = subgroup?.number ?? Number(subgroup?.name.match(/\d+/u)?.[0]);
  return <article className="students-table-lesson" style={color ? { borderLeftColor: color } : undefined}>
    <div className="students-table-subject">
      {showIcons && !lesson.event && lesson.subject && <SubjectIcon subject={lesson.subject} />}
      <strong title={lesson.event || lesson.subject?.name}>{title}</strong>
      {lesson.lessonKind === "lab" && <span className="students-table-tag">лаб.</span>}
      {subgroup && <span className="students-table-tag" title={subgroup.name}>{subgroupNumber > 0 ? `п/г ${subgroupNumber}` : subgroup.name}</span>}
    </div>
    {(lesson.teacher || room) && <div className="students-table-resources">
      {lesson.teacher && <span title={lesson.teacher.name}>{teacherInitials(lesson.teacher.name)}</span>}
      {room && <span className="students-table-room" title={`Кабинет: ${lesson.room!.name}`}>{room}</span>}
    </div>}
    {!!lesson.jointGroups?.length && <span className="students-table-joint" title="Совместное занятие">Совм. <span className="school-code">{lesson.jointGroups.map(group => group.name).join(", ")}</span></span>}
  </article>;
}

function TableBand({ groups, showIcons, columns, ariaLabel }: { groups: DayGroup[]; showIcons: boolean; columns: number; ariaLabel?: string }) {
  // A slot can start at different times in different groups or school shifts.
  // Keep those in separate rows so the common time column stays accurate.
  const rows = [...new Map(groups.flatMap(group => group.day?.holiday ? [] : (group.day?.lessons ?? []).map(lesson => [rowKey(lesson), { slot: lesson.slot, start: lesson.start }] as const))).values()]
    .sort((a, b) => a.start - b.start || a.slot - b.slot);
  const cells = groups.map(group => {
    const byRow = new Map<string, PublicStudentLesson[]>();
    for (const lesson of group.day?.lessons ?? []) {
      const key = rowKey(lesson);
      byRow.set(key, [...(byRow.get(key) ?? []), lesson]);
    }
    return byRow;
  });
  const displayRows = rows.length ? rows : [{ slot: 0, start: 0 }];
  const width = `calc(var(--students-time-width) + 2px + (100% - var(--students-time-width) - 2px) / ${columns} * ${groups.length})`;
  return <div className="students-day-table-wrap" style={{ width }}><table className="students-day-table" aria-label={`${ariaLabel ?? "Расписание классов"}: ${groups.map(group => group.name).join(", ")}`}>
    <colgroup><col className="students-table-time-col" />{groups.map(group => <col key={group.id} />)}</colgroup>
    <thead><tr><th scope="col" className="students-table-corner">Урок<br />Время</th>{groups.map(group => <th scope="col" className={`school-code${group.isToday ? " is-today" : ""}`} aria-current={group.isToday ? "date" : undefined} key={group.id}>{group.name}</th>)}</tr></thead>
    <tbody>{displayRows.map((row, index) => <tr key={`${row.slot}:${row.start}`}>
      <th scope="row" className="students-table-time">{row.slot ? <><strong>№{row.slot}</strong><time>{clock(row.start)}</time></> : "—"}</th>
      {groups.map((group, groupIndex) => {
        if (group.day?.holiday || !group.day?.lessons.length) {
          return index === 0 ? <td className="students-table-empty-day" key={group.id} rowSpan={displayRows.length}>{group.day?.holiday ? group.day.calendarLabel || (group.day.holidayKind === "vacation" ? "Каникулы" : "Занятий нет") : "Занятий нет"}</td> : null;
        }
        const lessons = cells[groupIndex].get(`${row.slot}:${row.start}`) ?? [];
        return <td key={group.id}>{lessons.length ? <div className="students-table-lessons">{lessons.map(lesson => <CompactLesson key={lesson.id} lesson={lesson} showIcons={showIcons} />)}</div> : <span className="students-table-empty" aria-label="Нет урока">—</span>}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

export default function StudentsDayTable({ groups, showIcons, ariaLabel }: { groups: DayGroup[]; showIcons: boolean; ariaLabel?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth) return;
      const styles = getComputedStyle(element);
      const timeWidth = parseFloat(styles.getPropertyValue("--students-time-width"));
      const groupWidth = parseFloat(styles.getPropertyValue("--students-group-width"));
      setColumns(Math.max(1, Math.floor((element.clientWidth - timeWidth - 2) / groupWidth)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const bands = Array.from({ length: Math.ceil(groups.length / columns) }, (_, index) => groups.slice(index * columns, (index + 1) * columns));
  return <div className="students-day-tables" ref={container}>{bands.map(band => <TableBand key={band[0].id} groups={band} showIcons={showIcons} columns={columns} ariaLabel={ariaLabel} />)}</div>;
}
