import { z, type ZodType } from "zod";
import type {
  DesktopPluginActionDefinition,
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
  DesktopPluginManifest,
} from "./plugins.types";
import {
  desktopPluginExecutionRequestSchema,
  desktopPluginExecutionResultSchema,
  desktopPluginManifestSchema,
} from "./plugins.types";
import {
  SentryProviderAdapter,
} from "../error-sources/desktop-sentry-provider.adapter";
import {
  PostHogProviderAdapter,
} from "../error-sources/desktop-posthog-provider.adapter";
import type {
  DesktopLocalPluginAction,
  LoadedDesktopLocalPlugin,
} from "./desktop-local-plugin-loader";
import { githubScaffold } from "./generated/stackstorm-github.scaffold";

type PluginActionRuntime = {
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  referencePath?: string;
  inputSchema: ZodType<Record<string, unknown>>;
  execute(input: {
    auth: Record<string, unknown>;
    input: Record<string, unknown>;
  }): Promise<DesktopPluginExecutionResult>;
};

type PluginRuntime = {
  manifest: DesktopPluginManifest;
  actions: Map<string, PluginActionRuntime>;
};

type TemplateContext = {
  auth: Record<string, unknown>;
  input: Record<string, unknown>;
};

const githubScaffoldActions = new Map(
  githubScaffold.actions.map((action) => [action.id, action] as const),
);
const githubScaffoldTriggers = new Map(
  githubScaffold.triggers.map((trigger) => [trigger.id, trigger] as const),
);
const githubManifestTriggerToScaffoldTriggerId: Record<string, string> = {
  repository_event: "repository_event",
  deployment_event: "deploy_pack_on_deployment_event",
};

function githubScaffoldActionReferencePath(actionId: string): string {
  const action = githubScaffoldActions.get(actionId);
  if (action === undefined) {
    throw new Error(
      `Missing StackStorm GitHub scaffold action metadata for "${actionId}".`,
    );
  }

  return action.referencePath;
}

function githubScaffoldTriggerReferencePath(triggerId: string): string {
  const scaffoldTriggerId =
    githubManifestTriggerToScaffoldTriggerId[triggerId] ?? triggerId;
  const trigger = githubScaffoldTriggers.get(scaffoldTriggerId);
  if (trigger === undefined) {
    throw new Error(
      `Missing StackStorm GitHub scaffold trigger metadata for "${triggerId}".`,
    );
  }

  return trigger.referencePath;
}

function buildPluginInputSchema(
  fields: DesktopPluginFieldDefinition[],
): ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    let schema: z.ZodTypeAny;
    switch (field.type) {
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "json":
        schema = z.unknown();
        break;
      case "string_array":
        schema = z.array(z.string());
        break;
      case "string":
      default:
        schema = z.string();
        break;
    }

    if (field.type === "string" && field.enumValues !== undefined) {
      schema = schema.refine(
        (value) => typeof value === "string" && field.enumValues?.includes(value) === true,
        {
          message: `${field.label} must be one of: ${field.enumValues.join(", ")}.`,
        },
      );
    }

    if (field.defaultValue !== undefined) {
      schema = schema.default(field.defaultValue);
    } else if (!field.required) {
      schema = schema.optional();
    }

    shape[field.key] = schema;
  }

  return z.object(shape).passthrough();
}

function lookupTemplateValue(
  expression: string,
  context: TemplateContext,
): unknown {
  const segments = expression
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`Invalid template expression: ${expression}`);
  }

  const [scope, ...pathSegments] = segments;
  let current: unknown;
  if (scope === "auth") {
    current = context.auth;
  } else if (scope === "input") {
    current = context.input;
  } else {
    throw new Error(`Unsupported template scope: ${scope}`);
  }

  for (const segment of pathSegments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      throw new Error(`Missing template value for ${expression}`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined) {
    throw new Error(`Missing template value for ${expression}`);
  }

  return current;
}

const templatePattern = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;

function renderTemplateString(
  template: string,
  context: TemplateContext,
): unknown {
  const exactMatch = template.match(/^{{\s*([a-zA-Z0-9_.-]+)\s*}}$/);
  if (exactMatch !== null) {
    return lookupTemplateValue(exactMatch[1] ?? "", context);
  }

  return template.replaceAll(templatePattern, (_match, expression: string) => {
    const value = lookupTemplateValue(expression, context);
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return String(value);
    }

    return JSON.stringify(value);
  });
}

function renderTemplateValue(
  template: unknown,
  context: TemplateContext,
): unknown {
  if (typeof template === "string") {
    return renderTemplateString(template, context);
  }

  if (Array.isArray(template)) {
    return template.map((item) => renderTemplateValue(item, context));
  }

  if (template !== null && typeof template === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      output[key] = renderTemplateValue(value, context);
    }
    return output;
  }

  return template;
}

function isMissingTemplateValueError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Missing template value for ");
}

function renderTransportTemplateValue(
  template: unknown,
  context: TemplateContext,
): unknown {
  if (typeof template === "string") {
    try {
      return renderTemplateString(template, context);
    } catch (error) {
      if (isMissingTemplateValueError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  if (Array.isArray(template)) {
    return template
      .map((item) => renderTransportTemplateValue(item, context))
      .filter((item) => item !== undefined);
  }

  if (template !== null && typeof template === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const rendered = renderTransportTemplateValue(value, context);
      if (rendered !== undefined) {
        output[key] = rendered;
      }
    }
    return output;
  }

  return template;
}

function appendPluginQuery(
  url: URL,
  query: Record<string, string> | undefined,
  context: TemplateContext,
): void {
  if (query === undefined) {
    return;
  }

  for (const [key, template] of Object.entries(query)) {
    const value = renderTransportTemplateValue(template, context);
    if (value === null || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.append(key, String(value));
  }
}

function readPathValue(payload: unknown, path: string): unknown {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let current = payload;

  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolveSameOriginNextUrl(nextUrl: unknown, currentUrl: URL): URL | null {
  if (typeof nextUrl !== "string" || nextUrl.trim().length === 0) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(nextUrl, currentUrl);
  } catch {
    throw new Error(`Cannot resolve next URL: "${String(nextUrl)}" is not a URL`);
  }

  if (resolved.origin !== currentUrl.origin) {
    throw new Error(
      `Refusing to follow cross-origin pagination URL: "${resolved.origin}" != "${currentUrl.origin}"`,
    );
  }

  return resolved;
}

async function parseHttpPluginResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as unknown;
  }

  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  return text;
}

function summarizeHttpPluginError(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }

  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  return `HTTP plugin request failed with status ${String(status)}`;
}

function parseGitHubError(payload: unknown, fallbackStatus: number): string {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  return `GitHub request failed with status ${String(fallbackStatus)}`;
}

function readTrimmedString(
  value: unknown,
  field: string,
  { required = false }: { required?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") {
    if (required) {
      throw new Error(`${field} must be a string`);
    }
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    if (required) {
      throw new Error(`${field} is required`);
    }
    return undefined;
  }
  return normalized;
}

function readRequiredTrimmedString(value: unknown, field: string): string {
  return readTrimmedString(value, field, { required: true }) as string;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  throw new Error(`${field} must be a number`);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Expected an array of strings");
  }

  const out: string[] = [];
  for (const item of value) {
    const normalized = readTrimmedString(item, "array item");
    if (normalized !== undefined) {
      out.push(normalized);
    }
  }
  return out;
}

function readOptionalJsonRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return readOptionalJsonRecord(parsed, field);
    } catch (error) {
      throw new Error(
        `${field} must be valid JSON when provided as a string: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${field} must be a JSON object`);
}

function readOptionalJsonArray(
  value: unknown,
  field: string,
): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return readOptionalJsonArray(parsed, field);
    } catch (error) {
      throw new Error(
        `${field} must be valid JSON when provided as a string: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`${field} must be an array`);
}

function appendPath(basePath: string, child: string | undefined): string {
  if (child === undefined || child.length === 0) {
    return basePath;
  }

  const normalizedChild = child
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${basePath}/${normalizedChild}`;
}

function buildQueryString(
  query: Record<string, string | number | boolean | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
      continue;
    }

    params.set(key, String(value));
  }
  const text = params.toString();
  return text.length === 0 ? "" : `?${text}`;
}

class GitHubApiClient {
  private readonly token?: string;
  private readonly baseUrl: string;

  constructor(auth: Record<string, unknown>) {
    this.token = readTrimmedString(auth.token, "token");
    const configuredBaseUrl = readTrimmedString(auth.baseUrl, "baseUrl");
    if (configuredBaseUrl === undefined) {
      this.baseUrl = "https://api.github.com";
      return;
    }

    const parsed = new URL(configuredBaseUrl);
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
  }

  async request(input: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | string[] | undefined>;
    body?: Record<string, unknown> | undefined;
    accept?: string;
  }): Promise<{ status: number; data: unknown }> {
    const url = `${this.baseUrl}${input.path}${buildQueryString(
      input.query ?? {},
    )}`;
    const headers: Record<string, string> = {
      Accept: input.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (this.token !== undefined) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const raw = await response.text();
    let data: unknown = null;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw) as unknown;
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      throw new Error(parseGitHubError(data, response.status));
    }

    return {
      status: response.status,
      data,
    };
  }
}

function repoFields(): DesktopPluginFieldDefinition[] {
  return [
    {
      key: "owner",
      label: "Owner",
      description: "GitHub user or organization that owns the repository.",
      type: "string",
      required: true,
    },
    {
      key: "repo",
      label: "Repository",
      description: "Repository name.",
      type: "string",
      required: true,
    },
  ];
}

