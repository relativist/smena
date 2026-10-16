import { generateQuarter } from "../shared/generateSchedule.ts";
import type { Schedule } from "./editor.ts";

type GenerateMessage = {
  type: "generate";
  id: number;
  state: Parameters<typeof generateQuarter>[0];
  quarterId: string;
  groupIds: string[];
  options: { preserveExisting: boolean; allowJointLessons: boolean };
};

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<GenerateMessage>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = ({ data }) => {
  if (data.type !== "generate") return;
  const { id, state, quarterId, groupIds, options } = data;
  try {
    const result = generateQuarter(state, quarterId, groupIds, {
      ...options,
      onProgress: (progress) => scope.postMessage({ type: "progress", id, progress }),
    });
    scope.postMessage({ type: "result", id, result: result as { schedule: Schedule } });
  } catch (reason) {
    scope.postMessage({
      type: "error",
      id,
      error: reason instanceof Error ? reason.message : "Не удалось составить расписание.",
    });
  }
};
