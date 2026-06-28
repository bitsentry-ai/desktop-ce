import { z } from "zod";

import { createDesktopNodePluginRuntimeService } from "../plugins/desktop-plugin-runtime.node";
import { DesktopPluginRuntimeService } from "../plugins/desktop-plugin-registry";
import { PostHogProviderAdapter } from "./desktop-posthog-provider.adapter";
import { resolveErrorSourceProviderActionId } from "./desktop-plugin-error-source-actions";
import type {
  ErrorSourceProvider,
  EventBatchResponse,
  IssueBatchResponse,
  OAuthAuthorizeInput,
  OAuthTokenExchangeInput,
  OAuthTokenRefreshInput,
  OAuthTokenResponse,
  OrganizationSummary,
  ProjectSummary,
} from "./desktop-error-source-provider.interface";

const organizationSummarySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
});

const projectSummarySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().optional(),
});

const issueBatchResponseSchema = z.object({
  issues: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
});

const eventBatchResponseSchema = z.object({
  events: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function primitiveString(value: unknown, fallback = ""): string {
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

function optionalTrimmedPrimitiveString(value: unknown): string | undefined {
  const normalized = primitiveString(value).trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return undefined;
}

function normalizeOrganizationSummary(value: unknown): OrganizationSummary {
  const record = asRecord(value);
  const slug = primitiveString(record.slug, primitiveString(record.id));
  return organizationSummarySchema.parse({
    slug,
    name: primitiveString(record.name, slug),
  });
}

function normalizeProjectSummary(value: unknown): ProjectSummary {
  const record = asRecord(value);
  const id = primitiveString(record.id);
  const slug = primitiveString(record.slug, id);
  const project: ProjectSummary = projectSummarySchema.parse({
    id,
    slug,
    name: primitiveString(record.name, slug.length > 0 ? slug : id),
    organizationId: optionalTrimmedPrimitiveString(
      record.organizationId ?? record.organization,
    ),
  });

  return project;
}

export class PluginBackedPostHogProviderAdapter implements ErrorSourceProvider {
  readonly sourceType = "posthog" as const;

  constructor(
    private readonly runtime = createDesktopNodePluginRuntimeService(),
    private readonly pluginId = "posthog",
    private readonly baseUrl?: string,
    private readonly oauthAdapter = new PostHogProviderAdapter({ apiBase: baseUrl }),
  ) {}

  withApiBase(baseUrl: string | null | undefined): PluginBackedPostHogProviderAdapter {
    const nextBaseUrl = (baseUrl ?? "").trim();
    if (nextBaseUrl.length === 0 || nextBaseUrl === this.baseUrl) {
      return this;
    }

    return new PluginBackedPostHogProviderAdapter(
      this.runtime,
      this.pluginId,
      nextBaseUrl,
    );
  }

  buildAuthorizeUrl(input: OAuthAuthorizeInput): string {
    return this.oauthAdapter.buildAuthorizeUrl(input);
  }

  exchangeCodeForToken(input: OAuthTokenExchangeInput): Promise<OAuthTokenResponse> {
    return this.oauthAdapter.exchangeCodeForToken(input);
  }

  refreshToken(input: OAuthTokenRefreshInput): Promise<OAuthTokenResponse> {
    return this.oauthAdapter.refreshToken(input);
  }

  async listOrganizations(accessToken: string): Promise<OrganizationSummary[]> {
    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listOrganizations"),
      auth: this.auth(accessToken),
      input: {},
    });

    return z.array(z.unknown()).parse(result.data).map(normalizeOrganizationSummary);
  }

  async listProjects(input: {
    accessToken: string;
    orgSlug?: string;
    signal?: AbortSignal;
  }): Promise<ProjectSummary[]> {
    void input.signal;

    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listProjects"),
      auth: this.auth(input.accessToken),
      input: {
        orgSlug: input.orgSlug,
      },
    });

    return z.array(z.unknown()).parse(result.data).map(normalizeProjectSummary);
  }

  async getProject(input: {
    accessToken: string;
    projectId: string;
    signal?: AbortSignal;
  }): Promise<ProjectSummary> {
    void input.signal;

    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("getProject"),
      auth: this.auth(input.accessToken),
      input: {
        projectId: input.projectId,
      },
    });

    return normalizeProjectSummary(result.data);
  }

  async queryIssues(input: {
    accessToken: string;
    orgSlug: string;
    projectIds: string[];
    query: string;
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<IssueBatchResponse> {
    void input.signal;

    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("queryIssues"),
      auth: this.auth(input.accessToken),
      input: {
        orgSlug: input.orgSlug,
        projectIds: input.projectIds,
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
      },
    });

    return issueBatchResponseSchema.parse(result.data);
  }

  async listIssues(input: {
    accessToken: string;
    orgSlug: string;
    projectIds: string[];
    cursor?: string;
    limit?: number;
    since?: string;
    until?: string;
  }): Promise<IssueBatchResponse> {
    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listIssues"),
      auth: this.auth(input.accessToken),
      input: {
        orgSlug: input.orgSlug,
        projectIds: input.projectIds,
        cursor: input.cursor,
        limit: input.limit,
        since: input.since,
        until: input.until,
      },
    });

    return issueBatchResponseSchema.parse(result.data);
  }

  async listIssueEvents(input: {
    accessToken: string;
    orgSlug: string;
    issueId: string;
    cursor?: string;
    projectIds?: string[];
    since?: string;
    until?: string;
  }): Promise<EventBatchResponse> {
    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listIssueEvents"),
      auth: this.auth(input.accessToken),
      input: {
        orgSlug: input.orgSlug,
        issueId: input.issueId,
        projectIds: input.projectIds,
        cursor: input.cursor,
        since: input.since,
        until: input.until,
      },
    });

    return eventBatchResponseSchema.parse(result.data);
  }

  private auth(accessToken: string): Record<string, unknown> {
    const auth: Record<string, unknown> = { accessToken };
    if (this.baseUrl !== undefined && this.baseUrl.length > 0) {
      auth.baseUrl = this.baseUrl;
    }
    return auth;
  }

  private readActionId(
    action:
      | "listOrganizations"
      | "listProjects"
      | "getProject"
      | "queryIssues"
      | "listIssues"
      | "listIssueEvents",
  ): string {
    return resolveErrorSourceProviderActionId({
      runtime: this.runtime,
      pluginId: this.pluginId,
      sourceType: this.sourceType,
      action,
    });
  }
}
