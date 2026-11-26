/**
 * A rehype pass that keeps long chat tables readable: columns with no value in any row are marked so the inline table
 * hides them (and named on the table so the reply can say so; the full-table view still shows them), runs of identical
 * rows (same text and same link targets) fold into their first row with a "×N" count, and rows past
 * the first few are marked so the table can start collapsed. Expanded, every row shows again in its original order.
 * Kept free of React so the rules are testable alone.
 */

/** Tables longer than this start collapsed. */
const COLLAPSE_ROWS_OVER = 10;
/** A collapsed table shows this many distinct rows. */
const COLLAPSED_ROW_COUNT = 5;
/** Empty columns are only dropped when this many rows agree they are empty. */
const MIN_ROWS_FOR_EMPTY_COLUMNS = 3;

/** Cells that carry no value: blank, or a placeholder dash. */
const EMPTY_CELL = /^(?:-{1,2}|—|–|n\/a)?$/i;

/** Property names on the table element; react-markdown renders them as `data-*` attributes. */
const HIDDEN_COLUMNS_PROPERTY = "dataHiddenColumns";
const ROW_COUNT_PROPERTY = "dataRowCount";
const OVERFLOW_ROW_PROPERTY = "dataOverflowRow";
const REPEAT_ROW_PROPERTY = "dataRepeatRow";
const EMPTY_COLUMN_PROPERTY = "dataEmptyColumn";
const COLLAPSIBLE_PROPERTY = "dataCollapsible";
/** Class of the "×N" marker a folded run's first row carries; it only shows while the table is collapsed. */
const ROW_REPEAT_CLASS = "chat-markdown-row-repeat";

type HastProperties = Record<string, unknown>;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: HastProperties;
  children?: HastNode[];
}

function isElement(node: HastNode, tagName?: string): boolean {
  return node.type === "element" && (tagName === undefined || node.tagName === tagName);
}

function childElements(node: HastNode, tagName?: string): HastNode[] {
  return (node.children ?? []).filter((child) => isElement(child, tagName));
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function cellsOf(row: HastNode): HastNode[] {
  return (row.children ?? []).filter((child) => isElement(child, "td") || isElement(child, "th"));
}

function isEmptyCell(cell: HastNode | undefined): boolean {
  return cell === undefined || EMPTY_CELL.test(textOf(cell).trim());
}

function markEmptyCells(row: HastNode, hidden: ReadonlySet<number>): void {
  cellsOf(row).forEach((cell, index) => {
    if (hidden.has(index)) cell.properties = { ...cell.properties, [EMPTY_COLUMN_PROPERTY]: "" };
  });
}

/** Text plus every link target, so two rows that read the same but point to different places never fold together. */
function signatureOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  const href = node.properties?.href;
  const target = typeof href === "string" ? `\u0001${href}\u0001` : "";
  return target + (node.children ?? []).map(signatureOf).join("");
}

function compactTable(table: HastNode): void {
  const head = childElements(table, "thead")[0];
  const body = childElements(table, "tbody")[0];
  if (body === undefined) return;
  const headRow = head === undefined ? undefined : childElements(head, "tr")[0];
  const rows = childElements(body, "tr");
  const properties: HastProperties = table.properties ?? {};
  table.properties = properties;
  properties[ROW_COUNT_PROPERTY] = rows.length;

  if (head !== undefined && headRow !== undefined && rows.length >= MIN_ROWS_FOR_EMPTY_COLUMNS) {
    const headers = cellsOf(headRow);
    const hidden = new Set(
      headers
        .map((_, column) => column)
        .filter((column) => rows.every((row) => isEmptyCell(cellsOf(row)[column]))),
    );
    // A table with nothing in any column keeps its columns, so it still reads as the (empty) table it is.
    if (hidden.size > 0 && hidden.size < headers.length) {
      properties[HIDDEN_COLUMNS_PROPERTY] = JSON.stringify(
        [...hidden].map((column) => textOf(headers[column]).trim()).filter((name) => name.length > 0),
      );
      markEmptyCells(headRow, hidden);
      rows.forEach((row) => {
        markEmptyCells(row, hidden);
      });
    }
  }

  const bodyRows = childElements(body, "tr");
  const folded = foldRepeatedRows(bodyRows);
  let distinct = 0;
  let overflow = false;
  bodyRows.forEach((row) => {
    if (row.properties?.[REPEAT_ROW_PROPERTY] !== undefined) return;
    distinct += 1;
    if (rows.length > COLLAPSE_ROWS_OVER && distinct > COLLAPSED_ROW_COUNT) {
      row.properties = { ...row.properties, [OVERFLOW_ROW_PROPERTY]: "" };
      overflow = true;
    }
  });
  if (folded || overflow) properties[COLLAPSIBLE_PROPERTY] = "true";
}

function rowKey(row: HastNode): string {
  return cellsOf(row)
    .map((cell) => signatureOf(cell).trim())
    .join("\u0000");
}

/**
 * Marks every row that repeats the row above it, and gives the first row of each run a "×N" marker in its first cell.
 * Returns whether any row was folded.
 */
function foldRepeatedRows(rows: HastNode[]): boolean {
  let folded = false;
  let start = 0;
  while (start < rows.length) {
    const key = rowKey(rows[start]);
    let end = start + 1;
    while (end < rows.length && rowKey(rows[end]) === key) end += 1;
    const count = end - start;
    if (count > 1) {
      folded = true;
      for (let index = start + 1; index < end; index += 1) {
        rows[index].properties = { ...rows[index].properties, [REPEAT_ROW_PROPERTY]: "" };
      }
      const firstCell = cellsOf(rows[start])[0];
      if (firstCell !== undefined) {
        firstCell.children = [
          ...(firstCell.children ?? []),
          {
            type: "element",
            tagName: "span",
            properties: { className: [ROW_REPEAT_CLASS] },
            children: [{ type: "text", value: `×${String(count)}` }],
          },
        ];
      }
    }
    start = end;
  }
  return folded;
}

function visit(node: HastNode): void {
  if (isElement(node, "table")) {
    compactTable(node);
    return;
  }
  for (const child of node.children ?? []) visit(child);
}

/** The rehype plugin: drops empty columns and marks overflow rows in every table. */
export function rehypeCompactTables() {
  return (tree: HastNode): void => {
    visit(tree);
  };
}

/** The hidden column names a compacted table carries, from its element properties. */
export function readHiddenColumns(properties: HastProperties | undefined): string[] {
  const raw = properties?.[HIDDEN_COLUMNS_PROPERTY];
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** Whether a compacted table hides rows until it is expanded: repeated rows folded, or rows past the first few. */
export function readCollapsible(properties: HastProperties | undefined): boolean {
  return properties?.[COLLAPSIBLE_PROPERTY] === "true";
}

/** The body row count a compacted table carries, or 0 when it was not compacted. */
export function readRowCount(properties: HastProperties | undefined): number {
  const raw = properties?.[ROW_COUNT_PROPERTY];
  return typeof raw === "number" ? raw : 0;
}
