import {
  DESKTOP_RPC_CHANNEL_SET,
  type DesktopRpcChannel,
} from "./desktop-ipc-contract";

export interface DesktopIpcClientErrorShape {
  code: string;
  message: string;
  field?: string;
}

export class DesktopIpcClientError
  extends Error
  implements DesktopIpcClientErrorShape
{
  code: string;
  field?: string;

  constructor({ code, message, field }: DesktopIpcClientErrorShape) {
    super(message);
    this.name = "IpcClientError";
    this.code = code;
    this.field = field;
  }
}

interface DesktopIpcClientRuntimeOptions {
  captureDesktopAnalyticsEvent: (
    event: string,
    properties?: Record<string, unknown>,
  ) => void;
  invokeMutation: (
    channel: DesktopRpcChannel,
    payload: unknown,
  ) => Promise<unknown>;
}

export function configureDesktopIpcClientRuntime(
  options: DesktopIpcClientRuntimeOptions,
) {
  async function ipcInvoke<T>(
    channel: DesktopRpcChannel,
    payload?: unknown,
  ): Promise<T> {
    if (!DESKTOP_RPC_CHANNEL_SET.has(channel)) {
      throw new DesktopIpcClientError({
        code: "forbidden",
        message: `Blocked RPC channel: ${channel}. Not in allowlist.`,
      });
    }

    try {
      let normalizedPayload: unknown = payload;
      if (normalizedPayload === undefined) {
        normalizedPayload = {};
      }
      const startedAt = Date.now();
      const result = await options.invokeMutation(channel, normalizedPayload);
      captureDesktopIpcSuccess(
        channel,
        normalizedPayload,
        result,
        Date.now() - startedAt,
      );
      return result as T;
    } catch (error: unknown) {
      if (error instanceof DesktopIpcClientError) {
        captureDesktopIpcFailure(channel, payload, error);
        throw error;
      }

      if (isIpcErrorLike(error)) {
        const ipcError = new DesktopIpcClientError(error);
        captureDesktopIpcFailure(channel, payload, ipcError);
        throw ipcError;
      }

      if (error instanceof Error) {
        const ipcError = new DesktopIpcClientError({
          code: "ipc_error",
          message: error.message,
        });
        captureDesktopIpcFailure(channel, payload, ipcError);
        throw ipcError;
      }

      const ipcError = new DesktopIpcClientError({
        code: "unknown_error",
        message: "An unexpected error occurred",
      });
      captureDesktopIpcFailure(channel, payload, ipcError);
      throw ipcError;
    }
  }

  function captureDesktopIpcSuccess(
    channel: DesktopRpcChannel,
    payload: unknown,
    result: unknown,
    durationMs: number,
  ): void {
    if (!TRACKED_IPC_ACTION_SET.has(channel)) {
      return;
    }

    options.captureDesktopAnalyticsEvent("desktop_action_succeeded", {
      action: channel,
      duration_ms: durationMs,
      ...summarizeTelemetryShape(payload, "payload"),
      ...summarizeTelemetryShape(result, "result"),
      ...extractChannelTelemetry(channel, payload, result),
    });
  }

  function captureDesktopIpcFailure(
    channel: DesktopRpcChannel,
    payload: unknown,
    error: DesktopIpcClientError,
  ): void {
    if (!TRACKED_IPC_ACTION_SET.has(channel)) {
      return;
    }

    options.captureDesktopAnalyticsEvent("desktop_action_failed", {
      action: channel,
      error_code: error.code,
      error_field: error.field,
      ...summarizeTelemetryShape(payload, "payload"),
      ...extractChannelTelemetry(channel, payload),
    });
  }

  return {
    ipcInvoke,
  };
}

function isIpcErrorLike(error: unknown): error is DesktopIpcClientErrorShape {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as DesktopIpcClientErrorShape).code === "string" &&
    typeof (error as DesktopIpcClientErrorShape).message === "string"
  );
}

const TRACKED_IPC_ACTIONS: readonly DesktopRpcChannel[] = [
  "runbooks:create",
  "runbooks:updateMeta",
  "runbooks:saveAction",
  "runbooks:deleteAction",
  "runbooks:reorderActions",
  "runbooks:delete",
  "runbooks:execute",
  "runbooks:export",
  "runbooks:exportToFile",
  "runbooks:import",
  "runbooks:importFromFile",
  "agent:start",
  "agent:cancel",
  "agent:approveRunbookAuthoringProposal",
  "agent:rejectRunbookAuthoringProposal",
  "agent:requestRunbookAuthoringRevision",
  "errorSources:triggerSync",
  "settings:updateGeneral",
  "settings:updateSecurity",
  "settings:updateNotifications",
  "errorSources:create",
  "errorSources:update",
  "errorSources:testConnection",
  "errorSources:delete",
];

