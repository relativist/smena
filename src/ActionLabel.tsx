import type { ReactNode } from "react";
import "./action-label.css";

export type ActionName = "add" | "edit" | "delete" | "save" | "print" | "replace" | "apply" | "preview";

const paths: Record<ActionName, ReactNode> = {
  add: <path d="M12 5v14M5 12h14" />,
  edit: <><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z" /><path d="M12 20h8" /></>,
  delete: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></>,
  save: <><path d="M5 3h12l4 4v14H3V3z" /><path d="M7 3v6h10V3M7 21v-8h10v8M14 5v2" /></>,
  print: <><path d="M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7z" /><path d="M17 11h.01" /></>,
  replace: <><circle cx="8" cy="7" r="3" /><path d="M2 20v-3a6 6 0 0 1 10-4M15 7h7l-3-3M22 7l-3 3M22 16h-7l3-3M15 16l3 3" /></>,
  apply: <path d="m4 12 5 5L20 6" />,
  preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
};

/** Decorative action icon; the existing text remains the button's accessible name. */
export default function ActionLabel({ action, children }: { action: ActionName; children: ReactNode }) {
  return <span className="action-label">
    <svg className="action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[action]}</svg>
    <span className="action-label-text">{children}</span>
  </span>;
}
