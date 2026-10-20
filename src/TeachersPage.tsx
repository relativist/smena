import { useRef, useState } from "react";
import { withBasePath } from "./basePath";
import SchoolName from "./SchoolSettings";
import TeachersDaySchedule from "./TeachersDaySchedule";
import TeachersQuarterSchedule from "./TeachersQuarterSchedule";
import "./teachers.css";

export default function TeachersPage() {
  const [view, setView] = useState<"date" | "quarter">(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get("view") === "quarter" || (!query.has("view") && (query.has("teacher") || query.has("teachers") || query.has("quarter") || query.has("week"))) ? "quarter" : "date";
  });
  const [visited, setVisited] = useState(() => ({ date: view === "date", quarter: view === "quarter" }));
  const savedQueries = useRef<Partial<Record<"date" | "quarter", string>>>({});
  const changeView = (next: "date" | "quarter") => {
    if (next === view) return;
    savedQueries.current[view] = window.location.search;
    window.history.replaceState(null, "", `${window.location.pathname}${savedQueries.current[next] ?? `?view=${next}`}`);
    setVisited(value => ({ ...value, [next]: true }));
    setView(next);
  };
  return <div className="teachers-page">
    <header className="teachers-header"><div className="teachers-header-top"><a className="teachers-brand" href={withBasePath("/teachers")} aria-label="Смена — главная страница учителей"><span className="teachers-brand-mark">С</span><span>смена</span></a><span className="teachers-header-title">Учителям</span><SchoolName className="teachers-header-school-name" /><nav className="teachers-public-links" aria-label="Публичные страницы"><a className="teachers-student-link" href={withBasePath("/")}>Ученикам</a><a className="teachers-admin-link" href={withBasePath("/admin")} aria-label="Вход для администратора"><span className="teachers-admin-label">Вход для администратора</span><span className="teachers-admin-short">Вход</span></a></nav></div></header>
    <main className="teachers-main">
      <div className="teachers-view-tabs" role="tablist" aria-label="Вид расписания">{(["date", "quarter"] as const).map(tab => <button key={tab} id={`teachers-tab-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls={`teachers-schedule-${tab}`} tabIndex={view === tab ? 0 : -1} onClick={() => changeView(tab)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? "date" : event.key === "End" ? "quarter" : view === "date" ? "quarter" : "date";
          changeView(next);
          document.getElementById(`teachers-tab-${next}`)?.focus();
        }
      }}>{tab === "date" ? "Дата" : "Четверть"}</button>)}</div>
      <div id="teachers-schedule-panel">
        <div id="teachers-schedule-date" role="tabpanel" aria-labelledby="teachers-tab-date" hidden={view !== "date"}>{visited.date && <TeachersDaySchedule active={view === "date"} />}</div>
        <div id="teachers-schedule-quarter" role="tabpanel" aria-labelledby="teachers-tab-quarter" hidden={view !== "quarter"}>{visited.quarter && <TeachersQuarterSchedule active={view === "quarter"} />}</div>
      </div>
    </main>
    <footer className="teachers-footer">Смена · расписание школы</footer>
  </div>;
}
