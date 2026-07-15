import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Bot,
  Database,
  FileText,
  Globe,
  History,
  Loader2,
  Puzzle,
  ScanSearch,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import Navbar from "../layout/Navbar";
import TopBar from "../layout/TopBar";
import { MarkdownContent } from "../markdown";
import { cn } from "../lib/utils";
import { stripInternalHostBlocks } from "../lib/hostProtocol";
import { StructuredOutputDisplay } from "./StructuredOutputDisplay";
import { StreamDeltaInspector } from "../chat/StreamDeltaInspector";
import type {
  RunbookActionType,
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
} from "../services/contracts";
import { useRunbooksService } from "../services/hooks";
import { useTranslation } from "@bitsentry-ce/i18n";

type RunResultStatus =
  | "queued"
  | "pending"
  | "running"
  | "claim_expired"
  | "completed"
  | "failed"
  | "cancelled";

interface StoredRunResult {
  id: string;
  executionId?: string;
  incidentThreadId?: string;
  runbookId: string;
  runbookTitle: string;
  runbookRevisionNumber?: number;
  runbookContextJson?: string;
  status: RunResultStatus;
  startedAt: string;
  completedAt?: string;
  completionReason?: RunbookExecutionRecord["completionReason"];
}

interface ResultTraceMemory {
  execution: RunbookExecutionRecord | null;
}

const RESULTS_KEY = "bitsentry_results";
const LEGACY_RESULTS_KEY = "bitsentry_investigations";
const RESULT_TRACES_KEY = "bitsentry_result_traces";
const LEGACY_RESULT_TRACES_KEY = "bitsentry_investigation_traces";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function loadResults(): StoredRunResult[] {
  try {
    const raw =
      localStorage.getItem(RESULTS_KEY) ??
      localStorage.getItem(LEGACY_RESULTS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as StoredRunResult[];
    return parsed.map((item) => {
      if (item.status === "running" && item.executionId === undefined) {
        return { ...item, status: "failed" };
      }

      return item;
    });
  } catch {
    return [];
  }
}

function saveResults(list: StoredRunResult[]) {
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(list));
  } catch {}
}

function loadResultTraces(): Record<string, ResultTraceMemory> {
  try {
    const raw =
      localStorage.getItem(RESULT_TRACES_KEY) ??
      localStorage.getItem(LEGACY_RESULT_TRACES_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Record<
      string,
      { execution?: RunbookExecutionRecord | null }
    >;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        {
          execution: value?.execution ?? null,
        },
      ]),
    );
  } catch {
    return {};
  }
}

function saveResultTraces(traceMap: Record<string, ResultTraceMemory>) {
  try {
    localStorage.setItem(RESULT_TRACES_KEY, JSON.stringify(traceMap));
  } catch {}
}

