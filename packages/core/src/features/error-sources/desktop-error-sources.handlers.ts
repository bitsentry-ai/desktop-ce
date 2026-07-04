import type { DbClient } from "../desktop/desktop-database-client";
import log from "electron-log";
import { z } from "zod";
import { errorSourceTypeSchema } from "./error-sources.schemas";
import { getErrorMessage } from "../../shared/errors";
import { SqliteErrorSourcesRepositoryAdapter } from "./desktop-sqlite-error-sources.adapter";
import { SqliteErrorIssuesRepositoryAdapter } from "./desktop-sqlite-error-issues.adapter";
import { SqliteErrorEventsRepositoryAdapter } from "./desktop-sqlite-error-events.adapter";
import { ErrorSourceSyncService } from "./desktop-error-source-sync.service";
import { SyncSchedulerService } from "./desktop-sync-scheduler.service";
import type { DesktopOauthManagerService } from "./desktop-oauth-manager";
import type {
  ErrorSource,
  ErrorSourceConfiguration,
  ErrorSourceType,
  LogLevelThreshold,
} from "./desktop-error-sources.types";
import type {
  DesktopPluginDataSourceSetupField,
  DesktopPluginDataSourceRecord,
  DesktopPluginPersistedDataSourceSetup,
  DesktopPluginRuntimeService,
} from "../plugins";
import { createDesktopNodePluginRuntimeService } from "../plugins/node";
import {
  hasErrorSourceProviderAction,
  resolveErrorSourceProviderActionId,
} from "./desktop-plugin-error-source-actions";

const INTERRUPTED_SYNC_MESSAGE =
  "Previous sync was interrupted before completion.";
