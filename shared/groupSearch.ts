export const GROUP_SEARCH_HELP = "Обычный поиск — по части названия: 1а найдёт 1А и 11А. Добавьте ! для точного поиска: !1 — все первые классы, !1а — только 1А. Регистр не учитывается.";

/** A leading ! matches a whole grade number or an exact group name. */
export function matchesGroupSearch(name: string, query: string): boolean {
  const value = name.trim().toLocaleLowerCase("ru");
  const search = query.trim().toLocaleLowerCase("ru");
  if (!search.startsWith("!")) return value.includes(search);
  const exact = search.slice(1).trim();
  if (!exact) return true;
  if (/^\d+$/u.test(exact)) return value.match(/^\d+/u)?.[0] === exact;
  return value === exact;
}
