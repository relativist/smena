import { appBasePath, stripBasePath, withBasePath } from "./basePath.js";

export type AppView = "schedule" | "catalog" | "plans" | "plan-coverage" | "calendar" | "bells" | "display-settings" | "teacher-load" | "teacher-replacements" | "schedule-print" | "documentation";
export type EntryView = "students" | "teachers" | "admin";

export function entryViewForPath(pathname: string, basePath?: string): EntryView {
  const path = stripBasePath(pathname, basePath).replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/students") return "students";
  if (path === "/teachers") return "teachers";
  return "admin";
}

const paths: Record<AppView, string> = {
  schedule: "/schedule",
  catalog: "/catalog",
  plans: "/plans",
  "plan-coverage": "/plan-coverage",
  calendar: "/calendar",
  bells: "/bells",
  "display-settings": "/display-settings",
  "teacher-load": "/teacher-load",
  "teacher-replacements": "/teacher-replacements",
  "schedule-print": "/schedule-print",
  documentation: "/documentation",
};

export function pathForView(view: AppView, basePath = appBasePath()): string {
  return withBasePath(paths[view], basePath);
}

export function viewForPath(pathname: string, basePath?: string): AppView | null {
  const path = stripBasePath(pathname, basePath).replace(/\/+$/, "") || "/";
  const match = (Object.entries(paths) as [AppView, string][]).find(([, value]) => value === path);
  return match?.[0] ?? null;
}
