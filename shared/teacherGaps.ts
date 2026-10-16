/** A scheduled activity that occupies a teacher's time. */
export type TeacherGapActivity = {
  id: string;
  start: number;
  duration: number;
  /** Actual normal break immediately before this activity in its group. */
  breakBefore?: number;
  /** Actual normal break immediately after this activity in its group. */
  breakAfter?: number;
};

export type TeacherGap = {
  start: number;
  end: number;
  minutes: number;
  normalBreakMinutes: number;
};

type Block = { start: number; end: number; activities: TeacherGapActivity[] };

/**
 * Find waits between occupied intervals. Overlapping and touching activities
 * are first unioned so joint lessons and subgroup mirrors cannot create gaps.
 * Only gaps longer than the most conservative adjacent normal break are kept.
 */
export function calculateTeacherGaps(
  activities: TeacherGapActivity[],
  fallbackNormalBreakMinutes = 10,
): TeacherGap[] {
  const fallback = Number.isFinite(fallbackNormalBreakMinutes) && fallbackNormalBreakMinutes >= 0
    ? fallbackNormalBreakMinutes
    : 10;
  const ordered = activities
    .filter((activity) => Number.isFinite(activity.start) && Number.isFinite(activity.duration) && activity.duration > 0)
    .map((activity) => ({ ...activity, end: activity.start + activity.duration }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const blocks: Block[] = [];
  for (const activity of ordered) {
    const last = blocks.at(-1);
    if (last && activity.start <= last.end) {
      last.end = Math.max(last.end, activity.end);
      last.activities.push(activity);
    } else {
      blocks.push({ start: activity.start, end: activity.end, activities: [activity] });
    }
  }

  const gaps: TeacherGap[] = [];
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const previous = blocks[index]!;
    const next = blocks[index + 1]!;
    const minutes = next.start - previous.end;
    const after = previous.activities
      .filter((activity) => activity.start + activity.duration === previous.end)
      .map((activity) => validBreak(activity.breakAfter, fallback));
    const before = next.activities
      .filter((activity) => activity.start === next.start)
      .map((activity) => validBreak(activity.breakBefore, fallback));
    const edgeBreaks = [...after, ...before];
    const normalBreakMinutes = edgeBreaks.length ? Math.max(...edgeBreaks) : fallback;
    if (minutes > normalBreakMinutes) gaps.push({ start: previous.end, end: next.start, minutes, normalBreakMinutes });
  }
  return gaps;
}

function validBreak(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}
