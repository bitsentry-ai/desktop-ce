import { randomUUID } from "crypto";
import {
  SqliteErrorSourcesRepositoryAdapter,
  type ErrorSourceDatabase,
} from "../error-sources/desktop-sqlite-error-sources.adapter";
import {
  normalizeRunbookIdleTimeout,
  normalizeRunbookActionType,
  parseRunbookIdleTimeoutForUpdate,
  type DesktopRunbookExportArtifactV1,
  type RunbookActionRecord,
  type RunbookActionParameter,
  type RunbookActionType,
  type RunbookContextV1,
  type RunbookHttpHeader,
  type RunbookHttpMethod,
  type RunbookLlmProviderKey,
  type RunbookRecord,
} from "./desktop-runbook.types";
import {
  collectRunbookGlobalReferences,
  createImportedRunbookTitle,
  normalizeRunbookImportOptions,
} from "./import-export";
import {
  type RunbookImportOptions,
  type RunbookImportSummary,
} from "./export.schemas";
import {
  logFilterConfigSchema,
  runbookHttpMethodSchema,
  runbookLlmProviderKeySchema,
  runbookTriggerSurfaceSchema,
  telemetryQueryModeSchema,
  type TelemetryActionConfigWithCli as TelemetryActionConfig,
  type LogFilterConfig,
} from "./runbooks.schemas";
import { errorSourceTypeSchema } from "../error-sources/error-sources.schemas";
import type {
  GlobalVariable,
  GlobalVariableInput,
} from "./globals.schemas";

type DesktopRunbookActionRecord = RunbookActionRecord<TelemetryActionConfig>;
type DesktopRunbookRecord = RunbookRecord<TelemetryActionConfig>;
type DesktopRunbookContext = RunbookContextV1<TelemetryActionConfig>;

