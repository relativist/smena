import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { dateIso, isValidIsoDate, mondayOf, weekDatesFor } from "../shared/studentNavigation.ts";
import { chooseStudentWeekLocation, studentQuarterWeeks } from "../shared/studentQuarterNavigation.ts";
import { matchesSchoolStage, type SchoolStage } from "../shared/studentDayNavigation.ts";
import { visibleQuarters } from "../shared/plans.ts";
import type { PublicStudentsIndex, PublicStudentsWeekSchedule } from "../shared/studentTypes.ts";
import StudentsDayTable from "./StudentsDayTable";
import SmartGroupPicker from "./SmartGroupPicker";
import { useSchoolSettings } from "./SchoolSettings";

type Selection = { quarterId: string; date: string };
const stages: Array<{ id: SchoolStage; label: string }> = [
  { id: "all", label: "Вся" }, { id: "primary", label: "Начальная" },
  { id: "middle", label: "Средняя" }, { id: "high", label: "Старшая" },
];
const today = () => dateIso(new Date());
const shortDate = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`));
const dayHeading = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const weekTitle = (week: string) => { const days = weekDatesFor(week); return `${shortDate(days[0])} – ${shortDate(days[6])}`; };

export default function StudentsQuarterSchedule({ active = true }: { active?: boolean }) {
  const [index, setIndex] = useState<PublicStudentsIndex>();
  const [selection, setSelection] = useState<Selection>();
  const [stage, setStage] = useState<SchoolStage>(() => {
    const value = new URLSearchParams(window.location.search).get("school");
    return stages.find(item => item.id === value)?.id ?? "all";
  });
  const [groupFilter, setGroupFilter] = useState<string[] | null | undefined>(() => {
    const query = new URLSearchParams(window.location.search);
    const groups = query.getAll("group").filter(Boolean);
    if (groups.length) return [...new Set(groups)];
    return query.get("groups") === "all" || stages.some(item => item.id !== "all" && item.id === query.get("school")) ? null : undefined;
  });
  const [pickerReset, setPickerReset] = useState(0);
  const [data, setData] = useState<PublicStudentsWeekSchedule>();
  const [indexError, setIndexError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [loading, setLoading] = useState(true);
  const indexRequest = useRef(0);
  const selectionRef = useRef(selection);
  const refreshedPublications = useRef(new Set<string>());
  selectionRef.current = selection;
  const { studentSubjectIcons, refresh } = useSchoolSettings();

  const loadIndex = useCallback((signal?: AbortSignal, preserve?: Selection) => {
    const request = ++indexRequest.current;
    const query = new URLSearchParams(window.location.search);
    setLoading(true); setIndexError(""); setScheduleError(""); setData(undefined);
    api<PublicStudentsIndex>("/api/public/students", { signal }).then(value => {
      if (signal?.aborted || request !== indexRequest.current) return;
      const current = preserve ? selectionRef.current ?? preserve : undefined;
      const next = chooseStudentWeekLocation(value.quarters, {
        today: today(), queryQuarter: current?.quarterId ?? query.get("quarter") ?? undefined,
        queryDate: current?.date ?? query.get("week") ?? query.get("date") ?? undefined,
      });
      setIndex(value); setSelection(next);
    }).catch(reason => {
      if (!signal?.aborted && request === indexRequest.current) setIndexError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание.");
    }).finally(() => { if (!signal?.aborted && request === indexRequest.current) setLoading(false); });
  }, []);

  useEffect(() => {
    const controller = new AbortController(); loadIndex(controller.signal);
    return () => controller.abort();
  }, [loadIndex]);

  const activeWeek = selection ? mondayOf(selection.date) : "";
  const quarter = index?.quarters.find(item => item.id === selection?.quarterId);
  const availableGroups = useMemo(() => [...(quarter?.groups ?? [])].filter(group => matchesSchoolStage(group.name, stage))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id)), [quarter, stage]);
  const activeGroupIds = useMemo(() => {
    if (groupFilter === null) return null;
    const selected = availableGroups.filter(group => groupFilter?.includes(group.id)).map(group => group.id);
    return selected.length ? selected : availableGroups.slice(0, 1).map(group => group.id);
  }, [availableGroups, groupFilter]);
  useEffect(() => {
    if (!selection || !index) return;
    const controller = new AbortController();
    let refreshing = false;
    setLoading(true); setData(undefined); setScheduleError("");
    const query = new URLSearchParams({ quarterId: selection.quarterId, weekStart: activeWeek });
    api<PublicStudentsWeekSchedule>(`/api/public/students/week?${query}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const indexed = index.quarters.find(item => item.id === selection.quarterId);
      const key = `${selection.quarterId}:${value.publication.version}`;
      if (indexed && value.publication.version > indexed.publication.version && !refreshedPublications.current.has(key)) {
        refreshedPublications.current.add(key); refreshing = true; loadIndex(controller.signal, selectionRef.current ?? selection); return;
      }
      setData(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setScheduleError(reason instanceof Error ? reason.message : "Не удалось загрузить расписание.");
    }).finally(() => { if (!controller.signal.aborted && !refreshing) setLoading(false); });
    refresh();
    return () => controller.abort();
  }, [selection?.quarterId, activeWeek, index, loadIndex, refresh]);

  useEffect(() => {
    if (!selection || !active) return;
    const query = new URLSearchParams({ view: "quarter", quarter: selection.quarterId, week: mondayOf(selection.date) });
    if (stage !== "all") query.set("school", stage);
    if (activeGroupIds === null) query.set("groups", "all");
    else for (const groupId of activeGroupIds) query.append("group", groupId);
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [selection, stage, activeGroupIds, active]);

  const weeks = useMemo(() => quarter ? studentQuarterWeeks(quarter) : [], [quarter]);
  const weekIndex = weeks.indexOf(activeWeek);
  const groups = useMemo(() => [...(data?.groups ?? [])].filter(group => matchesSchoolStage(group.name, stage) && (activeGroupIds === null || activeGroupIds.includes(group.id)))
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id)), [data, stage, activeGroupIds]);
  const changeQuarter = (id: string) => {
    if (!index || id === selection?.quarterId) return;
    setData(undefined);
    setSelection(chooseStudentWeekLocation(index.quarters, { today: today(), queryQuarter: id }));
  };
  const chooseWeek = (date: string) => {
    if (!selection || !quarter || !isValidIsoDate(date) || !weeks.includes(mondayOf(date)) || mondayOf(date) === activeWeek) return;
    setData(undefined);
    setSelection({ ...selection, date: date < quarter.startDate ? quarter.startDate : date > quarter.endDate ? quarter.endDate : date });
  };
  const goToday = () => {
    if (!index) return;
    const next = chooseStudentWeekLocation(index.quarters, { today: today() });
    if (next && (next.quarterId !== selection?.quarterId || mondayOf(next.date) !== activeWeek)) { setData(undefined); setSelection(next); }
  };
  const retry = () => loadIndex(undefined, selection);

  return <>
      <section className="students-controls students-quarter-controls" aria-label="Выбор расписания" aria-busy={loading && !selection}>
        <div className="students-school-control"><span>Школа</span><div className="students-school-options" role="group" aria-label="Ступень школы">{stages.map(item => <button key={item.id} type="button" aria-pressed={stage === item.id} onClick={() => { setStage(item.id); setGroupFilter(null); setPickerReset(value => value + 1); }}>{item.label}</button>)}</div></div>
        <SmartGroupPicker groups={availableGroups} selected={activeGroupIds} onChange={setGroupFilter} resetKey={`${quarter?.id ?? ""}:${stage}:${pickerReset}`} disabled={!quarter} />
        <label className="students-select-control">Четверть<select aria-label="Четверть" value={quarter?.id ?? ""} disabled={!selection} onChange={event => changeQuarter(event.target.value)}>{!selection && <option value="">{loading ? "Загрузка…" : "Нет четвертей"}</option>}{visibleQuarters(index?.quarters ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="students-select-control students-week-control"><label htmlFor="students-week">Неделя</label><div className="students-week-picker">
          <button type="button" aria-label="Предыдущая неделя" disabled={weekIndex <= 0} onClick={() => chooseWeek(weeks[weekIndex - 1])}>‹</button>
          <select id="students-week" aria-label="Неделя" value={activeWeek} disabled={!selection} onChange={event => chooseWeek(event.target.value)}>{!selection && <option value="">{loading ? "Загрузка…" : "Нет недель"}</option>}{[...weeks].reverse().map(week => <option key={week} value={week}>{weekTitle(week)}</option>)}</select>
          <button type="button" aria-label="Следующая неделя" disabled={weekIndex < 0 || weekIndex >= weeks.length - 1} onClick={() => chooseWeek(weeks[weekIndex + 1])}>›</button>
        </div></div>
        <button type="button" className="students-today-button" disabled={!index} onClick={goToday}>Сегодня</button>
      </section>
    {indexError && <div className="students-state students-error" role="alert"><p>{indexError}</p><button onClick={retry}>Повторить</button></div>}
    {!indexError && loading && !selection && <div className="students-state" role="status">Загружаем опубликованное расписание…</div>}
    {!indexError && !loading && index?.quarters.length === 0 && <div className="students-state"><h2>Расписание ещё не опубликовано</h2><p>Когда школа опубликует расписание, оно появится здесь.</p></div>}
    {selection && index && <>
      {scheduleError && <div className="students-state students-error" role="alert"><p>{scheduleError}</p><button onClick={retry}>Повторить</button></div>}
      {loading && <div className="students-state" role="status">Загружаем расписание…</div>}
      {!loading && !scheduleError && data && (!groups.length
        ? <div className="students-state"><h2>Нет классов выбранной ступени</h2><p>Выберите другую ступень школы или четверть.</p></div>
        : <div className="students-quarter-groups">{groups.map(group => {
          const days = new Map(group.days.map(day => [day.date, day]));
          const visibleDates = weekDatesFor(data.weekStart).filter(date => {
            if (date < data.quarter.startDate || date > data.quarter.endDate) return false;
            const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
            return (weekday >= 1 && weekday <= 5) || Boolean(days.get(date)?.lessons.length);
          });
          const columns = visibleDates.map(date => ({
            id: date, name: dayHeading.format(new Date(`${date}T12:00:00`)),
            day: days.get(date), isToday: date === today(),
          }));
          return <section className="students-quarter-group" key={group.id} aria-label={`Класс ${group.name}`}>
            <div className="students-schedule-meta"><h2 className="school-code">{group.name}</h2></div>
            {columns.length ? <StudentsDayTable groups={columns} showIcons={studentSubjectIcons === true} ariaLabel={`Расписание класса ${group.name}`} />
              : <div className="students-state">На этой неделе занятий нет.</div>}
          </section>;
        })}</div>)}
    </>}
  </>;
}
