import { useEffect, useMemo, useState } from "react";
import type { PublicStudentsDaySchedule } from "../shared/studentTypes.ts";
import { dateIso, isValidIsoDate } from "../shared/studentNavigation.ts";
import { matchesSchoolStage, shiftStudentDate, sortDayGroups, type SchoolStage } from "../shared/studentDayNavigation.ts";
import { api } from "./api";
import { useSchoolSettings } from "./SchoolSettings";
import RussianDateInput from "./RussianDateInput";
import StudentsDayTable from "./StudentsDayTable";

const stages: Array<{ id: SchoolStage; label: string }> = [
  { id: "all", label: "Вся" },
  { id: "primary", label: "Начальная" },
  { id: "middle", label: "Средняя" },
  { id: "high", label: "Старшая" },
];
const today = () => dateIso(new Date());
const dateTitle = (date: string) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`));

export default function StudentsDaySchedule({ active = true }: { active?: boolean }) {
  const [request, setRequest] = useState(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    return { date: isValidIsoDate(date) ? date : today(), nextStudyDay: !isValidIsoDate(date), attempt: 0 };
  });
  const [stage, setStage] = useState<SchoolStage>(() => {
    const value = new URLSearchParams(window.location.search).get("school");
    return stages.find(item => item.id === value)?.id ?? "all";
  });
  const [data, setData] = useState<PublicStudentsDaySchedule>();
  const [error, setError] = useState("");
  const { studentSubjectIcons, refresh } = useSchoolSettings();
  const date = data?.date ?? request.date;

  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError("");
    const query = new URLSearchParams({ date: request.date });
    if (request.nextStudyDay) query.set("nextStudyDay", "true");
    api<PublicStudentsDaySchedule>(`/api/public/students/day?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание."); });
    refresh();
    return () => controller.abort();
  }, [request, refresh]);

  useEffect(() => {
    if (!active) return;
    const query = new URLSearchParams({ view: "date", date });
    if (stage !== "all") query.set("school", stage);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [date, stage, active]);

  const groups = useMemo(() => sortDayGroups((data?.groups ?? []).filter(group => matchesSchoolStage(group.name, stage))), [data, stage]);
  const chooseDate = (next: string) => {
    if (!isValidIsoDate(next)) return;
    setData(undefined); setError("");
    setRequest(value => ({ date: next, nextStudyDay: false, attempt: value.attempt + 1 }));
  };
  const goToday = () => {
    setData(undefined); setError("");
    setRequest(value => ({ date: today(), nextStudyDay: true, attempt: value.attempt + 1 }));
  };

  return <>
    <section className="students-controls students-date-controls" aria-label="Расписание за день">
      <div className="students-school-control"><span>Школа</span><div className="students-school-options" role="group" aria-label="Ступень школы">{stages.map(item => <button type="button" key={item.id} aria-pressed={stage === item.id} onClick={() => setStage(item.id)}>{item.label}</button>)}</div></div>
      <div className="students-date-control"><span>Дата</span><div className="students-date-picker">
        <button type="button" className="students-date-arrow" aria-label="Предыдущий день" disabled={date <= "0001-01-01"} onClick={() => chooseDate(shiftStudentDate(date, -1))}>‹</button>
        <RussianDateInput label="Дата расписания" value={date} onChange={chooseDate} />
        <button type="button" className="students-date-arrow" aria-label="Следующий день" disabled={date >= "9999-12-31"} onClick={() => chooseDate(shiftStudentDate(date, 1))}>›</button>
      </div></div>
      <button type="button" className="students-today-button" onClick={goToday}>Сегодня</button>
    </section>
    <div className="students-schedule-meta students-date-meta"><h2>{dateTitle(date)}</h2>{data && <span>Классов: {groups.length}</span>}</div>
    {data && request.nextStudyDay && data.date > request.date && <p className="students-date-notice" role="status">Сегодня занятий нет. Показан ближайший день с опубликованными занятиями.</p>}
    {error ? <div className="students-state students-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRequest(value => ({ ...value, attempt: value.attempt + 1 }))}>Повторить</button></div>
      : !data ? <div className="students-state" role="status">Загружаем расписание…</div>
      : !data.hasPublications ? <div className="students-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>
      : !data.groups.length ? <div className="students-state"><h2>На эту дату нет опубликованного расписания</h2><p>Выберите другую дату.</p></div>
      : !groups.length ? <div className="students-state"><h2>Нет классов выбранной ступени</h2><p>Выберите другую ступень школы.</p></div>
      : <StudentsDayTable groups={groups} showIcons={studentSubjectIcons === true} />}
  </>;
}
