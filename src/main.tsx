import React, { lazy, Suspense, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { entryViewForPath } from "./navigation";
import { SchoolSettingsProvider } from "./SchoolSettings";
import { observeNumericTypography } from "./numericTypography";
import "./school-background.css";
import "./interface-appearance.css";
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

function NumericTypography() {
  useLayoutEffect(() => observeNumericTypography(document.body), []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NumericTypography />
    <SchoolSettingsProvider><Suspense fallback={<div role="status" style={{ padding: 24, fontFamily: "var(--ui-font-family)" }}>Загрузка…</div>}><Page /></Suspense></SchoolSettingsProvider>
  </React.StrictMode>,
);
