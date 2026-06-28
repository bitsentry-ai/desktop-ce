import {
  DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT,
} from "./external-source-query.schemas";
import {
  formatPostHogExternalSourceQueryResults,
} from "./posthog-query-format";
import {
  normalizePostHogSearchQuery,
} from "./posthog-hogql";
import {
  formatSentryExternalSourceQueryResults,
} from "./sentry-query-format";
import {
  getProviderForSource,
} from "./desktop-posthog-provider-binding";
import {
  refreshSourceAccessToken,
  type DesktopOAuthRefreshProvider,
} from "./desktop-oauth-token-refresher";
import type {
  ErrorSource,
  ErrorSourceConfiguration,
  ErrorSourceType,
} from "./desktop-error-sources.types";
import {
  readConfiguredProjectIds,
  readConfiguredProjectSlugs,
  resolveSentryProjectSelection,
  type DesktopSentryProjectSummary,
} from "./desktop-sentry-project-selection";
import {
  createDesktopNodePluginRuntimeService,
} from "../plugins/desktop-plugin-runtime.node";
import type {
  DesktopPluginRuntimeService,
} from "../plugins/desktop-plugin-registry";
import type { DesktopPluginErrorSourceSetupField } from "../plugins/plugins.types";
import {
  isRunbookQueryPluginErrorSourceType,
} from "./plugin-backed-error-sources";
import { resolveErrorSourceProviderActionId } from "./desktop-plugin-error-source-actions";

export interface ExternalSourceRunbookQueryInput {
  sourceId: string;
  query: string;
  signal?: AbortSignal;
}

export interface ExternalSourceRunbookQueryExecutor {
  execute(input: ExternalSourceRunbookQueryInput): Promise<string>;
}

type SupportedExternalSource = ErrorSource & {
  sourceType: "sentry" | "posthog";
};

type WazuhExternalSource = ErrorSource & {
  sourceType: "wazuh";
};

type QueryIssuesResponse = {
  issues: unknown[];
  hasMore: boolean;
};

type DesktopExternalSourceProvider = DesktopOAuthRefreshProvider & {
  listProjects(input: {
    accessToken: string;
    orgSlug: string;
    signal?: AbortSignal;
  }): Promise<DesktopSentryProjectSummary[]>;
  queryIssues(input: {
    accessToken: string;
    orgSlug: string;
    projectIds: string[];
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<QueryIssuesResponse>;
};

type DesktopExternalSourceProviderFactory = {
  getProvider(
    sourceType: ErrorSourceType,
  ): DesktopExternalSourceProvider;
};

type DesktopExternalSourceSourcesRepository = {
  findById(id: string): Promise<ErrorSource | null>;
  update(input: {
    id: string;
    accessTokenRef?: string | null;
    refreshTokenRef?: string | null;
    expiresAt?: string | null;
    grantedScopes?: string[];
    configuration?: ErrorSourceConfiguration;
  }): Promise<unknown>;
};

function readQueryInput(input: ExternalSourceRunbookQueryInput): {
  sourceId: string;
  query: string;
} {
  const sourceId = input.sourceId.trim();
  const query = input.query.trim();

  if (sourceId.length === 0) {
    throw new Error("External Source action is missing a selected source");
  }
  if (query.length === 0) {
    throw new Error("External Source action is missing a query");
  }

  return { sourceId, query };
}

function isSupportedExternalSource(
  source: ErrorSource,
): source is SupportedExternalSource {
  return (
    isRunbookQueryPluginErrorSourceType(source.sourceType) &&
    source.sourceType !== "wazuh"
  );
}

function isWazuhExternalSource(
  source: ErrorSource,
): source is WazuhExternalSource {
  return source.sourceType === "wazuh";
}

function requireSupportedSource(source: ErrorSource): SupportedExternalSource {
  if (isSupportedExternalSource(source)) {
    return source;
  }

  throw new Error(
    `External Source provider ${source.sourceType} is not supported yet`,
  );
}

function readOrgSlug(source: ErrorSource): string {
  const orgSlug = source.configuration.orgSlug?.trim();
  if (orgSlug === undefined || orgSlug.length === 0) {
    throw new Error(
      `External Source "${source.name}" is missing configuration.orgSlug`,
    );
  }

  return orgSlug;
}

function normalizeQuery(
  source: SupportedExternalSource,
  query: string,
): string {
  if (source.sourceType === "posthog") {
    return normalizePostHogSearchQuery(query);
  }

  return query;
}

function normalizeIssues(issues: unknown): unknown[] {
  if (Array.isArray(issues)) {
    return issues;
  }

  return [];
}

function readConfiguredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readWazuhIndexPattern(
  configuration: ErrorSourceConfiguration,
): string | undefined {
  const configuredIndexPatterns = readConfiguredStringArray(
    configuration.indexPatterns,
  );
  if (configuredIndexPatterns.length > 0) {
    return configuredIndexPatterns.join(",");
  }

  const fallbackProjectSlugs = readConfiguredStringArray(
    configuration.projectSlugs,
  );
  if (fallbackProjectSlugs.length > 0) {
    return fallbackProjectSlugs.join(",");
  }

  return undefined;
}

function buildWazuhPluginAuth(
  source: WazuhExternalSource,
): Record<string, unknown> {
  const auth: Record<string, unknown> = {};
  const indexUrl = source.configuration.baseUrl?.trim();
  if (indexUrl !== undefined && indexUrl.length > 0) {
    auth.indexUrl = indexUrl.replace(/\/+$/, "");
  }

  const indexPassword = source.accessTokenRef?.trim();
  if (indexPassword !== undefined && indexPassword.length > 0) {
    auth.indexPassword = indexPassword;
  }

  return auth;
}

function readSourcePluginId(source: ErrorSource): string {
  const pluginId = source.additionalMetadata?.pluginId;
  if (typeof pluginId === "string" && pluginId.trim().length > 0) {
    return pluginId.trim();
  }

  return source.sourceType;
}

function readPluginOutput(data: unknown): string {
  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as { output?: unknown }).output === "string"
  ) {
    return ((data as { output: string }).output).trim();
  }

  throw new Error("External Source Wazuh plugin returned no output");
}

