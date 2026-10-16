export type Subject = {
  id: string;
  name: string;
  teacher: string;
  fullTeacher: string;
  room: string;
  color: "blue" | "amber" | "green" | "rose" | "violet" | "teal";
  planned: number;
  target: number;
  subgroups?: {
    name: string;
    teacher: string;
    fullTeacher: string;
    room: string;
    planned: number;
    target: number;
  }[];
};

export type Group = {
  id: string;
  name: string;
  students: number;
  leader: string;
  room: string;
  start: string;
};

export type Lesson = {
  subjectId: string;
  lessonKind?: "regular" | "lab";
  teacherId?: string;
  roomId?: string;
  subgroupId?: string;
  subgroup?: string;
  teacher?: string;
  room?: string;
  event?: string;
  jointId?: string;
};

export type Day = {
  date: string;
  start: string;
  duration: number;
  breaks: number[];
  slots: Lesson[][];
  note?: string;
  holiday?: boolean;
};

export const subjects: Subject[] = [
  {
    id: "math",
    name: "Математика",
    teacher: "Соколова",
    fullTeacher: "Соколова Марина Викторовна",
    room: "214",
    color: "blue",
    planned: 28,
    target: 40,
  },
  {
    id: "russian",
    name: "Русский язык",
    teacher: "Иванова",
    fullTeacher: "Иванова Елена Сергеевна",
    room: "208",
    color: "rose",
    planned: 24,
    target: 40,
  },
  {
    id: "literature",
    name: "Литература",
    teacher: "Иванова",
    fullTeacher: "Иванова Елена Сергеевна",
    room: "208",
    color: "amber",
    planned: 8,
    target: 18,
  },
  {
    id: "english",
    name: "Английский язык",
    teacher: "Петрова",
    fullTeacher: "Петрова Анна Андреевна",
    room: "312",
    color: "violet",
    planned: 12,
    target: 24,
  },
  {
    id: "history",
    name: "История",
    teacher: "Кузнецов",
    fullTeacher: "Кузнецов Дмитрий Олегович",
    room: "205",
    color: "teal",
    planned: 16,
    target: 16,
  },
  {
    id: "physics",
    name: "Физика",
    teacher: "Михайлова",
    fullTeacher: "Михайлова Наталья Александровна",
    room: "310",
    color: "green",
    planned: 8,
    target: 18,
  },
  {
    id: "informatics",
    name: "Информатика",
    teacher: "Орлова",
    fullTeacher: "Орлова Светлана Игоревна",
    room: "Комп. класс",
    color: "blue",
    planned: 8,
    target: 18,
    subgroups: [
      {
        name: "5А/1",
        teacher: "Орлова",
        fullTeacher: "Орлова Светлана Игоревна",
        room: "Комп. 1",
        planned: 8,
        target: 18,
      },
      {
        name: "5А/2",
        teacher: "Демидов-Константиновский",
        fullTeacher: "Демидов-Константиновский Александр Константинович",
        room: "Комп. 2",
        planned: 7,
        target: 18,
      },
    ],
  },
  {
    id: "biology",
    name: "Биология",
    teacher: "Фёдорова",
    fullTeacher: "Фёдорова Ирина Павловна",
    room: "316",
    color: "green",
    planned: 6,
    target: 16,
  },
  {
    id: "pe",
    name: "Физкультура",
    teacher: "Волков",
    fullTeacher: "Волков Сергей Николаевич",
    room: "Спортзал",
    color: "amber",
    planned: 10,
    target: 24,
  },
];

export const groups: Group[] = [
  {
    id: "5a",
    name: "5А",
    students: 28,
    leader: "Иванова Елена Сергеевна",
    room: "208",
    start: "08:30",
  },
  {
    id: "5b",
    name: "5Б",
    students: 26,
    leader: "Соколова Марина Викторовна",
    room: "214",
    start: "14:00",
  },
  {
    id: "6a",
    name: "6А",
    students: 30,
    leader: "Петрова Анна Андреевна",
    room: "312",
    start: "09:00",
  },
];

