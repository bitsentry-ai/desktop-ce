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
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
  label: string;
  copyText: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
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

/**
 * A JSON or plain-text block with its toolbar. JSON starts unwrapped so its
 * indentation holds; plain text starts wrapped. "Wrap lines" flips either.
 */
function MonospaceOutputBlock({
  label,
  copyText,
  lead,
  text,
  json,
}: {
  label: string;
  copyText: string;
  lead: string;
  text: string;
  json: boolean;
}) {
  const [wrap, setWrap] = useState(!json);
  return (
    <div className={RUN_OUTPUT_BLOCK_CLASS}>
      <BlockToolbar label={label} copyText={copyText}>
        <WrapLinesToggle
          wrap={wrap}
          onToggle={() => {
            setWrap((current) => !current);
          }}
        />
      </BlockToolbar>
      {lead.length > 0 && (
        <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm text-foreground">
          {lead}
        </p>
      )}
      <TruncatedMonospace text={text} json={json} wrap={wrap} />
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
