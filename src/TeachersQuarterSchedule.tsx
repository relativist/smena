import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { dateIso, isValidIsoDate, mondayOf, TEACHER_STORAGE_KEY, weekDatesFor, chooseTeacherLocation } from "../shared/teacherNavigation.ts";
import { studentQuarterWeeks } from "../shared/studentQuarterNavigation.ts";
import { visibleQuarters } from "../shared/plans.ts";
import type { PublicTeacher, PublicTeachersIndex, PublicTeachersWeekSchedule } from "../shared/teacherTypes.ts";
import { teacherInitials } from "../shared/catalog.ts";
import TeachersScheduleTable from "./TeachersScheduleTable";
import TeacherPicker from "./TeacherPicker";
import { useSchoolSettings } from "./SchoolSettings";

type Selection = { quarterId: string; date: string };
const today = () => dateIso(new Date());
const shortDate = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`));
const dayHeading = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const weekTitle = (week: string) => { const days = weekDatesFor(week); return `${shortDate(days[0])} – ${shortDate(days[6])}`; };
const teacherSort = (a: PublicTeacher, b: PublicTeacher) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);

export default function TeachersQuarterSchedule({ active = true }: { active?: boolean }) {
  const initialQuery = useRef(new URLSearchParams(window.location.search));
  const [index, setIndex] = useState<PublicTeachersIndex>();
  const [selection, setSelection] = useState<Selection>();
  const [teacherFilter, setTeacherFilter] = useState<string[] | null>(() => {
    if (initialQuery.current.get("teachers") === "all") return null;
    const ids = [...new Set(initialQuery.current.getAll("teacher").filter(Boolean))];
    return ids.length ? ids : [];
  });
  const [data, setData] = useState<PublicTeachersWeekSchedule>();
  const [indexError, setIndexError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [loading, setLoading] = useState(true);
  const indexRequest = useRef(0);
  const selectionRef = useRef(selection);
  const refreshedPublications = useRef(new Set<string>());
  selectionRef.current = selection;
  const { refresh } = useSchoolSettings();

  const loadIndex = useCallback((signal?: AbortSignal, preserve?: Selection) => {
    const request = ++indexRequest.current;
    const query = initialQuery.current;
    setLoading(true); setIndexError(""); setScheduleError(""); setData(undefined);
    api<PublicTeachersIndex>("/api/public/teachers", { signal }).then(value => {
      if (signal?.aborted || request !== indexRequest.current) return;
      setIndex(value);
      let storedTeacher: string | undefined;
      try { storedTeacher = localStorage.getItem(TEACHER_STORAGE_KEY) ?? undefined; } catch { /* storage may be disabled */ }
      const previous = preserve ? selectionRef.current ?? preserve : undefined;
      const teacherIds = query.getAll("teacher").filter(id => value.quarters.some(q => q.teachers.some(t => t.id === id)));
      const queryTeacher = previous ? undefined : teacherIds[0] ?? query.get("teacher") ?? undefined;
      const nextLocation = chooseTeacherLocation(value, {
        today: today(), queryTeacher: previous ? undefined : queryTeacher,
        queryQuarter: previous?.quarterId ?? query.get("quarter") ?? undefined,
        queryDate: previous?.date ?? query.get("week") ?? query.get("date") ?? undefined,
        storedTeacher: previous ? undefined : storedTeacher,
      });
      const next = previous
        ? { quarterId: nextLocation?.quarterId ?? previous.quarterId, date: nextLocation?.date ?? previous.date }
        : nextLocation ? { quarterId: nextLocation.quarterId, date: nextLocation.date } : undefined;
      setSelection(next);
      if (!preserve && !query.has("teacher") && query.get("teachers") !== "all" && query.get("teachers") !== "none") {
        const quarter = value.quarters.find(item => item.id === next?.quarterId);
        const preferred = storedTeacher && quarter?.teachers.some(teacher => teacher.id === storedTeacher)
          ? storedTeacher : quarter?.teachers[0]?.id;
        setTeacherFilter(preferred ? [preferred] : []);
      } else if (!preserve && query.get("teachers") !== "all" && query.get("teachers") !== "none") {
        const ids = query.getAll("teacher").filter(id => value.quarters.some(q => q.id === next?.quarterId && q.teachers.some(t => t.id === id)));
        const fallback = value.quarters.find(q => q.id === next?.quarterId)?.teachers[0]?.id;
        setTeacherFilter(ids.length ? ids : fallback ? [fallback] : []);
      }
    }).catch(reason => {
      if (!signal?.aborted && request === indexRequest.current) setIndexError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание.");
    }).finally(() => { if (!signal?.aborted && request === indexRequest.current) setLoading(false); });
  }, []);

  useEffect(() => { const controller = new AbortController(); loadIndex(controller.signal); return () => controller.abort(); }, [loadIndex]);

  const activeWeek = selection ? mondayOf(selection.date) : "";
  const quarter = index?.quarters.find(item => item.id === selection?.quarterId);
  const teachers = useMemo(() => [...(quarter?.teachers ?? [])].sort(teacherSort), [quarter]);
  const activeTeacherIds = useMemo(() => {
    if (teacherFilter === null) return null;
    return teachers.filter(teacher => teacherFilter.includes(teacher.id)).map(teacher => teacher.id);
  }, [teachers, teacherFilter]);

  useEffect(() => {
    if (!selection || !index) return;
    const controller = new AbortController();
    let refreshing = false;
    setLoading(true); setData(undefined); setScheduleError("");
    const query = new URLSearchParams({ quarterId: selection.quarterId, weekStart: activeWeek });
    api<PublicTeachersWeekSchedule>(`/api/public/teachers/week?${query}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const indexed = index.quarters.find(item => item.id === selection.quarterId);
      const key = `${selection.quarterId}:${value.publication.version}`;
      if (indexed && value.publication.version > indexed.publication.version && !refreshedPublications.current.has(key)) {
        refreshedPublications.current.add(key); refreshing = true; loadIndex(controller.signal, selection); return;
      }
      setData(value);
    }).catch(reason => { if (!controller.signal.aborted) setScheduleError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание."); })
      .finally(() => { if (!controller.signal.aborted && !refreshing) setLoading(false); });
    refresh();
    return () => controller.abort();
  }, [selection?.quarterId, activeWeek, index, loadIndex, refresh]);

  useEffect(() => {
    if (!selection || !active) return;
    const query = new URLSearchParams({ view: "quarter", quarter: selection.quarterId, week: activeWeek });
    if (activeTeacherIds === null) query.set("teachers", "all");
    else if (!activeTeacherIds.length) query.set("teachers", "none");
    else for (const id of activeTeacherIds) query.append("teacher", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [selection, activeWeek, activeTeacherIds, active]);

  useEffect(() => {
    if (!selection || activeTeacherIds === null || activeTeacherIds.length !== 1) return;
    try { localStorage.setItem(TEACHER_STORAGE_KEY, activeTeacherIds[0]!); } catch { /* storage may be disabled */ }
  }, [selection?.quarterId, activeTeacherIds]);

  const weeks = useMemo(() => quarter ? studentQuarterWeeks(quarter) : [], [quarter]);
  const weekIndex = weeks.indexOf(activeWeek);
  const selectedTeachers = teachers.filter(teacher => activeTeacherIds === null || activeTeacherIds.includes(teacher.id));
  const changeQuarter = (id: string) => {
    if (!index || id === selection?.quarterId) return;
    setData(undefined);
    const next = chooseTeacherLocation(index, { today: today(), queryQuarter: id });
    if (next) setSelection({ quarterId: next.quarterId, date: next.date });
    const nextTeachers = index.quarters.find(item => item.id === id)?.teachers ?? [];
    if (teacherFilter === null) return;
    const retained = teacherFilter.filter(teacherId => nextTeachers.some(teacher => teacher.id === teacherId));
    setTeacherFilter(retained.length ? retained : nextTeachers.slice(0, 1).map(teacher => teacher.id));
  };
  const chooseWeek = (date: string) => {
    if (!selection || !quarter || !isValidIsoDate(date) || !weeks.includes(mondayOf(date)) || mondayOf(date) === activeWeek) return;
    setData(undefined);
    setSelection({ ...selection, date: date < quarter.startDate ? quarter.startDate : date > quarter.endDate ? quarter.endDate : date });
  };
  const goToday = () => {
    if (!index) return;
    const ids = activeTeacherIds === null ? teachers.map(teacher => teacher.id) : activeTeacherIds;
    const candidates = (ids.length ? ids : teachers.slice(0, 1).map(teacher => teacher.id))
      .map(id => chooseTeacherLocation(index, { today: today(), queryTeacher: id }))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const now = today();
    const next = candidates.sort((a, b) => Math.abs(Date.parse(`${a.date}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) - Math.abs(Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) || a.date.localeCompare(b.date))[0];
    if (next && (next.quarterId !== selection?.quarterId || mondayOf(next.date) !== activeWeek)) {
      if (next.quarterId !== selection?.quarterId && teacherFilter !== null) {
        const nextTeachers = index.quarters.find(item => item.id === next.quarterId)?.teachers ?? [];
        const retained = teacherFilter.filter(id => nextTeachers.some(teacher => teacher.id === id));
        if (!retained.length) setTeacherFilter(nextTeachers.slice(0, 1).map(teacher => teacher.id));
      }
      setData(undefined); setSelection({ quarterId: next.quarterId, date: next.date });
    }
  };
  const retry = () => loadIndex(undefined, selection);
  const columns = useMemo(() => {
    const daysByTeacher = new Map((data?.teachers ?? []).map(item => [item.id, item.days]));
    return selectedTeachers.map(teacher => {
      const dayByDate = new Map((daysByTeacher.get(teacher.id) ?? []).map(day => [day.date, day]));
      const visibleDates = weekDatesFor(data?.weekStart ?? activeWeek).filter(date => {
        if (date < (data?.quarter.startDate ?? quarter?.startDate ?? "") || date > (data?.quarter.endDate ?? quarter?.endDate ?? "")) return false;
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        return (weekday >= 1 && weekday <= 5) || Boolean(dayByDate.get(date)?.lessons.length);
      });
      return {
        id: teacher.id,
        name: teacher.name,
        days: visibleDates.map(date => ({ id: date, name: dayHeading.format(new Date(`${date}T12:00:00`)), day: dayByDate.get(date), isToday: date === today() })),
      };
    });
  }, [data, selectedTeachers, activeWeek, quarter]);

  return <>
    <section className="teachers-controls teachers-quarter-controls" aria-label="Выбор расписания" aria-busy={loading && !selection}>
      <TeacherPicker teachers={teachers} selected={activeTeacherIds} onChange={setTeacherFilter} resetKey={quarter?.id ?? ""} disabled={!quarter} />
      <label className="teachers-quarter-control">Четверть<select aria-label="Четверть" value={quarter?.id ?? ""} disabled={!selection} onChange={event => changeQuarter(event.target.value)}>{!selection && <option value="">{loading ? "Загрузка…" : "Нет четвертей"}</option>}{visibleQuarters(index?.quarters ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="teachers-week-control"><label htmlFor="teachers-quarter-week">Неделя</label><div className="teachers-week-picker"><button type="button" aria-label="Предыдущая неделя" disabled={weekIndex <= 0} onClick={() => chooseWeek(weeks[weekIndex - 1]!)}>‹</button><select id="teachers-quarter-week" aria-label="Неделя" value={activeWeek} disabled={!selection} onChange={event => chooseWeek(event.target.value)}>{!selection && <option value="">{loading ? "Загрузка…" : "Нет недель"}</option>}{[...weeks].reverse().map(week => <option key={week} value={week}>{weekTitle(week)}</option>)}</select><button type="button" aria-label="Следующая неделя" disabled={weekIndex < 0 || weekIndex >= weeks.length - 1} onClick={() => chooseWeek(weeks[weekIndex + 1]!)}>›</button></div></div>
      <button type="button" className="teachers-today-button" disabled={!index} onClick={goToday}>Сегодня</button>
    </section>
    {indexError && <div className="teachers-state teachers-error" role="alert"><p>{indexError}</p><button onClick={retry}>Повторить</button></div>}
    {!indexError && loading && !selection && <div className="teachers-state" role="status">Загружаем опубликованное расписание…</div>}
    {!indexError && !loading && index?.quarters.length === 0 && <div className="teachers-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>}
    {!indexError && !loading && Boolean(index?.quarters.length) && !selection && <div className="teachers-state"><h2>В опубликованном расписании нет преподавателей</h2><p>После публикации расписания с преподавателями они появятся в списке.</p></div>}
    {selection && index && <>
      {scheduleError && <div className="teachers-state teachers-error" role="alert"><p>{scheduleError}</p><button onClick={retry}>Повторить</button></div>}
      {loading && <div className="teachers-state" role="status">Загружаем расписание…</div>}
      {!loading && !scheduleError && data && (!selectedTeachers.length
          ? <div className="teachers-state"><h2>Преподаватели не выбраны</h2><p>Выберите преподавателей в фильтре.</p></div>
          : <><div className="teachers-shift-legend" aria-label="Смены"><span className="teachers-shift-morning">№ · 1-я смена</span><span className="teachers-shift-afternoon">№ · 2-я смена</span></div><div className="teachers-quarter-groups">{columns.map(item => <section className="teachers-quarter-group" key={item.id} aria-label={`Расписание: ${item.name}`}>
          <div className="teachers-schedule-meta"><h2 title={item.name}>{teacherInitials(item.name)}</h2></div>
          {item.days.length ? <TeachersScheduleTable columns={item.days} ariaLabel={`Расписание преподавателя ${item.name}`} centered /> : <div className="teachers-state">На этой неделе занятий нет.</div>}
        </section>)}</div></>)}
    </>}
  </>;
}
