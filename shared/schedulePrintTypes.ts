import type { Quarter } from "./plans.ts";
import type { PublicPublication, PublicStudentDay } from "./studentTypes.ts";

export type SchedulePrintSource = "published" | "draft";
export type SchedulePrintGroup = { id: string; name: string };
export type SchedulePrintIndex = {
  revision: number;
  published: Array<Quarter & { publication: PublicPublication; groups: SchedulePrintGroup[] }>;
  draft: Array<Quarter & { groups: SchedulePrintGroup[] }>;
};
export type SchedulePrintPreviewRequest = {
  source: SchedulePrintSource;
  quarterId: string;
  weekStart: string;
  groupIds: string[];
  version?: number;
  revision?: number;
};
export type SchedulePrintPreview = {
  source: SchedulePrintSource;
  quarter: Quarter;
  weekStart: string;
  weekEnd: string;
  publication?: PublicPublication;
  draftRevision?: number;
  groups: Array<{ group: SchedulePrintGroup; days: PublicStudentDay[] }>;
};
