/**
 * Finds a list of records in a step's JSON output and picks the columns worth
 * showing, so the Output pane can lead with a table of findings instead of the
 * raw payload. Kept free of React so the selection rules are testable alone.
 */

export interface RecordTable {
  /** The property that holds the records, or null when the payload is the list itself. */
  name: string | null;
  /** Total records in the list. */
  total: number;
  /** Records flattened to dotted keys, capped at {@link RECORD_TABLE_MAX_ROWS}. */
  rows: Record<string, unknown>[];
  /** Dotted keys, in display order. */
  columns: string[];
}

export const RECORD_TABLE_MAX_ROWS = 200;
/** Four columns fit the Output pane at 1440px without truncating identifiers. */
const MAX_COLUMNS = 4;
const MIN_ROWS = 2;
/** A column must have a scalar in at least this share of rows. */
const MIN_COLUMN_COVERAGE = 0.6;
/** Columns whose values average longer than this hold prose, which reads badly in a cell. */
const MAX_AVERAGE_CELL_LENGTH = 60;
const FLATTEN_DEPTH = 3;

/** Columns that identify or rank a record come first, in this order. */
const IDENTIFIER_PATTERN = /(^|\.)(cve|id|key|ref)$/i;

const COLUMN_PRIORITY: readonly RegExp[] = [
  /severity|priority|level/i,
  IDENTIFIER_PATTERN,
  /(^|\.)(name|title|host|hostname)$/i,
  /version$/i,
  /score|count|total/i,
  /status|state|result/i,
];

/** Last segments too generic to stand alone as a column header. */
const GENERIC_SEGMENTS = new Set([
  "id",
  "name",
  "version",
  "base",
  "type",
  "value",
  "key",
]);

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function flatten(
  value: PlainObject,
  prefix = "",
  depth = 0,
  out: PlainObject = {},
): PlainObject {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainObject(child) && depth < FLATTEN_DEPTH) {
      flatten(child, path, depth + 1, out);
    } else {
      out[path] = child;
    }
  }
  return out;
}

function recordList(
  value: unknown,
): { name: string | null; items: PlainObject[] } | null {
  const isRecordArray = (candidate: unknown): candidate is PlainObject[] =>
    Array.isArray(candidate) &&
    candidate.length >= MIN_ROWS &&
    candidate.every(isPlainObject);

  if (isRecordArray(value)) return { name: null, items: value };
  if (!isPlainObject(value)) return null;

  let best: { name: string; items: PlainObject[] } | null = null;
  for (const [name, child] of Object.entries(value)) {
    if (isRecordArray(child) && (best === null || child.length > best.items.length)) {
      best = { name, items: child };
    }
  }
  return best;
}

function priorityOf(column: string): number {
  const index = COLUMN_PRIORITY.findIndex((pattern) => pattern.test(column));
  return index === -1 ? COLUMN_PRIORITY.length : index;
}

function pickColumns(rows: PlainObject[]): string[] {
  const seen = new Map<string, { scalars: number; length: number; values: Set<string> }>();
  for (const row of rows) {
    for (const [key, cell] of Object.entries(row)) {
      if (!isScalar(cell)) continue;
      const text = String(cell);
      const stats = seen.get(key) ?? { scalars: 0, length: 0, values: new Set<string>() };
      stats.scalars += 1;
      stats.length += text.length;
      stats.values.add(text);
      seen.set(key, stats);
    }
  }

  const candidates = [...seen.entries()].filter(
    ([, stats]) =>
      stats.scalars / rows.length >= MIN_COLUMN_COVERAGE &&
      stats.length / stats.scalars <= MAX_AVERAGE_CELL_LENGTH &&
      // A value every record shares tells the reader nothing about any one record.
      stats.values.size > 1,
  );

  return candidates
    .map(([key], order) => ({ key, order, priority: priorityOf(key) }))
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .slice(0, MAX_COLUMNS)
    .map(({ key }) => key);
}

/** The record list in `value` with its columns, or null when it doesn't read as a table. */
export function findRecordTable(value: unknown): RecordTable | null {
  const list = recordList(value);
  if (list === null) return null;
  const rows = list.items.slice(0, RECORD_TABLE_MAX_ROWS).map((item) => flatten(item));
  const columns = pickColumns(rows);
  if (columns.length < 2) return null;
  return { name: list.name, total: list.items.length, rows, columns };
}

function lastSegment(column: string): string {
  const segments = column.split(".");
  return segments[segments.length - 1] ?? column;
}

/**
 * A column's header: its last key segment, or the last two when that segment
 * is generic ("package.name", "vulnerability.id") or shared with another column.
 */
export function recordColumnLabel(column: string, columns: readonly string[]): string {
  const segments = column.split(".");
  const last = lastSegment(column);
  const shared = columns.some(
    (other) => other !== column && lastSegment(other) === last,
  );
  if (segments.length > 1 && (GENERIC_SEGMENTS.has(last) || shared)) {
    return segments.slice(-2).join(".");
  }
  return last;
}

/** Whether a column holds identifiers, which the table never truncates. */
export function isIdentifierColumn(column: string): boolean {
  return IDENTIFIER_PATTERN.test(column);
}

/** How strongly a severity-like cell should read. */
export function severityTone(
  column: string,
  cell: unknown,
): "critical" | "warning" | null {
  if (!/severity|priority|level/i.test(column) || typeof cell !== "string") {
    return null;
  }
  const value = cell.toLowerCase();
  if (value === "critical" || value === "high") return "critical";
  if (value === "medium" || value === "moderate") return "warning";
  return null;
}
