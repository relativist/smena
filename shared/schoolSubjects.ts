import type { CatalogSubject, RoomKind, SubjectColor } from "./catalog.ts";

export type SchoolSubjectPreset = {
  id: string;
  name: string;
  shortName: string;
  color: SubjectColor;
  roomKind: RoomKind | null;
  labRoomKind: RoomKind | null;
  aliases: string[];
};

const preset = (
  id: string,
  name: string,
  shortName: string,
  color: SubjectColor,
  aliases: string[] = [],
  roomKind: RoomKind | null = null,
  labRoomKind: RoomKind | null = null,
): SchoolSubjectPreset => ({
  id, name, shortName, color, roomKind, labRoomKind,
  aliases: [name, shortName, ...aliases],
});

// Shared subject catalog baseline. Matching aliases preserve established local records.
export const schoolSubjectPresets: SchoolSubjectPreset[] = [
  preset("russian", "Русский язык", "Русс. яз.", "rose", ["Русский", "Русс. яз.", "Рус. яз."]),
  preset("literature", "Литература", "Лит-ра", "amber", ["Литерат.", "Лит-ра"]),
  preset("school:literary-reading", "Литературное чтение", "Лит. чтение", "peach", ["Лит. чтение"]),
  preset("math", "Математика", "Матем.", "blue", ["Матем.", "Матем"]),
  preset("school:algebra", "Алгебра", "Алгебра", "indigo"),
  preset("school:geometry", "Геометрия", "Геометрия", "violet"),
  preset("school:probability-statistics", "Вероятность и статистика", "Вероятн. и статист.", "cyan", ["Теория вероятностей и статистика"]),
  preset("english", "Английский язык", "Англ. яз.", "teal", ["Английский", "Англ. яз", "Англ яз", "Англ. язык", "English"]),
  preset("school:german", "Немецкий язык", "Нем. яз.", "olive", ["Немецкий", "Нем. яз.", "Deutsch"]),
  preset("school:french", "Французский язык", "Франц. яз.", "plum", ["Французский", "Франц. яз.", "Français"]),
  preset("school:chinese", "Китайский язык", "Кит. яз.", "berry", ["Китайский", "Кит. яз.", "中文"]),
  preset("history", "История", "История", "rust"),
  preset("school:social-studies", "Обществознание", "Обществоз.", "moss", ["Общ-ние", "Обществоз.", "Общ-ние"]),
  preset("school:geography", "География", "География", "green"),
  preset("physics", "Физика", "Физика", "sky", [], null, "physics-lab"),
  preset("school:chemistry", "Химия", "Химия", "lime", [], null, "chemistry-lab"),
  preset("biology", "Биология", "Биология", "mint"),
  preset("school:world-around", "Окружающий мир", "Окруж. мир", "olive", ["Окружающий мир (предмет)"]),
  preset("informatics", "Информатика", "Информ.", "cyan", ["Информатика и ИКТ", "Информ.", "Инф-ка"], "informatics"),
  preset("school:technology", "Труд (технология)", "Технология", "coral", ["Технология / труд", "Технология", "Труд", "Трудовое обучение"]),
  preset("school:visual-arts", "Изобразительное искусство", "Изо", "orchid", ["ИЗО", "Рисование"]),
  preset("school:music", "Музыка", "Музыка", "berry"),
  preset("pe", "Физическая культура", "Физ-ра", "green", ["Физкультура", "Физ-ра", "Физическая культура (физкультура)"], "gym"),
  preset("school:safety", "Основы безопасности и защиты Родины", "ОБЗР", "slate", ["ОБЗР", "ОБЖ", "Основы безопасности жизнедеятельности", "Основы безопасности и защиты Родины (ОБЗР)" ]),
  preset("school:orkse", "Основы религиозных культур и светской этики", "ОРКСЭ", "amber", ["ОРКСЭ", "ORKSE"]),
];

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Adds only presets that have no exact ID, name, short-name, or alias match.
 * Review-only generic names are intentionally ignored: a generic combined
 * course should not prevent the concrete subjects from being available.
 */
export function addMissingSchoolSubjectPresets(existing: CatalogSubject[]): CatalogSubject[] {
  const exactMatches = new Set<string>();
  for (const item of schoolSubjectPresets) {
    const aliases = new Set(item.aliases.map(normalize));
    if (existing.some((subject) =>
      subject.id === item.id || aliases.has(normalize(subject.name)) || aliases.has(normalize(subject.shortName))
    )) exactMatches.add(item.id);
  }
  const additions = schoolSubjectPresets
    .filter((item) => !exactMatches.has(item.id))
    .map((item) => ({
      id: item.id, name: item.name, shortName: item.shortName,
      color: item.color, roomKind: item.roomKind, labRoomKind: item.labRoomKind,
      archived: false,
    } satisfies CatalogSubject));
  return [...existing, ...additions];
}
