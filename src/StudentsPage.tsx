import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { chooseStudentLocation, dateIso, groupFor, isValidIsoDate, mondayOf, nearestLessonDate, STUDENT_GROUP_STORAGE_KEY, weekDatesFor } from "../shared/studentNavigation.ts";
import { visibleQuarters } from "../shared/plans.ts";
import type { PublicStudentDay, PublicStudentGroup, PublicStudentLesson, PublicStudentSchedule, PublicStudentsIndex } from "../shared/studentTypes.ts";
import { subjectColors } from "../shared/subjectColors.ts";
import SubjectIcon from "./SubjectIcon";
import SchoolName, { useSchoolSettings } from "./SchoolSettings";
import "./students.css";

const today = () => dateIso(new Date());
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }) => new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${value}T12:00:00`));
const groupSort = (a: PublicStudentGroup, b: PublicStudentGroup) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" });
const weekTitle = (monday: string) => {
  const days = weekDatesFor(monday);
  return `${dateLabel(days[0], { day: "numeric", month: "short" })} – ${dateLabel(days[6], { day: "numeric", month: "short" })}`;
};

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
        {(groupLabel || (!headerSurname && surname)) && <span className="students-lesson-detail" title={item.subgroup?.name}>{groupLabel ? `${groupLabel}${surname ? ` (${surname})` : ""}` : surname}</span>}
        {room && <span className="students-lesson-room">{room}</span>}
      </div>;
    })}
    {participants && <span className="students-lesson-joint">Общий: {participants}</span>}
    </div>
  </article>;
}

function DayCard({ day, date, todayDate, groupName, showIcons }: { day?: PublicStudentDay; date: string; todayDate: string; groupName: string; showIcons: boolean }) {
  const lessons = [...(day?.lessons ?? [])].sort((a, b) => a.start - b.start || a.slot - b.slot || a.id.localeCompare(b.id));
  const slotCount = Math.max(0, ...lessons.map(lesson => lesson.slot));
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(new Date(`${date}T12:00:00`));
  return <section className={`students-day${date === todayDate ? " is-today" : ""}${day?.holiday ? " is-holiday" : ""}`} aria-label={`${weekday}, ${dateLabel(date)}`}>
    <header className="students-day-header"><div><span>{weekday}</span><strong>{dateLabel(date, { day: "numeric", month: "long" })}</strong></div>{date === todayDate && <small>Сегодня</small>}</header>
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

export default function StudentsPage() {
  const [index, setIndex] = useState<PublicStudentsIndex>();
  const { studentSubjectIcons, refresh } = useSchoolSettings();
  const showSubjectIcons = studentSubjectIcons === true;
  const [indexError, setIndexError] = useState("");
  const [selection, setSelection] = useState<{ groupId: string; quarterId: string; date: string }>();
  const [schedule, setSchedule] = useState<PublicStudentSchedule>();
  const [scheduleError, setScheduleError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showGroups, setShowGroups] = useState(false);
  const [activeOption, setActiveOption] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const redirectForVacationRef = useRef(false);
  const selectedNameRef = useRef("");
  const selectionRef = useRef(selection);
  const refreshedPublicationRef = useRef(new Set<string>());
  const indexRequestRef = useRef(0);
  selectionRef.current = selection;

  useEffect(() => {
    if (selection) refresh();
  }, [selection?.groupId, selection?.quarterId, selection?.date, refresh]);

  const loadIndex = useCallback((signal?: AbortSignal, preserve?: { groupId: string; quarterId: string; date: string }) => {
    const requestId = ++indexRequestRef.current;
    setLoading(true); setIndexError(""); setSchedule(undefined); setScheduleError("");
    if (!preserve) setSelection(undefined);
    api<PublicStudentsIndex>("/api/public/students", { signal }).then(value => {
      if (signal?.aborted || requestId !== indexRequestRef.current) return;
      setIndex(value);
      const params = new URLSearchParams(window.location.search);
      let storedGroup: string | undefined;
      try { storedGroup = localStorage.getItem(STUDENT_GROUP_STORAGE_KEY) ?? undefined; } catch { /* storage may be disabled */ }
      const latest = preserve && selectionRef.current?.groupId === preserve.groupId && selectionRef.current.quarterId === preserve.quarterId ? selectionRef.current : preserve;
      const next = latest
        ? chooseStudentLocation(value.quarters, { today: today(), queryGroup: latest.groupId, queryQuarter: latest.quarterId, queryDate: latest.date, storedGroup })
        : chooseStudentLocation(value.quarters, {
            today: today(), queryGroup: params.get("group") ?? undefined,
            queryQuarter: params.get("quarter") ?? undefined, queryDate: params.get("week") ?? params.get("date") ?? undefined,
            storedGroup,
          });
      redirectForVacationRef.current = !preserve && !params.has("quarter") && !params.has("date") && next?.date === today();
      setSelection(next);
      setSearch(next ? groupFor(value.quarters.find(q => q.id === next.quarterId), next.groupId)?.name ?? "" : "");
    }).catch(error => { if (!signal?.aborted && requestId === indexRequestRef.current) setIndexError(error instanceof Error ? error.message : "Не удалось загрузить расписание."); }).finally(() => { if (!signal?.aborted && requestId === indexRequestRef.current) setLoading(false); });
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
    const query = new URLSearchParams({ quarterId: selection.quarterId, groupId: selection.groupId });
    api<PublicStudentSchedule>(`/api/public/students/schedule?${query}`, { signal: controller.signal })
      .then(value => {
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
          const next = chooseStudentLocation(index.quarters, { today: currentDate, queryGroup: selection.groupId, todayIsVacation: true });
          if (next && (next.date !== selection.date || next.quarterId !== selection.quarterId)) {
            setSelection(next);
            if (next.groupId !== selection.groupId || next.quarterId !== selection.quarterId) return;
          }
        }
        setSearch(value.group.name);
        setSchedule(value);
      }).catch(error => { if (!controller.signal.aborted) setScheduleError(error instanceof Error ? error.message : "Не удалось загрузить расписание."); })
      .finally(() => { if (!controller.signal.aborted && !indexRefreshStarted) setLoading(false); });
    return () => controller.abort();
  }, [selection?.groupId, selection?.quarterId, index, loadIndex]);

  useEffect(() => {
    if (!selection) return;
    try { localStorage.setItem(STUDENT_GROUP_STORAGE_KEY, selection.groupId); } catch { /* storage may be disabled */ }
    const params = new URLSearchParams({ group: selection.groupId, quarter: selection.quarterId, week: mondayOf(selection.date) });
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [selection]);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!pickerRef.current?.contains(event.target as Node)) { setShowGroups(false); setSearch(selectedNameRef.current); } };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);

  const quarter = useMemo(() => index?.quarters.find(item => item.id === selection?.quarterId), [index, selection]);
  const groups = useMemo(() => [...(quarter?.groups ?? [])].sort(groupSort), [quarter]);
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
    return (weekday >= 1 && weekday <= 5) || Boolean(daysByDate.get(date)?.lessons.length) || date === selection?.date;
  });
  const chosenGroupName = schedule?.group.name ?? groups.find(group => group.id === selection?.groupId)?.name ?? "";
  selectedNameRef.current = chosenGroupName;
  const groupFilter = showGroups && search === chosenGroupName ? "" : search;
  const filteredGroups = groups.filter(group => matchesGroupSearch(group.name, groupFilter));

  const chooseGroup = (group: PublicStudentGroup) => {
    if (!selection || !quarter) return;
    redirectForVacationRef.current = false;
    setSelection({ ...selection, groupId: group.id }); setSearch(group.name); setShowGroups(false);
  };
  const changeQuarter = (quarterId: string) => {
    if (!index || !selection) return;
    const nextQuarter = index.quarters.find(item => item.id === quarterId); if (!nextQuarter) return;
    const group = groupFor(nextQuarter, selection.groupId) ?? [...nextQuarter.groups].sort(groupSort)[0]; if (!group) return;
    redirectForVacationRef.current = false;
    setSelection({ groupId: group.id, quarterId, date: nearestLessonDate(group.lessonDates, today()) ?? (today() < nextQuarter.startDate ? nextQuarter.startDate : nextQuarter.endDate) });
    setSearch(group.name);
  };
  const setDate = (date: string) => { if (selection && isValidIsoDate(date) && date >= (quarter?.startDate ?? date) && date <= (quarter?.endDate ?? date)) { redirectForVacationRef.current = false; setSelection({ ...selection, date }); } };
  const goToday = () => {
    if (!index) return;
    redirectForVacationRef.current = true;
    const isVacation = schedule?.days.some(day => day.date === today() && day.holidayKind === "vacation");
    const next = chooseStudentLocation(index.quarters, { today: today(), queryGroup: selection?.groupId, todayIsVacation: isVacation });
    if (next) { setSelection(next); setSearch(groupFor(index.quarters.find(item => item.id === next.quarterId), next.groupId)?.name ?? ""); }
  };
  const moveWeek = (direction: number) => {
    const target = weeks[weekIndex + direction]; if (target) setDate(target < quarter!.startDate ? quarter!.startDate : target);
  };
  const retry = () => loadIndex();

  return <div className="students-page">
    <header className="students-header"><div className="students-header-top"><a className="students-brand" href="/" aria-label="Смена — главная страница учеников"><span className="students-brand-mark">С</span><span>смена</span></a><span className="students-header-title">Ученикам</span><SchoolName className="students-header-school-name" /><nav className="students-public-links" aria-label="Публичные страницы"><a className="students-admin-link" href="/teachers">Учителям</a><a className="students-admin-link" href="/admin" aria-label="Вход для администратора">Администратору</a></nav></div></header>
    <main className="students-main">
      {indexError && <div className="students-state students-error" role="alert"><p>{indexError}</p><button onClick={retry}>Повторить</button></div>}
      {!indexError && loading && !selection && <div className="students-state" role="status">Загружаем опубликованное расписание…</div>}
      {!indexError && !loading && index?.quarters.length === 0 && <div className="students-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>}
      {selection && index && <>
        <section className="students-controls" aria-label="Выбор расписания">
          <div className="students-group-control" ref={pickerRef}>
            <div className="group-search-label"><label htmlFor="students-group-search">Класс</label><GroupSearchHint /></div>
            <input id="students-group-search" role="combobox" aria-autocomplete="list" aria-expanded={showGroups} aria-controls="students-group-options" aria-activedescendant={showGroups && filteredGroups[activeOption] ? `student-group-${filteredGroups[activeOption].id}` : undefined} value={search} placeholder="Найти класс" autoComplete="off" onFocus={event => { setShowGroups(true); setActiveOption(0); event.currentTarget.select(); }} onBlur={() => { window.setTimeout(() => { if (!pickerRef.current?.contains(document.activeElement)) { setShowGroups(false); setSearch(selectedNameRef.current); } }, 120); }} onChange={event => { setSearch(event.target.value); setShowGroups(true); setActiveOption(0); }} onKeyDown={event => {
              if (event.key === "ArrowDown") { event.preventDefault(); setShowGroups(true); setActiveOption(value => Math.min(value + 1, filteredGroups.length - 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActiveOption(value => Math.max(value - 1, 0)); }
              else if (event.key === "Enter" && showGroups && filteredGroups[activeOption]) { event.preventDefault(); chooseGroup(filteredGroups[activeOption]); }
              else if (event.key === "Escape") setShowGroups(false);
            }} />
            {showGroups && <div id="students-group-options" className="students-group-options" role="listbox">{filteredGroups.length ? filteredGroups.map((group, i) => <button id={`student-group-${group.id}`} key={group.id} type="button" role="option" aria-selected={group.id === selection.groupId} className={`${i === activeOption ? "is-active" : ""}${group.id === selection.groupId ? " is-selected" : ""}`} onMouseEnter={() => setActiveOption(i)} onClick={() => chooseGroup(group)}>{group.name}{group.id === selection.groupId && <span>Выбран</span>}</button>) : <p>Класс не найден</p>}</div>}
          </div>
          <label className="students-select-control">Четверть<select value={quarter?.id ?? ""} onChange={event => changeQuarter(event.target.value)}>{visibleQuarters(index.quarters).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="students-select-control students-week-control"><label htmlFor="students-week">Неделя</label><div className="students-week-picker"><button type="button" aria-label="Предыдущая неделя" disabled={weekIndex <= 0} onClick={() => moveWeek(-1)}>‹</button><select id="students-week" aria-label="Неделя" value={activeWeek} onChange={event => setDate(event.target.value < (quarter?.startDate ?? "") ? quarter!.startDate : event.target.value)}>{weeks.map(week => <option key={week} value={week}>{weekTitle(week)}</option>)}</select><button type="button" aria-label="Следующая неделя" disabled={weekIndex < 0 || weekIndex >= weeks.length - 1} onClick={() => moveWeek(1)}>›</button></div></div>
          <button type="button" className="students-today-button" onClick={goToday}>Сегодня</button>
        </section>
        {scheduleError && <div className="students-state students-error" role="alert"><p>{scheduleError}</p><button onClick={retry}>Повторить</button></div>}
        {loading && <div className="students-state" role="status">Загружаем расписание…</div>}
        {!loading && !scheduleError && schedule && <>
          <div className="students-schedule-meta"><h2>{chosenGroupName}</h2><p>{quarter?.name} · опубликовано {new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(schedule.publication.publishedAt))}</p></div>
          {selection.date < (quarter?.startDate ?? "") || selection.date > (quarter?.endDate ?? "")
            ? <div className="students-state"><h2>Эта дата вне опубликованной четверти</h2><p>Выберите четверть, в которую входит нужная дата.</p></div>
            : !schedule.days.some(day => day.lessons.length)
              ? <div className="students-state"><h2>Для этого класса нет опубликованных занятий</h2><p>Выберите другую четверть или класс.</p></div>
            : <div className="students-days">{visibleDates.map(date => <DayCard key={date} date={date} day={daysByDate.get(date)} todayDate={today()} groupName={schedule.group.name} showIcons={showSubjectIcons === true} />)}</div>}
        </>}
      </>}
    </main>
    <footer className="students-footer">Смена · расписание школы</footer>
  </div>;
}
