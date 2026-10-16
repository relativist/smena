export const subjectColors = [
  {
    id: "blue",
    name: "Синий",
    ink: "#506ba8",
    tint: "#f0f4fc",
    line: "#e1e8f7",
    dot: "#809de0",
  },
  {
    id: "amber",
    name: "Оранжевый",
    ink: "#967840",
    tint: "#fbf8f0",
    line: "#f0e9d9",
    dot: "#cbb07b",
  },
  {
    id: "green",
    name: "Зелёный",
    ink: "#5e8c6e",
    tint: "#f1f7f2",
    line: "#e1ece3",
    dot: "#87b396",
  },
  {
    id: "rose",
    name: "Розовый",
    ink: "#a56c81",
    tint: "#fbf2f6",
    line: "#f1e4eb",
    dot: "#cc99ac",
  },
  {
    id: "violet",
    name: "Фиолетовый",
    ink: "#7969ae",
    tint: "#f5f2fb",
    line: "#e9e3f5",
    dot: "#a094d1",
  },
  {
    id: "teal",
    name: "Бирюзовый",
    ink: "#578d8d",
    tint: "#eff8f7",
    line: "#dfeedf",
    dot: "#81b6b5",
  },
  {
    id: "coral",
    name: "Коралловый",
    ink: "#a9574d",
    tint: "#fff3f0",
    line: "#f5dfda",
    dot: "#e49585",
  },
  {
    id: "cyan",
    name: "Голубой",
    ink: "#477b91",
    tint: "#f0f8fb",
    line: "#dcecf2",
    dot: "#83bacd",
  },
  {
    id: "lime",
    name: "Лаймовый",
    ink: "#6d8243",
    tint: "#f7f9ef",
    line: "#e9eed8",
    dot: "#afc477",
  },
  {
    id: "plum",
    name: "Сливовый",
    ink: "#825878",
    tint: "#faf3f8",
    line: "#eddfeb",
    dot: "#bb91b2",
  },
  {
    id: "indigo",
    name: "Индиго",
    ink: "#596c9e",
    tint: "#f2f4fb",
    line: "#e0e5f3",
    dot: "#8c9ccb",
  },
  {
    id: "mint",
    name: "Мятный",
    ink: "#4d8375",
    tint: "#eff8f4",
    line: "#dceee6",
    dot: "#83b9a6",
  },
  {
    id: "rust",
    name: "Терракотовый",
    ink: "#986548",
    tint: "#fbf5f0",
    line: "#eee2d7",
    dot: "#c99b78",
  },
  {
    id: "sky",
    name: "Небесный",
    ink: "#527fa8",
    tint: "#f1f7fc",
    line: "#dfeaf5",
    dot: "#8eb4d5",
  },
  {
    id: "olive",
    name: "Оливковый",
    ink: "#707b45",
    tint: "#f7f8f0",
    line: "#e8ead9",
    dot: "#aeb77b",
  },
  {
    id: "orchid",
    name: "Орхидея",
    ink: "#8b5c99",
    tint: "#faf4fb",
    line: "#ecdef0",
    dot: "#bd91c9",
  },
  {
    id: "slate",
    name: "Серо-синий",
    ink: "#5d7183",
    tint: "#f3f6f8",
    line: "#e2e8ec",
    dot: "#9aafbf",
  },
  {
    id: "peach",
    name: "Персиковый",
    ink: "#a56d4f",
    tint: "#fff6f0",
    line: "#f2e4d9",
    dot: "#d9a27f",
  },
  {
    id: "moss",
    name: "Моховый",
    ink: "#557b5c",
    tint: "#f1f7f1",
    line: "#dfebdf",
    dot: "#8eb294",
  },
  {
    id: "berry",
    name: "Ягодный",
    ink: "#9a586a",
    tint: "#fcf3f5",
    line: "#f0e0e5",
    dot: "#d18d9d",
  },
] as const;

export type SubjectColor = (typeof subjectColors)[number]["id"];

export function recommendSubjectColor(
  subjects: readonly { id: string; color: SubjectColor; archived: boolean }[],
  currentColor?: SubjectColor,
  editingId?: string,
  avoidCurrent = false,
): SubjectColor {
  const counts = new Map<SubjectColor, number>(
    subjectColors.map(({ id }) => [id, 0]),
  );
  for (const subject of subjects) {
    if (subject.archived || subject.id === editingId) continue;
    counts.set(subject.color, (counts.get(subject.color) ?? 0) + 1);
  }

  const palette = subjectColors.map(({ id }) => id);
  if (avoidCurrent) {
    const ordered = [...palette].sort(
      (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0),
    );
    const currentIndex = currentColor ? ordered.indexOf(currentColor) : -1;
    return (
      ordered[(currentIndex + 1 + ordered.length) % ordered.length] ??
      palette[0]
    );
  }

  const alternatives = palette;
  const leastUsed = Math.min(...alternatives.map((id) => counts.get(id) ?? 0));
  let candidates = alternatives.filter(
    (id) => (counts.get(id) ?? 0) === leastUsed,
  );
  if (!avoidCurrent && currentColor && candidates.length > 1)
    candidates = candidates.filter((id) => id !== currentColor);
  return candidates[0] ?? subjectColors[0].id;
}
