import { createId } from "../shared/createId.ts";
import SchoolName from "./SchoolSettings";
import InfoTooltip from "./InfoTooltip";
import ScheduleGroupSelect from "./ScheduleGroupSelect";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type DragEvent,
  type Ref,
} from "react";
import {
  editorSubjects,
  countPlanLessons,
  teacherChoices,
  type EditorAssignment,
  type EditorSubject as Subject,
} from "./catalogAdapter";
import { newRoomConflict, roomConflictMessage } from "../shared/roomConflicts";
import { newTeacherConflict, teacherConflictMessage } from "../shared/teacherConflicts";
import { teacherLabel, teacherInitials, roomKinds } from "../shared/catalog";
import SubjectIcon from "./SubjectIcon";
import { resolveSubjectIconId } from "../shared/subjectIcons.ts";
import { newRoomSuitabilityViolation, roomSuitabilityReason, roomSuitabilityViolationMessage } from "../shared/roomSuitability";
import { choosePlacementRoom } from "./roomChoice";
import { calendarDay, defaultSchoolCalendar, studyWeekdays } from "../shared/schoolCalendar";
import { inQuarter, quarterWeeks, weekOffsetFor, weekDates, visibleQuarters } from "../shared/plans";
import { bellBreak, defaultBellSettings, effectiveBellProfile } from "../shared/bellSchedule";
import { applyDayTiming } from "../shared/dayTiming";
import DayTimeForm from "./DayTimeForm";
import TeacherReplacementDialog from "./TeacherReplacementDialog";
import ScheduleCopyDialog from "./ScheduleCopyDialog";
import JointLessonDialog from "./JointLessonDialog";
import PublicationDialog from "./PublicationDialog";
import QuarterPlanDialog from "./QuarterPlanDialog";
import { newUnavailabilityViolation, scheduledUnavailability, unavailabilityViolationMessage } from "../shared/unavailability";

import {
  key,
  timeLabel,
  placeLesson,
  moveLesson,
  removeLesson,
  editLesson,
  setSlotTime,
  setBreak,
  appendSlot,
  removeEmptySlot,
  canPlace,
  canSwapLessons,
  swapLessons,
  teacherPlacementConflicts,
  transferTeacherLesson,
  formatTime,
  roomOccupancies,
  type Schedule,
  type EditorLesson,
  type Location,
} from "./editor";
import AutoScheduleDialog from "./AutoScheduleDialog";
import ClearScheduleDialog from "./ClearScheduleDialog";
import ServiceEventDialog from "./ServiceEventDialog";
import { LessonForm, TimeForm, BreakForm, type LessonValues } from "./EditorForms";
import type { EditorPreviewResponse, StateResponse } from "../server/contracts";
import { api, ApiError, type AuthSession } from "./api";
import { withBasePath } from "./basePath";
import { useAutosave } from "./useAutosave";
import ScheduleLessonCard from "./ScheduleLessonCard";
import "./admin-navigation.css";

type IconName =
  | "calendar"
  | "left"
  | "right"
  | "search"
  | "book"
  | "clock"
  | "pin"
  | "people"
  | "close"
  | "info"
  | "check"
  | "grip"
  | "arrow"
  | "leaf"
  | "wand"
  | "trash"
  | "publish"
  | "print"
  | "logout"
  | "menu"
  | "plan"
  | "catalog"
  | "settings"
  | "chevron";
const paths: Record<IconName, ReactNode> = {
  settings: <path d="M5 3v5m0 4v9M12 3v10m0 4v4M19 3v2m0 4v12M2 10h6M9 15h6M16 7h6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2" />
    </>
  ),
  wand: <><path d="m4 20 12-12 4 4L8 24Z" transform="translate(0 -3)"/><path d="m4 3 .5 2.5L7 6l-2.5.5L4 9l-.5-2.5L1 6l2.5-.5ZM17 2v3m-1.5-1.5h3"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  publish: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></>,
  print: <><path d="M6 9V3h12v6M6 18H4V9h16v9h-2M6 14h12v7H6zM17 12h.01"/></>,
  logout: <><path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h12"/></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
  plan: <><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></>,
  catalog: <><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h4"/></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  book: (
    <>
      <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" />
      <path d="M12 5v15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pin: (
    <>
      <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m2 9v-2a6 6 0 0 0-3-5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  grip: (
    <>
      <path
        d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
        strokeWidth="3"
      />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  leaf: (
    <>
      <path d="M19 4C7 2 2 10 6 16s16 2 13-12Z" />
      <path d="m5 21 9-12" />
    </>
  ),
};
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const weekdays = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const weekdayIndex = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const weekdayName = (date: string) => weekdays[weekdayIndex(date)];
const compactSubgroupSlot = (lessons: EditorLesson[]) => lessons.length > 1
  && lessons.every(lesson => !lesson.event && Boolean(lesson.subgroupId || lesson.subgroup));
const compactSubjectName = (name: string) => {
  const letters = (name.match(/\p{L}/gu) ?? []).slice(0, 3);
  if (letters.length) letters[0] = letters[0].toLocaleUpperCase("ru");
  return letters.join("") || "—";
};
const dateLabel = (value: string, long = false) =>
  new Date(`${value}T12:00:00`)
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: long ? "long" : "short",
    })
    .replace(" г.", "");
