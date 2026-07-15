import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "@bitsentry-ce/i18n";

const INCIDENTS_KEY = "bitsentry_incidents";
const INCIDENT_MESSAGES_KEY = "bitsentry_incident_messages";
const RUNBOOKS_KEY = "bitsentry_runbooks";
const RESULTS_KEY = "bitsentry_results";
const LEGACY_RESULTS_KEY = "bitsentry_investigations";
const RESULT_TRACES_KEY = "bitsentry_result_traces";
const LEGACY_RESULT_TRACES_KEY = "bitsentry_investigation_traces";
const RUNBOOK_ANALYTICS_KEY = "bitsentry.analytics.runbookExecutionState";

type IpcInvoke = <T = unknown>(
  channel: string,
  ...args: unknown[]
) => Promise<T>;

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type RunbookExecutionActionType =
  | "shell"
  | "llm"
  | "http"
  | "plugin"
  | "external_source"
  | "telemetry_existing_entry"
  | "data_source_query"
  | "telemetry_ingest"
  | "diagnosis_diagnose"
  | "diagnosis_verify"
  | "diagnosis_recommend";

type RunbookExecutionStatus = "running" | "completed" | "failed" | "cancelled";
type RunbookExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface DesktopProductStateSnapshot {
  incidents: unknown[];
  incidentMessages: Record<string, unknown[]>;
  runbooks: unknown[];
  results: unknown[];
  resultTraces: Record<string, unknown>;
}

interface ExecutionSnapshotRecord {
  executionId: string
  runbookId: string
  runbookTitle: string
  status: RunbookExecutionStatus
  startedAt: string
  completedAt?: string
  completionReason?: 'success' | 'step_failed' | 'user_cancelled' | 'idle_timeout' | 'app_shutdown' | 'lease_expired'
  idleTimeoutMinutes?: number
  lastActivityAt?: string
  parameterValues?: Record<string, string>
  steps: Array<{
    actionId: string;
    order: number;
    type: RunbookExecutionActionType;
    title: string;
    status: RunbookExecutionStepStatus;
    input?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
    output?: string;
    error?: string;
  }>;
}

interface StoredRunResult {
  id: string
  executionId?: string
  incidentThreadId?: string
  runbookId: string
  runbookTitle: string
  runbookRevisionNumber?: number
  runbookContextJson?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  completionReason?: 'success' | 'step_failed' | 'user_cancelled' | 'idle_timeout' | 'app_shutdown' | 'lease_expired'
}

interface ResultTraceMemory {
  execution: ExecutionSnapshotRecord | null;
}

interface RunbookExecutionAnalyticsState {
  runCountsByRunbookId: Record<string, number>;
}

interface RunbookExecutionEvent {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: ExecutionSnapshotRecord;
}

type SubscribeToRunbookExecutionEvents = (
  callback: (event: RunbookExecutionEvent) => void,
) => () => void;

type CommandCategory =
  | "logs"
  | "process"
  | "disk"
  | "network"
  | "database"
  | "docker"
  | "kubernetes"
  | "systemctl"
  | "custom";

const COMMAND_CATEGORY_PATTERNS: Array<{
  category: CommandCategory;
  pattern: RegExp;
}> = [
  { category: "logs", pattern: /\b(journalctl|tail|grep|awk|sed|less|cat)\b/ },
  { category: "process", pattern: /\b(ps|top|htop|pgrep|pidof|kill)\b/ },
  { category: "disk", pattern: /\b(df|du|lsblk|mount|free)\b/ },
  {
    category: "network",
    pattern: /\b(curl|wget|ping|dig|nslookup|ss|netstat|lsof|traceroute)\b/,
  },
  { category: "database", pattern: /\b(psql|mysql|redis-cli|mongo|sqlite3)\b/ },
  { category: "docker", pattern: /\b(docker|docker-compose|podman)\b/ },
  { category: "kubernetes", pattern: /\b(kubectl|helm)\b/ },
  { category: "systemctl", pattern: /\bsystemctl\b/ },
];

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readLocalSnapshot(): DesktopProductStateSnapshot {
  return {
    incidents: loadJson(INCIDENTS_KEY, []),
    incidentMessages: loadJson(INCIDENT_MESSAGES_KEY, {}),
    runbooks: loadJson(RUNBOOKS_KEY, []),
    results: loadJson(RESULTS_KEY, loadJson(LEGACY_RESULTS_KEY, [])),
    resultTraces: loadJson(
      RESULT_TRACES_KEY,
      loadJson(LEGACY_RESULT_TRACES_KEY, {}),
    ),
  };
}

