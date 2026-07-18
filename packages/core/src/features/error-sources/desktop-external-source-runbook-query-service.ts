import {
  DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT,
} from "./external-source-query.schemas";
import type {
  ErrorSource,
  ErrorSourceConfiguration,
} from "./desktop-error-sources.types";
import {
  createDesktopNodePluginRuntimeService,
} from "../plugins/desktop-plugin-runtime.node";
import type {
  DesktopPluginRuntimeService,
} from "../plugins/desktop-plugin-registry";
import type { DesktopPluginDataSourceRecord } from "../plugins/plugins.types";
import {
  hasErrorSourceProviderAction,
  resolveErrorSourceProviderActionId,
} from "./desktop-plugin-error-source-actions";
import { refreshSourceAccessToken } from "./desktop-oauth-token-refresher";

export interface ExternalSourceRunbookQueryInput {
  sourceId: string;
  query: string;
  signal?: AbortSignal;
}

export interface ExternalSourceRunbookQueryExecutor {
  execute(input: ExternalSourceRunbookQueryInput): Promise<string>;
}

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

function readConfiguredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readPluginIndexPattern(
  configuration: ErrorSourceConfiguration,
): string | undefined {
  const configuredIndexPatterns = readConfiguredStringArray(
    configuration.indexPatterns,
  );
  if (configuredIndexPatterns.length > 0) {
    return configuredIndexPatterns.join(",");
  }

  return undefined;
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

  throw new Error("External Source code plugin returned no output");
}

function pluginSourceRecord(source: ErrorSource): DesktopPluginDataSourceRecord {
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

function buildPluginAuthFromSource(
  source: ErrorSource,
  pluginRuntime: DesktopPluginRuntimeService,
): Promise<Record<string, unknown>> {
  const pluginId = readSourcePluginId(source);
  return pluginRuntime.buildErrorSourceAuth({
    pluginId,
    source: pluginSourceRecord(source),
  });
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

  const indexPattern = readPluginIndexPattern(source.configuration);
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
  if (!Array.isArray(rawIssues)) {
    return null;
  }

  return {
    issues: rawIssues,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  };
}

function readTrimmedRecordString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function readFirstTrimmedRecordString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readTrimmedRecordString(record, key);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function readGenericPluginIssueTitle(
  record: Record<string, unknown>,
  index: number,
): string {
  const title = readFirstTrimmedRecordString(record, [
    "title",
    "message",
    "name",
  ]);
  if (title !== null) {
    return title;
  }

  return `Item ${String(index + 1)}`;
}

function formatGenericPluginIssueLine(issue: unknown, index: number): string {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    return `${String(index + 1)}. ${JSON.stringify(issue)}`;
  }

  const record = issue as Record<string, unknown>;
  const fragments = [readGenericPluginIssueTitle(record, index)];
  const identifier = readFirstTrimmedRecordString(record, ["id", "issueId"]);
  if (identifier !== null) {
    fragments.push(`#${identifier}`);
  }

  const project = readFirstTrimmedRecordString(record, [
    "projectIdentifier",
    "projectId",
  ]);
  if (project !== null) {
    fragments.push(`project=${project}`);
  }

  return `${String(index + 1)}. ${fragments.join(" - ")}`;
}

function readOptionalPluginOutput(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const output = (data as { output?: unknown }).output;
  if (typeof output !== "string") {
    return undefined;
  }

  const normalized = output.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function formatGenericPluginQueryResults(input: {
  source: ErrorSource;
  query: string;
  issues: unknown[];
  hasMore: boolean;
  limit: number;
}): string {
  let resultCount = String(input.issues.length);
  if (input.hasMore) {
    resultCount = `${resultCount}+`;
  }

  const lines = [
    `Source: ${input.source.name} (${input.source.sourceType})`,
    `Query: ${input.query}`,
    `Results: ${resultCount}`,
  ];

  for (const [index, issue] of input.issues.slice(0, input.limit).entries()) {
    lines.push(formatGenericPluginIssueLine(issue, index));
  }

  return lines.join("\n");
}

async function executeCustomPluginQuery(args: {
  source: ErrorSource;
  query: string;
  limit: number;
  sourcesRepository: DesktopExternalSourceSourcesRepository;
  pluginRuntime: DesktopPluginRuntimeService;
  signal?: AbortSignal;
}): Promise<{
  output?: string;
  issues?: unknown[];
  hasMore?: boolean;
}> {
  const { source, query, limit, sourcesRepository, pluginRuntime, signal } =
    args;
  const pluginId = readSourcePluginId(source);
  const plugin = pluginRuntime.getPlugin(pluginId);
  const metadata = plugin?.metadata?.dataSource;
  if (plugin === null || metadata?.sourceType !== source.sourceType) {
    throw new Error(
      `External Source plugin "${pluginId}" does not match source type ${source.sourceType}`,
    );
  }

  const accessTokenRef = await refreshSourceAccessToken({
    source,
    sourcesRepository,
    pluginRuntime,
    signal,
  });
  const refreshedSource = { ...source, accessTokenRef };
  const auth = await buildPluginAuthFromSource(refreshedSource, pluginRuntime);
  const input = buildGenericPluginQueryInput(refreshedSource, query, limit);

  if (hasErrorSourceProviderAction(plugin, "queryIssues")) {
    const request = {
      pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: pluginRuntime,
        pluginId,
        sourceType: source.sourceType,
        action: "queryIssues",
      }),
      auth,
      input,
    };
    const execution = signal === undefined
      ? pluginRuntime.executeAction(request)
      : pluginRuntime.executeAction(request, { signal });

    return execution.then((result) => {
      if (!result.ok) {
        throw new Error(
          `Plugin "${pluginId}" failed to query issues for external source "${source.name}": ${result.summary}`,
        )
      }

      const page = readPluginIssueBatch(result.data);
      return {
        output: readOptionalPluginOutput(result.data),
        issues: page?.issues,
        hasMore: page?.hasMore,
      };
    });
  }

  if (hasErrorSourceProviderAction(plugin, "searchAlerts")) {
    const request = {
      pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: pluginRuntime,
        pluginId,
        sourceType: source.sourceType,
        action: "searchAlerts",
      }),
      auth,
      input,
    };
    const execution = signal === undefined
      ? pluginRuntime.executeAction(request)
      : pluginRuntime.executeAction(request, { signal });

    return execution.then((result) => {
      if (!result.ok) {
        throw new Error(
          `Plugin "${pluginId}" failed to search alerts for external source "${source.name}": ${result.summary}`,
        )
      }

      return {
        output: readPluginOutput(result.data),
      };
    });
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
    private readonly options?: { defaultLimit?: number },
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
  ) {}

  async execute(input: ExternalSourceRunbookQueryInput): Promise<string> {
    const { sourceId, query } = readQueryInput(input);

    const source = await this.sourcesRepository.findById(sourceId);
    if (source === null) {
      throw new Error(`Selected external source ${sourceId} was not found`);
    }

    const limit =
      this.options?.defaultLimit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT;
    const customQuery = await executeCustomPluginQuery({
      source,
      query,
      limit,
      sourcesRepository: this.sourcesRepository,
      pluginRuntime: this.pluginRuntime,
      signal: input.signal,
    });
    if (typeof customQuery.output === "string" && customQuery.output.length > 0) {
      return customQuery.output;
    }

    return formatGenericPluginQueryResults({
      source,
      query,
      issues: customQuery.issues ?? [],
      hasMore: customQuery.hasMore === true,
      limit,
    });
  }
}
