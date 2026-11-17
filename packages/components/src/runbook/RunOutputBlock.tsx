import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { MarkdownContent } from "../markdown";
import { detectRunOutputFormat, truncateLines } from "./runOutputFormat";

// Past this a captured payload stops being readable at a glance and starts
// costing real layout time, so the rest stays behind "Show all".
export const RUN_OUTPUT_MAX_VISIBLE_LINES = 200;

const COPIED_FEEDBACK_MS = 1200;

const BLOCK_CLASS =
  "min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-muted/20";
const MONO_CLASS =
  "m-0 min-w-0 max-w-full whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]";

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

function BlockToolbar({ label, copyText }: { label: string; copyText: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <RunOutputCopyButton text={copyText} />
    </div>
  );
}

function TruncatedMonospace({ text }: { text: string }) {
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
      <pre className={MONO_CLASS}>{expanded ? text : truncated.text}</pre>
      {toggle}
    </>
  );
}

/**
 * Renders captured step output: JSON (or JSON-in-a-string, or a lead sentence
 * followed by JSON) pretty-printed in monospace, Markdown rendered, anything
 * else as monospace text. JSON and text carry a Copy button and cap at
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
      return <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>;
    case "markdown":
      return (
        <div className={BLOCK_CLASS}>
          <BlockToolbar label={t("common.results.formatMarkdown")} copyText={format.text} />
          <div className="px-3 pb-3 text-sm">
            <MarkdownContent content={format.text} className="min-w-0 max-w-full" />
          </div>
        </div>
      );
    case "json":
      return (
        <div className={BLOCK_CLASS}>
          <BlockToolbar label="JSON" copyText={format.copyText} />
          {format.lead.length > 0 && (
            <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm text-foreground">
              {format.lead}
            </p>
          )}
          <TruncatedMonospace text={format.display} />
        </div>
      );
    case "text":
      return (
        <div className={BLOCK_CLASS}>
          <BlockToolbar label={t("common.results.formatText")} copyText={format.text} />
          <TruncatedMonospace text={format.text} />
        </div>
      );
  }
}
