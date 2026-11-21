import type { ReactNode } from "react";

import type { JsonBlockRenderer } from "../markdown";
import { StructuredValue } from "../runbook/StructuredValue";
import { findRecordTable, readableKey } from "../runbook/recordTable";
import { RecordTableView } from "../runbook/RecordTableView";
import { detectRunOutputFormat } from "../runbook/runOutputFormat";

const SUMMARY_FIELDS = 4;

/** Fields that state an evaluation's conclusion, in the order a verdict is looked for. */
const VERDICT_KEYS = ["verdict", "outcome", "decision", "eligibility"] as const;
const REASON_KEY = "reason";
const MACHINE_WORD = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function readableWord(value: string): string {
  return MACHINE_WORD.test(value) ? readableKey(value) : value;
}

interface Verdict {
  headline: string;
  reason: string | null;
  rest: Record<string, unknown>;
}

/** An object's conclusion ("Blocked") and its reason, lifted out so the card leads with them; null when it has none. */
function verdictOf(value: unknown): Verdict | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = VERDICT_KEYS.find((candidate) => {
    const field = record[candidate];
    return typeof field === "string" && field.length > 0 && field.length <= 40;
  });
  if (key === undefined) return null;
  const reasonValue = record[REASON_KEY];
  const reason = typeof reasonValue === "string" && reasonValue.length > 0 ? readableWord(reasonValue) : null;
  const rest = Object.fromEntries(
    Object.entries(record).filter(([field]) => field !== key && (reason === null || field !== REASON_KEY)),
  );
  return { headline: readableWord(record[key] as string), reason, rest };
}

/**
 * A JSON block in a chat reply, shown as evidence a person can read, never as raw JSON: a list of records as a table,
 * a single record (alone or in a one-item list) as labelled rows with the first fields shown and the rest one click
 * away, led by its verdict and reason when it states one ("Blocked · Vendor fix pending"), anything else as readable
 * values. Text that does not parse as JSON stays a code block.
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
  const verdict = verdictOf(value);
  return (
    <div className="my-3 min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      {verdict !== null && (
        <p className="mb-2 text-[15px] font-semibold leading-6 text-foreground">
          {verdict.headline}
          {verdict.reason !== null && <span className="font-normal text-muted-foreground">{` · ${verdict.reason}`}</span>}
        </p>
      )}
      <StructuredValue value={verdict === null ? value : verdict.rest} limit={SUMMARY_FIELDS} />
    </div>
  );
}

/** A {@link JsonBlockRenderer} for chat replies; module-level so markdown memoization keeps working. */
export const renderJsonEvidence: JsonBlockRenderer = (code, rawBlock) => <JsonEvidenceBlock code={code} rawBlock={rawBlock} />;
