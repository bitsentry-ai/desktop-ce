import { useMemo } from "react";
import { readableKey } from "./recordTable";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import { HighlightedJson } from "./HighlightedJson";
import { RUN_OUTPUT_MAX_VISIBLE_LINES } from "./RunOutputBlock";
import {
  jsonSummary,
  runOutputPreview,
  type JsonSummary,
  type RunOutputPreview,
} from "./runOutputFormat";
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

/** Lines of a longer plain-text output shown in the Summary (about 200px). */
export const FINAL_OUTPUT_PREVIEW_LINES = 10;
/** Top-level fields of a longer JSON object shown in the Summary. */
export const FINAL_OUTPUT_SUMMARY_FIELDS = 8;

/**
 * The first lines of a longer plain-text output. Runs of alignment spaces collapse to one, so a label stays next to its
 * value ("Pages free: 76905.") in the narrow Summary, and every line wraps so values read in full. When the output has
 * more lines than the preview shows, the last row fades out above "View full output". The Output column keeps the
 * exact spacing.
 */
function PlainTextPreviewLines({ text }: { text: string }) {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, FINAL_OUTPUT_PREVIEW_LINES).map((line) => line.replace(/ {2,}/g, " ").trimEnd());
  return (
    <pre
      className={cn(
        RUN_OUTPUT_MONO_CLASS,
        "max-h-60 min-w-0 max-w-full overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere]",
        allLines.length > FINAL_OUTPUT_PREVIEW_LINES && "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
      )}
    >
      {lines.map((line, index) => (
        <span key={`${String(index)}:${line}`} className="block">
          {line.length > 0 ? line : " "}
        </span>
      ))}
    </pre>
  );
}

/** "findingIds" or "open_findings" as words ("finding ids", "open findings") for the outcome line. */
function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Key/value rows for a JSON summary, in the run output monospace. */
/** A lower-case snake_case token such as `vendor_fix_pending`: a state name, which reads better as words. */
const ENUM_VALUE = /^[a-z]+(?:_[a-z]+)+$/;

function fieldValueText(value: string): string {
  if (value.length === 0) return "\u00a0";
  return ENUM_VALUE.test(value) ? readableKey(value) : value;
}

export function FieldRows({ fields }: { fields: JsonSummary["fields"] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px] leading-5">
      {fields.map((field) => (
        <div key={field.key} className="contents">
          <dt className="max-w-[11rem] truncate text-muted-foreground" title={field.key}>
            {readableKey(field.key)}
          </dt>
          <dd
            className={cn(
              "m-0 line-clamp-2 break-words text-foreground [overflow-wrap:anywhere]",
              !ENUM_VALUE.test(field.value) && "font-mono",
            )}
            title={field.value}
          >
            {fieldValueText(field.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OutcomeHeadline({ headline }: { headline: NonNullable<JsonSummary["headline"]> }) {
  const { t } = useTranslation();
  const noun = humanizeKey(headline.noun);
  const text =
    headline.total === null
      ? t("common.results.outcomeReturned", { shown: headline.shown, noun })
      : t("common.results.outcomeReturnedOf", { shown: headline.shown, total: headline.total, noun });
  return <p className="text-sm font-semibold leading-5 text-foreground">{text}</p>;
}

/**
 * A longer JSON object, read at a glance: an outcome line when it holds a list ("10 of 103 findings returned"), then
 * its readable top-level fields, one per row; paging and transport fields (offset, hasMore, cursors) sit under a
 * collapsed Details.
 */
function JsonSummaryFields({ summary, hasLead }: { summary: JsonSummary; hasLead: boolean }) {
  const { t } = useTranslation();
  const hidden = summary.total - summary.fields.length;
  return (
    <div className="space-y-2">
      {/* A sentence before the payload already states the outcome; the computed line is only for bare JSON. */}
      {summary.headline !== null && !hasLead && <OutcomeHeadline headline={summary.headline} />}
      {summary.fields.length > 0 && <FieldRows fields={summary.fields} />}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("common.results.moreFields", { count: hidden })}
        </p>
      )}
      {summary.details.length > 0 && (
        <details className="group text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium hover:text-foreground">
            {t("common.results.resultDetails", { count: summary.details.length })}
          </summary>
          <div className="pt-1.5">
            <FieldRows fields={summary.details} />
          </div>
        </details>
      )}
    </div>
  );
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
 * as the Output column. A short output shows whole; a longer one shows its
 * top-level fields (a JSON object) or its first ten lines, with a "View full
 * output" button that opens it in the Output column, so the Summary never
 * repeats the full payload.
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
  const summary = useMemo(
    () => (short ? null : jsonSummary(output, FINAL_OUTPUT_SUMMARY_FIELDS)),
    [output, short],
  );

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
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
            {summary !== null && <JsonSummaryFields summary={summary} hasLead={preview.lead.length > 0} />}
            {summary === null && !short && !preview.json && (
              <PlainTextPreviewLines text={preview.body} />
            )}
            {summary === null && (short || preview.json) && (
              <pre
                className={cn(
                  RUN_OUTPUT_MONO_CLASS,
                  RUN_OUTPUT_WRAPPED_CLASS,
                  !short && "line-clamp-[10]",
                )}
              >
                {preview.json ? (
                  <HighlightedJson text={preview.body} />
                ) : (
                  preview.body
                )}
              </pre>
            )}
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
