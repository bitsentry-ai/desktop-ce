import { useTranslation } from "@bitsentry-ce/i18n";
import type { ReactNode } from "react";

import { formatStructuredValue } from "../lib/jsonDisplay";

// Past this many lines a value stops being a glanceable cell and starts pushing
// the rest of the table off screen, so it scrolls within a fixed height instead.
const SCROLLABLE_VALUE_LINE_THRESHOLD = 12;

function StructuredValueCell({ value }: { value: unknown }) {
  const formatted = formatStructuredValue(value);

  if (formatted.split("\n").length <= SCROLLABLE_VALUE_LINE_THRESHOLD) {
    return <span className="whitespace-pre-wrap">{formatted}</span>;
  }

  return (
    <div className="max-h-64 overflow-y-auto whitespace-pre-wrap">
      {formatted}
    </div>
  );
}

function getLogFilterMetadata(metadata: Record<string, unknown> | undefined): {
  matchCount: number;
  groupNames: string[];
  error?: string;
} | null {
  const raw = metadata?.logFilter;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  let matchCount: number | undefined;
  if ("matchCount" in raw && typeof raw.matchCount === "number") {
    matchCount = raw.matchCount;
  }

  let groupNames: string[] = [];
  if ("groupNames" in raw && Array.isArray(raw.groupNames)) {
    groupNames = raw.groupNames.filter(
      (item): item is string => typeof item === "string",
    );
  }

  let error: string | undefined;
  if ("error" in raw && typeof raw.error === "string") {
    error = raw.error;
  }

  if (matchCount === undefined && groupNames.length === 0 && error === undefined) {
    return null;
  }

  const parsedMetadata: {
    matchCount: number;
    groupNames: string[];
    error?: string;
  } = {
    matchCount: matchCount ?? 0,
    groupNames,
  };
  if (error !== undefined) {
    parsedMetadata.error = error;
  }

  return parsedMetadata;
}

export function StructuredOutputDisplay({
  metadata,
  structuredOutput,
}: {
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const structuredEntries = Object.entries(structuredOutput ?? {});
  const logFilterMetadata = getLogFilterMetadata(metadata);
  const showStructuredOutput =
    structuredEntries.length > 0 || logFilterMetadata !== null;

  if (!showStructuredOutput) {
    return null;
  }

  let logFilterContent: ReactNode = null;
  if (logFilterMetadata !== null) {
    let matchUnit = "matches";
    if (logFilterMetadata.matchCount === 1) {
      matchUnit = "match";
    }

    let groupsContent: ReactNode = null;
    if (logFilterMetadata.groupNames.length > 0) {
      groupsContent = (
        <>
          <span className="text-muted-foreground/30">•</span>
          <span>{logFilterMetadata.groupNames.join(", ")}</span>
        </>
      );
    }

    logFilterContent = (
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/60">
        <span>
          {logFilterMetadata.matchCount} {matchUnit}
        </span>
        {groupsContent}
      </div>
    );
  }

  let valuesContent: ReactNode;
  if (logFilterMetadata?.error !== undefined) {
    valuesContent = (
      <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
        {logFilterMetadata.error}
      </div>
    );
  } else if (structuredEntries.length === 0) {
    valuesContent = (
      <p className="text-xs italic text-muted-foreground/50">
        {t("common.structuredOutputDisplay.noValuesExtracted")}
      </p>
    );
  } else {
    valuesContent = (
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full table-fixed divide-y divide-border text-xs">
          <tbody className="divide-y divide-border">
            {structuredEntries.map(([key, value]) => (
              <tr key={key}>
                <td className="w-40 break-words bg-muted/20 px-3 py-2 align-top font-mono text-[11px] text-muted-foreground">
                  {key}
                </td>
                <td className="px-3 py-2 align-top font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
                  <StructuredValueCell value={value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
        {t("common.structuredOutputDisplay.structuredOutput")}
      </div>
      {logFilterContent}
      {valuesContent}
    </div>
  );
}
