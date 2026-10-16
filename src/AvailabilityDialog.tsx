import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogRoom, CatalogTeacher } from "../shared/catalog";
import ActionLabel from "./ActionLabel";
import { api, ApiError, type AuthSession } from "./api";
import {
  validateUnavailabilityRules,
  type UnavailabilityViolation,
  type UnavailabilityRule,
} from "../shared/unavailability";
import RussianDateInput from "./RussianDateInput";
import "./availability.css";

type Props = {
  kind: "teacher" | "room";
  resource: CatalogTeacher | CatalogRoom;
  auth: AuthSession;
  revision: number;
  onUnauthorized: () => void;
  busy: boolean;
  pending: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (rules: UnavailabilityRule[]) => Promise<boolean>;
  onTeacherReplacement?: (rule: UnavailabilityRule) => void;
  onRetry: () => Promise<void>;
  onClose: () => void;
};
type RuleDraft = {
  id?: string;
  startDate: string;
  endDate: string;
  fullDay: boolean;
  start: string;
  end: string;
  recurring: boolean;
  weekdays: number[];
  reason: string;
};
const weekdayLabels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const dayToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const freshDraft = (): RuleDraft => ({
  startDate: dayToday(), endDate: dayToday(), fullDay: true,
  start: "09:00", end: "18:00", recurring: false, weekdays: [], reason: "",
});
function toMinutes(value: string, allow24 = false) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const hours = Number(match[1]); const minutes = Number(match[2]);
  if (allow24 && hours === 24 && minutes === 0) return 1440;
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : Number.NaN;
}
function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}
function ruleToDraft(rule: UnavailabilityRule): RuleDraft {
  const format = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return {
    id: rule.id, startDate: rule.startDate, endDate: rule.endDate,
    fullDay: rule.start === 0 && rule.end === 1440,
    start: format(rule.start), end: format(rule.end),
    recurring: Boolean(rule.weekdays), weekdays: rule.weekdays ?? [], reason: rule.reason ?? "",
  };
}
function ruleLabel(rule: UnavailabilityRule) {
  const range = rule.startDate === rule.endDate ? formatDate(rule.startDate) : `${formatDate(rule.startDate)} — ${formatDate(rule.endDate)}`;
  const time = rule.start === 0 && rule.end === 1440 ? "весь день" : `${ruleToDraft(rule).start}–${ruleToDraft(rule).end}`;
  const days = rule.weekdays ? ` · ${rule.weekdays.map((day) => weekdayLabels[day - 1]).join(", ")}` : "";
  return `${range} · ${time}${days}${rule.reason ? ` · ${rule.reason}` : ""}`;
}
function changedDraftForButton(draft: RuleDraft, editingId: string | null, baseline: RuleDraft) {
  return Boolean(editingId || draft.id || JSON.stringify(draft) !== JSON.stringify(baseline));
}

type PreviewResponse = { revision: number; violations: Array<UnavailabilityViolation & { groupName: string; subjectName: string }> };