function readPluginErrorSourceSetupFields(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
): DesktopPluginErrorSourceSetupField[] {
  return (
    pluginRuntime.getPlugin(pluginId)?.metadata?.errorSource?.setupFields ?? []
  );
}

function buildPluginAuthFromSource(
  source: ErrorSource,
  pluginRuntime: DesktopPluginRuntimeService,
): Record<string, unknown> {
  const pluginId = readSourcePluginId(source);
  const auth: Record<string, unknown> = {};
  const accessToken = source.accessTokenRef?.trim();

  for (const field of readPluginErrorSourceSetupFields(pluginRuntime, pluginId)) {
    if (field.storage === "accessTokenRef") {
      if (accessToken !== undefined && accessToken.length > 0) {
        auth[field.key] = accessToken;
      }
      continue;
    }

    const configurationKey = field.configurationKey ?? field.key;
    const value = (source.configuration as Record<string, unknown>)[configurationKey];
    if (value === undefined) {
      continue;
    }

    auth[field.key] = value;
    if (configurationKey !== field.key) {
      auth[configurationKey] = value;
    }
  }

  return auth;
}

function buildGenericPluginQueryInput(
  source: ErrorSource,
  query: string,
  limit: number,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    query,
    limit,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
  };

  const orgSlug = source.configuration.orgSlug?.trim();
  if (orgSlug !== undefined && orgSlug.length > 0) {
    input.orgSlug = orgSlug;
  }

  const configuredProjectIds = readConfiguredStringArray(
    source.configuration.projectIds,
  );
  if (configuredProjectIds.length > 0) {
    input.projectIds = configuredProjectIds;
  }

  const configuredProjectSlugs = readConfiguredStringArray(
    source.configuration.projectSlugs,
  );
  if (configuredProjectSlugs.length > 0) {
    input.projectSlugs = configuredProjectSlugs;
  }

  const indexPattern = readWazuhIndexPattern(source.configuration);
  if (indexPattern !== undefined) {
    input.indexPattern = indexPattern;
  }

  return input;
}

function readPluginIssueBatch(data: unknown): {
  issues: unknown[];
  hasMore: boolean;
} | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const rawIssues = (data as { issues?: unknown }).issues;
  const issues = Array.isArray(rawIssues) ? rawIssues : null;
  if (issues === null) {
    return null;
  }

  return {
    issues,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  };
}

