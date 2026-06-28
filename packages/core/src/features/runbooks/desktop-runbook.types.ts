import type {
  LogFilterConfig,
} from "./runbooks.schemas";
import type { RunbookExportArtifactV1 } from "./export.schemas";

import type { ErrorSourceType } from "../error-sources/desktop-error-sources.types";

export type RunbookActionType =
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
export type LegacyRunbookActionType = RunbookActionType | "ai";
export type RunbookHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RunbookLlmProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor";

export interface RunbookHttpHeader {
  key: string;
  value: string;
}

export interface RunbookActionParameter {
  id: string;
  key: string;
  label?: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  secure?: boolean;
}

export type RunbookParameterValues = Record<string, string>;

export interface RunbookActionRecord<TTelemetryActionConfig = unknown> {
  id: string;
  type: RunbookActionType;
  title: string;
  command?: string;
  prompt?: string;
  llmProviderKey?: RunbookLlmProviderKey;
  llmModel?: string;
  url?: string;
  method?: RunbookHttpMethod;
  headers?: RunbookHttpHeader[];
  body?: string;
  pluginId?: string;
  pluginActionId?: string;
  pluginInput?: string;
  pluginAuth?: string;
  query?: string;
  sourceId?: string;
  parameters?: RunbookActionParameter[];
  logFilter?: LogFilterConfig;
  telemetryConfig?: TTelemetryActionConfig;
}

export interface RunbookRecord<TTelemetryActionConfig = unknown> {
  id: string;
  title: string;
  description: string;
  idleTimeout?: number;
  revisionNumber: number;
  actions: RunbookActionRecord<TTelemetryActionConfig>[];
  createdAt: string;
  updatedAt: string;
}

export type DesktopExportedRunbookV1 =
  RunbookExportArtifactV1["runbooks"][number] & {
    idleTimeout?: number;
  };

export type DesktopRunbookExportArtifactV1 = Omit<
  RunbookExportArtifactV1,
  "runbooks"
> & {
  runbooks: DesktopExportedRunbookV1[];
};

export interface RunbookContextV1<TTelemetryActionConfig = unknown> {
  format: "bitsentry.runbook.context";
  version: 1;
  runbook: {
    id: string;
    title: string;
    description: string;
    revisionNumber: number;
    updatedAt: string;
    actionCount: number;
  };
  summary: {
    purposeText: string;
    actionTypeCounts: Record<RunbookActionType, number>;
    orderedActionTitles: string[];
  };
  globalReferences?: Array<{
    key: string;
    secure?: boolean;
    description?: string;
  }>;
  actions: Array<{
    id: string;
    order: number;
    type: RunbookActionType;
    title: string;
    payload: {
      command?: string;
      prompt?: string;
      llmProviderKey?: RunbookLlmProviderKey;
      llmModel?: string;
      url?: string;
      method?: RunbookHttpMethod;
      headers?: RunbookHttpHeader[];
      body?: string;
      pluginId?: string;
      pluginActionId?: string;
      pluginInput?: string;
      pluginAuth?: string;
      query?: string;
      sourceId?: string;
      parameters?: RunbookActionParameter[];
      logFilter?: LogFilterConfig;
      telemetryConfig?: TTelemetryActionConfig;
    };
  }>;
}

export type RunbookExecutionStatus =
  | "queued"
  | "pending"
  | "running"
  | "claim_expired"
  | "completed"
  | "failed"
  | "cancelled";
export type RunbookExecutionCompletionReason =
  | "success"
  | "step_failed"
  | "user_cancelled"
  | "idle_timeout"
  | "app_shutdown"
  | "lease_expired";
export type RunbookExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type RunbookExecutionSource = "manual" | "agent";
export type RunbookTriggerSurface =
  | "runbooks"
  | "incident_detail"
  | "incident_workspace"
  | "diagnosis";

export interface RunbookTriggerContext {
  entrypoint: RunbookTriggerSurface;
  needId?: string;
  needLabel?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: ErrorSourceType;
  incidentThreadId?: string;
}

