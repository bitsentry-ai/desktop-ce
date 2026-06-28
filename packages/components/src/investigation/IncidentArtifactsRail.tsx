import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Bot,
  Database,
  FileText,
  Globe,
  Loader2,
  Puzzle,
  ScanSearch,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";

import { MarkdownContent } from "../markdown";
import { cn } from "../lib/utils";
import { stripInternalHostBlocks } from "../lib/hostProtocol";
import type {
  RunbookActionType,
  RunbookExecutionRecord,
  RunbookExecutionStatus,
  RunbookExecutionStepRecord,
} from "../services/contracts";
import { useBitsentryServices } from "../services/context";
import { useTranslation } from "@bitsentry-ce/i18n";

export interface IncidentArtifactsToolCall {
  toolCallId: string;
  toolName: string;
  state: "running" | "done" | "failed";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface IncidentArtifactsMessage {
  kind: "user" | "agent";
  toolCalls?: IncidentArtifactsToolCall[];
}

interface IncidentArtifactReference {
  key: string;
  resultId: string | null;
  executionId: string | null;
  toolCallId: string;
  runbookId?: string;
  runbookTitle?: string;
  toolState: "running" | "done" | "failed";
  snapshot?: RunbookExecutionRecord | null;
  order: number;
}

interface IncidentArtifactEntry {
  key: string;
  order: number;
  resultId: string | null;
  executionId: string | null;
  runbookId?: string;
  runbookTitle: string;
  status: RunbookExecutionStatus | "starting";
  toolState: "running" | "done" | "failed";
  startedAt?: string;
  completedAt?: string;
  execution: RunbookExecutionRecord | null;
  latestStep: RunbookExecutionStepRecord | null;
  completedStepCount: number;
  stepCount: number;
  hasStoredSummary: boolean;
}

interface LastKnownArtifactContext {
  resultId?: string | null;
  executionId?: string | null;
  runbookId?: string;
  runbookTitle?: string;
}

interface StoredRunResult {
  id: string;
  executionId?: string;
  incidentThreadId?: string;
  runbookId: string;
  runbookTitle: string;
  status: RunbookExecutionStatus;
  startedAt: string;
  completedAt?: string;
}

interface StoredResultTraceMemory {
  execution: RunbookExecutionRecord | null;
}

type TranslationFn = ReturnType<typeof useTranslation>["t"];

const RESULTS_KEY = "bitsentry_results";
const LEGACY_RESULTS_KEY = "bitsentry_investigations";
const RESULT_TRACES_KEY = "bitsentry_result_traces";
const LEGACY_RESULT_TRACES_KEY = "bitsentry_investigation_traces";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function getUuid(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = getString(record, key);
  if (isUuid(value)) return value;
  return undefined;
}

function safeParseJson(input?: string): unknown {
  if (input === undefined || input.length === 0) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (typeof value !== "string") return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

function isExecutionStatus(value: unknown): value is RunbookExecutionStatus {
  return (
    value === "queued" ||
    value === "pending" ||
    value === "running" ||
    value === "claim_expired" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isRunbookExecutionRecord(
  value: unknown,
): value is RunbookExecutionRecord {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.executionId === "string" &&
    typeof record.runbookId === "string" &&
    typeof record.runbookTitle === "string" &&
    isExecutionStatus(record.status) &&
    typeof record.startedAt === "string" &&
    Array.isArray(record.steps)
  );
}

function actionIcon(type: RunbookActionType) {
  switch (type) {
    case "shell":
      return Terminal;
    case "llm":
      return Bot;
    case "http":
      return Globe;
    case "plugin":
      return Puzzle;
    case "external_source":
      return AlertCircle;
    case "telemetry_existing_entry":
      return BookOpen;
    case "data_source_query":
      return Database;
    case "telemetry_ingest":
      return Loader2;
    case "diagnosis_diagnose":
      return ScanSearch;
    case "diagnosis_verify":
      return ShieldCheck;
    case "diagnosis_recommend":
      return FileText;
    default:
      return AlertCircle;
  }
}

function actionTypeLabel(t: TranslationFn, type: RunbookActionType): string {
  switch (type) {
    case "shell":
      return t("common.incidentArtifactsRail.actionType.shell");
    case "llm":
      return t("common.incidentArtifactsRail.actionType.llm");
    case "http":
      return t("common.incidentArtifactsRail.actionType.http");
    case "plugin":
      return t("common.incidentArtifactsRail.actionType.plugin");
    case "external_source":
      return t("common.incidentArtifactsRail.actionType.external_source");
    case "telemetry_existing_entry":
      return t(
        "common.incidentArtifactsRail.actionType.telemetry_existing_entry",
      );
    case "data_source_query":
      return t("common.incidentArtifactsRail.actionType.data_source_query");
    case "telemetry_ingest":
      return t("common.incidentArtifactsRail.actionType.telemetry_ingest");
    case "diagnosis_diagnose":
      return t("common.incidentArtifactsRail.actionType.diagnosis_diagnose");
    case "diagnosis_verify":
      return t("common.incidentArtifactsRail.actionType.diagnosis_verify");
    case "diagnosis_recommend":
      return t("common.incidentArtifactsRail.actionType.diagnosis_recommend");
  }
}

function stepStatusLabel(
  t: TranslationFn,
  status: RunbookExecutionStepRecord["status"],
): string {
  switch (status) {
    case "pending":
      return t("common.incidentArtifactsRail.stepStatus.pending");
    case "running":
      return t("common.incidentArtifactsRail.stepStatus.running");
    case "completed":
      return t("common.incidentArtifactsRail.stepStatus.completed");
    case "failed":
      return t("common.incidentArtifactsRail.stepStatus.failed");
    case "cancelled":
      return t("common.incidentArtifactsRail.stepStatus.cancelled");
  }
}

function statusClasses(status: IncidentArtifactEntry["status"]): string {
  switch (status) {
    case "starting":
      return "bg-sky-500/15 text-sky-500";
    case "queued":
      return "bg-sky-500/15 text-sky-500";
    case "pending":
      return "bg-sky-500/15 text-sky-500";
    case "running":
      return "bg-amber-500/15 text-amber-500";
    case "claim_expired":
      return "bg-rose-500/15 text-rose-500";
    case "completed":
      return "bg-emerald-500/15 text-emerald-500";
    case "failed":
      return "bg-destructive/15 text-destructive";
    case "cancelled":
      return "bg-muted text-muted-foreground";
  }
}

function statusLabel(
  t: TranslationFn,
  status: IncidentArtifactEntry["status"],
): string {
  switch (status) {
    case "starting":
      return t("common.incidentArtifactsRail.status.starting");
    case "queued":
      return t("common.incidentArtifactsRail.status.queued");
    case "pending":
      return t("common.incidentArtifactsRail.status.pending");
    case "running":
      return t("common.incidentArtifactsRail.status.running");
    case "claim_expired":
      return t("common.incidentArtifactsRail.status.claimExpired");
    case "completed":
      return t("common.incidentArtifactsRail.status.completed");
    case "failed":
      return t("common.incidentArtifactsRail.status.failed");
    case "cancelled":
      return t("common.incidentArtifactsRail.status.cancelled");
  }
}

function finalOutput(execution: RunbookExecutionRecord | null): string {
  if (execution === null) return "";
  const completed = [...execution.steps]
    .reverse()
    .find(
      (step) => step.status === "completed" && step.output !== undefined,
    );
  return completed?.output ?? "";
}

function looksLikeMarkdown(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return false;
  if (text.startsWith("{") || text.startsWith("[")) return false;

  return (
    /^#{1,6}\s/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /^\s*>\s/m.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    text.includes("```")
  );
}

function OutputContent({
  value,
  emptyMessage,
}: {
  value: string;
  emptyMessage: string;
}) {
  const text = stripInternalHostBlocks(value);

  if (!text) {
    return (
      <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
    );
  }

  if (looksLikeMarkdown(text)) {
    return (
      <div className="min-w-0 max-w-full overflow-x-hidden rounded-xl border border-border bg-muted/15 p-3">
        <MarkdownContent content={text} />
      </div>
    );
  }

  return (
    <pre className="min-w-0 max-w-full overflow-x-hidden rounded-xl border border-border bg-muted/15 p-3 text-xs whitespace-pre-wrap break-all text-foreground">
      {text}
    </pre>
  );
}

function formatJsonBlock(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function normalizeStoredRunResult(value: unknown): StoredRunResult | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (
    typeof record.runbookId !== "string" ||
    record.runbookId.length === 0
  ) {
    return null;
  }
  if (
    typeof record.runbookTitle !== "string" ||
    record.runbookTitle.length === 0
  ) {
    return null;
  }
  if (!isExecutionStatus(record.status)) return null;
  if (typeof record.startedAt !== "string" || record.startedAt.length === 0) {
    return null;
  }

  const result: StoredRunResult = {
    id: record.id,
    runbookId: record.runbookId,
    runbookTitle: record.runbookTitle,
    status: record.status,
    startedAt: record.startedAt,
  };

  if (typeof record.executionId === "string" && record.executionId.length > 0) {
    result.executionId = record.executionId;
  }
  if (
    typeof record.incidentThreadId === "string" &&
    record.incidentThreadId.length > 0
  ) {
    result.incidentThreadId = record.incidentThreadId;
  }
  if (typeof record.completedAt === "string" && record.completedAt.length > 0) {
    result.completedAt = record.completedAt;
  }

  return result;
}

function loadStoredResults(): StoredRunResult[] {
  if (typeof window === "undefined") return [];

  try {
    const raw =
      window.localStorage.getItem(RESULTS_KEY) ??
      window.localStorage.getItem(LEGACY_RESULTS_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeStoredRunResult(entry))
      .filter((entry): entry is StoredRunResult => entry !== null);
  } catch {
    return [];
  }
}

function filterStoredResultsForIncident(
  storedResults: StoredRunResult[],
  incidentId?: string | null,
): StoredRunResult[] {
  if (incidentId === undefined || incidentId === null || incidentId.length === 0) {
    return storedResults;
  }

  return storedResults.filter(
    (result) => result.incidentThreadId === incidentId,
  );
}

function normalizedRunbookTitle(title?: string | null): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function runbookIdentityKey(input: {
  runbookId?: string | null;
  runbookTitle?: string | null;
  executionId?: string | null;
  resultId?: string | null;
  key?: string;
}): string {
  if (input.executionId !== undefined && input.executionId !== null) {
    return `execution:${input.executionId}`;
  }

  if (input.key !== undefined && input.key.startsWith("tool:")) {
    return input.key;
  }

  if (input.runbookId !== undefined && input.runbookId !== null) {
    return `runbook:${input.runbookId}`;
  }

  const normalizedTitle = normalizedRunbookTitle(input.runbookTitle);
  if (normalizedTitle !== null) {
    return `runbook-title:${normalizedTitle}`;
  }

  if (input.resultId !== undefined && input.resultId !== null) {
    return `result:${input.resultId}`;
  }

  return input.key ?? "artifact:unknown";
}

function timestampScore(value?: string): number {
  if (value === undefined || value.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  return Number.NEGATIVE_INFINITY;
}

function artifactStatusPriority(
  status: IncidentArtifactEntry["status"],
): number {
  switch (status) {
    case "running":
      return 5;
    case "queued":
      return 4;
    case "pending":
      return 4;
    case "starting":
      return 3;
    case "failed":
      return 2;
    case "claim_expired":
      return 2;
    case "cancelled":
      return 1;
    case "completed":
      return 0;
  }
}

function runbookIdentityMatches(
  reference: Pick<IncidentArtifactReference, "runbookId" | "runbookTitle">,
  result: Pick<StoredRunResult, "runbookId" | "runbookTitle">,
): boolean {
  if (reference.runbookId !== undefined && result.runbookId.length > 0) {
    return reference.runbookId === result.runbookId;
  }

  const referenceTitle = normalizedRunbookTitle(reference.runbookTitle);
  if (referenceTitle === null) return false;
  return referenceTitle === normalizedRunbookTitle(result.runbookTitle);
}

function preferArtifact(
  current: IncidentArtifactEntry,
  candidate: IncidentArtifactEntry,
): IncidentArtifactEntry {
  const currentStartedAt = timestampScore(current.startedAt);
  const candidateStartedAt = timestampScore(candidate.startedAt);
  if (candidateStartedAt !== currentStartedAt) {
    if (candidateStartedAt > currentStartedAt) return candidate;
    return current;
  }

  const currentStatus = artifactStatusPriority(current.status);
  const candidateStatus = artifactStatusPriority(candidate.status);
  if (candidateStatus !== currentStatus) {
    if (candidateStatus > currentStatus) return candidate;
    return current;
  }

  const currentCompletedAt = timestampScore(current.completedAt);
  const candidateCompletedAt = timestampScore(candidate.completedAt);
  if (candidateCompletedAt !== currentCompletedAt) {
    if (candidateCompletedAt > currentCompletedAt) return candidate;
    return current;
  }

  if (candidate.order !== current.order) {
    if (candidate.order > current.order) return candidate;
    return current;
  }

  if (candidate.execution !== null && current.execution === null) {
    return candidate;
  }

  if (candidate.execution === null && current.execution !== null) {
    return current;
  }

  return candidate;
}

function collapseArtifactsByRunbook(
  artifacts: IncidentArtifactEntry[],
): IncidentArtifactEntry[] {
  const collapsed = new Map<string, IncidentArtifactEntry>();

  for (const artifact of artifacts) {
    const identityKey = runbookIdentityKey(artifact);
    const previous = collapsed.get(identityKey);
    if (previous === undefined) {
      collapsed.set(identityKey, artifact);
    } else {
      collapsed.set(identityKey, preferArtifact(previous, artifact));
    }
  }

  return [...collapsed.values()].sort((left, right) => {
    const startedDifference =
      timestampScore(right.startedAt) - timestampScore(left.startedAt);
    if (startedDifference !== 0) {
      return startedDifference;
    }

    return right.order - left.order;
  });
}

function loadStoredResultTraces(): Record<string, StoredResultTraceMemory> {
  if (typeof window === "undefined") return {};

  try {
    const raw =
      window.localStorage.getItem(RESULT_TRACES_KEY) ??
      window.localStorage.getItem(LEGACY_RESULT_TRACES_KEY);
    if (raw === null || raw.length === 0) return {};
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null) return {};

    const traces: Record<string, StoredResultTraceMemory> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const trace = asRecord(value);
      if (trace === null) continue;
      const execution = trace.execution;
      let storedExecution: RunbookExecutionRecord | null = null;
      if (isRunbookExecutionRecord(execution)) {
        storedExecution = execution;
      }
      traces[key] = {
        execution: storedExecution,
      };
    }
    return traces;
  } catch {
    return {};
  }
}

function getLatestStep(
  execution: RunbookExecutionRecord | null,
): RunbookExecutionStepRecord | null {
  if (execution === null || execution.steps.length === 0) return null;
  return (
    execution.steps.find((step) => step.status === "running") ??
    [...execution.steps]
      .reverse()
      .find(
        (step) =>
          step.status === "failed" ||
          step.status === "cancelled" ||
          step.status === "completed",
      ) ??
    execution.steps[0]
  );
}

function stepSelectionKey(step: RunbookExecutionStepRecord): string {
  const actionId = step.actionId ?? step.type;
  return `${String(step.order)}:${actionId}:${step.title}`;
}

function getProviderDisplayName(providerKey: unknown): string | null {
  switch (providerKey) {
    case "claude_code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    case "kilocode":
      return "KiloCode";
    default:
      return null;
  }
}

function getStepProviderSummary(step: RunbookExecutionStepRecord): string | null {
  const providerKey =
    getString(asRecord(step.metadata), "providerKey") ??
    getString(asRecord(step.input), "llmProviderKey");
  const providerName = getProviderDisplayName(providerKey);
  const model =
    getString(asRecord(step.input), "llmModel") ??
    getString(asRecord(step.input), "llmModelTemplate");

  if (providerName !== null && model !== undefined) {
    return `${providerName} • ${model}`;
  }

  return providerName ?? model ?? null;
}

function getStepVisibleOutput(step: RunbookExecutionStepRecord | null): string {
  return step?.output ?? step?.error ?? "";
}

function findStoredResult(
  reference: Pick<
    IncidentArtifactReference,
    "key" | "resultId" | "executionId" | "runbookId" | "runbookTitle"
  >,
  storedResults: StoredRunResult[],
): StoredRunResult | null {
  if (reference.resultId) {
    return storedResults.find((result) => result.id === reference.resultId) ?? null;
  }

  if (reference.executionId) {
    return (
      storedResults.find((result) => result.executionId === reference.executionId) ??
      null
    );
  }

  if (reference.key?.startsWith("tool:")) {
    return null;
  }

  const matches = storedResults.filter((result) =>
    runbookIdentityMatches(reference, result),
  );
  if (matches.length !== 1) return null;
  return matches[0];
}

function artifactSummaryText(
  t: TranslationFn,
  artifact: IncidentArtifactEntry,
): string {
  if (artifact.stepCount > 0) {
    return t("common.incidentArtifactsRail.stepsComplete", {
      completed: artifact.completedStepCount,
      total: artifact.stepCount,
    });
  }

  if (artifact.hasStoredSummary) {
    switch (artifact.status) {
      case "completed":
        return t("common.incidentArtifactsRail.summary.completed");
      case "failed":
        return t("common.incidentArtifactsRail.summary.failed");
      case "claim_expired":
        return t("common.incidentArtifactsRail.summary.claimExpired");
      case "cancelled":
        return t("common.incidentArtifactsRail.summary.cancelled");
      case "running":
        return t("common.incidentArtifactsRail.summary.running");
      case "queued":
      case "pending":
      case "starting":
        return t("common.incidentArtifactsRail.summary.queued");
    }
  }

  if (artifact.executionId) {
    return t("common.incidentArtifactsRail.waitingForSteps");
  }

  return t("common.incidentArtifactsRail.waitingToStart");
}

function artifactEmptyStateCopy(
  t: TranslationFn,
  artifact: IncidentArtifactEntry,
): string {
  if (artifact.execution) {
    return "";
  }

  if (artifact.hasStoredSummary) {
    switch (artifact.status) {
      case "completed":
        return t("common.incidentArtifactsRail.emptyState.completed");
      case "failed":
        return t("common.incidentArtifactsRail.emptyState.failed");
      case "claim_expired":
        return t("common.incidentArtifactsRail.emptyState.claimExpired");
      case "cancelled":
        return t("common.incidentArtifactsRail.emptyState.cancelled");
      case "running":
        return t("common.incidentArtifactsRail.emptyState.running");
      case "queued":
      case "pending":
      case "starting":
        return t("common.incidentArtifactsRail.emptyState.queued");
    }
  }

  return t("common.incidentArtifactsRail.noSnapshotYet");
}

function collectArtifactReferences(
  messages: IncidentArtifactsMessage[],
): IncidentArtifactReference[] {
  const refs = new Map<string, IncidentArtifactReference>();
  let order = 0;
  let lastKnownContext: LastKnownArtifactContext | null = null;

  for (const message of messages) {
    if (message.kind !== "agent") continue;

    for (const toolCall of message.toolCalls ?? []) {
      if (
        toolCall.toolName !== "execute_runbook" &&
        toolCall.toolName !== "continue_diagnosis_runbook" &&
        toolCall.toolName !== "get_runbook_execution"
      ) {
        continue;
      }

      const inputRecord = asRecord(toolCall.input);
      const outputRecord = asRecord(safeParseJson(toolCall.output));
      let snapshot: RunbookExecutionRecord | null = null;
      if (isRunbookExecutionRecord(outputRecord)) {
        snapshot = outputRecord;
      }
      const derivedResultId =
        getUuid(outputRecord, "resultId") ?? getUuid(inputRecord, "resultId");
      const derivedExecutionId =
        getUuid(outputRecord, "executionId") ??
        getUuid(inputRecord, "executionId") ??
        snapshot?.executionId;
      const derivedRunbookId =
        getString(outputRecord, "runbookId") ??
        getString(inputRecord, "runbookId") ??
        snapshot?.runbookId;
      const derivedRunbookTitle =
        getString(outputRecord, "runbookTitle") ??
        getString(inputRecord, "runbookTitle") ??
        snapshot?.runbookTitle;
      const previousContext: Partial<LastKnownArtifactContext> =
        lastKnownContext ?? {};
      const previousResultId: string | null = previousContext.resultId ?? null;
      const previousExecutionId: string | null =
        previousContext.executionId ?? null;
      const previousRunbookId: string | undefined = previousContext.runbookId;
      const previousRunbookTitle: string | undefined =
        previousContext.runbookTitle;
      let resultId: string | null = derivedResultId ?? null;
      let executionId: string | null = derivedExecutionId ?? null;
      let runbookId: string | undefined = derivedRunbookId;
      let runbookTitle: string | undefined = derivedRunbookTitle;
      if (toolCall.toolName === "get_runbook_execution") {
        resultId = derivedResultId ?? previousResultId;
        executionId = derivedExecutionId ?? previousExecutionId;
        runbookId = derivedRunbookId ?? previousRunbookId;
        runbookTitle = derivedRunbookTitle ?? previousRunbookTitle;
      }
      const identityExecutionId = executionId ?? snapshot?.executionId ?? null;

      if (
        toolCall.toolName === "get_runbook_execution" &&
        resultId === null &&
        identityExecutionId === null &&
        snapshot === null
      ) {
        continue;
      }

      if (
        toolCall.state === "failed" &&
        resultId === null &&
        identityExecutionId === null &&
        snapshot === null
      ) {
        continue;
      }

      let key = `tool:${toolCall.toolCallId}`;
      if (identityExecutionId !== null) {
        key = `execution:${identityExecutionId}`;
      }
      if (resultId !== null) {
        key = `result:${resultId}`;
      }

      const previous = refs.get(key);

      refs.set(key, {
        key,
        resultId,
        executionId: identityExecutionId,
        toolCallId: toolCall.toolCallId,
        runbookId: runbookId ?? previous?.runbookId,
        runbookTitle: runbookTitle ?? previous?.runbookTitle,
        toolState: toolCall.state,
        snapshot: snapshot ?? previous?.snapshot ?? null,
        order: previous?.order ?? order,
      });

      lastKnownContext = {
        resultId,
        executionId: identityExecutionId,
        runbookId: runbookId ?? previous?.runbookId,
        runbookTitle: runbookTitle ?? previous?.runbookTitle,
      };

      order += 1;
    }
  }

  return [...refs.values()].sort((left, right) => right.order - left.order);
}

function mergeStoredResultsIntoReferences(
  references: IncidentArtifactReference[],
  storedResults: StoredRunResult[],
): IncidentArtifactReference[] {
  const merged = new Map(references.map((reference) => [reference.key, reference]));
  const resultsByRecency = [...storedResults].sort(
    (left, right) =>
      timestampScore(right.startedAt) - timestampScore(left.startedAt),
  );

  for (const result of resultsByRecency) {
    const existingReference = [...merged.values()].find((reference) => {
      if (reference.resultId !== null) {
        return reference.resultId === result.id;
      }

      if (reference.executionId !== null) {
        return result.executionId === reference.executionId;
      }

      return false;
    });

    let unresolvedRunbookCandidates: IncidentArtifactReference[] = [];
    if (existingReference === undefined) {
      unresolvedRunbookCandidates = [...merged.values()]
        .filter(
          (reference) =>
            reference.resultId === null &&
            reference.executionId === null &&
            runbookIdentityMatches(reference, result),
        )
        .sort((left, right) => right.order - left.order);
    }

    const adoptedReference =
      existingReference ?? unresolvedRunbookCandidates[0] ?? null;
    const key = adoptedReference?.key ?? `result:${result.id}`;
    const previous = adoptedReference ?? merged.get(key);
    let executionId: string | null = previous?.executionId ?? null;
    if (isUuid(result.executionId)) {
      executionId = result.executionId;
    }

    merged.set(key, {
      key,
      resultId: result.id,
      executionId,
      toolCallId: previous?.toolCallId ?? key,
      runbookId: result.runbookId,
      runbookTitle: result.runbookTitle,
      toolState: previous?.toolState ?? "done",
      snapshot: previous?.snapshot ?? null,
      order: previous?.order ?? Number.MAX_SAFE_INTEGER,
    });
  }

  return [...merged.values()].sort((left, right) => right.order - left.order);
}

export function countIncidentArtifacts(
  messages: IncidentArtifactsMessage[],
  incidentId?: string | null,
): number {
  const keys = new Set<string>();
  const references = collectArtifactReferences(messages);
  let mergedReferences = references;
  if (incidentId !== undefined && incidentId !== null && incidentId.length > 0) {
    mergedReferences = mergeStoredResultsIntoReferences(
      references,
      filterStoredResultsForIncident(loadStoredResults(), incidentId),
    );
  }

  for (const reference of mergedReferences) {
    keys.add(runbookIdentityKey(reference));
  }

  return keys.size;
}

function ArtifactListItem({
  artifact,
  isSelected,
  onSelect,
}: {
  artifact: IncidentArtifactEntry;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const isPendingExecution =
    artifact.status === "running" || artifact.status === "starting";
  let StatusIcon = FileText;
  if (isPendingExecution) {
    StatusIcon = Loader2;
  }
  let itemClassName = "border-border bg-muted/10 hover:bg-muted/20";
  if (isSelected) {
    itemClassName = "border-primary bg-primary/5";
  }
  let iconClassName = "text-muted-foreground";
  if (isPendingExecution) {
    iconClassName = "animate-spin text-amber-500";
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-2xl border p-3 text-left transition-colors",
        itemClassName,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background">
          <StatusIcon size={15} className={iconClassName} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium">
              {artifact.runbookTitle}
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                statusClasses(artifact.status),
              )}
            >
              {statusLabel(t, artifact.status)}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {artifactSummaryText(t, artifact)}
          </div>
          {artifact.latestStep !== null && (
            <div className="mt-2 flex items-center gap-2 text-xs text-foreground">
              <ArrowRight size={12} className="text-muted-foreground" />
              <span className="truncate">
                {artifact.latestStep.title ||
                  t("common.incidentArtifactsRail.stepNumber", {
                    order: artifact.latestStep.order,
                  })}
              </span>
              <span className="text-muted-foreground">
                {stepStatusLabel(t, artifact.latestStep.status)}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function ArtifactDetails({
  artifact,
}: {
  artifact: IncidentArtifactEntry | null;
}) {
  const { t } = useTranslation();
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);

  useEffect(() => {
    if (artifact?.execution === undefined || artifact.execution === null) {
      setSelectedStepKey(null);
      return;
    }

    const selectedStillExists = artifact.execution.steps.some(
      (step) => stepSelectionKey(step) === selectedStepKey,
    );
    if (selectedStillExists) return;

    const preferred =
      artifact.execution.steps.find((step) => step.status === "running") ??
      artifact.latestStep ??
      artifact.execution.steps[0] ??
      null;

    if (preferred === null) {
      setSelectedStepKey(null);
    } else {
      setSelectedStepKey(stepSelectionKey(preferred));
    }
  }, [artifact, selectedStepKey]);

  const selectedStep =
    artifact?.execution?.steps.find(
      (step) => stepSelectionKey(step) === selectedStepKey,
    ) ??
    artifact?.execution?.steps.find((step) => step.status === "running") ??
    artifact?.latestStep ??
    artifact?.execution?.steps[0] ??
    null;
  const selectedInput = formatJsonBlock(selectedStep?.input);
  let selectedOutput = finalOutput(artifact?.execution ?? null);
  if (selectedStep !== null) {
    selectedOutput = getStepVisibleOutput(selectedStep);
  }
  const executionParameters = formatJsonBlock(
    artifact?.execution?.parameterValues,
  );

  if (artifact === null) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 text-center text-sm text-muted-foreground">
        {t("common.incidentArtifactsRail.selectARunbookExecutionTo")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold">{artifact.runbookTitle}</div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              statusClasses(artifact.status),
            )}
          >
            {statusLabel(t, artifact.status)}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {artifact.executionId !== null &&
            t("common.incidentArtifactsRail.executionShortId", {
              shortId: artifact.executionId.slice(0, 8),
            })}
          {artifact.executionId === null &&
            t("common.incidentArtifactsRail.pendingExecution")}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(180px,0.9fr)]">
        <div className="min-h-0 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
            <span>{t("common.incidentArtifactsRail.liveSteps")}</span>
            <span>
              {artifact.completedStepCount}/{artifact.stepCount || 0}
            </span>
          </div>

          <div className="space-y-2">
            {artifact.execution?.steps.map((step) => {
              const Icon = actionIcon(step.type);
              const stepKey = stepSelectionKey(step);
              let isActive = false;
              if (selectedStep !== null) {
                isActive = stepSelectionKey(selectedStep) === stepKey;
              }
              let stepButtonClassName =
                "border-border bg-muted/10 hover:bg-muted/20";
              if (isActive) {
                stepButtonClassName = "border-primary bg-primary/5";
              }
              const providerSummary = getStepProviderSummary(step);
              const visibleOutput = getStepVisibleOutput(step);

              return (
                <button
                  key={stepKey}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => { setSelectedStepKey(stepKey); }}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                    stepButtonClassName,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground/60">
                      {step.order}
                    </span>
                    <Icon size={13} className="text-muted-foreground" />
                    <span className="truncate text-sm font-medium">
                      {step.title ||
                        t("common.incidentArtifactsRail.stepNumber", {
                          order: step.order,
                        })}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {actionTypeLabel(t, step.type)} •{" "}
                    {stepStatusLabel(t, step.status)}
                  </div>
                  {providerSummary !== null && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {providerSummary}
                    </div>
                  )}
                  {step.error !== undefined && step.error.length > 0 && (
                    <div className="mt-2 text-xs text-destructive">
                      {step.error}
                    </div>
                  )}
                  {isActive &&
                    (step.error === undefined || step.error.length === 0) &&
                    visibleOutput.length > 0 && (
                    <div className="mt-2 line-clamp-4 text-xs text-muted-foreground">
                      {stripInternalHostBlocks(visibleOutput)}
                    </div>
                  )}
                </button>
              );
            })}

