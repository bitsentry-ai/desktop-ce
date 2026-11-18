import type { ReactNode } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";

import type { JsonBlockRenderer } from "../markdown";
import { FieldRows } from "../runbook/FinalOutputPreview";
import { RunOutputBlock } from "../runbook/RunOutputBlock";
import { findRecordTable } from "../runbook/recordTable";
import { detectRunOutputFormat, jsonSummary } from "../runbook/runOutputFormat";

const SUMMARY_FIELDS = 6;

/**
 * A JSON block in a chat reply, shown as evidence a reader can scan instead of a raw dump: a list of records opens as
 * a table (with a JSON view), an object as its first fields; the raw JSON stays one click away.
 */
function JsonEvidenceBlock({
  code,
  rawBlock,
  label,
}: {
  code: string;
  rawBlock: ReactNode;
  label: string;
}) {
  const { t } = useTranslation();
  const format = detectRunOutputFormat(code);
  if (format.kind !== "json") return rawBlock;

  if (findRecordTable(format.value) !== null) {
    return (
      <div className="my-3 min-w-0">
        <RunOutputBlock value={code} emptyMessage="" />
      </div>
    );
  }

  const summary = jsonSummary(code, SUMMARY_FIELDS);
  if (summary === null || summary.fields.length === 0) {
    return (
      <details className="my-3 min-w-0">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          {label}
        </summary>
        {rawBlock}
      </details>
    );
  }

  const hidden = summary.total - summary.fields.length;
  return (
    <div className="my-3 min-w-0 space-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <FieldRows fields={summary.fields} />
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("common.results.moreFields", { count: hidden })}
        </p>
      )}
      <details className="min-w-0">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          {label}
        </summary>
        {rawBlock}
      </details>
    </div>
  );
}

/** A {@link JsonBlockRenderer} for chat replies; module-level so markdown memoization keeps working. */
export const renderJsonEvidence: JsonBlockRenderer = (code, rawBlock, label) => (
  <JsonEvidenceBlock code={code} rawBlock={rawBlock} label={label} />
);
