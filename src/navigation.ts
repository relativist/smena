export type AppView = "schedule" | "catalog" | "plans" | "plan-coverage" | "calendar" | "bells" | "display-settings" | "teacher-load" | "teacher-replacements" | "schedule-print" | "documentation";
export type EntryView = "students" | "teachers" | "admin";

export function entryViewForPath(pathname: string): EntryView {
  const path = pathname.replace(/\/+$/, "") || "/";
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

export function pathForView(view: AppView): string {
  return paths[view];
}

export function viewForPath(pathname: string): AppView | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const match = (Object.entries(paths) as [AppView, string][]).find(([, value]) => value === path);
  return match?.[0] ?? null;
}