const defaultBreaks = [10, 10, 15, 10, 10, 10];
const weekOne: Lesson[][][] = [
  [
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "english" }],
    [
      {
        subjectId: "informatics",
        subgroup: "5А/1",
        teacher: "Орлова",
        room: "Комп. 1",
      },
      {
        subjectId: "informatics",
        subgroup: "5А/2",
        teacher: "Демидов-Константиновский",
        room: "Комп. 2",
      },
    ],
    [{ subjectId: "pe" }],
    [{ subjectId: "history" }],
    [],
  ],
  [
    [{ subjectId: "russian" }],
    [{ subjectId: "math" }],
    [{ subjectId: "physics" }],
    [{ subjectId: "english" }],
    [{ subjectId: "biology" }],
    [],
    [{ subjectId: "literature" }],
  ],
  [
    [{ subjectId: "english" }],
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "physics", teacher: "Михайлова" }],
    [{ subjectId: "history" }],
    [{ subjectId: "pe" }],
    [],
  ],
  [
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "literature" }],
    [{ subjectId: "biology" }],
    [{ subjectId: "english" }],
    [],
    [],
  ],
  [
    [{ subjectId: "russian" }],
    [{ subjectId: "math" }],
    [{ subjectId: "physics" }],
    [
      {
        subjectId: "informatics",
        subgroup: "5А/1",
        teacher: "Орлова",
        room: "Комп. 1",
      },
      {
        subjectId: "informatics",
        subgroup: "5А/2",
        teacher: "Демидов-Константиновский",
        room: "Комп. 2",
      },
    ],
    [{ subjectId: "pe" }],
    [],
    [],
  ],
];

const weekTwo: Lesson[][][] = [
  [
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "english" }],
    [{ subjectId: "biology" }],
    [{ subjectId: "history" }],
    [],
    [],
  ],
  [
    [{ subjectId: "russian" }],
    [{ subjectId: "math" }],
    [{ subjectId: "physics" }],
    [{ subjectId: "english" }],
    [{ subjectId: "pe" }],
    [],
    [],
  ],
  [
    [{ subjectId: "english" }],
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "history" }],
    [{ subjectId: "biology" }],
    [],
    [],
  ],
  [
    [{ subjectId: "math" }],
    [{ subjectId: "russian" }],
    [{ subjectId: "literature" }],
    [{ subjectId: "physics" }],
    [{ subjectId: "english" }],
    [],
    [],
  ],
  [
    [{ subjectId: "russian" }],
    [{ subjectId: "math" }],
    [{ subjectId: "event", event: "Линейка", room: "Актовый зал" }],
    [
      {
        subjectId: "informatics",
        subgroup: "5А/1",
        teacher: "Орлова",
        room: "Комп. 1",
      },
      {
        subjectId: "informatics",
        subgroup: "5А/2",
        teacher: "Демидов-Константиновский",
        room: "Комп. 2",
      },
    ],
    [{ subjectId: "pe" }],
    [],
    [],
  ],
];

const addMinutes = (time: string, amount: number): string => {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + amount;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const dateAtOffset = (offset: number, day: number): string => {
  const date = new Date(2026, 9, 5 + offset * 7 + day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export function getWeek(groupId: string, weekOffset: number): Day[] {
  const group = groups.find((item) => item.id === groupId) ?? groups[0];
  if (weekOffset === 3) {
    return Array.from(
      { length: 5 },
      (_, day): Day => ({
        date: dateAtOffset(weekOffset, day),
        start: group.start,
        duration: 45,
        breaks: [...defaultBreaks],
        slots: Array.from({ length: 7 }, () => []),
        note: "Осенние каникулы",
        holiday: true,
      }),
    );
  }

  const source = weekOffset === 1 ? weekTwo : weekOne;
  return source.map((sourceSlots, dayIndex): Day => {
    const slots = sourceSlots.map((lessons) =>
      lessons.map((lesson) => ({ ...lesson })),
    );
    if (groupId === "5b") {
      for (const slot of slots) {
        for (const lesson of slot) {
          if (lesson.subgroup)
            lesson.subgroup = lesson.subgroup.replace("5А", "5Б");
        }
      }
    } else if (groupId === "6a") {
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        for (const lesson of slot) {
          if (lesson.subjectId === "informatics") {
            slots[index] = [
              {
                subjectId: "informatics",
                teacher: "Орлова",
                room: "Комп. класс",
              },
            ];
            break;
          }
        }
      }
    }
    return {
      date: dateAtOffset(weekOffset, dayIndex),
      start:
        dayIndex === 4 && weekOffset === 0
          ? addMinutes(group.start, 30)
          : group.start,
      duration: dayIndex === 2 && weekOffset === 0 ? 35 : 45,
      breaks: [...defaultBreaks],
      slots,
      ...(dayIndex === 2 && weekOffset === 0
        ? { note: "Сокращённый день" }
        : {}),
    };
  });
}
