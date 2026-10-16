import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SelectableGroup } from "./GroupSelection";
import "./group-selection.css";

type Props = { groups: SelectableGroup[]; value: string; onChange: (id: string) => void; label?: string; disabled?: boolean };
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export default function GroupSelect({ groups, value, onChange, label = "Группа", disabled = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusRef = useRef(false);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = groups.find((group) => group.id === value);
  const filtered = useMemo(() => {
    return groups.filter((group) => matchesGroupSearch(group.name, query)).sort((a, b) => collator.compare(a.name, b.name));
  }, [groups, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  useEffect(() => { if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1)); }, [active, filtered.length]);
  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open, filtered]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
    setActive(0);
    restoreFocusRef.current = document.activeElement !== input.current;
    input.current?.focus();
  };
  const closeWhenFocusLeaves = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
      setQuery("");
      setActive(0);
    }
  };
  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); setQuery(""); setActive(0); return; }
    if (event.key === "ArrowDown" && filtered.length) {
      event.preventDefault();
      if (!open) { setOpen(true); setActive(0); }
      else setActive((index) => Math.min(index + 1, filtered.length - 1));
    }
    if (event.key === "ArrowUp" && filtered.length) {
      event.preventDefault();
      if (!open) { setOpen(true); setActive(filtered.length - 1); }
      else setActive((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && open && filtered[active]) { event.preventDefault(); choose(filtered[active].id); }
  };

  return <div className="group-select" ref={root} onBlurCapture={closeWhenFocusLeaves}>
    {label && <span className="group-select-label group-search-label">{label}<GroupSearchHint /></span>}
    <div className="group-select-control">
      <input ref={input} role="combobox" aria-label={label || "Группа"} aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={open && filtered[active] ? `${listboxId}-${active}` : undefined} value={open ? query : selected?.name ?? ""} placeholder="Найти группу" disabled={disabled} onFocus={() => { if (restoreFocusRef.current) { restoreFocusRef.current = false; return; } setOpen(true); setQuery(""); setActive(0); }} onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={handleKey} />
      <button type="button" aria-label={open ? "Закрыть список групп" : "Показать группы"} disabled={disabled} onClick={() => { if (open) { setOpen(false); setQuery(""); setActive(0); } else { setOpen(true); setQuery(""); setActive(0); input.current?.focus(); } }}>▾</button>
      {open && <div id={listboxId} className="group-select-options" role="listbox" aria-label={label || "Группы"}>
        {filtered.map((group, index) => <button type="button" ref={(element) => { optionRefs.current[index] = element; }} id={`${listboxId}-${index}`} role="option" aria-selected={group.id === value} className={index === active ? "active" : ""} key={group.id} onMouseEnter={() => setActive(index)} onClick={() => choose(group.id)}>{group.name}</button>)}
        {!filtered.length && <span className="group-select-empty">Группы не найдены</span>}
      </div>}
    </div>
    {!label && <GroupSearchHint />}
  </div>;
}