const handlerPayloadSchema = z.record(z.string(), z.unknown());
const createErrorSourcePayloadSchema = z
  .object({
    pluginId: z.string().min(1),
    sourceType: errorSourceTypeSchema,
    name: z.string().min(1),
    setupValues: handlerPayloadSchema.optional(),
    configuration: handlerPayloadSchema.optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    logLevelThreshold: z.enum(["error", "warning", "info", "debug"]).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose();
type CreateErrorSourcePayload = z.infer<typeof createErrorSourcePayloadSchema>;
const updateErrorSourcePayloadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    setupValues: handlerPayloadSchema.optional(),
    configuration: handlerPayloadSchema.optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    logLevelThreshold: z.enum(["error", "warning", "info", "debug"]).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose();
type UpdateErrorSourcePayload = z.infer<typeof updateErrorSourcePayloadSchema>;
const probeConnectionPayloadSchema = z.object({
  pluginId: z.string().min(1),
  sourceType: errorSourceTypeSchema,
  setupValues: handlerPayloadSchema.optional(),
});
type ProbeConnectionPayload = z.infer<typeof probeConnectionPayloadSchema>;
const initiateOAuthPayloadSchema = z.object({
  pluginId: z.string().min(1),
  sourceType: errorSourceTypeSchema,
  setupValues: handlerPayloadSchema.optional(),
  clientId: z.string().optional(),
  redirectUri: z.string().optional(),
});
type InitiateOAuthPayload = z.infer<typeof initiateOAuthPayloadSchema>;
const completeOAuthPayloadSchema = z
  .object({
    pluginId: z.string().min(1),
    sourceType: errorSourceTypeSchema,
    setupValues: handlerPayloadSchema.optional(),
    code: z.string().min(1),
    state: z.string().min(1),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().optional(),
    name: z.string().optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    logLevelThreshold: z.enum(["error", "warning", "info", "debug"]).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose();
type CompleteOAuthPayload = z.infer<typeof completeOAuthPayloadSchema>;
type ProbeOrganization = { id: string; name: string };
type ProbeProject = { id: string; name: string; orgId: string };
const idPayloadSchema = z.object({ id: z.string().min(1) });
const triggerSyncPayloadSchema = z
  .object({ id: z.string().optional() })
  .optional()
  .default({});
const errorIssuesListPayloadSchema = z.object({
  sourceId: z.string().min(1),
  status: z.string().optional(),
  level: z.string().optional(),
  projectIdentifier: z.string().optional(),
  environment: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});
const errorEventsListPayloadSchema = z.object({
  sourceId: z.string().min(1),
  issueId: z.string().optional(),
  level: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

type DesktopOauthManagerServiceClass = new (
  db: DbClient,
  pluginRuntime?: DesktopPluginRuntimeService,
) => DesktopOauthManagerService;

let syncScheduler: SyncSchedulerService | null = null;
let interruptedSyncRecovery: Promise<void> | null = null;

function readPayloadRecord(value: unknown): Record<string, unknown> | null {
  const parsed = handlerPayloadSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return null;
}

function readCreateErrorSourcePayload(
  payload: unknown,
): CreateErrorSourcePayload {
  return createErrorSourcePayloadSchema.parse(payload);
}

function readUpdateErrorSourcePayload(
  payload: unknown,
): UpdateErrorSourcePayload {
  return updateErrorSourcePayloadSchema.parse(payload);
}

function readProbeConnectionPayload(payload: unknown): ProbeConnectionPayload {
  return probeConnectionPayloadSchema.parse(payload);
}

function readInitiateOAuthPayload(payload: unknown): InitiateOAuthPayload {
  return initiateOAuthPayloadSchema.parse(payload);
}

function readCompleteOAuthPayload(payload: unknown): CompleteOAuthPayload {
  return completeOAuthPayloadSchema.parse(payload);
}

function nullableNonEmptyString(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  return value;
}

function applyOptionalOAuthConfiguration(
  configuration: ErrorSourceConfiguration,
  values: {
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthRedirectUri?: string;
  },
): void {
  if (values.oauthClientId !== undefined) {
    configuration.oauthClientId = values.oauthClientId;
  }
  if (values.oauthClientSecret !== undefined) {
    configuration.oauthClientSecret = values.oauthClientSecret;
  }
  if (values.oauthRedirectUri !== undefined) {
    configuration.oauthRedirectUri = values.oauthRedirectUri;
  }
}

function readOAuthConfigurationOverrides(
  configuration: Record<string, unknown>,
): {
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
} {
  const oauthClientId = readOptionalTrimmed(configuration.oauthClientId);
  const oauthClientSecret = readOptionalTrimmed(
    configuration.oauthClientSecret,
  );
  const oauthRedirectUri = readOptionalTrimmed(configuration.oauthRedirectUri);

  const overrides: {
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthRedirectUri?: string;
  } = {};
  if (oauthClientId !== undefined) {
    overrides.oauthClientId = oauthClientId;
  }
  if (oauthClientSecret !== undefined) {
    overrides.oauthClientSecret = oauthClientSecret;
  }
  if (oauthRedirectUri !== undefined) {
    overrides.oauthRedirectUri = oauthRedirectUri;
  }

  return overrides;
}

function buildPluginOAuthConfiguration(input: {
  persistedSetup: DesktopPluginPersistedDataSourceSetup;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
}): ErrorSourceConfiguration {
  const configuration: ErrorSourceConfiguration = {
    ...input.persistedSetup.configuration,
  };
  applyOptionalOAuthConfiguration(configuration, {
    oauthClientId: input.oauthClientId,
    oauthClientSecret: input.oauthClientSecret,
    oauthRedirectUri: input.oauthRedirectUri,
  });
  return configuration;
}

function toLogLevelThreshold(value: unknown): LogLevelThreshold {
  let raw = "error";
  if (typeof value === "string") {
    raw = value;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "debug") return "debug";
  if (normalized === "info") return "info";
  if (normalized === "warning") return "warning";
  return "error";
}

function readOptionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function readSourceType(value: unknown): ErrorSourceType | null {
  const normalized = readOptionalTrimmed(value);
  if (normalized !== undefined) {
    return normalized;
  }

  return null;
}

function readRequiredSourceType(
  value: unknown,
  label: string,
): ErrorSourceType {
  const sourceType = readSourceType(value);
  if (sourceType === null) {
    throw new Error(`${label} requires a sourceType`);
  }

  return sourceType;
}

function readPluginId(value: unknown): string | undefined {
  const normalized = readOptionalTrimmed(value);
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function readDelimitedStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\n]/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return readStringArray(value);
}

function readPluginSetupFieldValue(
  field: DesktopPluginDataSourceSetupField,
  setupValues: Record<string, unknown>,
): unknown {
  const rawValue = setupValues[field.key];

  if (field.control === "multiline_list") {
    const items = readDelimitedStringArray(rawValue);
    if (items.length === 0) {
      return undefined;
    }

    return items;
  }

  const normalized = readOptionalTrimmed(rawValue);
  if (normalized === undefined) {
    return undefined;
  }

  return normalized;
}

function pluginSetupFieldConfigurationKeys(
  field: DesktopPluginDataSourceSetupField,
): string[] {
  const keys = new Set([field.key]);
  if (field.key === "owner") {
    keys.add("orgSlug");
  }
  if (field.key === "repos") {
    keys.add("projectIds");
  }
  if (field.key === "indexUrl") {
    keys.add("baseUrl");
  }
  return [...keys];
}

function pluginSetupConfigurationKeysToReset(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
  setupValues: Record<string, unknown>,
): string[] {
  const submittedKeys = new Set(Object.keys(setupValues));
  const keys = new Set<string>();
  for (const field of readPluginDataSourceSetupFields(
    pluginRuntime,
    pluginId,
  )) {
    if (field.control === "password" || !submittedKeys.has(field.key)) {
      continue;
    }

    for (const key of pluginSetupFieldConfigurationKeys(field)) {
      keys.add(key);
    }
  }
  return [...keys];
}

function readPluginDataSourceSetupFields(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
): DesktopPluginDataSourceSetupField[] {
  const plugin = pluginRuntime.getPlugin(pluginId);
  return plugin?.metadata?.dataSource?.setupFields ?? [];
}

function hasMatchingErrorSourcePlugin(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
  sourceType: ErrorSourceType,
): boolean {
  const errorSource = pluginRuntime.getPlugin(pluginId)?.metadata?.dataSource;
  return errorSource?.sourceType === sourceType;
}

async function resolvePersistedPluginSetup(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
  setupValues: Record<string, unknown>,
): Promise<DesktopPluginPersistedDataSourceSetup> {
  const setupFields = readPluginDataSourceSetupFields(pluginRuntime, pluginId);
  const setupFieldKeys = new Set(setupFields.map((field) => field.key));
  const normalizedSetupValues: Record<string, unknown> = Object.fromEntries(
    Object.entries(setupValues).filter(([key]) => !setupFieldKeys.has(key)),
  );
  for (const field of setupFields) {
    const value = readPluginSetupFieldValue(field, setupValues);
    if (value !== undefined) {
      normalizedSetupValues[field.key] = value;
    }
  }

  return pluginRuntime.resolveErrorSourceSetup({
    pluginId,
    setupValues: normalizedSetupValues,
  });
}

function readSourcePluginId(source: ErrorSource): string {
  const pluginId = readPluginId(source.additionalMetadata?.pluginId);
  if (pluginId !== undefined) {
    return pluginId;
  }

  return source.sourceType;
}

function mergeErrorSourceAdditionalMetadata(
  additionalMetadata: Record<string, unknown> | null | undefined,
  pluginId: string | undefined,
): Record<string, unknown> | null {
  let nextMetadata: Record<string, unknown> = {};
  if (additionalMetadata !== null && additionalMetadata !== undefined) {
    nextMetadata = { ...additionalMetadata };
  }

  if (pluginId !== undefined && pluginId.length > 0) {
    nextMetadata.pluginId = pluginId;
  }

  if (Object.keys(nextMetadata).length === 0) {
    return null;
  }

  return nextMetadata;
}

function toRendererErrorSource(source: ErrorSource) {
  const pluginId = readPluginId(source.additionalMetadata?.pluginId);
  return {
    id: source.id,
    pluginId,
    sourceType: source.sourceType,
    name: source.name,
    syncEnabled: source.syncEnabled,
    autoDiagnosisEnabled: source.autoDiagnosisEnabled,
    logLevelThreshold: source.logLevelThreshold,
    lastSyncAt: source.lastSyncAt,
    lastSyncStatus: source.lastSyncStatus,
    lastSyncError: source.lastSyncError,
    configuration: sanitizeErrorSourceConfiguration(source.configuration),
  };
}

function sanitizeErrorSourceConfiguration(
  configuration: ErrorSource["configuration"] | null | undefined,
): Record<string, unknown> {
  if (configuration === null || configuration === undefined) {
    return {};
  }

  const sanitized: Record<string, unknown> = { ...configuration };
  delete sanitized.oauthClientSecret;
  return sanitized;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }

    const normalized = item.trim();
    if (normalized.length === 0) {
      return [];
    }

    return [normalized];
  });
}

function readProbeRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function readProbeString(value: unknown, fallback = ""): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return fallback;
}

function readProbeOrganizations(data: unknown): ProbeOrganization[] {
  return readUnknownArray(data).map((item) => {
    const record = readProbeRecord(item);
    const id = readProbeString(record.slug, readProbeString(record.id)).trim();
    if (id.length === 0) {
      throw new Error("Plugin returned an organization without an id");
    }

    return {
      id,
      name: readProbeString(record.name, id),
    };
  });
}

function readProbeProjects(
  data: unknown,
  orgId: string,
  useSlugAsId: boolean,
): ProbeProject[] {
  return readUnknownArray(data).map((item) => {
    const record = readProbeRecord(item);
    const fallbackId = readProbeString(record.id);
    const slug = readProbeString(record.slug, fallbackId).trim();
    let id = fallbackId.trim();
    if (useSlugAsId) {
      id = slug;
    }
    if (id.length === 0) {
      throw new Error("Plugin returned a project without an id");
    }
    let nameFallback = id;
    if (slug.length > 0) {
      nameFallback = slug;
    }

    return {
      id,
      name: readProbeString(record.name, nameFallback),
      orgId: readProbeString(
        record.organizationId ?? record.organization ?? record.orgSlug,
        orgId,
      ),
    };
  });
}

function readPluginConnectionIndexPattern(
  configuration: ErrorSourceConfiguration,
): string | undefined {
  const indexPatterns = readStringArray(configuration.indexPatterns);
  if (indexPatterns.length > 0) {
    return indexPatterns.join(",");
  }

  return undefined;
}

function pluginSourceRecord(
  source: ErrorSource,
): DesktopPluginDataSourceRecord {
  return {
    id: source.id,
    sourceType: source.sourceType,
    name: source.name,
    accessTokenRef: source.accessTokenRef,
    refreshTokenRef: source.refreshTokenRef,
    expiresAt: source.expiresAt,
    grantedScopes: source.grantedScopes,
    configuration: { ...source.configuration },
  };
}

async function buildPluginAuthFromSource(
  source: ErrorSource,
  pluginRuntime: DesktopPluginRuntimeService,
): Promise<Record<string, unknown>> {
  const pluginId = readSourcePluginId(source);
  return pluginRuntime.buildErrorSourceAuth({
    pluginId,
    source: pluginSourceRecord(source),
  });
}

function buildPluginProbeAuth(input: {
  pluginRuntime: DesktopPluginRuntimeService;
  pluginId: string;
  persistedSetup: DesktopPluginPersistedDataSourceSetup;
}): Promise<Record<string, unknown>> {
  return input.pluginRuntime.buildErrorSourceProbeAuth({
    pluginId: input.pluginId,
    persistedSetup: input.persistedSetup,
  });
}

function readPluginIssueCount(data: unknown): number {
  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as { issueCount?: unknown }).issueCount === "number"
  ) {
    const issueCount = (data as { issueCount: number }).issueCount;
    if (Number.isFinite(issueCount) && issueCount >= 0) {
      return Math.trunc(issueCount);
    }
  }

  return 0;
}

