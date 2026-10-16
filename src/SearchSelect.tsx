import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

type Option = { id: string; label: string; detail?: string };
type Props = { label: string; value: string; options: Option[]; placeholder: string; onChange: (value: string) => void; floating?: boolean };

export default function SearchSelect({ label, value, options, placeholder, onChange, floating = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>({});
  const selected = options.find(option => option.id === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru");
    return options.filter(option => !needle || `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase("ru").includes(needle));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !floating) return;
    const panel = list.current;
    if (!panel) return;
    // A native popover stays in the modal's DOM/focus scope, but is rendered
    // in the top layer, outside its scrolling and clipping boundaries.
    panel.showPopover();
    const position = () => {
      const anchor = input.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const margin = 8;
      const gap = 5;
      const width = Math.min(anchor.width, window.innerWidth - margin * 2);
      const desiredHeight = Math.min(panel.scrollHeight + 2, 300, window.innerHeight * 0.45);
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
      const above = Math.max(0, anchor.top - gap - margin);
      const placeBelow = below >= desiredHeight || below >= above;
      const available = placeBelow ? below : above;
      const maxHeight = Math.min(desiredHeight, available);
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
      const top = placeBelow
        ? Math.max(margin, Math.min(anchor.bottom + gap, window.innerHeight - maxHeight - margin))
        : Math.max(margin, anchor.top - maxHeight - gap);
      setFloatingStyle({ left, top, width, maxHeight });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (panel.isConnected && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [floating, open, filtered.length]);

  function choose(option: Option) { onChange(option.id); setQuery(""); setOpen(false); }
  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(""); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, filtered.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    if (event.key === "Enter" && open && filtered[active]) { event.preventDefault(); choose(filtered[active]!); }
  }

  return <div className="tr-search-select" ref={root}>
    <label><span>{label}</span><input ref={input} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined} value={open ? query : selected?.label ?? ""} placeholder={placeholder} autoComplete="off" onFocus={() => { setOpen(true); setQuery(""); setActive(0); }} onClick={() => { if (!open) { setOpen(true); setQuery(""); setActive(0); } }} onBlur={() => { window.setTimeout(() => { if (!root.current?.contains(document.activeElement)) { setOpen(false); setQuery(""); } }, 0); }} onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0); }} onKeyDown={handleKey} /></label>
    {open && <div ref={list} id={listId} popover={floating ? "manual" : undefined} className={`tr-search-options${floating ? " tr-search-options-floating" : ""}`} style={floating ? floatingStyle : undefined} role="listbox" aria-label={label}>{filtered.map((option, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={option.id === value} key={option.id} className={index === active ? "is-active" : ""} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</button>)}{!filtered.length && <p>Ничего не найдено</p>}</div>}
  </div>;
}