function formatGenericPluginQueryResults(input: {
  source: ErrorSource;
  query: string;
  issues: unknown[];
  hasMore: boolean;
  limit: number;
}): string {
  const lines = [
    `Source: ${input.source.name} (${input.source.sourceType})`,
    `Query: ${input.query}`,
    `Results: ${String(input.issues.length)}${input.hasMore ? "+" : ""}`,
  ];

  for (const [index, issue] of input.issues.slice(0, input.limit).entries()) {
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
      lines.push(`${String(index + 1)}. ${JSON.stringify(issue)}`);
      continue;
    }

    const record = issue as Record<string, unknown>;
    const title =
      (typeof record.title === "string" && record.title.trim().length > 0
        ? record.title.trim()
        : typeof record.message === "string" && record.message.trim().length > 0
          ? record.message.trim()
          : typeof record.name === "string" && record.name.trim().length > 0
            ? record.name.trim()
            : `Item ${String(index + 1)}`);
    const identifier =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : typeof record.issueId === "string" && record.issueId.trim().length > 0
          ? record.issueId.trim()
          : null;
    const project =
      typeof record.projectIdentifier === "string" &&
      record.projectIdentifier.trim().length > 0
        ? record.projectIdentifier.trim()
        : typeof record.projectId === "string" && record.projectId.trim().length > 0
          ? record.projectId.trim()
          : null;

    const fragments = [title];
    if (identifier !== null) {
      fragments.push(`#${identifier}`);
    }
    if (project !== null) {
      fragments.push(`project=${project}`);
    }
    lines.push(`${String(index + 1)}. ${fragments.join(" - ")}`);
  }

  return lines.join("\n");
}

function executeCustomPluginQuery(args: {
  source: ErrorSource;
  query: string;
  limit: number;
  pluginRuntime: DesktopPluginRuntimeService;
}): Promise<{
  output?: string;
  issues?: unknown[];
  hasMore?: boolean;
}> {
  const { source, query, limit, pluginRuntime } = args;
  const pluginId = readSourcePluginId(source);
  const plugin = pluginRuntime.getPlugin(pluginId);
  const metadata = plugin?.metadata?.errorSource;
  if (metadata?.sourceType !== source.sourceType) {
    throw new Error(
      `External Source plugin "${pluginId}" does not match source type ${source.sourceType}`,
    );
  }

  const auth = buildPluginAuthFromSource(source, pluginRuntime);
  const input = buildGenericPluginQueryInput(source, query, limit);
  const providerActions = metadata.providerActions;

  if (providerActions?.queryIssues !== undefined) {
    return pluginRuntime.executeAction({
      pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: pluginRuntime,
        pluginId,
        sourceType: source.sourceType,
        action: "queryIssues",
      }),
      auth,
      input,
    }).then((result) => {
      const output = (
        result.data !== null &&
        typeof result.data === "object" &&
        !Array.isArray(result.data) &&
        typeof (result.data as { output?: unknown }).output === "string"
      )
        ? ((result.data as { output: string }).output.trim())
        : undefined;
      const page = readPluginIssueBatch(result.data);
      return {
        output,
        issues: page?.issues,
        hasMore: page?.hasMore,
      };
    });
  }

  if (providerActions?.searchAlerts !== undefined) {
    return pluginRuntime.executeAction({
      pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: pluginRuntime,
        pluginId,
        sourceType: source.sourceType,
        action: "searchAlerts",
      }),
      auth,
      input,
    }).then((result) => ({
      output: readPluginOutput(result.data),
    }));
  }

  throw new Error(
    `External Source provider ${source.sourceType} does not declare a query action yet`,
  );
}

