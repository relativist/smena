import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "./month-year-picker.css";

type Props = { value: string; onChange: (value: string) => void };

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MIN_YEAR = 1900;
const MAX_YEAR = 9998;

function parseMonth(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : null;
}

function monthValue(year: number, month: number) {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
}

function titleFor(value: string) {
  const parsed = parseMonth(value);
  return parsed ? `${MONTHS[parsed.month]} ${parsed.year}` : value;
}

export function MonthYearPicker({ value, onChange }: Props) {
  const selected = parseMonth(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const monthRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [yearText, setYearText] = useState(String(selected?.year ?? new Date().getFullYear()));
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const parsedYear = /^\d{4}$/.test(yearText) ? Number(yearText) : NaN;
  const validYear = Number.isInteger(parsedYear) && parsedYear >= MIN_YEAR && parsedYear <= MAX_YEAR;
  const yearError = useMemo(() => {
    if (!yearText) return "Введите год из четырёх цифр.";
    if (!/^\d{4}$/.test(yearText)) return "Год должен состоять из четырёх цифр.";
    if (!validYear) return `Укажите год от ${MIN_YEAR} до ${MAX_YEAR}.`;
    return "";
  }, [yearText, validYear]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(290, window.innerWidth - 24);
    const height = popupRef.current?.offsetHeight ?? 260;
    const below = rect.bottom + 7;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 7);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top });
  };

  const show = () => {
    updatePosition();
    setYearText(String(selected?.year ?? new Date().getFullYear()));
    setOpen(true);
  };

  useEffect(() => {
    if (open) updatePosition();
  }, [open, yearError]);

  useEffect(() => {
    if (!open) return;
    monthRefs.current[selected?.month ?? 0]?.focus();
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, selected?.month]);

  const chooseMonth = (month: number) => {
    if (!validYear) return;
    const next = monthValue(parsedYear, month);
    if (next !== value) onChange(next);
    close(true);
  };

  const moveFocus = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const offsets: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(11, index + offset));
    monthRefs.current[next]?.focus();
  };

  return <div className="month-year-picker">
    <span className="month-year-picker-label">Месяц и год</span>
    <button ref={triggerRef} type="button" className="month-year-picker-trigger" aria-label={`Выбрать месяц и год: ${titleFor(value)}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => open ? close() : show()}>
      <span>{titleFor(value)}</span><span className="month-year-picker-chevron" aria-hidden="true">▾</span>
    </button>
    {open && <div ref={popupRef} className="month-year-picker-popover" role="dialog" aria-label="Выбор месяца и года" style={position ? { left: position.left, top: position.top } : undefined}>
      <div className="month-year-picker-year-row">
        <button type="button" aria-label="Предыдущий год" disabled={!validYear || parsedYear <= MIN_YEAR} onClick={() => setYearText(String(parsedYear - 1))}>‹</button>
        <label>Год<input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={yearText} aria-invalid={Boolean(yearError)} aria-describedby="month-year-picker-error" onChange={event => setYearText(event.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
        <button type="button" aria-label="Следующий год" disabled={!validYear || parsedYear >= MAX_YEAR} onClick={() => setYearText(String(parsedYear + 1))}>›</button>
      </div>
      <div className="month-year-picker-months" role="group" aria-label="Месяцы">
        {MONTHS.map((month, index) => <button key={month} ref={element => { monthRefs.current[index] = element; }} type="button" disabled={!validYear} aria-pressed={Boolean(selected && selected.year === parsedYear && selected.month === index)} onKeyDown={event => moveFocus(index, event)} onClick={() => chooseMonth(index)}>{month}</button>)}
      </div>
      <p className="month-year-picker-error" id="month-year-picker-error" role="status">{yearError}</p>
    </div>}
  </div>;
}