function paginationFields(): DesktopPluginFieldDefinition[] {
  return [
    {
      key: "page",
      label: "Page",
      description: "Optional page number for paginated GitHub endpoints.",
      type: "number",
      required: false,
    },
    {
      key: "perPage",
      label: "Per Page",
      description: "Optional page size for paginated GitHub endpoints.",
      type: "number",
      required: false,
    },
  ];
}

function githubAction(input: {
  pluginId?: string;
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  referencePath?: string;
  inputSchema: ZodType<Record<string, unknown>>;
  execute(context: {
    client: GitHubApiClient;
    input: Record<string, unknown>;
  }): Promise<{ status: number; summary: string; data: unknown }>;
}): PluginActionRuntime {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel,
    fields: input.fields,
    referencePath: input.referencePath ?? githubScaffoldActionReferencePath(input.id),
    inputSchema: input.inputSchema,
    async execute(request) {
      const validatedInput = input.inputSchema.parse(request.input);
      const result = await input.execute({
        client: new GitHubApiClient(request.auth),
        input: validatedInput,
      });

      return desktopPluginExecutionResultSchema.parse({
        pluginId: input.pluginId ?? "github",
        actionId: input.id,
        ok: true,
        status: result.status,
        summary: result.summary,
        data: result.data,
      });
    },
  };
}

function pluginActionRuntime<TContext>(input: {
  pluginId: string;
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  referencePath?: string;
  inputSchema: ZodType<Record<string, unknown>>;
  createContext(auth: Record<string, unknown>): TContext;
  execute(context: {
    context: TContext;
    input: Record<string, unknown>;
  }): Promise<{ status: number; summary: string; data: unknown }>;
}): PluginActionRuntime {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel,
    fields: input.fields,
    referencePath: input.referencePath,
    inputSchema: input.inputSchema,
    async execute(request) {
      const validatedInput = input.inputSchema.parse(request.input);
      const result = await input.execute({
        context: input.createContext(request.auth),
        input: validatedInput,
      });

      return desktopPluginExecutionResultSchema.parse({
        pluginId: input.pluginId,
        actionId: input.id,
        ok: true,
        status: result.status,
        summary: result.summary,
        data: result.data,
      });
    },
  };
}

function sentryAction(input: {
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  inputSchema: ZodType<Record<string, unknown>>;
  execute(context: {
    provider: SentryProviderAdapter;
    accessToken: string;
    input: Record<string, unknown>;
  }): Promise<{ status: number; summary: string; data: unknown }>;
}): PluginActionRuntime {
  return pluginActionRuntime({
    pluginId: "sentry",
    id: input.id,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel,
    fields: input.fields,
    inputSchema: input.inputSchema,
    createContext(auth) {
      const accessToken = readRequiredTrimmedString(
        auth.accessToken,
        "accessToken",
      );

      return {
        provider: new SentryProviderAdapter(),
        accessToken,
      };
    },
    async execute({ context, input: validatedInput }) {
      return input.execute({
        provider: context.provider,
        accessToken: context.accessToken,
        input: validatedInput,
      });
    },
  });
}

function postHogAction(input: {
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  inputSchema: ZodType<Record<string, unknown>>;
  execute(context: {
    provider: PostHogProviderAdapter;
    accessToken: string;
    input: Record<string, unknown>;
  }): Promise<{ status: number; summary: string; data: unknown }>;
}): PluginActionRuntime {
  return pluginActionRuntime({
    pluginId: "posthog",
    id: input.id,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel,
    fields: input.fields,
    inputSchema: input.inputSchema,
    createContext(auth) {
      const accessToken = readRequiredTrimmedString(
        auth.accessToken,
        "accessToken",
      );
      const baseUrl = readTrimmedString(auth.baseUrl, "baseUrl");

      return {
        provider: new PostHogProviderAdapter({
          apiBase: baseUrl,
        }),
        accessToken,
      };
    },
    async execute({ context, input: validatedInput }) {
      return input.execute({
        provider: context.provider,
        accessToken: context.accessToken,
        input: validatedInput,
      });
    },
  });
}

const wazuhSearchResponseSchema = z.object({
  hits: z.object({
    total: z.object({
      value: z.number().int().nonnegative(),
    }),
    hits: z.array(z.record(z.string(), z.unknown())),
  }),
});

function readWazuhIndexPattern(value: unknown): string {
  if (typeof value !== "string") {
    return "wazuh-alerts-*";
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return "wazuh-alerts-*";
  }

  return normalized;
}

function readWazuhLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function readWazuhOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function getWazuhSearchDescription(hit: Record<string, unknown>): string {
  const source =
    hit._source !== null &&
    typeof hit._source === "object" &&
    !Array.isArray(hit._source)
      ? (hit._source as Record<string, unknown>)
      : {};
  const rule =
    source.rule !== null &&
    typeof source.rule === "object" &&
    !Array.isArray(source.rule)
      ? (source.rule as Record<string, unknown>)
      : {};

  const description = rule.description;
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim();
  }

  const fullLog = source.full_log;
  if (typeof fullLog === "string" && fullLog.trim().length > 0) {
    return fullLog.trim().slice(0, 120);
  }

  return "No description";
}

function getWazuhAgentName(hit: Record<string, unknown>): string {
  const source =
    hit._source !== null &&
    typeof hit._source === "object" &&
    !Array.isArray(hit._source)
      ? (hit._source as Record<string, unknown>)
      : {};
  const agent =
    source.agent !== null &&
    typeof source.agent === "object" &&
    !Array.isArray(source.agent)
      ? (source.agent as Record<string, unknown>)
      : {};
  const name = agent.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }

  return "unknown-agent";
}

function getWazuhTimestamp(hit: Record<string, unknown>): string {
  const source =
    hit._source !== null &&
    typeof hit._source === "object" &&
    !Array.isArray(hit._source)
      ? (hit._source as Record<string, unknown>)
      : {};
  const timestamp = source["@timestamp"];
  if (typeof timestamp === "string" && timestamp.trim().length > 0) {
    return timestamp.trim();
  }

  return "n/a";
}

function formatWazuhSearchOutput(input: {
  query: string;
  hits: Array<Record<string, unknown>>;
  hasMore: boolean;
}): string {
  const lines = ["Source: Wazuh (wazuh)", `Query: ${input.query}`];

  let resultsLabel = String(input.hits.length);
  if (input.hasMore) {
    resultsLabel += "+";
  }
  lines.push(`Results: ${resultsLabel}`);

  for (const hit of input.hits.slice(0, 10)) {
    lines.push(
      `- ${getWazuhTimestamp(hit)} · ${getWazuhAgentName(hit)} · ${getWazuhSearchDescription(hit)}`,
    );
  }

  if (input.hasMore) {
    lines.push("More results available.");
  }

  return lines.join("\n");
}

function wazuhAction(input: {
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  inputSchema: ZodType<Record<string, unknown>>;
  execute(context: {
    auth: {
      indexUrl: string;
      indexUsername: string;
      indexPassword: string;
    };
    input: Record<string, unknown>;
  }): Promise<{ status: number; summary: string; data: unknown }>;
}): PluginActionRuntime {
  return pluginActionRuntime({
    pluginId: "wazuh",
    id: input.id,
    title: input.title,
    description: input.description,
    riskLevel: input.riskLevel,
    fields: input.fields,
    inputSchema: input.inputSchema,
    createContext(auth) {
      return {
        auth: {
          indexUrl: readRequiredTrimmedString(auth.indexUrl, "indexUrl"),
          indexUsername: readRequiredTrimmedString(
            auth.indexUsername,
            "indexUsername",
          ),
          indexPassword: readRequiredTrimmedString(
            auth.indexPassword,
            "indexPassword",
          ),
        },
      };
    },
    async execute({ context, input: validatedInput }) {
      return input.execute({
        auth: context.auth,
        input: validatedInput,
      });
    },
  });
}

function createLocalHttpPluginAction(
  pluginId: string,
  action: DesktopLocalPluginAction,
): PluginActionRuntime {
  if (action.transport.kind !== "http") {
    throw new Error(
      `Plugin action "${pluginId}.${action.id}" expected an HTTP transport but received "${action.transport.kind}".`,
    );
  }

  const transport = action.transport;

  return pluginActionRuntime({
    pluginId,
    id: action.id,
    title: action.title,
    description: action.description,
    riskLevel: action.riskLevel,
    fields: action.fields,
    referencePath: action.referencePath,
    inputSchema: buildPluginInputSchema(action.fields),
    createContext(auth) {
      return {
        auth,
      };
    },
    async execute({ context, input }) {
      const templateContext: TemplateContext = {
        auth: context.auth,
        input,
      };
      const resolvedUrl = renderTemplateValue(
        transport.url,
        templateContext,
      );
      if (typeof resolvedUrl !== "string" || resolvedUrl.trim().length === 0) {
        throw new Error(`Plugin action "${action.id}" did not resolve a valid URL`);
      }

      const url = new URL(resolvedUrl);
      appendPluginQuery(url, transport.query, templateContext);

      const headers = Object.fromEntries(
        Object.entries(transport.headers ?? {}).flatMap(([key, template]) => {
          const value = renderTransportTemplateValue(template, templateContext);
          if (value === undefined) {
            return [];
          }
          return [[key, String(value)]];
        }),
      );

      const bodyValue = renderTransportTemplateValue(transport.body, templateContext);
      let body: BodyInit | undefined;
      if (bodyValue !== undefined) {
        if (
          typeof bodyValue === "string" ||
          bodyValue instanceof URLSearchParams
        ) {
          body = bodyValue;
        } else {
          body = JSON.stringify(bodyValue);
          if (headers["Content-Type"] === undefined) {
            headers["Content-Type"] = "application/json";
          }
        }
      }

      const response = await fetch(url, {
        method: transport.method,
        headers,
        body,
      });
      const successStatusCodes = transport.successStatusCodes;
      const ok =
        successStatusCodes !== undefined
          ? successStatusCodes.includes(response.status)
          : response.ok;
      const data = await parseHttpPluginResponse(response);
      if (!ok) {
        throw new Error(summarizeHttpPluginError(data, response.status));
      }

      if (transport.pagination?.kind === "next_url") {
        const items = readPathValue(data, transport.pagination.itemsPath);
        if (!Array.isArray(items)) {
          throw new Error(
            `Plugin action "${action.id}" expected pagination items at "${transport.pagination.itemsPath}".`,
          );
        }

        const aggregated = [...items];
        const maxPages = transport.pagination.maxPages ?? 50;
        let pageCount = 1;
        let nextUrl = resolveSameOriginNextUrl(
          readPathValue(data, transport.pagination.nextPath),
          url,
        );

        while (nextUrl !== null && pageCount < maxPages) {
          const nextResponse = await fetch(nextUrl, {
            method: "GET",
            headers,
          });
          const nextOk =
            successStatusCodes !== undefined
              ? successStatusCodes.includes(nextResponse.status)
              : nextResponse.ok;
          const nextData = await parseHttpPluginResponse(nextResponse);
          if (!nextOk) {
            throw new Error(summarizeHttpPluginError(nextData, nextResponse.status));
          }

          const nextItems = readPathValue(nextData, transport.pagination.itemsPath);
          if (!Array.isArray(nextItems)) {
            throw new Error(
              `Plugin action "${action.id}" expected pagination items at "${transport.pagination.itemsPath}".`,
            );
          }

          aggregated.push(...nextItems);
          pageCount += 1;
          nextUrl = resolveSameOriginNextUrl(
            readPathValue(nextData, transport.pagination.nextPath),
            nextUrl,
          );
        }

        return {
          status: response.status,
          summary: `${transport.method} ${url.pathname} completed successfully.`,
          data: aggregated,
        };
      }

      return {
        status: response.status,
        summary: `${transport.method} ${url.pathname} completed successfully.`,
        data,
      };
    },
  });
}

