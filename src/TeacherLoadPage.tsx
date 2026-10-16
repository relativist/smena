import AdminPageHeader from "./AdminPageHeader";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts";
import { summarizeTeacherLoad, type TeacherLoadRow, type TeacherLoadSummary } from "../shared/teacherLoad.ts";
import { teacherLoadMonth, loadPercent, WEEKLY_LOAD_TARGET } from "../shared/teacherLoadPeriods.ts";
import type { TeacherLoadSummaryResponse, TeacherLoadPeriod } from "../server/teacherLoadApi.ts";
import { MonthYearPicker } from "./MonthYearPicker";
import { weekDatesFor } from "../shared/studentNavigation.ts";
import "./teacher-load.css";

type Props = { initialState: StateResponse; auth: AuthSession; onUnauthorized: () => void; onBack: () => Promise<void>; initialQuarterId?: string };
type Source = "draft" | "published";
type SortKey = "name" | "month" | `week:${string}`;
type DetailPeriod = { start: string; end: string; target: number; studyDays: number; incomplete: boolean; nonStudyLabel?: string };
type DetailWeek = TeacherLoadPeriod;
type Selection = { row: TeacherLoadRow; period: DetailPeriod; weeks: DetailWeek[] };

const today = () => new Date().toLocaleDateString("sv-SE");
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const monthLabel = (month: string) => {
  const label = dateLabel(`${month}-15`, { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const periodTitle = (start: string, end: string) => `${dateLabel(start)} – ${dateLabel(end, { day: "numeric", month: "short", year: "numeric" })}`;
const number = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
const loadTone = (percent: number | null) => percent === null ? "teacher-load-unavailable" : percent < 50 ? "teacher-load-red" : percent < 80 ? "teacher-load-yellow" : percent < 100 ? "teacher-load-blue" : "teacher-load-green";
const lessonWord = (count: number) => !Number.isInteger(count) ? "урока" : count % 100 >= 11 && count % 100 <= 14 ? "уроков" : count % 10 === 1 ? "урок" : count % 10 >= 2 && count % 10 <= 4 ? "урока" : "уроков";
const eventWord = (count: number) => count % 100 >= 11 && count % 100 <= 14 ? "мероприятий" : count % 10 === 1 ? "мероприятие" : count % 10 >= 2 && count % 10 <= 4 ? "мероприятия" : "мероприятий";
const sortText = (a: string, b: string) => a.localeCompare(b, "ru", { numeric: true, sensitivity: "base" });
function calculationTitle(period: DetailPeriod) {
  if (period.incomplete) return "Нет полной публикации за этот период: сумма неполная, процент не рассчитывается.";
  if (period.nonStudyLabel) return `${period.nonStudyLabel}. В общем календаре школы нет учебных дней в этом периоде; процент не рассчитывается.`;
  if (period.target <= 0) return "В этом периоде нет учебных дней по общему календарю школы: процент не рассчитывается.";
  return `100% = ${number(period.target)} ${lessonWord(period.target)}; учебных дней: ${period.studyDays}. Ориентир ${WEEKLY_LOAD_TARGET} уроков за полную учебную неделю, с учётом общих каникул и границ месяца/четвертей.`;
}

function LoadMetric({ summary, period, onClick, label }: { summary: TeacherLoadSummary; period: DetailPeriod; onClick: () => void; label: string }) {
  const percent = period.incomplete ? null : loadPercent(summary.lessons, period.target);
  if (!period.incomplete && period.nonStudyLabel && summary.lessons === 0) {
    return <button type="button" className="teacher-load-non-study" title={calculationTitle(period)} aria-label={`${label}: ${period.nonStudyLabel}`} onClick={onClick}>
      <span>{period.nonStudyLabel}</span>
      {summary.events > 0 && <small>+ {summary.events} мер.</small>}
    </button>;
  }
  return <button type="button" className={`teacher-load-metric ${loadTone(percent)}${percent !== null && percent > 100 ? " teacher-load-extra" : ""}`} title={calculationTitle(period)} aria-label={`${label}: ${summary.lessons} уроков, ${percent === null ? "процент не рассчитан" : `${number(percent)}%`}`} onClick={onClick}>
    <span className="teacher-load-metric-top">{summary.lessons}</span>
    <span className="teacher-load-percent">{percent === null ? "—" : `${number(percent)}%`}</span>
    {percent !== null && <span className="teacher-load-bar" aria-hidden="true"><i style={{ width: `${Math.min(percent, 100)}%` }} /></span>}
    {summary.events > 0 && <span className="teacher-load-events">+ {summary.events} мер.</span>}
    {period.incomplete && <span className="teacher-load-incomplete">Неполные данные</span>}
  </button>;
}

function TeacherDetails({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { row, period, weeks } = selection;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const lessons = row.lessons.filter(lesson => lesson.date >= period.start && lesson.date <= period.end);
  const summary = summarizeTeacherLoad(row.lessons, period.start, period.end);
  const noStudyLessons = !period.incomplete && !!period.nonStudyLabel && summary.lessons === 0;
  const percent = period.incomplete ? null : loadPercent(summary.lessons, period.target);
  const groupMap = new Map<string, { id: string; name: string; lessons: number }>();
  for (const lesson of lessons) {
    if (lesson.isEvent) continue;
    const participants = new Map(lesson.participants.map(group => [group.id, group]));
    for (const group of participants.values()) {
      const existing = groupMap.get(group.id);
      if (existing) existing.lessons += 1;
      else groupMap.set(group.id, { id: group.id, name: group.name, lessons: 1 });
    }
  }
  const groups = [...groupMap.values()].sort((a, b) => sortText(a.name, b.name));
  return <dialog ref={dialogRef} className="teacher-load-dialog" aria-labelledby="teacher-load-detail-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="teacher-load-dialog-header"><div><p>Нагрузка учителя</p><h2 id="teacher-load-detail-title">{row.name}</h2></div><button type="button" aria-label="Закрыть" onClick={onClose}>×</button></header>
    <p className="teacher-load-detail-period">{periodTitle(period.start, period.end)}</p>
    {!noStudyLessons && <div className="teacher-load-detail-summary"><span><strong>{summary.lessons}</strong> {lessonWord(summary.lessons)}</span><span className={`teacher-load-detail-percent ${loadTone(percent)}${percent !== null && percent > 100 ? " teacher-load-extra" : ""}`} title={calculationTitle(period)}><strong>{percent === null ? "—" : `${number(percent)}%`}</strong> нагрузки</span><span><strong>{summary.events}</strong> {eventWord(summary.events)}</span><span><strong>{summary.minutes}</strong> мин уроков</span></div>}
    <p className="teacher-load-detail-calculation">{calculationTitle(period)}</p>
    {(groups.length > 0 || !noStudyLessons) && <section className="teacher-load-detail-groups" aria-label="Группы за выбранный период">
      <h3>Группы за выбранный период{period.incomplete ? " · доступная часть публикации" : ""}</h3>
      {groups.length ? <ul className="teacher-load-group-list">{groups.map(group => <li key={group.id}>
        <strong>{group.name}</strong><span>{group.lessons} {lessonWord(group.lessons)}</span>
      </li>)}</ul> : <p>Нет групп с уроками за этот период.</p>}
    </section>}
    {!lessons.length && !noStudyLessons && <p className="teacher-load-empty-detail">{period.incomplete ? "В доступной части публикации занятий нет." : "За выбранный период занятий нет."}</p>}
    <div className="teacher-load-week-scroll" tabIndex={0} role="region" aria-label="Занятия по неделям">
      <table className="teacher-load-week-grid">
        <caption className="teacher-load-grid-caption">Занятия за {periodTitle(period.start, period.end)}</caption>
        <thead><tr><th scope="col">Неделя</th>{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day, index) => <th key={day} scope="col" className={index >= 5 ? "is-weekend" : ""}>{day}</th>)}</tr></thead>
        <tbody>{weeks.map(week => <tr key={week.id}>
          <th scope="row" className="teacher-load-grid-week" title={periodTitle(week.fullStart, week.fullEnd)}>
            <strong>{dateLabel(week.start)}<br />– {dateLabel(week.end)}</strong>
            {week.incomplete ? <small>Неполные данные</small> : week.nonStudyLabel ? <small>{week.nonStudyLabel}</small> : null}
          </th>
          {weekDatesFor(week.fullStart).map((date, index) => {
            const outside = date < period.start || date > period.end;
            const dayLessons = outside ? [] : lessons.filter(lesson => lesson.date === date);
            return <td key={date} data-date={date} className={`${index >= 5 ? "is-weekend" : ""}${outside ? " is-outside" : ""}`} title={outside ? "Вне выбранного периода" : undefined}>
              <time className="teacher-load-grid-date" dateTime={date}>{dateLabel(date, { day: "2-digit", month: "2-digit" })}</time>
              {dayLessons.length ? dayLessons.map(lesson => <article className="teacher-load-grid-lesson" key={`${lesson.id}:${lesson.start}`}>
                <div className="teacher-load-grid-lesson-title"><time>{clock(lesson.start)}</time><strong title={lesson.subject} aria-label={lesson.subject}>{lesson.shortSubject}</strong></div>
                <div className="teacher-load-grid-lesson-meta"><span className="school-code">{lesson.participants.map(participant => participant.subgroup ? participant.subgroup.startsWith(participant.name) ? participant.subgroup : `${participant.name}/${participant.subgroup}` : participant.name).join(", ")}</span>{lesson.room && <span className="teacher-load-grid-room">{lesson.room}</span>}</div>
              </article>) : <span className="teacher-load-grid-empty" aria-label={outside ? "Вне выбранного периода" : week.incomplete ? "В доступных данных занятий нет" : "Занятий нет"}>—</span>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <footer className="teacher-load-dialog-footer"><button type="button" onClick={onClose}>Закрыть</button></footer>
  </dialog>;
}

export default function TeacherLoadPage({ initialState, onUnauthorized, onBack, initialQuarterId }: Props) {
  const [source, setSource] = useState<Source>("draft");
  const [month, setMonth] = useState(() => {
    const current = today();
    const quarter = initialState.quarters.find(item => item.id === initialQuarterId);
    const anchor = quarter && (current < quarter.startDate || current > quarter.endDate) ? current < quarter.startDate ? quarter.startDate : quarter.endDate : current;
    return anchor.slice(0, 7);
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: "name", direction: 1 });
  const [loaded, setLoaded] = useState<TeacherLoadSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    document.body.classList.add("teacher-load-view");
    return () => document.body.classList.remove("teacher-load-view");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestRef.current;
    setLoading(true); setError(""); setLoaded(null);
    api<TeacherLoadSummaryResponse>(`/api/teacher-load?source=${source}&month=${encodeURIComponent(month)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && requestId === requestRef.current) setLoaded(result);
    }).catch(reason => {
      if (controller.signal.aborted || requestId !== requestRef.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить нагрузку учителей.");
    }).finally(() => { if (!controller.signal.aborted && requestId === requestRef.current) { setLoading(false); setRefreshing(false); } });
    return () => controller.abort();
  }, [source, month, onUnauthorized, refreshVersion]);
  useEffect(() => {
    detailRequestRef.current += 1;
    setSelection(null);
    setDetailsLoading(false);
  }, [source, month]);
  useEffect(() => () => { detailRequestRef.current += 1; }, []);
  const refresh = async () => {
    setRefreshing(true);
    setLoading(true);
    setLoaded(null);
    setRefreshVersion(value => value + 1);
  };

  const bounds = useMemo(() => teacherLoadMonth(month, []), [month]);
  const relevantQuarters = initialState.quarters.filter(quarter => quarter.startDate <= bounds.end && quarter.endDate >= bounds.start);
  const localPeriods = teacherLoadMonth(month, initialState.quarters.map(quarter => ({ quarter, calendar: initialState.calendar })));
  const periods: TeacherLoadSummaryResponse["periods"] = loaded?.periods ?? { ...localPeriods, weeks: localPeriods.weeks.map(week => ({ ...week, incomplete: false })) };
  const incomplete = (start: string, end: string) => source === "published" && Boolean(loaded?.missingQuarters.some(item => {
    const quarter = initialState.quarters.find(entry => entry.id === item.id);
    return quarter && quarter.startDate <= end && quarter.endDate >= start;
  }));
  const monthPeriod: DetailPeriod = { start: periods.start, end: periods.end, target: periods.target, studyDays: periods.studyDays, incomplete: incomplete(periods.start, periods.end), nonStudyLabel: periods.nonStudyLabel };
  const weekPeriod = (week: TeacherLoadPeriod): DetailWeek => week;
  const rows = loaded?.rows ?? [];
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru");
    const result = rows.filter(row => (!row.archived || row.month.lessons > 0 || row.weeks.some(week => week.lessons > 0)) && (!query || row.name.toLocaleLowerCase("ru").includes(query))).map(row => ({
      row: { id: row.id, name: row.name, archived: row.archived, lessons: [] }, month: row.month, weeks: row.weeks,
    }));
    const index = periods.weeks.findIndex(week => `week:${week.id}` === sort.key);
    result.sort((a, b) => sort.key === "name" || (sort.key.startsWith("week:") && index < 0) ? sortText(a.row.name, b.row.name) * (sort.key === "name" ? sort.direction : 1)
      : ((sort.key === "month" ? a.month.lessons - b.month.lessons : a.weeks[index]!.lessons - b.weeks[index]!.lessons) * sort.direction || sortText(a.row.name, b.row.name)));
    return result;
  }, [rows, periods.weeks, search, sort]);
  const changeSort = (key: SortKey) => setSort(current => current.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: key === "name" ? 1 : -1 });
  const sortLabel = (key: SortKey, text: string) => <button type="button" className="teacher-load-sort" onClick={() => changeSort(key)}>{text}{sort.key === key && <span aria-hidden="true">{sort.direction === 1 ? " ↑" : " ↓"}</span>}</button>;
  const sortState = (key: SortKey) => sort.key === key ? sort.direction === 1 ? "ascending" as const : "descending" as const : "none" as const;
  const back = async () => { setBackBusy(true); try { await onBack(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось вернуться к расписанию."); } finally { setBackBusy(false); } };
  const openDetails = async (row: Pick<TeacherLoadRow, "id" | "name" | "archived">, period: DetailPeriod, weeks: DetailWeek[]) => {
    const id = ++detailRequestRef.current;
    setDetailsLoading(true);
    try {
      const params = new URLSearchParams({ source, month, teacherId: row.id, startDate: period.start, endDate: period.end });
      const response = await api<{ teacher: TeacherLoadRow | null }>(`/api/teacher-load/details?${params}`);
      if (id !== detailRequestRef.current) return;
      setSelection({ row: response.teacher ?? { ...row, lessons: [] }, period, weeks });
    } catch (reason) {
      if (id !== detailRequestRef.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить уроки учителя.");
    } finally { if (id === detailRequestRef.current) setDetailsLoading(false); }
  };

  useLayoutEffect(() => {
    const wrapper = tableWrapRef.current;
    if (!wrapper) return;
    const measure = () => {
      const top = wrapper.getBoundingClientRect().top;
      const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 0;
      const bottomPadding = mainRef.current ? parseFloat(getComputedStyle(mainRef.current).paddingBottom) || 0 : 0;
      const remaining = window.innerHeight - top - footerHeight - 14 - bottomPadding;
      wrapper.style.maxHeight = `${Math.max(220, Math.floor(remaining))}px`;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (mainRef.current) observer?.observe(mainRef.current);
    if (footerRef.current) observer?.observe(footerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visibleRows, loaded, loading, error, source, month, search]);

  return <div className="teacher-load-page">
    <AdminPageHeader title="Нагрузка учителей" onBack={() => void back()} busy={backBusy} />
    <main ref={mainRef} className="teacher-load-main">
      <section className="teacher-load-controls" aria-label="Фильтры нагрузки">
        <label className="teacher-load-source">Данные<select aria-label="Данные" value={source} onChange={event => { setSource(event.target.value as Source); setError(""); setSelection(null); }}><option value="draft">Черновик</option><option value="published">Опубликованное расписание</option></select></label>
        <MonthYearPicker value={month} onChange={next => { if (next === month) return; setMonth(next); setSelection(null); if (sort.key.startsWith("week:")) setSort({ key: "name", direction: 1 }); }} />
        <label className="teacher-load-search">Поиск учителя<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Фамилия или имя" /></label>
        <button type="button" className="teacher-load-refresh" onClick={() => void refresh()} disabled={refreshing || loading}>{refreshing || loading ? "Обновляем…" : "Обновить"}</button>
      </section>
      <div className="teacher-load-periods"><strong>{monthLabel(month)}</strong><span>{periodTitle(periods.start, periods.end)}</span></div>
      {source === "published" && loaded?.publications.length ? <p className="teacher-load-publication-meta">{loaded.publications.map(item => `${item.quarterName} · версия ${item.version} · ${dateLabel(item.publishedAt.slice(0, 10), { day: "numeric", month: "short", year: "numeric" })}`).join("; ")}</p> : null}
      {error && <div className="teacher-load-message is-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Повторить</button></div>}
      {source === "published" && loaded && loaded.missingQuarters.length > 0 && <div className="teacher-load-message is-warning" role="status">Нет публикации для четвертей: {loaded.missingQuarters.map(quarter => quarter.name).join(", ")}. Суммы за затронутые периоды неполные; проценты не рассчитаны.</div>}
      {source === "published" && !relevantQuarters.length && <div className="teacher-load-message" role="status">Выбранный месяц не пересекается с учебными четвертями.</div>}
      {loading && <div className="teacher-load-loading" role="status">Загружаем нагрузку учителей…</div>}
      {source === "published" && !loading && loaded && !loaded.publications.length && !error && relevantQuarters.length > 0 && <div className="teacher-load-message">Для выбранного месяца пока нет публикации.</div>}
      {loaded && <div ref={tableWrapRef} className="teacher-load-table-wrap" aria-busy={refreshing}>
        <table className="teacher-load-table" style={{ minWidth: 270 + periods.weeks.length * 130 + 160 }}><thead><tr>
          <th scope="col" aria-sort={sortState("name")}>{sortLabel("name", "Учитель")}</th>
          {periods.weeks.map(week => <th key={week.id} scope="col" aria-sort={sortState(`week:${week.id}`)} title={calculationTitle(weekPeriod(week))}>
            {sortLabel(`week:${week.id}`, `${dateLabel(week.start, { day: "numeric" })}–${dateLabel(week.end)}`)}
            {!weekPeriod(week).incomplete && week.nonStudyLabel && <small>{week.nonStudyLabel}</small>}
          </th>)}
          <th scope="col" className="teacher-load-month-total" aria-sort={sortState("month")} title={calculationTitle(monthPeriod)}>{sortLabel("month", "Итого за месяц")}<small>{monthPeriod.incomplete ? "Неполные данные" : periods.target > 0 ? `${number(periods.target)} ${lessonWord(periods.target)} = 100%` : "Нет учебных дней"}</small></th>
        </tr></thead><tbody>{visibleRows.map(({ row, weeks, month: monthSummary }) => <tr key={row.id} className={row.archived ? "is-archived" : ""}>
          <th scope="row"><button type="button" className="teacher-load-name" onClick={() => void openDetails(row, monthPeriod, periods.weeks.map(weekPeriod))}>{row.name}{row.archived && <small>Архив</small>}</button></th>
          {periods.weeks.map((week, index) => <td key={week.id}><LoadMetric summary={weeks[index]!} period={weekPeriod(week)} label={`${row.name}, ${periodTitle(week.start, week.end)}`} onClick={() => void openDetails(row, weekPeriod(week), [weekPeriod(week)])} /></td>)}
          <td className="teacher-load-month-total"><LoadMetric summary={monthSummary} period={monthPeriod} label={`${row.name}, ${monthLabel(month)}`} onClick={() => void openDetails(row, monthPeriod, periods.weeks.map(weekPeriod))} /></td>
        </tr>)}</tbody></table>
        {!visibleRows.length && <p className="teacher-load-no-rows">Учителя не найдены.</p>}
      </div>}
      <footer ref={footerRef} className="teacher-load-footer">
        <p className="teacher-load-footnote">В крайних неделях считаются только даты выбранного месяца. Месячный ориентир — сумма недельных; наведите на число для объяснения расчёта.</p>
        <div className="teacher-load-color-legend" aria-label="Цвета нагрузки">
          <span className="teacher-load-red">Менее 50%</span><span className="teacher-load-yellow">50–79,9%</span><span className="teacher-load-blue">80–99,9%</span><span className="teacher-load-green">100% и выше</span>
          <span className="teacher-load-info">
            <button type="button" aria-label="Как рассчитывается нагрузка" aria-describedby="teacher-load-calculation-hint">i</button>
            <span id="teacher-load-calculation-hint" role="tooltip">100% за полную учебную неделю — {WEEKLY_LOAD_TARGET} уроков. Для частей недели и общих каникул ориентир уменьшается по календарю школы. Это сравнение назначенных уроков, а не расчёт зарплаты.</span>
          </span>
        </div>
      </footer>
    </main>
    {detailsLoading && <div className="teacher-load-loading" role="status">Загружаем уроки учителя…</div>}
    {selection && <TeacherDetails selection={selection} onClose={() => setSelection(null)} />}
  </div>;
}
