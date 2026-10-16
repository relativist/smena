import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { entryViewForPath } from "./navigation";
import { SchoolSettingsProvider } from "./SchoolSettings";
import "./school-background.css";
const StudentsPage = lazy(() => import("./StudentsPage"));
const TeachersPage = lazy(() => import("./TeachersPage"));
const AuthShell = lazy(() => import("./AuthShell"));
const entryView = entryViewForPath(window.location.pathname);
const studentsView = entryView === "students";
const teachersView = entryView === "teachers";
document.body.classList.toggle("students-view", studentsView);
document.body.classList.toggle("teachers-view", teachersView);
document.title = studentsView ? "Смена · Ученикам" : teachersView ? "Смена · Учителям" : "Смена · Расписание";
const Page = studentsView ? StudentsPage : teachersView ? TeachersPage : AuthShell;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SchoolSettingsProvider><Suspense fallback={<div role="status" style={{ padding: 24, fontFamily: "system-ui" }}>Загрузка…</div>}><Page /></Suspense></SchoolSettingsProvider>
  </React.StrictMode>,
);