type Detail = { location: Location; id: string };
type Placement = {
  lesson: Omit<EditorLesson, "id">;
  from?: { location: Location; id: string };
};
type TimeDialog = {
  location: Location;
  kind: "time" | "break";
  wholeDay?: boolean;
};
type UndoEntry = { schedule: Schedule; label: string; location: Location };
function Modal({
  title,
  children,
  close,
  hint,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".modal-head .icon-button")?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="modal-head">
        <h2 id="dialog-title">{title}{hint && <InfoTooltip label={title}>{hint}</InfoTooltip>}</h2>
        <button className="icon-button" autoFocus onClick={close} aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

type LessonDialogHandle = { setDetail: (detail: Detail | null) => void };

// Opening a lesson only updates this small subtree. The calendar and palette
// keep their rendered state instead of rebuilding before the dialog can paint.
function LessonDetailsDialog({ controller, schedule, catalog, subjects, groupId, close, onSave, onDelete, onMove, onRepeat, onJoint }: {
  controller: Ref<LessonDialogHandle>;
  schedule: Schedule;
  catalog: StateResponse["catalog"];
  subjects: Subject[];
  groupId: string;
  close: () => void;
  onSave: (detail: Detail, value: LessonValues) => void;
  onDelete: (detail: Detail) => void;
  onMove: (detail: Detail, lesson: EditorLesson) => void;
  onRepeat: (detail: Detail) => void;
  onJoint: (detail: Detail) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  useImperativeHandle(controller, () => ({ setDetail }), []);
  const day = detail ? schedule[key(detail.location.groupId, detail.location.weekOffset)]?.find(day => day.date === detail.location.date) : undefined;
  const lesson = detail && day ? day.slots[detail.location.slot]?.find(lesson => lesson.id === detail.id) : undefined;
  if (!detail || !day || !lesson) return null;
  return <Modal title={lesson.event ?? subjects.find(subject => subject.id === lesson.subjectId)?.name ?? "Занятие"} close={close}>
    <LessonForm
      key={lesson.id}
      day={day}
      slot={detail.location.slot}
      lesson={lesson}
      catalog={catalog}
      schedule={schedule}
      groupId={groupId}
      close={close}
      onSave={value => onSave(detail, value)}
      onDelete={() => onDelete(detail)}
      onMove={() => onMove(detail, lesson)}
      onRepeat={() => onRepeat(detail)}
      onJoint={() => onJoint(detail)}
    />
  </Modal>;
}

export default function App({
  initialState,
  auth,
  onUnauthorized,
  onLogout,
  onReload,
  onOpenCatalog,
  onOpenPlan,
  onOpenPlanCoverage,
  onOpenCalendar,
  onOpenBells,
  onOpenDisplaySettings,
  onOpenDocumentation,
  onOpenTeacherLoad,
  onOpenReassignments,
  onOpenPrint,
  initialGroupId,
  initialQuarterId,
}: {
  initialState: StateResponse;
  auth: AuthSession;
  onUnauthorized: () => void;
  onLogout: () => Promise<void>;
  onReload: () => Promise<void>;
  onOpenCatalog: (groupId: string, quarterId: string) => Promise<void>;
  onOpenPlan: (groupId: string, quarterId: string) => Promise<void>;
  onOpenPlanCoverage: (groupId: string, quarterId: string) => Promise<void>;
  onOpenCalendar: (groupId: string, quarterId: string) => Promise<void>;
  onOpenBells: (groupId: string, quarterId: string) => Promise<void>;
  onOpenDisplaySettings: (groupId: string, quarterId: string) => Promise<void>;
  onOpenDocumentation: (groupId: string, quarterId: string) => Promise<void>;
  onOpenTeacherLoad: (groupId: string, quarterId: string) => Promise<void>;
  onOpenReassignments: (groupId: string, quarterId: string) => Promise<void>;
  onOpenPrint: (groupId: string, quarterId: string, date: string) => Promise<void>;
  initialGroupId?: string;
  initialQuarterId?: string;
}) {
  const [editorState, setEditorState] = useState(initialState);
  const [scopedMode] = useState(initialState.editorBootstrap === true);
  const [scopeLoading, setScopeLoading] = useState(scopedMode);
  const [scopeError, setScopeError] = useState("");
  const [scopeAttempt, setScopeAttempt] = useState(0);
  const scopeBase = useRef<Schedule | null>(null);
  const scopeCounts = useRef<StateResponse["editorScope"]>(undefined);
  const preservedDragWeek = useRef<{ key: string; days: Schedule[string] } | null>(null);
  const catalog = editorState.catalog;
  const showSubjectIcons = editorState.displaySettings?.settings.adminSubjectIcons ?? true;
  const calendar = editorState.calendar ?? defaultSchoolCalendar();
  const groups = catalog.groups.map((entry) => ({
    ...entry,
    leader:
      catalog.teachers.find((item) => item.id === entry.leaderId)?.name ??
      "Не назначен",
    room: catalog.rooms.find((item) => item.id === entry.roomId)?.name ?? "—",
  }));
  const [schedule, setSchedule] = useState(initialState.schedule);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const copyState = useMemo(() => ({ ...editorState, schedule }), [editorState, schedule]);
  const save = useAutosave(initialState, auth.csrfToken, onUnauthorized);
  async function applyBulkOperation(operation: "clear" | "copy" | "joint" | "event", options: Record<string, unknown>) {
    if (scopeLoading || scopeError) throw new Error("Сначала загрузите выбранную неделю.");
    if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
    const response = await api<{ revision: number; updatedAt: string; changedDays?: unknown[] }>("/api/schedule-operations/apply", {
      method: "POST",
      headers: { "x-csrf-token": auth.csrfToken },
      body: JSON.stringify({ revision: save.currentRevision(), requestId: createId(), operation, options }),
    });
    if (!Number.isInteger(response.revision)) throw new Error("Сервер не подтвердил изменение расписания.");
    setHistory([]);
    setPlacement(null);
    setNotice({ text: "Расписание обновлено", error: false });
    setScopeAttempt(value => value + 1);
  }
  const [loggingOut, setLoggingOut] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [history, setHistory] = useState<UndoEntry[]>([]);
  const groupStorageKey = `smena:admin:last-group:${auth.username}`;
  const [groupId, setGroupId] = useState(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(groupStorageKey); } catch { /* Storage may be disabled. */ }
    return groups.find((entry) => entry.id === initialGroupId)?.id
      ?? groups.find((entry) => entry.id === stored && !entry.archived)?.id
      ?? groups.find((entry) => !entry.archived)!.id;
  });
  useEffect(() => {
    try { localStorage.setItem(groupStorageKey, groupId); } catch { /* Selection still works without storage. */ }
  }, [groupStorageKey, groupId]);
  const today = new Date().toLocaleDateString("en-CA");
  const activeQuarters = visibleQuarters(editorState.quarters);
  const [quarterId, setQuarterId] = useState(
    activeQuarters.find((entry) => entry.id === initialQuarterId)?.id ??
      activeQuarters.find((entry) => inQuarter(today, entry))?.id ??
      activeQuarters[0].id,
  );
  const quarter = editorState.quarters.find(
    (entry) => entry.id === quarterId,
  )!;
  const offsets = quarterWeeks(quarter);
  const [weekOffset, setWeekOffset] = useState(() =>
    offsets.includes(weekOffsetFor(today)) ? weekOffsetFor(today) : offsets[0],
  );
  useEffect(() => {
    if (!scopedMode) return;
    let active = true;
    const controller = new AbortController();
    setScopeLoading(true);
    setScopeError("");
    void (async () => {
      try {
        if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
        const params = new URLSearchParams({ groupId, quarterId, weekOffset: String(weekOffset) });
        const scoped = await api<StateResponse>(`/api/editor/week?${params}`, { signal: controller.signal });
        if (!active) return;
        const nextSchedule = preservedDragWeek.current
          ? { ...scoped.schedule, [preservedDragWeek.current.key]: preservedDragWeek.current.days }
          : scoped.schedule;
        setEditorState({ ...initialState, ...scoped, schedule: nextSchedule, editorBootstrap: true });
        setSchedule(nextSchedule);
        scopeBase.current = nextSchedule;
        scopeCounts.current = scoped.editorScope;
        setHistory([]);
        if (!save.reset(nextSchedule, scoped.revision))
          throw new Error("Дождитесь сохранения изменений и повторите загрузку недели.");
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onUnauthorized();
        setScopeError(error instanceof Error ? error.message : "Не удалось загрузить неделю.");
      } finally {
        if (active) setScopeLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [scopedMode, groupId, quarterId, weekOffset, scopeAttempt]);
  const schoolYear =
    Number(quarter.startDate.slice(0, 4)) -
    (Number(quarter.startDate.slice(5, 7)) < 8 ? 1 : 0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [paletteRoomId, setPaletteRoomId] = useState("");
  const [autoScheduleOpen, setAutoScheduleOpen] = useState(false);
  const [clearScheduleOpen, setClearScheduleOpen] = useState(false);
  const [replacementLessonIds, setReplacementLessonIds] = useState<string[] | null>(null);
  const [copySource, setCopySource] = useState<{ groupId: string; weekOffset: number; lessonId?: string } | null>(null);
  const [jointSource, setJointSource] = useState<{ groupId: string; lessonId: string } | null>(null);
  const [serviceEvent, setServiceEvent] = useState<{
    title: string;
    location?: Location;
    lessonId?: string;
    contextSchedule?: Schedule;
  } | null>(null);
  useEffect(() => {
    setPaletteRoomId("");
    setPlacement(null);
  }, [selected, groupId, quarterId]);
  const [onlyRemaining, setOnlyRemaining] = useState(false);
  const [dialog, setDialog] = useState<"hours" | null>(null);
  const detailRef = useRef<Detail | null>(null);
  const lessonDialogRef = useRef<LessonDialogHandle>(null);
  function setDetail(detail: Detail | null) {
    detailRef.current = detail;
    lessonDialogRef.current?.setDetail(detail);
  }
  const [timeDialog, setTimeDialog] = useState<TimeDialog | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [dragging, setDragging] = useState<Placement | null>(null);
  const [teacherTransfer, setTeacherTransfer] = useState<{
    location: Location;
    payload: Placement;
  } | null>(null);
  const [transferError, setTransferError] = useState("");
  const [hovered, setHovered] = useState("");
  const [serverTargets, setServerTargets] = useState<EditorPreviewResponse["targets"]>([]);
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const dragRef = useRef<Placement | null>(null);
  const weekDragTimer = useRef<{ offset: number; timer: number } | null>(null);
  const [dragWeek, setDragWeek] = useState<number | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const group = groups.find((item) => item.id === groupId)!;
  const bellProfile = effectiveBellProfile(editorState.bellSettings ?? defaultBellSettings(), groupId);
  const week = schedule[key(groupId, weekOffset)] ?? [];
  const weekStartDate = week[0]?.date ?? quarter.startDate;
  const visibleWeek = week.filter((day) => weekdayIndex(day.date) < 5
    || studyWeekdays(calendar, groupId).includes(weekdayIndex(day.date) + 1)
    || !day.holiday || day.slots.some((slot) => slot.length > 0));
  const unavailableLessons = useMemo(() => scheduledUnavailability(schedule, catalog), [schedule, catalog]);
  const unavailableById = useMemo(() => {
    const result = new Map<string, typeof unavailableLessons>();
    for (const violation of unavailableLessons) result.set(violation.lessonId, [...(result.get(violation.lessonId) ?? []), violation]);
    return result;
  }, [unavailableLessons]);
  const replacementIds = [...new Set(unavailableLessons.filter(entry => entry.kind === "teacher" && inQuarter(entry.date, quarter)).map(entry => entry.lessonId))];
  const allSubjects = useMemo(
    () => editorSubjects(catalog, groupId, quarterId, editorState.studyPlans),
    [catalog, groupId, quarterId, editorState.studyPlans],
  );
  const subjects = allSubjects.filter(
    (subject) => subject.assignments.length > 0,
  );
  const activePlacement = dragging ?? placement;
  const previewPayload = activePlacement ? {
    lesson: activePlacement.lesson,
    ...(activePlacement.from ? { from: activePlacement.from } : {}),
  } : null;
  const previewSignature = previewPayload ? JSON.stringify({
    revision: save.revision, groupId, quarterId, weekOffset,
    payload: previewPayload,
    autoRoom: !paletteRoomId && !activePlacement?.from && !activePlacement?.lesson.event,
    saveStatus: save.status.kind,
  }) : "";
  const [serverTargetsSignature, setServerTargetsSignature] = useState("");
  useEffect(() => {
    if (!scopedMode || !activePlacement || scopeLoading || save.status.kind !== "saved") {
      setServerTargets([]);
      setServerTargetsSignature("");
      return;
    }
    let active = true;
    const controller = new AbortController();
    const params = {
      revision: save.currentRevision(),
      groupId,
      quarterId,
      weekOffset,
      payload: previewPayload!,
      autoRoom: !paletteRoomId && !activePlacement.from && !activePlacement.lesson.event,
    };
    void api<EditorPreviewResponse>("/api/editor/preview", {
      method: "POST",
      headers: { "x-csrf-token": auth.csrfToken },
      body: JSON.stringify(params),
      signal: controller.signal,
    }).then((result) => {
      if (active && result.revision === save.currentRevision()) {
        setServerTargets(result.targets);
        setServerTargetsSignature(previewSignature);
      }
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onUnauthorized();
        setNotice({ text: error instanceof Error ? error.message : "Не удалось проверить места", error: true });
      }
    });
    return () => { active = false; controller.abort(); };
  }, [scopedMode, activePlacement, scopeLoading, save.status.kind, save.revision, groupId, quarterId, weekOffset, paletteRoomId, auth.csrfToken]);
  const selectedSubject =
    subjects.find((subject) => subject.id === selected) ?? subjects[0];
  const assignmentScope = `${groupId}|${quarterId}|${selectedSubject?.id ?? ""}`;
  const [paletteAssignmentChoice, setPaletteAssignmentChoice] = useState({ scope: "", id: "" });
  const selectedAssignment = selectedSubject?.assignments.length === 1
    ? selectedSubject.assignments[0]
    : selectedSubject?.assignments.find(assignment =>
      paletteAssignmentChoice.scope === assignmentScope && assignment.id === paletteAssignmentChoice.id);
  const paletteReady = Boolean(selectedAssignment);
  // Until a subgroup is chosen, show each teacher once as an inactive preview.
  const paletteSubject = selectedSubject ? { ...selectedSubject,
    assignments: selectedAssignment ? [selectedAssignment] : selectedSubject.assignments.slice(0, 1),
  } : undefined;
  const isHoliday = week.every((day) => day.holiday);
  const lessonCount = week.reduce(
    (n, day) => n + day.slots.filter((slot) => slot.length > 0).length,
    0,
  );
  function planned(item: EditorAssignment) {
    if (scopedMode && scopeBase.current && scopeCounts.current) {
      const entry = scopeCounts.current.counts.find((count) =>
        count.subjectId === item.subjectId &&
        count.subgroupId === (item.subgroupId ?? null) &&
        count.lessonKind === item.lessonKind,
      );
      const scopedCount = (value: Schedule) => {
        const ids = new Set<string>();
        for (const [scheduleKey, days] of Object.entries(value)) {
          if (!scheduleKey.startsWith(`${groupId}:`)) continue;
          for (const day of days) {
            if (day.date < quarter.startDate || day.date > quarter.endDate) continue;
            for (const slot of day.slots) for (const lesson of slot) {
              const whole = !lesson.subgroupId && !lesson.subgroup;
              if (lesson.subjectId === item.subjectId &&
                (lesson.lessonKind ?? "regular") === item.lessonKind &&
                (item.subgroupId ? whole || lesson.subgroupId === item.subgroupId : whole) &&
                !lesson.event) ids.add(lesson.id);
            }
          }
        }
        return ids.size;
      };
      return (entry?.count ?? 0) + scopedCount(schedule) - scopedCount(scopeBase.current);
    }
    return countPlanLessons(
      schedule,
      groupId,
      quarter,
      item.subjectId,
      item.subgroupId,
      item.lessonKind,
    );
  }
  function hasDeficit(subject: Subject) {
    return subject.assignments.some((item) => planned(item) < item.target);
  }
  const visibleSubjects = subjects.filter(
    (subject) =>
      `${subject.name} ${subject.shortName}`
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")) &&
      (!onlyRemaining || hasDeficit(subject)),
  );
  const deficits = subjects.filter(hasDeficit).length;
  const palette = (
    paletteSubject
      ? teacherChoices(catalog, paletteSubject, paletteRoomId || undefined)
      : []
  ).map((item) => ({
    ...item,
    planned: planned(item),
  }));
  const paletteRoomReasons = new Map(catalog.rooms.map((room) => {
    const reasons = paletteSubject?.assignments.map((assignment) => roomSuitabilityReason(catalog, {
      subjectId: paletteSubject!.id, lessonKind: assignment.lessonKind,
      groupId, subgroupId: assignment.subgroupId, roomId: room.id,
    })) ?? [];
    return [room.id, reasons.length && reasons.every(Boolean) ? [...new Set(reasons)].join(" · ") : ""] as const;
  }));
  function subjectLabel(subject: Subject) {
    if (subject.assignments.length === 1)
      return `${planned(subject.assignments[0])} / ${subject.assignments[0].target}`;
    return `${subject.assignments.length} назначения`;
  }
  function locationFor(date: string, slot: number): Location {
    return { groupId, weekOffset, date, slot };
  }
  function applyChange(
    transform: (value: Schedule) => Schedule,
    label: string,
    location: Location,
  ) {
    if (loggingOut || reloading || scopeLoading || scopeError) return;
    const next = transform(schedule);
    if (next === schedule) return;
    const roomSuitability = newRoomSuitabilityViolation(next, schedule, catalog);
    if (roomSuitability) throw new Error(roomSuitabilityViolationMessage(roomSuitability, catalog));
    const unavailable = newUnavailabilityViolation(next, schedule, catalog);
    if (unavailable) throw new Error(unavailabilityViolationMessage(unavailable, catalog));
    const roomConflict = newRoomConflict(next, schedule);
    if (roomConflict)
      throw new Error(roomConflictMessage(roomConflict, catalog));
    const teacherConflict = newTeacherConflict(next, schedule);
    if (teacherConflict)
      throw new Error(teacherConflictMessage(teacherConflict, catalog));
    setHistory((entries) => [
      ...entries.slice(-29),
      { schedule, label, location },
    ]);
    setSchedule(next);
    save.queue(next);
    setNotice({ text: label });
  }
  async function logout() {
    setLoggingOut(true);
    try {
      if (await save.flush()) await onLogout();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      )
        onUnauthorized();
      setNotice({
        text: error instanceof Error ? error.message : "Не удалось выйти",
        error: true,
      });
    } finally {
      setLoggingOut(false);
    }
  }
  async function reloadSaved() {
    setReloading(true);
    try {
      await onReload();
      setReloadConfirm(false);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "Не удалось загрузить расписание",
        error: true,
      });
    } finally {
      setReloading(false);
    }
  }
  async function openAutoSchedule() {
    if (await save.flush()) setAutoScheduleOpen(true);
    else setNotice({ text: "Сначала сохраните изменения текущей недели.", error: true });
  }
  async function openPublication() {
    if (loggingOut || reloading) return;
    setReloading(true);
    try {
      if (await save.flush()) {
        setDetail(null);
        setPlacement(null);
        setPublicationOpen(true);
      } else {
        setNotice({ text: "Сначала сохраните черновик или устраните ошибку сохранения.", error: true });
      }
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть публикацию", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openClearSchedule() {
    if (loggingOut || reloading) return;
    if (!(await save.flush())) {
      setNotice({ text: "Сначала сохраните изменения текущей недели.", error: true });
      return;
    }
    setClearScheduleOpen(true);
  }
  async function openScheduleCopy(source: { groupId: string; weekOffset: number; lessonId?: string }) {
    if (loggingOut || reloading) return;
    setReloading(true);
    try {
      if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
      setDetail(null);
      setPlacement(null);
      setCopySource(source);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть копирование", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openJointLesson(source: { groupId: string; lessonId: string }) {
    if (loggingOut || reloading) return;
    setReloading(true);
    try {
      if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
      setDetail(null);
      setPlacement(null);
      setJointSource(source);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть объединение групп", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openReplacements(ids: string[]) {
    setReloading(true);
    try {
      if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
      setReplacementLessonIds(ids);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось загрузить уроки для замены", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openServiceEvent(value: NonNullable<typeof serviceEvent>) {
    if (loggingOut || reloading) return;
    setReloading(true);
    try {
      if (!(await save.flush())) throw new Error("Сначала сохраните изменения текущей недели.");
      let contextSchedule = schedule;
      if (scopedMode && value.location) {
        const context = await api<{ revision: number; schedule: Schedule }>(
          `/api/schedule-operations/event-context?${new URLSearchParams({ date: value.location.date })}`,
        );
        if (context.revision !== save.currentRevision())
          throw new Error("Расписание изменилось. Обновите неделю перед размещением мероприятия.");
        contextSchedule = context.schedule;
      }
      setDetail(null);
      setServiceEvent({ ...value, contextSchedule });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть мероприятие", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openPlan() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenPlan(groupId, quarterId);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error ? error.message : "Не удалось открыть план",
        error: true,
      });
    } finally {
      setReloading(false);
    }
  }
  async function openPlanCoverage() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenPlanCoverage(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть выполнение учебных планов", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openCalendar() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenCalendar(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть календарь", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openTeacherLoad() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenTeacherLoad(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть нагрузку учителей", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openBells() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenBells(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть настройки времени", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openDisplaySettings() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenDisplaySettings(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть настройки отображения", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openDocumentation() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenDocumentation(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть документацию", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openReassignments() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenReassignments(groupId, quarterId);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть замены учителей", error: true });
    } finally {
      setReloading(false);
    }
  }
  async function openCatalog() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenCatalog(groupId, quarterId);
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "Не удалось открыть справочники",
        error: true,
      });
    } finally {
      setReloading(false);
    }
  }
  async function openPrint() {
    setReloading(true);
    try {
      if (await save.flush()) await onOpenPrint(groupId, quarterId, week.find(day => inQuarter(day.date, quarter))?.date ?? quarter.startDate);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось открыть печать расписания", error: true });
    } finally {
      setReloading(false);
    }
  }
  function attempt(action: () => void) {
    try {
      action();
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "Не удалось выполнить действие",
        error: true,
      });
    }
  }
  function undo() {
    if (loggingOut || reloading || scopeLoading || scopeError) return;
    const last = history.at(-1);
    if (!last) return;
    const unavailable = newUnavailabilityViolation(last.schedule, schedule, catalog);
    if (unavailable) {
      setNotice({ text: `Отмена невозможна: ${unavailabilityViolationMessage(unavailable, catalog)}`, error: true });
      return;
    }
    const roomSuitability = newRoomSuitabilityViolation(last.schedule, schedule, catalog);
    if (roomSuitability) {
      setNotice({ text: roomSuitabilityViolationMessage(roomSuitability, catalog), error: true });
      return;
    }
    const conflict = newRoomConflict(last.schedule, schedule);
    if (conflict) {
      setNotice({ text: roomConflictMessage(conflict, catalog), error: true });
      return;
    }
    const teacherConflict = newTeacherConflict(last.schedule, schedule);
    if (teacherConflict) {
      setNotice({ text: teacherConflictMessage(teacherConflict, catalog), error: true });
      return;
    }
    setSchedule(last.schedule);
    save.queue(last.schedule);
    setHistory((entries) => entries.slice(0, -1));
    setGroupId(last.location.groupId);
    setWeekOffset(last.location.weekOffset);
    const undoQuarter = editorState.quarters.find((entry) =>
      inQuarter(last.location.date, entry),
    );
    if (undoQuarter) setQuarterId(undoQuarter.id);
    setDetail(null);
    setTimeDialog(null);
    setPlacement(null);
    setNotice({ text: `Отменено: ${last.label.toLocaleLowerCase("ru")}` });
  }
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "Escape") {
        setPlacement(null);
        endDrag();
        setNavOpen(false);
        if (target.closest(".admin-rail")) target.blur();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        !detailRef.current &&
        !timeDialog &&
        !dialog &&
        !autoScheduleOpen &&
        !clearScheduleOpen &&
        !teacherTransfer &&
        !replacementLessonIds &&
        !copySource &&
        !jointSource &&
        !serviceEvent
      ) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const showWeek = (offset: number) => {
    const source = dragRef.current?.from?.location;
    if (source && source.weekOffset !== offset) {
      const sourceKey = key(source.groupId, source.weekOffset);
      const days = schedule[sourceKey];
      if (days) preservedDragWeek.current = { key: sourceKey, days };
    }
    setWeekOffset(offset);
    setHovered("");
    setDetail(null);
    setTimeDialog(null);
  };
  function beginDrag(event: DragEvent, payload: Placement) {
    dragRef.current = payload;
    setDragging(payload);
    setPlacement(null);
    event.dataTransfer.effectAllowed = payload.from ? "move" : "copy";
    event.dataTransfer.setData("text/plain", payload.lesson.subjectId);
  }
  function endDrag() {
    dragRef.current = null;
    setDragging(null);
    setHovered("");
    preservedDragWeek.current = null;
    cancelWeekDrag();
  }
  function cancelWeekDrag() {
    if (weekDragTimer.current) window.clearTimeout(weekDragTimer.current.timer);
    weekDragTimer.current = null;
    setDragWeek(null);
  }
  function hoverDragWeek(event: DragEvent, offset: number) {
    if (!dragRef.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
    setHovered("");
    if (offset === weekOffset || weekDragTimer.current?.offset === offset) return;
    cancelWeekDrag();
    setDragWeek(offset);
    weekDragTimer.current = { offset, timer: window.setTimeout(() => {
      weekDragTimer.current = null;
      setDragWeek(null);
      if (dragRef.current) showWeek(offset);
    }, 650) };
  }
  useEffect(() => {
    const finish = () => endDrag();
    window.addEventListener("dragend", finish);
    return () => {
      window.removeEventListener("dragend", finish);
      if (weekDragTimer.current) window.clearTimeout(weekDragTimer.current.timer);
    };
  }, []);
  function targetAction(location: Location, payload: Placement) {
    if (!payload.from && !paletteRoomId && !payload.lesson.event)
      payload = { ...payload, lesson: choosePlacementRoom(schedule, location, payload.lesson, catalog) };
    const entries = schedule[key(location.groupId, location.weekOffset)]
      ?.find((day) => day.date === location.date)?.slots[location.slot] ?? [];
    const from = payload.from?.location;
    const self = !!from && from.groupId === location.groupId && from.date === location.date && from.slot === location.slot;
    const swap = !!from && !self && entries.length > 0 &&
      !payload.lesson.subgroup && !payload.lesson.subgroupId &&
      !entries.some((lesson) => lesson.subgroup || lesson.subgroupId);
    const eventReason = entries.length === 0 ? null : entries.some((entry) => entry.event || entry.subjectId === "event")
      ? "Ячейка занята мероприятием" : "Ячейка занята уроком";
    const reason = !inQuarter(location.date, quarter) || (from && !inQuarter(from.date, quarter))
      ? "Перемещение доступно только внутри выбранной четверти"
      : self ? null
        : swap ? canSwapLessons(schedule, from!, payload.from!.id, location, catalog)
          : payload.lesson.event ? eventReason
            : canPlace(schedule, location, payload.lesson, payload.from?.id, catalog);
    return { self, swap, reason, payload, label: self ? "Исходный урок" : reason ?? (payload.lesson.event ? "Настроить мероприятие" : swap ? "Поменять уроки местами" : payload.from ? "Перенести в свободное место" : `Разместить занятие · кабинет ${payload.lesson.room || "не выбран"}`) };
  }
  function placeAt(location: Location, payload: Placement | null = placement) {
    if (scopeError) {
      setNotice({ text: "Не удалось загрузить выбранную неделю. Повторите загрузку перед изменением расписания.", error: true });
      return;
    }
    if (scopeLoading) {
      setNotice({ text: "Загружается выбранная неделя. Повторите действие через секунду." });
      return;
    }
    if (!inQuarter(location.date, quarter)) return;
    if (!payload) {
      setNotice({ text: "Сначала выберите карточку преподавателя слева" });
      return;
    }
    if (payload.lesson.event) {
      void openServiceEvent({ title: payload.lesson.event, location });
      setPlacement(null);
      return;
    }
    const from = payload.from?.location;
    if (from && from.groupId === location.groupId && from.date === location.date && from.slot === location.slot)
      return;
    const target = scopedMode
      ? dropTargets.get(`${location.date}:${location.slot}`) ?? null
      : targetAction(location, payload);
    if (!target) {
      setNotice({ text: "Проверяем доступность места. Повторите действие через секунду." });
      return;
    }
    payload = target.payload;
    if (target.swap) {
      attempt(() => {
        if (target.reason) throw new Error(target.reason);
        applyChange(
          (value) => swapLessons(value, from!, payload.from!.id, location, catalog),
          "Уроки поменяны местами",
          location,
        );
        setPlacement(null);
      });
      return;
    }
    if (from && !inQuarter(from.date, quarter)) return;
    const targetTime = schedule[key(location.groupId, location.weekOffset)]?.find(day => day.date === location.date)?.times[location.slot];
    if (targetTime) {
      const unavailable = newUnavailabilityViolation([{
        lessonId: payload.from?.id ?? "__new-placement__", groupId: location.groupId, date: location.date,
        start: targetTime.start, end: targetTime.start + targetTime.duration,
        teacherId: payload.lesson.teacherId, roomId: payload.lesson.roomId,
      }], roomOccupancies(schedule), catalog);
      if (unavailable) {
        setNotice({ text: unavailabilityViolationMessage(unavailable, catalog), error: true });
        return;
      }
    }
    if (teacherPlacementConflicts(schedule, location, payload.lesson, payload.from?.id).length) {
      setTransferError("");
      setTeacherTransfer({ location, payload });
      return;
    }
    attempt(() => {
      if (payload.from) {
        applyChange(
          (value) =>
            moveLesson(
              value,
              payload.from!.location,
              payload.from!.id,
              location,
              catalog,
            ),
          "Урок перемещён",
          location,
        );
        setPlacement(null);
      } else
        applyChange(
          (value) => placeLesson(value, location, payload.lesson, catalog),
          "Урок добавлен",
          location,
        );
    });
  }
  const dropTargets = useMemo(() => {
    if (scopedMode) return new Map((serverTargetsSignature === previewSignature ? serverTargets : []).map((target) => [`${target.date}:${target.slot}`, target]));
    const targets = new Map<string, ReturnType<typeof targetAction>>();
    if (activePlacement)
      for (const day of week)
        day.slots.forEach((_, slot) => targets.set(`${day.date}:${slot}`, targetAction(locationFor(day.date, slot), activePlacement)));
    return targets;
  }, [schedule, activePlacement, week, groupId, weekOffset, quarter, catalog, paletteRoomId, scopedMode, serverTargets, serverTargetsSignature, previewSignature]);
  const hoveredTarget = dropTargets.get(hovered);
  const transferConflicts = teacherTransfer
    ? teacherPlacementConflicts(schedule, teacherTransfer.location, teacherTransfer.payload.lesson, teacherTransfer.payload.from?.id)
    : [];
  let transferBlocked = "";
  let transferUndoBlocked = false;
  if (teacherTransfer) {
    try {
      const preview = transferTeacherLesson(schedule, teacherTransfer.location, teacherTransfer.payload.lesson, catalog, teacherTransfer.payload.from);
      transferUndoBlocked = !!(newTeacherConflict(schedule, preview) || newRoomConflict(schedule, preview) || newUnavailabilityViolation(schedule, preview, catalog));
    } catch (error) {
      transferBlocked = error instanceof Error ? error.message : "Перенос невозможен";
    }
  }
  const timingDay = timeDialog
    ? schedule[
        key(timeDialog.location.groupId, timeDialog.location.weekOffset)
      ].find((day) => day.date === timeDialog.location.date)
    : null;

  return (
    <div className={`admin-workspace ${navOpen ? "nav-open" : ""}`}>
      <aside className="admin-rail" aria-label="Навигация администратора"
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setNavOpen(true); }} onPointerLeave={(event) => { if (event.pointerType === "mouse") setNavOpen(false); }}
        onFocusCapture={(event) => { if (event.target.matches(":focus-visible")) setNavOpen(true); }}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNavOpen(false); }}>
        <div className="admin-rail-head">
          <span className="admin-rail-logo"><Icon name="calendar" size={21} /></span>
          <span className="admin-rail-brand">Меню</span>
          <button className="admin-rail-toggle" type="button" aria-label={navOpen ? "Свернуть меню" : "Открыть меню"} aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}>
            <Icon name="menu" size={18} />
          </button>
        </div>
        <nav className="admin-rail-nav" aria-label="Разделы">
          <span className="admin-rail-section">Работа</span>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openPlan()} title="Учебные планы">
            <Icon name="plan" /><span>Учебные планы</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openPlanCoverage()} title="Выполнение планов">
            <Icon name="check" /><span>Выполнение планов</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openTeacherLoad()} title="Нагрузка учителей">
            <Icon name="people" /><span>Нагрузка учителей</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openReassignments()} title="Замены и переназначения">
            <Icon name="people" /><span>Замены и переназначения</span><Icon name="chevron" size={14} />
          </button>
          <span className="admin-rail-section">Настройки</span>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openDisplaySettings()} title="Общие настройки">
            <Icon name="settings" /><span>Общие настройки</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openCatalog()} title="Справочники">
            <Icon name="catalog" /><span>Справочники</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openCalendar()} title="Календарь школы">
            <Icon name="calendar" /><span>Календарь школы</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openBells()} title="Время и перемены">
            <Icon name="clock" /><span>Время и перемены</span><Icon name="chevron" size={14} />
          </button>
          <span className="admin-rail-section">Расписание</span>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openAutoSchedule()} title="Составить четверть автоматически">
            <Icon name="wand" /><span>Автосоставление</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openClearSchedule()} title="Очистить неделю или четверть">
            <Icon name="trash" /><span>Очистка расписания</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" onClick={() => setDialog("hours")} title="План четверти">
            <Icon name="clock" /><span>План четверти</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openPublication()} title="Опубликовать всю выбранную четверть" aria-label="Опубликовать">
            <Icon name="publish" /><span>Опубликовать</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openPrint()} title="Печать расписания">
            <Icon name="print" /><span>Печать расписания</span><Icon name="chevron" size={14} />
          </button>
          <a className="admin-rail-item" href={withBasePath("/")} title="Посмотреть опубликованное расписание" aria-label="Расписание для учеников">
            <Icon name="calendar" /><span>Ученикам</span><Icon name="chevron" size={14} />
          </a>
          <a className="admin-rail-item" href={withBasePath("/teachers")} title="Посмотреть расписание преподавателя" aria-label="Расписание для учителей">
            <Icon name="people" /><span>Учителям</span><Icon name="chevron" size={14} />
          </a>
        </nav>
        <div className="admin-rail-footer">
          <span className="admin-rail-user" title={auth.username}>{auth.username}</span>
          <button type="button" className="admin-rail-item" disabled={reloading || loggingOut} onClick={() => void openDocumentation()} title="Документация">
            <Icon name="book" /><span>Документация</span><Icon name="chevron" size={14} />
          </button>
          <button type="button" className="admin-rail-item" disabled={loggingOut || reloading} onClick={() => void logout()} title="Выйти">
            <Icon name="logout" /><span>{loggingOut ? "Сохраняем и выходим…" : "Выйти"}</span><Icon name="chevron" size={14} />
          </button>
        </div>
      </aside>
      <header className="app-header">
        <span className="brand" aria-label="Смена">
          <span className="brand-mark">
            <Icon name="calendar" size={23} />
          </span>
          смена
        </span>
        <div className="header-divider" />
        <div className="app-school-identity">
          <SchoolName className="app-school-name" />
          <span className="school-label">{schoolYear} / {schoolYear + 1} <span>· Администратор</span></span>
        </div>
        <div className="header-right">
          <span className="demo-badge">
            <span />
            Черновик
          </span>
        </div>
      </header>

      <main className="schedule-main" inert={loggingOut || reloading}>
        {["error", "conflict", "auth"].includes(save.status.kind) && (
          <div className="save-warning" role="alert">
            <span>{save.status.message}</span>
            {save.status.kind === "error" && (
              <button
                className="secondary-button"
                onClick={() => void save.flush()}
              >
                Повторить сохранение
              </button>
            )}
            {save.status.kind === "auth" && (
              <button className="secondary-button" onClick={onUnauthorized}>
                Войти снова
              </button>
            )}
            {save.status.kind === "conflict" && (
              <button
                className="secondary-button"
                onClick={() => setReloadConfirm(true)}
              >
                Загрузить сохранённое
              </button>
            )}
          </div>
        )}
      <div className="context-bar" aria-busy={scopeLoading}>
          <h1>Расписание</h1>
          <span className="scope-loading-indicator" role="status">{scopeLoading ? "Загружаем неделю…" : ""}</span>
          {scopeError && <button className="secondary-button" title={scopeError} onClick={() => setScopeAttempt((attempt) => attempt + 1)}>Повторить загрузку недели</button>}
          <ScheduleGroupSelect groups={groups.map(item => ({ id: item.id, name: `${item.name}${item.archived ? " · архив" : ""}` }))} value={groupId}
              onChange={(id) => {
                setGroupId(id);
                setSelected("");
                setPlacement(null);
                setDetail(null);
                setTimeDialog(null);
                endDrag();
              }} />
          <div className="group-meta">
            <span>
              <Icon name="pin" size={16} />
              Каб. {group.room}
            </span>
          </div>
          <div className="context-divider" />
          <label className="quarter-label quarter-select">
            <Icon name="calendar" size={17} />
            <select
              aria-label="Четверть"
              value={quarterId}
              onChange={(event) => {
                const next = editorState.quarters.find(
                  (entry) => entry.id === event.target.value,
                )!;
                const weeks = quarterWeeks(next);
                setQuarterId(next.id);
                setWeekOffset(
                  weeks.includes(weekOffset) ? weekOffset : weeks[0],
                );
                setSelected("");
                setPlacement(null);
                setDetail(null);
                setTimeDialog(null);
                endDrag();
              }}
            >
              {activeQuarters.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <span
            className="group-leader"
            title={`Классный руководитель: ${group.leader}`}
          >
            <Icon name="people" size={14} />
            <span className="group-leader__text">Кл. рук. {group.leaderId ? teacherInitials(group.leader) : "—"}</span>
          </span>
          <div className="context-actions">
            {replacementIds.length > 0 && <button className="secondary-button replacement-alert" onClick={() => void openReplacements(replacementIds)} title="Уроки с недоступным учителем в выбранной четверти, во всех группах">
              Нужна замена · {replacementIds.length}
            </button>}
            <span
              className={`edit-status save-${save.status.kind}`}
              role="status"
              title={
                save.status.updatedAt
                  ? `Сохранено ${new Date(save.status.updatedAt).toLocaleString("ru-RU")}`
                  : save.status.message
              }
            >
              {
                {
                  saved: "Сохранено",
                  pending: "Есть изменения…",
                  saving: "Сохраняется…",
                  error: "Не сохранено",
                  conflict: "Другая версия",
                  auth: "Нужен вход",
                }[save.status.kind]
              }
            </span>
            <button
              className="secondary-button"
              disabled={!history.length}
              onClick={undo}
              title="Отменить последнее действие · Ctrl+Z"
            >
              ↶ Отменить
            </button>
            <button
              className="text-button context-hours"
              onClick={() => setDialog("hours")}
            >
              Часы
              <Icon name="arrow" size={14} />
            </button>
          </div>
        </div>

        <section className="workspace" aria-label="Редактор расписания">
          <aside className="subjects-panel">
            <div className="panel-heading">
              <h2>Предметы</h2>
              <span className="count-badge">{subjects.length}</span>
            </div>
            <label className="search-box">
              <Icon name="search" size={16} />
              <input
                placeholder="Найти предмет"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Найти предмет"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  aria-label="Очистить поиск"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </label>
            <label className="filter">
              <input
                type="checkbox"
                checked={onlyRemaining}
                onChange={(event) => setOnlyRemaining(event.target.checked)}
              />
              Недобор
            </label>
            <div className="subject-list">
              {!subjects.length && (
                <p className="empty-plan-note">
                  Предметы ещё не назначены. Откройте «План группы», чтобы
                  добавить предметы и преподавателей.
                </p>
              )}
              {visibleSubjects.map((subject) => (
                <button
                  key={subject.id}
                  onClick={() => {
                    setSelected(subject.id);
                    setPlacement(null);
                  }}
                  className={`subject-row ${selectedSubject!.id === subject.id ? "active" : ""}`}
                  aria-pressed={selectedSubject!.id === subject.id}
                  title={subject.name}
                >
                  {showSubjectIcons && resolveSubjectIconId(subject) ? <SubjectIcon subject={subject} /> : <span className={`subject-dot ${subject.color}`} />}
                  <span className="subject-row-copy">
                    <b>{subject.shortName || subject.name}</b>
                    <span>{subjectLabel(subject)}</span>
                  </span>
                </button>
              ))}
              {!visibleSubjects.length && (
                <p className="empty-search">Предметы не найдены</p>
              )}
              <div className="service-palette">
                <span>Мероприятия</span>
                <button
                  className={`subject-row ${placement?.lesson.event ? "active" : ""}`}
                  draggable
                  onDragStart={(event) => beginDrag(event, { lesson: { subjectId: "event", event: "Мероприятие" } })}
                  onDragEnd={endDrag}
                  onClick={() => {
                    setPlacement({ lesson: { subjectId: "event", event: "Мероприятие" } });
                    setNotice({ text: "Выберите ячейку для мероприятия или перетащите его в расписание" });
                  }}
                  title="Выберите ячейку или перетащите в расписание."
                >
                  <Icon name="people" size={15} />
                  <b>Мероприятие</b>
                </button>
              </div>
            </div>
            <button
              className="hours-summary"
              onClick={() => setDialog("hours")}
            >
              <span className="summary-icon">
                <Icon name="clock" size={17} />
              </span>
              <span>
                <b>План четверти</b>
                <small>Недобор: {deficits} предметов</small>
              </span>
              <Icon name="right" size={14} />
            </button>
            <p className="sample-note">
              Часы по урокам этой четверти.
              <br />
              Сохраняется автоматически.
            </p>
          </aside>

          <aside className="palette-panel">
            <div className="panel-heading">
              <h2>Занятия</h2>
              <Icon name="book" size={17} />
            </div>
            <p className="panel-caption" title={selectedSubject?.name}>
              {selectedSubject?.shortName || selectedSubject?.name || "Нет назначений"}
            </p>
            {selectedSubject && selectedSubject.assignments.length > 1 && <div className="palette-assignments" role="group" aria-label="Подгруппа для нового урока">
              <span>Подгруппа</span>
              {selectedSubject.assignments.map(assignment => <button type="button" key={assignment.id}
                aria-pressed={selectedAssignment?.id === assignment.id}
                onClick={() => {
                  setPaletteAssignmentChoice({ scope: assignmentScope, id: assignment.id });
                  setPlacement(null);
                  setPaletteRoomId("");
                  endDrag();
                }}>
                {assignment.name || "Вся группа"}{assignment.lessonKind === "lab" ? " · лаб." : ""}
              </button>)}
              {!paletteReady && <small>Выберите подгруппу</small>}
            </div>}
            <label className="palette-room">
              <span>Кабинет</span>
              <select
                aria-label="Кабинет для нового урока"
                disabled={!paletteReady}
                value={paletteRoomId}
                title="Автоматически: подходящий свободный кабинет; приоритет кабинета преподавателя и группы"
                onChange={(event) => {
                  setPaletteRoomId(event.target.value);
                  setPlacement(null);
                }}
              >
                <option value="">Автоматически</option>
                {catalog.rooms
                  .filter((room) => !room.archived && !paletteRoomReasons.get(room.id))
                  .sort((a, b) =>
                    a.name.localeCompare(b.name, "ru", { numeric: true }),
                  )
                  .map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name} · {roomKinds[room.kind]}{room.capacity !== null ? ` · ${room.capacity} мест` : ""}
                    </option>
                  ))}
              </select>
            </label>
            {paletteRoomId && paletteRoomReasons.get(paletteRoomId) && <p className="palette-room-error" role="status">
              {paletteRoomReasons.get(paletteRoomId)}. Выберите подходящий кабинет или «Автоматически».
            </p>}
            <div className="teacher-cards">
              {selectedSubject && palette.length === 0 && (
                <p className="palette-hint">
                  Для этого предмета нет преподавателей. Отметьте его в
                  справочнике «Учителя».
                </p>
              )}
              {palette.map((item) => {
                const subgroup = paletteReady && item.subgroupId ? item.name : undefined;
                const payload: Placement = {
                  lesson: {
                    subjectId: selectedSubject!.id,
                    lessonKind: item.lessonKind,
                    teacherId: item.teacherId,
                    roomId: item.roomId,
                    subgroupId: item.subgroupId,
                    teacher: item.teacher,
                    room: item.room,
                    subgroup,
                  },
                };
                const armed =
                  placement &&
                  !placement.from &&
                  placement.lesson.subjectId === selectedSubject!.id &&
                  placement.lesson.teacherId === item.teacherId &&
                  placement.lesson.subgroupId === item.subgroupId &&
                  (placement.lesson.lessonKind ?? "regular") ===
                    item.lessonKind;
                return (
                  <button
                    className={`teacher-card ${selectedSubject!.color} ${armed ? "armed" : ""}`}
                    key={item.id}
                    draggable={
                      paletteReady && !item.unavailable &&
                      !selectedSubject!.archived &&
                      !group.archived
                    }
                    disabled={
                      !paletteReady || item.unavailable ||
                      selectedSubject!.archived ||
                      group.archived
                    }
                    title={
                      !paletteReady ? "Сначала выберите подгруппу" : item.unavailable ||
                      selectedSubject!.archived ||
                      group.archived
                        ? item.reason ||
                          "Назначение в архиве. Восстановите запись в справочнике."
                        : undefined
                    }
                    onDragStart={(event) => beginDrag(event, payload)}
                    onDragEnd={endDrag}
                    onClick={() => setPlacement(armed ? null : payload)}
                    aria-pressed={!!armed}
                    aria-label={`Разместить: ${selectedSubject!.name}, ${subgroup ?? "вся группа"}, ${item.teacher}${item.lessonKind === "lab" ? ", лабораторная" : ""}`}
                  >
                    {paletteReady && item.unavailable && item.reason && <small className="teacher-room-reason">{item.reason}</small>}
                    <div className="teacher-card-top">
                      {subgroup && (
                        <span className="group-chip">{subgroup}</span>
                      )}
                      <span className="grip">
                        <Icon name="grip" size={16} />
                      </span>
                    </div>
                    <p className="teacher-name" title={item.fullTeacher}>
                      {teacherInitials(item.fullTeacher)}
                    </p>
                    {paletteReady && <><span className="room-label">
                      <Icon name="pin" size={13} />
                      {item.room}
                    </span>
                    <div className="plan-line">
                      <span>
                        {item.planned}/{item.target}
                      </span>
                      <b>
                        {item.planned > item.target
                          ? `+${item.planned - item.target}`
                          : `ещё ${item.target - item.planned}`}
                      </b>
                    </div>
                    <div className="progress">
                      <span
                        style={{
                          width: `${Math.min(100, (item.planned / item.target) * 100)}%`,
                        }}
                      />
                    </div></>}
                  </button>
                );
              })}
            </div>
            <div className="palette-hint">
              <p>
                Перетащите карточку в день
                <br />
                или выберите её и нажмите
                <br />
                на свободное место.
              </p>
            </div>
          </aside>

          <div className="calendar-panel">
            <div className="week-toolbar">
              <div className="week-title">
                <h2>
                  {week.length ? `${dateLabel(weekStartDate, true)} — ${dateLabel(visibleWeek.at(-1)?.date ?? weekStartDate, true)}` : "Загрузка недели…"}
                </h2>
                <span>
                  {isHoliday
                    ? "Неучебная неделя"
                    : `Учебная неделя · ${lessonCount} заполненных позиций`}
                </span>
              </div>
              <div className="week-navigation">
                <button className="secondary-button copy-week-button"
                  disabled={loggingOut || reloading || !week.some(day => inQuarter(day.date, quarter) && day.slots.some(slot => slot.length > 0))}
                  onClick={() => void openScheduleCopy({ groupId, weekOffset })}>
                  Копировать неделю
                </button>
                <button
                  className="icon-button"
                  aria-label="Предыдущая неделя"
                  disabled={weekOffset === offsets[0]}
                  onClick={() => showWeek(weekOffset - 1)}
                >
                  <Icon name="left" />
                </button>
                <button
                  className="week-reset"
                  onClick={() =>
                    showWeek(
                      offsets.includes(weekOffsetFor(today))
                        ? weekOffsetFor(today)
                        : offsets[0],
                    )
                  }
                  title="Ближайшая неделя выбранной четверти"
                >
                  Сегодня
                </button>
                <button
                  className="icon-button"
                  aria-label="Следующая неделя"
                  disabled={weekOffset === offsets.at(-1)}
                  onClick={() => showWeek(weekOffset + 1)}
                >
                  <Icon name="right" />
                </button>
              </div>
            </div>
            {placement && (
              <div className="selection-banner">
                <span>
                  {placement.from ? "Перенос" : "Добавление"}:{" "}
                  {placement.lesson.event ??
                    allSubjects.find(
                      (item) => item.id === placement.lesson.subjectId,
                    )?.name
                  }{" "}
                  · <span className="school-code">{placement.lesson.subgroup ?? "вся группа"}</span> — выберите место
                </span>
                <button
                  className="icon-button"
                  aria-label="Отменить выбор карточки"
                  onClick={() => setPlacement(null)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
            <div className="calendar-scroll">
              <div className="week-grid" style={{ gridTemplateColumns: `repeat(${visibleWeek.length}, minmax(var(--schedule-day-width, 340px), 1fr))` }}>
                {visibleWeek.map((day) => (
                  <div
                    className={`day-column ${day.date === today ? "example-day" : ""}`}
                    key={day.date}
                  >
                    <div className="day-heading" title={calendarDay(calendar, groupId, day.date).label}>
                      <div>
                        <span>{weekdayName(day.date)}</span>
                        <b>{dateLabel(day.date)}</b>
                      </div>
                      {day.date === today && <span className="today-dot" />}
                    </div>
                    {day.holiday || !inQuarter(day.date, quarter) ? (
                      <div className="day-note">
                        {inQuarter(day.date, quarter)
                          ? "Неучебный день"
                          : "Вне четверти"}
                      </div>
                    ) : (
                      <button
                        className={`day-note ${day.times.length > 0 && day.times.every((t) => t.duration === 35) ? "shortened" : ""}`}
                        onClick={() =>
                          setTimeDialog({
                            location: locationFor(day.date, 0),
                            kind: "time",
                            wholeDay: true,
                          })
                        }
                        aria-label={`Начало дня, ${weekdayName(day.date)}`}
                        title="Настроить время дня"
                      >
                        <Icon name="clock" size={12} />
                        {day.times.length > 0 && day.times.every((t) => t.duration === 35)
                          ? "Уроки по 35 мин"
                          : `Начало в ${day.start}`}
                        <span aria-hidden="true">⌄</span>
                      </button>
                    )}
                    {day.holiday || !inQuarter(day.date, quarter) ? (
                      <div className="holiday-card">
                        <Icon name="leaf" size={27} />
                        <b>
                          {inQuarter(day.date, quarter)
                            ? calendarDay(calendar, groupId, day.date).label
                            : "Вне четверти"}
                        </b>
                        <span>
                          {inQuarter(day.date, quarter)
                            ? "Занятия не проводятся"
                            : "Выберите другую дату"}
                        </span>
                      </div>
                    ) : (
                      <>
                        {day.slots.map((lessons, slot) => {
                          const compactSlot = compactSubgroupSlot(lessons);
                          const location = locationFor(day.date, slot);
                          const targetId = `${day.date}:${slot}`;
                          const dropTarget = dropTargets.get(targetId);
                          const dropReason = dropTarget?.reason ?? null;
                          const defaultGap = bellBreak(bellProfile, slot);
                          const isGap = lessons.length === 0
                            && day.slots.slice(0, slot).some(entries => entries.length > 0)
                            && day.slots.slice(slot + 1).some(entries => entries.length > 0);
                          return (
                            <div className="slot-wrap" key={slot}>
                              <div className="slot-time">
                                <span className="slot-number">{slot + 1}</span>
                                <button
                                  className="time-button"
                                  onClick={() =>
                                    setTimeDialog({ location, kind: "time" })
                                  }
                                  aria-label={`Время урока ${slot + 1}, ${weekdayName(day.date)}`}
                                >
                                  {timeLabel(day, slot)}
                                </button>
                                {lessons.length === 0 && slot === day.slots.length - 1 && (
                                  <button
                                    className="remove-empty-slot-button"
                                    onClick={() => attempt(() => applyChange(
                                      value => removeEmptySlot(value, location),
                                      "Пустая ячейка удалена",
                                      location,
                                    ))}
                                    aria-label={`Удалить пустую ячейку ${slot + 1}, ${weekdayName(day.date)}`}
                                    title="Удалить пустую ячейку и перемену перед ней"
                                  >
                                    <Icon name="trash" size={13} />
                                  </button>
                                )}
                              </div>
                              <div
                                className={`lesson-slot ${isGap ? "schedule-gap" : ""} ${lessons.length > 1 ? "split-slot" : ""} ${compactSlot ? "compact-slot" : ""} ${dropTarget ? dropTarget.self ? "drop-source" : dropReason ? "drop-blocked" : "drop-allowed" : ""} ${hovered === targetId ? "drop-hover" : ""}`}
                                data-date={day.date}
                                data-slot={slot}
                                style={
                                  {
                                    "--slot-cards": Math.max(
                                      1,
                                      ...week.map((other) => {
                                        const entries = other.slots[slot] ?? [];
                                        return compactSubgroupSlot(entries) ? 1 : entries.length;
                                      }),
                                    ),
                                  } as CSSProperties
                                }
                                onDragEnter={(event) => {
                                  if (!dragRef.current) return;
                                  event.preventDefault();
                                  cancelWeekDrag();
                                  setHovered(targetId);
                                }}
                                onDragOver={(event) => {
                                  if (!dragRef.current) return;
                                  cancelWeekDrag();
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = dragRef.current.from
                                      ? "move"
                                      : "copy";
                                  setHovered(targetId);
                                }}
                                onDragLeave={(event) => {
                                  if (
                                    !event.currentTarget.contains(
                                      event.relatedTarget as Node | null,
                                    )
                                  )
                                    setHovered("");
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const payload = dragRef.current;
                                  if (payload) placeAt(location, payload);
                                  endDrag();
                                }}
                                onClick={(event) => {
                                  if (event.target === event.currentTarget && activePlacement && !dragging)
                                    placeAt(location, activePlacement);
                                }}
                                onMouseEnter={() => { if (activePlacement) setHovered(targetId); }}
                                onMouseLeave={() => { if (!dragging) setHovered(""); }}
                                title={
                                  activePlacement
                                    ? dropTarget?.label
                                    : undefined
                                }
                              >
                                {lessons.length === 0 ? (
                                  <button
                                    className="empty-slot"
                                    title={isGap ? "Окно между уроками" : undefined}
                                    onClick={() => placeAt(location)}
                                    aria-label={`Добавить урок ${slot + 1}, ${weekdayName(day.date)}`}
                                  >
                                    <span>+</span>
                                    <span>Добавить</span>
                                  </button>
                                ) : (
                                  lessons.map((lesson) => {
                                    const subject = allSubjects.find(
                                      (item) => item.id === lesson.subjectId,
                                    );
                                    const teacher = teacherLabel(
                                      lesson.teacher ?? "",
                                    );
                                    const fullTeacher = catalog.teachers.find(item => item.id === lesson.teacherId)?.name
                                      || lesson.teacher || "Преподаватель не задан";
                                    const subgroup = lesson.subgroup || catalog.subgroups.find(item => item.id === lesson.subgroupId)?.name;
                                    const room = lesson.room ?? "Не задан";
                                    const roomLabel = /^\d/.test(room)
                                      ? `Каб. ${room}`
                                      : room;
                                    const fullTitle =
                                      lesson.event ??
                                      `${subject?.name} (${teacher})`;
                                    const unavailable = unavailableById.get(lesson.id) ?? [];
                                    const availabilityLabel = unavailable.some(entry => entry.kind === "teacher") ? "Нужна замена" : "Кабинет недоступен";
                                    const payload: Placement = {
                                      lesson,
                                      from: { location, id: lesson.id },
                                    };
                                    return (
                                      <ScheduleLessonCard
                                        key={lesson.id}
                                        compact={compactSlot}
                                        abbreviation={compactSubjectName(subject?.name ?? "")}
                                        previewEnabled={!activePlacement}
                                        preview={<>
                                          <strong>{subject?.name}{lesson.lessonKind === "lab" ? " · лабораторная" : ""}</strong>
                                          <span>{subgroup}</span>
                                          <span>{fullTeacher}</span>
                                          <span>{roomLabel} · {timeLabel(day, slot)}</span>
                                          {lesson.jointId && <span>Совместное занятие</span>}
                                          {lesson.note && <span>{lesson.note}</span>}
                                          {unavailable.length > 0 && <span className="lesson-availability-label">{unavailable.map(entry => entry.message).join("; ")}</span>}
                                        </>}
                                        draggable={!lesson.event && !lesson.jointId}
                                        onDragStart={(event) =>
                                          beginDrag(event, payload)
                                        }
                                        onDragEnd={endDrag}
                                        onClick={() => {
                                          if (placement?.lesson.event && !placement.from) {
                                            placeAt(location);
                                            return;
                                          }
                                          if (placement?.from && dropTarget?.swap) {
                                            placeAt(location);
                                            return;
                                          }
                                          if (compactSlot && placement && !dropReason && !dropTarget?.self) {
                                            placeAt(location);
                                            return;
                                          }
                                          if (placement) setPlacement(null);
                                          if (lesson.event) {
                                            void openServiceEvent({ title: lesson.event, location, lessonId: lesson.id });
                                            return;
                                          }
                                          setDetail({
                                            location,
                                            id: lesson.id,
                                          });
                                        }}
                                        className={`lesson-card ${lesson.event ? "event-card" : (subject?.color ?? "blue")} ${selected === lesson.subjectId ? "highlighted" : ""} ${unavailable.length ? "lesson-unavailable" : ""}`}
                                        aria-label={`${lesson.event ?? subject?.name}, ${subgroup ?? "вся группа"}, ${weekdayName(day.date)}, ${timeLabel(day, slot)}${unavailable.length ? `, ${availabilityLabel}` : ""}`}
                                        title={activePlacement ? dropTarget?.label : `${fullTitle} · ${roomLabel}${lesson.subgroup ? ` · ${lesson.subgroup}` : ""}${lesson.note ? ` · ${lesson.note}` : ""}${unavailable.length ? ` · ${unavailable.map(entry => entry.message).join("; ")}` : ""}`}
                                      >
                                        {lesson.event ? <span className="event-card-icon"><Icon name="calendar" size={29} /></span> : showSubjectIcons && subject && <SubjectIcon subject={subject} />}
                                        <span className="lesson-copy">
                                          <b className="lesson-title">
                                            {lesson.event ?? (
                                              <>
                                                {subject?.shortName ||
                                                  subject?.name}
                                                {lesson.lessonKind === "lab"
                                                  ? " · лаб."
                                                  : ""}{" "}
                                                <span className="lesson-teacher">
                                                  ({teacher})
                                                </span>
                                              </>
                                            )}
                                          </b>
                                          <span className="lesson-meta">
                                            <span className="lesson-room">
                                              <Icon name="pin" size={12} />
                                              <span>{roomLabel}</span>
                                            </span>
                                            {lesson.subgroup && (
                                              <span className="subgroup-label">
                                                {lesson.subgroup}
                                              </span>
                                            )}
                                            {lesson.jointId && (
                                              <span className="joint-lesson-label" title="Совместное занятие. Изменения применяются ко всем участникам.">Общее</span>
                                            )}
                                            {lesson.note && (
                                              <span title={lesson.note}>•</span>
                                            )}
                                          </span>
                                          {unavailable.length > 0 && <span className="lesson-availability-label">{availabilityLabel}</span>}
                                        </span>
                                      </ScheduleLessonCard>
                                    );
                                  })
                                )}
                                {lessons.length > 0 &&
                                  lessons.every((lesson) => lesson.subgroupId || lesson.subgroup) &&
                                  activePlacement &&
                                  !dropReason && (
                                    <button
                                      className="add-subgroup-button"
                                      onClick={() => placeAt(location)}
                                      aria-label={`Добавить подгруппу, ${weekdayName(day.date)}, урок ${slot + 1}`}
                                      title="Добавить выбранную подгруппу"
                                    >
                                      +
                                    </button>
                                  )}
                              </div>
                              {slot < day.slots.length - 1 && (
                                <button
                                  className={`break-label ${day.breaks[slot] !== defaultGap ? "custom-break" : ""}`}
                                  onClick={() =>
                                    setTimeDialog({ location, kind: "break" })
                                  }
                                  aria-label={`Перемена после урока ${slot + 1}, ${weekdayName(day.date)}`}
                                  title={
                                    day.breaks[slot] !== defaultGap
                                      ? "Изменено для этого дня"
                                      : "Изменить перемену только для этого дня"
                                  }
                                >
                                  <span />
                                  {day.breaks[slot]} мин
                                  {day.breaks[slot] !== defaultGap ? " ·" : ""}
                                  <span />
                                </button>
                              )}
                            </div>
                          );
                        })}
                        <button
                          className="add-slot-button"
                          disabled={day.slots.at(-1)?.length === 0 || day.slots.length >= 12}
                          title={day.slots.at(-1)?.length === 0
                            ? "Сначала заполните пустую ячейку в конце дня"
                            : day.slots.length >= 12 ? "В день можно добавить не больше 12 ячеек" : undefined}
                          onClick={() =>
                            attempt(() =>
                              applyChange(
                                (value) =>
                                  appendSlot(value, locationFor(day.date, 0), bellProfile),
                                "Ячейка добавлена",
                                locationFor(day.date, 0),
                              ),
                            )
                          }
                          aria-label={`Добавить ячейку, ${weekdayName(day.date)}`}
                        >
                          + Ячейка
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {dragging && (
              <div className={`drag-feedback ${hoveredTarget?.reason ? "blocked" : ""}`} role="status">
                {hoveredTarget
                  ? `${hoveredTarget.reason ? "Нельзя: " : ""}${hoveredTarget.label}`
                  : dragging.from
                    ? "Зелёная рамка — перенос или обмен, красная — конфликт. Для другой недели задержите урок над её датой."
                    : "Зелёная рамка — место свободно, красная — конфликт."}
              </div>
            )}
            <div className="week-strip" aria-label="Недели четверти">
              {offsets.map((offset) => {
                const days = schedule[key(groupId, offset)];
                const dates = weekDates(offset);
                const summary = editorState.editorScope?.weeks?.find((entry) => entry.weekOffset === offset);
                const holiday = days ? days.every((day) => day.holiday)
                  : summary?.holiday ?? dates.every((date) => calendarDay(calendar, groupId, date).holiday);
                const hasEvent = days ? days.some((day) => day.slots.flat().some((lesson) => lesson.event)) : summary?.event;
                return (
                  <button
                    key={offset}
                    onClick={() => showWeek(offset)}
                    className={`${weekOffset === offset ? "selected" : ""} ${dragWeek === offset ? "drag-week-target" : ""}`}
                    onDragEnter={(event) => hoverDragWeek(event, offset)}
                    onDragOver={(event) => hoverDragWeek(event, offset)}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelWeekDrag();
                    }}
                    onDrop={(event) => { event.preventDefault(); endDrag(); }}
                    aria-pressed={weekOffset === offset}
                  >
                    <Icon
                      name={
                        holiday ? "leaf" : "calendar"
                      }
                      size={15}
                    />
                    <span>
                      С {dateLabel(dates[0])}
                      <small>
                        {holiday
                          ? "Неучебная неделя"
                          : hasEvent
                            ? "С мероприятием"
                            : "Учебная неделя"}
                      </small>
                    </span>
                    {weekOffset === offset && (
                      <span className="week-indicator" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {dialog === "hours" && (
        <QuarterPlanDialog
          groupName={group.name}
          quarterName={quarter.name}
          rows={subjects.flatMap((subject) => subject.assignments.map((item) => ({
            id: item.id,
            subjectId: item.subjectId,
            subjectName: subject.name,
            subgroupId: item.subgroupId ?? null,
            subgroupName: item.subgroupId ? item.name : null,
            lessonKind: item.lessonKind,
            target: item.target,
            scheduled: planned(item),
          })))}
          onClose={() => setDialog(null)}
        />
      )}
      {autoScheduleOpen && (
        <AutoScheduleDialog
          catalog={catalog}
          quarter={quarter}
          schedule={schedule}
          studyPlans={editorState.studyPlans}
          temporaryTeacherReplacements={editorState.temporaryTeacherReplacements}
          teachingAssignments={editorState.teachingAssignments}
          bellSettings={editorState.bellSettings}
          calendar={editorState.calendar}
          currentGroupId={groupId}
          revision={save.currentRevision()}
          csrfToken={auth.csrfToken}
          onUnauthorized={onUnauthorized}
          onClose={() => setAutoScheduleOpen(false)}
          onJobApplied={async () => { setAutoScheduleOpen(false); setHistory([]); setScopeAttempt(value => value + 1); }}
        />
      )}
      {clearScheduleOpen && (
        <ClearScheduleDialog
          catalog={catalog}
          revision={save.currentRevision()}
          csrfToken={auth.csrfToken}
          onUnauthorized={onUnauthorized}
          currentGroupId={groupId}
          weekDates={week.map((day) => day.date)}
          quarter={quarter}
          onClose={() => setClearScheduleOpen(false)}
          onApply={async (options) => {
            await applyBulkOperation("clear", options);
            setClearScheduleOpen(false);
            setPlacement(null);
          }}
        />
      )}
      {serviceEvent && (
        <ServiceEventDialog
          catalog={catalog}
          schedule={serviceEvent.contextSchedule ?? schedule}
          revision={save.currentRevision()}
          csrfToken={auth.csrfToken}
          onUnauthorized={onUnauthorized}
          currentGroupId={groupId}
          location={serviceEvent.location}
          lessonId={serviceEvent.lessonId}
          onClose={() => setServiceEvent(null)}
          onApply={async (options) => {
            await applyBulkOperation("event", options);
            setServiceEvent(null);
            setPlacement(null);
          }}
        />
      )}
      {teacherTransfer && (
        <Modal title="Преподаватель уже занят" close={() => setTeacherTransfer(null)}>
          <p className="modal-intro">
            {catalog.teachers.find((entry) => entry.id === teacherTransfer.payload.lesson.teacherId)?.name}
            {" · "}{catalog.groups.find((entry) => entry.id === teacherTransfer.location.groupId)?.name}
            {" · "}{teacherTransfer.location.date}, урок {teacherTransfer.location.slot + 1}.
          </p>
          <p className="transfer-description">
            Для назначения сюда нужно удалить следующие занятия. Часы этих групп уменьшатся.
          </p>
          <ul className="transfer-lessons">
            {transferConflicts.map(({ b }) => (
              <li key={b.lessonId}>
                <b className="school-code">{catalog.groups.find((entry) => entry.id === b.groupId)?.name ?? b.groupId}</b>
                <span>{b.event || catalog.subjects.find((entry) => entry.id === b.subjectId)?.name || b.subjectId}</span>
                <span>{formatTime(b.start)}–{formatTime(b.end)}</span>
              </li>
            ))}
          </ul>
          {(transferError || transferBlocked) && (
            <p className="form-error" role="alert">{transferError || transferBlocked}</p>
          )}
          {!transferBlocked && <p className="form-hint">{transferUndoBlocked
            ? "В исходном расписании уже есть пересечения. Перенос устранит их; отмена не сможет восстановить конфликтующее расписание."
            : "Перенос и удаление можно отменить одним действием."}</p>}
          <div className="reload-actions">
            <button className="secondary-button" autoFocus onClick={() => setTeacherTransfer(null)}>Отмена</button>
            <button
              className="primary-button"
              disabled={!!transferBlocked || loggingOut || reloading}
              onClick={() => {
                try {
                  applyChange(
                    (current) => transferTeacherLesson(current, teacherTransfer.location, teacherTransfer.payload.lesson, catalog, teacherTransfer.payload.from),
                    "Преподаватель перенесён",
                    teacherTransfer.location,
                  );
                  setTeacherTransfer(null);
                  setPlacement(null);
                } catch (error) {
                  setTransferError(error instanceof Error ? error.message : "Не удалось перенести преподавателя");
                }
              }}
            >Перенести преподавателя сюда</button>
          </div>
        </Modal>
      )}
      {replacementLessonIds && <TeacherReplacementDialog
        schedule={schedule}
        catalog={catalog}
        lessonIds={replacementLessonIds}
        close={() => setReplacementLessonIds(null)}
        onApply={(next) => {
          const id = replacementLessonIds[0];
          const entry = Object.entries(schedule).find(([, days]) => days.some(day => day.slots.some(slot => slot.some(lesson => lesson.id === id))));
          if (!entry) throw new Error("Выбранный урок не найден");
          const day = entry[1].find(day => day.slots.some(slot => slot.some(lesson => lesson.id === id)))!;
          const separator = entry[0].lastIndexOf(":");
          applyChange(() => next, "Учитель заменён", { groupId: entry[0].slice(0, separator), weekOffset: Number(entry[0].slice(separator + 1)), date: day.date, slot: day.slots.findIndex(slot => slot.some(lesson => lesson.id === id)) });
        }}
      />}
      {copySource && <ScheduleCopyDialog
        state={copyState}
        revision={save.currentRevision()}
        csrfToken={auth.csrfToken}
        onUnauthorized={onUnauthorized}
        quarterId={quarterId}
        sourceGroupId={copySource.groupId}
        sourceWeekOffset={copySource.weekOffset}
        sourceLessonId={copySource.lessonId}
        onClose={() => setCopySource(null)}
        onApply={(options) => applyBulkOperation("copy", options as unknown as Record<string, unknown>)}
      />}
      {publicationOpen && <PublicationDialog
        quarterId={quarterId}
        csrfToken={auth.csrfToken}
        groupNames={Object.fromEntries(catalog.groups.map((entry) => [entry.id, entry.name]))}
        onUnauthorized={onUnauthorized}
        onClose={() => setPublicationOpen(false)}
        onPublished={(response) => setNotice({ text: `${quarter.name} опубликована · версия ${response.publication.version}`, error: false })}
      />}
      {jointSource && <JointLessonDialog
        state={copyState}
        revision={save.currentRevision()}
        csrfToken={auth.csrfToken}
        onUnauthorized={onUnauthorized}
        currentQuarterId={quarterId}
        sourceGroupId={jointSource.groupId}
        sourceLessonId={jointSource.lessonId}
        onClose={() => setJointSource(null)}
        onApply={(options) => applyBulkOperation("joint", options as unknown as Record<string, unknown>)}
      />}
      <LessonDetailsDialog
        controller={lessonDialogRef}
        catalog={catalog}
        schedule={schedule}
        subjects={allSubjects}
        groupId={groupId}
        close={() => setDetail(null)}
        onRepeat={detail => void openScheduleCopy({ groupId: detail.location.groupId, weekOffset: detail.location.weekOffset, lessonId: detail.id })}
        onJoint={detail => void openJointLesson({ groupId: detail.location.groupId, lessonId: detail.id })}
        onSave={(detail, value) => {
          applyChange(
            (current) =>
              editLesson(
                current,
                detail.location,
                detail.id,
                {
                  teacher: value.teacher,
                  teacherId: value.teacherId,
                  roomId: value.roomId,
                  room: value.room,
                  note: value.note,
                },
                value,
                catalog,
              ),
            "Урок изменён",
            detail.location,
          );
          setDetail(null);
        }}
        onDelete={detail =>
          attempt(() => {
            applyChange(
              (current) =>
                removeLesson(current, detail.location, detail.id, catalog),
              "Урок удалён",
              detail.location,
            );
            setDetail(null);
          })
        }
        onMove={(detail, lesson) => {
          setPlacement({
            lesson,
            from: { location: detail.location, id: detail.id },
          });
          setDetail(null);
        }}
      />
      {timeDialog && timingDay && (
        <Modal
          title={
            timeDialog.kind === "break"
              ? "Перемена"
              : timeDialog.wholeDay
                ? "Начало учебного дня"
                : "Время урока"
          }
          close={() => setTimeDialog(null)}
        >
          {timeDialog.kind === "break" ? (
            <BreakForm
              day={timingDay}
              slot={timeDialog.location.slot}
              defaultGap={bellBreak(bellProfile, timeDialog.location.slot)}
              close={() => setTimeDialog(null)}
              onSave={(minutes) => {
                applyChange(
                  (value) => setBreak(value, timeDialog.location, minutes),
                  "Перемена изменена",
                  timeDialog.location,
                );
                setTimeDialog(null);
              }}
            />
          ) : timeDialog.wholeDay ? (
            <DayTimeForm
              day={timingDay}
              location={timeDialog.location}
              schedule={schedule}
              catalog={catalog}
              schoolProfile={bellProfile}
              close={() => setTimeDialog(null)}
              onSave={(options) => {
                applyChange(
                  (current) => applyDayTiming(current, options, catalog),
                  options.groupIds.length > 1 ? "Время учебного дня изменено у нескольких групп" : "Время учебного дня изменено",
                  timeDialog.location,
                );
                setTimeDialog(null);
              }}
            />
          ) : (
            <TimeForm
              day={timingDay}
              slot={timeDialog.location.slot}
              close={() => setTimeDialog(null)}
              onSave={(value) => {
                applyChange(
                  (current) =>
                    setSlotTime(
                      current,
                      timeDialog.location,
                      value.start,
                      value.duration,
                      value.shiftFollowing,
                    ),
                  "Время изменено",
                  timeDialog.location,
                );
                setTimeDialog(null);
              }}
            />
          )}
        </Modal>
      )}
      {reloadConfirm && (
        <Modal
          title="Загрузить сохранённое расписание?"
          close={() => {
            if (!reloading) setReloadConfirm(false);
          }}
        >
          <p>
            Несохранённые правки на этой странице будут заменены последней
            версией из базы. История отмены очистится.
          </p>
          <div className="reload-actions">
            <button
              className="secondary-button"
              disabled={reloading}
              onClick={() => setReloadConfirm(false)}
            >
              Оставить мои правки
            </button>
            <button
              className="primary-button"
              disabled={reloading}
              onClick={() => void reloadSaved()}
            >
              {reloading ? "Загружаем…" : "Загрузить из базы"}
            </button>
          </div>
        </Modal>
      )}
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="Закрыть уведомление"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