            {artifact.execution === null && (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-3 py-4 text-sm text-muted-foreground">
                {artifactEmptyStateCopy(t, artifact)}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
                {t("common.incidentArtifactsRail.executionParameters")}
              </div>
              <OutputContent
                value={executionParameters}
                emptyMessage={t("common.incidentArtifactsRail.empty.params")}
              />
            </div>
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
                {t("common.incidentArtifactsRail.input")}
              </div>
              <OutputContent
                value={selectedInput}
                emptyMessage={t("common.incidentArtifactsRail.empty.input")}
              />
            </div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
              {t("common.incidentArtifactsRail.output")}
            </div>
            <OutputContent
              value={selectedOutput}
              emptyMessage={t("common.incidentArtifactsRail.empty.output")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function IncidentArtifactsRail({
  isOpen,
  onClose,
  messages,
  incidentId,
}: {
  isOpen: boolean;
  onClose: () => void;
  messages: IncidentArtifactsMessage[];
  incidentId?: string | null;
}) {
  const { t } = useTranslation();
  const { runbooks } = useBitsentryServices();
  const [executionMap, setExecutionMap] = useState<
    Record<string, RunbookExecutionRecord>
  >({});
  const [storedResults, setStoredResults] = useState<StoredRunResult[]>([]);
  const [storedTraces, setStoredTraces] = useState<
    Record<string, StoredResultTraceMemory>
  >({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const previousArtifactKeysRef = useRef<string>("");

  useEffect(() => {
    const refreshStoredRunbookArtifacts = () => {
      setStoredResults(loadStoredResults());
      setStoredTraces(loadStoredResultTraces());
    };

    refreshStoredRunbookArtifacts();
    window.addEventListener(
      "bitsentry:results-updated",
      refreshStoredRunbookArtifacts,
    );

    return () => {
      window.removeEventListener(
        "bitsentry:results-updated",
        refreshStoredRunbookArtifacts,
      );
    };
  }, []);

  const incidentStoredResults = useMemo(
    () => filterStoredResultsForIncident(storedResults, incidentId),
    [incidentId, storedResults],
  );

  const references = useMemo(() => {
    return mergeStoredResultsIntoReferences(
      collectArtifactReferences(messages),
      incidentStoredResults,
    );
  }, [incidentStoredResults, messages]);

  const trackedExecutionIds = useMemo(() => {
    const ids = new Set<string>();

    for (const reference of references) {
      if (isUuid(reference.executionId)) {
        ids.add(reference.executionId);
      }

      const storedResult = findStoredResult(reference, incidentStoredResults);
      if (isUuid(storedResult?.executionId)) {
        ids.add(storedResult.executionId);
      }
    }

    return [...ids];
  }, [incidentStoredResults, references]);

  useEffect(() => {
    const inlineExecutions = Object.fromEntries(
      references
        .filter(
          (
            reference,
          ): reference is IncidentArtifactReference & {
            executionId: string;
            snapshot: RunbookExecutionRecord;
          } => Boolean(reference.executionId && reference.snapshot),
        )
        .map((reference) => [reference.executionId, reference.snapshot]),
    );

    if (Object.keys(inlineExecutions).length === 0) return;

    setExecutionMap((prev) => ({
      ...prev,
      ...inlineExecutions,
    }));
  }, [references]);

  useEffect(() => {
    if (!runbooks || trackedExecutionIds.length === 0) return;

    let cancelled = false;
    const executionIdsToFetch = trackedExecutionIds.filter(
      (executionId) => isUuid(executionId) && !executionMap[executionId],
    );

    if (executionIdsToFetch.length === 0) return;

    void Promise.all(
      executionIdsToFetch.map(async (executionId) => [
        executionId,
        await runbooks.getExecution(executionId).catch(() => null),
      ]),
    ).then((results) => {
      if (cancelled) return;

      const nextEntries = results.filter(
        (entry): entry is [string, RunbookExecutionRecord] => Boolean(entry[1]),
      );

      if (nextEntries.length === 0) return;

      setExecutionMap((prev) => ({
        ...prev,
        ...Object.fromEntries(nextEntries),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [executionMap, runbooks, trackedExecutionIds]);

  useEffect(() => {
    if (!runbooks || trackedExecutionIds.length === 0) return;

    const trackedSet = new Set(trackedExecutionIds);
    return runbooks.onExecutionEvent(({ executionId, execution }) => {
      if (!trackedSet.has(executionId)) return;

      setExecutionMap((prev) => ({
        ...prev,
        [executionId]: execution,
      }));
    });
  }, [runbooks, trackedExecutionIds]);

  const rawArtifacts = useMemo<IncidentArtifactEntry[]>(
    () =>
      references.map((reference) => {
        const fallbackResult = findStoredResult(
          reference,
          incidentStoredResults,
        );
        const resolvedExecutionId =
          reference.executionId ?? fallbackResult?.executionId ?? null;
        let storedExecutionForResult: RunbookExecutionRecord | null = null;
        if (reference.resultId !== null) {
          storedExecutionForResult =
            storedTraces[reference.resultId]?.execution ?? null;
        }
        let storedExecutionById: RunbookExecutionRecord | null = null;
        if (resolvedExecutionId !== null) {
          storedExecutionById = executionMap[resolvedExecutionId] ?? null;
        }
        let matchingStoredExecution: RunbookExecutionRecord | null = null;
        if (resolvedExecutionId !== null) {
          matchingStoredExecution =
            Object.values(storedTraces).find(
              (trace) => trace.execution?.executionId === resolvedExecutionId,
            )?.execution ?? null;
        }
        const fallbackExecution =
          storedExecutionById ??
          reference.snapshot ??
          storedExecutionForResult ??
          matchingStoredExecution ??
          null;
        const execution = fallbackExecution ?? null;
        const latestStep = getLatestStep(execution);
        let completedStepCount = 0;
        let stepCount = 0;
        if (execution !== null) {
          completedStepCount = execution.steps.filter(
            (step) => step.status === "completed",
          ).length;
          stepCount = execution.steps.length;
        }

        let status: IncidentArtifactEntry["status"] = "starting";
        if (resolvedExecutionId !== null) {
          status = "pending";
        }
        if (reference.toolState === "failed") {
          status = "failed";
        }
        if (fallbackResult !== null) {
          status = fallbackResult.status;
        }
        if (execution !== null) {
          status = execution.status;
        }

        return {
          key: reference.key,
          order: reference.order,
          resultId: reference.resultId ?? fallbackResult?.id ?? null,
          executionId: execution?.executionId ?? resolvedExecutionId,
          runbookId: execution?.runbookId ?? reference.runbookId,
          runbookTitle:
            execution?.runbookTitle ??
            fallbackResult?.runbookTitle ??
            reference.runbookTitle ??
            t("common.incidentArtifactsRail.fallbackRunbookExecution"),
          status,
          toolState: reference.toolState,
          startedAt: execution?.startedAt ?? fallbackResult?.startedAt,
          completedAt: execution?.completedAt ?? fallbackResult?.completedAt,
          execution,
          latestStep,
          completedStepCount,
          stepCount,
          hasStoredSummary: fallbackResult !== null,
        };
      }),
    [executionMap, incidentStoredResults, references, storedTraces, t],
  );

  const artifacts = useMemo(
    () => collapseArtifactsByRunbook(rawArtifacts),
    [rawArtifacts],
  );

  useEffect(() => {
    if (artifacts.length === 0) {
      setSelectedKey(null);
      return;
    }

    const selectedStillExists = artifacts.some(
      (artifact) => artifact.key === selectedKey,
    );
    const artifactKeys = artifacts.map((artifact) => artifact.key).join("\n");
    const artifactKeysChanged = artifactKeys !== previousArtifactKeysRef.current;
    previousArtifactKeysRef.current = artifactKeys;

    const preferred =
      artifacts.find(
        (artifact) =>
          artifact.status === "queued" ||
          artifact.status === "running" ||
          artifact.status === "pending",
      ) ?? artifacts[0];

    if (selectedStillExists) {
      const selectedArtifact = artifacts.find(
        (artifact) => artifact.key === selectedKey,
      );
      if (
        artifactKeysChanged &&
        selectedArtifact !== undefined &&
        preferred.key !== selectedArtifact.key &&
        selectedArtifact.status !== "queued" &&
        selectedArtifact.status !== "running" &&
        selectedArtifact.status !== "pending"
      ) {
        setSelectedKey(preferred.key);
      }
      return;
    }

    setSelectedKey(preferred.key);
  }, [artifacts, selectedKey]);

  const selectedArtifact =
    artifacts.find((artifact) => artifact.key === selectedKey) ?? null;
  let railTransformClass = "translate-x-full";
  if (isOpen) {
    railTransformClass = "translate-x-0";
  }

  return (
    <aside
      data-tour="incidents-artifacts-rail"
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-full max-w-[430px] flex-col border-l border-border bg-background/95 shadow-2xl backdrop-blur transition-transform duration-300",
        railTransformClass,
      )}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-9 items-center justify-center rounded-2xl border border-border bg-muted/20">
          <FileText size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {t("common.incidentArtifactsRail.runbookResults")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("common.incidentArtifactsRail.runbookExecutionCount", {
              count: artifacts.length,
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("common.incidentArtifactsRail.closeArtifacts")}
        >
          <X size={14} />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,0.9fr)_minmax(0,1.4fr)]">
        <div
          data-tour="incidents-artifacts-list"
          className="min-h-0 overflow-y-auto px-4 py-4"
        >
          <div className="space-y-2">
            {artifacts.map((artifact) => (
              <ArtifactListItem
                key={artifact.key}
                artifact={artifact}
                isSelected={artifact.key === selectedKey}
                onSelect={() => { setSelectedKey(artifact.key); }}
              />
            ))}

            {artifacts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground">
                {t("common.incidentArtifactsRail.whenTheIncidentAgentExecutes")}
              </div>
            )}
          </div>
        </div>

        <div
          data-tour="incidents-artifacts-detail"
          className="min-h-0 px-4 pb-4"
        >
          <ArtifactDetails artifact={selectedArtifact} />
        </div>
      </div>
    </aside>
  );
}
