import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogSubject } from "../shared/catalog.ts";
import {
  addMissingSchoolSubjectPresets,
  schoolSubjectPresets,
} from "../shared/schoolSubjects.ts";

const subject = (id: string, name: string, shortName = name, archived = false): CatalogSubject => ({
  id, name, shortName, archived, color: "blue", roomKind: null, labRoomKind: null,
});

test("catalog baseline contains 25 named presets with valid colors and unique IDs", async () => {
  const { subjectColors } = await import("../shared/subjectColors.ts");
  assert.equal(schoolSubjectPresets.length, 25);
  assert.equal(new Set(schoolSubjectPresets.map(({ id }) => id)).size, 25);
  assert.deepEqual(schoolSubjectPresets.map(({ name }) => name), [
    "Русский язык", "Литература", "Литературное чтение", "Математика", "Алгебра", "Геометрия",
    "Вероятность и статистика", "Английский язык", "Немецкий язык", "Французский язык", "Китайский язык",
    "История", "Обществознание", "География", "Физика", "Химия", "Биология", "Окружающий мир",
    "Информатика", "Труд (технология)", "Изобразительное искусство", "Музыка", "Физическая культура",
    "Основы безопасности и защиты Родины", "Основы религиозных культур и светской этики",
  ]);
  for (const item of schoolSubjectPresets) assert.ok(subjectColors.some(({ id }) => id === item.color));
  assert.deepEqual(schoolSubjectPresets.find(({ id }) => id === "school:safety")?.aliases.slice(2, 4), ["ОБЗР", "ОБЖ"]);
});

test("automatic fill populates an empty catalog and is idempotent", () => {
  const added = addMissingSchoolSubjectPresets([]);
  assert.equal(added.length, schoolSubjectPresets.length);
  assert.deepEqual(addMissingSchoolSubjectPresets(added), added);
});

test("exact ID, name, short-name and aliases preserve local records", () => {
  const existing = [
    subject("russian", "Русский язык переименован", "Русский", true),
    subject("local-english", "Мой предмет", "English"),
    subject("local-math", "Мой курс математики", "Матем."),
  ];
  const added = addMissingSchoolSubjectPresets(existing);
  assert.deepEqual(added.slice(0, existing.length), existing);
  assert.equal(added.filter(({ id }) => id === "russian").length, 1);
  assert.equal(added.filter(({ id }) => id === "english").length, 0);
  assert.equal(added.filter(({ id }) => id === "math").length, 0);
});

test("generic and combined names do not suppress concrete subjects", () => {
  const existing = [
    subject("local-foreign", "Иностранный язык", "Ин. яз."),
    subject("local-combined-history", "История и обществознание"),
    subject("local-combined-math", "Алгебра и геометрия"),
  ];
  const added = addMissingSchoolSubjectPresets(existing);
  for (const id of ["english", "school:german", "school:french", "school:chinese", "history", "school:social-studies", "school:algebra", "school:geometry"])
    assert.ok(added.some((item) => item.id === id), `expected ${id} to be added`);
  assert.deepEqual(added.slice(0, existing.length), existing);
});
