/**
 * Widths of the Summary / Steps / Output columns at lg+, as percentages of the
 * detail area, and their persistence in localStorage.
 *
 * Kept free of React so the clamping and storage rules are testable alone.
 */

export type ResultsColumnSplit = readonly [number, number, number];

/** Index of a divider: 0 sits between Summary and Steps, 1 between Steps and Output. */
export type ResultsColumnDivider = 0 | 1;

export const RESULTS_COLUMN_MIN_PERCENT = 18;
export const DEFAULT_RESULTS_COLUMN_SPLIT: ResultsColumnSplit = [26, 24, 50];
export const RESULTS_COLUMN_SPLIT_STORAGE_KEY = "bitsentry.results.columnSplit";

/** How far one arrow key press moves a divider. */
export const RESULTS_COLUMN_KEYBOARD_STEP = 2;

// Rounding to a tenth of a percent can leave the total a hair off 100.
const TOTAL_TOLERANCE = 0.5;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Returns `value` as a split when it is three widths that fit, else null. */
export function normalizeColumnSplit(
  value: unknown,
): ResultsColumnSplit | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const widths: unknown[] = value;
  if (
    !widths.every(
      (width) => typeof width === "number" && Number.isFinite(width),
    )
  ) {
    return null;
  }

  const [summary, steps, output] = widths as [number, number, number];
  if (Math.abs(summary + steps + output - 100) > TOTAL_TOLERANCE) return null;
  if (
    Math.min(summary, steps, output) <
    RESULTS_COLUMN_MIN_PERCENT - TOTAL_TOLERANCE
  ) {
    return null;
  }
  return [summary, steps, output];
}

export function sameColumnSplit(
  a: ResultsColumnSplit,
  b: ResultsColumnSplit,
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Moves one divider by `deltaPercent`, trading width between the two columns
 * on either side of it. Neither may drop below the minimum; the third column
 * keeps its width.
 */
export function resizeColumnSplit(
  split: ResultsColumnSplit,
  divider: ResultsColumnDivider,
  deltaPercent: number,
): ResultsColumnSplit {
  const pair = split[divider] + split[divider + 1];
  const before = roundPercent(
    clamp(
      split[divider] + deltaPercent,
      RESULTS_COLUMN_MIN_PERCENT,
      pair - RESULTS_COLUMN_MIN_PERCENT,
    ),
  );
  const after = roundPercent(pair - before);
  return divider === 0 ? [before, after, split[2]] : [split[0], before, after];
}

/** The split after a key press on a divider, or null for keys it ignores. */
export function columnSplitForKey(
  split: ResultsColumnSplit,
  divider: ResultsColumnDivider,
  key: string,
): ResultsColumnSplit | null {
  const before = split[divider];
  const pair = before + split[divider + 1];
  switch (key) {
    case "ArrowLeft":
      return resizeColumnSplit(split, divider, -RESULTS_COLUMN_KEYBOARD_STEP);
    case "ArrowRight":
      return resizeColumnSplit(split, divider, RESULTS_COLUMN_KEYBOARD_STEP);
    case "Home":
      return resizeColumnSplit(
        split,
        divider,
        RESULTS_COLUMN_MIN_PERCENT - before,
      );
    case "End":
      return resizeColumnSplit(
        split,
        divider,
        pair - RESULTS_COLUMN_MIN_PERCENT - before,
      );
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
  } catch {
    // A full or blocked store only costs the remembered widths.
  }
}
