import { useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { ChevronRight } from "../icons";
import { cn } from "../lib/utils";
import { parseJsonContainer } from "./runOutputFormat";
import { findRecordTable, readableKey } from "./recordTable";
import { RecordTableView } from "./RecordTableView";

/** Objects nested deeper than this show as a one-line summary instead of more indented rows. */
const MAX_DEPTH = 3;

/** A lower-case snake_case token such as `vendor_fix_pending`: a state name, which reads better as words. */
const ENUM_VALUE = /^[a-z]+(?:_[a-z]+)+$/;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

function ScalarText({ value }: { value: unknown }) {
  const { t } = useTranslation();
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">{t("common.structured.empty")}</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? t("common.structured.yes") : t("common.structured.no")}</span>;
  }
  if (typeof value === "number") {
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  const text = String(value);
  if (ENUM_VALUE.test(text)) return <span>{readableKey(text)}</span>;
  const technical = !text.includes(" ") && /[/:._-]/.test(text);
  return <span className={cn("whitespace-pre-line [overflow-wrap:anywhere]", technical && "font-mono text-[12px]")}>{text}</span>;
}

function countLabel(value: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (Array.isArray(value)) return t("common.structured.items", { count: value.length });
  if (isObject(value)) return t("common.structured.fields", { count: Object.keys(value).length });
  return "";
}

/** A long list shows this many entries first, with the rest one click away. */
const LIST_PREVIEW = 5;

interface ListEntry {
  item: unknown;
  /** How many identical items this entry stands for: the item and the ones right after it. */
  count: number;
  /** Position of the first such item. */
  index: number;
}

/** JSON with object keys sorted, so records that differ only in key order count as identical. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Runs of identical neighbours folded into one entry with a count. Only neighbours fold, so the list keeps its order:
 * A, A, B, A reads as A ×2, B, A.
 */
function groupIdenticalItems(items: readonly unknown[]): ListEntry[] {
  const entries: ListEntry[] = [];
  let previousKey: string | null = null;
  items.forEach((item, index) => {
    const key = stableKey(item);
    const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
    if (last !== undefined && key === previousKey) {
      last.count += 1;
      return;
    }
    previousKey = key;
    entries.push({ item, count: 1, index });
  });
  return entries;
}

const LIST_TOGGLE_CLASS =
  "rounded-sm text-xs font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A list of records or mixed values. Folded, runs of identical items show once marked "×N" and a long list shows its
 * first {@link LIST_PREVIEW} entries; "Show all" lists every item, numbered, in its original order.
 */
function RecordList({ items, depth }: { items: unknown[]; depth: number }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const entries = groupIdenticalItems(items);
  const grouped = entries.length < items.length;
  // Hiding a single entry behind a button saves nothing.
  const capped = entries.length > LIST_PREVIEW + 1;
  const folded = (grouped || capped) && !showAll;
  const foldedCount = capped ? LIST_PREVIEW : entries.length;
  const visible: ListEntry[] = folded
    ? entries.slice(0, foldedCount)
    : items.map((item, index) => ({ item, count: 1, index }));
  return (
    <div className="min-w-0 space-y-1.5">
      <ol className="space-y-2">
        {visible.map((entry) => (
          <li key={entry.index} className="flex min-w-0 gap-2">
            <span
              className="min-w-5 shrink-0 whitespace-nowrap text-right text-xs leading-5 tabular-nums text-muted-foreground"
              title={folded && grouped ? t("common.structured.identicalItems", { count: entry.count }) : undefined}
            >
              {folded && grouped ? `×${String(entry.count)}` : entry.index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <StructuredValue value={entry.item} depth={depth + 1} />
            </div>
          </li>
        ))}
      </ol>
      {(grouped || capped) && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => {
            setShowAll((current) => !current);
          }}
          className={LIST_TOGGLE_CLASS}
        >
          {showAll
            ? t("common.structured.showFewer")
            : t("common.structured.showAllItems", { count: items.length })}
        </button>
      )}
    </div>
  );
}

function ListValue({ items, depth }: { items: unknown[]; depth: number }) {
  const { t } = useTranslation();
  if (items.length === 0) return <span className="text-muted-foreground">{t("common.structured.none")}</span>;
  const table = findRecordTable(items);
  if (table !== null) return <RecordTableView table={table} />;
  if (items.every(isScalar)) {
    return (
      <span className="[overflow-wrap:anywhere]">
        {items.map((item, index) => (
          <span key={index}>
            {index > 0 && ", "}
            <ScalarText value={item} />
          </span>
        ))}
      </span>
    );
  }
  return <RecordList items={items} depth={depth} />;
}

/** A string that holds a JSON list or object long enough to stretch the view; shorter ones read fine as text. */
const FOLDED_JSON_TEXT = 160;

/** JSON carried as a string, such as findings handed to a plugin: folded to its size, readable values one click away. */
function JsonTextValue({ value }: { value: object }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="inline-flex max-w-full items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight size={14} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {countLabel(value, t)}
      </button>
      {open && (
        <div className="mt-1.5 max-h-80 overflow-y-auto overscroll-contain border-l border-border pl-3 [scrollbar-width:thin]">
          <StructuredValue value={value} />
        </div>
      )}
    </div>
  );
}

/** One field's value: plain values as text, nested values indented under the label until they get too deep. */
function FieldValue({ value, depth }: { value: unknown; depth: number }) {
  const { t } = useTranslation();
  if (typeof value === "string" && value.length > FOLDED_JSON_TEXT) {
    const data = parseJsonContainer(value);
    if (data !== null) return <JsonTextValue value={data} />;
  }
  if (isScalar(value)) return <ScalarText value={value} />;
  if (depth + 1 >= MAX_DEPTH) return <span className="text-muted-foreground">{countLabel(value, t)}</span>;
  return (
    <div className="border-l border-border pl-3">
      <StructuredValue value={value} depth={depth + 1} />
    </div>
  );
}

function ObjectRows({ value, depth, limit }: { value: JsonObject; depth: number; limit?: number }) {
  const { t } = useTranslation();
  const entries = Object.entries(value);
  const [showAll, setShowAll] = useState(false);
  if (entries.length === 0) return <span className="text-muted-foreground">{t("common.structured.none")}</span>;
  const visible = limit === undefined || showAll ? entries : entries.slice(0, limit);
  const hidden = entries.length - visible.length;
  return (
    <div className="min-w-0 space-y-1.5">
      <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px] leading-5">
        {visible.map(([key, field]) => (
          <div key={key} className="contents">
            <dt className="max-w-[11rem] truncate text-muted-foreground" title={key}>
              {readableKey(key)}
            </dt>
            <dd className="m-0 min-w-0 text-foreground">
              <FieldValue value={field} depth={depth} />
            </dd>
          </div>
        ))}
      </dl>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            setShowAll(true);
          }}
          className={LIST_TOGGLE_CLASS}
        >
          {t("common.structured.showAllFields", { count: entries.length })}
        </button>
      )}
    </div>
  );
}

/**
 * Any JSON value as something a person can read, never as raw JSON: an object as labelled rows (nested objects
 * indented under their label), a list of records as a table, a list of plain values as a comma list, and a single
 * value as text. `limit` shows that many top-level fields first, with the rest one click away.
 */
export function StructuredValue({ value, depth = 0, limit }: { value: unknown; depth?: number; limit?: number }) {
  if (Array.isArray(value)) return <ListValue items={value} depth={depth} />;
  if (isObject(value)) return <ObjectRows value={value} depth={depth} limit={limit} />;
  return (
    <span className="text-[13px] leading-5">
      <ScalarText value={value} />
    </span>
  );
}
