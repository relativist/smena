import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./russian-date-input.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  label: string;
};

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const pad = (number: number) => String(number).padStart(2, "0");
const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromIso = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
};
const displayDate = (value: string) => {
  const date = fromIso(value);
  return date ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}` : "";
};
const parseDisplayDate = (value: string) => {
  const match = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return date.getFullYear() === Number(match[3]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[1]) ? isoDate(date) : null;
};
const today = () => {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

export default function RussianDateInput({ value, onChange, label }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const yearButton = useRef<HTMLButtonElement>(null);
  const [yearOpen, setYearOpen] = useState(false);
  const [yearPage, setYearPage] = useState(2016);
  const selected = fromIso(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const date = selected ?? today();
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const [text, setText] = useState(displayDate(value));
  const [invalid, setInvalid] = useState(false);
  const [focusDate, setFocusDate] = useState<Date | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number; maxHeight: number }>({ left: 8, top: 8, maxHeight: 320 });
  const years = Array.from({ length: 12 }, (_, index) => yearPage + index);
  const yearPageFor = (year: number) => Math.max(100, Math.min(9988, Math.floor(year / 12) * 12));

  useEffect(() => {
    setText(displayDate(value));
    setInvalid(false);
    textInput.current?.setCustomValidity("");
  }, [value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (yearOpen) {
          setYearOpen(false);
          yearButton.current?.focus();
        } else setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, yearOpen]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = root.current?.getBoundingClientRect();
      const panel = popover.current;
      if (!anchor || !panel) return;
      const margin = 8;
      const panelWidth = panel.getBoundingClientRect().width;
      const naturalHeight = panel.scrollHeight;
      const spaceBelow = window.innerHeight - anchor.bottom - 5 - margin;
      const spaceAbove = anchor.top - 5 - margin;
      const placeBelow = spaceBelow >= naturalHeight || spaceBelow >= spaceAbove;
      const availableHeight = Math.max(120, Math.min(naturalHeight, placeBelow ? spaceBelow : spaceAbove));
      const left = Math.max(margin, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - margin));
      const top = placeBelow
        ? Math.max(margin, Math.min(anchor.bottom + 5, window.innerHeight - availableHeight - margin))
        : Math.max(margin, anchor.top - availableHeight - 5);
      setPopoverPosition({ left, top, maxHeight: availableHeight });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, month, yearOpen]);

  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const total = Math.ceil((mondayOffset + count) / 7) * 7;
    return Array.from({ length: total }, (_, index) => {
      const day = index - mondayOffset + 1;
      if (day < 1 || day > count) return null;
      return new Date(month.getFullYear(), month.getMonth(), day);
    });
  }, [month]);
  const firstVisibleDate = cells.find((date): date is Date => date !== null);
  const focusIsInMonth = focusDate?.getFullYear() === month.getFullYear() && focusDate.getMonth() === month.getMonth();
  const selectedIsInMonth = selected?.getFullYear() === month.getFullYear() && selected.getMonth() === month.getMonth();

  function commitTyped() {
    const trimmed = text.trim();
    if (!trimmed) {
      setInvalid(false);
      textInput.current?.setCustomValidity("");
      onChange("");
      return;
    }
    const parsed = parseDisplayDate(trimmed);
    if (parsed) {
      setInvalid(false);
      textInput.current?.setCustomValidity("");
      setText(displayDate(parsed));
      onChange(parsed);
    } else {
      setInvalid(true);
      textInput.current?.setCustomValidity("Введите дату в формате ДД.ММ.ГГГГ.");
    }
  }

  function choose(date: Date) {
    const next = isoDate(date);
    setText(displayDate(next));
    setInvalid(false);
    textInput.current?.setCustomValidity("");
    onChange(next);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setOpen(false);
    setFocusDate(date);
    textInput.current?.focus();
  }

  function moveMonth(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
    setFocusDate(null);
  }

  function handleGridKey(event: React.KeyboardEvent<HTMLButtonElement>, date: Date) {
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    setFocusDate(next);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-date="${isoDate(next)}"]`)?.focus());
  }

  return (
    <div className="russian-date-input" ref={root}>
      <div className="ru-date-control">
        <input
          ref={textInput}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${errorId}-date-error` : undefined}
          placeholder="ДД.ММ.ГГГГ"
          value={text}
          onChange={(event) => { setText(event.target.value); setInvalid(false); event.currentTarget.setCustomValidity(""); }}
          onBlur={commitTyped}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitTyped(); } }}
        />
        <button
          type="button"
          className="ru-date-toggle"
          aria-label={`${open ? "Закрыть календарь" : "Открыть календарь"}: ${label}`}
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              setYearOpen(false);
              const date = selected ?? today();
              setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
              setFocusDate(selected ?? today());
            }
            setOpen((current) => !current);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="12" rx="2"/><path d="M6 3v4M14 3v4M3 9h14M6.5 12h.01M10 12h.01M13.5 12h.01M6.5 15h.01M10 15h.01"/></svg>
        </button>
      </div>
      {invalid && <span className="ru-date-error" id={`${errorId}-date-error`}>Введите дату в формате ДД.ММ.ГГГГ.</span>}
      {open && (
        <div ref={popover} className="ru-date-popover" style={{ left: popoverPosition.left, top: popoverPosition.top, maxHeight: popoverPosition.maxHeight }} role="dialog" aria-label={`Календарь: ${label}`}>
          <div className="ru-date-monthbar">
            <button type="button" className="ru-date-nav" aria-label="Предыдущий месяц" onClick={() => moveMonth(-1)}>‹</button>
            <select aria-label="Месяц" value={month.getMonth()} onChange={(event) => { setMonth(new Date(month.getFullYear(), Number(event.target.value), 1)); setYearOpen(false); }}>
              {MONTHS.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
            <button ref={yearButton} type="button" className="ru-date-year-toggle" aria-label={`Выбрать год: ${month.getFullYear()}`} aria-expanded={yearOpen} aria-controls={`${errorId}-years`} onClick={() => {
              if (!yearOpen) setYearPage(yearPageFor(month.getFullYear()));
              setYearOpen((current) => !current);
            }}>{month.getFullYear()} <span aria-hidden="true">⌄</span></button>
            <button type="button" className="ru-date-nav" aria-label="Следующий месяц" onClick={() => moveMonth(1)}>›</button>
          </div>
          {yearOpen ? <section className="ru-date-years" id={`${errorId}-years`} aria-label="Выбор года">
            <div className="ru-date-years-nav">
              <button type="button" className="ru-date-nav" aria-label="Предыдущие 12 лет" disabled={yearPage <= 100} onClick={() => setYearPage((year) => Math.max(100, year - 12))}>‹</button>
              <span aria-live="polite">{yearPage}–{yearPage + 11}</span>
              <button type="button" className="ru-date-nav" aria-label="Следующие 12 лет" disabled={yearPage >= 9988} onClick={() => setYearPage((year) => Math.min(9988, year + 12))}>›</button>
            </div>
            <div className="ru-date-years-grid">
              {years.map((year) => <button key={year} type="button" className={year === month.getFullYear() ? "selected" : ""} aria-pressed={year === month.getFullYear()} onClick={() => {
                setMonth(new Date(year, month.getMonth(), 1));
                setFocusDate(null);
                setYearOpen(false);
                yearButton.current?.focus();
              }}>{year}</button>)}
            </div>
          </section> : (
          <div className="ru-date-grid" role="grid" aria-label={`${MONTHS[month.getMonth()]} ${month.getFullYear()}`}>
            {WEEKDAYS.map((day) => <span key={day} className="ru-date-weekday" role="columnheader">{day}</span>)}
            {cells.map((date, index) => {
              if (!date) return <span key={`blank-${index}`} className="ru-date-blank" role="gridcell" />;
              const dateValue = isoDate(date);
              const isSelected = value === dateValue;
              const isToday = isoDate(today()) === dateValue;
              return <button
                key={dateValue}
                type="button"
                role="gridcell"
                data-date={dateValue}
                className={`ru-date-day${isSelected ? " selected" : ""}${isToday ? " today" : ""}`}
                aria-label={`${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`}
                aria-selected={isSelected}
                tabIndex={(focusIsInMonth ? isoDate(focusDate!) === dateValue : isSelected || (!selectedIsInMonth && firstVisibleDate === date)) ? 0 : -1}
                onKeyDown={(event) => handleGridKey(event, date)}
                onClick={() => choose(date)}
              >{date.getDate()}</button>;
            })}
          </div>
          )}
          <div className="ru-date-footer">
            <button type="button" onClick={() => choose(today())}>Сегодня</button>
            <button type="button" onClick={() => { setText(""); setInvalid(false); textInput.current?.setCustomValidity(""); onChange(""); setOpen(false); textInput.current?.focus(); }}>Очистить</button>
          </div>
        </div>
      )}
    </div>
  );
}
