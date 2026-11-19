import { useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
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
  return (
    <ol className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 gap-2">
          <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <StructuredValue value={item} depth={depth + 1} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** One field's value: plain values as text, nested values indented under the label until they get too deep. */
function FieldValue({ value, depth }: { value: unknown; depth: number }) {
  const { t } = useTranslation();
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
          className="rounded-sm text-xs font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
