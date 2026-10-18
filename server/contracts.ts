import type { Quarter, StudyPlan } from "../shared/plans.ts";
import type { Catalog, CatalogKind } from "../shared/catalog.ts";
import type { Schedule, EditorDay, EditorLesson, Location } from "../src/editor.ts";
import type { SchoolCalendar } from "../shared/schoolCalendar.ts";
import type { Curriculum } from "../shared/curricula.ts";
import type { BellSettings } from "../shared/bellSchedule.ts";
import type { DisplaySettingsResponse } from "../shared/displaySettings.ts";
import type { TemporaryTeacherReplacement } from "../shared/temporaryTeacherReplacements.ts";
import type { AutomaticTeacherReplacementPreview, ReplacementRequest } from "../shared/automaticTeacherReplacement.ts";
import type { TeacherLessonOrigin, TeacherTeachingAssignment } from "../shared/teacherReassignment.ts";

export interface PlanBaseline {
  groupId: string;
  subjectId: string;
  subgroup: string | null;
  subgroupId?: string;
  planned: number;
  target: number;
  initialCount: number;
}

export interface StateResponse {
  schedule: Schedule;
  revision: number;
  updatedAt: string;
  baseline: PlanBaseline[];
  catalog: Catalog;
  catalogDeletionBlockers?: Partial<Record<CatalogKind, Record<string, string[]>>>;
  quarters: Quarter[];
  studyPlans: StudyPlan[];
  curricula?: Curriculum[];
  calendar?: SchoolCalendar;
  bellSettings?: BellSettings;
  displaySettings?: DisplaySettingsResponse;
  temporaryTeacherReplacements?: TemporaryTeacherReplacement[];
  teacherLessonOrigins?: TeacherLessonOrigin[];
  teachingAssignments?: TeacherTeachingAssignment[];
  editorScope?: EditorScope;
  editorBootstrap?: boolean;
  plansScope?: { quarterId: string };
  curriculumTemplates?: Curriculum[];
}

/** A mutation receipt; consumers reload their own scoped view at this revision. */
export type TeacherReassignmentReceipt = { revision: number; updatedAt: string; operationId?: string };

export type EditorScope = {
  groupId: string;
  quarterId: string;
  weekOffset: number;
  dates: string[];
  counts: Array<{ subjectId: string; subgroupId: string | null; lessonKind: "regular" | "lab"; count: number }>;
  weeks?: Array<{ weekOffset: number; holiday: boolean; event: boolean }>;
};
export type EditorPlacement = {
  lesson: Omit<EditorLesson, "id">;
  from?: { location: Location; id: string };
};
export type EditorPreviewRequest = {
  revision: number;
  groupId: string;
  quarterId: string;
  weekOffset: number;
  payload: EditorPlacement;
  autoRoom: boolean;
};
export type EditorTarget = {
  date: string;
  slot: number;
  self: boolean;
  swap: boolean;
  reason: string | null;
  payload: EditorPlacement;
  label: string;
};
export type EditorPreviewResponse = { revision: number; targets: EditorTarget[] };
export type EditorDayChange = { key: string; dayIndex: number; before: EditorDay; after: EditorDay };
export type EditorDaysRequest = { revision: number; requestId: string; changes: EditorDayChange[] };
export type EditorDaysResponse = { revision: number; updatedAt: string };

export type TeacherReplacementPreviewResponse = {
  revision: number;
  preview: AutomaticTeacherReplacementPreview;
};

export type TeacherReplacementApplyResponse = {
  state: StateResponse;
  operationId: string;
};

export type TeacherReplacementUndoResponse = { state: StateResponse };
export type TeacherReplacementApplyReceipt = { revision: number; updatedAt: string; operationId: string };
export type TeacherReplacementUndoReceipt = { revision: number; updatedAt: string };

export type TeacherReplacementPreviewRequest = { revision: number; request: ReplacementRequest };
