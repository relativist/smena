import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { PublicDisplaySettings } from "../shared/displaySettings";
import "./school-name.css";

type SchoolSettingsContextValue = {
  schoolName: string;
  studentSubjectIcons: boolean | undefined;
  refresh: () => void;
  update: (settings: PublicDisplaySettings) => void;
};
const SchoolSettingsContext = createContext<SchoolSettingsContextValue>({ schoolName: "", studentSubjectIcons: undefined, refresh: () => {}, update: () => {} });

export function SchoolSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<{ schoolName: string; studentSubjectIcons?: boolean }>({ schoolName: "" });
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const baseTitle = useRef(document.title);
  const refresh = useCallback(() => {
    if (!active.current || document.visibilityState === "hidden") return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void api<PublicDisplaySettings>("/api/public/display-settings", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(value => {
        if (!active.current || controller.signal.aborted) return;
        setSettings({ schoolName: typeof value.schoolName === "string" ? value.schoolName : "", studentSubjectIcons: typeof value.studentSubjectIcons === "boolean" ? value.studentSubjectIcons : true });
      }).catch(() => {
        if (!active.current || controller.signal.aborted) return;
        setSettings(value => ({ ...value, studentSubjectIcons: value.studentSubjectIcons ?? true }));
      });
  }, []);
  const update = useCallback((value: PublicDisplaySettings) => {
    // A save response is newer than any public request already in flight.
    request.current?.abort();
    setSettings(value);
  }, []);
  useEffect(() => {
    active.current = true;
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active.current = false;
      request.current?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    document.title = settings.schoolName ? `${settings.schoolName} · ${baseTitle.current}` : baseTitle.current;
  }, [settings.schoolName]);
  const value = useMemo(() => ({ schoolName: settings.schoolName, studentSubjectIcons: settings.studentSubjectIcons, refresh, update }), [settings, refresh, update]);
  return <SchoolSettingsContext.Provider value={value}>{children}</SchoolSettingsContext.Provider>;
}

export function useSchoolSettings() { return useContext(SchoolSettingsContext); }

export default function SchoolName({ className = "" }: { className?: string }) {
  const { schoolName } = useSchoolSettings();
  return schoolName ? <span className={`school-name ${className}`} title={schoolName}>{schoolName}</span> : null;
}
