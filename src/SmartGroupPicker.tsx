import { useEffect, useId, useMemo, useRef, useState } from "react";
import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import "./smart-group-picker.css";

type Group = { id: string; name: string };
type Props = {
  groups: Group[];
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
  resetKey?: string;
  disabled?: boolean;
};

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export default function SmartGroupPicker({ groups, selected, onChange, resetKey, disabled = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => groups
    .filter(group => matchesGroupSearch(group.name, query))
    .sort((a, b) => collator.compare(a.name, b.name)), [groups, query]);
  const selectedNames = groups.filter(group => selected?.includes(group.id)).map(group => group.name);
  const caption = selected === null
    ? "Все группы"
    : selectedNames.length <= 2
      ? selectedNames.join(", ") || "Группы не выбраны"
      : `${selectedNames.length} групп`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [resetKey]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const toggle = (id: string, checked: boolean) => {
    const current = selected ?? [];
    const next = checked ? [...current, id] : current.filter(value => value !== id);
    onChange(next.length ? [...new Set(next)] : null);
  };

  return <div className="smart-group-picker" ref={rootRef}>
    <span className="smart-group-picker__label group-search-label">Группа<GroupSearchHint /></span>
    <button
      type="button"
      className="smart-group-picker__trigger"
      ref={triggerRef}
      aria-label="Умный фильтр выбора групп"
      aria-expanded={open}
      aria-controls={popupId}
      disabled={disabled}
      onClick={() => setOpen(value => !value)}
    >
      <span className="smart-group-picker__caption">{caption}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div id={popupId} className="smart-group-picker__popup" role="dialog" aria-label="Умный фильтр выбора групп">
      <label className="smart-group-picker__search">
        <span className="smart-group-picker__visually-hidden">Поиск групп</span>
        <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти группу" />
      </label>
      <div className="smart-group-picker__actions">
        <button type="button" onClick={() => onChange([...new Set([...(selected ?? []), ...visible.map(group => group.id)])])} disabled={!visible.length}>Выбрать найденные</button>
        <button type="button" onClick={() => onChange(null)} disabled={selected === null}>Сбросить</button>
      </div>
      <div className="smart-group-picker__list" role="group" aria-label="Группы">
        {visible.map(group => <label key={group.id}>
          <input type="checkbox" checked={selected?.includes(group.id) ?? false} onChange={event => toggle(group.id, event.target.checked)} />
          <span>{group.name}</span>
        </label>)}
        {!visible.length && <span className="smart-group-picker__empty">Группы не найдены</span>}
      </div>
    </div>}
  </div>;
}
