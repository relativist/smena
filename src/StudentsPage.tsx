import { useRef, useState } from "react";
import { withBasePath } from "./basePath";
import StudentsQuarterSchedule from "./StudentsQuarterSchedule";
import StudentsDaySchedule from "./StudentsDaySchedule";
import SchoolName from "./SchoolSettings";
import "./students.css";

export default function StudentsPage() {
  const [view, setView] = useState<"date" | "quarter">(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get("view") === "quarter" || (!query.has("view") && (query.has("group") || query.has("quarter") || query.has("week"))) ? "quarter" : "date";
  });
  const [visited, setVisited] = useState(() => ({ date: view === "date", quarter: view === "quarter" }));
  const savedQueries = useRef<Partial<Record<"date" | "quarter", string>>>({});
  const changeView = (next: "date" | "quarter") => {
    if (next === view) return;
    savedQueries.current[view] = window.location.search;
    const query = savedQueries.current[next] ?? `?view=${next}`;
    window.history.replaceState(null, "", `${window.location.pathname}${query}`);
    setVisited(value => ({ ...value, [next]: true }));
    setView(next);
  };
  return <div className="students-page">
    <header className="students-header"><div className="students-header-top"><a className="students-brand" href={withBasePath("/")} aria-label="Смена — главная страница учеников"><span className="students-brand-mark">С</span><span>смена</span></a><span className="students-header-title">Ученикам</span><SchoolName className="students-header-school-name" /><nav className="students-public-links" aria-label="Публичные страницы"><a className="students-admin-link" href={withBasePath("/teachers")}>Учителям</a><a className="students-admin-link" href={withBasePath("/admin")} aria-label="Вход для администратора">Администратору</a></nav></div></header>
    <main className="students-main">
      <div className="students-view-tabs" role="tablist" aria-label="Вид расписания">{(["date", "quarter"] as const).map(tab => <button key={tab} id={`students-tab-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls={`students-schedule-${tab}`} tabIndex={view === tab ? 0 : -1} onClick={() => changeView(tab)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? "date" : event.key === "End" ? "quarter" : view === "date" ? "quarter" : "date";
          changeView(next);
          document.getElementById(`students-tab-${next}`)?.focus();
        }
      }}>{tab === "date" ? "Дата" : "Четверть"}</button>)}</div>
      <div id="students-schedule-panel">
        <div id="students-schedule-date" role="tabpanel" aria-labelledby="students-tab-date" hidden={view !== "date"}>
          {visited.date && <StudentsDaySchedule active={view === "date"} />}
        </div>
        <div id="students-schedule-quarter" role="tabpanel" aria-labelledby="students-tab-quarter" hidden={view !== "quarter"}>
          {visited.quarter && <StudentsQuarterSchedule active={view === "quarter"} />}
        </div>
      </div>
    </main>
    <footer className="students-footer">Смена · расписание школы</footer>
  </div>;
}