function createLocalBuiltinPluginAction(input: {
  pluginId: string;
  action: DesktopLocalPluginAction;
  builtinAction: PluginActionRuntime;
}): PluginActionRuntime {
  return {
    id: input.action.id,
    title: input.action.title,
    description: input.action.description,
    riskLevel: input.action.riskLevel,
    fields: input.action.fields,
    referencePath: input.action.referencePath,
    inputSchema: buildPluginInputSchema(input.action.fields),
    async execute(request) {
      return input.builtinAction.execute(request);
    },
  };
}

function createLocalPlugin(
  input: LoadedDesktopLocalPlugin,
  resolveBuiltinAction: (
    pluginId: string,
    actionId: string,
  ) => PluginActionRuntime | null,
): PluginRuntime {
  const manifest = desktopPluginManifestSchema.parse({
    id: input.definition.id,
    name: input.definition.name,
    version: input.definition.version,
    description: input.definition.description,
    referenceRepositoryPath: input.referenceRepositoryPath,
    metadata: input.definition.metadata,
    auth: input.definition.auth,
    actions: input.definition.actions.map(
      ({ transport: _transport, ...action }): DesktopPluginActionDefinition => ({
        ...action,
      }),
    ),
    triggers: input.definition.triggers,
  });

  const actions = input.definition.actions.map((action) => {
    if (action.transport.kind === "builtin") {
      const builtinAction = resolveBuiltinAction(manifest.id, action.id);
      if (builtinAction === null) {
        throw new Error(
          `Plugin action "${manifest.id}.${action.id}" declares a builtin transport, but no builtin executor is registered for that action.`,
        );
      }

      return createLocalBuiltinPluginAction({
        pluginId: manifest.id,
        action,
        builtinAction,
      });
    }

    return createLocalHttpPluginAction(manifest.id, action);
  });

  return {
    manifest,
    actions: new Map(actions.map((action) => [action.id, action])),
  };
}

