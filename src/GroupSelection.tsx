import { matchesGroupSearch } from "../shared/groupSearch";
import GroupSearchHint from "./GroupSearchHint";
import { useMemo, useState } from "react";
import "./group-selection.css";

export type SelectableGroup = { id: string; name: string };
type Props = {
  groups: SelectableGroup[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
};

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export default function GroupSelection({ groups, value, onChange, disabled = false, label = "Группы" }: Props) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    return groups.filter((group) => matchesGroupSearch(group.name, query)).sort((a, b) => collator.compare(a.name, b.name));
  }, [groups, query]);
  const visibleIds = visible.map((group) => group.id);
  const selected = new Set(value);
  const selectVisible = () => onChange([...new Set([...value, ...visibleIds])]);

  return <section className="group-selection" aria-label={label}>
    <div className="group-selection-heading"><strong className="group-search-label">{label}<GroupSearchHint /></strong><span>Выбрано: {value.length}</span></div>
    <label className="group-selection-search"><span className="group-selection-visually-hidden">Поиск группы</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти группу" disabled={disabled} /></label>
    <div className="group-selection-actions">
      <button type="button" onClick={selectVisible} disabled={disabled || !visible.length}>Выбрать видимые</button>
      <button type="button" onClick={() => onChange([])} disabled={disabled || !value.length}>Сбросить</button>
      {query && <span>Найдено: {visible.length}</span>}
    </div>
    <div className="group-selection-list" role="group" aria-label={label}>
      {visible.map((group) => <label key={group.id}><input type="checkbox" checked={selected.has(group.id)} disabled={disabled} onChange={() => onChange(selected.has(group.id) ? value.filter((id) => id !== group.id) : [...value, group.id])} />{group.name}</label>)}
      {!visible.length && <span className="group-selection-empty">Группы не найдены</span>}
    </div>
  </section>;
}
