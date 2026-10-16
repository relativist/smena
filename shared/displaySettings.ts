export interface DisplaySettings {
  adminSubjectIcons: boolean;
  studentSubjectIcons: boolean;
  schoolName: string;
}

export interface PublicDisplaySettings {
  schoolName: string;
  studentSubjectIcons: boolean;
}

export interface DisplaySettingsResponse {
  settings: DisplaySettings;
  revision: number;
}

export function defaultDisplaySettings(): DisplaySettings {
  return { adminSubjectIcons: true, studentSubjectIcons: true, schoolName: "" };
}
