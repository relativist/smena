import { useMemo } from "react";
import type { SelectableGroup } from "./GroupSelection";
import "./schedule-group-select.css";

type Props = {
  groups: SelectableGroup[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
};

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const gradeOf = (name: string) => {
  const match = name.trim().match(/^(1[01]|[1-9])(?=$|[\s\-–—/\\()[А-ЯЁа-яёA-Za-z])/u);
  return match?.[1] ?? null;
};

export default function ScheduleGroupSelect({ groups, value, onChange, label = "Группа" }: Props) {
  const selected = groups.find(group => group.id === value);
  const grades = useMemo(() => {
    const byGrade = new Map<string, SelectableGroup[]>();
    const other: SelectableGroup[] = [];
    for (const group of groups) {
      const grade = gradeOf(group.name);
      if (!grade) { other.push(group); continue; }
      const entries = byGrade.get(grade) ?? [];
      entries.push(group);
      byGrade.set(grade, entries);
    }
    for (const entries of byGrade.values()) entries.sort((a, b) => collator.compare(a.name, b.name));
    other.sort((a, b) => collator.compare(a.name, b.name));
    return { byGrade, other, numbers: [...byGrade.keys()].sort((a, b) => Number(a) - Number(b)) };
  }, [groups]);
  const selectedGrade = gradeOf(selected?.name ?? "");
  const selectedIsOther = selected !== undefined && grades.other.some(group => group.id === selected.id);
  const effectiveGrade = selectedGrade && grades.byGrade.has(selectedGrade)
    ? selectedGrade
    : selectedIsOther
      ? "other"
      : grades.numbers[0] ?? "other";
  const variants = effectiveGrade === "other" ? grades.other : grades.byGrade.get(effectiveGrade) ?? [];

  return <div className="schedule-group-select" aria-label={label}>
    <span className="schedule-group-select__label">{label}</span>
    <select aria-label="Параллель" value={effectiveGrade} onChange={event => {
      const next = event.target.value;
      const options = next === "other" ? grades.other : grades.byGrade.get(next) ?? [];
      if (options.length) onChange(options[0].id);
    }}>
      {grades.numbers.map(grade => <option key={grade} value={grade}>{grade} класс</option>)}
      {grades.other.length > 0 && <option value="other">Другие группы</option>}
    </select>
    <div className="schedule-group-select__variants" role="group" aria-label={`${effectiveGrade === "other" ? "Другие группы" : `${effectiveGrade} класс`} · варианты`}>
      {variants.map(group => <button key={group.id} type="button" aria-pressed={group.id === value} className={group.id === value ? "is-selected" : ""} onClick={() => onChange(group.id)}>{group.name}</button>)}
      {!variants.length && <span>В этом классе нет групп</span>}
    </div>
  </div>;
}
