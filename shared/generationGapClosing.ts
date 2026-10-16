import type { EditorDay } from "../src/editor.ts";

export type GapPlacement = {
  lessonId: string;
  slot: number;
};

export type GapClosingOptions<T extends GapPlacement> = {
  day: EditorDay;
  placements: T[];
  isMovable?: (placement: T) => boolean;
  canMove: (placement: T, destination: number, positions: ReadonlyMap<string, number>, moving: ReadonlySet<string>) => boolean;
  maxMoves?: number;
  maxSearches?: number;
  shouldCancel?: () => boolean;
};

/** Finds a bounded chain that reduces internal empty slots without mutating the day or placements. */
export function findGapClosingMoves<T extends GapPlacement>({
  day,
  placements,
  isMovable = () => true,
  canMove,
  maxMoves = 3,
  maxSearches = 100,
  shouldCancel,
}: GapClosingOptions<T>): Map<string, number> | undefined {
  if (placements.length < 1) return undefined;
  const movablePlacements = placements.filter(isMovable);
  const generatedIds = new Set(movablePlacements.map((entry) => entry.lessonId));
  const originalSlots = day.slots.map((rows) => rows.map((lesson) => lesson.id));
  const countGaps = (positions: ReadonlyMap<string, number>) => {
    const occupied = day.slots.map((rows, slot) => rows.some((lesson) => !generatedIds.has(lesson.id)) ||
      movablePlacements.some((entry) => (positions.get(entry.lessonId) ?? entry.slot) === slot));
    const first = occupied.indexOf(true);
    const last = occupied.lastIndexOf(true);
    return first < 0 ? 0 : occupied.slice(first, last + 1).filter((value) => !value).length;
  };
  const initialGaps = countGaps(new Map());
  if (!initialGaps) return undefined;
  let explored = 0;
  let solution: Map<string, number> | undefined;
  const search = (positions: Map<string, number>, chain: Set<string>, destination: number, moves: number): boolean => {
    if (shouldCancel?.()) throw new Error("Составление расписания отменено");
    if (++explored > maxSearches) return false;
    const occupiedAt = (slot: number) => originalSlots[slot]!.some((lessonId) => !generatedIds.has(lessonId)) ||
      movablePlacements.some((entry) => (positions.get(entry.lessonId) ?? entry.slot) === slot);
    if (occupiedAt(destination)) return false;
    if (countGaps(positions) < initialGaps) { solution = new Map(positions); return true; }
    if (moves >= maxMoves) return false;
    const sources = movablePlacements
      .filter((entry) => !chain.has(entry.lessonId))
      .filter((entry) => {
        const slot = positions.get(entry.lessonId) ?? entry.slot;
        const fixedRows = originalSlots[slot]!.filter((lessonId) => !generatedIds.has(lessonId));
        return fixedRows.length === 0 && movablePlacements.filter((other) => (positions.get(other.lessonId) ?? other.slot) === slot).length === 1;
      })
      .sort((a, b) => Math.abs((positions.get(b.lessonId) ?? b.slot) - destination) - Math.abs((positions.get(a.lessonId) ?? a.slot) - destination));
    for (const placement of sources) {
      const source = positions.get(placement.lessonId) ?? placement.slot;
      if (source === destination || !canMove(placement, destination, positions, chain)) continue;
      const next = new Map(positions);
      next.set(placement.lessonId, destination);
      const nextChain = new Set(chain).add(placement.lessonId);
      if (countGaps(next) < initialGaps) { solution = next; return true; }
      if (search(next, nextChain, source, moves + 1)) return true;
    }
    return false;
  };
  const firstOccupied = day.slots.findIndex((rows) => rows.length > 0);
  let lastOccupied = -1;
  for (let slot = day.slots.length - 1; slot >= 0; slot -= 1)
    if (day.slots[slot]!.length) { lastOccupied = slot; break; }
  const emptySlots = day.slots.flatMap((rows, slot) => !rows.length && slot > firstOccupied && slot < lastOccupied ? [slot] : []);
  for (const empty of emptySlots) {
    search(new Map(), new Set(), empty, 0);
    if (solution) break;
  }
  return solution && countGaps(solution) < initialGaps ? solution : undefined;
}
