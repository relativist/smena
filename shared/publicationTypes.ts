import type { StateResponse } from "../server/contracts.ts";
import type { Quarter } from "./plans.ts";

export type PublicationSnapshot = Pick<StateResponse,
  "schedule" | "catalog" | "studyPlans" | "curricula" | "baseline" | "calendar" | "bellSettings"
> & { quarter: Quarter };

export type PublicationMetadata = {
  quarterId: string;
  version: number;
  publishedAt: string;
  draftRevision: number;
  publishedBy: string;
};

export type PublicationIssue = {
  code: string;
  message: string;
  groupId?: string;
  date?: string;
  lessonId?: string;
};

export type PublicationSummary = {
  groupCount: number;
  lessonCount: number;
  added: number;
  removed: number;
  changed: number;
  affectedGroupIds: string[];
  settingsChanged: boolean;
};

export type PublicationPreview = {
  quarter: Quarter;
  revision: number;
  previous: PublicationMetadata | null;
  summary: PublicationSummary;
  errors: PublicationIssue[];
  warnings: PublicationIssue[];
  canPublish: boolean;
};

export type PublishedQuarterResponse = {
  publication: PublicationMetadata;
  snapshot: PublicationSnapshot;
};

export type PublishResponse = {
  publication: PublicationMetadata;
  summary: PublicationSummary;
  unchanged?: boolean;
};
