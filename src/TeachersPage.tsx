import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { withBasePath } from "./basePath";
import { chooseTeacherLocation, dateIso, isValidIsoDate, mondayOf, nearestLessonDate, TEACHER_STORAGE_KEY, weekDatesFor } from "../shared/teacherNavigation.ts";
import { visibleQuarters } from "../shared/plans.ts";
import type { PublicTeacher, PublicTeacherDay, PublicTeacherGroup, PublicTeacherLesson, PublicTeacherSchedule, PublicTeachersIndex } from "../shared/teacherTypes.ts";
import { subjectColors } from "../shared/subjectColors.ts";
import SchoolName from "./SchoolSettings";
import InfoTooltip from "./InfoTooltip";
import "./teachers.css";

const today = () => dateIso(new Date());
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }) => new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${value}T12:00:00`));
const teacherSort = (a: PublicTeacher, b: PublicTeacher) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" });
const weekTitle = (monday: string) => {
  const days = weekDatesFor(monday);
  return `${dateLabel(days[0], { day: "numeric", month: "short" })} – ${dateLabel(days[6], { day: "numeric", month: "short" })}`;
};
const roomName = (value?: string) => value?.replace(/^\s*кабинет\s*/i, "").trim();
const lessonNumbers = (lesson: PublicTeacherLesson) => [...new Set(lesson.groups.map(group => group.slot))].sort((a, b) => a - b);
const shiftFor = (group: PublicTeacherGroup, lesson: PublicTeacherLesson) => (group.dayStart ?? lesson.start) < 12 * 60 ? "morning" : "afternoon";

function TeacherLesson({ lesson }: { lesson: PublicTeacherLesson }) {
  const color = subjectColors.find(item => item.id === lesson.subject?.color)?.dot;
  const numbers = [...new Map(lesson.groups.map(group => {
    const shift = shiftFor(group, lesson);
    return [`${group.slot}:${shift}`, { slot: group.slot, shift }] as const;
  })).values()].sort((a, b) => a.slot - b.slot || (a.shift === b.shift ? 0 : a.shift === "morning" ? -1 : 1));
  const groups = lesson.groups.map(group => {
    const number = group.subgroup?.number ?? Number(group.subgroup?.name.match(/\d+/)?.[0]);
    const cohort = group.subgroup
      ? Number.isFinite(number) && number > 0 ? `${group.name}/${number}` : `${group.name}/${group.subgroup.name}`
      : group.name;
    return { cohort, slot: group.slot, shift: shiftFor(group, lesson) };
  });
  const room = roomName(lesson.room?.name);
  return <article className="teachers-lesson" style={color ? { borderLeftColor: color } : undefined}>
    <div className="teachers-lesson-time"><strong>{numbers.map((number, index) => <span key={`${number.slot}:${number.shift}`} className={`teachers-shift-${number.shift}`} title={number.shift === "morning" ? "Первая смена" : "Вторая смена"}>{index > 0 && <span className="teachers-number-divider" aria-hidden="true">/</span>}{index === 0 ? "№" : ""}{number.slot}</span>)}</strong><time>{clock(lesson.start)}</time></div>
    <div className="teachers-lesson-content">
      <strong>{lesson.event || lesson.subject?.name || "Занятие"}</strong>
      {lesson.lessonKind === "lab" && <span className="teachers-lesson-tag">Лаб.</span>}
      <div className="teachers-lesson-groups" aria-label="Классы и подгруппы">{groups.map((group, index) => <span key={`${group.cohort}-${index}`}><span className="school-code">{group.cohort}</span>{numbers.length > 1 && <> · <b className={`teachers-shift-${group.shift}`}>№{group.slot}</b></>}</span>)}</div>
      {room && <span className="teachers-lesson-room">{room}</span>}
    </div>
  </article>;
}

function TeacherDay({ day, date, todayDate }: { day?: PublicTeacherDay; date: string; todayDate: string }) {
  const lessons = [...(day?.lessons ?? [])].sort((a, b) => a.start - b.start || (lessonNumbers(a)[0] ?? 0) - (lessonNumbers(b)[0] ?? 0) || a.id.localeCompare(b.id));
  const gaps = new Map((day?.gaps ?? []).map(gap => [gap.end, gap]));
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(new Date(`${date}T12:00:00`));
  return <section className={`teachers-day${date === todayDate ? " is-today" : ""}${day?.holiday ? " is-holiday" : ""}`} aria-label={`${weekday}, ${dateLabel(date)}`}>
    <header className="teachers-day-header"><div><span>{weekday}</span><strong>{dateLabel(date, { day: "numeric", month: "long" })}</strong></div>{date === todayDate && <small>Сегодня</small>}</header>
    {day?.holiday
      ? <p className="teachers-day-empty">{day.calendarLabel || (day.holidayKind === "vacation" ? "Каникулы" : "Занятий нет")}</p>
      : lessons.length
        ? <div className="teachers-day-lessons">{lessons.map((lesson, index) => {
          const gap = index === 0 || lessons[index - 1]!.start !== lesson.start ? gaps.get(lesson.start) : undefined;
          return <Fragment key={lesson.id}>
            {gap && <div className="teachers-gap" title={`Промежуток ${gap.minutes} мин длиннее перемены рядом с уроками (${gap.normalBreakMinutes} мин).`}>
              <strong>Перерыв {gap.minutes} мин</strong>
              <span>{clock(gap.start)}–{clock(gap.end)}</span>
            </div>}
            <TeacherLesson lesson={lesson} />
          </Fragment>;
        })}</div>
        : <p className="teachers-day-empty">Занятий нет</p>}
  </section>;
}

export default function TeachersPage() {
  const [index, setIndex] = useState<PublicTeachersIndex>();
  const [indexError, setIndexError] = useState("");
  const [selection, setSelection] = useState<{ teacherId: string; quarterId: string; date: string }>();
  const [schedule, setSchedule] = useState<PublicTeacherSchedule>();
  const [scheduleError, setScheduleError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showTeachers, setShowTeachers] = useState(false);
  const [activeOption, setActiveOption] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(selection);
  const selectedNameRef = useRef("");
  const redirectForVacationRef = useRef(false);
  const refreshedPublicationRef = useRef(new Set<string>());
  const indexRequestRef = useRef(0);
  selectionRef.current = selection;

  const loadIndex = useCallback((signal?: AbortSignal, preserve?: { teacherId: string; quarterId: string; date: string }) => {
    const requestId = ++indexRequestRef.current;
    setLoading(true); setIndexError(""); setSchedule(undefined); setScheduleError("");
    if (!preserve) setSelection(undefined);
    api<PublicTeachersIndex>("/api/public/teachers", { signal }).then(value => {
      if (signal?.aborted || requestId !== indexRequestRef.current) return;
      setIndex(value);
      const params = new URLSearchParams(window.location.search);
      let storedTeacher: string | undefined;
      try { storedTeacher = localStorage.getItem(TEACHER_STORAGE_KEY) ?? undefined; } catch { /* storage may be disabled */ }
      const latest = preserve && selectionRef.current?.teacherId === preserve.teacherId && selectionRef.current.quarterId === preserve.quarterId ? selectionRef.current : preserve;
      const next = latest
        ? chooseTeacherLocation(value, { today: today(), queryTeacher: latest.teacherId, queryQuarter: latest.quarterId, queryDate: latest.date, storedTeacher })
        : chooseTeacherLocation(value, { today: today(), queryTeacher: params.get("teacher") ?? undefined, queryQuarter: params.get("quarter") ?? undefined, queryDate: params.get("date") ?? undefined, storedTeacher });
      redirectForVacationRef.current = !preserve && !params.has("quarter") && !params.has("date") && next?.date === today();
      setSelection(next);
      setSearch(next ? value.quarters.find(q => q.id === next.quarterId)?.teachers.find(teacher => teacher.id === next.teacherId)?.name ?? "" : "");
    }).catch(error => {
      if (!signal?.aborted && requestId === indexRequestRef.current) setIndexError(error instanceof Error ? error.message : "Не удалось загрузить расписание.");
    }).finally(() => { if (!signal?.aborted && requestId === indexRequestRef.current) setLoading(false); });
  }, []);

  useEffect(() => {
    const controller = new AbortController(); loadIndex(controller.signal);
    return () => controller.abort();
  }, [loadIndex]);

  useEffect(() => {
    if (!selection || !index) { setSchedule(undefined); return; }
    const controller = new AbortController();
    let indexRefreshStarted = false;
    setLoading(true); setSchedule(undefined); setScheduleError("");
    const query = new URLSearchParams({ quarterId: selection.quarterId, teacherId: selection.teacherId });
    api<PublicTeacherSchedule>(`/api/public/teachers/schedule?${query}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const indexedQuarter = index.quarters.find(item => item.id === selection.quarterId);
      const versionKey = `${selection.quarterId}:${value.publication.version}`;
      if (indexedQuarter && value.publication.version > indexedQuarter.publication.version && !refreshedPublicationRef.current.has(versionKey)) {
        refreshedPublicationRef.current.add(versionKey);
        indexRefreshStarted = true;
        loadIndex(controller.signal, selectionRef.current ?? selection);
        return;
      }
      const currentDate = today();
      const todayIsVacation = value.days.some(day => day.date === currentDate && day.holidayKind === "vacation");
      if (redirectForVacationRef.current && selection.date === currentDate && todayIsVacation) {
        redirectForVacationRef.current = false;
        const next = chooseTeacherLocation(index, { today: currentDate, queryTeacher: selection.teacherId, todayIsVacation: true });
        if (next && (next.date !== selection.date || next.quarterId !== selection.quarterId)) {
          setSelection(next);
          if (next.teacherId !== selection.teacherId || next.quarterId !== selection.quarterId) return;
        }
      }
      setSearch(value.teacher.name);
      setSchedule(value);
    }).catch(error => { if (!controller.signal.aborted) setScheduleError(error instanceof Error ? error.message : "Не удалось загрузить расписание."); })
      .finally(() => { if (!controller.signal.aborted && !indexRefreshStarted) setLoading(false); });
    return () => controller.abort();
  }, [selection?.teacherId, selection?.quarterId, index, loadIndex]);

  useEffect(() => {
    if (!selection) return;
    try { localStorage.setItem(TEACHER_STORAGE_KEY, selection.teacherId); } catch { /* storage may be disabled */ }
    const params = new URLSearchParams({ teacher: selection.teacherId, quarter: selection.quarterId, date: selection.date });
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [selection]);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!pickerRef.current?.contains(event.target as Node)) { setShowTeachers(false); setSearch(selectedNameRef.current); } };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);

  const quarter = useMemo(() => index?.quarters.find(item => item.id === selection?.quarterId), [index, selection]);
  const teachers = useMemo(() => [...(quarter?.teachers ?? [])].sort(teacherSort), [quarter]);
  const weeks = useMemo(() => {
    if (!quarter) return [];
    const result: string[] = [];
    let monday = mondayOf(quarter.startDate);
    while (monday <= quarter.endDate) { result.push(monday); const next = new Date(`${monday}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 7); monday = next.toISOString().slice(0, 10); }
    return result;
  }, [quarter]);
  const activeWeek = selection ? mondayOf(selection.date) : "";
  const weekIndex = weeks.indexOf(activeWeek);
  const weekDates = selection ? weekDatesFor(selection.date) : [];
  const daysByDate = useMemo(() => new Map((schedule?.days ?? []).map(day => [day.date, day])), [schedule]);
  const visibleDates = weekDates.filter(date => {
    if (date < (quarter?.startDate ?? "") || date > (quarter?.endDate ?? "")) return false;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5 || Boolean(daysByDate.get(date)?.lessons.length) || date === selection?.date;
  });
  const weekGaps = visibleDates.flatMap(date => {
    const day = daysByDate.get(date);
    return day?.holiday ? [] : day?.gaps ?? [];
  });
  const weekGapMinutes = weekGaps.reduce((total, gap) => total + gap.minutes, 0);
  const teacherName = schedule?.teacher.name ?? teachers.find(teacher => teacher.id === selection?.teacherId)?.name ?? "";
  selectedNameRef.current = teacherName;
  const filter = showTeachers && search === teacherName ? "" : search;
  const filteredTeachers = teachers.filter(teacher => teacher.name.toLocaleLowerCase("ru").includes(filter.toLocaleLowerCase("ru")));
  useEffect(() => {
    if (showTeachers && filteredTeachers[activeOption]) document.getElementById(`teacher-option-${filteredTeachers[activeOption].id}`)?.scrollIntoView({ block: "nearest" });
  }, [showTeachers, activeOption, filter, teachers]);

  const chooseTeacher = (teacher: PublicTeacher) => {
    if (!selection || !quarter) return;
    redirectForVacationRef.current = false;
    setSelection({ ...selection, teacherId: teacher.id }); setSearch(teacher.name); setShowTeachers(false);
  };
  const changeQuarter = (quarterId: string) => {
    if (!index || !selection) return;
    const nextQuarter = index.quarters.find(item => item.id === quarterId); if (!nextQuarter) return;
    const teacher = nextQuarter.teachers.find(item => item.id === selection.teacherId) ?? [...nextQuarter.teachers].sort(teacherSort)[0];
    if (!teacher) return;
    redirectForVacationRef.current = false;
    setSelection({ teacherId: teacher.id, quarterId, date: nearestLessonDate(teacher.lessonDates, today()) ?? (today() < nextQuarter.startDate ? nextQuarter.startDate : today() > nextQuarter.endDate ? nextQuarter.endDate : today()) });
    setSearch(teacher.name);
  };
  const setDate = (date: string) => {
    if (selection && isValidIsoDate(date) && date >= (quarter?.startDate ?? date) && date <= (quarter?.endDate ?? date)) {
      redirectForVacationRef.current = false;
      setSelection({ ...selection, date });
    }
  };
  const goToday = () => {
    if (!index) return;
    redirectForVacationRef.current = true;
    const isVacation = schedule?.days.some(day => day.date === today() && day.holidayKind === "vacation");
    const next = chooseTeacherLocation(index, { today: today(), queryTeacher: selection?.teacherId, todayIsVacation: isVacation });
    if (next) { setSelection(next); setSearch(index.quarters.find(item => item.id === next.quarterId)?.teachers.find(item => item.id === next.teacherId)?.name ?? ""); }
  };
  const moveWeek = (direction: number) => {
    const target = weeks[weekIndex + direction];
    if (target) setDate(target < (quarter?.startDate ?? target) ? quarter!.startDate : target);
  };
  const retry = () => loadIndex(undefined, selection);

  return <div className="teachers-page">
    <header className="teachers-header"><div className="teachers-header-top"><a className="teachers-brand" href={withBasePath("/teachers")} aria-label="Смена — главная страница учителей"><span className="teachers-brand-mark">С</span><span>смена</span></a><span className="teachers-header-title">Учителям</span><SchoolName className="teachers-header-school-name" /><nav className="teachers-public-links" aria-label="Публичные страницы"><a className="teachers-student-link" href={withBasePath("/")}>Ученикам</a><a className="teachers-admin-link" href={withBasePath("/admin")} aria-label="Вход для администратора"><span className="teachers-admin-label">Вход для администратора</span><span className="teachers-admin-short">Вход</span></a></nav></div></header>
    <main className="teachers-main">
      {indexError && <div className="teachers-state teachers-error" role="alert"><p>{indexError}</p><button onClick={retry}>Повторить</button></div>}
      {!indexError && loading && !selection && <div className="teachers-state" role="status">Загружаем опубликованное расписание…</div>}
      {!indexError && !loading && index?.quarters.length === 0 && <div className="teachers-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>}
      {!indexError && !loading && Boolean(index?.quarters.length) && !selection && <div className="teachers-state"><h2>В опубликованном расписании нет преподавателей</h2><p>После публикации расписания с преподавателями они появятся в списке.</p></div>}
      {selection && index && <>
        <section className="teachers-controls" aria-label="Выбор расписания">
          <div className="teachers-picker" ref={pickerRef}>
            <label htmlFor="teachers-search">Учитель</label>
            <input id="teachers-search" role="combobox" aria-autocomplete="list" aria-expanded={showTeachers} aria-controls="teachers-options" aria-activedescendant={showTeachers && filteredTeachers[activeOption] ? `teacher-option-${filteredTeachers[activeOption].id}` : undefined} value={search} placeholder="Найти учителя по фамилии или имени" autoComplete="off" onFocus={event => { setShowTeachers(true); setActiveOption(0); event.currentTarget.select(); }} onBlur={() => { window.setTimeout(() => { if (!pickerRef.current?.contains(document.activeElement)) { setShowTeachers(false); setSearch(selectedNameRef.current); } }, 120); }} onChange={event => { setSearch(event.target.value); setShowTeachers(true); setActiveOption(0); }} onKeyDown={event => {
              if (event.key === "ArrowDown") { event.preventDefault(); setShowTeachers(true); setActiveOption(value => Math.min(value + 1, filteredTeachers.length - 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActiveOption(value => Math.max(value - 1, 0)); }
              else if (event.key === "Enter" && showTeachers && filteredTeachers[activeOption]) { event.preventDefault(); chooseTeacher(filteredTeachers[activeOption]); }
              else if (event.key === "Escape") { setShowTeachers(false); setSearch(teacherName); }
            }} />
            {showTeachers && <div id="teachers-options" className="teachers-options" role="listbox">{filteredTeachers.length ? filteredTeachers.map((teacher, i) => <button id={`teacher-option-${teacher.id}`} key={teacher.id} type="button" role="option" aria-selected={teacher.id === selection.teacherId} className={`${i === activeOption ? "is-active" : ""}${teacher.id === selection.teacherId ? " is-selected" : ""}`} onMouseEnter={() => setActiveOption(i)} onClick={() => chooseTeacher(teacher)}>{teacher.name}{teacher.id === selection.teacherId && <span>Выбран</span>}</button>) : <p>Учитель не найден</p>}</div>}
          </div>
          <label className="teachers-quarter-control">Четверть<select value={quarter?.id ?? ""} onChange={event => changeQuarter(event.target.value)}>{visibleQuarters(index.quarters).map(item => <option key={item.id} value={item.id} disabled={!item.teachers.length}>{item.name}</option>)}</select></label>
          <div className="teachers-week-control"><label htmlFor="teachers-week">Неделя</label><div className="teachers-week-picker"><button type="button" aria-label="Предыдущая неделя" disabled={weekIndex <= 0} onClick={() => moveWeek(-1)}>‹</button><select id="teachers-week" aria-label="Неделя" value={activeWeek} onChange={event => setDate(event.target.value < (quarter?.startDate ?? "") ? quarter!.startDate : event.target.value)}>{weeks.map(week => <option key={week} value={week}>{weekTitle(week)}</option>)}</select><button type="button" aria-label="Следующая неделя" disabled={weekIndex < 0 || weekIndex >= weeks.length - 1} onClick={() => moveWeek(1)}>›</button></div></div>
          <button type="button" className="teachers-today-button" onClick={goToday}>Сегодня</button>
        </section>
        {scheduleError && <div className="teachers-state teachers-error" role="alert"><p>{scheduleError}</p><button onClick={retry}>Повторить</button></div>}
        {loading && <div className="teachers-state" role="status">Загружаем расписание…</div>}
        {!loading && !scheduleError && schedule && <>
          {schedule.days.some(day => day.lessons.length) && <div className="teachers-shift-legend" aria-label="Цвета смен"><span className="teachers-shift-morning" title="Учебный день группы начинается до 12:00">№ · 1-я смена</span><span className="teachers-shift-afternoon" title="Учебный день группы начинается с 12:00">№ · 2-я смена</span></div>}
          {schedule.days.some(day => day.gaps !== undefined) && <div className="teachers-gap-explanation">
            {weekGaps.length > 0 && <span className="teachers-gap-summary">Длительные перерывы за неделю: <strong>{weekGapMinutes} мин</strong></span>}
            {weekGaps.length === 0 && <span>Промежутки</span>}
            <InfoTooltip label="Промежутки между уроками">Отмечены промежутки длиннее перемен рядом с уроками. Указано всё время ожидания.</InfoTooltip>
          </div>}
          {selection.date < (quarter?.startDate ?? "") || selection.date > (quarter?.endDate ?? "")
            ? <div className="teachers-state"><h2>Эта дата вне опубликованной четверти</h2><p>Выберите четверть, в которую входит нужная дата.</p></div>
            : !schedule.days.some(day => day.lessons.length)
              ? <div className="teachers-state"><h2>У этого учителя нет опубликованных занятий</h2><p>Выберите другую четверть или преподавателя.</p></div>
              : visibleDates.length ? <div className="teachers-days">{visibleDates.map(date => <TeacherDay key={date} date={date} day={daysByDate.get(date)} todayDate={today()} />)}</div>
                : <div className="teachers-state"><h2>На этой неделе занятий нет</h2><p>Выберите другую неделю или перейдите к ближайшему расписанию.</p></div>}
        </>}
      </>}
    </main>
    <footer className="teachers-footer">Смена · расписание школы</footer>
  </div>;
}
