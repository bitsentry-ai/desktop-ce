import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import { HighlightedJson } from "./HighlightedJson";
import { RUN_OUTPUT_MAX_VISIBLE_LINES } from "./RunOutputBlock";
import { runOutputPreview, type RunOutputPreview } from "./runOutputFormat";
import {
  RUN_OUTPUT_BLOCK_CLASS,
  RUN_OUTPUT_MONO_CLASS,
  RUN_OUTPUT_WRAPPED_CLASS,
} from "./runOutputStyles";

/** Outputs up to this many lines show whole in the Summary. */
export const FINAL_OUTPUT_SHORT_MAX_LINES = 6;
// A few very long lines wrap into many in the narrow Summary column, so a
// "short" output must also be short in characters.
const FINAL_OUTPUT_SHORT_MAX_CHARS = 480;

const VIEW_FULL_OUTPUT_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-11";

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    count += 1;
  }
  return count;
}

/** True when the whole preview fits in a few lines, so it needs no "View full output". */
export function isShortFinalOutput(preview: RunOutputPreview): boolean {
  return (
    lineCount(preview.lead) + lineCount(preview.body) <=
      FINAL_OUTPUT_SHORT_MAX_LINES &&
    preview.lead.length + preview.body.length <= FINAL_OUTPUT_SHORT_MAX_CHARS
  );
}

/**
 * The Summary column's view of the final output, in the same monospace block
 * as the Output column. A short output shows whole; a longer one shows a
 * four-line preview and a "View full output" button that opens it in the
 * Output column, so the Summary never repeats the full payload.
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
  const short = preview !== null && isShortFinalOutput(preview);

  return (
    <div className="space-y-2">
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
                className={cn(
                  "whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]",
                  !short && "line-clamp-2",
                )}
              >
                {preview.lead}
              </p>
            )}
            <pre
              className={cn(
                RUN_OUTPUT_MONO_CLASS,
                RUN_OUTPUT_WRAPPED_CLASS,
                !short && "line-clamp-4",
              )}
            >
              {preview.json ? (
                <HighlightedJson text={preview.body} />
              ) : (
                preview.body
              )}
            </pre>
          </div>
          {!short && (
            <button
              type="button"
              onClick={onViewOutput}
              className={VIEW_FULL_OUTPUT_BUTTON_CLASS}
            >
              {t("common.results.viewFullOutput")}
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
