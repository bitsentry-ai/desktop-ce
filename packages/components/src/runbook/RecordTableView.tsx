import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import {
  isIdentifierColumn,
  readableKey,
  recordColumnLabel,
  severityTone,
  type RecordTable,
} from "./recordTable";

/** A lower-case snake_case token such as `vendor_fix_available`: a state name, which reads better as words. */
const ENUM_VALUE = /^[a-z]+(?:_[a-z]+)+$/;

function formatCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return ENUM_VALUE.test(cell) ? readableKey(cell) : cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return JSON.stringify(cell);
}

const SEVERITY_DOT_CLASS = {
  critical: "bg-foreground",
  warning: "bg-muted-foreground/60",
} as const;

/** A record list as a table: one row per record, the columns that tell records apart. */
export function RecordTableView({ table }: { table: RecordTable }) {
  const { t } = useTranslation();
  // Number columns are short; they take a narrow right-aligned track so the
  // text columns share the rest of the pane instead of scrolling sideways.
  const numeric = new Set(
    table.columns.filter((column) =>
      table.rows.every(
        (row) => row[column] === undefined || typeof row[column] === "number",
      ),
    ),
  );
  return (
    <div className="border-t border-border">
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {t("common.results.recordCount", { count: table.total })}
        {table.name !== null && (
          <>
            {" · "}
            <span className="font-mono text-foreground/80">{table.name}</span>
          </>
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] table-fixed border-collapse text-left text-[13px] leading-5">
          <thead>
            <tr className="border-y border-border bg-muted/40">
              {table.columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  title={column}
                  className={cn(
                    "h-8 truncate px-3 text-xs font-medium text-muted-foreground",
                    numeric.has(column) && "w-24 text-right",
                    isIdentifierColumn(column) && "w-40",
                  )}
                >
                  {recordColumnLabel(column, table.columns)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr
                // Records have no stable id of their own; their order is fixed by the payload.
                key={index}
                className="border-b border-border/60 last:border-b-0 hover:bg-muted/40"
              >
                {table.columns.map((column) => {
                  const text = formatCell(row[column]);
                  const tone = severityTone(column, row[column]);
                  // Identifiers and numbers stay on one line; other text wraps to two, so names that differ only near
                  // the end (package versions, hostnames) stay readable.
                  const singleLine = numeric.has(column) || isIdentifierColumn(column);
                  const plain = singleLine ? text : <span className="line-clamp-2 [overflow-wrap:anywhere]">{text}</span>;
                  return (
                    <td
                      key={column}
                      title={text}
                      className={cn(
                        "h-9 px-3 text-foreground",
                        singleLine ? "truncate" : "py-1.5",
                        numeric.has(column) && "text-right tabular-nums",
                        isIdentifierColumn(column) && "font-mono text-xs",
                      )}
                    >
                      {tone === null ? (
                        plain
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <span
                            aria-hidden="true"
                            className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT_CLASS[tone])}
                          />
                          {text}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.total > table.rows.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t("common.results.recordsShown", {
            shown: table.rows.length,
            count: table.total,
          })}
        </p>
      )}
    </div>
  );
}