export default function AvailabilityDialog({ kind, resource, auth, revision, onUnauthorized, busy, pending, onDirtyChange, onSave, onTeacherReplacement, onRetry, onClose }: Props) {
  const initialRules = resource.unavailability ?? [];
  const [rules, setRules] = useState<UnavailabilityRule[]>(initialRules);
  const [draft, setDraft] = useState<RuleDraft>(freshDraft);
  const blankDraftRef = useRef(freshDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = useMemo(() => JSON.stringify(rules) !== JSON.stringify(initialRules), [rules, initialRules]);
  const hasUncommittedDraft = changedDraftForButton(draft, editingId, blankDraftRef.current);
  useEffect(() => onDirtyChange(dirty || hasUncommittedDraft), [dirty, hasUncommittedDraft, onDirtyChange]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const proposal = useMemo(() => {
    if (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate) return null;
    const changedDraft = changedDraftForButton(draft, editingId, blankDraftRef.current);
    let candidate = rules;
    if (changedDraft) {
      const start = draft.fullDay ? 0 : toMinutes(draft.start);
      const end = draft.fullDay ? 1440 : toMinutes(draft.end, true);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (draft.recurring && !draft.weekdays.length)) return null;
      const item: UnavailabilityRule = {
        id: draft.id ?? editingId ?? "__preview__", startDate: draft.startDate, endDate: draft.endDate,
        start, end, ...(draft.recurring ? { weekdays: draft.weekdays } : {}),
        ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
      };
      candidate = [...rules.filter((rule) => rule.id !== item.id), item];
    }
    const validation = validateUnavailabilityRules(candidate);
    if (validation) return null;
    return candidate;
  }, [draft, rules, editingId]);

  useEffect(() => {
    if (!proposal) {
      setPreview(null);
      setPreviewError("");
      setPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setPreviewError("");
    setPreviewLoading(true);
    const timer = window.setTimeout(() => void api<PreviewResponse>("/api/catalog/availability-preview", {
      method: "POST",
      headers: { "x-csrf-token": auth.csrfToken },
      body: JSON.stringify({ kind, resourceId: resource.id, rules: proposal, revision }),
      signal: controller.signal,
    }).then((result) => {
      if (result.revision !== revision) throw new Error("Данные расписания изменились. Закройте и откройте окно заново.");
      setPreview(result);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) onUnauthorized();
      setPreviewError(reason instanceof ApiError && reason.status === 409 ? "Данные расписания изменились. Закройте и откройте окно заново." : reason instanceof Error ? reason.message : "Не удалось проверить затронутые уроки.");
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false);
    }), 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [proposal, kind, resource.id, revision, auth.csrfToken, onUnauthorized]);

  function resetDraft() { setDraft(freshDraft()); setEditingId(null); setError(""); }
  function patchDraft(patch: Partial<RuleDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }
  function addOrUpdate(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate) { setError("Проверьте даты ограничения."); return; }
    if (draft.recurring && !draft.weekdays.length) { setError("Выберите хотя бы один день недели."); return; }
    const start = draft.fullDay ? 0 : toMinutes(draft.start);
    const end = draft.fullDay ? 1440 : toMinutes(draft.end, true);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { setError("Укажите интервал времени в формате ЧЧ:ММ."); return; }
    if (draft.reason.length > 300) { setError("Причина не должна превышать 300 символов."); return; }
    const rule: UnavailabilityRule = {
      id: draft.id ?? crypto.randomUUID(), startDate: draft.startDate, endDate: draft.endDate,
      start, end, ...(draft.recurring ? { weekdays: [...draft.weekdays].sort() } : {}),
      ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    };
    const next = [...rules.filter((item) => item.id !== rule.id), rule];
    const validation = validateUnavailabilityRules(next);
    if (validation) { setError(validation); return; }
    setRules(next); resetDraft();
  }
  function editRule(rule: UnavailabilityRule) { setDraft(ruleToDraft(rule)); setEditingId(rule.id); setError(""); }
  async function save() {
    if (!formRef.current?.reportValidity()) return;
    const changedDraft = changedDraftForButton(draft, editingId, blankDraftRef.current);
    let nextRules = rules;
    if (changedDraft) {
      if (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate) { setError("Проверьте даты ограничения."); return; }
      if (draft.recurring && !draft.weekdays.length) { setError("Выберите хотя бы один день недели."); return; }
      const start = draft.fullDay ? 0 : toMinutes(draft.start);
      const end = draft.fullDay ? 1440 : toMinutes(draft.end, true);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { setError("Укажите интервал времени в формате ЧЧ:ММ."); return; }
      if (draft.reason.length > 300) { setError("Причина не должна превышать 300 символов."); return; }
      const rule: UnavailabilityRule = {
        id: draft.id ?? editingId ?? crypto.randomUUID(), startDate: draft.startDate, endDate: draft.endDate,
        start, end, ...(draft.recurring ? { weekdays: [...draft.weekdays].sort() } : {}),
        ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
      };
      nextRules = [...rules.filter((item) => item.id !== rule.id), rule];
    }
    const validation = validateUnavailabilityRules(nextRules);
    if (validation) { setError(validation); return; }
    setSaving(true); setError("");
    try {
      if (!(await onSave(nextRules))) setError("Не удалось сохранить. Проверьте сообщение на странице и повторите сохранение.");
    } finally { setSaving(false); }
  }
  const violations = preview?.revision === revision ? preview.violations : null;

  return <div className="availability-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="availability-dialog" role="dialog" aria-modal="true" aria-labelledby="availability-title">
      <header><div><h2 id="availability-title">Недоступность: {resource.name}</h2><p>{kind === "teacher" ? "Затронутые уроки останутся в расписании и потребуют замены учителя." : "Затронутые уроки останутся в расписании и потребуют другого кабинета."}</p></div><button type="button" aria-label="Закрыть" onClick={onClose}>×</button></header>
      <div className="availability-content">
        <form ref={formRef} className="availability-form" onSubmit={addOrUpdate}>
          <h3>{editingId ? "Изменить ограничение" : "Новое ограничение"}</h3>
          <div className="availability-dates">
            <label><span>С даты</span><RussianDateInput label="С даты" value={draft.startDate} onChange={(value) => patchDraft({ startDate: value })} /></label>
            <label><span>По дату</span><RussianDateInput label="По дату" value={draft.endDate} onChange={(value) => patchDraft({ endDate: value })} /></label>
          </div>
          <label className="availability-check"><input type="checkbox" checked={draft.fullDay} onChange={(event) => patchDraft({ fullDay: event.target.checked })} /><span>Весь день</span></label>
          {!draft.fullDay && <div className="availability-times"><label>С<input type="text" inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5} pattern="([01][0-9]|2[0-3]):[0-5][0-9]" title="24-часовой формат, например 09:30" value={draft.start} onChange={(event) => patchDraft({ start: event.target.value })} required /></label><label>По<input type="text" inputMode="numeric" placeholder="ЧЧ:ММ" maxLength={5} pattern="(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)" title="24-часовой формат, например 15:30 или 24:00" value={draft.end} onChange={(event) => patchDraft({ end: event.target.value })} required /></label></div>}
          <label className="availability-check"><input type="checkbox" checked={draft.recurring} onChange={(event) => patchDraft({ recurring: event.target.checked })} /><span>Повторять по дням недели в этом периоде</span></label>
          {draft.recurring && <div className="availability-weekdays">{weekdayLabels.map((day, index) => <label key={day}><input type="checkbox" checked={draft.weekdays.includes(index + 1)} onChange={(event) => setDraft((current) => ({ ...current, weekdays: event.target.checked ? [...current.weekdays, index + 1] : current.weekdays.filter((value) => value !== index + 1) }))} />{day}</label>)}</div>}
          <label>Причина <input maxLength={300} value={draft.reason} onChange={(event) => patchDraft({ reason: event.target.value })} placeholder="Например, больничный или ремонт" /></label>
          {error && <div className="availability-error" role="alert">{error}{pending && <button type="button" onClick={() => void onRetry()} disabled={busy}>Повторить сохранение</button>}</div>}
          <div className="availability-actions"><button type="submit" className="availability-primary"><ActionLabel action={editingId ? "edit" : "add"}>{editingId ? "Обновить ограничение" : "Добавить ограничение"}</ActionLabel></button>{editingId && <button type="button" onClick={resetDraft}>Отмена</button>}</div>
        </form>
        <div className="availability-side">
          <section className="availability-rule-section"><h3>Ограничения ({rules.length})</h3>{rules.length ? <ul>{rules.map((rule) => <li key={rule.id}><span>{ruleLabel(rule)}</span><div><button type="button" onClick={() => editRule(rule)}><ActionLabel action="edit">Изменить</ActionLabel></button>{kind === "teacher" && onTeacherReplacement && <button type="button" disabled={busy || saving || dirty || hasUncommittedDraft} onClick={() => onTeacherReplacement(rule)}><ActionLabel action="replace">Найти заменяющих</ActionLabel></button>}<button type="button" className="availability-remove" onClick={() => { setRules(rules.filter((item) => item.id !== rule.id)); if (editingId === rule.id) resetDraft(); }}><ActionLabel action="delete">Удалить</ActionLabel></button></div></li>)}</ul> : <p className="availability-empty">Ограничений пока нет.</p>}</section>
          <section className="availability-preview"><h3>Затронутые уроки {violations ? `(${violations.length})` : ""}</h3><p>Показываем занятия, которые пересекаются с выбранным ограничением.</p>{!proposal ? <div className="availability-no-impact">Заполните даты и время, чтобы увидеть уроки.</div> : previewLoading ? <div className="availability-no-impact">Проверяем расписание…</div> : previewError ? <div className="availability-no-impact" role="status">{previewError}</div> : violations ? violations.length ? <ul>{violations.map((item, index) => <li key={`${item.lessonId}-${item.ruleId}-${index}`}><strong className="school-code">{item.groupName || item.groupId}</strong><span>{formatDate(item.date)} · {String(Math.floor(item.start / 60)).padStart(2, "0")}:{String(item.start % 60).padStart(2, "0")}–{String(Math.floor(item.end / 60)).padStart(2, "0")}:{String(item.end % 60).padStart(2, "0")}</span><small>{item.subjectName || "Урок"}</small></li>)}</ul> : <div className="availability-no-impact">Пересекающихся уроков нет.</div> : <div className="availability-no-impact">Проверяем расписание…</div>}</section>
        </div>
      </div>
      <footer><button type="button" onClick={onClose} disabled={busy || saving}>Закрыть</button><button type="button" className="availability-primary" onClick={() => void save()} disabled={busy || saving}><ActionLabel action="save">{busy || saving ? "Сохраняем…" : kind === "teacher" ? "Сохранить" : changedDraftForButton(draft, editingId, blankDraftRef.current) ? "Сохранить правило" : "Сохранить ограничения"}</ActionLabel></button></footer>
    </section>
  </div>;
}