function writeLocalSnapshot(snapshot: DesktopProductStateSnapshot): void {
  saveJson(INCIDENTS_KEY, snapshot.incidents);
  saveJson(INCIDENT_MESSAGES_KEY, snapshot.incidentMessages);
  saveJson(RUNBOOKS_KEY, snapshot.runbooks);
  saveJson(RESULTS_KEY, snapshot.results);
  saveJson(RESULT_TRACES_KEY, snapshot.resultTraces);
}

function recordRunbookExecutionForAnalytics(runbookId: string) {
  const state = loadJson<RunbookExecutionAnalyticsState>(RUNBOOK_ANALYTICS_KEY, {
    runCountsByRunbookId: {},
  });
  const nextCount = (state.runCountsByRunbookId[runbookId] ?? 0) + 1;
  saveJson(RUNBOOK_ANALYTICS_KEY, {
    runCountsByRunbookId: {
      ...state.runCountsByRunbookId,
      [runbookId]: nextCount,
    },
  });
  return {
    runbook_run_count: nextCount,
    runbook_reused: nextCount > 1,
  };
}

function toDurationMs(startedAt: string, completedAt?: string): number | undefined {
  if (completedAt === undefined || completedAt.length === 0) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function countStepsByStatus(
  execution: ExecutionSnapshotRecord,
  status: RunbookExecutionStepStatus,
): number {
  return execution.steps.filter((step) => step.status === status).length;
}

function hasStepType(
  execution: ExecutionSnapshotRecord,
  type: RunbookExecutionActionType,
): boolean {
  return execution.steps.some((step) => step.type === type);
}

function summarizeExecutionForAnalytics(execution: ExecutionSnapshotRecord) {
  let runtimeParameterCount = 0;
  if (execution.parameterValues !== undefined) {
    runtimeParameterCount = Object.keys(execution.parameterValues).length;
  }

  return {
    execution_id: execution.executionId,
    runbook_id: execution.runbookId,
    runbook_action_count: execution.steps.length,
    completed_action_count: countStepsByStatus(execution, "completed"),
    failed_action_count: countStepsByStatus(execution, "failed"),
    cancelled_action_count: countStepsByStatus(execution, "cancelled"),
    has_shell_step: hasStepType(execution, "shell"),
    has_ai_step: hasStepType(execution, "llm"),
    has_http_step: hasStepType(execution, "http"),
    has_plugin_step: hasStepType(execution, "plugin"),
    has_external_source_step: hasStepType(execution, "external_source"),
    runtime_parameter_count: runtimeParameterCount,
    run_duration_ms: toDurationMs(execution.startedAt, execution.completedAt),
    completion_reason: execution.completionReason,
    status: execution.status,
  };
}

function summarizeStepForAnalytics(
  execution: ExecutionSnapshotRecord,
  step: ExecutionSnapshotRecord["steps"][number],
) {
  return {
    execution_id: execution.executionId,
    runbook_id: execution.runbookId,
    runbook_action_type: step.type,
    runbook_step_order: step.order,
    step_status: step.status,
    step_duration_ms: toDurationMs(step.startedAt ?? "", step.completedAt),
  };
}

function stepAnalyticsKey(
  execution: ExecutionSnapshotRecord,
  step: ExecutionSnapshotRecord["steps"][number],
): string {
  return `${execution.executionId}:${String(step.order)}:${step.actionId}:${step.status}`;
}

function isTerminalStatus(status: RunbookExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function dispatchRunbookTerminalAnalytics(summary: Record<string, unknown>): void {
  window.dispatchEvent(
    new CustomEvent("bitsentry:runbook-terminal-analytics", {
      detail: summary,
    }),
  );
}

function commandCategoryFromStep(
  step: ExecutionSnapshotRecord["steps"][number],
):
  | "logs"
  | "process"
  | "disk"
  | "network"
  | "database"
  | "docker"
  | "kubernetes"
  | "systemctl"
  | "custom"
  | "unknown" {
  let command = "";
  if (typeof step.input?.command === "string") {
    command = step.input.command.toLowerCase();
  }
  if (command.trim().length === 0) return "unknown";
  return commandCategoryFromCommand(command);
}

function commandCategoryFromCommand(
  command: string,
): CommandCategory {
  for (const { category, pattern } of COMMAND_CATEGORY_PATTERNS) {
    if (pattern.test(command)) {
      return category;
    }
  }

  return "custom";
}

function normalizeStoredResults(results: unknown[]): StoredRunResult[] {
  return results.filter((result): result is StoredRunResult => {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return false;
    }
    return typeof (result as StoredRunResult).id === "string";
  });
}

function normalizeResultTraces(
  traces: Record<string, unknown>,
): Record<string, ResultTraceMemory> {
  const normalized: Record<string, ResultTraceMemory> = {};
  for (const [key, value] of Object.entries(traces)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const trace = value as ResultTraceMemory;
    normalized[key] = {
      execution: trace.execution ?? null,
    };
  }

  return normalized;
}

function buildExecutionResultRecord(input: {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: ExecutionSnapshotRecord;
  existing?: StoredRunResult;
}): StoredRunResult {
  const startedAt = input.existing?.startedAt ?? input.execution.startedAt;
  const record: StoredRunResult = {
    id: input.resultId,
    executionId: input.executionId,
    runbookId: input.execution.runbookId,
    runbookTitle: input.execution.runbookTitle,
    runbookRevisionNumber: input.existing?.runbookRevisionNumber,
    runbookContextJson: input.existing?.runbookContextJson,
    status: input.execution.status,
    startedAt,
    completedAt: input.execution.completedAt,
    completionReason: input.execution.completionReason,
  };
  if (input.incidentThreadId !== undefined && input.incidentThreadId !== null) {
    record.incidentThreadId = input.incidentThreadId;
  }

  return record;
}

function upsertExecutionResult(
  results: StoredRunResult[],
  input: {
    resultId: string;
    executionId: string;
    incidentThreadId?: string | null;
    execution: ExecutionSnapshotRecord;
  },
): StoredRunResult[] {
  const nextResults = [...results];
  const existingIndex = nextResults.findIndex((item) => item.id === input.resultId);
  let existing: StoredRunResult | undefined;
  if (existingIndex >= 0) {
    existing = nextResults[existingIndex];
  }
  const nextRecord = buildExecutionResultRecord({
    ...input,
    existing,
  });

  if (existing !== undefined) {
    nextResults[existingIndex] = {
      ...existing,
      ...nextRecord,
    };
    return nextResults;
  }

  nextResults.unshift(nextRecord);
  return nextResults;
}

function trackStepAnalytics(
  execution: ExecutionSnapshotRecord,
  step: ExecutionSnapshotRecord["steps"][number],
  trackedStepStatuses: Set<string>,
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent,
): void {
  if (step.status !== "completed" && step.status !== "failed") {
    return;
  }

  const key = stepAnalyticsKey(execution, step);
  if (trackedStepStatuses.has(key)) {
    return;
  }
  trackedStepStatuses.add(key);

  const stepProperties = summarizeStepForAnalytics(execution, step);
  captureDesktopAnalyticsEvent("investigation_action_run", stepProperties);

  if (step.type === "shell") {
    captureDesktopAnalyticsEvent("command_run", {
      ...stepProperties,
      command_category: commandCategoryFromStep(step),
      success: step.status === "completed",
    });
  }

  if (step.type === "llm" && step.status === "completed") {
    captureDesktopAnalyticsEvent("ai_interpretation_generated", {
      ...stepProperties,
      success: true,
    });
  }
}

function trackTerminalExecutionAnalytics(
  execution: ExecutionSnapshotRecord,
  trackedTerminalExecutions: Set<string>,
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent,
): void {
  if (!isTerminalStatus(execution.status)) {
    return;
  }

  if (trackedTerminalExecutions.has(execution.executionId)) {
    return;
  }
  trackedTerminalExecutions.add(execution.executionId);

  const summary = {
    ...summarizeExecutionForAnalytics(execution),
    ...recordRunbookExecutionForAnalytics(execution.runbookId),
  };
  dispatchRunbookTerminalAnalytics(summary);

  if (execution.status === "completed") {
    captureDesktopAnalyticsEvent("runbook_run_completed", summary);
    if (summary.runbook_reused) {
      captureDesktopAnalyticsEvent("runbook_rerun", summary);
    }
    return;
  }

  if (execution.status === "cancelled") {
    captureDesktopAnalyticsEvent("runbook_run_cancelled", summary);
    return;
  }

  captureDesktopAnalyticsEvent("runbook_run_failed", summary);
}

function mirrorExecutionEvent(input: {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: ExecutionSnapshotRecord;
}): void {
  const snapshot = readLocalSnapshot();
  const results = normalizeStoredResults(snapshot.results);
  const traces = normalizeResultTraces(snapshot.resultTraces);
  const nextResults = upsertExecutionResult(results, input);

  writeLocalSnapshot({
    ...snapshot,
    results: nextResults,
    resultTraces: {
      ...traces,
      [input.resultId]: {
        ...(traces[input.resultId] ?? { execution: null }),
        execution: input.execution,
      },
    },
  });
  window.dispatchEvent(
    new CustomEvent("bitsentry:results-updated", {
      detail: { source: "execution-mirror" },
    }),
  );
}

export interface DesktopStateBootstrapProps {
  children: ReactNode;
  ipcInvoke: IpcInvoke;
  captureDesktopAnalyticsEvent?: CaptureDesktopAnalyticsEvent;
  subscribeToRunbookExecutionEvents: SubscribeToRunbookExecutionEvents;
}

function clearScheduledTimer(timerRef: RefObject<number | null>): void {
  const timer = timerRef.current;
  if (timer !== null) {
    window.clearTimeout(timer);
  }
}

export function DesktopStateBootstrap({
  children,
  ipcInvoke,
  captureDesktopAnalyticsEvent = () => {},
  subscribeToRunbookExecutionEvents,
}: DesktopStateBootstrapProps) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const hydrateInProgressRef = useRef(true);
  const runbookTimerRef = useRef<number | null>(null);
  const resultTimerRef = useRef<number | null>(null);
  const trackedExecutionTerminalRef = useRef(new Set<string>());
  const trackedStepStatusRef = useRef(new Set<string>());

  const trackExecutionAnalytics = useCallback((execution: ExecutionSnapshotRecord) => {
    for (const step of execution.steps) {
      trackStepAnalytics(
        execution,
        step,
        trackedStepStatusRef.current,
        captureDesktopAnalyticsEvent,
      );
    }
    trackTerminalExecutionAnalytics(
      execution,
      trackedExecutionTerminalRef.current,
      captureDesktopAnalyticsEvent,
    );
  }, [captureDesktopAnalyticsEvent]);

  const syncFns = useMemo(
    () => ({
      syncRunbooks: async () => {
        const snapshot = readLocalSnapshot();
        await ipcInvoke("desktopState:syncRunbooks", {
          runbooks: snapshot.runbooks,
        });
      },
      syncResults: async () => {
        const snapshot = readLocalSnapshot();
        await ipcInvoke("desktopState:syncResults", {
          results: snapshot.results,
          resultTraces: snapshot.resultTraces,
        });
      },
    }),
    [ipcInvoke],
  );

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const snapshot = await ipcInvoke<DesktopProductStateSnapshot>(
          "desktopState:bootstrap",
          readLocalSnapshot(),
        );
        if (cancelled) return;
        writeLocalSnapshot(snapshot);
      } catch (error) {
        console.error("[desktop-state] bootstrap failed:", error);
      } finally {
        hydrateInProgressRef.current = false;
        if (!cancelled) {
          setReady(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [ipcInvoke]);

  useEffect(() => {
    if (!ready) return;

    const schedule = (
      timerRef: RefObject<number | null>,
      action: () => Promise<void>,
    ) => {
      if (hydrateInProgressRef.current) return;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void action().catch((error: unknown) => {
          console.error("[desktop-state] sync failed:", error);
        });
      }, 150);
    };

    const handleRunbooksUpdated = () => {
      schedule(runbookTimerRef, syncFns.syncRunbooks);
    };
    const handleResultsUpdated = (event: Event) => {
      const { detail } = event as CustomEvent<{ source?: string }>;
      const source = detail?.source;
      if (source === "execution-mirror") {
        return;
      }
      schedule(resultTimerRef, syncFns.syncResults);
    };

    window.addEventListener(
      "bitsentry:runbooks-updated",
      handleRunbooksUpdated,
    );
    window.addEventListener("bitsentry:results-updated", handleResultsUpdated);
    const unsubscribeRunbookExecutions = subscribeToRunbookExecutionEvents(
      (event) => {
        const { resultId, executionId, incidentThreadId, execution } = event;
        trackExecutionAnalytics(execution);
        mirrorExecutionEvent({
          resultId,
          executionId,
          incidentThreadId,
          execution,
        });
      },
    );

    return () => {
      window.removeEventListener(
        "bitsentry:runbooks-updated",
        handleRunbooksUpdated,
      );
      window.removeEventListener(
        "bitsentry:results-updated",
        handleResultsUpdated,
      );
      unsubscribeRunbookExecutions();

      clearScheduledTimer(runbookTimerRef);
      clearScheduledTimer(resultTimerRef);
    };
  }, [
    ready,
    subscribeToRunbookExecutionEvents,
    syncFns,
    trackExecutionAnalytics,
  ]);

  if (!ready) {
    return (
      <div className="auth-loading">
        <p>{t("common.desktopStateBootstrap.loadingWorkspace")}</p>
      </div>
    );
  }

  return <>{children}</>;
}
