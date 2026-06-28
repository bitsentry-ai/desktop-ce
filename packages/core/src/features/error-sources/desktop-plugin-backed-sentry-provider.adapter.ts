import { z } from "zod";

import { createDesktopNodePluginRuntimeService } from "../plugins/desktop-plugin-runtime.node";
import { DesktopPluginRuntimeService } from "../plugins/desktop-plugin-registry";
import { SentryProviderAdapter } from "./desktop-sentry-provider.adapter";
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

export class PluginBackedSentryProviderAdapter implements ErrorSourceProvider {
  readonly sourceType = "sentry" as const;

  constructor(
    private readonly runtime = createDesktopNodePluginRuntimeService(),
    private readonly pluginId = "sentry",
    private readonly oauthAdapter = new SentryProviderAdapter(),
  ) {}

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
      auth: { accessToken },
      input: {},
    });

    return z.array(organizationSummarySchema).parse(result.data);
  }

  async listProjects(input: {
    accessToken: string;
    orgSlug: string;
    signal?: AbortSignal;
  }): Promise<ProjectSummary[]> {
    void input.signal;

    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listProjects"),
      auth: { accessToken: input.accessToken },
      input: { orgSlug: input.orgSlug },
    });

    return z.array(projectSummarySchema).parse(result.data);
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
      auth: { accessToken: input.accessToken },
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
      auth: { accessToken: input.accessToken },
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
    void input.projectIds;

    const result = await this.runtime.executeAction({
      pluginId: this.pluginId,
      actionId: this.readActionId("listIssueEvents"),
      auth: { accessToken: input.accessToken },
      input: {
        orgSlug: input.orgSlug,
        issueId: input.issueId,
        cursor: input.cursor,
        since: input.since,
        until: input.until,
      },
    });

    return eventBatchResponseSchema.parse(result.data);
  }

  private readActionId(
    action:
      | "listOrganizations"
      | "listProjects"
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
