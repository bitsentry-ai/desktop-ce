import { z } from "zod";

import type {
  RunbookContextV1,
  RunbookImportSummary,
  RunbookRecord,
} from "../../services";
import type { DesktopNativeDialogFilter } from "../../services/desktop-api";

export const RESULTS_KEY = "bitsentry_results";
export const LEGACY_RESULTS_KEY = "bitsentry_investigations";
export const RUNBOOKS_KEY = "bitsentry_runbooks";

export const RUNBOOK_ARTIFACT_FILE_FILTERS: DesktopNativeDialogFilter[] = [
  {
    name: "Runbook Artifacts",
    extensions: ["yaml", "yml", "json"],
  },
  {
    name: "YAML",
    extensions: ["yaml", "yml"],
  },
  {
    name: "JSON",
    extensions: ["json"],
  },
];

type StoredRunResult = {
  id: string;
  executionId?: string;
  incidentThreadId?: string | null;
  runbookId: string;
  runbookTitle: string;
  runbookRevisionNumber?: number;
  runbookContextJson?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  completionReason?:
    | "success"
    | "step_failed"
    | "user_cancelled"
    | "idle_timeout"
    | "app_shutdown"
    | "lease_expired";
};

const storedRunResultSchema = z.object({
  id: z.string(),
  executionId: z.string().optional(),
  incidentThreadId: z.string().nullable().optional(),
  runbookId: z.string(),
  runbookTitle: z.string(),
  runbookRevisionNumber: z.number().optional(),
  runbookContextJson: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  completionReason: z
    .enum([
      "success",
      "step_failed",
      "user_cancelled",
      "idle_timeout",
      "app_shutdown",
      "lease_expired",
    ])
    .optional(),
}) satisfies z.ZodType<StoredRunResult>;

const storedRunResultsSchema = z.array(storedRunResultSchema);

export function getRunbookIdsToExport(
  runbooks: RunbookRecord[],
  targetRunbookId: string | undefined,
): string[] {
  if (targetRunbookId === undefined) {
    return runbooks.map((runbook) => runbook.id);
  }

  const availableIds = new Set(runbooks.map((runbook) => runbook.id));
  if (!availableIds.has(targetRunbookId)) {
    return [];
  }

  return [targetRunbookId];
}

export function getRunbookExportTitle(
  runbooks: RunbookRecord[],
  idsToExport: string[],
): string | undefined {
  if (idsToExport.length !== 1) {
    return undefined;
  }

  return runbooks.find((runbook) => runbook.id === idsToExport[0])?.title;
}

export function replaceRunbookInList(
  runbooks: RunbookRecord[],
  updated: RunbookRecord,
): RunbookRecord[] {
  if (!runbooks.some((runbook) => runbook.id === updated.id)) {
    return [updated, ...runbooks];
  }

  return runbooks.map((runbook) => {
    if (runbook.id === updated.id) {
      return updated;
    }

    return runbook;
  });
}

export function readStoredRunbooks(): RunbookRecord[] {
  try {
    const raw = localStorage.getItem(RUNBOOKS_KEY);
    if (raw === null || raw.length === 0) {
      return [];
    }

    return JSON.parse(raw) as RunbookRecord[];
  } catch {
    return [];
  }
}

export function createRunbooksExportFilename(runbookTitle?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let prefix = toKebabCase(runbookTitle ?? "");
  if (prefix.length === 0) {
    prefix = "runbooks";
  }
  return `${prefix}-${timestamp}.yaml`;
}

export function summarizeImportResult(summary: RunbookImportSummary): string {
  return `${String(summary.imported)} imported, ${String(summary.skipped)} skipped, ${String(summary.failed)} failed`;
}

function toStoredRunStatus(value: string | undefined): StoredRunResult["status"] {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "running"
  ) {
    return value;
  }

  return "running";
}

export function persistRunningRunResult(input: {
  executionId: string;
  resultId: string;
  runbook: Pick<RunbookRecord, "id" | "title">;
  context: RunbookContextV1;
  execution?: {
    status?: string;
    startedAt?: string;
    completedAt?: string;
  };
}): void {
  const rawResults =
    localStorage.getItem(RESULTS_KEY) ??
    localStorage.getItem(LEGACY_RESULTS_KEY);
  let results: StoredRunResult[] = [];
  if (rawResults !== null) {
    results = storedRunResultsSchema.parse(JSON.parse(rawResults));
  }

  // Mirror what the execution actually reports. Assuming "running" turns a
  // deduplicated or already-finished execution into a run that never ends.
  const status = toStoredRunStatus(input.execution?.status);
  const completedAt = input.execution?.completedAt;
  const nextResult: StoredRunResult = {
    id: input.resultId,
    runbookId: input.runbook.id,
    runbookTitle: input.runbook.title,
    runbookRevisionNumber: input.context.runbook.revisionNumber,
    runbookContextJson: JSON.stringify(input.context),
    executionId: input.executionId,
    status,
    startedAt: input.execution?.startedAt ?? new Date().toISOString(),
    completedAt,
  };

  const existingIndex = results.findIndex((item) => item.id === input.resultId);
  if (existingIndex >= 0) {
    results[existingIndex] = {
      ...results[existingIndex],
      ...nextResult,
      // Spreading keeps a stale completedAt when the new run has none, which
      // is how finished timestamps leaked onto fresh runs.
      completedAt,
    };
  } else {
    results.unshift(nextResult);
  }

  localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
  window.dispatchEvent(new CustomEvent("bitsentry:results-updated"));
}

function toKebabCase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  return normalized.slice(start, end);
}
