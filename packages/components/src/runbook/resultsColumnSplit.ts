/**
 * Widths of the Summary and Steps columns at lg+, in CSS pixels, and their
 * persistence in localStorage. Output takes whatever width is left.
 *
 * Kept free of React so the clamping and storage rules are testable alone.
 */

/** [Summary, Steps] widths in px. */
export type ResultsColumnSplit = readonly [number, number];

/** Index of a divider: 0 sits after Summary, 1 after Steps. */
export type ResultsColumnDivider = 0 | 1;

export const DEFAULT_RESULTS_COLUMN_SPLIT: ResultsColumnSplit = [300, 300];

/** Narrowest and widest each fixed column may be dragged to. */
export const RESULTS_COLUMN_LIMITS: readonly [
  { min: number; max: number },
  { min: number; max: number },
] = [
  { min: 220, max: 560 },
  { min: 180, max: 480 },
];

/**
 * v2 stores pixels. The v1 key held percentages of a container whose width is
 * unknown here, so it is dropped rather than converted.
 */
export const RESULTS_COLUMN_SPLIT_STORAGE_KEY =
  "bitsentry.results.columnWidths.v2";
export const LEGACY_RESULTS_COLUMN_SPLIT_STORAGE_KEY =
  "bitsentry.results.columnSplit";

/** How far one arrow key press moves a divider. */
const RESULTS_COLUMN_KEYBOARD_STEP = 16;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

function clampWidth(divider: ResultsColumnDivider, value: number): number {
  const { min, max } = RESULTS_COLUMN_LIMITS[divider];
  return Math.round(Math.min(Math.max(value, min), max));
}

/** Returns `value` as a split (clamped to the limits) when it is two widths, else null. */
export function normalizeColumnSplit(
  value: unknown,
): ResultsColumnSplit | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const widths: unknown[] = value;
  if (
    !widths.every(
      (width) => typeof width === "number" && Number.isFinite(width),
    )
  ) {
    return null;
  }

  const [summary, steps] = widths as [number, number];
  return [clampWidth(0, summary), clampWidth(1, steps)];
}

export function sameColumnSplit(
  a: ResultsColumnSplit,
  b: ResultsColumnSplit,
): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Moves one divider by `deltaPx`, resizing the column before it within its
 * limits. Output, the flexible column, absorbs the difference.
 */
export function resizeColumnSplit(
  split: ResultsColumnSplit,
  divider: ResultsColumnDivider,
  deltaPx: number,
): ResultsColumnSplit {
  const width = clampWidth(divider, split[divider] + deltaPx);
  return divider === 0 ? [width, split[1]] : [split[0], width];
}

/** The split after a key press on a divider, or null for keys it ignores. */
export function columnSplitForKey(
  split: ResultsColumnSplit,
  divider: ResultsColumnDivider,
  key: string,
): ResultsColumnSplit | null {
  const { min, max } = RESULTS_COLUMN_LIMITS[divider];
  const current = split[divider];
  switch (key) {
    case "ArrowLeft":
      return resizeColumnSplit(split, divider, -RESULTS_COLUMN_KEYBOARD_STEP);
    case "ArrowRight":
      return resizeColumnSplit(split, divider, RESULTS_COLUMN_KEYBOARD_STEP);
    case "Home":
      return resizeColumnSplit(split, divider, min - current);
    case "End":
      return resizeColumnSplit(split, divider, max - current);
    default:
      return null;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can be blocked outright (privacy settings, sandboxed frames).
    return null;
  }
}

export function readColumnSplit(
  storage: StorageReader | null = browserStorage(),
): ResultsColumnSplit {
  if (storage === null) return DEFAULT_RESULTS_COLUMN_SPLIT;
  try {
    const raw = storage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY);
    if (raw === null) return DEFAULT_RESULTS_COLUMN_SPLIT;
    return (
      normalizeColumnSplit(JSON.parse(raw)) ?? DEFAULT_RESULTS_COLUMN_SPLIT
    );
  } catch {
    return DEFAULT_RESULTS_COLUMN_SPLIT;
  }
}

export function writeColumnSplit(
  split: ResultsColumnSplit,
  storage: StorageWriter | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY, JSON.stringify(split));
    storage.removeItem?.(LEGACY_RESULTS_COLUMN_SPLIT_STORAGE_KEY);
  } catch {
    // A full or blocked store only costs the remembered widths.
  }
}
