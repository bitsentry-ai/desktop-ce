import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import { HighlightedJson } from "./HighlightedJson";
import { RUN_OUTPUT_MAX_VISIBLE_LINES } from "./RunOutputBlock";
import { runOutputPreview } from "./runOutputFormat";
import {
  RUN_OUTPUT_BLOCK_CLASS,
  RUN_OUTPUT_MONO_CLASS,
  RUN_OUTPUT_WRAPPED_CLASS,
} from "./runOutputStyles";

const ACTION_BUTTON_CLASS =
  "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

function isClipped(element: HTMLElement | null): boolean {
  return element !== null && element.scrollHeight > element.clientHeight + 1;
}

/**
 * Sets `data-clamped` on `frame` while either clamped element hides text, so
 * "Show more" only appears when there is more. Written straight to the DOM so
 * measuring never re-renders the summary.
 */
function useClampedFlag(
  frameRef: RefObject<HTMLDivElement | null>,
  leadRef: RefObject<HTMLParagraphElement | null>,
  bodyRef: RefObject<HTMLPreElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || !active) return undefined;

    const update = () => {
      frame.dataset.clamped = String(
        isClipped(leadRef.current) || isClipped(bodyRef.current),
      );
    };
    update();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    if (leadRef.current !== null) observer.observe(leadRef.current);
    if (bodyRef.current !== null) observer.observe(bodyRef.current);
    return () => {
      observer.disconnect();
    };
  }, [frameRef, leadRef, bodyRef, active]);
}

/**
 * The Summary column's view of the final output: the formatted payload in the
 * same monospace block as the Output column, clamped to four lines with an
 * inline "Show more", and a button that opens it in the Output column.
 */
export function FinalOutputPreview({
  output,
  emptyMessage,
  onViewOutput,
}: {
  output: string;
  emptyMessage: string;
  onViewOutput: () => void;
}) {
  const { t } = useTranslation();
  const preview = useMemo(
    () => runOutputPreview(output, RUN_OUTPUT_MAX_VISIBLE_LINES),
    [output],
  );
  // Tracks which output was expanded, so a new run collapses again without an
  // effect.
  const [expandedOutput, setExpandedOutput] = useState<string | null>(null);
  const expanded = expandedOutput === output;

  const frameRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  useClampedFlag(frameRef, leadRef, bodyRef, preview !== null && !expanded);

  return (
    <div ref={frameRef} className="group/final space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t("common.results.finalOutput")}
      </div>
      {preview === null ? (
        <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
      ) : (
        <>
          <div className={cn(RUN_OUTPUT_BLOCK_CLASS, "space-y-2 px-3 py-2.5")}>
            {preview.lead.length > 0 && (
              <p
                ref={leadRef}
                className={cn(
                  "whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]",
                  !expanded && "line-clamp-2",
                )}
              >
                {preview.lead}
              </p>
            )}
            <pre
              ref={bodyRef}
              className={cn(
                RUN_OUTPUT_MONO_CLASS,
                RUN_OUTPUT_WRAPPED_CLASS,
                !expanded && "line-clamp-4",
              )}
            >
              {preview.json ? (
                <HighlightedJson text={preview.body} />
              ) : (
                preview.body
              )}
            </pre>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => {
                setExpandedOutput(expanded ? null : output);
              }}
              className={cn(
                ACTION_BUTTON_CLASS,
                !expanded &&
                  "hidden group-data-[clamped=true]/final:inline-flex",
              )}
            >
              {expanded
                ? t("common.results.showLess")
                : t("common.results.showMore")}
            </button>
            <button
              type="button"
              onClick={onViewOutput}
              className={ACTION_BUTTON_CLASS}
            >
              {t("common.results.viewOutput")}
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