const TRACKED_IPC_ACTION_SET = new Set<DesktopRpcChannel>(TRACKED_IPC_ACTIONS);
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|prompt|content|body|text|code|script|command|stdout|stderr|input|output)/i;
const SAFE_SCALAR_KEY_PATTERN =
  /(^id$|Id$|^type$|Type$|^mode$|Mode$|^format$|Format$|^provider$|Provider$|^method$|Method$|^status$|Status$|^source$|Source$|^enabled$|Enabled$|^success$|Success$|^count$|Count$|Name$|^name$)/i;

function summarizeTelemetryShape(
  value: unknown,
  prefix: "payload" | "result",
): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }

  if (Array.isArray(value)) {
    return {
      [`${prefix}_kind`]: "array",
      [`${prefix}_count`]: value.length,
    };
  }

  if (typeof value !== "object") {
    return {
      [`${prefix}_kind`]: typeof value,
    };
  }

  const record = value as Record<string, unknown>;
  return summarizeTelemetryObject(record, prefix);
}

function summarizeTelemetryObject(
  record: Record<string, unknown>,
  prefix: "payload" | "result",
): Record<string, unknown> {
  const keys = Object.keys(record);
  const summary: Record<string, unknown> = {
    [`${prefix}_kind`]: "object",
    [`${prefix}_key_count`]: keys.length,
  };

  for (const [key, nested] of Object.entries(record)) {
    addTelemetryFieldSummary(summary, prefix, key, nested);
  }

  return summary;
}

function addTelemetryFieldSummary(
  summary: Record<string, unknown>,
  prefix: "payload" | "result",
  key: string,
  nested: unknown,
): void {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return;
  }

  const telemetryKey = `${prefix}_${toTelemetryKey(key)}`;

  if (typeof nested === "boolean") {
    summary[telemetryKey] = nested;
    return;
  }

  if (Array.isArray(nested)) {
    summary[`${telemetryKey}_count`] = nested.length;
    return;
  }

  if (!SAFE_SCALAR_KEY_PATTERN.test(key)) {
    return;
  }

  if (typeof nested === "number") {
    summary[telemetryKey] = nested;
    return;
  }

  if (typeof nested === "string") {
    summary[telemetryKey] = nested.slice(0, 80);
  }
}

function toTelemetryKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function telemetryRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function telemetryString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function telemetryBoolean(
  record: Record<string, unknown> | null,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  if (typeof value !== "boolean") {
    return undefined;
  }

  return value;
}

function telemetryNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  if (typeof value !== "number") {
    return undefined;
  }

  return value;
}

function telemetryArrayCount(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.length;
}

function telemetryObjectKeyCount(
  record: Record<string, unknown> | null,
  key: string,
): number {
  const value = telemetryRecord(record?.[key]);
  if (value === null) {
    return 0;
  }

  return Object.keys(value).length;
}

function telemetryProjectCount(
  record: Record<string, unknown> | null,
): number | undefined {
  const projectIds = telemetryArrayCount(record, "projectIds");
  const projectSlugs = telemetryArrayCount(record, "projectSlugs");
  if (projectIds === undefined && projectSlugs === undefined) {
    return undefined;
  }

  return (projectIds ?? 0) + (projectSlugs ?? 0);
}

function telemetryFieldKeys(record: Record<string, unknown> | null): string[] {
  if (record === null) {
    return [];
  }

  return Object.keys(record).sort();
}

function extractChannelTelemetry(
  channel: DesktopRpcChannel,
  payload: unknown,
  result?: unknown,
): Record<string, unknown> {
  const record = telemetryRecord(payload);
  const resultRecord = telemetryRecord(result);
  const extractor = CHANNEL_TELEMETRY_EXTRACTORS[channel];
  if (extractor === undefined) {
    return {};
  }

  return extractor(record, resultRecord, channel);
}

type ChannelTelemetryExtractor = (
  record: Record<string, unknown> | null,
  resultRecord: Record<string, unknown> | null,
  channel: DesktopRpcChannel,
) => Record<string, unknown>;

