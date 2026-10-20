import type { PublicStudentDay, PublicStudentLesson } from "../shared/studentTypes.ts";
import { subjectColors } from "../shared/subjectColors.ts";
import SubjectIcon from "./SubjectIcon";

const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }) => new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${value}T12:00:00`));

function LessonCard({ lessons, groupName, showIcons }: { lessons: PublicStudentLesson[]; groupName: string; showIcons: boolean }) {
  const lesson = lessons[0];
  const title = lesson.event || lesson.subject?.name || "Занятие";
  const participants = lesson.jointGroups?.map(group => group.name).join(", ");
  const color = subjectColors.find(item => item.id === lesson.subject?.color)?.dot;
  const headerSurname = lessons.length === 1 && !lesson.subgroup ? lesson.teacher?.name.trim().split(/\s+/)[0] : undefined;
  return <article className="students-lesson" style={color ? { borderLeftColor: color } : undefined}>
    {showIcons && !lesson.event && lesson.subject && <SubjectIcon subject={lesson.subject} />}
    <div className="students-lesson-body">
    <strong className="students-lesson-title">{title}{headerSurname && <span className="students-lesson-teacher" title={lesson.teacher?.name}> ({headerSurname})</span>}</strong>
    {lesson.lessonKind === "lab" && <span className="students-lesson-tag">Лаб.</span>}
    {lessons.map(item => {
      const surname = item.teacher?.name.trim().split(/\s+/)[0];
      const room = item.room?.name.replace(/^\s*кабинет\s*/i, "");
      const number = item.subgroup?.number ?? Number(item.subgroup?.name.match(/\d+/)?.[0]);
      const groupLabel = item.subgroup && (Number.isFinite(number) && number > 0 ? `${groupName}/${number}` : item.subgroup.name);
      return (groupLabel || (!headerSurname && surname) || room) && <div className="students-lesson-resources" key={item.id}>
        {(groupLabel || (!headerSurname && surname)) && <span className="students-lesson-detail" title={item.subgroup?.name}>{groupLabel ? <><span className="school-code">{groupLabel}</span>{surname ? ` (${surname})` : ""}</> : surname}</span>}
        {room && <span className="students-lesson-room">{room}</span>}
      </div>;
    })}
    {participants && <span className="students-lesson-joint">Общий: <span className="school-code">{participants}</span></span>}
    </div>
  </article>;
}

export default function StudentDayCard({ day, date, todayDate, groupName, showIcons, groupHeading }: { day?: PublicStudentDay; date: string; todayDate: string; groupName: string; showIcons: boolean; groupHeading?: string }) {
  const lessons = [...(day?.lessons ?? [])].sort((a, b) => a.start - b.start || a.slot - b.slot || a.id.localeCompare(b.id));
  const slotCount = Math.max(0, ...lessons.map(lesson => lesson.slot));
  const lessonCount = new Set(lessons.map(lesson => lesson.slot)).size;
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(new Date(`${date}T12:00:00`));
  return <section className={`students-day${date === todayDate ? " is-today" : ""}${day?.holiday ? " is-holiday" : ""}`} aria-label={groupHeading ? `${groupHeading}, ${dateLabel(date)}` : `${weekday}, ${dateLabel(date)}`}>
    <header className="students-day-header">{groupHeading ? <><h3 className="school-code">{groupHeading}</h3><span>{day?.holiday ? "Выходной" : `${lessonCount} зан.`}</span></> : <><div><span>{weekday}</span><strong>{dateLabel(date, { day: "numeric", month: "long" })}</strong></div>{date === todayDate && <small>Сегодня</small>}</>}</header>
    {day?.holiday || !slotCount
      ? <p className="students-day-empty">{day?.holiday ? day.calendarLabel || (day.holidayKind === "vacation" ? "Каникулы" : "Занятий нет") : "На этот день занятий нет"}</p>
      : <div className="students-day-lessons">{Array.from({ length: slotCount }, (_, slot) => {
          const slotLessons = lessons.filter(lesson => lesson.slot === slot + 1);
          const cards = new Map<string, PublicStudentLesson[]>();
          for (const lesson of slotLessons) {
            const key = lesson.subgroup ? `${lesson.subject?.id}:${lesson.event}:${lesson.lessonKind}` : lesson.id;
            cards.set(key, [...(cards.get(key) ?? []), lesson]);
          }
          const start = slotLessons[0]?.start;
          return <div className={`students-slot-row${slotLessons.length ? "" : " is-empty"}`} key={slot}>
            <div className="students-slot-time"><strong>№{slot + 1}</strong>{start !== undefined && <time>{clock(start)}</time>}</div>
            <div className="students-slot-items">{[...cards].map(([key, lessons]) => <LessonCard key={key} lessons={lessons} groupName={groupName} showIcons={showIcons} />)}</div>
            {!slotLessons.length && <span className="students-empty-slot">—</span>}
          </div>;
        })}</div>}
  </section>;
}
