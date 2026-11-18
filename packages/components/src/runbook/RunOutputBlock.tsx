import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, Copy, WrapText } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { MarkdownContent } from "../markdown";
import { cn } from "../lib/utils";
import { HighlightedJson } from "./HighlightedJson";
import {
  findRecordTable,
  recordColumnLabel,
  severityTone,
  type RecordTable,
} from "./recordTable";
import { detectRunOutputFormat, truncateLines } from "./runOutputFormat";
import {
  RUN_OUTPUT_BLOCK_CLASS,
  RUN_OUTPUT_MONO_CLASS,
  RUN_OUTPUT_WRAPPED_CLASS,
} from "./runOutputStyles";

// Past this a captured payload stops being readable at a glance and starts
// costing real layout time, so the rest stays behind "Show all".
export const RUN_OUTPUT_MAX_VISIBLE_LINES = 200;

const COPIED_FEEDBACK_MS = 1200;

// Edge shadows of the JSON scroller; shown by `useHorizontalScrollEdges`.
const SCROLL_SHADOW_CLASS =
  "pointer-events-none absolute inset-y-0 w-4 opacity-0 transition-opacity duration-150";

export function RunOutputCopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (timerRef.current != null) clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, COPIED_FEEDBACK_MS);
      })
      .catch(() => {});
  };

  const Icon = copied ? Check : Copy;
  const label = copied ? t("common.results.copied") : t("common.results.copy");

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={t("common.results.copyOutput")}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <Icon size={12} aria-hidden="true" />
      <span aria-live="polite">{label}</span>
    </button>
  );
}

const BLOCK_TOOL_BUTTON_CLASS =
  "inline-flex h-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-11";

/** Toggles soft wrapping of long lines; pressed while lines wrap. */
function WrapLinesToggle({
  wrap,
  onToggle,
}: {
  wrap: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t("common.results.wrapLines");
  return (
    <button
      type="button"
      aria-pressed={wrap}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(
        BLOCK_TOOL_BUTTON_CLASS,
        "w-6 max-sm:w-11",
        wrap && "border-foreground/20 bg-muted text-foreground",
      )}
    >
      <WrapText size={12} aria-hidden="true" />
    </button>
  );
}

function BlockToolbar({
  label,
  copyText,
  children,
}: {
  label: ReactNode;
  copyText: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1.5">
      {typeof label === "string" ? (
        <span className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </span>
      ) : (
        label
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {children}
        <RunOutputCopyButton text={copyText} />
      </div>
    </div>
  );
}

/**
 * Marks which edges of a horizontal scroller have content past them, as
 * `data-scroll-start` / `data-scroll-end` on `frame`. Written straight to the
 * DOM so scrolling never re-renders the output.
 */
function useHorizontalScrollEdges(
  frameRef: RefObject<HTMLDivElement | null>,
  scrollerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLPreElement | null>,
) {
  useEffect(() => {
    const frame = frameRef.current;
    const scroller = scrollerRef.current;
    if (frame === null || scroller === null) return undefined;

    const update = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      frame.dataset.scrollStart = String(scroller.scrollLeft > 1);
      frame.dataset.scrollEnd = String(scroller.scrollLeft < maxScroll - 1);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });

    // The content grows when "Show all" expands it, the scroller when the
    // column is resized.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(scroller);
      if (contentRef.current !== null) observer.observe(contentRef.current);
    }

    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [frameRef, scrollerRef, contentRef]);
}

/**
 * Captured monospace output. Unwrapped, long lines scroll sideways (JSON keeps
 * its indentation) with a soft shadow on whichever side has more; wrapped,
 * they fold back at the column edge and no shadow shows.
 */
function MonospaceScrollArea({
  text,
  json,
  wrap,
}: {
  text: string;
  json: boolean;
  wrap: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  useHorizontalScrollEdges(frameRef, scrollerRef, contentRef);

  return (
    <div ref={frameRef} className="group/json relative min-w-0">
      <div ref={scrollerRef} className="overflow-x-auto overscroll-x-contain">
        <pre
          ref={contentRef}
          className={cn(
            RUN_OUTPUT_MONO_CLASS,
            "px-3 pb-3",
            wrap ? RUN_OUTPUT_WRAPPED_CLASS : "w-max min-w-full whitespace-pre",
          )}
        >
          {json ? <HighlightedJson text={text} /> : text}
        </pre>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          SCROLL_SHADOW_CLASS,
          "left-0 bg-gradient-to-r from-[hsl(var(--foreground)/0.08)] to-transparent group-data-[scroll-start=true]/json:opacity-100",
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          SCROLL_SHADOW_CLASS,
          "right-0 bg-gradient-to-l from-[hsl(var(--foreground)/0.08)] to-transparent group-data-[scroll-end=true]/json:opacity-100",
        )}
      />
    </div>
  );
}