const CHANNEL_TELEMETRY_EXTRACTORS: Partial<
  Record<DesktopRpcChannel, ChannelTelemetryExtractor>
> = {
  "runbooks:updateMeta": extractRunbookUpdateMetaTelemetry,
  "runbooks:saveAction": extractRunbookSaveActionTelemetry,
  "runbooks:reorderActions": extractRunbookReorderTelemetry,
  "runbooks:execute": extractRunbookExecuteTelemetry,
  "runbooks:export": extractRunbookExportTelemetry,
  "runbooks:exportToFile": extractRunbookExportTelemetry,
  "runbooks:import": extractRunbookImportTelemetry,
  "runbooks:importFromFile": extractRunbookImportTelemetry,
  "settings:updateGeneral": extractSettingsTelemetry,
  "settings:updateSecurity": extractSettingsTelemetry,
  "settings:updateNotifications": extractSettingsTelemetry,
  "errorSources:create": extractErrorSourceCreateTelemetry,
  "errorSources:update": extractErrorSourceUpdateTelemetry,
  "errorSources:testConnection": extractErrorSourceIdTelemetry,
  "errorSources:delete": extractErrorSourceIdTelemetry,
};

function extractRunbookUpdateMetaTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields = listKeys(record, ["title", "description", "idleTimeout"]);
  return {
    runbook_field_count: fields.length,
    runbook_fields: fields.join(","),
  };
}

function extractRunbookSaveActionTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  const action = telemetryRecord(record?.action);
  const parameterCount = telemetryArrayCount(action, "parameters");
  return {
    runbook_action_type: telemetryString(action, "type"),
    runbook_action_method: telemetryString(action, "method"),
    runbook_action_provider: telemetryString(action, "llmProviderKey"),
    runbook_action_source_connected:
      telemetryString(action, "sourceId") !== undefined,
    runbook_action_parameter_count: parameterCount,
    runbook_action_has_log_filter: action?.logFilter !== undefined,
  };
}

function extractRunbookReorderTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    runbook_action_count: telemetryArrayCount(record, "actionIdsInOrder"),
  };
}

function extractRunbookExecuteTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  const trigger = telemetryRecord(record?.triggerContext);
  return {
    runtime_parameter_count: telemetryObjectKeyCount(record, "parameterValues"),
    runbook_entrypoint: telemetryString(trigger, "entrypoint"),
  };
}

function extractRunbookExportTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    runbook_count: telemetryArrayCount(record, "ids"),
    include_globals: telemetryBoolean(record, "includeGlobals"),
  };
}

function extractRunbookImportTelemetry(
  record: Record<string, unknown> | null,
  resultRecord: Record<string, unknown> | null,
): Record<string, unknown> {
  const options = telemetryRecord(record?.options);
  return {
    import_conflict_policy: telemetryString(options, "conflictPolicy"),
    import_dry_run: telemetryBoolean(options, "dryRun"),
    include_globals: telemetryBoolean(options, "includeGlobals"),
    imported_runbook_count: telemetryNumber(resultRecord, "importedRunbooks"),
  };
}

function extractSettingsTelemetry(
  record: Record<string, unknown> | null,
  _resultRecord: Record<string, unknown> | null,
  channel: DesktopRpcChannel,
): Record<string, unknown> {
  const data = telemetryRecord(record?.data);
  const fields = telemetryFieldKeys(data);
  return {
    settings_domain: channel.replace("settings:update", "").toLowerCase(),
    settings_field_count: fields.length,
    settings_fields: fields.slice(0, 12).join(","),
  };
}

function extractErrorSourceCreateTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    error_source_operation: "create",
    error_source_type: telemetryString(record, "sourceType"),
    error_source_project_count: telemetryProjectCount(record),
    error_source_sync_enabled: telemetryBoolean(record, "syncEnabled"),
    error_source_auto_diagnosis: telemetryBoolean(
      record,
      "autoDiagnosisEnabled",
    ),
  };
}

function extractErrorSourceUpdateTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    error_source_operation: "update",
    error_source_project_count: telemetryProjectCount(record),
    error_source_sync_enabled: telemetryBoolean(record, "syncEnabled"),
    error_source_auto_diagnosis: telemetryBoolean(
      record,
      "autoDiagnosisEnabled",
    ),
  };
}

function extractErrorSourceIdTelemetry(
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    error_source_id_present: typeof record?.id === "string",
  };
}

function listKeys(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (record === null) {
    return [];
  }

  return keys.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
}