export interface RunbookExecutionStepRecord {
  actionId: string;
  order: number;
  type: RunbookActionType;
  title: string;
  status: RunbookExecutionStepStatus;
  input?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  statusCode?: number;
  streamDeltas?: Array<{
    timestamp: string;
    text: string;
    kind?: "text" | "command_output";
  }>;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

export interface RunbookExecutionRecord {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string;
  runbookTitle: string;
  status: RunbookExecutionStatus;
  snapshotVersion?: number;
  startedAt: string;
  completedAt?: string;
  completionReason?: RunbookExecutionCompletionReason;
  idleTimeoutMinutes?: number;
  lastActivityAt?: string;
  parameterValues?: RunbookParameterValues;
  source: RunbookExecutionSource;
  triggerContext?: RunbookTriggerContext;
  steps: RunbookExecutionStepRecord[];
}

export const DEFAULT_RUNBOOK_IDLE_TIMEOUT_MINUTES = 30;
export const MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES = 1440;
const RUNBOOK_TIME_WINDOW_PARAMETER_KEYS = new Set(["since", "until"]);
const ISO_LIKE_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

function parseNumericRunbookIdleTimeout(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }

  return Number.NaN;
}

export function normalizeRunbookIdleTimeout(
  value: unknown,
): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }

  const parsed = parseNumericRunbookIdleTimeout(value);

  if (
    Number.isInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES
  ) {
    return parsed;
  }

  return undefined;
}

export function parseRunbookIdleTimeoutForUpdate(
  value: unknown,
): number | undefined {
  const parsed = normalizeRunbookIdleTimeout(value);
  if (parsed == null && value != null && value !== "") {
    throw new Error(
      `Runbook idle timeout must be an integer from 0 to ${String(MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES)} minutes`,
    );
  }
  return parsed;
}

function padUtcComponent(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcRunbookTimestamp(value: Date): string {
  return `${String(value.getUTCFullYear())}-${padUtcComponent(value.getUTCMonth() + 1)}-${padUtcComponent(value.getUTCDate())} ${padUtcComponent(value.getUTCHours())}:${padUtcComponent(value.getUTCMinutes())}:${padUtcComponent(value.getUTCSeconds())} UTC`;
}

function preserveOriginalWhenTrimmedEmpty(
  trimmedValue: string,
  originalValue: string,
): string {
  if (trimmedValue.length > 0) {
    return trimmedValue;
  }

  return originalValue;
}

function normalizeIsoLikeTimestamp(trimmedValue: string): string {
  const match = trimmedValue.match(ISO_LIKE_TIMESTAMP_PATTERN);
  if (match === null) {
    return trimmedValue;
  }

  const datePart = match[1];
  const timePart = match[2];
  const timezonePart = match[3];
  if (datePart === undefined || timePart === undefined) {
    return trimmedValue;
  }

  if (timezonePart === undefined) {
    return `${datePart} ${timePart}`;
  }

  if (timezonePart === "Z") {
    return `${datePart} ${timePart} UTC`;
  }

  const parsed = new Date(trimmedValue);
  if (Number.isNaN(parsed.getTime())) {
    return trimmedValue;
  }

  return formatUtcRunbookTimestamp(parsed);
}

function normalizeTimeWindowParameterValue(key: string, value: string): string {
  if (!RUNBOOK_TIME_WINDOW_PARAMETER_KEYS.has(key.trim().toLowerCase())) {
    return value;
  }

  const trimmedValue = value.trim();
  if (!ISO_LIKE_TIMESTAMP_PATTERN.test(trimmedValue)) {
    return preserveOriginalWhenTrimmedEmpty(trimmedValue, value);
  }

  return normalizeIsoLikeTimestamp(trimmedValue);
}

function normalizedRunbookParameterEntries(
  parameterValues: RunbookParameterValues,
  normalizeValue: (key: string, value: string) => string,
): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(parameterValues)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length > 0) {
      entries.push([normalizedKey, normalizeValue(normalizedKey, value)]);
    }
  }

  return entries;
}

export function normalizeRunbookParameterValues(
  parameterValues: RunbookParameterValues | undefined,
): RunbookParameterValues {
  if (parameterValues === undefined) {
    return {};
  }

  return Object.fromEntries(
    normalizedRunbookParameterEntries(parameterValues, (_key, value) => value),
  );
}

export function normalizeJournalTimeWindowParameterValues(
  parameterValues: RunbookParameterValues | undefined,
): RunbookParameterValues {
  if (parameterValues === undefined) {
    return {};
  }

  return Object.fromEntries(
    normalizedRunbookParameterEntries(
      parameterValues,
      normalizeTimeWindowParameterValue,
    ),
  );
}