function TruncatedMonospace({
  text,
  json,
  wrap,
}: {
  text: string;
  json: boolean;
  wrap: boolean;
}) {
  const { t } = useTranslation();
  // Tracks which text was expanded, so selecting another step collapses again
  // without an effect.
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  const truncated = useMemo(
    () => truncateLines(text, RUN_OUTPUT_MAX_VISIBLE_LINES),
    [text],
  );

  let toggle: ReactNode = null;
  if (truncated.truncated) {
    toggle = (
      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpandedText(expanded ? null : text);
          }}
          className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
        >
          {expanded
            ? t("common.results.showFewerLines")
            : t("common.results.showAllLines", { count: truncated.totalLines })}
        </button>
      </div>
    );
  }

  return (
    <>
      <MonospaceScrollArea
        text={expanded ? text : truncated.text}
        json={json}
        wrap={wrap}
      />
      {toggle}
    </>
  );
}

type OutputView = "table" | "json";

const VIEW_BUTTON_CLASS =
  "inline-flex h-6 items-center rounded-[5px] px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-10 max-sm:px-3";

/** Switches a record list between its table and the raw JSON. */
function OutputViewSwitch({
  view,
  onChange,
}: {
  view: OutputView;
  onChange: (view: OutputView) => void;
}) {
  const { t } = useTranslation();
  const options: { value: OutputView; label: string }[] = [
    { value: "table", label: t("common.results.viewTable") },
    { value: "json", label: "JSON" },
  ];
  return (
    <div
      role="group"
      aria-label={t("common.results.outputView")}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            VIEW_BUTTON_CLASS,
            view === option.value && "bg-muted text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function formatCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return JSON.stringify(cell);
}

const SEVERITY_DOT_CLASS = {
  critical: "bg-destructive",
  warning: "bg-[hsl(var(--warning))]",
} as const;

/** A record list as a table: one row per record, the columns that tell records apart. */
function RecordTableView({ table }: { table: RecordTable }) {
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
                  return (
                    <td
                      key={column}
                      title={text}
                      className={cn(
                        "h-9 truncate px-3 text-foreground",
                        numeric.has(column) && "text-right tabular-nums",
                      )}
                    >
                      {tone === null ? (
                        text
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

/** JSON lines longer than this hold prose (descriptions, messages), which reads better wrapped. */
const PROSE_LINE_LENGTH = 160;

function hasProseLine(text: string): boolean {
  return text.split("\n").some((line) => line.length > PROSE_LINE_LENGTH);
}

/**
 * A JSON or plain-text block with its toolbar. Compact JSON starts unwrapped so
 * its indentation holds; JSON with prose-length values, and plain text, start
 * wrapped. "Wrap lines" flips either.
 */
function MonospaceOutputBlock({
  label,
  copyText,
  lead,
  text,
  json,
  table = null,
}: {
  label: string;
  copyText: string;
  lead: string;
  text: string;
  json: boolean;
  table?: RecordTable | null;
}) {
  const [wrap, setWrap] = useState(() => !json || hasProseLine(text));
  const [view, setView] = useState<OutputView>("table");
  const showTable = table !== null && view === "table";
  return (
    <div className={RUN_OUTPUT_BLOCK_CLASS}>
      <BlockToolbar
        label={
          table === null ? label : <OutputViewSwitch view={view} onChange={setView} />
        }
        copyText={copyText}
      >
        {!showTable && (
          <WrapLinesToggle
            wrap={wrap}
            onToggle={() => {
              setWrap((current) => !current);
            }}
          />
        )}
      </BlockToolbar>
      {lead.length > 0 && (
        <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm text-foreground">
          {lead}
        </p>
      )}
      {showTable ? (
        <RecordTableView table={table} />
      ) : (
        <TruncatedMonospace text={text} json={json} wrap={wrap} />
      )}
    </div>
  );
}

/**
 * Renders captured step output: JSON (or JSON-in-a-string, or a lead sentence
 * followed by JSON) pretty-printed and syntax-coloured in a sideways scroller,
 * Markdown rendered, anything else as wrapped monospace text. JSON and text
 * carry "Wrap lines" and Copy buttons and cap at
 * {@link RUN_OUTPUT_MAX_VISIBLE_LINES} lines until expanded.
 */
export function RunOutputBlock({
  value,
  emptyMessage,
}: {
  value: string;
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  const format = useMemo(() => detectRunOutputFormat(value), [value]);
  const table = useMemo(
    () => (format.kind === "json" ? findRecordTable(format.value) : null),
    [format],
  );

  switch (format.kind) {
    case "empty":
      return (
        <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
      );
    case "markdown":
      return (
        <div className={RUN_OUTPUT_BLOCK_CLASS}>
          <BlockToolbar
            label={t("common.results.formatMarkdown")}
            copyText={format.text}
          />
          <div className="px-3 pb-3 text-sm">
            <MarkdownContent
              content={format.text}
              className="min-w-0 max-w-full"
            />
          </div>
        </div>
      );
    case "json":
      return (
        <MonospaceOutputBlock
          key="json"
          label="JSON"
          copyText={format.copyText}
          lead={format.lead}
          text={format.display}
          json
          table={table}
        />
      );
    case "text":
      return (
        <MonospaceOutputBlock
          key="text"
          label={t("common.results.formatText")}
          copyText={format.text}
          lead=""
          text={format.text}
          json={false}
        />
      );
  }
}