function statusLabel(status: RunResultStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "claim_expired":
      return "Claim expired";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function statusClass(status: RunResultStatus): string {
  switch (status) {
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

function formatIdleTimeoutMinutes(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return "None";
  return `${String(value)}m`;
}

function cancellationReasonMessage(
  execution: RunbookExecutionRecord | null | undefined,
): string | null {
  if (execution?.completionReason !== "idle_timeout") return null;
  const timeout = formatIdleTimeoutMinutes(execution.idleTimeoutMinutes) ?? "the configured idle window";
  return `Cancelled after ${timeout} without execution activity`;
}

function executionSource(execution: RunbookExecutionRecord | null | undefined) {
  if (execution?.source === "agent") {
    return "agent";
  }

  return "manual";
}

function sourceLabel(execution: RunbookExecutionRecord | null | undefined) {
  if (executionSource(execution) === "agent") {
    return "Agent";
  }

  return "Manual";
}

function sourceClass(execution: RunbookExecutionRecord | null | undefined) {
  if (executionSource(execution) === "agent") {
    return "border-violet-500/20 bg-violet-500/10 text-violet-500";
  }

  return "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400";
}

function startedByLabel(execution: RunbookExecutionRecord | null | undefined) {
  if (executionSource(execution) === "agent") {
    return "Started by agent";
  }

  return "Started manually";
}

function entrypointLabel(execution: RunbookExecutionRecord | null | undefined) {
  switch (execution?.triggerContext?.entrypoint) {
    case "runbooks":
      return "From Runbooks";
    case "incident_detail":
      return "From Incident Detail";
    case "incident_workspace":
      return "From Incident Workspace";
    case "diagnosis":
      return "From Diagnosis";
    default:
      return null;
  }
}

function typeIcon(type: RunbookActionType) {
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

function finalOutput(execution: RunbookExecutionRecord | null): string {
  if (execution === null) return "";
  const completed = [...execution.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "completed" &&
        step.output !== undefined &&
        step.output.length > 0,
    );
  return completed?.output ?? "";
}

function stepSelectionKey(step: RunbookExecutionStepRecord): string {
  let actionPart: string = step.type;
  if (step.actionId !== undefined && step.actionId.length > 0) {
    actionPart = step.actionId;
  }

  return `${String(step.order)}:${actionPart}:${step.title}`;
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

function RenderedOutput({
  value,
  emptyMessage,
}: {
  value: string;
  emptyMessage: string;
}) {
  const text = stripInternalHostBlocks(value);

  if (text.length === 0) {
    return (
      <p className="text-xs italic text-muted-foreground/50">{emptyMessage}</p>
    );
  }

  if (looksLikeMarkdown(text)) {
    return (
      <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <MarkdownContent content={text} className="min-w-0 max-w-full" />
      </div>
    );
  }

  return (
    <pre className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-muted/20 p-3 text-xs whitespace-pre-wrap break-words">
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

function executionParameterSummary(
  execution: RunbookExecutionRecord | null | undefined,
): string | null {
  const parameterValues = execution?.parameterValues;
  if (parameterValues === undefined) return null;

  const entries = Object.entries(parameterValues)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .slice(0, 2);

  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${value}`).join(" • ");
}

function sortResults(list: StoredRunResult[]): StoredRunResult[] {
  return [...list].sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
}

function SummaryPanel({
  result,
  execution,
}: {
  result: StoredRunResult;
  execution: RunbookExecutionRecord | null;
}) {
  const { t } = useTranslation();
  const completedSteps =
    execution?.steps.filter((step) => step.status === "completed").length ?? 0;
  const failedStep =
    execution?.steps.find((step) => step.status === "failed") ?? null;
  const finalText = finalOutput(execution);
  const parameterText = formatJsonBlock(execution?.parameterValues);
  const sourceText = sourceLabel(execution);
  const sourceDetailText = startedByLabel(execution);
  const surfaceText = entrypointLabel(execution);
  const idleTimeoutText = formatIdleTimeoutMinutes(execution?.idleTimeoutMinutes);
  const idleCancellationMessage = cancellationReasonMessage(execution);

  let surfaceContent: ReactNode = null;
  if (surfaceText !== null) {
    surfaceContent = (
      <div className="text-xs text-muted-foreground">{surfaceText}</div>
    );
  }

  let completedAtContent: ReactNode = null;
  if (result.completedAt !== undefined) {
    completedAtContent = (
      <div className="text-xs text-muted-foreground">
        {t("common.results.completed")}{" "}
        {new Date(result.completedAt).toLocaleString()}
      </div>
    );
  }

  let idleTimeoutContent: ReactNode = null;
  if (idleTimeoutText !== null) {
    idleTimeoutContent = (
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.results.idleTimeout")}
        </div>
        <div className="mt-1 font-medium">{idleTimeoutText}</div>
      </div>
    );
  }

  let idleCancellationContent: ReactNode = null;
  if (idleCancellationMessage !== null) {
    idleCancellationContent = (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
        {idleCancellationMessage}
      </div>
    );
  }

  let failedStepContent: ReactNode = null;
  if (failedStep !== null) {
    let failedStepTitle = t("common.incidentArtifactsRail.stepNumber", {
      order: failedStep.order,
    });
    if (failedStep.title.length > 0) {
      failedStepTitle = failedStep.title;
    }

    failedStepContent = (
      <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        <div className="font-medium">{failedStepTitle}</div>
        <div className="mt-1 whitespace-pre-wrap text-xs">{failedStep.error}</div>
      </div>
    );
  }

  let finalOutputEmptyMessage = t(
    "common.results.noCompletedStepOutputAvailable",
  );
  if (result.status === "running") {
    finalOutputEmptyMessage = t("common.results.executionIsStillRunning");
  }

  return (
    <div data-tour="results-summary" className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {t("common.results.summary")}
        </h3>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground/60">
            {t("common.results.runbook")}
          </div>
          <div className="font-medium">{result.runbookTitle}</div>
          <div className="text-xs text-muted-foreground">
            {sourceDetailText} {new Date(result.startedAt).toLocaleString()}
          </div>
          {surfaceContent}
          {completedAtContent}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {t("common.results.status")}
            </div>
            <div className="mt-1 font-medium">{statusLabel(result.status)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {t("common.results.completed_2")}
            </div>
            <div className="mt-1 font-medium">
              {completedSteps}/{execution?.steps.length ?? 0} steps
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {t("runbooks.results.source")}
                          </div>
            <div className="mt-1 font-medium">{sourceText}</div>
          </div>
          {idleTimeoutContent}
        </div>

        {idleCancellationContent}
        {failedStepContent}

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground/60">
            {t("common.results.executionParameters")}
          </div>
          <RenderedOutput
            value={parameterText}
            emptyMessage={t("common.results.noRuntimeParameterValuesCaptured")}
          />
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground/60">
            {t("common.results.finalOutput")}
          </div>
          <RenderedOutput
            value={finalText}
            emptyMessage={finalOutputEmptyMessage}
          />
        </div>
      </div>
    </div>
  );
}

function StepsPanel({
  execution,
  selectedStepKey,
  onSelect,
}: {
  execution: RunbookExecutionRecord | null;
  selectedStepKey: string | null;
  onSelect: (stepKey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-tour="results-steps" className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {t("common.results.steps")}
        </h3>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {execution?.steps.map((step) => {
          const Icon = typeIcon(step.type);
          const stepKey = stepSelectionKey(step);
          const isSelected = selectedStepKey === stepKey;
          let stepClassName = "border-border bg-muted/10 hover:bg-muted/20";
          if (isSelected) {
            stepClassName = "border-primary bg-primary/5";
          }

          let stepTitle = t("common.incidentArtifactsRail.stepNumber", {
            order: step.order,
          });
          if (step.title.length > 0) {
            stepTitle = step.title;
          }

          let stepErrorContent: ReactNode = null;
          if (step.error !== undefined && step.error.length > 0) {
            stepErrorContent = (
              <div className="mt-2 truncate text-xs text-destructive">
                {step.error}
              </div>
            );
          }

          return (
            <button
              key={stepKey}
              aria-pressed={isSelected}
              onClick={() => { onSelect(stepKey); }}
              className={cn(
                "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                stepClassName,
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground/60">
                  {step.order}
                </span>
                <Icon size={13} className="text-muted-foreground" />
                <span className="truncate text-sm font-medium">{stepTitle}</span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="uppercase tracking-wide">{step.type}</span>
                <span className="text-muted-foreground/30">•</span>
                <span>{step.status}</span>
              </div>
              {stepErrorContent}
            </button>
          );
        })}
        {!execution && (
          <p className="text-xs italic text-muted-foreground/50">
            {t("common.results.waitingForExecutionState")}
          </p>
        )}
      </div>
    </div>
  );
}

function OutputPanel({ step }: { step: RunbookExecutionStepRecord | null }) {
  const { t } = useTranslation();
  const inputText = formatJsonBlock(step?.input);
  let content: ReactNode = (
    <p className="text-xs italic text-muted-foreground/50">
      {t("common.results.selectAStepToInspect")}
    </p>
  );
  if (step !== null) {
    let stepTitle = t("common.incidentArtifactsRail.stepNumber", {
      order: step.order,
    });
    if (step.title.length > 0) {
      stepTitle = step.title;
    }

    let errorContent: ReactNode = null;
    if (step.error !== undefined && step.error.length > 0) {
      errorContent = (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs whitespace-pre-wrap text-destructive">
          {step.error}
        </div>
      );
    }

    let outputEmptyMessage = t("common.results.noOutputCapturedForThis");
    if (step.status === "running") {
      outputEmptyMessage = t("common.results.thisStepIsStillProducing");
    }

    content = (
      <div className="min-w-0 space-y-3">
        <div>
          <div className="text-sm font-medium">{stepTitle}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {step.type} • {step.status}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {t("common.results.input")}
          </div>
          <RenderedOutput
            value={inputText}
            emptyMessage={t("common.results.noInputMetadataCaptured")}
          />
        </div>
        {errorContent}
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/60">
            {t("common.results.output_2")}
          </div>
          <RenderedOutput
            value={step.output ?? ""}
            emptyMessage={outputEmptyMessage}
          />
        </div>
        <StreamDeltaInspector deltas={step.streamDeltas} />
        <StructuredOutputDisplay
          metadata={step.metadata}
          structuredOutput={step.structuredOutput}
        />
      </div>
    );
  }

  return (
    <div data-tour="results-output" className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {t("common.results.output")}
        </h3>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
        {content}
      </div>
    </div>
  );
}

function ResultsList({
  results,
  traceMap,
  emptyMessage,
  onSelect,
}: {
  results: StoredRunResult[];
  traceMap?: Record<string, ResultTraceMemory>;
  emptyMessage: string;
  onSelect: (resultId: string) => void;
}) {
  const { t } = useTranslation();
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground">
        <FileText size={36} className="opacity-25" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {results.map((result) => {
        const execution = traceMap?.[result.id]?.execution ?? null;
        const parameterSummary = executionParameterSummary(execution);
        let completedAtContent: ReactNode = null;
        if (result.completedAt !== undefined) {
          completedAtContent = (
            <>
              <span className="text-muted-foreground/30">•</span>
              <span>
                {t("common.results.completed_3")}{" "}
                {new Date(result.completedAt).toLocaleString()}
              </span>
            </>
          );
        }

        let parameterSummaryContent: ReactNode = null;
        if (parameterSummary !== null) {
          parameterSummaryContent = (
            <div className="mt-1 text-xs text-muted-foreground">
              {parameterSummary}
            </div>
          );
        }

        return (
          <button
            key={result.id}
            onClick={() => { onSelect(result.id); }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <FileText size={14} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {result.runbookTitle}
                <span className="ml-2 font-mono text-xs text-muted-foreground/50">
                  {result.id.slice(0, 8)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("common.results.started_2")}{" "}
                  {new Date(result.startedAt).toLocaleString()}
                </span>
                {completedAtContent}
              </div>
              {parameterSummaryContent}
            </div>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                sourceClass(execution),
              )}
            >
              {sourceLabel(execution)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                statusClass(result.status),
              )}
            >
              {statusLabel(result.status)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function ResultsPage() {
  const { t } = useTranslation();
  const runbooks = useRunbooksService();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const activeId = searchParams.get("id");
  const runbookFilter = searchParams.get("runbook");
  const viewMode = searchParams.get("view");
  const [results, setResults] = useState<StoredRunResult[]>(loadResults);
  const [traceMap, setTraceMap] =
    useState<Record<string, ResultTraceMemory>>(loadResultTraces);
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);

  const sortedResults = useMemo(() => sortResults(results), [results]);
  const filteredResults = useMemo(() => {
    if (runbookFilter !== null && runbookFilter.length > 0) {
      return sortedResults.filter((result) => result.runbookId === runbookFilter);
    }

    return sortedResults;
  }, [runbookFilter, sortedResults]);
  const resultCounts = useMemo(
    () =>
      filteredResults.reduce<Record<RunResultStatus | "total", number>>(
        (counts, result) => {
          counts.total += 1;
          counts[result.status] += 1;
          return counts;
        },
        {
          total: 0,
          queued: 0,
          pending: 0,
          running: 0,
          claim_expired: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
      ),
    [filteredResults],
  );
  const showAllHistory =
    activeId === null &&
    (viewMode === "history" || runbookFilter === null || runbookFilter.length === 0);

  const activeResult =
    sortedResults.find((result) => result.id === activeId) ?? null;
  let activeExecution: RunbookExecutionRecord | null = null;
  if (activeId !== null) {
    activeExecution = traceMap[activeId]?.execution ?? null;
  }

  useEffect(() => {
    saveResults(results);
    window.dispatchEvent(new Event("bitsentry:results-updated"));
  }, [results]);

  useEffect(() => {
    saveResultTraces(traceMap);
    window.dispatchEvent(new Event("bitsentry:results-updated"));
  }, [traceMap]);

  const syncExecution = useCallback(
    (resultId: string, execution: RunbookExecutionRecord) => {
      setTraceMap((prev) => ({
        ...prev,
        [resultId]: { execution },
      }));
      setResults((prev) =>
        prev.map((result) => {
          if (result.id !== resultId) {
            return result;
          }

          return {
            ...result,
            status: execution.status,
            completedAt: execution.completedAt ?? result.completedAt,
            completionReason:
              execution.completionReason ?? result.completionReason,
          };
        }),
      );
    },
    [],
  );

  useEffect(() => {
    if (!isUuid(activeResult?.executionId)) return;
    const cachedExecution = traceMap[activeResult.id]?.execution;
    if (cachedExecution?.executionId === activeResult.executionId) return;

    let cancelled = false;

    void runbooks.getExecution(activeResult.executionId).then((execution) => {
      if (!cancelled && execution !== null) {
        syncExecution(activeResult.id, execution);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeResult?.executionId,
    activeResult?.id,
    runbooks,
    syncExecution,
    traceMap,
  ]);

  useEffect(() => {
    return runbooks.onExecutionEvent(
      ({ resultId, executionId, incidentThreadId, execution }) => {
        setTraceMap((prev) => ({
          ...prev,
          [resultId]: { execution },
        }));

        setResults((prev) => {
          const existingIndex = prev.findIndex((item) => item.id === resultId);
          if (existingIndex >= 0) {
            return prev.map((result, index) => {
              if (index !== existingIndex) {
                return result;
              }

              let startedAt = result.startedAt;
              if (startedAt.length === 0) {
                startedAt = execution.startedAt;
              }

              return {
                ...result,
                executionId,
                incidentThreadId:
                  incidentThreadId ?? result.incidentThreadId,
                runbookId: execution.runbookId,
                runbookTitle: execution.runbookTitle,
                status: execution.status,
                startedAt,
                completedAt: execution.completedAt ?? result.completedAt,
                completionReason:
                  execution.completionReason ?? result.completionReason,
              };
            });
          }

          return [
            {
              id: resultId,
              executionId,
              incidentThreadId: incidentThreadId ?? undefined,
              runbookId: execution.runbookId,
              runbookTitle: execution.runbookTitle,
              status: execution.status,
              startedAt: execution.startedAt,
              completedAt: execution.completedAt,
              completionReason: execution.completionReason,
            },
            ...prev,
          ];
        });
      },
    );
  }, [runbooks]);

  useEffect(() => {
    if (activeExecution === null) {
      setSelectedStepKey(null);
      return;
    }
    const preferred =
      activeExecution.steps.find((step) => step.status === "running") ??
      activeExecution.steps.find((step) => step.status === "pending") ??
      activeExecution.steps.find((step) => step.status === "failed") ??
      activeExecution.steps.find((step) => step.status === "completed") ??
      activeExecution.steps[0];
    setSelectedStepKey((current) => {
      if (
        current !== null &&
        current.length > 0 &&
        activeExecution.steps.some((step) => stepSelectionKey(step) === current)
      ) {
        return current;
      }

      if (preferred !== undefined) {
        return stepSelectionKey(preferred);
      }

      return null;
    });
  }, [activeExecution]);

  const activeStep = useMemo(
    () =>
      activeExecution?.steps.find(
        (step) => stepSelectionKey(step) === selectedStepKey,
      ) ??
      activeExecution?.steps[0] ??
      null,
    [activeExecution, selectedStepKey],
  );

  const handleCancel = useCallback(async () => {
    if (!isUuid(activeResult?.executionId) || cancelPending) return;
    setCancelPending(true);
    try {
      await runbooks.cancelExecution(activeResult.executionId);
    } finally {
      setCancelPending(false);
    }
  }, [activeResult?.executionId, cancelPending, runbooks]);

  // ── Filtered list view when ?runbook=<id> is present ─────────────────────
  if (runbookFilter !== null && runbookFilter.length > 0 && activeId === null) {
    const runbookTitle = filteredResults[0]?.runbookTitle ?? "Runbook";
    let resultPluralSuffix = "s";
    if (resultCounts.total === 1) {
      resultPluralSuffix = "";
    }

    return (
      <div className="flex h-screen overflow-hidden">
        <Navbar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
              <button
                onClick={() => { void navigate(`/runbooks?id=${runbookFilter}`); }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft size={12} />
                {t("common.results.backToRunbook")}
              </button>
              <span className="text-muted-foreground/30">/</span>
              <span className="flex-1 text-sm font-medium text-muted-foreground">
                {t("common.results.resultsFor")} {runbookTitle}
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {resultCounts.total} run{resultPluralSuffix}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <ResultsList
                results={filteredResults}
                traceMap={traceMap}
                emptyMessage={t("common.results.noResultsYetRunThisRunbook")}
                onSelect={(resultId) => { void navigate(`/results?id=${resultId}`); }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (showAllHistory) {
    return (
      <div className="flex h-screen overflow-hidden">
        <Navbar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
              <span className="flex-1 text-sm font-medium text-muted-foreground">
                {t("common.results.allRunbookResults")}
              </span>
              <button
                data-tour="results-runbooks-btn"
                onClick={() => { void navigate("/runbooks"); }}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
              >
                <BookOpen size={12} />
                {t("common.results.runbooks")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {filteredResults.length > 0 && (
                <div
                  data-tour="results-stats"
                  className="mb-4 grid gap-3 md:grid-cols-4"
                >
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      {t("common.results.total")}
                    </div>
                    <div className="mt-1 text-lg font-medium">
                      {resultCounts.total}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-amber-500/5 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      {t("common.results.running")}
                    </div>
                    <div className="mt-1 text-lg font-medium text-amber-500">
                      {resultCounts.running}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-emerald-500/5 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      {t("common.results.completed_4")}
                    </div>
                    <div className="mt-1 text-lg font-medium text-emerald-500">
                      {resultCounts.completed}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-destructive/5 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      {t("common.results.failedCancelled")}
                    </div>
                    <div className="mt-1 text-lg font-medium text-destructive">
                      {resultCounts.failed +
                        resultCounts.cancelled +
                        resultCounts.claim_expired}
                    </div>
                  </div>
                </div>
              )}

              <div data-tour="results-list">
                <ResultsList
                  results={filteredResults}
                  traceMap={traceMap}
                  emptyMessage={t("common.results.noRunbookResultsYet")}
                  onSelect={(resultId) => { void navigate(`/results?id=${resultId}`); }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex flex-1 overflow-hidden">
          {activeResult === null && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <FileText size={36} className="opacity-25" />
              <p className="text-sm">
                {t("common.results.selectAResultOrRun")}
              </p>
              <button
                onClick={() => { void navigate("/runbooks"); }}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-xs hover:border-primary/40 hover:text-foreground transition-colors"
              >
                <BookOpen size={12} />
                {t("common.results.goToRunbooks")}
              </button>
            </div>
          )}
          {activeResult !== null && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
                <button
                  data-tour="results-runbooks-btn"
                  onClick={() => {
                    void navigate(`/runbooks?id=${activeResult.runbookId}`);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {activeResult.runbookTitle}
                </button>
                <span className="text-muted-foreground/30">/</span>
                <span className="font-mono text-xs text-muted-foreground/50">
                  {activeResult.id.slice(0, 8)}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    statusClass(activeResult.status),
                  )}
                >
                  {statusLabel(activeResult.status)}
                </span>
                <div className="flex-1" />
                <button
                  data-tour="results-history-btn"
                  onClick={() => { void navigate("/results?view=history"); }}
                  className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
                  title={t("common.results.allRunbookResults_2")}
                >
                  <History size={13} />
                </button>
                {activeResult.status === "running" && (
                  <button
                    onClick={() => { void handleCancel(); }}
                    disabled={cancelPending}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    {cancelPending && <Loader2 size={11} className="animate-spin" />}
                    {!cancelPending && <X size={11} />}
                    {t("common.actions.cancel")}
                  </button>
                )}
              </div>

              <div className="flex flex-1 divide-x divide-border overflow-hidden">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <SummaryPanel
                    result={activeResult}
                    execution={activeExecution}
                  />
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <StepsPanel
                    execution={activeExecution}
                    selectedStepKey={selectedStepKey}
                    onSelect={setSelectedStepKey}
                  />
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <OutputPanel step={activeStep} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
