export type ArchiveCounts = { groups: number; teachers: number; rooms: number; lessons: number };

export type ArchiveManifest = {
  format: "smena-school-archive";
  formatVersion: 1;
  applicationVersion: string;
  postgresMajorVersion: number;
  schemaVersions: number[];
  createdAt: string;
  schoolName: string;
  counts: ArchiveCounts;
  tables: Array<{ name: string; columns: string[]; rows: number }>;
};

export type ArchivePreview = {
  token: string;
  expiresAt: string;
  archive: ArchiveManifest;
  current: { revision: number; displayRevision: number; schoolName: string; counts: ArchiveCounts };
};

export type ArchiveRestoreResult = {
  restored: true;
  backupFilename: string;
  counts: ArchiveCounts;
};

export type ArchiveRestoreStatus = {
  state: "ready" | "restoring" | "complete" | "failed";
  result?: ArchiveRestoreResult;
  error?: string;
};

export type ArchiveAvailability = { supported: boolean; reason?: string };

export const MAX_ARCHIVE_UPLOAD_BYTES = 128 * 1024 * 1024;