export class ExternalSourceRunbookQueryService
  implements ExternalSourceRunbookQueryExecutor
{
  constructor(
    private readonly sourcesRepository: DesktopExternalSourceSourcesRepository,
    private readonly providerFactory: DesktopExternalSourceProviderFactory,
    private readonly options?: { defaultLimit?: number },
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
  ) {}

  async execute(input: ExternalSourceRunbookQueryInput): Promise<string> {
    const { sourceId, query } = readQueryInput(input);

    const source = await this.sourcesRepository.findById(sourceId);
    if (source === null) {
      throw new Error(`Selected external source ${sourceId} was not found`);
    }

    if (!isRunbookQueryPluginErrorSourceType(source.sourceType)) {
      const customQuery = await executeCustomPluginQuery({
        source,
        query,
        limit: this.options?.defaultLimit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT,
        pluginRuntime: this.pluginRuntime,
      });
      if (typeof customQuery.output === "string" && customQuery.output.length > 0) {
        return customQuery.output;
      }

      return formatGenericPluginQueryResults({
        source,
        query,
        issues: customQuery.issues ?? [],
        hasMore: customQuery.hasMore === true,
        limit: this.options?.defaultLimit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT,
      });
    }

    if (isWazuhExternalSource(source)) {
      return this.executeWazuhQuery(source, query);
    }

    const supportedSource = requireSupportedSource(source);
    const normalizedQuery = normalizeQuery(supportedSource, query);
    const orgSlug = readOrgSlug(supportedSource);

    const token = await this.resolveAccessToken(supportedSource, input.signal);
    const provider = getProviderForSource(this.providerFactory, supportedSource);
    const projectIds = await this.resolveProjectIds(
      supportedSource,
      token,
      orgSlug,
      input.signal,
    );
    const limit =
      this.options?.defaultLimit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT;
    const page = await provider.queryIssues({
      accessToken: token,
      orgSlug,
      projectIds,
      query: normalizedQuery,
      limit,
      signal: input.signal,
    });

    return this.formatOutput({
      source: supportedSource,
      query: normalizedQuery,
      issues: normalizeIssues(page.issues),
      hasMore: page.hasMore,
      limit,
    });
  }

  private async executeWazuhQuery(
    source: WazuhExternalSource,
    query: string,
  ): Promise<string> {
    const limit =
      this.options?.defaultLimit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT;
    const indexPattern = readWazuhIndexPattern(source.configuration);
    const pluginId = readSourcePluginId(source);
    const result = await this.pluginRuntime.executeAction({
      pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: this.pluginRuntime,
        pluginId,
        sourceType: source.sourceType,
        action: "searchAlerts",
      }),
      auth: buildWazuhPluginAuth(source),
      input: {
        query,
        limit,
        ...(indexPattern === undefined ? {} : { indexPattern }),
      },
    });

    return readPluginOutput(result.data);
  }

  private async resolveAccessToken(
    source: SupportedExternalSource,
    signal?: AbortSignal,
  ): Promise<string> {
    return refreshSourceAccessToken({
      source: source,
      sourcesRepository: this.sourcesRepository,
      providerFactory: this.providerFactory,
      signal,
    });
  }

  private async resolveProjectIds(
    source: SupportedExternalSource,
    accessToken: string,
    orgSlug: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const configuredProjectIds = readConfiguredProjectIds(source.configuration);
    if (configuredProjectIds.length > 0) {
      return configuredProjectIds;
    }

    const configuredProjectSlugs = readConfiguredProjectSlugs(
      source.configuration,
    );
    if (configuredProjectSlugs.length === 0) {
      return [];
    }

    const provider = getProviderForSource(this.providerFactory, source);
    const projects = await provider.listProjects({
      accessToken,
      orgSlug,
      signal,
    });
    const resolvedProjects = resolveSentryProjectSelection(projects, {
      projectSlugs: configuredProjectSlugs,
    });

    if (resolvedProjects.projectIds.length === 0) {
      throw new Error(
        `External Source "${source.name}" has Sentry project slugs that could not be resolved to numeric project IDs`,
      );
    }

    await this.sourcesRepository.update({
      id: source.id,
      configuration: {
        ...source.configuration,
        projectIds: resolvedProjects.projectIds,
        projectSlugs: resolvedProjects.projectSlugs,
        projectNames: resolvedProjects.projectNames,
      },
    });

    source.configuration = {
      ...source.configuration,
      projectIds: resolvedProjects.projectIds,
      projectSlugs: resolvedProjects.projectSlugs,
      projectNames: resolvedProjects.projectNames,
    };

    return resolvedProjects.projectIds;
  }

  private formatOutput(input: {
    source: ErrorSource;
    query: string;
    issues: unknown[];
    hasMore: boolean;
    limit: number;
  }): string {
    if (input.source.sourceType === "posthog") {
      return formatPostHogExternalSourceQueryResults({
        sourceName: input.source.name,
        sourceType: input.source.sourceType,
        query: input.query,
        issues: input.issues,
        hasMore: input.hasMore,
        limit: input.limit,
      });
    }
    return formatSentryExternalSourceQueryResults({
      sourceName: input.source.name,
      sourceType: input.source.sourceType,
      query: input.query,
      issues: input.issues,
      hasMore: input.hasMore,
      limit: input.limit,
    });
  }
}