export interface DesktopRunbookStoreDatabase extends ErrorSourceDatabase {
  runbook: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    update(args: unknown): Promise<Record<string, unknown>>;
    updateMany(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  runbookAction: {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
    deleteMany(args: unknown): Promise<unknown>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  $executeRawUnsafe(query: string): Promise<unknown>;
}

export interface DesktopRunbookStoreGlobalVariablesService {
  list(): Promise<GlobalVariable[]>;
  create(input: GlobalVariableInput): Promise<GlobalVariable>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function serializeOptionalJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

function warningsForResult(warnings: Set<string>): string[] | undefined {
  if (warnings.size === 0) {
    return undefined;
  }

  return [...warnings];
}

function normalizeImportedFingerprintLlmProviderKey(
  providerKey: RunbookLlmProviderKey | undefined,
): RunbookLlmProviderKey | undefined {
  if (providerKey === "claude_code" || providerKey === "codex") {
    return undefined;
  }

  return providerKey;
}

function sourceIdFromArtifactRef(
  sourceRef: string | undefined,
  sourceIdByRef: Map<string, string>,
): string | undefined {
  if (sourceRef === undefined || sourceRef.length === 0) {
    return undefined;
  }

  return sourceIdByRef.get(sourceRef);
}

function sanitizeExportedErrorSourceConfiguration(
  value: unknown,
): Record<string, unknown> {
  const configuration = asObject(value);
  const sanitized = { ...configuration };
  delete sanitized.oauthClientSecret;
  return sanitized;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(asObject(value))
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
      );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((item) => asString(item).trim())
        .filter((item) => item.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeFingerprintBaseUrl(value: unknown): string | undefined {
  const raw = asString(value).trim();
  if (raw.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin.toLowerCase()}${pathname}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function normalizeFingerprintSlug(value: unknown): string | undefined {
  const raw = asString(value).trim();
  if (raw.length === 0) {
    return undefined;
  }

  return raw.toLowerCase();
}

function toArtifactRefSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildArtifactSourceRefs(
  sourcesById: Map<
    string,
    Awaited<ReturnType<SqliteErrorSourcesRepositoryAdapter["findById"]>>
  >,
): Map<string, string> {
  const usedRefs = new Set<string>();
  const refsById = new Map<string, string>();
  let unnamedIndex = 1;

  for (const source of sourcesById.values()) {
    if (source === null) {
      continue;
    }

    let baseRef = toArtifactRefSlug(source.name);
    if (baseRef.length === 0) {
      baseRef = `external-source-${String(unnamedIndex)}`;
    }
    let nextRef = baseRef;
    let suffix = 2;
    while (usedRefs.has(nextRef)) {
      nextRef = `${baseRef}-${String(suffix)}`;
      suffix += 1;
    }

    usedRefs.add(nextRef);
    refsById.set(source.id, nextRef);
    unnamedIndex += 1;
  }

  return refsById;
}

function buildExternalSourceFingerprint(
  sourceType: string,
  configuration: unknown,
): string {
  const config = sanitizeExportedErrorSourceConfiguration(configuration);

  switch (sourceType) {
    case "sentry":
      return `sentry::${stableSerialize({
        orgSlug: normalizeFingerprintSlug(config.orgSlug),
        sentryBaseUrl: normalizeFingerprintBaseUrl(config.sentryBaseUrl),
        projectIds: normalizeStringArray(config.projectIds),
        projectSlugs: normalizeStringArray(config.projectSlugs),
      })}`;
    case "posthog":
      return `posthog::${stableSerialize({
        orgSlug: normalizeFingerprintSlug(config.orgSlug),
        posthogBaseUrl: normalizeFingerprintBaseUrl(config.posthogBaseUrl),
        projectIds: normalizeStringArray(config.projectIds),
      })}`;
    case "wazuh":
      return `wazuh::${stableSerialize({
        baseUrl: normalizeFingerprintBaseUrl(config.baseUrl),
        indexPatterns: normalizeStringArray(config.indexPatterns),
      })}`;
    default:
      return `${sourceType}::${stableSerialize(config)}`;
  }
}

function requiresExternalSourceAuthToken(sourceType: string): boolean {
  return sourceType === "sentry" || sourceType === "posthog";
}

function normalizeExportedExternalSourceCredentials(value: unknown): {
  authToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  grantedScopes?: string[];
} {
  const credentials = asObject(value);
  const authToken = asString(credentials.authToken).trim();
  const refreshToken = asString(credentials.refreshToken).trim();
  const grantedScopes = normalizeStringArray(credentials.grantedScopes);

  const exportedCredentials: {
    authToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    grantedScopes?: string[];
  } = {};

  if (authToken.length > 0) {
    exportedCredentials.authToken = authToken;
  }

  if (refreshToken.length > 0) {
    exportedCredentials.refreshToken = refreshToken;
  }

  if (typeof credentials.expiresAt === "string") {
    const expiresAt = credentials.expiresAt.trim();
    if (expiresAt.length > 0) {
      exportedCredentials.expiresAt = expiresAt;
    }
  }

  if (grantedScopes.length > 0) {
    exportedCredentials.grantedScopes = grantedScopes;
  }

  return exportedCredentials;
}

function collectReferencedArtifactSourceRefs(
  runbooks: DesktopRunbookExportArtifactV1["runbooks"],
): string[] {
  return [
    ...new Set(
      runbooks.flatMap((runbook) =>
        runbook.actions.flatMap((action) => {
          if (action.type !== "external_source") {
            return [];
          }

          const sourceRef = action.sourceRef?.trim();
          if (sourceRef === undefined || sourceRef.length === 0) {
            return [];
          }

          return [sourceRef];
        }),
      ),
    ),
  ];
}

function normalizeRunbookParameterFingerprint(
  value: unknown,
): Array<Record<string, unknown>> | undefined {
  const parameters = normalizeRunbookParameters(value);
  if (parameters === undefined || parameters.length === 0) {
    return undefined;
  }

  return parameters.map((parameter) => {
    const normalizedParameter: Record<string, unknown> = {
      key: parameter.key,
    };

    if (typeof parameter.defaultValue === "string") {
      normalizedParameter.defaultValue = parameter.defaultValue;
    }

    if (typeof parameter.required === "boolean") {
      normalizedParameter.required = parameter.required;
    }

    if (parameter.secure === true) {
      normalizedParameter.secure = true;
    }

    return normalizedParameter;
  });
}

function normalizeRunbookActionFingerprint(
  action: {
    type: RunbookActionType;
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
    sourceRef?: string;
    parameters?: RunbookActionParameter[];
    logFilter?: LogFilterConfig;
    telemetryConfig?: TelemetryActionConfig;
    title?: string;
  },
  resolveSourceFingerprint: (sourceId: string) => string | undefined,
): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    type: action.type,
  };

  if (action.logFilter !== undefined) {
    shared.logFilter = action.logFilter;
  }

  if (action.parameters !== undefined && action.parameters.length > 0) {
    shared.parameters = normalizeRunbookParameterFingerprint(action.parameters);
  }

  switch (action.type) {
    case "shell": {
      return {
        ...shared,
        command: action.command ?? "",
      };
    }
    case "llm": {
      const fingerprint: Record<string, unknown> = {
        ...shared,
        prompt: action.prompt ?? "",
      };

      if (action.llmProviderKey !== undefined) {
        fingerprint.llmProviderKey = action.llmProviderKey;
      }

      if (action.llmModel !== undefined && action.llmModel.length > 0) {
        fingerprint.llmModel = action.llmModel;
      }

      return fingerprint;
    }
    case "http": {
      const fingerprint: Record<string, unknown> = {
        ...shared,
        method: action.method ?? "GET",
        url: action.url ?? "",
      };

      if (typeof action.body === "string") {
        fingerprint.body = action.body;
      }

      if (action.headers !== undefined && action.headers.length > 0) {
        fingerprint.headers = action.headers;
      }

      return fingerprint;
    }
    case "plugin": {
      return {
        ...shared,
        pluginId: action.pluginId ?? "",
        pluginActionId: action.pluginActionId ?? "",
        pluginAuth: action.pluginAuth ?? "",
        pluginInput: action.pluginInput ?? "",
      };
    }
    case "external_source": {
      const sourceId = action.sourceId?.trim();
      const sourceRef = action.sourceRef?.trim();
      if (sourceId === undefined || sourceId.length === 0) {
        if (sourceRef === undefined || sourceRef.length === 0) {
          throw new Error(
            `External Source action "${action.title ?? "Untitled action"}" is missing a selected source`,
          );
        }

        return {
          ...shared,
          query: action.query ?? "",
          sourceFingerprint: `unresolved:${sourceRef}`,
        };
      }

      const sourceFingerprint = resolveSourceFingerprint(sourceId);
      if (sourceFingerprint === undefined || sourceFingerprint.length === 0) {
        throw new Error(
          `External Source action "${action.title ?? "Untitled action"}" could not resolve a matching data source`,
        );
      }

      return {
        ...shared,
        query: action.query ?? "",
        sourceFingerprint,
      };
    }
    case "telemetry_existing_entry":
    case "data_source_query":
    case "telemetry_ingest":
    case "diagnosis_diagnose":
    case "diagnosis_verify":
    case "diagnosis_recommend": {
      const fingerprint = {
        ...shared,
      };
      if (typeof action.body === "string") {
        fingerprint.body = action.body;
      }
      if (typeof action.query === "string") {
        fingerprint.query = action.query;
      }
      if (action.telemetryConfig !== undefined) {
        fingerprint.telemetryConfig = action.telemetryConfig;
      }
      return fingerprint;
    }
    default:
      throw new Error(
        `Unsupported runbook action type: ${String(action.type)}`,
      );
  }
}

function buildRunbookFingerprint(
  actions: Array<{
    type: RunbookActionType;
    command?: string;
    prompt?: string;
    llmProviderKey?: RunbookLlmProviderKey;
    llmModel?: string;
    url?: string;
    method?: RunbookHttpMethod;
    headers?: RunbookHttpHeader[];
    body?: string;
    query?: string;
    sourceId?: string;
    parameters?: RunbookActionParameter[];
    logFilter?: LogFilterConfig;
    telemetryConfig?: TelemetryActionConfig;
    title?: string;
  }>,
  resolveSourceFingerprint: (sourceId: string) => string | undefined,
): string {
  return stableSerialize(
    actions.map((action) =>
      normalizeRunbookActionFingerprint(action, resolveSourceFingerprint),
    ),
  );
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function normalizeRunbookHeaders(
  value: unknown,
): RunbookHttpHeader[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const headers = value
    .map((item) => {
      const header = asObject(item);
      const key = asString(header.key).trim();
      if (key.length === 0) return null;

      return {
        key,
        value: asString(header.value),
      };
    })
    .filter((item): item is RunbookHttpHeader => item !== null);

  if (headers.length === 0) {
    return undefined;
  }

  return headers;
}

function parseRunbookHeaders(value: unknown): RunbookHttpHeader[] | undefined {
  if (Array.isArray(value)) {
    return normalizeRunbookHeaders(value);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return normalizeRunbookHeaders(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeRunbookParameters(
  value: unknown,
): RunbookActionParameter[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const parameters = value.flatMap((item): RunbookActionParameter[] => {
    const parameter = asObject(item);
    const key = asString(parameter.key).trim();
    if (key.length === 0) return [];

    let label = asString(parameter.label, key).trim();
    if (label.length === 0) {
      label = key;
    }
    const secure = parameter.secure === true;
    const normalizedParameter: RunbookActionParameter = {
      id: asString(parameter.id, key),
      key,
      label,
    };

    if (typeof parameter.description === "string") {
      normalizedParameter.description = parameter.description;
    }

    if (typeof parameter.defaultValue === "string" && !secure) {
      normalizedParameter.defaultValue = parameter.defaultValue;
    }

    if (typeof parameter.required === "boolean") {
      normalizedParameter.required = parameter.required;
    }

    if (secure) {
      normalizedParameter.secure = true;
    }

    return [normalizedParameter];
  });

  if (parameters.length === 0) {
    return undefined;
  }

  return parameters;
}

function parseRunbookParameters(
  value: unknown,
): RunbookActionParameter[] | undefined {
  if (Array.isArray(value)) {
    return normalizeRunbookParameters(value);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return normalizeRunbookParameters(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeRunbookLogFilter(
  value: unknown,
): LogFilterConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const parsed = logFilterConfigSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}

function parseRunbookLogFilter(value: unknown): LogFilterConfig | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return normalizeRunbookLogFilter(value);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return normalizeRunbookLogFilter(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseRunbookLlmProviderKey(value: unknown): RunbookLlmProviderKey | undefined {
  const parsed = runbookLlmProviderKeySchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}

function parseRunbookHttpMethod(value: unknown): RunbookHttpMethod | undefined {
  const parsed = runbookHttpMethodSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data;
}

function isTelemetryActionType(type: RunbookActionType): boolean {
  return (
    type === "telemetry_existing_entry" ||
    type === "data_source_query" ||
    type === "telemetry_ingest" ||
    type === "diagnosis_diagnose" ||
    type === "diagnosis_verify" ||
    type === "diagnosis_recommend"
  );
}

const TELEMETRY_LLM_PROVIDER_KEYS = new Set<
  NonNullable<TelemetryActionConfig["llmProviderKey"]>
>(["groq", "kilocode", "openai", "anthropic", "gemini", "openrouter"]);

function isTelemetryLlmProviderKey(
  value: unknown,
): value is NonNullable<TelemetryActionConfig["llmProviderKey"]> {
  return (
    typeof value === "string" &&
    TELEMETRY_LLM_PROVIDER_KEYS.has(
      value as NonNullable<TelemetryActionConfig["llmProviderKey"]>,
    )
  );
}

function normalizePositiveIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((item) => {
    if (!Number.isInteger(item)) {
      return [];
    }

    const numericItem = Number(item);
    if (numericItem <= 0) {
      return [];
    }

    return [numericItem];
  });

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function normalizeTelemetryConfig(
  value: unknown,
): TelemetryActionConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const config = asObject(value);
  const normalized: TelemetryActionConfig = {};

  if (typeof config.needId === "string") {
    normalized.needId = config.needId;
  }
  if (typeof config.needLabel === "string") {
    normalized.needLabel = config.needLabel;
  }
  if (typeof config.sourceId === "string") {
    normalized.sourceId = config.sourceId;
  }
  const sourceType = errorSourceTypeSchema.safeParse(config.sourceType);
  if (sourceType.success) {
    normalized.sourceType = sourceType.data;
  }
  if (typeof config.sourceName === "string") {
    normalized.sourceName = config.sourceName;
  }
  const queryMode = telemetryQueryModeSchema.safeParse(config.queryMode);
  if (queryMode.success) {
    normalized.queryMode = queryMode.data;
  }
  if (Number.isInteger(config.queryLimit)) {
    normalized.queryLimit = Number(config.queryLimit);
  }
  if (typeof config.queryText === "string") {
    normalized.queryText = config.queryText;
  }
  if (typeof config.collectionDate === "string") {
    normalized.collectionDate = config.collectionDate;
  }
  if (typeof config.include === "string") {
    normalized.include = config.include;
  }
  if (typeof config.exclude === "string") {
    normalized.exclude = config.exclude;
  }
  if (typeof config.indexPattern === "string") {
    normalized.indexPattern = config.indexPattern;
  }

  const telemetryEntryIds = normalizePositiveIntegerArray(config.telemetryEntryIds);
  if (telemetryEntryIds !== undefined) {
    normalized.telemetryEntryIds = telemetryEntryIds;
  }
  const diagnosisEntryIds = normalizePositiveIntegerArray(config.diagnosisEntryIds);
  if (diagnosisEntryIds !== undefined) {
    normalized.diagnosisEntryIds = diagnosisEntryIds;
  }
  if (isTelemetryLlmProviderKey(config.llmProviderKey)) {
    normalized.llmProviderKey = config.llmProviderKey;
  }
  if (typeof config.llmModel === "string") {
    normalized.llmModel = config.llmModel;
  }
  const entrypoint = runbookTriggerSurfaceSchema.safeParse(config.entrypoint);
  if (entrypoint.success) {
    normalized.entrypoint = entrypoint.data;
  }

  return normalized;
}

function parseTelemetryConfig(
  type: RunbookActionType,
  value: unknown,
): TelemetryActionConfig | undefined {
  if (!isTelemetryActionType(type)) {
    return undefined;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return normalizeTelemetryConfig(value);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return normalizeTelemetryConfig(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function serializeRunbookActionBody(
  action: DesktopRunbookActionRecord,
): string | null {
  if (action.type === "plugin") {
    return action.pluginInput ?? null;
  }

  if (isTelemetryActionType(action.type)) {
    if (action.telemetryConfig !== undefined) {
      return JSON.stringify(action.telemetryConfig);
    }

    return action.body ?? null;
  }

  return action.body ?? null;
}

function serializeStoredRunbookActionUrl(
  action: DesktopRunbookActionRecord,
): string | null {
  if (action.type === "plugin") {
    return action.pluginAuth ?? null;
  }

  return action.url ?? null;
}

function serializeStoredRunbookActionQuery(
  action: DesktopRunbookActionRecord,
): string | null {
  if (action.type === "plugin") {
    return action.pluginActionId ?? null;
  }

  return action.query ?? null;
}

function serializeStoredRunbookActionSourceId(
  action: DesktopRunbookActionRecord,
): string | null {
  if (action.type === "plugin") {
    return action.pluginId ?? null;
  }

  return action.sourceId ?? null;
}

function createEmptyActionTypeCounts(): DesktopRunbookContext["summary"]["actionTypeCounts"] {
  return {
    shell: 0,
    llm: 0,
    http: 0,
    plugin: 0,
    external_source: 0,
    telemetry_existing_entry: 0,
    data_source_query: 0,
    telemetry_ingest: 0,
    diagnosis_diagnose: 0,
    diagnosis_verify: 0,
    diagnosis_recommend: 0,
  };
}

function copySharedRunbookActionFields(
  target: DesktopRunbookActionRecord,
  action: DesktopRunbookActionRecord,
): void {
  if (action.parameters !== undefined && action.parameters.length > 0) {
    target.parameters = action.parameters;
  }

  if (action.logFilter !== undefined) {
    target.logFilter = action.logFilter;
  }
}

function sanitizeRunbookAction(
  action: DesktopRunbookActionRecord,
): DesktopRunbookActionRecord {
  const sanitized: DesktopRunbookActionRecord = {
    id: action.id,
    type: action.type,
    title: action.title,
  };
  copySharedRunbookActionFields(sanitized, action);

  switch (action.type) {
    case "shell": {
      if (typeof action.command === "string") {
        sanitized.command = action.command;
      }
      return sanitized;
    }
    case "llm": {
      if (typeof action.prompt === "string") {
        sanitized.prompt = action.prompt;
      }
      if (typeof action.llmProviderKey === "string") {
        sanitized.llmProviderKey = action.llmProviderKey;
      }
      if (typeof action.llmModel === "string") {
        sanitized.llmModel = action.llmModel;
      }
      return sanitized;
    }
    case "http": {
      if (typeof action.url === "string") {
        sanitized.url = action.url;
      }
      if (action.method !== undefined) {
        sanitized.method = action.method;
      }
      if (action.headers !== undefined && action.headers.length > 0) {
        sanitized.headers = action.headers;
      }
      if (typeof action.body === "string") {
        sanitized.body = action.body;
      }
      return sanitized;
    }
    case "plugin": {
      if (typeof action.pluginId === "string") {
        sanitized.pluginId = action.pluginId;
      }
      if (typeof action.pluginActionId === "string") {
        sanitized.pluginActionId = action.pluginActionId;
      }
      if (typeof action.pluginInput === "string") {
        sanitized.pluginInput = action.pluginInput;
      }
      if (typeof action.pluginAuth === "string") {
        sanitized.pluginAuth = action.pluginAuth;
      }
      return sanitized;
    }
    case "external_source": {
      if (typeof action.query === "string") {
        sanitized.query = action.query;
      }
      if (typeof action.sourceId === "string") {
        sanitized.sourceId = action.sourceId;
      }
      return sanitized;
    }
    case "telemetry_existing_entry":
    case "data_source_query":
    case "telemetry_ingest":
    case "diagnosis_diagnose":
    case "diagnosis_verify":
    case "diagnosis_recommend": {
      if (typeof action.body === "string") {
        sanitized.body = action.body;
      }
      if (typeof action.query === "string") {
        sanitized.query = action.query;
      }
      if (typeof action.sourceId === "string") {
        sanitized.sourceId = action.sourceId;
      }
      if (action.telemetryConfig !== undefined) {
        sanitized.telemetryConfig = action.telemetryConfig;
      }
      return sanitized;
    }
    default:
      throw new Error(
        `Unsupported runbook action type: ${String(action.type)}`,
      );
  }
}

function assertValidAction(action: DesktopRunbookActionRecord): void {
  if (action.title.trim().length === 0) {
    throw new Error("Runbook action title is required");
  }

  if (action.type === "external_source") {
    if (action.query === undefined || action.query.trim().length === 0) {
      throw new Error("External Source action is missing a query");
    }
    if (action.sourceId === undefined || action.sourceId.trim().length === 0) {
      throw new Error("External Source action is missing a source selection");
    }
  }

  if (action.type === "plugin") {
    if (action.pluginId === undefined || action.pluginId.trim().length === 0) {
      throw new Error("Plugin action is missing a selected plugin");
    }
    if (
      action.pluginActionId === undefined ||
      action.pluginActionId.trim().length === 0
    ) {
      throw new Error("Plugin action is missing a selected plugin action");
    }
  }
}

function parseIncomingRunbookAction(
  action: Record<string, unknown>,
  fallback: { id: string; type?: RunbookActionType },
): DesktopRunbookActionRecord {
  const type = normalizeRunbookActionType(action.type, fallback.type);

  const nextAction = sanitizeRunbookAction({
    id: asString(action.id, fallback.id),
    type,
    title: asString(action.title),
    command: asOptionalString(action.command),
    prompt: asOptionalString(action.prompt),
    llmProviderKey: parseRunbookLlmProviderKey(action.llmProviderKey),
    llmModel: asOptionalString(action.llmModel),
    url: asOptionalString(action.url),
    method: parseRunbookHttpMethod(action.method),
    headers: normalizeRunbookHeaders(action.headers),
    body: asOptionalString(action.body),
    pluginId: asOptionalString(action.pluginId),
    pluginActionId: asOptionalString(action.pluginActionId),
    pluginInput: asOptionalString(action.pluginInput),
    pluginAuth: asOptionalString(action.pluginAuth),
    query: asOptionalString(action.query),
    sourceId: asOptionalString(action.sourceId),
    parameters: normalizeRunbookParameters(action.parameters),
    logFilter: normalizeRunbookLogFilter(action.logFilter),
    telemetryConfig: parseTelemetryConfig(
      type,
      action.telemetryConfig ?? action.body,
    ),
  });

  assertValidAction(nextAction);
  return nextAction;
}

function toRunbookAction(raw: Record<string, unknown>): DesktopRunbookActionRecord {
  const type = normalizeRunbookActionType(raw.type);
  return sanitizeRunbookAction({
    id: asString(raw.id),
    type,
    title: asString(raw.title),
    command: asOptionalString(raw.command),
    prompt: asOptionalString(raw.prompt),
    llmProviderKey: parseRunbookLlmProviderKey(raw.llmProviderKey),
    llmModel: asOptionalString(raw.llmModel),
    url: type === "plugin" ? undefined : asOptionalString(raw.url),
    method: parseRunbookHttpMethod(raw.method),
    headers: parseRunbookHeaders(raw.headersJson ?? raw.headers),
    body: type === "plugin" ? undefined : asOptionalString(raw.body),
    pluginId: type === "plugin" ? asOptionalString(raw.sourceId) : undefined,
    pluginActionId:
      type === "plugin" ? asOptionalString(raw.query) : undefined,
    pluginInput: type === "plugin" ? asOptionalString(raw.body) : undefined,
    pluginAuth: type === "plugin" ? asOptionalString(raw.url) : undefined,
    query: type === "plugin" ? undefined : asOptionalString(raw.query),
    sourceId: type === "plugin" ? undefined : asOptionalString(raw.sourceId),
    parameters: parseRunbookParameters(raw.parametersJson ?? raw.parameters),
    logFilter: parseRunbookLogFilter(raw.logFilterJson ?? raw.logFilter),
    telemetryConfig: parseTelemetryConfig(
      type,
      raw.body ?? raw.telemetryConfig,
    ),
  });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Context payload projection preserves each action type's public fields.
function actionPayload(
  action: DesktopRunbookActionRecord,
): DesktopRunbookContext["actions"][number]["payload"] {
  const payload: DesktopRunbookContext["actions"][number]["payload"] = {};
  if (action.parameters !== undefined && action.parameters.length > 0) {
    payload.parameters = action.parameters;
  }
  if (action.logFilter !== undefined) {
    payload.logFilter = action.logFilter;
  }

  switch (action.type) {
    case "shell": {
      if (action.command !== undefined && action.command.length > 0) {
        payload.command = action.command;
      }
      return payload;
    }
    case "llm": {
      if (action.prompt !== undefined && action.prompt.length > 0) {
        payload.prompt = action.prompt;
      }
      if (action.llmProviderKey !== undefined) {
        payload.llmProviderKey = action.llmProviderKey;
      }
      if (action.llmModel !== undefined && action.llmModel.length > 0) {
        payload.llmModel = action.llmModel;
      }
      return payload;
    }
    case "http": {
      if (action.url !== undefined && action.url.length > 0) {
        payload.url = action.url;
      }
      if (action.method !== undefined) {
        payload.method = action.method;
      }
      if (action.headers !== undefined && action.headers.length > 0) {
        payload.headers = action.headers;
      }
      if (typeof action.body === "string") {
        payload.body = action.body;
      }
      return payload;
    }
    case "plugin": {
      if (action.pluginId !== undefined && action.pluginId.length > 0) {
        payload.pluginId = action.pluginId;
      }
      if (
        action.pluginActionId !== undefined &&
        action.pluginActionId.length > 0
      ) {
        payload.pluginActionId = action.pluginActionId;
      }
      if (typeof action.pluginAuth === "string") {
        payload.pluginAuth = action.pluginAuth;
      }
      if (typeof action.pluginInput === "string") {
        payload.pluginInput = action.pluginInput;
      }
      return payload;
    }
    case "external_source": {
      if (action.query !== undefined && action.query.length > 0) {
        payload.query = action.query;
      }
      if (action.sourceId !== undefined && action.sourceId.length > 0) {
        payload.sourceId = action.sourceId;
      }
      return payload;
    }
    case "telemetry_existing_entry":
    case "data_source_query":
    case "telemetry_ingest":
    case "diagnosis_diagnose":
    case "diagnosis_verify":
    case "diagnosis_recommend": {
      if (action.telemetryConfig !== undefined) {
        payload.telemetryConfig = action.telemetryConfig;
      }
      return payload;
    }
    default:
      throw new Error(
        `Unsupported runbook action type: ${String(action.type)}`,
      );
  }
}

function describeAction(action: DesktopRunbookActionRecord, order: number): string {
  let title = action.title;
  if (title.length === 0) {
    title = "Untitled action";
  }
  const base = `${String(order)}. [${action.type}] ${title}`;
  if (action.command !== undefined && action.command.length > 0) return `${base} -> ${action.command}`;
  if (action.prompt !== undefined && action.prompt.length > 0) return `${base} -> ${action.prompt}`;
  if (action.url !== undefined && action.url.length > 0) return `${base} -> ${action.method ?? "GET"} ${action.url}`;
  if (action.query !== undefined && action.query.length > 0) return `${base} -> ${action.query}`;
  if (action.sourceId !== undefined && action.sourceId.length > 0) return `${base} -> source:${action.sourceId}`;
  if (action.telemetryConfig?.needLabel !== undefined && action.telemetryConfig.needLabel.length > 0)
    return `${base} -> ${action.telemetryConfig.needLabel}`;
  if (action.telemetryConfig?.sourceId !== undefined && action.telemetryConfig.sourceId.length > 0)
    return `${base} -> source:${action.telemetryConfig.sourceId}`;
  return base;
}

function buildPurposeText(runbook: DesktopRunbookRecord): string {
  const lines = [`Runbook "${runbook.title}"`];
  if (runbook.description.trim().length > 0) {
    lines.push(runbook.description.trim());
  }
  if (runbook.actions.length > 0) {
    lines.push(
      `Ordered actions: ${runbook.actions
        .map((action, index) => describeAction(action, index + 1))
        .join(" | ")}`,
    );
  } else {
    lines.push("Ordered actions: none");
  }
  return lines.join("\n");
}

export class DesktopRunbookStore {
  private readonly errorSourcesRepository: SqliteErrorSourcesRepositoryAdapter;

  constructor(
    private readonly db: DesktopRunbookStoreDatabase,
    private readonly globalVariablesService: DesktopRunbookStoreGlobalVariablesService,
  ) {
    this.errorSourcesRepository = new SqliteErrorSourcesRepositoryAdapter(db);
  }

  private async listActions(
    runbookId: string,
  ): Promise<DesktopRunbookActionRecord[]> {
    const rows = (await this.db.runbookAction.findMany({
      where: { runbookId },
      orderBy: { sortOrder: "asc" },
    }));

    return rows.map((row) => toRunbookAction(row));
  }

  private async hydrateRunbook(
    rawRunbook: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const runbookId = asString(rawRunbook.id);
    const actions = await this.listActions(runbookId);
    return {
      id: runbookId,
      title: asString(rawRunbook.title, "New Runbook"),
      description: asString(rawRunbook.description),
      idleTimeout: normalizeRunbookIdleTimeout(rawRunbook.idleTimeout),
      revisionNumber: Math.max(1, Number(rawRunbook.revisionNumber ?? 1)),
      actions,
      createdAt: asIsoString(rawRunbook.createdAt),
      updatedAt: asIsoString(rawRunbook.updatedAt),
    };
  }

  async getRunbookRow(id: string): Promise<Record<string, unknown> | null> {
    return this.db.runbook.findUnique({
      where: {
        id,
        deletedAt: null,
      },
    });
  }

  async getRunbookOrThrow(id: string): Promise<DesktopRunbookRecord> {
    const row = await this.getRunbookRow(id);
    if (row === null) {
      throw new Error(`Runbook not found: ${id}`);
    }
    return this.hydrateRunbook(row);
  }

  private async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.db.$executeRawUnsafe("BEGIN");

    try {
      const result = await operation();
      await this.db.$executeRawUnsafe("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.db.$executeRawUnsafe("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private async bumpRevision(
    runbook: DesktopRunbookRecord,
  ): Promise<DesktopRunbookRecord> {
    const updated = await this.db.runbook.update({
      where: { id: runbook.id },
      data: {
        revisionNumber: runbook.revisionNumber + 1,
        updatedAt: new Date().toISOString(),
      },
    });
    return this.hydrateRunbook(updated);
  }

  async list(): Promise<DesktopRunbookRecord[]> {
    const rows = (await this.db.runbook.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    }));

    return Promise.all(rows.map((row) => this.hydrateRunbook(row)));
  }

  async get(id: string): Promise<DesktopRunbookRecord | null> {
    const row = await this.getRunbookRow(id);
    if (row === null) return null;
    return this.hydrateRunbook(row);
  }

  async create(payload: Record<string, unknown>): Promise<DesktopRunbookRecord> {
    const id = asString(payload.id);
    const title = asString(payload.title, "New Runbook");
    const description = asString(payload.description);
    const hasIdleTimeout = Object.prototype.hasOwnProperty.call(
      payload,
      "idleTimeout",
    );
    let idleTimeout: number | undefined;
    if (hasIdleTimeout) {
      idleTimeout = parseRunbookIdleTimeoutForUpdate(payload.idleTimeout);
    }
    const now = new Date().toISOString();

    const created = await this.db.runbook.create({
      data: {
        id,
        title,
        description,
        idleTimeout: idleTimeout ?? null,
        revisionNumber: 1,
        createdAt: now,
        updatedAt: now,
      },
    });

    return this.hydrateRunbook(created);
  }

  async updateMeta(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const id = asString(payload.id);
    const current = await this.getRunbookOrThrow(id);
    let nextTitle = current.title;
    if (typeof payload.title === "string") {
      nextTitle = payload.title;
    }

    let nextDescription = current.description;
    if (typeof payload.description === "string") {
      nextDescription = payload.description;
    }

    const hasIdleTimeout = Object.prototype.hasOwnProperty.call(
      payload,
      "idleTimeout",
    );
    let nextIdleTimeout = current.idleTimeout;
    if (hasIdleTimeout) {
      nextIdleTimeout = parseRunbookIdleTimeoutForUpdate(payload.idleTimeout);
    }

    if (
      nextTitle === current.title &&
      nextDescription === current.description &&
      nextIdleTimeout === current.idleTimeout
    ) {
      return current;
    }

    const updated = await this.db.runbook.update({
      where: { id },
      data: {
        title: nextTitle,
        description: nextDescription,
        idleTimeout: nextIdleTimeout ?? null,
      },
    });

    return this.bumpRevision(
      await this.hydrateRunbook(updated),
    );
  }

  async updateActions(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const runbookId = asString(payload.runbookId);
    const current = await this.getRunbookOrThrow(runbookId);
    let actionInputs: Array<Record<string, unknown>> = [];
    if (Array.isArray(payload.actions)) {
      actionInputs = payload.actions.map((action) => asObject(action));
    }
    const now = new Date().toISOString();

    const nextActions = actionInputs.map((action, index) =>
      parseIncomingRunbookAction(action, {
        id: asString(action.id, current.actions[index]?.id ?? randomUUID()),
        type: current.actions[index]?.type,
      }),
    );

    await this.withTransaction(async () => {
      await this.db.runbookAction.deleteMany({
        where: { runbookId },
      });

      for (let index = 0; index < nextActions.length; index += 1) {
        const action = nextActions[index];
        let headersJson: string | null = null;
        if (action.headers !== undefined && action.headers.length > 0) {
          headersJson = JSON.stringify(action.headers);
        }

        let parametersJson: string | null = null;
        if (action.parameters !== undefined && action.parameters.length > 0) {
          parametersJson = JSON.stringify(action.parameters);
        }

        let logFilterJson: string | null = null;
        if (action.logFilter !== undefined) {
          logFilterJson = JSON.stringify(action.logFilter);
        }

        await this.db.runbookAction.create({
          data: {
            id: action.id,
            runbookId,
            sortOrder: index,
            type: action.type,
            title: action.title,
            command: action.command ?? null,
            prompt: action.prompt ?? null,
            llmProviderKey: action.llmProviderKey ?? null,
            llmModel: action.llmModel ?? null,
            url: serializeStoredRunbookActionUrl(action),
            method: action.method ?? null,
            headersJson,
            body: serializeRunbookActionBody(action),
            query: serializeStoredRunbookActionQuery(action),
            sourceId: serializeStoredRunbookActionSourceId(action),
            parametersJson,
            logFilterJson,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      await this.db.runbook.update({
        where: { id: runbookId },
        data: {
          revisionNumber: current.revisionNumber + 1,
          updatedAt: now,
        },
      });
    });

    return this.getRunbookOrThrow(runbookId);
  }

  async saveAction(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const runbookId = asString(payload.runbookId);
    const action = asObject(payload.action);
    const actionId = asString(action.id);
    const current = await this.getRunbookOrThrow(runbookId);
    const existing = current.actions.find((item) => item.id === actionId);
    const now = new Date().toISOString();

    if (existing !== undefined) {
      const nextAction = parseIncomingRunbookAction(action, {
        id: actionId,
        type: existing.type,
      });

      await this.db.runbookAction.update({
        where: { id: actionId, runbookId },
        data: {
          type: nextAction.type,
          title: nextAction.title,
          command: nextAction.command ?? null,
          prompt: nextAction.prompt ?? null,
          llmProviderKey: nextAction.llmProviderKey ?? null,
          llmModel: nextAction.llmModel ?? null,
          url: serializeStoredRunbookActionUrl(nextAction),
          method: nextAction.method ?? null,
          headersJson: serializeOptionalJson(nextAction.headers),
          body: serializeRunbookActionBody(nextAction),
          query: serializeStoredRunbookActionQuery(nextAction),
          sourceId: serializeStoredRunbookActionSourceId(nextAction),
          parametersJson: serializeOptionalJson(nextAction.parameters),
          logFilterJson: serializeOptionalJson(nextAction.logFilter),
          updatedAt: now,
        },
      });

      return this.bumpRevision(await this.getRunbookOrThrow(runbookId));
    }

    const requestedSortOrder = Number(action.sortOrder);
    const nextAction = parseIncomingRunbookAction(action, {
      id: actionId,
    });
    let insertAt = current.actions.length;
    if (Number.isFinite(requestedSortOrder)) {
      insertAt = Math.max(0, Math.min(current.actions.length, requestedSortOrder));
    }

    for (
      let index = current.actions.length - 1;
      index >= insertAt;
      index -= 1
    ) {
      const item = current.actions[index];
      await this.db.runbookAction.update({
        where: { id: item.id, runbookId },
        data: {
          sortOrder: index + 1,
          updatedAt: now,
        },
      });
    }

    await this.db.runbookAction.create({
      data: {
        id: actionId,
        runbookId,
        sortOrder: insertAt,
        type: nextAction.type,
        title: nextAction.title,
        command: nextAction.command ?? null,
        prompt: nextAction.prompt ?? null,
        llmProviderKey: nextAction.llmProviderKey ?? null,
        llmModel: nextAction.llmModel ?? null,
        url: serializeStoredRunbookActionUrl(nextAction),
        method: nextAction.method ?? null,
        headersJson: serializeOptionalJson(nextAction.headers),
        body: serializeRunbookActionBody(nextAction),
        query: serializeStoredRunbookActionQuery(nextAction),
        sourceId: serializeStoredRunbookActionSourceId(nextAction),
        parametersJson: serializeOptionalJson(nextAction.parameters),
        logFilterJson: serializeOptionalJson(nextAction.logFilter),
        createdAt: now,
        updatedAt: now,
      },
    });

    return this.bumpRevision(await this.getRunbookOrThrow(runbookId));
  }

  async deleteAction(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const runbookId = asString(payload.runbookId);
    const actionId = asString(payload.actionId);
    const current = await this.getRunbookOrThrow(runbookId);
    const targetIndex = current.actions.findIndex(
      (action) => action.id === actionId,
    );
    if (targetIndex === -1) {
      return current;
    }

    const now = new Date().toISOString();
    await this.db.runbookAction.delete({
      where: { id: actionId, runbookId },
    });

    for (
      let index = targetIndex + 1;
      index < current.actions.length;
      index += 1
    ) {
      const item = current.actions[index];
      await this.db.runbookAction.update({
        where: { id: item.id, runbookId },
        data: {
          sortOrder: index - 1,
          updatedAt: now,
        },
      });
    }

    return this.bumpRevision(await this.getRunbookOrThrow(runbookId));
  }

  async reorderActions(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookRecord> {
    const runbookId = asString(payload.runbookId);
    let actionIdsInOrder: string[] = [];
    if (Array.isArray(payload.actionIdsInOrder)) {
      actionIdsInOrder = payload.actionIdsInOrder.map((item) => String(item));
    }
    const current = await this.getRunbookOrThrow(runbookId);
    const currentIds = current.actions.map((action) => action.id);

    if (
      actionIdsInOrder.length !== currentIds.length ||
      currentIds.some((id) => !actionIdsInOrder.includes(id))
    ) {
      throw new Error(
        "Runbook action reorder payload does not match current runbook actions",
      );
    }

    if (currentIds.every((id, index) => actionIdsInOrder[index] === id)) {
      return current;
    }

    const now = new Date().toISOString();
    for (let index = 0; index < actionIdsInOrder.length; index += 1) {
      await this.db.runbookAction.update({
        where: { id: actionIdsInOrder[index], runbookId },
        data: {
          sortOrder: index,
          updatedAt: now,
        },
      });
    }

    return this.bumpRevision(await this.getRunbookOrThrow(runbookId));
  }

  async remove(payload: Record<string, unknown>): Promise<{ ok: true }> {
    const id = asString(payload.id);
    await this.db.runbook.updateMany({
      where: { id },
      data: {
        deletedAt: new Date().toISOString(),
      },
    });
    return { ok: true };
  }

  async exportRunbooks(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookExportArtifactV1> {
    let ids: string[] = [];
    if (Array.isArray(payload.ids)) {
      ids = payload.ids
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    }
    const includeGlobals = payload.includeGlobals === true;

    if (ids.length === 0) {
      throw new Error("At least one runbook id is required for export");
    }

    const uniqueIds = [...new Set(ids)];
    const runbooks = await Promise.all(
      uniqueIds.map((id) => this.getRunbookOrThrow(id)),
    );
    const referencedSourceIds = [
      ...new Set(
        runbooks.flatMap((runbook) =>
          runbook.actions
            .map((action) => action.sourceId?.trim() ?? "")
            .filter((sourceId) => sourceId.length > 0),
        ),
      ),
    ];
    let referencedSources: Array<
      Awaited<ReturnType<SqliteErrorSourcesRepositoryAdapter["findById"]>>
    > = [];
    if (referencedSourceIds.length > 0) {
      referencedSources = await Promise.all(
        referencedSourceIds.map((sourceId) =>
          this.errorSourcesRepository.findById(sourceId),
        ),
      );
    }
    const referencedSourcesById = new Map(
      referencedSources
        .filter(
          (source): source is NonNullable<(typeof referencedSources)[number]> =>
            source !== null,
        )
        .map((source) => [source.id, source]),
    );
    const sourceRefsById = buildArtifactSourceRefs(referencedSourcesById);
    const exportedRunbooks = runbooks.map((runbook) => {
      const exportedRunbook: DesktopRunbookExportArtifactV1["runbooks"][number] = {
        title: runbook.title,
        actions: runbook.actions.map((action) => {
          let sourceRef: string | undefined;
          let sourceName: string | undefined;
          let sourceType: DesktopRunbookExportArtifactV1["runbooks"][number]["actions"][number]["sourceType"];
          if (action.sourceId !== undefined) {
            sourceRef = sourceRefsById.get(action.sourceId);
            sourceName = referencedSourcesById.get(action.sourceId)?.name;
            const parsedSourceType = errorSourceTypeSchema.safeParse(
              referencedSourcesById.get(action.sourceId)?.sourceType,
            );
            if (parsedSourceType.success) {
              sourceType = parsedSourceType.data;
            }
          }

          return {
            type: action.type,
            title: action.title,
            command: action.command,
            prompt: action.prompt,
            llmProviderKey: action.llmProviderKey,
            llmModel: action.llmModel,
            url: action.url,
            method: action.method,
            headers: action.headers,
            body: action.body,
            pluginId: action.pluginId,
            pluginActionId: action.pluginActionId,
            pluginInput: action.pluginInput,
            pluginAuth: action.pluginAuth,
            query: action.query,
            sourceRef,
            sourceName,
            sourceType,
            parameters: action.parameters?.map((parameter) => ({
              key: parameter.key,
              label: parameter.label,
              description: parameter.description,
              defaultValue: parameter.defaultValue,
              required: parameter.required,
              secure: parameter.secure,
            })),
            logFilter: action.logFilter,
            telemetryConfig: action.telemetryConfig,
          };
        }),
      };
      if (runbook.description.length > 0) {
        exportedRunbook.description = runbook.description;
      }
      if (typeof runbook.idleTimeout === "number") {
        exportedRunbook.idleTimeout = runbook.idleTimeout;
      }
      return exportedRunbook;
    });
    let globals: DesktopRunbookExportArtifactV1["globals"];
    if (includeGlobals) {
      globals = await this.buildExportGlobals(exportedRunbooks);
    }
    const externalSources = this.buildExportExternalSources(
      referencedSourcesById,
      sourceRefsById,
    );

    const artifact: DesktopRunbookExportArtifactV1 = {
      format: "bitsentry.runbooks.export",
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: {
        product: "superterminal",
        runtime: "desktop",
      },
      runbooks: exportedRunbooks,
    };

    if (globals !== undefined && globals.length > 0) {
      artifact.globals = globals;
    }
    if (externalSources.length > 0) {
      artifact.externalSources = externalSources;
    }

    return artifact;
  }

  // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Import coordinates conflict handling, dependencies, and dry-run summaries.
  async importRunbooks(
    payload: Record<string, unknown>,
  ): Promise<RunbookImportSummary> {
    const artifact = payload.artifact as
      | DesktopRunbookExportArtifactV1
      | undefined;
    const options = payload.options as RunbookImportOptions | undefined;
    const normalizedOptions = normalizeRunbookImportOptions(options);

    if (artifact === undefined) {
      throw new Error("Runbook import artifact is required");
    }

    if (normalizedOptions.conflictPolicy === "overwrite") {
      throw new Error(
        'conflictPolicy "overwrite" is not supported yet for SuperTerminal import',
      );
    }

    const existingRunbooks = await this.list();
    const existingSources = await this.errorSourcesRepository.findMany();
    const existingTitles = new Set(
      existingRunbooks.map((runbook) => runbook.title),
    );
    const existingSourceFingerprintsById = new Map(
      existingSources.map((source) => [
        source.id,
        buildExternalSourceFingerprint(source.sourceType, source.configuration),
      ]),
    );
    const existingRunbookByFingerprint = new Map(
      existingRunbooks.map((runbook) => [
        buildRunbookFingerprint(
          runbook.actions,
          (sourceId) =>
            existingSourceFingerprintsById.get(sourceId) ??
            `missing:${sourceId}`,
        ),
        runbook,
      ]),
    );
    const referencedArtifactSourceRefs = collectReferencedArtifactSourceRefs(
      artifact.runbooks,
    );
    const artifactExternalSourcesByRef = new Map<
      string,
      NonNullable<DesktopRunbookExportArtifactV1["externalSources"]>[number]
    >();
    for (const externalSource of artifact.externalSources ?? []) {
      const sourceRef = externalSource.ref.trim();
      if (sourceRef.length === 0) {
        throw new Error(
          "Artifact externalSources entries must include a non-empty ref",
        );
      }
      if (artifactExternalSourcesByRef.has(sourceRef)) {
        throw new Error(
          `Artifact includes duplicate external source ref "${sourceRef}"`,
        );
      }
      artifactExternalSourcesByRef.set(sourceRef, externalSource);
    }
    for (const runbook of artifact.runbooks) {
      for (const action of runbook.actions) {
        if (action.type !== "external_source") {
          continue;
        }

        const sourceRef = action.sourceRef?.trim();
        if (sourceRef === undefined || sourceRef.length === 0) {
          throw new Error(
            `External Source action "${action.title}" is missing sourceRef in the import YAML.`,
          );
        }
        if (
          artifactExternalSourcesByRef.size > 0 &&
          !artifactExternalSourcesByRef.has(sourceRef)
        ) {
          throw new Error(
            `External Source action "${action.title}" references sourceRef "${sourceRef}" but the import YAML does not define it under externalSources.`,
          );
        }
      }
    }

    const summary: RunbookImportSummary = {
      imported: 0,
      skipped: 0,
      failed: 0,
      warnings: [
      ],
      results: [],
    };
    if (artifact.globals !== undefined && artifact.globals.length > 0) {
      if (normalizedOptions.includeGlobals) {
        summary.warnings.push(
          "Artifact includes referenced globals and will import missing ones without overwriting existing values.",
        );
      } else {
        summary.warnings.push(
          "Artifact globals were ignored because includeGlobals is disabled.",
        );
      }
    }
    if (artifact.externalSources !== undefined && artifact.externalSources.length > 0) {
      summary.warnings.push(
        "Artifact includes referenced external sources. Matching local sources will be reused by fingerprint, and missing ones require credentials in the YAML.",
      );
    }

    if (
      normalizedOptions.includeGlobals &&
      artifact.globals !== undefined &&
      artifact.globals.length > 0
    ) {
      const globalWarnings = await this.importGlobalsFromArtifact(
        artifact.globals,
        {
          dryRun: normalizedOptions.dryRun,
        },
      );
      summary.warnings.push(...globalWarnings);
    }

    const referencedArtifactExternalSources = referencedArtifactSourceRefs
      .map((sourceRef) => artifactExternalSourcesByRef.get(sourceRef))
      .filter(
        (
          externalSource,
        ): externalSource is NonNullable<
          DesktopRunbookExportArtifactV1["externalSources"]
        >[number] => externalSource !== undefined,
      );
    let importedExternalSources = {
      sourceIdByRef: new Map<string, string>(),
      sourceFingerprintByRef: new Map<string, string>(),
      warnings: [] as string[],
    };
    if (referencedArtifactExternalSources.length > 0) {
      importedExternalSources = await this.importExternalSourcesFromArtifact(
        referencedArtifactExternalSources,
        {
          dryRun: normalizedOptions.dryRun,
          existingSources,
        },
      );
    }
    summary.warnings.push(...importedExternalSources.warnings);
    const resolvedSourceFingerprintsById = new Map(
      existingSourceFingerprintsById,
    );
    for (const [
      sourceRef,
      resolvedSourceId,
    ] of importedExternalSources.sourceIdByRef) {
      const fingerprint =
        importedExternalSources.sourceFingerprintByRef.get(sourceRef);
      if (fingerprint !== undefined && fingerprint.length > 0) {
        resolvedSourceFingerprintsById.set(resolvedSourceId, fingerprint);
      }
    }

    for (const exportedRunbook of artifact.runbooks) {
      let requestedTitle = exportedRunbook.title.trim();
      if (requestedTitle.length === 0) {
        requestedTitle = "Imported runbook";
      }
      const warnings = new Set<string>();

      if (exportedRunbook.tags !== undefined && exportedRunbook.tags.length > 0) {
        warnings.add(
          `Runbook "${requestedTitle}" includes tags that are not stored in SuperTerminal yet.`,
        );
      }

      const referencedGlobals = collectRunbookGlobalReferences(exportedRunbook);
      if (referencedGlobals.length > 0) {
        warnings.add(
          `Runbook references globals: ${referencedGlobals.join(", ")}`,
        );
      }

      for (const action of exportedRunbook.actions) {
        if (typeof action.timeout === "number") {
          warnings.add(
            `Action "${action.title}" includes a timeout that is not stored in SuperTerminal yet.`,
          );
        }

        if (isTelemetryActionType(action.type)) {
          warnings.add(
            `Action "${action.title}" uses ${action.type} and will need review in SuperTerminal before execution.`,
          );
        }

        const sourceRef = action.sourceRef?.trim();
        if (sourceRef !== undefined && sourceRef.length > 0) {
          let sourceLabel = sourceRef;
          const sourceName = action.sourceName?.trim();
          if (sourceName !== undefined && sourceName.length > 0) {
            sourceLabel = sourceName;
          }
          const importedSourceId = importedExternalSources.sourceIdByRef.get(
            sourceRef,
          );
          let sourceWarning = `Action "${action.title}" references external source "${sourceLabel}" and should be reviewed in the target environment.`;
          if (importedSourceId !== undefined) {
            sourceWarning = `Action "${action.title}" was resolved against external source "${sourceLabel}".`;
          }
          warnings.add(
            sourceWarning,
          );
        }
      }

      const runbookFingerprint = buildRunbookFingerprint(
        exportedRunbook.actions.map((action) => ({
          type: action.type,
          title: action.title,
          command: action.command,
          prompt: action.prompt,
          llmProviderKey: normalizeImportedFingerprintLlmProviderKey(action.llmProviderKey),
          llmModel: action.llmModel,
          url: action.url,
          method: action.method,
          headers: action.headers,
          body: action.body,
          query: action.query,
          sourceId: sourceIdFromArtifactRef(
            action.sourceRef,
            importedExternalSources.sourceIdByRef,
          ),
          sourceRef: action.sourceRef,
          parameters: normalizeRunbookParameters(action.parameters),
          logFilter: action.logFilter,
          telemetryConfig: normalizeTelemetryConfig(action.telemetryConfig),
        })),
        (sourceId) => resolvedSourceFingerprintsById.get(sourceId),
      );

      const matchingRunbook =
        existingRunbookByFingerprint.get(runbookFingerprint);
      if (matchingRunbook !== undefined && normalizedOptions.conflictPolicy === "skip") {
        summary.skipped += 1;
        summary.results.push({
          title: requestedTitle,
          status: "skipped",
          runbookId: matchingRunbook.id,
          reason: `same runbook actions already exist in "${matchingRunbook.title}"`,
          warnings: warningsForResult(warnings),
        });
        summary.warnings.push(...warnings);
        continue;
      }

      if (
        existingTitles.has(requestedTitle) &&
        normalizedOptions.conflictPolicy === "skip"
      ) {
        summary.skipped += 1;
        summary.results.push({
          title: requestedTitle,
          status: "skipped",
          reason: "title conflict",
          warnings: warningsForResult(warnings),
        });
        summary.warnings.push(...warnings);
        continue;
      }

      let importedTitle = requestedTitle;
      if (normalizedOptions.conflictPolicy === "duplicate") {
        importedTitle = createImportedRunbookTitle(requestedTitle, existingTitles);
      }
      const nextRunbookId = randomUUID();
      const now = new Date().toISOString();

      if (normalizedOptions.dryRun) {
        summary.imported += 1;
        existingTitles.add(importedTitle);
        existingRunbookByFingerprint.set(runbookFingerprint, {
          id: nextRunbookId,
          title: importedTitle,
          description: exportedRunbook.description ?? "",
          idleTimeout: normalizeRunbookIdleTimeout(exportedRunbook.idleTimeout),
          revisionNumber: 1,
          actions: [],
          createdAt: now,
          updatedAt: now,
        });
        summary.results.push({
          title: importedTitle,
          status: "imported",
          warnings: warningsForResult(warnings),
        });
        summary.warnings.push(...warnings);
        continue;
      }

      let createdRunbook = false;
      try {
        await this.db.runbook.create({
          data: {
            id: nextRunbookId,
            title: importedTitle,
            description: exportedRunbook.description ?? "",
            idleTimeout:
              normalizeRunbookIdleTimeout(exportedRunbook.idleTimeout) ?? null,
            revisionNumber: 1,
            createdAt: now,
            updatedAt: now,
          },
        });
        createdRunbook = true;

        for (
          let index = 0;
          index < exportedRunbook.actions.length;
          index += 1
        ) {
          const action = exportedRunbook.actions[index];
          const actionId = randomUUID();

          const normalizedParameters = normalizeRunbookParameters(action.parameters);
          let body = action.body ?? null;
          let url = action.url ?? null;
          let query = action.query ?? null;
          if (isTelemetryActionType(action.type) && action.telemetryConfig !== undefined) {
            body = JSON.stringify(action.telemetryConfig);
          }
          let sourceId: string | null = null;
          if (action.type === "plugin") {
            body = action.pluginInput ?? null;
            url = action.pluginAuth ?? null;
            query = action.pluginActionId ?? null;
            sourceId = action.pluginId ?? null;
          } else if (action.sourceRef !== undefined && action.sourceRef.length > 0) {
            sourceId = importedExternalSources.sourceIdByRef.get(action.sourceRef) ?? null;
          }

          await this.db.runbookAction.create({
            data: {
              id: actionId,
              runbookId: nextRunbookId,
              sortOrder: index,
              type: action.type,
              title: action.title,
              command: action.command ?? null,
              prompt: action.prompt ?? null,
              llmProviderKey: action.llmProviderKey ?? null,
              llmModel: action.llmModel ?? null,
              url,
              method: action.method ?? null,
              headersJson: serializeOptionalJson(action.headers),
              body,
              query,
              sourceId,
              parametersJson: serializeOptionalJson(normalizedParameters),
              logFilterJson: serializeOptionalJson(action.logFilter),
              createdAt: now,
              updatedAt: now,
            },
          });
        }

        existingTitles.add(importedTitle);
        existingRunbookByFingerprint.set(runbookFingerprint, {
          id: nextRunbookId,
          title: importedTitle,
          description: exportedRunbook.description ?? "",
          idleTimeout: normalizeRunbookIdleTimeout(exportedRunbook.idleTimeout),
          revisionNumber: 1,
          actions: [],
          createdAt: now,
          updatedAt: now,
        });
        summary.imported += 1;
        summary.results.push({
          title: importedTitle,
          status: "imported",
          runbookId: nextRunbookId,
          warnings: warningsForResult(warnings),
        });
        summary.warnings.push(...warnings);
      } catch (error) {
        if (createdRunbook) {
          await this.db.runbookAction.deleteMany({
            where: { runbookId: nextRunbookId },
          });
          await this.db.runbook
            .delete({
              where: { id: nextRunbookId },
            })
            .catch(() => {});
        }

        summary.failed += 1;
        let failureReason = "Failed to import runbook";
        if (error instanceof Error) {
          failureReason = error.message;
        }
        summary.results.push({
          title: importedTitle,
          status: "failed",
          reason: failureReason,
          warnings: warningsForResult(warnings),
        });
        summary.warnings.push(...warnings);
      }
    }

    summary.warnings = [...new Set(summary.warnings)];
    return summary;
  }

  async exportContext(
    payload: Record<string, unknown>,
  ): Promise<DesktopRunbookContext> {
    const id = asString(payload.id);
    const runbook = await this.getRunbookOrThrow(id);
    const counts = createEmptyActionTypeCounts();

    for (const action of runbook.actions) {
      counts[action.type] += 1;
    }

    const globalReferences = await this.buildGlobalReferencesFromActions(
      runbook.actions.map((action) => ({
        type: action.type,
        title: action.title,
        command: action.command,
        prompt: action.prompt,
        url: action.url,
        body: action.body,
        query: action.query,
        headers: action.headers,
      })),
    );

    const context: DesktopRunbookContext = {
      format: "bitsentry.runbook.context",
      version: 1,
      runbook: {
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        revisionNumber: runbook.revisionNumber,
        updatedAt: runbook.updatedAt,
        actionCount: runbook.actions.length,
      },
      summary: {
        purposeText: buildPurposeText(runbook),
        actionTypeCounts: counts,
        orderedActionTitles: runbook.actions.map((action) => action.title),
      },
      actions: runbook.actions.map((action, index) => ({
        id: action.id,
        order: index + 1,
        type: action.type,
        title: action.title,
        payload: actionPayload(action),
      })),
    };

    if (globalReferences.length > 0) {
      context.globalReferences = globalReferences;
    }

    return context;
  }

  private buildExportExternalSources(
    sourcesById: Map<
      string,
      Awaited<ReturnType<SqliteErrorSourcesRepositoryAdapter["findById"]>>
    >,
    sourceRefsById: Map<string, string>,
  ): NonNullable<DesktopRunbookExportArtifactV1["externalSources"]> {
    return [...sourcesById.values()]
      .filter((source): source is NonNullable<typeof source> => source !== null)

      .map((source) => {
        const accessTokenRef = source.accessTokenRef?.trim();
        const refreshTokenRef = source.refreshTokenRef?.trim();
        const hasAccessTokenRef =
          accessTokenRef !== undefined && accessTokenRef.length > 0;
        const hasRefreshTokenRef =
          refreshTokenRef !== undefined && refreshTokenRef.length > 0;
        const exportedSource: NonNullable<
          DesktopRunbookExportArtifactV1["externalSources"]
        >[number] = {
          ref: sourceRefsById.get(source.id) ?? source.id,
          sourceType: source.sourceType,
          name: source.name,
          configuration: sanitizeExportedErrorSourceConfiguration(
            source.configuration,
          ),
          logLevelThreshold: source.logLevelThreshold,
          syncEnabled: source.syncEnabled,
          autoDiagnosisEnabled: source.autoDiagnosisEnabled,
          credentialsRedacted: hasAccessTokenRef || hasRefreshTokenRef,
        };

        if (
          requiresExternalSourceAuthToken(source.sourceType) ||
          hasAccessTokenRef ||
          hasRefreshTokenRef
        ) {
          const credentials: NonNullable<typeof exportedSource.credentials> = {
            authToken: "",
          };
          if (hasRefreshTokenRef) {
            credentials.refreshToken = "";
          }
          if (source.expiresAt !== null) {
            credentials.expiresAt = source.expiresAt;
          }
          if (source.grantedScopes.length > 0) {
            credentials.grantedScopes = source.grantedScopes;
          }
          exportedSource.credentials = credentials;
        }

        return exportedSource;
      });
  }

  private async importExternalSourcesFromArtifact(
    externalSources: NonNullable<
      DesktopRunbookExportArtifactV1["externalSources"]
    >,
    options?: {
      dryRun?: boolean;
      existingSources?: Awaited<
        ReturnType<SqliteErrorSourcesRepositoryAdapter["findMany"]>
      >;
    },
  ): Promise<{
    sourceIdByRef: Map<string, string>;
    sourceFingerprintByRef: Map<string, string>;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const existingSources =
      options?.existingSources ??
      (await this.errorSourcesRepository.findMany());
    const existingBySignature = new Map(
      existingSources.map((source) => [
        buildExternalSourceFingerprint(source.sourceType, source.configuration),
        source,
      ]),
    );
    const sourceIdByRef = new Map<string, string>();
    const sourceFingerprintByRef = new Map<string, string>();

    for (const externalSource of externalSources) {
      const sanitizedConfiguration = sanitizeExportedErrorSourceConfiguration(
        externalSource.configuration,
      );
      const fingerprint = buildExternalSourceFingerprint(
        externalSource.sourceType,
        sanitizedConfiguration,
      );
      const existing = existingBySignature.get(fingerprint);
      sourceFingerprintByRef.set(externalSource.ref, fingerprint);

      if (existing !== undefined) {
        sourceIdByRef.set(externalSource.ref, existing.id);
        continue;
      }

      const credentials = normalizeExportedExternalSourceCredentials(
        externalSource.credentials,
      );

      if (
        requiresExternalSourceAuthToken(externalSource.sourceType) &&
        credentials.authToken === undefined
      ) {
        throw new Error(
          `External source "${externalSource.name}" does not match an existing local source and is missing authToken in the import YAML.`,
        );
      }

      if (options?.dryRun === true) {
        sourceIdByRef.set(externalSource.ref, externalSource.ref);
        existingBySignature.set(fingerprint, {
          id: externalSource.ref,
          sourceType: externalSource.sourceType,
          name: externalSource.name,
          accessTokenRef: credentials.authToken ?? null,
          refreshTokenRef: credentials.refreshToken ?? null,
          expiresAt: credentials.expiresAt ?? null,
          grantedScopes: credentials.grantedScopes ?? [],
          configuration: sanitizedConfiguration,
          logLevelThreshold: externalSource.logLevelThreshold ?? "error",
          additionalMetadata: null,
          syncEnabled: externalSource.syncEnabled ?? true,
          autoDiagnosisEnabled: externalSource.autoDiagnosisEnabled ?? false,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        });
        warnings.push(
          `Would create external source "${externalSource.name}" from the YAML credentials.`,
        );
        continue;
      }

      const created = await this.errorSourcesRepository.create({
        sourceType: externalSource.sourceType,
        name: externalSource.name,
        accessTokenRef: credentials.authToken ?? null,
        refreshTokenRef: credentials.refreshToken ?? null,
        expiresAt: credentials.expiresAt ?? null,
        grantedScopes: credentials.grantedScopes ?? [],
        configuration: sanitizedConfiguration,
        logLevelThreshold: externalSource.logLevelThreshold,
        syncEnabled: externalSource.syncEnabled,
        autoDiagnosisEnabled: externalSource.autoDiagnosisEnabled,
      });
      sourceIdByRef.set(externalSource.ref, created.id);
      existingBySignature.set(fingerprint, created);
    }

    return {
      sourceIdByRef,
      sourceFingerprintByRef,
      warnings,
    };
  }

  private async buildGlobalReferencesFromActions(
    actions: Array<{
      command?: string;
      prompt?: string;
      url?: string;
      body?: string;
      query?: string;
      headers?: RunbookHttpHeader[];
      title: string;
      type: RunbookActionType;
    }>,
  ): Promise<NonNullable<DesktopRunbookContext["globalReferences"]>> {
    const references = collectRunbookGlobalReferences({ actions });
    if (references.length === 0) {
      return [];
    }

    const globals = await this.globalVariablesService.list();
    const globalsByKey = new Map(
      globals.map((globalVariable) => [globalVariable.key, globalVariable]),
    );

    return references.map((key) => {
      const globalVariable = globalsByKey.get(key);
      const reference: NonNullable<
        DesktopRunbookContext["globalReferences"]
      >[number] = {
        key,
      };
      if (globalVariable?.secure === true) {
        reference.secure = true;
      }
      if (
        globalVariable?.description !== undefined &&
        globalVariable.description.length > 0
      ) {
        reference.description = globalVariable.description;
      }
      return reference;
    });
  }

  private async buildExportGlobals(
    runbooks: Array<{
      actions: Array<{
        type: RunbookActionType;
        title: string;
        command?: string;
        prompt?: string;
        url?: string;
        body?: string;
        query?: string;
        headers?: RunbookHttpHeader[];
      }>;
    }>,
  ): Promise<DesktopRunbookExportArtifactV1["globals"]> {
    const referencedKeys = new Set<string>();

    for (const runbook of runbooks) {
      for (const key of collectRunbookGlobalReferences(runbook)) {
        referencedKeys.add(key);
      }
    }

    if (referencedKeys.size === 0) {
      return undefined;
    }

    const globals = await this.globalVariablesService.list();
    return globals
      .filter((globalVariable) => referencedKeys.has(globalVariable.key))
      .map((globalVariable) => {
        if (globalVariable.secure === true) {
          return {
            key: globalVariable.key,
            description: globalVariable.description,
            secure: true,
            redacted: true,
          };
        }

        return {
          key: globalVariable.key,
          value: globalVariable.value,
          description: globalVariable.description,
          secure: false,
        };
      });
  }

  private async importGlobalsFromArtifact(
    globals: NonNullable<DesktopRunbookExportArtifactV1["globals"]>,
    options?: {
      dryRun?: boolean;
    },
  ): Promise<string[]> {
    const warnings: string[] = [];
    const existingGlobals = await this.globalVariablesService.list();
    const existingKeys = new Set(
      existingGlobals.map((globalVariable) => globalVariable.key),
    );

    for (const globalVariable of globals) {
      if (existingKeys.has(globalVariable.key)) {
        continue;
      }

      if (options?.dryRun === true) {
        existingKeys.add(globalVariable.key);
        if (globalVariable.secure === true && globalVariable.redacted === true) {
          warnings.push(
            `Would import secure global "${globalVariable.key}" without a value. Re-enter the secret before running dependent runbooks.`,
          );
        }
        continue;
      }

      const createPayload: Parameters<
        DesktopRunbookStoreGlobalVariablesService["create"]
      >[0] = {
        key: globalVariable.key,
        description: globalVariable.description,
        secure: globalVariable.secure,
      };
      if (
        globalVariable.secure !== true &&
        typeof globalVariable.value === "string"
      ) {
        createPayload.value = globalVariable.value;
      }

      await this.globalVariablesService.create({
        ...createPayload,
      });
      existingKeys.add(globalVariable.key);

      if (globalVariable.secure === true && globalVariable.redacted === true) {
        warnings.push(
          `Imported secure global "${globalVariable.key}" without a value. Re-enter the secret before running dependent runbooks.`,
        );
      }
    }

    return warnings;
  }
}
