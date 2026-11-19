import type { ReactNode } from "react";

import type { JsonBlockRenderer } from "../markdown";
import { StructuredValue } from "../runbook/StructuredValue";
import { findRecordTable } from "../runbook/recordTable";
import { RecordTableView } from "../runbook/RecordTableView";
import { detectRunOutputFormat } from "../runbook/runOutputFormat";

const SUMMARY_FIELDS = 6;

/**
 * A JSON block in a chat reply, shown as evidence a person can read, never as raw JSON: a list of records as a table,
 * a single record (alone or in a one-item list) as labelled rows with the first fields shown and the rest one click
 * away, anything else as readable values. Text that does not parse as JSON stays a code block.
 */
function JsonEvidenceBlock({ code, rawBlock }: { code: string; rawBlock: ReactNode }) {
  const format = detectRunOutputFormat(code);
  if (format.kind !== "json") return rawBlock;

  const table = findRecordTable(format.value);
  if (table !== null) {
    return (
      <div className="my-3 min-w-0">
        <RecordTableView table={table} />
      </div>
    );
  }

  const value =
    Array.isArray(format.value) && format.value.length === 1 && typeof format.value[0] === "object" && format.value[0] !== null
      ? (format.value[0] as unknown)
      : format.value;
  return (
    <div className="my-3 min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <StructuredValue value={value} limit={SUMMARY_FIELDS} />
    </div>
  );
}

/** A {@link JsonBlockRenderer} for chat replies; module-level so markdown memoization keeps working. */
export const renderJsonEvidence: JsonBlockRenderer = (code, rawBlock) => <JsonEvidenceBlock code={code} rawBlock={rawBlock} />;
