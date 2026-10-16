import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import './info-tooltip.css';

type InfoTooltipProps = {
  label: string;
  children: string;
};

type Position = { top: number; left: number };

export default function InfoTooltip({ label, children }: InfoTooltipProps) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const bubble = tooltipRef.current.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const left = Math.min(
      Math.max(button.left + button.width / 2 - bubble.width / 2, margin),
      window.innerWidth - bubble.width - margin,
    );
    const below = window.innerHeight - button.bottom - margin;
    const top = below >= bubble.height + gap
      ? button.bottom + gap
      : Math.max(margin, button.top - bubble.height - gap);
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)
        && !tooltipRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const closeUnlessFocused = () => {
    if (document.activeElement !== buttonRef.current) setOpen(false);
  };

  return (
    <span
      className="info-tooltip"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (event.relatedTarget !== tooltipRef.current) closeUnlessFocused();
      }}
    >
      <button
        className="info-tooltip__button"
        type="button"
        aria-label={`Подсказка: ${label}`}
        aria-describedby={tooltipId}
        ref={buttonRef}
        // A dialog may autofocus its first control when opened. Show the hint
        // for deliberate keyboard focus, pointer use, or activation only.
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}
        onBlur={(event) => {
          if (event.relatedTarget !== tooltipRef.current) setOpen(false);
        }}
        onClick={() => setOpen(true)}
      >
        i
      </button>
      {open && (
        <span
          className="info-tooltip__bubble"
          id={tooltipId}
          role="tooltip"
          ref={tooltipRef}
          style={{ top: position.top, left: position.left }}
          onMouseLeave={closeUnlessFocused}
        >
          {children}
        </span>
      )}
    </span>
  );
}
