import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import SchoolName, { useSchoolSettings } from "./SchoolSettings";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AdminPageHeader from "./AdminPageHeader";
import ActionLabel from "./ActionLabel";
import RussianDateInput from "./RussianDateInput";
import { ApiError, api, type AuthSession } from "./api";
import type { StateResponse } from "../server/contracts.ts";
import type { SchedulePrintGroup, SchedulePrintIndex, SchedulePrintPreview, SchedulePrintPreviewRequest, SchedulePrintSource } from "../shared/schedulePrintTypes.ts";
import { visibleQuarters } from "../shared/plans.ts";
import { packPrintRows, printDateTables, printLessonDisplay, printTimeRows, printWeekDays, splitOversizedPrintRow, type PrintDay, type PrintRow } from "../shared/schedulePrint.ts";
import { isValidIsoDate } from "../shared/studentNavigation.ts";
import { matchesSchoolStage, shiftStudentDate, type SchoolStage } from "../shared/studentDayNavigation.ts";
import "./schedule-print.css";

type Props = { initialState: StateResponse; auth: AuthSession; onUnauthorized: () => void; onBack: () => Promise<void>; initialGroupId?: string; initialQuarterId?: string; initialDate?: string };
type PrintTable = { group: SchedulePrintGroup; days: PrintDay[]; rows: PrintRow[]; columnHeadings?: string[]; date?: string };
type PrintPage = PrintTable & { start: number; end: number; continued: boolean };
type PrintView = "quarter" | "date";
const stages: Array<{ id: SchoolStage; label: string }> = [
  { id: "all", label: "Вся школа" }, { id: "primary", label: "Начальная · 1–4" },
  { id: "middle", label: "Средняя · 5–9" }, { id: "high", label: "Старшая · 10–11" },
];
const dateIso = (date = new Date()) => date.toLocaleDateString("sv-SE");
const mondayOf = (date: string) => { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); return value.toLocaleDateString("sv-SE"); };
const addDays = (date: string, amount: number) => { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + amount); return value.toLocaleDateString("sv-SE"); };
const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => new Intl.DateTimeFormat("ru-RU", options).format(new Date(`${date}T12:00:00`));
const weekdays = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

function weeksFor(quarter: { startDate: string; endDate: string }) {
  const weeks: string[] = [];
  let week = mondayOf(quarter.startDate);
  while (week <= quarter.endDate) { weeks.push(week); week = addDays(week, 7); }
  return weeks;
}

function GroupPicker({ groups, selected, onChange }: { groups: SchedulePrintGroup[]; selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false); const [search, setSearch] = useState(""); const root = useRef<HTMLDivElement>(null);
  const visible = groups.filter(group => matchesGroupSearch(group.name, search));
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, []);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  return <div className="sp-group-picker" ref={root}>
    <span className="sp-field-label group-search-label">Группы<GroupSearchHint /></span>
    <button className="sp-picker-trigger" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{selected.length ? `Выбрано групп: ${selected.length}` : "Выберите группы"}<span aria-hidden="true">⌄</span></button>
    {open && <div className="sp-picker-popover">
      <input aria-label="Поиск групп" placeholder="Найти группу" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="sp-picker-actions"><button type="button" onClick={() => onChange([...new Set([...selected, ...visible.map(group => group.id)])])}>Выбрать видимые</button><button type="button" onClick={() => onChange(groups.map(group => group.id))}>Выбрать все</button><button type="button" onClick={() => onChange([])}>Сбросить</button></div>
      <div className="sp-picker-list">{visible.length ? visible.map(group => <label key={group.id}><input type="checkbox" checked={selected.includes(group.id)} onChange={() => toggle(group.id)} /><span>{group.name}</span></label>) : <p>Группы не найдены</p>}</div>
    </div>}
  </div>;
}