function readPluginIssueBatch(data: unknown): {
  issues: unknown[];
  hasMore: boolean;
} | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const rawIssues = (data as { issues?: unknown }).issues;
  if (!Array.isArray(rawIssues)) {
    return null;
  }

  return {
    issues: rawIssues,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  };
}

function readUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return [];
}

function readConfiguredOrganizationCount(
  configuration: ErrorSourceConfiguration,
): number {
  if (readOptionalTrimmed(configuration.orgSlug) === undefined) {
    return 0;
  }

  return 1;
}

function buildGenericPluginConnectionInput(
  source: ErrorSource,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    query: "*",
    limit: 1,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
  };

  const orgSlug = readOptionalTrimmed(source.configuration.orgSlug);
  if (orgSlug !== undefined) {
    input.orgSlug = orgSlug;
  }

  const projectIds = readStringArray(source.configuration.projectIds);
  if (projectIds.length > 0) {
    input.projectIds = projectIds;
  }

  const projectSlugs = readStringArray(source.configuration.projectSlugs);
  if (projectSlugs.length > 0) {
    input.projectSlugs = projectSlugs;
  }

  const indexPattern = readPluginConnectionIndexPattern(source.configuration);
  if (indexPattern !== undefined) {
    input.indexPattern = indexPattern;
  }

  return input;
}

function isMissingPluginAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith("Missing required auth field:") ||
    error.message.endsWith(" is required")
  );
}

function recoverInterruptedSyncs(
  sourcesRepository: SqliteErrorSourcesRepositoryAdapter,
): Promise<void> {
  if (interruptedSyncRecovery === null) {
    interruptedSyncRecovery = sourcesRepository
      .markInterruptedSyncsFailed(INTERRUPTED_SYNC_MESSAGE)
      .then((count) => {
        if (count > 0) {
          log.warn(
            `[error-sources] Recovered ${String(count)} interrupted source sync(s)`,
          );
        }
      })
      .catch((error: unknown) => {
        log.warn(
          "[error-sources] Failed to recover interrupted source syncs:",
          error,
        );
      });
  }
  return interruptedSyncRecovery;
}

export function createDesktopErrorSourcesHandlers(
  db: DbClient,
  dependencies: {
    OauthManagerService: DesktopOauthManagerServiceClass;
    pluginRuntime?: DesktopPluginRuntimeService;
  },
): Record<string, (payload: unknown) => Promise<unknown>> {
  const sourcesRepository = new SqliteErrorSourcesRepositoryAdapter(db);
  const issuesRepository = new SqliteErrorIssuesRepositoryAdapter(db);
  const eventsRepository = new SqliteErrorEventsRepositoryAdapter(db);
  const pluginRuntime =
    dependencies.pluginRuntime ?? createDesktopNodePluginRuntimeService();
  const oauthManager = new dependencies.OauthManagerService(db, pluginRuntime);
  const syncService = new ErrorSourceSyncService(
    db,
    sourcesRepository,
    issuesRepository,
    eventsRepository,
    pluginRuntime,
  );
  const syncRecovery = recoverInterruptedSyncs(sourcesRepository);

  if (syncScheduler === null) {
    syncScheduler = new SyncSchedulerService(syncService, 10 * 60 * 1000);
    void syncRecovery.finally(() => {
      syncScheduler?.start();
    });
  }

  function filterProbeOrganizations<T extends { id: string }>(
    orgs: T[],
    requestedOrgSlug: string | undefined,
  ): T[] {
    if (requestedOrgSlug === undefined) {
      return orgs;
    }

    return orgs.filter((org) => org.id === requestedOrgSlug);
  }

  return {
    "errorSources:probeConnection": async (rawPayload: unknown) => {
      const payload = readProbeConnectionPayload(rawPayload);
      const sourceType = payload.sourceType;
      const pluginId = payload.pluginId.trim();
      const setupValues = readPayloadRecord(payload.setupValues) ?? {};
      const persistedSetup = await resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      );
      const requestedOrgSlug = readOptionalTrimmed(
        persistedSetup.configuration.orgSlug,
      );
      const plugin = pluginRuntime.getPlugin(pluginId);

      log.info(
        `[error-sources] probeConnection:start type=${sourceType} org=${requestedOrgSlug ?? "<auto>"}`,
      );

      if (plugin?.metadata?.dataSource?.sourceType !== sourceType) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${sourceType}`,
        );
      }
      if (!hasErrorSourceProviderAction(plugin, "listOrganizations")) {
        throw new Error(
          `Error source plugin "${pluginId}" does not expose listOrganizations for connection probing`,
        );
      }

      try {
        const auth = await buildPluginProbeAuth({
          pluginRuntime,
          pluginId,
          persistedSetup,
        });
        const orgResult = await pluginRuntime.executeAction({
          pluginId,
          actionId: resolveErrorSourceProviderActionId({
            runtime: pluginRuntime,
            pluginId,
            sourceType,
            action: "listOrganizations",
          }),
          auth,
          input: {},
        });
        if (!orgResult.ok) {
          throw new Error(orgResult.summary);
        }
        const visibleOrgs = filterProbeOrganizations(
          readProbeOrganizations(orgResult.data),
          requestedOrgSlug,
        );
        const projectIdFieldUsesSlug =
          pluginRuntime.getErrorSourceProbeProjectIdentity(pluginId) === "slug";
        const canListProjects = hasErrorSourceProviderAction(
          plugin,
          "listProjects",
        );

        const projects: ProbeProject[] = [];
        if (canListProjects) {
          for (const org of visibleOrgs) {
            const projectResult = await pluginRuntime.executeAction({
              pluginId,
              actionId: resolveErrorSourceProviderActionId({
                runtime: pluginRuntime,
                pluginId,
                sourceType,
                action: "listProjects",
              }),
              auth,
              input: {
                orgSlug: org.id,
              },
            });
            if (!projectResult.ok) {
              throw new Error(projectResult.summary);
            }
            projects.push(
              ...readProbeProjects(
                projectResult.data,
                org.id,
                projectIdFieldUsesSlug,
              ),
            );
          }
        }

        const organizations: ProbeOrganization[] = visibleOrgs.map((org) => ({
          id: org.id,
          name: org.name,
        }));

        log.info(
          `[error-sources] probeConnection:success type=${sourceType} orgs=${String(organizations.length)} projects=${String(projects.length)}`,
        );
        return { organizations, projects };
      } catch (error) {
        log.warn("[error-sources] probeConnection:failed", error);
        const detail = getErrorMessage(error);
        throw new Error(`Probe failed: ${detail}`);
      }
    },

    "errorSources:getAll": async () => {
      await syncRecovery;
      const data = await sourcesRepository.findMany();
      return {
        data: data.map((source) => toRendererErrorSource(source)),
        total: data.length,
      };
    },

    "errorSources:getOne": async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload);
      await syncRecovery;
      const source = await sourcesRepository.findById(payload.id);
      if (source === null)
        throw new Error(`Error source ${payload.id} not found`);
      return toRendererErrorSource(source);
    },

    "errorSources:create": async (rawPayload: unknown) => {
      const payload = readCreateErrorSourcePayload(rawPayload);
      const sourceType = payload.sourceType;
      const pluginId = payload.pluginId.trim();
      const setupValues = readPayloadRecord(payload.setupValues) ?? {};
      const persistedSetup = await resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      );
      const usePluginCreatePath = hasMatchingErrorSourcePlugin(
        pluginRuntime,
        pluginId,
        sourceType,
      );
      const sourceName = payload.name;

      if (!usePluginCreatePath) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${sourceType}`,
        );
      }

      try {
        const customPluginConfiguration = {
          ...persistedSetup.configuration,
          ...(readPayloadRecord(payload.configuration) ?? {}),
        };

        const created = await sourcesRepository.create({
          sourceType,
          name: sourceName,
          additionalMetadata: mergeErrorSourceAdditionalMetadata(
            readPayloadRecord(payload.additionalMetadata),
            pluginId,
          ),
          accessTokenRef: nullableNonEmptyString(
            persistedSetup.accessTokenRef ?? "",
          ),
          refreshTokenRef: persistedSetup.refreshTokenRef ?? null,
          expiresAt: persistedSetup.expiresAt ?? null,
          grantedScopes: persistedSetup.grantedScopes ?? [],
          configuration: customPluginConfiguration,
          logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
          syncEnabled: payload.syncEnabled !== false,
          autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
        });
        return toRendererErrorSource(created);
      } catch (error) {
        throw error;
      }
    },

    "errorSources:update": async (rawPayload: unknown) => {
      const payload = readUpdateErrorSourcePayload(rawPayload);
      const existing = await sourcesRepository.findById(payload.id);
      if (existing === null)
        throw new Error(`Error source ${payload.id} not found`);
      const setupValues = readPayloadRecord(payload.setupValues);
      const pluginId = readSourcePluginId(existing);
      let persistedSetup: DesktopPluginPersistedDataSourceSetup = {
        configuration: {},
      };
      if (setupValues !== null) {
        persistedSetup = await resolvePersistedPluginSetup(
          pluginRuntime,
          pluginId,
          setupValues,
        );
      }
      if (
        !hasMatchingErrorSourcePlugin(
          pluginRuntime,
          pluginId,
          existing.sourceType,
        )
      ) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${existing.sourceType}`,
        );
      }

      let nextConfiguration: Record<string, unknown> = {
        ...existing.configuration,
      };
      if (payload.configuration !== undefined) {
        nextConfiguration = {
          ...nextConfiguration,
          ...payload.configuration,
        };
      }
      if (setupValues !== null) {
        const configurationKeysToReset = new Set(
          pluginSetupConfigurationKeysToReset(
            pluginRuntime,
            pluginId,
            setupValues,
          ),
        );
        if (configurationKeysToReset.size > 0) {
          nextConfiguration = Object.fromEntries(
            Object.entries(nextConfiguration).filter(
              ([key]) => !configurationKeysToReset.has(key),
            ),
          );
        }
      }
      if (Object.keys(persistedSetup.configuration).length > 0) {
        nextConfiguration = {
          ...nextConfiguration,
          ...persistedSetup.configuration,
        };
      }
      const tokenReplacement = persistedSetup.accessTokenRef !== undefined;
      const tokenMetadataUpdate: {
        refreshTokenRef?: string | null;
        expiresAt?: string | null;
        grantedScopes?: string[];
      } = {};
      if (persistedSetup.refreshTokenRef !== undefined) {
        tokenMetadataUpdate.refreshTokenRef = persistedSetup.refreshTokenRef;
      } else if (tokenReplacement) {
        tokenMetadataUpdate.refreshTokenRef = null;
      }
      if (persistedSetup.expiresAt !== undefined) {
        tokenMetadataUpdate.expiresAt = persistedSetup.expiresAt;
      } else if (tokenReplacement) {
        tokenMetadataUpdate.expiresAt = null;
      }
      if (persistedSetup.grantedScopes !== undefined) {
        tokenMetadataUpdate.grantedScopes = persistedSetup.grantedScopes;
      } else if (tokenReplacement) {
        tokenMetadataUpdate.grantedScopes = [];
      }

      const updated = await sourcesRepository.update({
        id: existing.id,
        name: readOptionalTrimmed(payload.name),
        additionalMetadata:
          readPayloadRecord(payload.additionalMetadata) ?? undefined,
        accessTokenRef: persistedSetup.accessTokenRef,
        ...tokenMetadataUpdate,
        configuration: nextConfiguration,
        logLevelThreshold: payload.logLevelThreshold,
        syncEnabled: payload.syncEnabled,
        autoDiagnosisEnabled: payload.autoDiagnosisEnabled,
      });
      if (updated === null)
        throw new Error(`Error source ${payload.id} not found`);
      return toRendererErrorSource(updated);
    },

    "errorSources:delete": async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload);
      const source = await sourcesRepository.findById(payload.id);
      if (source === null) {
        return { success: true };
      }

      await sourcesRepository.remove(source.id);
      return { success: true };
    },

    "errorSources:initiateOAuth": async (rawPayload: unknown) => {
      const payload = readInitiateOAuthPayload(rawPayload);
      const sourceType = readRequiredSourceType(
        payload.sourceType,
        "OAuth initiation",
      );
      const pluginId = payload.pluginId.trim();
      const setupValues = readPayloadRecord(payload.setupValues) ?? {};
      const persistedSetup = await resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      );
      const oauthConfigOverrides = readOAuthConfigurationOverrides(
        persistedSetup.configuration,
      );
      const baseUrl = readOptionalTrimmed(persistedSetup.configuration.baseUrl);
      log.info(`[error-sources] initiateOAuth:start sourceType=${sourceType}`);
      return oauthManager.initiateOAuth(sourceType, {
        pluginId,
        clientId:
          readOptionalTrimmed(payload.clientId) ??
          oauthConfigOverrides.oauthClientId,
        redirectUri:
          readOptionalTrimmed(payload.redirectUri) ??
          oauthConfigOverrides.oauthRedirectUri,
        baseUrl,
      });
    },

    "errorSources:completeOAuth": async (rawPayload: unknown) => {
      const payload = readCompleteOAuthPayload(rawPayload);
      const sourceType = readRequiredSourceType(
        payload.sourceType,
        "OAuth completion",
      );
      const code = payload.code.trim();
      const state = payload.state.trim();
      const pluginId = payload.pluginId.trim();
      const setupValues = readPayloadRecord(payload.setupValues) ?? {};
      const persistedSetup = await resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      );
      const oauthConfigOverrides = readOAuthConfigurationOverrides(
        persistedSetup.configuration,
      );
      const oauthBaseUrl = readOptionalTrimmed(
        persistedSetup.configuration.baseUrl,
      );

      log.info(`[error-sources] completeOAuth:start sourceType=${sourceType}`);
      const oauthClientId =
        readOptionalTrimmed(payload.clientId) ??
        oauthConfigOverrides.oauthClientId;
      const oauthClientSecret =
        readOptionalTrimmed(payload.clientSecret) ??
        oauthConfigOverrides.oauthClientSecret;
      const oauthRedirectUri =
        readOptionalTrimmed(payload.redirectUri) ??
        oauthConfigOverrides.oauthRedirectUri;

      if (!hasMatchingErrorSourcePlugin(pluginRuntime, pluginId, sourceType)) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${sourceType}`,
        );
      }

      const tokenResult = await oauthManager.completeOAuth(sourceType, {
        code,
        state,
        pluginId,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        redirectUri: oauthRedirectUri,
        baseUrl: oauthBaseUrl,
      });
      try {
        log.info("[error-sources] completeOAuth: token exchange succeeded");
        const accessToken = tokenResult.accessToken.trim();
        if (accessToken.length === 0) {
          throw new Error(`Failed to resolve ${sourceType} access token`);
        }

        const configuration = buildPluginOAuthConfiguration({
          persistedSetup,
          oauthClientId,
          oauthClientSecret,
          oauthRedirectUri,
        });
        const source = await sourcesRepository.create({
          sourceType,
          name:
            payload.name ??
            pluginRuntime.getPlugin(pluginId)?.name ??
            sourceType,
          additionalMetadata: mergeErrorSourceAdditionalMetadata(
            readPayloadRecord(payload.additionalMetadata),
            pluginId,
          ),
          accessTokenRef: accessToken,
          refreshTokenRef: tokenResult.refreshToken,
          expiresAt: tokenResult.expiresAt,
          grantedScopes: tokenResult.scopes,
          configuration,
          logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
          syncEnabled: payload.syncEnabled !== false,
          autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
        });
        log.info(
          `[error-sources] completeOAuth:success id=${source.id} type=${sourceType} plugin=${pluginId}`,
        );

        return {
          source: toRendererErrorSource(source),
          organizations: [],
          projects: [],
        };
      } catch (error) {
        log.error("[error-sources] completeOAuth:failed", error);
        throw error;
      }
    },

    "errorSources:testConnection": async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload);
      const sourceId = payload.id;
      log.info(`[error-sources] testConnection:start sourceId=${sourceId}`);
      const source = await sourcesRepository.findById(payload.id);
      if (source === null)
        throw new Error(`Error source ${payload.id} not found`);
      const pluginId = readSourcePluginId(source);
      const plugin = pluginRuntime.getPlugin(pluginId);

      if (plugin?.metadata?.dataSource?.sourceType !== source.sourceType) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${source.sourceType}`,
        );
      }

      const auth = await buildPluginAuthFromSource(source, pluginRuntime);
      const input = buildGenericPluginConnectionInput(source);

      try {
        if (hasErrorSourceProviderAction(plugin, "queryIssues")) {
          const result = await pluginRuntime.executeAction({
            pluginId,
            actionId: resolveErrorSourceProviderActionId({
              runtime: pluginRuntime,
              pluginId,
              sourceType: source.sourceType,
              action: "queryIssues",
            }),
            auth,
            input,
          });
          if (!result.ok) {
            throw new Error(result.summary);
          }
          const issueBatch = readPluginIssueBatch(result.data);
          const issueCount =
            issueBatch?.issues.length ?? readPluginIssueCount(result.data);
          return {
            success: true,
            provider: source.sourceType,
            organizationCount: readConfiguredOrganizationCount(
              source.configuration,
            ),
            projectCount: issueCount,
          };
        }

        if (hasErrorSourceProviderAction(plugin, "searchAlerts")) {
          const result = await pluginRuntime.executeAction({
            pluginId,
            actionId: resolveErrorSourceProviderActionId({
              runtime: pluginRuntime,
              pluginId,
              sourceType: source.sourceType,
              action: "searchAlerts",
            }),
            auth,
            input,
          });
          if (!result.ok) {
            throw new Error(result.summary);
          }
          const issueCount = readPluginIssueCount(result.data);
          return {
            success: true,
            provider: source.sourceType,
            organizationCount: readConfiguredOrganizationCount(
              source.configuration,
            ),
            projectCount: issueCount,
          };
        }

        if (hasErrorSourceProviderAction(plugin, "listOrganizations")) {
          const result = await pluginRuntime.executeAction({
            pluginId,
            actionId: resolveErrorSourceProviderActionId({
              runtime: pluginRuntime,
              pluginId,
              sourceType: source.sourceType,
              action: "listOrganizations",
            }),
            auth,
            input: {},
          });
          const organizations = readUnknownArray(result.data);
          return {
            success: true,
            provider: source.sourceType,
            organizationCount: organizations.length,
            projectCount: 0,
          };
        }
      } catch (error) {
        if (isMissingPluginAuthError(error)) {
          log.info(
            `[error-sources] testConnection:plugin sourceId=${source.id} missing plugin auth`,
          );
          return {
            success: false,
            provider: source.sourceType,
            organizationCount: 0,
            projectCount: 0,
          };
        }

        throw error;
      }

      throw new Error(
        `Error source plugin "${pluginId}" does not expose a connection test action`,
      );
    },

    "errorSources:triggerSync": async (rawPayload: unknown) => {
      const payload = triggerSyncPayloadSchema.parse(rawPayload);
      await syncRecovery;
      if (payload.id !== undefined && payload.id.length > 0) {
        log.info(`[error-sources] triggerSync:start sourceId=${payload.id}`);
        return syncService.syncSourceById(payload.id);
      }
      log.info("[error-sources] triggerSync:start all enabled sources");
      return syncService.syncAllEnabled();
    },

    "errorIssues:list": async (rawPayload: unknown) => {
      const payload = errorIssuesListPayloadSchema.parse(rawPayload);
      return issuesRepository.list({
        sourceId: payload.sourceId,
        status: payload.status,
        level: payload.level,
        projectIdentifier: payload.projectIdentifier,
        environment: payload.environment,
        limit: payload.limit,
        offset: payload.offset,
      });
    },

    "errorEvents:list": async (rawPayload: unknown) => {
      const payload = errorEventsListPayloadSchema.parse(rawPayload);
      return eventsRepository.list({
        sourceId: payload.sourceId,
        issueId: payload.issueId,
        level: payload.level,
        search: payload.search,
        limit: payload.limit,
        offset: payload.offset,
      });
    },

    "errorEvents:getOne": async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload);
      const event = await eventsRepository.findById(payload.id);
      if (event === null)
        throw new Error(`Error event ${payload.id} not found`);
      return event;
    },
  };
}
