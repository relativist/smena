import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./smart-group-picker.css";

type Teacher = { id: string; name: string };
type Props = {
  teachers: Teacher[];
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
  disabled?: boolean;
  resetKey?: string;
  label?: string;
};

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const normalize = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").trim().replace(/\s+/gu, " ");

export default function TeacherPicker({ teachers, selected, onChange, disabled = false, resetKey, label = "Преподаватели" }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => teachers.filter(teacher => normalize(teacher.name).includes(normalize(query)))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id)), [teachers, query]);
  const selectedNames = teachers.filter(teacher => selected?.includes(teacher.id)).map(teacher => teacher.name);
  const caption = selected === null
    ? "Все преподаватели"
    : selectedNames.length <= 2
      ? selectedNames.join(", ") || "Преподаватели не выбраны"
      : `Выбрано: ${selectedNames.length}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); setOpen(false); triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  useEffect(() => { setOpen(false); setQuery(""); }, [resetKey]);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);

  const toggle = (id: string, checked: boolean) => {
    const current = selected ?? teachers.map(teacher => teacher.id);
    const next = checked ? [...current, id] : current.filter(value => value !== id);
    onChange(next.length === teachers.length ? null : [...new Set(next)]);
  };

  return <div className="smart-group-picker teacher-filter" ref={rootRef}>
    <span className="smart-group-picker__label">{label}</span>
    <button type="button" className="smart-group-picker__trigger" ref={triggerRef} aria-label="Фильтр преподавателей"
      aria-expanded={open} aria-controls={popupId} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <span className="smart-group-picker__caption">{caption}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div id={popupId} className="smart-group-picker__popup" role="dialog" aria-label="Фильтр преподавателей">
      <label className="smart-group-picker__search"><span className="smart-group-picker__visually-hidden">Поиск преподавателя</span>
        <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти преподавателя" />
      </label>
      <div className="smart-group-picker__actions">
        <button type="button" onClick={() => onChange(null)} disabled={selected === null}>Выбрать всех</button>
        <button type="button" onClick={() => onChange([...new Set([...(selected ?? teachers.map(teacher => teacher.id)), ...visible.map(teacher => teacher.id)])])} disabled={!visible.length || selected === null}>Выбрать найденных</button>
        <button type="button" onClick={() => onChange([])} disabled={selected?.length === 0}>Сбросить</button>
      </div>
      <div className="smart-group-picker__list" role="group" aria-label="Преподаватели">
        {visible.map(teacher => <label key={teacher.id}>
          <input type="checkbox" checked={selected === null || selected.includes(teacher.id)} onChange={event => toggle(teacher.id, event.target.checked)} />
          <span>{teacher.name}</span>
        </label>)}
        {!visible.length && <span className="smart-group-picker__empty">Преподаватели не найдены</span>}
      </div>
    </div>}
  </div>;
}
