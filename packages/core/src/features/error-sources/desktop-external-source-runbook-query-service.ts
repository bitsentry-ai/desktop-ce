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
import type { DesktopPluginErrorSourceSetupField } from "../plugins/plugins.types";
import { resolveErrorSourceProviderActionId } from "./desktop-plugin-error-source-actions";

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

  const fallbackProjectSlugs = readConfiguredStringArray(
    configuration.projectSlugs,
  );
  if (fallbackProjectSlugs.length > 0) {
    return fallbackProjectSlugs.join(",");
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
        auth.accessToken = accessToken;
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
      const page = readPluginIssueBatch(result.data);
      return {
        output: readOptionalPluginOutput(result.data),
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
    providerFactory: unknown,
    private readonly options?: { defaultLimit?: number },
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
  ) {
    void providerFactory;
  }

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
      limit,
    });
  }
}