function Sheet({ page, quarter, weekStart, watermark, measure = false }: { page: PrintPage; quarter: SchedulePrintPreview["quarter"]; weekStart: string; watermark: boolean; measure?: boolean }) {
  const columnIndexes = page.columnHeadings ? page.days.map((_, index) => index) : page.days.some(day => day.weekday > 4 && day.lessons.length) ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
  const continuation = page.continued;
  const tableWidth = `calc(20mm + ${columnIndexes.length} * 38.5mm)`;
  return <section className={`sp-sheet${measure ? " sp-measure-sheet" : ""}`}>
    <div className="sp-page-head">
      <div><SchoolName className="sp-school-name" /><h2>{page.date ? dateLabel(page.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : page.group.name}{continuation ? " - продолжение" : ""}</h2><p>{quarter.name}{!page.date && ` · неделя ${dateLabel(weekStart)} - ${dateLabel(addDays(weekStart, 6))}`}</p></div>
      {watermark && <strong className="sp-watermark">ЧЕРНОВИК</strong>}
    </div>
    <table className="sp-table" style={{ width: tableWidth }}><colgroup><col className="sp-time-col" />{columnIndexes.map(index => <col key={index} className="sp-group-col" />)}</colgroup><thead><tr><th className="sp-number-head">№<span>Время</span></th>{columnIndexes.map(index => <th key={index} className={page.days[index].inQuarter ? "" : "is-outside-quarter"}>{page.columnHeadings?.[index] ?? weekdays[index]}{!page.date && <span>{dateLabel(page.days[index].date, { day: "numeric", month: "short" })}</span>}{page.days[index].holidayLabel && <small>{page.days[index].holidayLabel}</small>}{!page.days[index].inQuarter && <small>вне четверти</small>}</th>)}</tr></thead>
      <tbody>{page.rows.slice(page.start, page.end).map((row, fragment) => <tr className="sp-row" key={`${row.slot}-${page.start}-${fragment}`}>
        <th scope="row"><strong>{row.slot || "—"}</strong>{row.start !== undefined && <time>{`${String(Math.floor(row.start / 60) % 24).padStart(2, "0")}:${String(row.start % 60).padStart(2, "0")}`}</time>}{row.continued && row.slot ? <small>далее</small> : null}</th>
        {columnIndexes.map(index => <td key={index} data-day-index={index}>{row.days[index]?.length ? row.days[index].map(lesson => {
          const detail = printLessonDisplay(lesson);
          return <div className="sp-lesson" key={lesson.id}><strong>{detail.subject}</strong><span>{[detail.teacher, detail.subgroup, detail.room].filter(Boolean).join(" · ")}</span>{detail.joint && <small>Общий: {detail.joint}</small>}</div>;
        }) : row.slot === 0 && !page.days[index].holidayLabel ? <span className="sp-no-lessons">Занятий нет</span> : null}</td>)}
      </tr>)}</tbody>
    </table>
  </section>;
}

export default function SchedulePrintPage({ auth, onUnauthorized, onBack, initialGroupId, initialQuarterId, initialDate }: Props) {
  const { schoolName } = useSchoolSettings();
  const [view, setView] = useState<PrintView>("date");
  const [date, setDate] = useState(isValidIsoDate(initialDate) ? initialDate : dateIso());
  const [stage, setStage] = useState<SchoolStage>("all");
  const [dateGroupIds, setDateGroupIds] = useState<string[] | undefined>(undefined);
  const [index, setIndex] = useState<SchedulePrintIndex>(); const [indexBusy, setIndexBusy] = useState(true); const [indexError, setIndexError] = useState("");
  const [source, setSource] = useState<SchedulePrintSource>("published"); const [quarterId, setQuarterId] = useState(""); const [weekStart, setWeekStart] = useState(""); const [groupIds, setGroupIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<SchedulePrintPreview>(); const [previewKey, setPreviewKey] = useState(""); const [previewBusy, setPreviewBusy] = useState(false); const [error, setError] = useState(""); const [backBusy, setBackBusy] = useState(false);
  const [pages, setPages] = useState<PrintPage[]>([]); const [paginationKey, setPaginationKey] = useState(""); const [paginationError, setPaginationError] = useState("");
  const selectionVersion = useRef(0); const requestController = useRef<AbortController | undefined>(undefined); const measureHost = useRef<HTMLDivElement>(null);
  const clearPreview = () => { selectionVersion.current += 1; requestController.current?.abort(); requestController.current = undefined; setPreviewBusy(false); setPreview(undefined); setPreviewKey(""); setPages([]); setPaginationKey(""); setError(""); setPaginationError(""); };

  const quarters = visibleQuarters(source === "published" ? index?.published ?? [] : index?.draft ?? []);
  const quarter = view === "date" ? quarters.find(item => item.startDate <= date && item.endDate >= date) : quarters.find(item => item.id === quarterId) ?? quarters[0];
  const groupList = useMemo(() => [...(quarter?.groups ?? [])].sort((a, b) => collator.compare(a.name, b.name)), [quarter]);
  const selectedGroupIds = view === "date" ? groupList.filter(group => dateGroupIds === undefined || dateGroupIds.includes(group.id)).map(group => group.id) : groupIds;
  const selectedWeek = view === "date" ? date ? mondayOf(date) : "" : weekStart;
  const weeks = useMemo(() => quarter ? weeksFor(quarter) : [], [quarter]);
  const selectedKey = JSON.stringify({ view, date: view === "date" ? date : undefined, source, quarterId: quarter?.id ?? "", weekStart: selectedWeek, groupIds: [...selectedGroupIds].sort(collator.compare) });
  const canPreview = Boolean(index && quarter && selectedWeek && selectedGroupIds.length && !indexBusy && !previewBusy);
  const canPrint = Boolean(preview && previewKey === selectedKey && paginationKey === previewKey && pages.length && !previewBusy && !paginationError);

  useEffect(() => {
    const controller = new AbortController(); setIndexBusy(true); setIndexError("");
    api<SchedulePrintIndex>("/api/schedule-print/index", { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setIndex(value);
      const today = initialDate ?? dateIso();
      const published = visibleQuarters(value.published);
      const preferred = published.find(item => item.id === initialQuarterId) ?? published.find(item => item.startDate <= today && item.endDate >= today) ?? published[0];
      const selected = preferred;
      setQuarterId(selected?.id ?? "");
      if (selected) {
        const week = mondayOf(today); const validWeeks = weeksFor(selected);
        setWeekStart(validWeeks.includes(week) ? week : validWeeks.find(item => item >= week) ?? validWeeks[validWeeks.length - 1] ?? "");
        setGroupIds(initialGroupId && selected.groups.some(group => group.id === initialGroupId) ? [initialGroupId] : []);
      }
    }).catch(reason => { if (!controller.signal.aborted) { if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized(); else setIndexError(reason instanceof Error ? reason.message : "Не удалось загрузить данные для печати."); } }).finally(() => { if (!controller.signal.aborted) setIndexBusy(false); });
    return () => controller.abort();
  }, [auth, initialDate, initialGroupId, initialQuarterId, onUnauthorized]);

  useEffect(() => {
    document.body.classList.add("schedule-print-view");
    return () => { document.body.classList.remove("schedule-print-view"); requestController.current?.abort(); };
  }, []);

  const changeSource = (next: SchedulePrintSource) => {
    clearPreview(); setSource(next); setDateGroupIds(undefined);
    const target = visibleQuarters((next === "published" ? index?.published : index?.draft) ?? []);
    const preferred = target.find(item => item.id === quarterId) ?? target.find(item => item.startDate <= dateIso() && item.endDate >= dateIso()) ?? target[0];
    setQuarterId(preferred?.id ?? "");
    if (preferred) { const current = mondayOf(dateIso()); const list = weeksFor(preferred); setWeekStart(list.includes(current) ? current : list.find(item => item >= current) ?? list.at(-1) ?? ""); setGroupIds([]); }
  };
  const changeQuarter = (nextId: string) => {
    clearPreview(); setQuarterId(nextId);
    const next = quarters?.find(item => item.id === nextId); if (!next) { setWeekStart(""); setGroupIds([]); return; }
    const current = mondayOf(initialDate ?? dateIso()); const list = weeksFor(next);
    setWeekStart(list.includes(current) ? current : list.find(item => item >= current) ?? list.at(-1) ?? "");
    setGroupIds(initialGroupId && next.groups.some(group => group.id === initialGroupId) ? [initialGroupId] : []);
  };
  const changeWeek = (next: string) => { clearPreview(); setWeekStart(next); };
  const changeGroups = (next: string[]) => { clearPreview(); const valid = next.filter(id => groupList.some(group => group.id === id)); if (view === "date") setDateGroupIds(valid); else setGroupIds(valid); };
  const changeView = (next: PrintView) => { if (next !== view) { clearPreview(); setView(next); } };
  const changeDate = (next: string) => {
    if (next && !isValidIsoDate(next)) return;
    clearPreview(); setDate(next);
    if (quarters.find(item => item.startDate <= next && item.endDate >= next)?.id !== quarter?.id) setDateGroupIds(undefined);
  };

  const refreshIndex = async () => {
    setIndexBusy(true); setIndexError("");
    try {
      const next = await api<SchedulePrintIndex>("/api/schedule-print/index"); setIndex(next);
      const choices = visibleQuarters(source === "published" ? next.published : next.draft);
      const today = initialDate ?? dateIso();
      const current = choices.find(item => item.id === quarterId);
      const selected = current ?? choices.find(item => item.startDate <= today && item.endDate >= today) ?? choices[0];
      const nextQuarterId = selected?.id ?? "";
      const nextWeeks = selected ? weeksFor(selected) : [];
      const desiredWeek = selected && selected.id === quarterId ? weekStart : mondayOf(today);
      const nextWeek = nextWeeks.includes(desiredWeek) ? desiredWeek : nextWeeks.find(week => week >= desiredWeek) ?? nextWeeks.at(-1) ?? "";
      const validGroups = new Set(selected?.groups.map(group => group.id) ?? []);
      const nextGroupIds = groupIds.filter(id => validGroups.has(id));
      clearPreview();
      setQuarterId(nextQuarterId); setWeekStart(nextWeek); setGroupIds(nextGroupIds);
    } catch (reason) { if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized(); else setIndexError(reason instanceof Error ? reason.message : "Не удалось обновить расписания."); }
    finally { setIndexBusy(false); }
  };

  const requestPreview = async () => {
    if (!index || !quarter || !selectedWeek || !selectedGroupIds.length) return;
    const version = ++selectionVersion.current; const key = selectedKey; const controller = new AbortController(); requestController.current?.abort(); requestController.current = controller;
    const publishedQuarter = source === "published" ? index.published.find(item => item.id === quarter.id) : undefined;
    const body: SchedulePrintPreviewRequest = { source, quarterId: quarter.id, weekStart: selectedWeek, groupIds: [...selectedGroupIds].sort(collator.compare), ...(publishedQuarter ? { version: publishedQuarter.publication.version } : { revision: index.revision }) };
    setPreview(undefined); setPreviewKey(""); setPages([]); setPaginationKey(""); setError(""); setPaginationError(""); setPreviewBusy(true);
    try {
      const value = await api<SchedulePrintPreview>("/api/schedule-print/preview", { method: "POST", headers: { "x-csrf-token": auth.csrfToken }, body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted || version !== selectionVersion.current || key !== selectedKey) return;
      setPreview(value); setPreviewKey(key);
    } catch (reason) {
      if (controller.signal.aborted || version !== selectionVersion.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) onUnauthorized();
      else if (reason instanceof ApiError && reason.status === 409) { await refreshIndex(); setError("Расписание изменилось. Обновили список — проверьте выбор и сформируйте предпросмотр заново."); }
      else setError(reason instanceof Error ? reason.message : "Не удалось сформировать предпросмотр.");
    } finally { if (!controller.signal.aborted && version === selectionVersion.current) setPreviewBusy(false); }
  };

  const measuredGroups = useMemo<PrintTable[]>(() => preview ? view === "date" ? printDateTables(preview, date) : preview.groups.map(item => {
    const days = printWeekDays(item.days, preview.weekStart, preview.quarter); return { group: item.group, days, rows: printTimeRows(days) };
  }) : [], [preview, view, date]);
  useLayoutEffect(() => {
    const host = measureHost.current;
    if (!preview || !previewKey || !host) return;
    let active = true; setPaginationError(""); setPaginationKey("");
    const calculate = async () => {
      try { await document.fonts?.ready; } catch { /* fallback fonts are still measurable */ }
      requestAnimationFrame(() => {
        if (!active) return;
        const all: PrintPage[] = [];
        for (const [groupIndex, group] of measuredGroups.entries()) {
          const node: HTMLElement | null = host.querySelector(`[data-measure-group="${groupIndex}"]`);
          if (!node) continue;
          const sheet = node.querySelector(".sp-sheet") as HTMLElement | null; const head = node.querySelector(".sp-page-head") as HTMLElement | null; const thead = node.querySelector(".sp-table thead") as HTMLElement | null;
          const rowNodes = Array.from(node.querySelectorAll(".sp-row")) as HTMLElement[];
          if (!sheet || !head || !thead) continue;
          const pxPerMm = 96 / 25.4;
          const available = Math.max(8, (sheet.clientHeight - 20 * pxPerMm - head.offsetHeight - thead.offsetHeight - 20) / pxPerMm);
          const pageRows: PrintRow[] = []; const heights: number[] = [];
          for (const [rowIndex, row] of rowNodes.entries()) {
            const rowHeight = row.getBoundingClientRect().height / pxPerMm;
            if (rowHeight <= available + 0.5) { pageRows.push(group.rows[rowIndex]); heights.push(rowHeight); continue; }
            const cardHeights = Array.from({ length: group.days.length }, () => [] as number[]);
            for (const cell of Array.from(row.querySelectorAll("td[data-day-index]")) as HTMLElement[]) {
              const dayIndex = Number(cell.dataset.dayIndex);
              cardHeights[dayIndex] = (Array.from(cell.querySelectorAll(".sp-lesson")) as HTMLElement[]).map(card => {
                const margin = Number.parseFloat(getComputedStyle(card).marginBottom) || 0;
                return (card.getBoundingClientRect().height + margin) / pxPerMm;
              });
            }
            const split = splitOversizedPrintRow(group.rows[rowIndex], cardHeights, Math.max(2, available - 2.8));
            if (split.oversizedCard) {
              setPaginationError(`В группе ${group.group.name} одна карточка урока слишком высокая для страницы А4. Сократите её название или число объединённых занятий.`);
              return;
            }
            pageRows.push(...split.rows); heights.push(...split.heightsMm);
          }
          for (const slice of packPrintRows(heights, available)) all.push({ ...group, rows: pageRows, start: slice.start, end: slice.end, continued: slice.start > 0 });
        }
        if (active) { setPages(all); setPaginationKey(previewKey); }
      });
    };
    void calculate();
    return () => { active = false; };
  }, [measuredGroups, preview, previewKey, schoolName]);

  const back = async () => { setBackBusy(true); setError(""); try { await onBack(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось вернуться в расписание."); } finally { setBackBusy(false); } };
  return <div className="schedule-print-page">
    <style media="print">{"@page { size: A4 landscape; margin: 0; }"}</style>
    <AdminPageHeader title="Печать расписания" onBack={() => void back()} busy={backBusy} />
    <main className="sp-main">
      <div className="sp-view-tabs" role="tablist" aria-label="Вид расписания для печати">{(["date", "quarter"] as const).map(tab => <button key={tab} id={`sp-tab-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls="sp-schedule-panel" tabIndex={view === tab ? 0 : -1} onClick={() => changeView(tab)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? "date" : event.key === "End" ? "quarter" : view === "date" ? "quarter" : "date";
          changeView(next); document.getElementById(`sp-tab-${next}`)?.focus();
        }
      }}>{tab === "quarter" ? "Четверть" : "Дата"}</button>)}</div>
      <div id="sp-schedule-panel" role="tabpanel" aria-labelledby={`sp-tab-${view}`}>
      <section className="sp-controls" aria-label="Параметры печати">
        <div className={`sp-control-grid${view === "date" ? " sp-date-controls" : ""}`}>
          <label>Источник расписания<select aria-label="Источник расписания" value={source} onChange={event => changeSource(event.target.value as SchedulePrintSource)}><option value="published">Опубликованное</option><option value="draft">Черновик</option></select></label>
          {view === "quarter" ? <>
            <label>Четверть<select aria-label="Четверть" value={quarter?.id ?? ""} onChange={event => changeQuarter(event.target.value)} disabled={!quarters?.length}>{quarters?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Неделя<select aria-label="Неделя" value={weekStart} onChange={event => changeWeek(event.target.value)} disabled={!weeks.length}>{weeks.map(week => <option key={week} value={week}>{dateLabel(week)} – {dateLabel(addDays(week, 6))}</option>)}</select></label>
          </> : <>
            <label>Школа<select aria-label="Школа" value={stage} onChange={event => { const next = event.target.value as SchoolStage; clearPreview(); setStage(next); setDateGroupIds(groupList.filter(group => matchesSchoolStage(group.name, next)).map(group => group.id)); }}>{stages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <div className="sp-date-control"><span className="sp-field-label">Дата</span><div className="sp-date-picker">
              <button type="button" aria-label="Предыдущий день" disabled={!date || date <= "0001-01-01"} onClick={() => changeDate(shiftStudentDate(date, -1))}>‹</button>
              <RussianDateInput label="Дата расписания" value={date} onChange={changeDate} />
              <button type="button" aria-label="Следующий день" disabled={!date || date >= "9999-12-31"} onClick={() => changeDate(shiftStudentDate(date, 1))}>›</button>
              <button type="button" className="sp-today" onClick={() => changeDate(dateIso())}>Сегодня</button>
            </div></div>
          </>}
          <GroupPicker groups={groupList} selected={selectedGroupIds} onChange={changeGroups} />
        </div>
        <div className="sp-controls-footer"><p>{view === "date" ? "Классы печатаются общей таблицей на выбранную дату, до семи классов на листе." : "Каждая группа печатается отдельно на листах А4 в альбомной ориентации."} Чтобы убрать адрес, дату и номера страниц, отключите «Колонтитулы» в дополнительных настройках печати браузера.</p><button type="button" className="sp-primary" onClick={() => void requestPreview()} disabled={!canPreview}><ActionLabel action="preview">{previewBusy ? "Формируем…" : "Предпросмотр"}</ActionLabel></button><button type="button" onClick={() => window.print()} disabled={!canPrint}><ActionLabel action="print">Печать</ActionLabel></button></div>
        {indexError && <p className="sp-error" role="alert">{indexError} <button type="button" onClick={() => void refreshIndex()}>Повторить</button></p>}
        {error && <p className="sp-error" role="alert">{error}</p>}{paginationError && <p className="sp-error" role="alert">{paginationError}</p>}
        {index && !quarters?.length && <p className="sp-empty">{source === "published" ? "Нет опубликованных четвертей. Опубликуйте расписание или выберите черновик." : "Нет черновых четвертей для печати."}</p>}
        {index && quarters.length > 0 && view === "date" && !quarter && <p className="sp-empty">{!date ? "Выберите дату расписания." : <>{source === "published" ? "На эту дату нет опубликованного расписания." : "Эта дата не входит ни в одну четверть черновика."} Выберите другую дату.</>}</p>}
        {index && view === "date" && quarter && !groupList.length && <p className="sp-empty">Нет групп для печати.</p>}
        {preview && preview.groups.length === 0 && <p className="sp-empty">Для выбранных групп нет данных в этом расписании.</p>}
      </section>
      {preview && previewKey === selectedKey && <div className="sp-preview-scroll" aria-label="Предпросмотр страниц">
        <div className="sp-paper-stack">{pages.map((page) => <Sheet key={`${page.group.id}-${page.start}`} page={page} quarter={preview.quarter} weekStart={preview.weekStart} watermark={preview.source === "draft"} />)}</div>
      </div>}
      {preview && preview.source === "draft" && <p className="sp-screen-watermark">Черновик · для проверки, не опубликованное расписание</p>}
      {preview && <div className="sp-measure-host" ref={measureHost} aria-hidden="true">{measuredGroups.map((group, index) => <div data-measure-group={index} key={group.group.id}><Sheet page={{ ...group, start: 0, end: group.rows.length, continued: true }} quarter={preview.quarter} weekStart={preview.weekStart} watermark={preview.source === "draft"} measure /></div>)}</div>}
      {!preview && !indexBusy && !indexError && quarter && <div className="sp-empty sp-before-preview">{view === "date" ? "Выберите дату и группы, затем нажмите «Предпросмотр»." : "Выберите четверть, неделю и группы, затем нажмите «Предпросмотр»."}</div>}
      </div>
    </main>
  </div>;
}
