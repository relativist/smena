export const subjectIcons = [
  { id: "book", label: "Книга" },
  { id: "russian", label: "Русский язык" },
  { id: "literature", label: "Литература" },
  { id: "reading", label: "Литературное чтение" },
  { id: "math", label: "Математика" },
  { id: "algebra", label: "Алгебра" },
  { id: "geometry", label: "Геометрия" },
  { id: "statistics", label: "Вероятность и статистика" },
  { id: "flag-uk", label: "Английский язык" },
  { id: "flag-de", label: "Немецкий язык" },
  { id: "flag-fr", label: "Французский язык" },
  { id: "flag-cn", label: "Китайский язык" },
  { id: "history", label: "История" },
  { id: "society", label: "Обществознание" },
  { id: "geography", label: "География" },
  { id: "physics", label: "Физика" },
  { id: "chemistry", label: "Химия" },
  { id: "biology", label: "Биология" },
  { id: "world", label: "Окружающий мир" },
  { id: "informatics", label: "Информатика" },
  { id: "technology", label: "Труд и технология" },
  { id: "art", label: "Изобразительное искусство" },
  { id: "music", label: "Музыка" },
  { id: "sport", label: "Физическая культура" },
  { id: "safety", label: "Основы безопасности" },
  { id: "ethics", label: "ОРКСЭ" },
] as const;

export type SubjectIconId = (typeof subjectIcons)[number]["id"];

const iconIds = new Set<string>(subjectIcons.map(({ id }) => id));
export function isSubjectIconId(value: unknown): value is SubjectIconId {
  return typeof value === "string" && iconIds.has(value);
}

export type SubjectIconSubject = {
  id?: string;
  name?: string;
  shortName?: string;
  iconId?: SubjectIconId | "auto" | null;
};

function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const presetIcons: Record<string, SubjectIconId> = {
  russian: "russian", literature: "literature", "school:literary-reading": "reading",
  math: "math", "school:algebra": "algebra", "school:geometry": "geometry",
  "school:probability-statistics": "statistics", english: "flag-uk", "school:german": "flag-de",
  "school:french": "flag-fr", "school:chinese": "flag-cn", history: "history",
  "school:social-studies": "society", "school:geography": "geography", physics: "physics",
  "school:chemistry": "chemistry", biology: "biology", "school:world-around": "world",
  informatics: "informatics", "school:technology": "technology", "school:visual-arts": "art",
  "school:music": "music", pe: "sport", "school:safety": "safety", "school:orkse": "ethics",
};

const namesToIcons = new Map<string, SubjectIconId>();
function aliases(id: SubjectIconId, ...names: string[]) {
  for (const name of names) namesToIcons.set(normalize(name), id);
}
aliases("russian", "Русский язык", "Русский", "Русс. яз.", "Рус. яз.");
aliases("literature", "Литература", "Литерат.", "Лит-ра");
aliases("reading", "Литературное чтение", "Лит. чтение");
aliases("math", "Математика", "Матем.", "Матем");
aliases("algebra", "Алгебра"); aliases("geometry", "Геометрия");
aliases("statistics", "Вероятность и статистика", "Теория вероятностей и статистика");
aliases("flag-uk", "Английский язык", "Английский", "Англ. яз", "Англ. язык", "English");
aliases("flag-de", "Немецкий язык", "Немецкий", "Нем. яз", "Deutsch");
aliases("flag-fr", "Французский язык", "Французский", "Франц. яз", "Français");
aliases("flag-cn", "Китайский язык", "Китайский", "Кит. яз", "中文");
aliases("history", "История"); aliases("society", "Обществознание", "Обществоз.", "Общ-ние");
aliases("geography", "География"); aliases("physics", "Физика"); aliases("chemistry", "Химия");
aliases("biology", "Биология"); aliases("world", "Окружающий мир", "Окруж. мир");
aliases("informatics", "Информатика", "Информатика и ИКТ", "Информ.", "Инф-ка");
aliases("technology", "Труд (технология)", "Технология", "Труд", "Трудовое обучение");
aliases("art", "Изобразительное искусство", "ИЗО", "Рисование"); aliases("music", "Музыка");
aliases("sport", "Физическая культура", "Физкультура", "Физ-ра");
aliases("safety", "Основы безопасности и защиты Родины", "ОБЗР", "ОБЖ", "Основы безопасности жизнедеятельности");
aliases("ethics", "Основы религиозных культур и светской этики", "ОРКСЭ", "ORKSE");

export function resolveSubjectIconId(subject: SubjectIconSubject): SubjectIconId | null {
  if (subject.iconId === null) return null;
  if (isSubjectIconId(subject.iconId)) return subject.iconId;
  if (subject.id && presetIcons[subject.id]) return presetIcons[subject.id];
  const fromName = subject.name ? namesToIcons.get(normalize(subject.name)) : undefined;
  if (fromName) return fromName;
  const fromShortName = subject.shortName ? namesToIcons.get(normalize(subject.shortName)) : undefined;
  return fromShortName ?? "book";
}
