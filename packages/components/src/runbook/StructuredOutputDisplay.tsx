import { useTranslation } from "@bitsentry-ce/i18n";
import type { ReactNode } from "react";

const COMPACT_VALUE_MAX_LENGTH = 40;

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || typeof value !== "object") {
    return String(value);
  }

  let compact: string;
  try {
    compact = JSON.stringify(value);
  } catch {
    return String(value);
  }

  if (compact.length <= COMPACT_VALUE_MAX_LENGTH) {
    return compact;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return compact;
  }
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
                <td className="whitespace-pre-wrap px-3 py-2 align-top font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
                  {formatStructuredValue(value)}
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
