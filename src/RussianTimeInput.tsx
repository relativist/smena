import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./russian-time-input.css";

const pad = (value: number) => String(value).padStart(2, "0");

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
};

export default function RussianTimeInput({ id, value, onChange }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const hourSelect = useRef<HTMLSelectElement>(null);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const [hour, minute] = valid ? value.split(":").map(Number) : [0, 0];

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !root.current || !popover.current) return;
    const place = () => {
      const control = root.current!.getBoundingClientRect();
      const popup = popover.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(control.left, window.innerWidth - popup.width - 8)),
        top: control.bottom + popup.height + 14 <= window.innerHeight
          ? control.bottom + 6
          : Math.max(8, control.top - popup.height - 6),
      });
    };
    place();
    hourSelect.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div className="russian-time-input" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <div className="ru-time-control">
        <input id={id} type="text" inputMode="numeric" placeholder="ЧЧ:ММ"
          maxLength={5} pattern="([01][0-9]|2[0-3]):[0-5][0-9]" required
          title="Время в 24-часовом формате, например 14:00"
          value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" className="ru-time-toggle" ref={toggle}
          aria-label="Выбрать время начала урока" aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </button>
      </div>
      {open && <div className="ru-time-popover" id={popoverId} ref={popover}
        role="group" aria-label="Выбор времени" style={position}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}>
        <div className="ru-time-heading"><strong>{valid ? value : "00:00"}</strong></div>
        <div className="ru-time-columns">
          <label><span>Часы</span><select aria-label="Часы" size={6} value={hour} ref={hourSelect}
            onChange={(event) => onChange(`${pad(Number(event.target.value))}:${pad(minute)}`)}>
            {Array.from({ length: 24 }, (_, index) => <option key={index} value={index}>{pad(index)}</option>)}
          </select></label>
          <label><span>Минуты</span><select aria-label="Минуты" size={6} value={minute}
            onChange={(event) => onChange(`${pad(hour)}:${pad(Number(event.target.value))}`)}>
            {Array.from({ length: 60 }, (_, index) => <option key={index} value={index}>{pad(index)}</option>)}
          </select></label>
        </div>
        <button type="button" className="ru-time-done" onClick={close}>Готово</button>
      </div>}
    </div>
  );
}