const RUNBOOK_EXECUTION_SOURCE_VALUES = [
  "manual",
  "agent",
] as const satisfies readonly RunbookExecutionSource[];
const RUNBOOK_EXECUTION_SOURCES = new Set<string>(
  RUNBOOK_EXECUTION_SOURCE_VALUES,
);
const RUNBOOK_TRIGGER_SURFACE_VALUES = [
  "runbooks",
  "incident_detail",
  "incident_workspace",
  "diagnosis",
] as const satisfies readonly RunbookTriggerSurface[];
const RUNBOOK_TRIGGER_SURFACES = new Set<string>(
  RUNBOOK_TRIGGER_SURFACE_VALUES,
);
const RUNBOOK_TRIGGER_CONTEXT_STRING_FIELDS = [
  "needId",
  "needLabel",
  "sourceId",
  "sourceName",
  "incidentThreadId",
] as const satisfies readonly (keyof RunbookTriggerContext)[];
const RUNBOOK_TRIGGER_SOURCE_TYPE_VALUES = [
  "sentry",
  "wazuh",
  "posthog",
] as const satisfies readonly NonNullable<RunbookTriggerContext["sourceType"]>[];
const RUNBOOK_TRIGGER_SOURCE_TYPES = new Set<string>(
  RUNBOOK_TRIGGER_SOURCE_TYPE_VALUES,
);

function isRunbookExecutionSource(
  value: string,
): value is RunbookExecutionSource {
  for (const source of RUNBOOK_EXECUTION_SOURCE_VALUES) {
    if (source === value) {
      return true;
    }
  }

  return false;
}

function isRunbookTriggerSurface(
  value: string,
): value is RunbookTriggerSurface {
  for (const surface of RUNBOOK_TRIGGER_SURFACE_VALUES) {
    if (surface === value) {
      return true;
    }
  }

  return false;
}

function isRunbookTriggerSourceType(
  value: string,
): value is NonNullable<RunbookTriggerContext["sourceType"]> {
  for (const sourceType of RUNBOOK_TRIGGER_SOURCE_TYPE_VALUES) {
    if (sourceType === value) {
      return true;
    }
  }

  return false;
}

function asRunbookObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function parseRunbookTriggerSurface(
  value: unknown,
): RunbookTriggerSurface | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (isRunbookTriggerSurface(value)) {
    return value;
  }

  return undefined;
}

function addRunbookTriggerStringFields(
  context: RunbookTriggerContext,
  input: Record<string, unknown>,
): void {
  for (const key of RUNBOOK_TRIGGER_CONTEXT_STRING_FIELDS) {
    const value = input[key];
    if (typeof value === "string") {
      context[key] = value;
    }
  }
}

function parseRunbookTriggerSourceType(
  value: unknown,
): RunbookTriggerContext["sourceType"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (isRunbookTriggerSourceType(value)) {
    return value;
  }

  return undefined;
}

export function parseRunbookExecutionSource(
  value: unknown,
): RunbookExecutionSource | null {
  if (typeof value !== "string") {
    return null;
  }

  if (isRunbookExecutionSource(value)) {
    return value;
  }

  return null;
}

export function normalizeRunbookTriggerContext(
  value: unknown,
): RunbookTriggerContext | undefined {
  const input = asRunbookObject(value);
  if (input === undefined) {
    return undefined;
  }

  const entrypoint = parseRunbookTriggerSurface(input.entrypoint);
  if (entrypoint === undefined) {
    return undefined;
  }

  const context: RunbookTriggerContext = { entrypoint };
  addRunbookTriggerStringFields(context, input);
  const sourceType = parseRunbookTriggerSourceType(input.sourceType);
  if (sourceType !== undefined) {
    context.sourceType = sourceType;
  }

  return context;
}

const RUNBOOK_ACTION_TYPE_VALUES = [
  "shell",
  "llm",
  "http",
  "plugin",
  "external_source",
  "telemetry_existing_entry",
  "data_source_query",
  "telemetry_ingest",
  "diagnosis_diagnose",
  "diagnosis_verify",
  "diagnosis_recommend",
] as const satisfies readonly RunbookActionType[];
const RUNBOOK_ACTION_TYPES = new Set<string>(RUNBOOK_ACTION_TYPE_VALUES);

function isRunbookActionType(value: string): value is RunbookActionType {
  for (const actionType of RUNBOOK_ACTION_TYPE_VALUES) {
    if (actionType === value) {
      return true;
    }
  }

  return false;
}

function parseRunbookActionType(
  value: string,
): RunbookActionType | undefined {
  if (isRunbookActionType(value)) {
    return value;
  }

  return undefined;
}

export function normalizeRunbookActionType(
  value: unknown,
  fallback: RunbookActionType = "shell",
): RunbookActionType {
  if (typeof value !== "string") {
    return fallback;
  }

  const raw = value.trim().toLowerCase();
  if (raw === "ai") return "llm";
  const parsed = parseRunbookActionType(raw);
  if (parsed !== undefined) {
    return parsed;
  }

  return fallback;
}
