import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './schedule-lesson-card.css';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  compact: boolean;
  abbreviation: string;
  preview: ReactNode;
  previewEnabled?: boolean;
  children: ReactNode;
};

export default function ScheduleLessonCard({
  compact,
  abbreviation,
  preview,
  previewEnabled = true,
  children,
  className = '',
  onClick,
  onDragStart,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  title,
  ...buttonProps
}: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>();
  const tooltipId = useId();

  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => {
    if (previewEnabled) setOpen(true);
  }, [previewEnabled]);

  useEffect(() => {
    if (!compact || !previewEnabled) close();
  }, [compact, previewEnabled, close]);

  useLayoutEffect(() => {
    if (!open || !previewEnabled || !buttonRef.current || !previewRef.current) return;
    const buttonRect = buttonRef.current.getBoundingClientRect();
    const bubbleRect = previewRef.current.getBoundingClientRect();
    const margin = 10;
    const gap = 8;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const left = Math.max(margin, Math.min(
      buttonRect.left + (buttonRect.width - bubbleRect.width) / 2,
      viewportWidth - bubbleRect.width - margin,
    ));
    const above = buttonRect.top - gap - bubbleRect.height;
    const top = above >= margin
      ? above
      : Math.min(buttonRect.bottom + gap, viewportHeight - bubbleRect.height - margin);
    setPosition({ left, top: Math.max(margin, top) });
  }, [open, previewEnabled, preview]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (!compact) {
    return <button {...buttonProps} className={className} onClick={onClick} onDragStart={onDragStart}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocus={onFocus} onBlur={onBlur} title={title}>
      {children}
    </button>;
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    close();
    onClick?.(event);
  };
  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    close();
    onDragStart?.(event);
  };
  const handleMouseEnter = (event: MouseEvent<HTMLButtonElement>) => {
    onMouseEnter?.(event);
    show();
  };
  const handleMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    close();
    onMouseLeave?.(event);
  };
  const handleFocus = (event: FocusEvent<HTMLButtonElement>) => {
    onFocus?.(event);
    if (event.currentTarget.matches(':focus-visible')) show();
  };
  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    close();
    onBlur?.(event);
  };
  const previewRoot = buttonRef.current?.closest('.admin-workspace') ?? document.body;
  const previewClassName = `${className.split(/\s+/).filter((name) => name && name !== 'highlighted').join(' ')} compact-lesson-preview`.trim();

  return <>
    <button
      {...buttonProps}
      ref={buttonRef}
      className={`${className} compact-lesson-card`.trim()}
      aria-describedby={open && previewEnabled ? tooltipId : buttonProps['aria-describedby']}
      onClick={handleClick}
      onDragStart={handleDragStart}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      title={undefined}
    >
      <span className="compact-lesson-abbreviation">{abbreviation}</span>
    </button>
    {open && previewEnabled && createPortal(
      <div
        ref={previewRef}
        id={tooltipId}
        role="tooltip"
        className={previewClassName}
        style={position}
      >
        {preview}
      </div>,
      previewRoot,
    )}
  </>;
}