function createGitHubPlugin(): PluginRuntime {
  const authFields: DesktopPluginFieldDefinition[] = [
    {
      key: "token",
      label: "Access Token",
      description:
        "GitHub personal access token or GitHub App installation token. Optional for public read-only calls.",
      type: "string",
      required: false,
      secret: true,
    },
    {
      key: "deploymentEnvironment",
      label: "Deployment Environment",
      description:
        "Expected deployment environment for the StackStorm-style deployment_event workflow.",
      type: "string",
      required: false,
      defaultValue: "production",
    },
    {
      key: "baseUrl",
      label: "API Base URL",
      description:
        "Optional GitHub Enterprise API base URL, for example https://github.example.com/api/v3.",
      type: "string",
      required: false,
      defaultValue: "https://api.github.com",
    },
  ];

  const repositoryEventTypes = [
    "IssuesEvent",
    "IssueCommentEvent",
    "ForkEvent",
    "WatchEvent",
    "ReleaseEvent",
    "PushEvent",
  ];

  const actions: PluginActionRuntime[] = [
    githubAction({
      id: "add_comment",
      title: "Add Comment",
      description: "Add a comment to an issue or pull request.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "issueNumber", label: "Issue Number", type: "number", required: true },
        { key: "body", label: "Comment", type: "string", required: true },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        issueNumber: z.coerce.number().int().positive(),
        body: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/issues/${String(input.issueNumber)}/comments`,
          body: { body: input.body },
        });
        return {
          status: response.status,
          summary: `Added a comment to issue #${String(input.issueNumber)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "add_status",
      title: "Add Commit Status",
      description: "Create a commit status for a SHA.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "sha", label: "SHA", type: "string", required: true },
        { key: "state", label: "State", type: "string", required: true },
        { key: "description", label: "Description", type: "string", required: false },
        { key: "targetUrl", label: "Target URL", type: "string", required: false },
        { key: "context", label: "Context", type: "string", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        sha: z.string().min(1),
        state: z.enum(["error", "failure", "pending", "success"]),
        description: z.string().optional(),
        targetUrl: z.string().url().optional(),
        context: z.string().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/statuses/${encodeURIComponent(input.sha as string)}`,
          body: {
            state: input.state,
            description: input.description,
            target_url: input.targetUrl,
            context: input.context,
          },
        });
        return {
          status: response.status,
          summary: `Created commit status "${String(input.state)}" for ${String(input.sha)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "add_team_membership",
      title: "Add Team Membership",
      description: "Add a user to an organization team.",
      riskLevel: "write",
      fields: [
        { key: "org", label: "Organization", type: "string", required: true },
        { key: "teamSlug", label: "Team Slug", type: "string", required: true },
        { key: "username", label: "Username", type: "string", required: true },
        { key: "role", label: "Role", type: "string", required: false },
      ],
      inputSchema: z.object({
        org: z.string().min(1),
        teamSlug: z.string().min(1),
        username: z.string().min(1),
        role: z.enum(["member", "maintainer"]).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "PUT",
          path: `/orgs/${encodeURIComponent(input.org as string)}/teams/${encodeURIComponent(
            input.teamSlug as string,
          )}/memberships/${encodeURIComponent(input.username as string)}`,
          body: {
            role: input.role,
          },
        });
        return {
          status: response.status,
          summary: `Added ${String(input.username)} to ${String(input.teamSlug)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "check_deployment_env",
      title: "Check Deployment Environment",
      description:
        "Validate that an incoming deployment environment matches the expected target environment.",
      riskLevel: "read",
      fields: [
        { key: "environment", label: "Environment", type: "string", required: true },
        {
          key: "expectedEnvironment",
          label: "Expected Environment",
          type: "string",
          required: true,
        },
      ],
      inputSchema: z.object({
        environment: z.string().min(1),
        expectedEnvironment: z.string().min(1),
      }),
      async execute({ input }) {
        const environment = String(input.environment);
        const expectedEnvironment = String(input.expectedEnvironment);
        const matches = environment === expectedEnvironment;
        return {
          status: 200,
          summary: matches
            ? `Deployment environment matches "${expectedEnvironment}".`
            : `Deployment environment "${environment}" does not match "${expectedEnvironment}".`,
          data: {
            environment,
            expectedEnvironment,
            matches,
          },
        };
      },
    }),
    githubAction({
      id: "create_deployment",
      title: "Create Deployment",
      description: "Create a repository deployment.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "ref", label: "Ref", type: "string", required: true },
        { key: "task", label: "Task", type: "string", required: false },
        { key: "description", label: "Description", type: "string", required: false },
        { key: "environment", label: "Environment", type: "string", required: false },
        { key: "payload", label: "Payload", type: "json", required: false },
        { key: "requiredContexts", label: "Required Contexts", type: "string_array", required: false },
        { key: "autoMerge", label: "Auto Merge", type: "boolean", required: false },
        { key: "transientEnvironment", label: "Transient Environment", type: "boolean", required: false },
        { key: "productionEnvironment", label: "Production Environment", type: "boolean", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1),
        task: z.string().optional(),
        description: z.string().optional(),
        environment: z.string().optional(),
        payload: z.unknown().optional(),
        requiredContexts: z.array(z.string().min(1)).optional(),
        autoMerge: z.boolean().optional(),
        transientEnvironment: z.boolean().optional(),
        productionEnvironment: z.boolean().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/deployments`,
          body: {
            ref: input.ref,
            task: input.task,
            auto_merge: input.autoMerge,
            required_contexts: input.requiredContexts,
            payload: input.payload,
            environment: input.environment,
            description: input.description,
            transient_environment: input.transientEnvironment,
            production_environment: input.productionEnvironment,
          },
        });
        return {
          status: response.status,
          summary: `Created deployment for ref ${String(input.ref)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "create_deployment_status",
      title: "Create Deployment Status",
      description: "Post a deployment status update.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "deploymentId", label: "Deployment ID", type: "number", required: true },
        { key: "state", label: "State", type: "string", required: true },
        { key: "description", label: "Description", type: "string", required: false },
        { key: "targetUrl", label: "Target URL", type: "string", required: false },
        { key: "logUrl", label: "Log URL", type: "string", required: false },
        { key: "environment", label: "Environment", type: "string", required: false },
        { key: "autoInactive", label: "Auto Inactive", type: "boolean", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        deploymentId: z.coerce.number().int().positive(),
        state: z.enum([
          "error",
          "failure",
          "inactive",
          "in_progress",
          "pending",
          "queued",
          "success",
        ]),
        description: z.string().optional(),
        targetUrl: z.string().url().optional(),
        logUrl: z.string().url().optional(),
        environment: z.string().optional(),
        autoInactive: z.boolean().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/deployments/${String(input.deploymentId)}/statuses`,
          body: {
            state: input.state,
            description: input.description,
            target_url: input.targetUrl,
            log_url: input.logUrl,
            environment: input.environment,
            auto_inactive: input.autoInactive,
          },
        });
        return {
          status: response.status,
          summary: `Created deployment status "${String(input.state)}".`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "deployment_event",
      title: "Deployment Event",
      description:
        "Process a GitHub deployment event and install or update a local desktop plugin when the deployment environment matches.",
      riskLevel: "write",
      fields: [
        {
          key: "repo_fullname",
          label: "Repository Full Name",
          description: "The full repo path, for example org/repository.",
          type: "string",
          required: true,
        },
        {
          key: "repo_name",
          label: "Repository Name",
          description: "Repository name.",
          type: "string",
          required: true,
        },
        {
          key: "deploy_ref",
          label: "Deploy Ref",
          description: "The branch, tag, or ref to deploy.",
          type: "string",
          required: false,
          defaultValue: "master",
        },
        {
          key: "deploy_env",
          label: "Deployment Environment",
          description: "Target environment carried by the deployment event.",
          type: "string",
          required: false,
          defaultValue: "production",
        },
        {
          key: "deploy_sha",
          label: "Deployment SHA",
          description: "Commit SHA for the deployment.",
          type: "string",
          required: true,
        },
        {
          key: "deploy_desc",
          label: "Deployment Description",
          description: "Human description of the deployment.",
          type: "string",
          required: true,
        },
        {
          key: "deploy_id",
          label: "Deployment ID",
          description: "GitHub deployment identifier.",
          type: "number",
          required: true,
        },
        {
          key: "ssh_url",
          label: "Repository SSH URL",
          description: "Repository SSH URL from the deployment payload.",
          type: "string",
          required: true,
        },
        {
          key: "creator",
          label: "Creator",
          description:
            "Login that created the deployment. Desktop uses the configured plugin token for follow-up status updates.",
          type: "string",
          required: true,
        },
        {
          key: "deploy_payload",
          label: "Deployment Payload",
          description: "Additional payload information from GitHub.",
          type: "json",
          required: false,
          defaultValue: {},
        },
      ],
      inputSchema: z.object({
        repo_fullname: z.string().min(1),
        repo_name: z.string().min(1),
        deploy_ref: z.string().min(1).default("master"),
        deploy_env: z.string().min(1).default("production"),
        deploy_sha: z.string().min(1),
        deploy_desc: z.string().min(1),
        deploy_id: z.coerce.number().int().positive(),
        ssh_url: z.string().min(1),
        creator: z.string().min(1),
        deploy_payload: z.unknown().optional(),
      }),
      async execute() {
        throw new Error(
          'GitHub deployment_event requires the desktop node plugin runtime because it installs a local plugin into the trusted desktop plugin directory.',
        );
      },
    }),
    githubAction({
      id: "create_file",
      title: "Create File",
      description: "Create a new repository file.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "path", label: "Path", type: "string", required: true },
        { key: "content", label: "Content", type: "string", required: true },
        { key: "message", label: "Commit Message", type: "string", required: true },
        { key: "branch", label: "Branch", type: "string", required: false },
        { key: "committerName", label: "Committer Name", type: "string", required: false },
        { key: "committerEmail", label: "Committer Email", type: "string", required: false },
        { key: "authorName", label: "Author Name", type: "string", required: false },
        { key: "authorEmail", label: "Author Email", type: "string", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        message: z.string().min(1),
        branch: z.string().optional(),
        committerName: z.string().optional(),
        committerEmail: z.string().optional(),
        authorName: z.string().optional(),
        authorEmail: z.string().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "PUT",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/contents/${String(input.path)
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}`,
          body: {
            message: input.message,
            content: Buffer.from(String(input.content), "utf8").toString("base64"),
            branch: input.branch,
            committer:
              input.committerName && input.committerEmail
                ? {
                    name: input.committerName,
                    email: input.committerEmail,
                  }
                : undefined,
            author:
              input.authorName && input.authorEmail
                ? {
                    name: input.authorName,
                    email: input.authorEmail,
                  }
                : undefined,
          },
        });
        return {
          status: response.status,
          summary: `Created file ${String(input.path)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "create_issue",
      title: "Create Issue",
      description: "Create a repository issue.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "title", label: "Title", type: "string", required: true },
        { key: "body", label: "Body", type: "string", required: false },
        { key: "assignees", label: "Assignees", type: "string_array", required: false },
        { key: "labels", label: "Labels", type: "string_array", required: false },
        { key: "milestone", label: "Milestone", type: "number", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        body: z.string().optional(),
        assignees: z.array(z.string().min(1)).optional(),
        labels: z.array(z.string().min(1)).optional(),
        milestone: z.coerce.number().int().positive().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/issues`,
          body: {
            title: input.title,
            body: input.body,
            assignees: input.assignees,
            labels: input.labels,
            milestone: input.milestone,
          },
        });
        return {
          status: response.status,
          summary: `Created issue "${String(input.title)}".`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "create_pull",
      title: "Create Pull Request",
      description: "Create a pull request.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "title", label: "Title", type: "string", required: true },
        { key: "head", label: "Head", type: "string", required: true },
        { key: "base", label: "Base", type: "string", required: true },
        { key: "body", label: "Body", type: "string", required: false },
        { key: "draft", label: "Draft", type: "boolean", required: false },
        {
          key: "maintainerCanModify",
          label: "Maintainer Can Modify",
          type: "boolean",
          required: false,
        },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        head: z.string().min(1),
        base: z.string().min(1),
        body: z.string().optional(),
        draft: z.boolean().optional(),
        maintainerCanModify: z.boolean().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/pulls`,
          body: {
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body,
            draft: input.draft,
            maintainer_can_modify: input.maintainerCanModify,
          },
        });
        return {
          status: response.status,
          summary: `Created pull request "${String(input.title)}".`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "create_release",
      title: "Create Release",
      description: "Create a repository release.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "tagName", label: "Tag Name", type: "string", required: true },
        { key: "targetCommitish", label: "Target Commitish", type: "string", required: false },
        { key: "name", label: "Release Name", type: "string", required: false },
        { key: "body", label: "Body", type: "string", required: false },
        { key: "draft", label: "Draft", type: "boolean", required: false },
        { key: "prerelease", label: "Prerelease", type: "boolean", required: false },
        { key: "generateReleaseNotes", label: "Generate Release Notes", type: "boolean", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        tagName: z.string().min(1),
        targetCommitish: z.string().optional(),
        name: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
        prerelease: z.boolean().optional(),
        generateReleaseNotes: z.boolean().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/releases`,
          body: {
            tag_name: input.tagName,
            target_commitish: input.targetCommitish,
            name: input.name,
            body: input.body,
            draft: input.draft,
            prerelease: input.prerelease,
            generate_release_notes: input.generateReleaseNotes,
          },
        });
        return {
          status: response.status,
          summary: `Created release ${String(input.tagName)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "delete_branch_protection",
      title: "Delete Branch Protection",
      description: "Remove branch protection rules from a branch.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "branch", label: "Branch", type: "string", required: true },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "DELETE",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/branches/${encodeURIComponent(input.branch as string)}/protection`,
        });
        return {
          status: response.status,
          summary: `Removed branch protection from ${String(input.branch)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_branch_protection",
      title: "Get Branch Protection",
      description: "Read branch protection rules for a branch.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "branch", label: "Branch", type: "string", required: true },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/branches/${encodeURIComponent(input.branch as string)}/protection`,
        });
        return {
          status: response.status,
          summary: `Fetched branch protection for ${String(input.branch)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_clone_stats",
      title: "Get Clone Stats",
      description: "Read clone traffic statistics for a repository.",
      riskLevel: "read",
      fields: repoFields(),
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/traffic/clones`,
        });
        return {
          status: response.status,
          summary: `Fetched clone stats for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_contents",
      title: "Get Contents",
      description: "Read repository file or directory contents.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "path", label: "Path", type: "string", required: false },
        { key: "ref", label: "Ref", type: "string", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().optional(),
        ref: z.string().optional(),
      }),
      async execute({ client, input }) {
        const basePath = `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
          input.repo as string,
        )}/contents`;
        const response = await client.request({
          method: "GET",
          path: appendPath(basePath, readTrimmedString(input.path, "path")),
          query: {
            ref: readTrimmedString(input.ref, "ref"),
          },
        });
        return {
          status: response.status,
          summary: `Fetched repository contents.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_deployment_statuses",
      title: "Get Deployment Statuses",
      description: "List statuses for a deployment.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "deploymentId", label: "Deployment ID", type: "number", required: true },
        ...paginationFields(),
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        deploymentId: z.coerce.number().int().positive(),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/deployments/${String(input.deploymentId)}/statuses`,
          query: {
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Fetched deployment statuses for ${String(input.deploymentId)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_issue",
      title: "Get Issue",
      description: "Read an issue or pull request issue record.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "issueNumber", label: "Issue Number", type: "number", required: true },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        issueNumber: z.coerce.number().int().positive(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/issues/${String(input.issueNumber)}`,
        });
        return {
          status: response.status,
          summary: `Fetched issue #${String(input.issueNumber)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_pull",
      title: "Get Pull Request",
      description: "Read a pull request.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "pullNumber", label: "Pull Number", type: "number", required: true },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        pullNumber: z.coerce.number().int().positive(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/pulls/${String(input.pullNumber)}`,
        });
        return {
          status: response.status,
          summary: `Fetched pull request #${String(input.pullNumber)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_traffic_stats",
      title: "Get Traffic Stats",
      description: "Read view traffic statistics for a repository.",
      riskLevel: "read",
      fields: repoFields(),
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/traffic/views`,
        });
        return {
          status: response.status,
          summary: `Fetched traffic stats for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "get_user",
      title: "Get User",
      description: "Read a GitHub user profile or the authenticated user.",
      riskLevel: "read",
      fields: [
        {
          key: "username",
          label: "Username",
          description:
            "Optional username. When omitted, the authenticated user endpoint is used.",
          type: "string",
          required: false,
        },
      ],
      inputSchema: z.object({
        username: z.string().optional(),
      }),
      async execute({ client, input }) {
        const username = readTrimmedString(input.username, "username");
        const response = await client.request({
          method: "GET",
          path:
            username === undefined
              ? "/user"
              : `/users/${encodeURIComponent(username)}`,
        });
        return {
          status: response.status,
          summary:
            username === undefined
              ? "Fetched authenticated user."
              : `Fetched GitHub user ${username}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "latest_release",
      title: "Latest Release",
      description: "Read the latest published release.",
      riskLevel: "read",
      fields: repoFields(),
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/releases/latest`,
        });
        return {
          status: response.status,
          summary: `Fetched latest release for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "list_deployments",
      title: "List Deployments",
      description: "List repository deployments.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "sha", label: "SHA", type: "string", required: false },
        { key: "ref", label: "Ref", type: "string", required: false },
        { key: "task", label: "Task", type: "string", required: false },
        { key: "environment", label: "Environment", type: "string", required: false },
        ...paginationFields(),
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        sha: z.string().optional(),
        ref: z.string().optional(),
        task: z.string().optional(),
        environment: z.string().optional(),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/deployments`,
          query: {
            sha: input.sha as string | undefined,
            ref: input.ref as string | undefined,
            task: input.task as string | undefined,
            environment: input.environment as string | undefined,
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Listed deployments for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "list_issues",
      title: "List Issues",
      description: "List issues in a repository.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "milestone", label: "Milestone", type: "string", required: false },
        { key: "state", label: "State", type: "string", required: false },
        { key: "assignee", label: "Assignee", type: "string", required: false },
        { key: "creator", label: "Creator", type: "string", required: false },
        { key: "mentioned", label: "Mentioned", type: "string", required: false },
        { key: "labels", label: "Labels", type: "string_array", required: false },
        { key: "sort", label: "Sort", type: "string", required: false },
        { key: "direction", label: "Direction", type: "string", required: false },
        { key: "since", label: "Since", type: "string", required: false },
        ...paginationFields(),
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        milestone: z.string().optional(),
        state: z.enum(["open", "closed", "all"]).optional(),
        assignee: z.string().optional(),
        creator: z.string().optional(),
        mentioned: z.string().optional(),
        labels: z.array(z.string().min(1)).optional(),
        sort: z.enum(["created", "updated", "comments"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        since: z.string().optional(),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/issues`,
          query: {
            milestone: input.milestone as string | undefined,
            state: input.state as string | undefined,
            assignee: input.assignee as string | undefined,
            creator: input.creator as string | undefined,
            mentioned: input.mentioned as string | undefined,
            labels: input.labels as string[] | undefined,
            sort: input.sort as string | undefined,
            direction: input.direction as string | undefined,
            since: input.since as string | undefined,
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Listed issues for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "list_pulls",
      title: "List Pull Requests",
      description: "List pull requests in a repository.",
      riskLevel: "read",
      fields: [
        ...repoFields(),
        { key: "state", label: "State", type: "string", required: false },
        { key: "head", label: "Head", type: "string", required: false },
        { key: "base", label: "Base", type: "string", required: false },
        { key: "sort", label: "Sort", type: "string", required: false },
        { key: "direction", label: "Direction", type: "string", required: false },
        ...paginationFields(),
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        state: z.enum(["open", "closed", "all"]).optional(),
        head: z.string().optional(),
        base: z.string().optional(),
        sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/pulls`,
          query: {
            state: input.state as string | undefined,
            head: input.head as string | undefined,
            base: input.base as string | undefined,
            sort: input.sort as string | undefined,
            direction: input.direction as string | undefined,
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Listed pull requests for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "list_releases",
      title: "List Releases",
      description: "List repository releases.",
      riskLevel: "read",
      fields: [...repoFields(), ...paginationFields()],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/releases`,
          query: {
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Listed releases for ${String(input.owner)}/${String(input.repo)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "list_teams",
      title: "List Teams",
      description: "List teams in an organization.",
      riskLevel: "read",
      fields: [
        { key: "org", label: "Organization", type: "string", required: true },
        ...paginationFields(),
      ],
      inputSchema: z.object({
        org: z.string().min(1),
        page: z.coerce.number().int().positive().optional(),
        perPage: z.coerce.number().int().positive().max(100).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "GET",
          path: `/orgs/${encodeURIComponent(input.org as string)}/teams`,
          query: {
            page: input.page as number | undefined,
            per_page: input.perPage as number | undefined,
          },
        });
        return {
          status: response.status,
          summary: `Listed teams for ${String(input.org)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "merge_pull",
      title: "Merge Pull Request",
      description: "Merge a pull request.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "pullNumber", label: "Pull Number", type: "number", required: true },
        { key: "commitTitle", label: "Commit Title", type: "string", required: false },
        { key: "commitMessage", label: "Commit Message", type: "string", required: false },
        { key: "mergeMethod", label: "Merge Method", type: "string", required: false },
        { key: "sha", label: "SHA", type: "string", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        pullNumber: z.coerce.number().int().positive(),
        commitTitle: z.string().optional(),
        commitMessage: z.string().optional(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
        sha: z.string().optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "PUT",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/pulls/${String(input.pullNumber)}/merge`,
          body: {
            commit_title: input.commitTitle,
            commit_message: input.commitMessage,
            merge_method: input.mergeMethod,
            sha: input.sha,
          },
        });
        return {
          status: response.status,
          summary: `Merged pull request #${String(input.pullNumber)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "review_pull",
      title: "Review Pull Request",
      description: "Create a review on a pull request.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "pullNumber", label: "Pull Number", type: "number", required: true },
        { key: "event", label: "Event", type: "string", required: false },
        { key: "body", label: "Body", type: "string", required: false },
        { key: "commitId", label: "Commit ID", type: "string", required: false },
        { key: "comments", label: "Comments", type: "json", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        pullNumber: z.coerce.number().int().positive(),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
        body: z.string().optional(),
        commitId: z.string().optional(),
        comments: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "POST",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/pulls/${String(input.pullNumber)}/reviews`,
          body: {
            event: input.event,
            body: input.body,
            commit_id: input.commitId,
            comments: input.comments,
          },
        });
        return {
          status: response.status,
          summary: `Created a review on pull request #${String(input.pullNumber)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "store_oauth_token",
      title: "Store OAuth Token",
      description:
        "Normalize a GitHub OAuth token payload for desktop use. Desktop does not persist StackStorm kv tokens through this action.",
      riskLevel: "write",
      fields: [
        { key: "token", label: "Token", type: "string", required: true, secret: true },
      ],
      inputSchema: z.object({
        token: z.string().min(1),
      }),
      async execute({ input }) {
        return {
          status: 200,
          summary:
            "Validated the OAuth token input. Desktop plugins should store credentials through app settings rather than a StackStorm kv store action.",
          data: {
            stored: false,
            reason: "desktop_runtime_requires_settings_backed_credentials",
            tokenPreview: `${String(input.token).slice(0, 4)}...`,
          },
        };
      },
    }),
    githubAction({
      id: "update_branch_protection",
      title: "Update Branch Protection",
      description: "Replace branch protection rules for a branch.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "branch", label: "Branch", type: "string", required: true },
        {
          key: "protection",
          label: "Protection",
          description:
            "Branch protection payload shaped like GitHub's REST API body.",
          type: "json",
          required: true,
        },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1),
        protection: z.record(z.string(), z.unknown()),
      }),
      async execute({ client, input }) {
        const response = await client.request({
          method: "PUT",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/branches/${encodeURIComponent(input.branch as string)}/protection`,
          body: input.protection as Record<string, unknown>,
        });
        return {
          status: response.status,
          summary: `Updated branch protection for ${String(input.branch)}.`,
          data: response.data,
        };
      },
    }),
    githubAction({
      id: "update_file",
      title: "Update File",
      description: "Update an existing repository file.",
      riskLevel: "write",
      fields: [
        ...repoFields(),
        { key: "path", label: "Path", type: "string", required: true },
        { key: "content", label: "Content", type: "string", required: true },
        { key: "message", label: "Commit Message", type: "string", required: true },
        { key: "branch", label: "Branch", type: "string", required: false },
        { key: "sha", label: "SHA", type: "string", required: false },
        { key: "committerName", label: "Committer Name", type: "string", required: false },
        { key: "committerEmail", label: "Committer Email", type: "string", required: false },
        { key: "authorName", label: "Author Name", type: "string", required: false },
        { key: "authorEmail", label: "Author Email", type: "string", required: false },
      ],
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        message: z.string().min(1),
        branch: z.string().optional(),
        sha: z.string().optional(),
        committerName: z.string().optional(),
        committerEmail: z.string().optional(),
        authorName: z.string().optional(),
        authorEmail: z.string().optional(),
      }),
      async execute({ client, input }) {
        const encodedPath = String(input.path)
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");

        let sha = readTrimmedString(input.sha, "sha");
        if (sha === undefined) {
          const existing = await client.request({
            method: "GET",
            path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
              input.repo as string,
            )}/contents/${encodedPath}`,
            query: {
              ref: readTrimmedString(input.branch, "branch"),
            },
          });
          if (
            existing.data === null ||
            typeof existing.data !== "object" ||
            Array.isArray(existing.data)
          ) {
            throw new Error("Expected a file object when resolving the current SHA");
          }
          const resolvedSha = (existing.data as { sha?: unknown }).sha;
          sha = readTrimmedString(resolvedSha, "sha", { required: true });
        }

        const response = await client.request({
          method: "PUT",
          path: `/repos/${encodeURIComponent(input.owner as string)}/${encodeURIComponent(
            input.repo as string,
          )}/contents/${encodedPath}`,
          body: {
            message: input.message,
            content: Buffer.from(String(input.content), "utf8").toString("base64"),
            sha,
            branch: input.branch,
            committer:
              input.committerName && input.committerEmail
                ? {
                    name: input.committerName,
                    email: input.committerEmail,
                  }
                : undefined,
            author:
              input.authorName && input.authorEmail
                ? {
                    name: input.authorName,
                    email: input.authorEmail,
                  }
                : undefined,
          },
        });
        return {
          status: response.status,
          summary: `Updated file ${String(input.path)}.`,
          data: response.data,
        };
      },
    }),
  ];

  const manifest = desktopPluginManifestSchema.parse({
    id: "github",
    name: "GitHub",
    version: `stackstorm-reference-${githubScaffold.version}`,
    description:
      `Typed desktop plugin port of the StackStorm ${githubScaffold.description} pack, with manifest-defined actions and trigger metadata for safer agent execution.`,
    referenceRepositoryPath: githubScaffold.referenceRepositoryPath,
    auth: {
      fields: authFields,
    },
    actions: actions.map(
      (action): DesktopPluginActionDefinition => ({
        id: action.id,
        title: action.title,
        description: action.description,
        riskLevel: action.riskLevel,
        fields: action.fields,
        referencePath: githubScaffoldActionReferencePath(action.id),
      }),
    ),
    triggers: [
      {
        id: "repository_event",
        title: "Repository Event",
        description:
          "Poll or webhook-driven repository event ingestion modeled after the StackStorm repository sensor.",
        kind: "poll",
        eventTypes: repositoryEventTypes,
        referencePath: githubScaffoldTriggerReferencePath("repository_event"),
        fields: [
          {
            key: "repositories",
            label: "Repositories",
            description:
              "List of owner/repository pairs to watch. Mirrors repository_sensor.repositories.",
            type: "json",
            required: true,
          },
          {
            key: "eventTypeWhitelist",
            label: "Event Type Whitelist",
            description:
              "Repository event types to ingest, for example PushEvent or ReleaseEvent.",
            type: "string_array",
            required: false,
          },
          {
            key: "count",
            label: "History Count",
            description:
              "Maximum number of previously seen events to fetch during poll reconciliation.",
            type: "number",
            required: false,
          },
        ],
      },
      {
        id: "deployment_event",
        title: "Deployment Event Webhook",
        description:
          "Webhook-driven deployment event trigger modeled after StackStorm's deployment_event rule.",
        kind: "webhook",
        eventTypes: ["deployment"],
        referencePath: githubScaffoldTriggerReferencePath("deployment_event"),
        fields: [
          {
            key: "environment",
            label: "Environment",
            description:
              "Expected deployment environment used to route or filter deployment webhooks.",
            type: "string",
            required: false,
          },
        ],
      },
    ],
  });

  return {
    manifest,
    actions: new Map(actions.map((action) => [action.id, action])),
  };
}

function createSentryPlugin(): PluginRuntime {
  const authFields: DesktopPluginFieldDefinition[] = [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "Sentry user token or OAuth access token used for organizations, projects, issues, and events.",
      type: "string",
      required: true,
      secret: true,
    },
  ];

  const actions: PluginActionRuntime[] = [
    sentryAction({
      id: "list_organizations",
      title: "List Organizations",
      description: "List Sentry organizations visible to the access token.",
      riskLevel: "read",
      fields: [],
      inputSchema: z.object({}),
      async execute({ provider, accessToken }) {
        const organizations = await provider.listOrganizations(accessToken);
        return {
          status: 200,
          summary: `Fetched ${String(organizations.length)} Sentry organization(s).`,
          data: organizations,
        };
      },
    }),
    sentryAction({
      id: "list_projects",
      title: "List Projects",
      description: "List Sentry projects within an organization.",
      riskLevel: "read",
      fields: [
        { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
      ],
      inputSchema: z.object({
        orgSlug: z.string().min(1),
      }),
      async execute({ provider, accessToken, input }) {
        const projects = await provider.listProjects({
          accessToken,
          orgSlug: String(input.orgSlug),
        });
        return {
          status: 200,
          summary: `Fetched ${String(projects.length)} project(s) from ${String(input.orgSlug)}.`,
          data: projects,
        };
      },
    }),
    sentryAction({
      id: "query_issues",
      title: "Query Issues",
      description: "Search Sentry issues with the same query path the desktop runtime uses.",
      riskLevel: "read",
      fields: [
        { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
        { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
        { key: "query", label: "Query", type: "string", required: true },
        { key: "limit", label: "Limit", type: "number", required: false },
        { key: "cursor", label: "Cursor", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().min(1),
        projectIds: z.array(z.string().min(1)).min(1),
        query: z.string().min(1),
        limit: z.coerce.number().int().positive().optional(),
        cursor: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.queryIssues({
          accessToken,
          orgSlug: String(input.orgSlug),
          projectIds: input.projectIds as string[],
          query: String(input.query),
          limit: input.limit as number | undefined,
          cursor: input.cursor as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.issues.length)} issue(s) from Sentry query.`,
          data: batch,
        };
      },
    }),
    sentryAction({
      id: "list_issues",
      title: "List Issues",
      description: "List Sentry issues for an organization and project set.",
      riskLevel: "read",
      fields: [
        { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
        { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
        { key: "cursor", label: "Cursor", type: "string", required: false },
        { key: "limit", label: "Limit", type: "number", required: false },
        { key: "since", label: "Since", type: "string", required: false },
        { key: "until", label: "Until", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().min(1),
        projectIds: z.array(z.string().min(1)).min(1),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.listIssues({
          accessToken,
          orgSlug: String(input.orgSlug),
          projectIds: input.projectIds as string[],
          cursor: input.cursor as string | undefined,
          limit: input.limit as number | undefined,
          since: input.since as string | undefined,
          until: input.until as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.issues.length)} Sentry issue(s).`,
          data: batch,
        };
      },
    }),
    sentryAction({
      id: "list_issue_events",
      title: "List Issue Events",
      description: "List events attached to a Sentry issue.",
      riskLevel: "read",
      fields: [
        { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
        { key: "issueId", label: "Issue ID", type: "string", required: true },
        { key: "cursor", label: "Cursor", type: "string", required: false },
        { key: "since", label: "Since", type: "string", required: false },
        { key: "until", label: "Until", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().min(1),
        issueId: z.string().min(1),
        cursor: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.listIssueEvents({
          accessToken,
          orgSlug: String(input.orgSlug),
          issueId: String(input.issueId),
          cursor: input.cursor as string | undefined,
          since: input.since as string | undefined,
          until: input.until as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.events.length)} event(s) for issue ${String(
            input.issueId,
          )}.`,
          data: batch,
        };
      },
    }),
  ];

  const manifest = desktopPluginManifestSchema.parse({
    id: "sentry",
    name: "Sentry",
    version: "desktop-runtime-v1",
    description:
      "Typed desktop plugin that exposes the current Sentry organization, project, issue, and event query surfaces through manifest-defined actions.",
    metadata: {
      errorSource: {
        sourceType: "sentry",
        oauth: {
          envClientIdName: "SENTRY_OAUTH_CLIENT_ID",
          envClientSecretName: "SENTRY_OAUTH_CLIENT_SECRET",
          envRedirectUriName: "SENTRY_OAUTH_REDIRECT_URI",
          scopes: ["org:read", "project:read", "event:read"],
          publicClient: false,
        },
        setupFields: [
          {
            key: "authToken",
            target: "authToken",
            storage: "accessTokenRef",
            label: "Access Token",
            placeholder: "Sentry user token",
            description:
              "User token or OAuth access token for organizations, issues, and events.",
            required: true,
            control: "password",
          },
          {
            key: "organizationSlug",
            target: "organizationSlug",
            storage: "configuration",
            configurationKey: "orgSlug",
            label: "Organization",
            placeholder: "my-sentry-org",
            required: true,
            control: "text",
          },
          {
            key: "projectSlugs",
            target: "projectSlugs",
            storage: "configuration",
            configurationKey: "projectSlugs",
            label: "Projects",
            placeholder: "frontend-web\nbackend-api",
            description:
              "Optional project slugs to narrow syncs and runbook queries.",
            required: false,
            control: "multiline_list",
          },
          {
            key: "oauthClientId",
            storage: "configuration",
            configurationKey: "oauthClientId",
            label: "OAuth Client ID",
            placeholder: "Sentry OAuth client id override",
            description:
              "Optional override for the Sentry OAuth client id used during authorize and refresh flows.",
            required: false,
            control: "text",
          },
          {
            key: "oauthClientSecret",
            storage: "configuration",
            configurationKey: "oauthClientSecret",
            label: "OAuth Client Secret",
            placeholder: "Sentry OAuth client secret override",
            description:
              "Optional override for the Sentry OAuth client secret used during token exchange and refresh.",
            required: false,
            control: "password",
          },
          {
            key: "oauthRedirectUri",
            storage: "configuration",
            configurationKey: "oauthRedirectUri",
            label: "OAuth Redirect URI",
            placeholder: "bitsentry-desktop://oauth/callback",
            description:
              "Optional override for the Sentry OAuth redirect URI when this plugin uses a custom OAuth app.",
            required: false,
            control: "text",
          },
        ],
      },
    },
    auth: {
      fields: authFields,
    },
    actions: actions.map(
      (action): DesktopPluginActionDefinition => ({
        id: action.id,
        title: action.title,
        description: action.description,
        riskLevel: action.riskLevel,
        fields: action.fields,
        referencePath: action.referencePath,
      }),
    ),
    triggers: [
      {
        id: "issue_detected",
        title: "Issue Detected",
        description:
          "Poll-driven issue detection trigger for newly seen Sentry issues in a configured organization and project set.",
        kind: "poll",
        eventTypes: ["issue.created", "issue.regressed"],
        fields: [
          { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
          { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
          { key: "query", label: "Query Filter", type: "string", required: false },
        ],
      },
      {
        id: "issue_resolved",
        title: "Issue Resolved",
        description:
          "Poll-driven trigger for issue resolution or disappearance from the tracked issue set.",
        kind: "poll",
        eventTypes: ["issue.resolved"],
        fields: [
          { key: "orgSlug", label: "Organization Slug", type: "string", required: true },
          { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
        ],
      },
    ],
  });

  return {
    manifest,
    actions: new Map(actions.map((action) => [action.id, action])),
  };
}

function createPostHogPlugin(): PluginRuntime {
  const authFields: DesktopPluginFieldDefinition[] = [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "PostHog personal API key or OAuth access token used for organizations, projects, and HogQL queries.",
      type: "string",
      required: true,
      secret: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      description:
        "Optional PostHog region or self-hosted base URL, such as https://eu.posthog.com.",
      type: "string",
      required: false,
      defaultValue: "https://us.posthog.com",
    },
  ];

  const actions: PluginActionRuntime[] = [
    postHogAction({
      id: "list_organizations",
      title: "List Organizations",
      description: "List PostHog organizations visible to the access token.",
      riskLevel: "read",
      fields: [],
      inputSchema: z.object({}),
      async execute({ provider, accessToken }) {
        const organizations = await provider.listOrganizations(accessToken);
        return {
          status: 200,
          summary: `Fetched ${String(organizations.length)} PostHog organization(s).`,
          data: organizations,
        };
      },
    }),
    postHogAction({
      id: "list_projects",
      title: "List Projects",
      description: "List PostHog projects, optionally scoped to an organization.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          description:
            "Optional organization identifier for filtering the project list.",
          type: "string",
          required: false,
        },
      ],
      inputSchema: z.object({
        orgSlug: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const projects = await provider.listProjects({
          accessToken,
          orgSlug: input.orgSlug as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(projects.length)} PostHog project(s).`,
          data: projects,
        };
      },
    }),
    postHogAction({
      id: "get_project",
      title: "Get Project",
      description: "Fetch a single PostHog project by numeric project id.",
      riskLevel: "read",
      fields: [
        { key: "projectId", label: "Project ID", type: "string", required: true },
      ],
      inputSchema: z.object({
        projectId: z.string().min(1),
      }),
      async execute({ provider, accessToken, input }) {
        const project = await provider.getProject({
          accessToken,
          projectId: String(input.projectId),
        });
        return {
          status: 200,
          summary: `Fetched PostHog project ${String(input.projectId)}.`,
          data: project,
        };
      },
    }),
    postHogAction({
      id: "query_issues",
      title: "Query Issues",
      description: "Search PostHog exception issues with the existing HogQL query path.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
        { key: "query", label: "Query", type: "string", required: true },
        { key: "limit", label: "Limit", type: "number", required: false },
        { key: "cursor", label: "Cursor", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().optional(),
        projectIds: z.array(z.string().min(1)).min(1),
        query: z.string().min(1),
        limit: z.coerce.number().int().positive().optional(),
        cursor: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.queryIssues({
          accessToken,
          orgSlug: String(input.orgSlug ?? ""),
          projectIds: input.projectIds as string[],
          query: String(input.query),
          limit: input.limit as number | undefined,
          cursor: input.cursor as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.issues.length)} PostHog issue(s) from query.`,
          data: batch,
        };
      },
    }),
    postHogAction({
      id: "list_issues",
      title: "List Issues",
      description: "List PostHog issues across one or more projects.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
        { key: "cursor", label: "Cursor", type: "string", required: false },
        { key: "limit", label: "Limit", type: "number", required: false },
        { key: "since", label: "Since", type: "string", required: false },
        { key: "until", label: "Until", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().optional(),
        projectIds: z.array(z.string().min(1)).min(1),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.listIssues({
          accessToken,
          orgSlug: String(input.orgSlug ?? ""),
          projectIds: input.projectIds as string[],
          cursor: input.cursor as string | undefined,
          limit: input.limit as number | undefined,
          since: input.since as string | undefined,
          until: input.until as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.issues.length)} PostHog issue(s).`,
          data: batch,
        };
      },
    }),
    postHogAction({
      id: "list_issue_events",
      title: "List Issue Events",
      description: "List PostHog events for a namespaced issue fingerprint.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        { key: "issueId", label: "Issue ID", type: "string", required: true },
        { key: "projectIds", label: "Project IDs", type: "string_array", required: false },
        { key: "cursor", label: "Cursor", type: "string", required: false },
        { key: "since", label: "Since", type: "string", required: false },
        { key: "until", label: "Until", type: "string", required: false },
      ],
      inputSchema: z.object({
        orgSlug: z.string().optional(),
        issueId: z.string().min(1),
        projectIds: z.array(z.string().min(1)).optional(),
        cursor: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }),
      async execute({ provider, accessToken, input }) {
        const batch = await provider.listIssueEvents({
          accessToken,
          orgSlug: String(input.orgSlug ?? ""),
          issueId: String(input.issueId),
          projectIds: input.projectIds as string[] | undefined,
          cursor: input.cursor as string | undefined,
          since: input.since as string | undefined,
          until: input.until as string | undefined,
        });
        return {
          status: 200,
          summary: `Fetched ${String(batch.events.length)} PostHog event(s) for issue ${String(
            input.issueId,
          )}.`,
          data: batch,
        };
      },
    }),
  ];

  const manifest = desktopPluginManifestSchema.parse({
    id: "posthog",
    name: "PostHog",
    version: "desktop-runtime-v1",
    description:
      "Typed desktop plugin that exposes the current PostHog organization, project, issue, and event query surfaces through manifest-defined actions.",
    metadata: {
      errorSource: {
        sourceType: "posthog",
        oauth: {
          envClientIdName: "POSTHOG_OAUTH_CLIENT_ID",
          envClientSecretName: "POSTHOG_OAUTH_CLIENT_SECRET",
          envRedirectUriName: "POSTHOG_OAUTH_REDIRECT_URI",
          scopes: [
            "organization:read",
            "project:read",
            "error_tracking:read",
            "query:read",
            "event:read",
          ],
          publicClient: true,
        },
        setupFields: [
          {
            key: "baseUrl",
            target: "baseUrl",
            storage: "configuration",
            configurationKey: "posthogBaseUrl",
            label: "PostHog Host",
            placeholder: "https://eu.posthog.com",
            description:
              "Use the default US or EU host, or provide a custom self-hosted base URL.",
            required: false,
            control: "posthog_base_url",
          },
          {
            key: "authToken",
            target: "authToken",
            storage: "accessTokenRef",
            label: "API Key",
            placeholder: "PostHog personal API key",
            description:
              "Personal API key or OAuth access token used for organizations, projects, and HogQL queries.",
            required: true,
            control: "password",
          },
          {
            key: "organizationId",
            target: "organizationId",
            storage: "configuration",
            configurationKey: "orgSlug",
            label: "Organization",
            placeholder: "12345",
            required: false,
            control: "text",
          },
          {
            key: "projectIds",
            target: "projectIds",
            storage: "configuration",
            configurationKey: "projectIds",
            label: "Projects",
            placeholder: "123\n456",
            description:
              "One or more numeric PostHog project ids. Required for project-scoped keys.",
            required: true,
            control: "multiline_list",
          },
          {
            key: "oauthClientId",
            storage: "configuration",
            configurationKey: "oauthClientId",
            label: "OAuth Client ID",
            placeholder: "PostHog OAuth client id override",
            description:
              "Optional override for the PostHog OAuth client id used during authorize and refresh flows.",
            required: false,
            control: "text",
          },
          {
            key: "oauthClientSecret",
            storage: "configuration",
            configurationKey: "oauthClientSecret",
            label: "OAuth Client Secret",
            placeholder: "PostHog OAuth client secret override",
            description:
              "Optional override for the PostHog OAuth client secret used during token exchange and refresh.",
            required: false,
            control: "password",
          },
          {
            key: "oauthRedirectUri",
            storage: "configuration",
            configurationKey: "oauthRedirectUri",
            label: "OAuth Redirect URI",
            placeholder: "bitsentry-desktop://oauth/callback",
            description:
              "Optional override for the PostHog OAuth redirect URI when this plugin uses a custom OAuth app.",
            required: false,
            control: "text",
          },
        ],
      },
    },
    auth: {
      fields: authFields,
    },
    actions: actions.map(
      (action): DesktopPluginActionDefinition => ({
        id: action.id,
        title: action.title,
        description: action.description,
        riskLevel: action.riskLevel,
        fields: action.fields,
        referencePath: action.referencePath,
      }),
    ),
    triggers: [
      {
        id: "exception_detected",
        title: "Exception Detected",
        description:
          "Poll-driven trigger for newly surfaced PostHog exception issues across selected projects.",
        kind: "poll",
        eventTypes: ["exception.detected", "exception.regressed"],
        fields: [
          { key: "projectIds", label: "Project IDs", type: "string_array", required: true },
          { key: "query", label: "Query Filter", type: "string", required: false },
          { key: "baseUrl", label: "Base URL", type: "string", required: false },
        ],
      },
      {
        id: "exception_event_detected",
        title: "Exception Event Detected",
        description:
          "Poll-driven trigger for event-level exception activity on a tracked fingerprint.",
        kind: "poll",
        eventTypes: ["exception.event"],
        fields: [
          { key: "issueId", label: "Issue ID", type: "string", required: true },
          { key: "projectIds", label: "Project IDs", type: "string_array", required: false },
        ],
      },
    ],
  });

  return {
    manifest,
    actions: new Map(actions.map((action) => [action.id, action])),
  };
}

function createWazuhPlugin(): PluginRuntime {
  const authFields: DesktopPluginFieldDefinition[] = [
    {
      key: "indexUrl",
      label: "Index URL",
      description:
        "OpenSearch index base URL, for example https://wazuh.example.com:9200.",
      type: "string",
      required: false,
    },
    {
      key: "indexUsername",
      label: "Index Username",
      description:
        "Username used for the Wazuh/OpenSearch index API.",
      type: "string",
      required: false,
    },
    {
      key: "indexPassword",
      label: "Index Password",
      description:
        "Password used for the Wazuh/OpenSearch index API.",
      type: "string",
      required: false,
      secret: true,
    },
  ];

  const actions: PluginActionRuntime[] = [
    wazuhAction({
      id: "search_alerts",
      title: "Search Alerts",
      description:
        "Query Wazuh alert indexes with a bounded read-only OpenSearch search request.",
      riskLevel: "read",
      fields: [
        { key: "query", label: "Query", type: "string", required: true },
        { key: "limit", label: "Limit", type: "number", required: false },
        {
          key: "offset",
          label: "Offset",
          description:
            "Optional page offset for bounded sync or large alert result sets.",
          type: "number",
          required: false,
        },
        {
          key: "indexPattern",
          label: "Index Pattern",
          description:
            "Optional Wazuh index pattern such as wazuh-alerts-4.x-*.",
          type: "string",
          required: false,
        },
        {
          key: "since",
          label: "Since",
          description:
            "Optional lower bound on @timestamp for bounded sync reads.",
          type: "string",
          required: false,
        },
        {
          key: "until",
          label: "Until",
          description:
            "Optional upper bound on @timestamp for bounded sync reads.",
          type: "string",
          required: false,
        },
      ],
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
        indexPattern: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }),
      async execute({ auth, input }) {
        const indexPattern = readWazuhIndexPattern(input.indexPattern);
        const limit = readWazuhLimit(input.limit);
        const offset = readWazuhOffset(input.offset);
        const since = readTrimmedString(input.since, "since");
        const until = readTrimmedString(input.until, "until");
        const searchUrl = new URL(
          `${auth.indexUrl.replace(/\/+$/, "")}/${indexPattern}/_search`,
        );
        const credentials = Buffer.from(
          `${auth.indexUsername}:${auth.indexPassword}`,
        ).toString("base64");
        let queryBody: Record<string, unknown> = {
          query_string: {
            query: String(input.query),
          },
        };
        if (since !== undefined || until !== undefined) {
          const range: Record<string, string> = {};
          if (since !== undefined) {
            range.gte = since;
          }
          if (until !== undefined) {
            range.lte = until;
          }
          queryBody = {
            bool: {
              must: [queryBody],
              filter: [
                {
                  range: {
                    "@timestamp": range,
                  },
                },
              ],
            },
          };
        }
        const response = await fetch(searchUrl, {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: queryBody,
            size: limit,
            from: offset,
            sort: [{ ["@timestamp"]: "desc" }],
          }),
        });

        if (response.status === 404) {
          const data = {
            output: formatWazuhSearchOutput({
              query: String(input.query),
              hits: [],
              hasMore: false,
            }),
            issueCount: 0,
            hasMore: false,
            items: [],
          };
          return {
            status: 200,
            summary: `Fetched 0 Wazuh alert(s) from ${indexPattern}.`,
            data,
          };
        }

        const payload = await parseHttpPluginResponse(response);
        if (!response.ok) {
          throw new Error(summarizeHttpPluginError(payload, response.status));
        }

        const parsed = wazuhSearchResponseSchema.parse(payload);
        const hits = parsed.hits.hits;
        const totalHits = parsed.hits.total.value;
        const hasMore = totalHits > offset + hits.length;
        const data = {
          output: formatWazuhSearchOutput({
            query: String(input.query),
            hits,
            hasMore,
          }),
          issueCount: hits.length,
          totalCount: totalHits,
          hasMore,
          items: hits,
        };

        return {
          status: 200,
          summary: `Fetched ${String(hits.length)} Wazuh alert(s) from ${indexPattern}.`,
          data,
        };
      },
    }),
  ];

  const manifest = desktopPluginManifestSchema.parse({
    id: "wazuh",
    name: "Wazuh",
    version: "desktop-runtime-v1",
    description:
      "Typed desktop plugin that exposes bounded Wazuh alert index queries through manifest-defined actions.",
    metadata: {
      errorSource: {
        sourceType: "wazuh",
        setupFields: [
          {
            key: "baseUrl",
            target: "baseUrl",
            storage: "configuration",
            configurationKey: "baseUrl",
            label: "API Base URL",
            placeholder: "https://wazuh.example.com:9200",
            description:
              "Optional OpenSearch index base URL. Leave blank when the desktop runtime is configured elsewhere.",
            required: false,
            control: "text",
          },
          {
            key: "authToken",
            target: "authToken",
            storage: "accessTokenRef",
            label: "Auth Token",
            placeholder: "OpenSearch password or token",
            description:
              "Optional credential used for bounded alert-index queries.",
            required: false,
            control: "password",
          },
          {
            key: "indexPatterns",
            target: "indexPatterns",
            storage: "configuration",
            configurationKey: "indexPatterns",
            label: "Index Patterns",
            placeholder: "wazuh-alerts-4.x-*",
            description:
              "Optional index patterns used for sync and runbook query defaults.",
            required: false,
            control: "multiline_list",
          },
        ],
      },
    },
    auth: {
      fields: authFields,
    },
    actions: actions.map(
      (action): DesktopPluginActionDefinition => ({
        id: action.id,
        title: action.title,
        description: action.description,
        riskLevel: action.riskLevel,
        fields: action.fields,
        referencePath: action.referencePath,
      }),
    ),
    triggers: [
      {
        id: "alert_detected",
        title: "Alert Detected",
        description:
          "Poll-driven trigger for newly detected Wazuh alerts in a configured index pattern.",
        kind: "poll",
        eventTypes: ["alert.detected"],
        fields: [
          {
            key: "indexPattern",
            label: "Index Pattern",
            type: "string",
            required: false,
          },
          {
            key: "query",
            label: "Query Filter",
            type: "string",
            required: false,
          },
        ],
      },
    ],
  });

  return {
    manifest,
    actions: new Map(actions.map((action) => [action.id, action])),
  };
}

export class DesktopPluginRegistry {
  private readonly plugins = new Map<string, PluginRuntime>();

  constructor(localPlugins: LoadedDesktopLocalPlugin[] = []) {
    this.register(createGitHubPlugin());
    this.register(createSentryPlugin());
    this.register(createPostHogPlugin());
    this.register(createWazuhPlugin());
    for (const plugin of localPlugins) {
      this.register(
        createLocalPlugin(plugin, (pluginId, actionId) =>
          this.getAction(pluginId, actionId),
        ),
      );
    }
  }

  register(plugin: PluginRuntime): void {
    this.plugins.set(plugin.manifest.id, plugin);
  }

  list(): DesktopPluginManifest[] {
    return Array.from(this.plugins.values(), (plugin) => plugin.manifest);
  }

  get(pluginId: string): DesktopPluginManifest | null {
    return this.plugins.get(pluginId)?.manifest ?? null;
  }

  getAction(pluginId: string, actionId: string): PluginActionRuntime | null {
    return this.plugins.get(pluginId)?.actions.get(actionId) ?? null;
  }
}

export class DesktopPluginRuntimeService {
  constructor(protected registry = new DesktopPluginRegistry()) {}

  listPlugins(): DesktopPluginManifest[] {
    return this.registry.list();
  }

  getPlugin(pluginId: string): DesktopPluginManifest | null {
    return this.registry.get(pluginId);
  }

  async executeAction(
    input: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    const request = desktopPluginExecutionRequestSchema.parse(input);
    const plugin = this.registry.get(request.pluginId);
    if (plugin === null) {
      throw new Error(`Unknown plugin: ${request.pluginId}`);
    }

    const action = this.registry.getAction(request.pluginId, request.actionId);
    if (action === null) {
      throw new Error(
        `Unknown action "${request.actionId}" for plugin "${request.pluginId}"`,
      );
    }

    for (const field of plugin.auth.fields) {
      if (!field.required) continue;
      const value = request.auth[field.key];
      if (value === undefined || value === null || String(value).trim().length === 0) {
        throw new Error(`Missing required auth field: ${field.key}`);
      }
    }

    return action.execute({
      auth: request.auth,
      input: request.input,
    });
  }
}
