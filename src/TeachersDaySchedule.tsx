import { useEffect, useMemo, useState } from "react";
import { teacherInitials } from "../shared/catalog.ts";
import { dateIso, isValidIsoDate } from "../shared/teacherNavigation.ts";
import { shiftStudentDate } from "../shared/studentDayNavigation.ts";
import type { PublicTeachersDaySchedule } from "../shared/teacherTypes.ts";
import { api } from "./api";
import RussianDateInput from "./RussianDateInput";
import { useSchoolSettings } from "./SchoolSettings";
import TeacherPicker from "./TeacherPicker";
import TeachersScheduleTable from "./TeachersScheduleTable";

const today = () => dateIso(new Date());
const dateTitle = (date: string) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`));

export default function TeachersDaySchedule({ active = true }: { active?: boolean }) {
  const [request, setRequest] = useState(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    return { date: isValidIsoDate(date) ? date : today(), nextStudyDay: !isValidIsoDate(date), attempt: 0 };
  });
  const [teacherFilter, setTeacherFilter] = useState<string[] | null>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("teachers") === "none") return [];
    const ids = query.getAll("teacher").filter(Boolean);
    return ids.length ? [...new Set(ids)] : null;
  });
  const [data, setData] = useState<PublicTeachersDaySchedule>();
  const [error, setError] = useState("");
  const { refresh } = useSchoolSettings();
  const date = data?.date ?? request.date;
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError("");
    const query = new URLSearchParams({ date: request.date });
    if (request.nextStudyDay) query.set("nextStudyDay", "true");
    api<PublicTeachersDaySchedule>(`/api/public/teachers/day?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание."); });
    refresh();
    return () => controller.abort();
  }, [request, refresh]);
  useEffect(() => {
    if (!active) return;
    const query = new URLSearchParams({ view: "date", date });
    if (teacherFilter?.length === 0) query.set("teachers", "none");
    else if (teacherFilter) for (const id of teacherFilter) query.append("teacher", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [date, teacherFilter, active]);
  const availableTeachers = useMemo(() => (data?.teachers ?? [])
    .slice().sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id)), [data]);
  const columns = useMemo(() => availableTeachers.filter(teacher => teacherFilter === null || teacherFilter.includes(teacher.id)).map(teacher => {
    return {
      id: teacher.id, name: teacherInitials(teacher.name), title: teacher.name,
      day: teacher.day,
    };
  }), [availableTeachers, teacherFilter]);
  const chooseDate = (next: string) => {
    if (!isValidIsoDate(next)) return;
    setRequest(value => ({ date: next, nextStudyDay: false, attempt: value.attempt + 1 }));
  };
  return <>
    <section className="teachers-controls teachers-date-controls" aria-label="Расписание за день">
      <TeacherPicker teachers={availableTeachers} selected={teacherFilter} onChange={setTeacherFilter} disabled={!data} resetKey="date" />
      <div className="teachers-date-control"><span>Дата</span><div className="teachers-date-picker">
        <button type="button" className="teachers-date-arrow" aria-label="Предыдущий день" disabled={date <= "0001-01-01"} onClick={() => chooseDate(shiftStudentDate(date, -1))}>‹</button>
        <RussianDateInput label="Дата расписания" value={date} onChange={chooseDate} />
        <button type="button" className="teachers-date-arrow" aria-label="Следующий день" disabled={date >= "9999-12-31"} onClick={() => chooseDate(shiftStudentDate(date, 1))}>›</button>
      </div></div>
      <button type="button" className="teachers-today-button" onClick={() => setRequest(value => ({ date: today(), nextStudyDay: true, attempt: value.attempt + 1 }))}>Сегодня</button>
    </section>
    <div className="teachers-schedule-meta teachers-date-meta"><h2>{dateTitle(date)}</h2>{data && <span>Преподавателей: {columns.length}</span>}</div>
    {data && request.nextStudyDay && data.date > request.date && <p className="teachers-date-notice" role="status">Сегодня занятий нет. Показан ближайший день с опубликованными занятиями.</p>}
    {error ? <div className="teachers-state teachers-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRequest(value => ({ ...value, attempt: value.attempt + 1 }))}>Повторить</button></div>
      : !data ? <div className="teachers-state" role="status">Загружаем расписание…</div>
      : !data.hasPublications ? <div className="teachers-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>
      : !data.teachers.length ? <div className="teachers-state"><h2>На эту дату нет опубликованного расписания</h2><p>Выберите другую дату.</p></div>
      : !columns.length ? <div className="teachers-state"><h2>Преподаватели не выбраны</h2><p>Выберите преподавателей в фильтре.</p></div>
      : <><div className="teachers-shift-legend" aria-label="Цвета смен"><span className="teachers-shift-morning">№ · 1-я смена</span><span className="teachers-shift-afternoon">№ · 2-я смена</span></div><TeachersScheduleTable columns={columns} /></>}
  </>;
}
