import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SqliteErrorSourcesRepositoryAdapter,
  type ErrorSourceDatabase,
} from "@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter";
import { ErrorSourceSyncService } from "@bitsentry-ce/core/features/error-sources/desktop-error-source-sync.service";
import type { UpsertErrorIssueInput } from "@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-issues.adapter";
import type {
  ErrorIssue,
  ErrorSource,
} from "@bitsentry-ce/core/features/error-sources/desktop-error-sources.types";
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
} from "@bitsentry-ce/core/features/plugins";
import { createDesktopNodePluginRuntimeService } from "@bitsentry-ce/core/features/plugins/node";
import path from "path";

class TestPluginRuntimeService extends DesktopPluginRuntimeService {
  readonly executeActionMock =
    vi.fn<
      (
        input: DesktopPluginExecutionRequest,
      ) => Promise<DesktopPluginExecutionResult>
    >();

  constructor(private readonly descriptors: DesktopPluginDescriptor[]) {
    super();
  }

  override listPlugins(): DesktopPluginDescriptor[] {
    return this.descriptors;
  }

  override getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.descriptors.find((plugin) => plugin.id === pluginId) ?? null;
  }

  override executeAction(
    input: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    return this.executeActionMock(input);
  }
}

function createProviderAction(
  id: string,
): DesktopPluginDescriptor["actions"][number] {
  return {
    id,
    title: id,
    description: `${id} action.`,
    riskLevel: "read",
    fields: [],
  };
}

function createPostHogPluginDescriptor(): DesktopPluginDescriptor {
  return {
    id: "posthog",
    name: "PostHog",
    version: "1.0.0",
    description: "PostHog code plugin.",
    type: "data_source",
    metadata: {
      dataSource: {
        sourceType: "posthog",
        oauth: {
          envClientIdName: "POSTHOG_OAUTH_CLIENT_ID",
          envClientSecretName: "POSTHOG_OAUTH_CLIENT_SECRET",
          publicClient: false,
        },
        setupFields: [
          {
            key: "accessToken",
            label: "API key",
            required: true,
            control: "password",
          },
        ],
      },
    },
    auth: {
      fields: [
        {
          key: "accessToken",
          label: "API key",
          type: "string",
          required: true,
        },
      ],
    },
    actions: [
      createProviderAction("refresh_token"),
      createProviderAction("list_issues"),
    ],
  };
}

function createSentryPluginDescriptor(): DesktopPluginDescriptor {
  return {
    id: "sentry",
    name: "Sentry",
    version: "1.0.0",
    description: "Sentry code plugin.",
    type: "data_source",
    metadata: {
      dataSource: {
        sourceType: "sentry",
        setupFields: [
          {
            key: "accessToken",
            label: "Auth token",
            required: true,
            control: "password",
          },
        ],
      },
    },
    auth: {
      fields: [
        {
          key: "accessToken",
          label: "Auth token",
          type: "string",
          required: true,
        },
      ],
    },
    actions: [createProviderAction("list_issues")],
  };
}

function makeSource(overrides: Partial<ErrorSource> = {}): ErrorSource {
  return {
    id: "source-sentry",
    sourceType: "sentry",
    name: "Jagad",
    accessTokenRef: "token",
    refreshTokenRef: null,
    expiresAt: null,
    grantedScopes: [],
    configuration: {
      orgSlug: "jagad",
      projectIds: ["4504367120777216"],
    },
    logLevelThreshold: "error",
    additionalMetadata: null,
    syncEnabled: true,
    autoDiagnosisEnabled: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function rejectUnexpectedDatabaseCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected error source database call"));
}

function makeIssue(input: UpsertErrorIssueInput): ErrorIssue {
  return {
    id: `local-${input.externalIssueId}`,
    sourceId: input.sourceId,
    externalIssueId: input.externalIssueId,
    externalShortId: nullable(input.externalShortId),
    title: input.title,
    culprit: nullable(input.culprit),
    type: nullable(input.type),
    metadata: nullable(input.metadata),
    projectIdentifier: nullable(input.projectIdentifier),
    level: input.level,
    status: input.status,
    isUnhandled: nullable(input.isUnhandled),
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    eventCount: input.eventCount,
    userCount: nullable(input.userCount),
    tags: nullable(input.tags),
    environment: nullable(input.environment),
    release: nullable(input.release),
    platform: nullable(input.platform),
    additionalMetadata: nullable(input.additionalMetadata),
    diagnosisStatus: null,
    diagnosisResult: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("Sentry external source sync", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires sync to run through a matching code plugin", async () => {
    const source = makeSource();
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn() },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn() },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn((input: UpsertErrorIssueInput) =>
          Promise.resolve(makeIssue(input)),
        ),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      new TestPluginRuntimeService([]),
    );

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      'Error source plugin "sentry" does not match source type sentry',
    );
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "failed",
        lastSyncError:
          'Error source plugin "sentry" does not match source type sentry',
      }),
    );
  });

  it("queries Sentry by last seen when doing incremental source sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pluginDirectory = path.resolve(
      process.cwd(),
      "../../packages/plugins",
    );
    const pluginRuntime = createDesktopNodePluginRuntimeService([
      pluginDirectory,
    ]);
    await pluginRuntime.executeAction({
      pluginId: "sentry",
      actionId: "list_issues",
      auth: {
        accessToken: "token",
      },
      input: {
        orgSlug: "jagad",
        projectIds: ["4504367120777216"],
        since: "2026-06-01T08:00:00.000Z",
        limit: 20,
      },
    });

    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("limit=20");
    expect(url).toContain("project=4504367120777216");
    expect(decodeURIComponent(url)).toContain(
      "query=lastSeen:>=2026-06-01T08:00:00.000Z",
    );
  });

  it("can clear interrupted in-progress source sync status", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db: ErrorSourceDatabase = {
      errorSource: {
        create: rejectUnexpectedDatabaseCall,
        delete: rejectUnexpectedDatabaseCall,
        findMany: rejectUnexpectedDatabaseCall,
        findUnique: rejectUnexpectedDatabaseCall,
        update: rejectUnexpectedDatabaseCall,
        updateMany,
      },
    };
    const repository = new SqliteErrorSourcesRepositoryAdapter(db);

    await expect(
      repository.markInterruptedSyncsFailed(
        "Previous sync was interrupted before completion.",
      ),
    ).resolves.toBe(1);

    expect(updateMany).toHaveBeenCalledWith({
      where: { lastSyncStatus: "in_progress" },
      data: {
        lastSyncStatus: "failed",
        lastSyncError: "Previous sync was interrupted before completion.",
      },
    });
  });

  it("syncs sources through matching code plugin actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      accessTokenRef: "stale-token",
      refreshTokenRef: "stored-refresh-token",
      expiresAt: "2026-06-01T08:59:00.000Z",
      additionalMetadata: { pluginId: "posthog" },
      configuration: {
        orgSlug: "jagad",
        projectIds: ["4504367120777216"],
        projectSlugs: ["frontend"],
        oauthClientId: "posthog-client-id",
        oauthClientSecret: "posthog-client-secret",
      },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const runtime = new TestPluginRuntimeService([
      createPostHogPluginDescriptor(),
    ]);
    runtime.executeActionMock.mockImplementation((request) => {
      if (request.actionId === "refresh_token") {
        return Promise.resolve({
          pluginId: "posthog",
          actionId: "refresh_token",
          ok: true,
          status: 200,
          summary: "Refreshed PostHog token.",
          data: {
            accessToken: "refreshed-access-token",
            refreshToken: "rotated-refresh-token",
            expiresIn: 3600,
          },
        });
      }

      return Promise.resolve({
        pluginId: "posthog",
        actionId: "list_issues",
        ok: true,
        status: 200,
        summary: "Listed PostHog issues.",
        data: {
          issues: [],
          hasMore: false,
        },
      });
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn() },
        telemetryEntry: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
        diagnosisEntry: { upsert: vi.fn() },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn((input: UpsertErrorIssueInput) =>
          Promise.resolve(makeIssue(input)),
        ),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    const result = await service.syncSourceById(source.id);

    expect(result).toEqual({
      sourceId: source.id,
      syncedIssues: 0,
      syncedEvents: 0,
    });
    const refreshRequest = runtime.executeActionMock.mock.calls.find(
      ([request]) => request.actionId === "refresh_token",
    )?.[0];
    expect(refreshRequest).toMatchObject({
      pluginId: "posthog",
      actionId: "refresh_token",
      input: {
        clientId: "posthog-client-id",
        clientSecret: "posthog-client-secret",
        refreshToken: "stored-refresh-token",
      },
    });
    const executionRequest = runtime.executeActionMock.mock.calls.find(
      ([request]) => request.actionId === "list_issues",
    )?.[0];
    expect(executionRequest).toMatchObject({
      pluginId: "posthog",
      actionId: "list_issues",
      auth: {
        accessToken: "refreshed-access-token",
      },
    });
    expect(sourcesRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: source.id,
        accessTokenRef: "refreshed-access-token",
        refreshTokenRef: "rotated-refresh-token",
      }),
    );
    expect(executionRequest?.input).toMatchObject({
      sourceId: source.id,
      sourceName: "Production PostHog",
      sourceType: "posthog",
      orgSlug: "jagad",
      projectIds: ["4504367120777216"],
      projectSlugs: ["frontend"],
      query: "*",
      limit: 100,
      since: "2026-06-01T07:30:00.000Z",
      until: "2026-06-01T09:00:00.000Z",
    });
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "success",
        lastSyncError: null,
        lastSyncAt: "2026-06-01T09:00:00.000Z",
      }),
    );
  });

  it("fails plugin issue pages with ok false without advancing the watermark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const runtime = new TestPluginRuntimeService([
      createPostHogPluginDescriptor(),
    ]);
    runtime.executeActionMock.mockResolvedValue({
      pluginId: "posthog",
      actionId: "list_issues",
      ok: false,
      status: 500,
      summary: "PostHog provider returned HTTP 500.",
      data: {
        issues: [],
        hasMore: false,
      },
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn() },
        telemetryEntry: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
        diagnosisEntry: { upsert: vi.fn() },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      "PostHog provider returned HTTP 500.",
    );
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "failed",
        lastSyncError:
          'Plugin "posthog" failed to list issues for source sync: PostHog provider returned HTTP 500.',
      }),
    );
    expect(sourcesRepository.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncAt: "2026-06-01T09:00:00.000Z",
        lastSyncStatus: "success",
      }),
    );
  });

  it("bounds initial Sentry plugin syncs instead of crawling all history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-sentry",
      sourceType: "sentry",
      name: "Production Sentry",
      additionalMetadata: { pluginId: "sentry" },
      lastSyncAt: null,
    });
    const runtime = new TestPluginRuntimeService([
      createSentryPluginDescriptor(),
    ]);
    runtime.executeActionMock.mockResolvedValue({
      pluginId: "sentry",
      actionId: "list_issues",
      ok: true,
      status: 200,
      summary: "Listed Sentry issues.",
      data: {
        issues: [],
        hasMore: false,
      },
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn() },
        telemetryEntry: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
        diagnosisEntry: { upsert: vi.fn() },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).resolves.toMatchObject({
      syncedIssues: 0,
    });
    const firstPluginCall = runtime.executeActionMock.mock.calls[0];
    if (firstPluginCall === undefined) {
      throw new Error("Expected Sentry source sync to execute a plugin action");
    }
    const [executionRequest] = firstPluginCall;
    expect(executionRequest.input).toMatchObject({
      since: "2026-05-31T09:00:00.000Z",
      until: "2026-06-01T09:00:00.000Z",
    });
  });

  it("preserves plugin issue first-seen timestamps separately from last-seen timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const runtime = new TestPluginRuntimeService([
      createPostHogPluginDescriptor(),
    ]);
    runtime.executeActionMock.mockResolvedValue({
      pluginId: "posthog",
      actionId: "list_issues",
      ok: true,
      status: 200,
      summary: "Listed PostHog issues.",
      data: {
        issues: [
          {
            id: "issue-1",
            title: "Checkout failed",
            level: "error",
            firstSeen: "2026-05-01T08:00:00.000Z",
            lastSeen: "2026-06-01T08:45:00.000Z",
          },
        ],
        hasMore: false,
      },
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const upsertIssue = vi.fn((input: UpsertErrorIssueInput) =>
      Promise.resolve(makeIssue(input)),
    );
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: upsertIssue,
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).resolves.toMatchObject({
      syncedIssues: 1,
    });
    expect(upsertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        externalIssueId: "issue-1",
        firstSeen: "2026-05-01T08:00:00.000Z",
        lastSeen: "2026-06-01T08:45:00.000Z",
      }),
    );
  });

  it("fails capped plugin syncs without advancing the watermark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const runtime = new TestPluginRuntimeService([
      createPostHogPluginDescriptor(),
    ]);
    runtime.executeActionMock.mockResolvedValue({
      pluginId: "posthog",
      actionId: "list_issues",
      ok: true,
      status: 200,
      summary: "Listed PostHog issues.",
      data: {
        issues: [
          {
            id: "issue-1",
            title: "Repeated issue",
            level: "error",
            lastSeen: "2026-06-01T08:45:00.000Z",
          },
        ],
        hasMore: true,
        nextCursor: "next-page",
      },
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn((input: UpsertErrorIssueInput) =>
          Promise.resolve(makeIssue(input)),
        ),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      "Plugin sync reached the 10 page limit before all issues were fetched.",
    );
    expect(runtime.executeActionMock).toHaveBeenCalledTimes(10);
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "failed",
        lastSyncError:
          "Plugin sync reached the 10 page limit before all issues were fetched.",
      }),
    );
    expect(sourcesRepository.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncAt: "2026-06-01T09:00:00.000Z",
        lastSyncStatus: "success",
      }),
    );
  });

  it("continues plugin issue pagination across empty pages with cursors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const runtime = new TestPluginRuntimeService([
      createPostHogPluginDescriptor(),
    ]);
    runtime.executeActionMock
      .mockResolvedValueOnce({
        pluginId: "posthog",
        actionId: "list_issues",
        ok: true,
        status: 200,
        summary: "Listed PostHog issues.",
        data: {
          issues: [],
          hasMore: true,
          nextCursor: "cursor-after-filtered-page",
        },
      })
      .mockResolvedValueOnce({
        pluginId: "posthog",
        actionId: "list_issues",
        ok: true,
        status: 200,
        summary: "Listed PostHog issues.",
        data: {
          issues: [
            {
              id: "issue-1",
              title: "Unfiltered issue",
              level: "error",
              lastSeen: "2026-06-01T08:45:00.000Z",
            },
          ],
          hasMore: false,
        },
      });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const issueRepository = {
      upsert: vi.fn((input: UpsertErrorIssueInput) =>
        Promise.resolve(makeIssue(input)),
      ),
      findById: vi.fn(),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      issueRepository,
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).resolves.toMatchObject({
      syncedIssues: 1,
    });
    expect(runtime.executeActionMock).toHaveBeenCalledTimes(2);
    expect(runtime.executeActionMock.mock.calls[1]?.[0]).toMatchObject({
      input: {
        cursor: "cursor-after-filtered-page",
      },
    });
    expect(issueRepository.upsert).toHaveBeenCalledTimes(1);
  });

  it("fails capped plugin event syncs without advancing the watermark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const descriptor = createPostHogPluginDescriptor();
    const runtime = new TestPluginRuntimeService([
      {
        ...descriptor,
        actions: [
          ...descriptor.actions,
          createProviderAction("list_issue_events"),
        ],
      },
    ]);
    runtime.executeActionMock.mockImplementation((request) => {
      if (request.actionId === "list_issues") {
        return Promise.resolve({
          pluginId: "posthog",
          actionId: "list_issues",
          ok: true,
          status: 200,
          summary: "Listed PostHog issues.",
          data: {
            issues: [
              {
                id: "issue-1",
                title: "Repeated issue",
                level: "error",
                lastSeen: "2026-06-01T08:45:00.000Z",
              },
            ],
            hasMore: false,
          },
        });
      }

      return Promise.resolve({
        pluginId: "posthog",
        actionId: "list_issue_events",
        ok: true,
        status: 200,
        summary: "Listed PostHog issue events.",
        data: {
          events: [
            {
              id: `event-${String(runtime.executeActionMock.mock.calls.length)}`,
              timestamp: "2026-06-01T08:45:00.000Z",
              message: "Repeated event",
            },
          ],
          hasMore: true,
          nextCursor: "next-event-page",
        },
      });
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn((input: UpsertErrorIssueInput) =>
          Promise.resolve(makeIssue(input)),
        ),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      "Plugin sync reached the 10 event page limit before all events were fetched.",
    );
    expect(runtime.executeActionMock).toHaveBeenCalledTimes(11);
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "failed",
        lastSyncError:
          "Plugin sync reached the 10 event page limit before all events were fetched.",
      }),
    );
    expect(sourcesRepository.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncAt: "2026-06-01T09:00:00.000Z",
        lastSyncStatus: "success",
      }),
    );
  });

  it("fails plugin event pages with ok false without advancing the watermark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));

    const source = makeSource({
      id: "source-posthog",
      sourceType: "posthog",
      name: "Production PostHog",
      additionalMetadata: { pluginId: "posthog" },
      lastSyncAt: "2026-06-01T08:30:00.000Z",
    });
    const descriptor = createPostHogPluginDescriptor();
    const runtime = new TestPluginRuntimeService([
      {
        ...descriptor,
        actions: [
          ...descriptor.actions,
          createProviderAction("list_issue_events"),
        ],
      },
    ]);
    runtime.executeActionMock.mockImplementation((request) => {
      if (request.actionId === "list_issues") {
        return Promise.resolve({
          pluginId: "posthog",
          actionId: "list_issues",
          ok: true,
          status: 200,
          summary: "Listed PostHog issues.",
          data: {
            issues: [
              {
                id: "issue-1",
                title: "Issue with failed events",
                level: "error",
                lastSeen: "2026-06-01T08:45:00.000Z",
              },
            ],
            hasMore: false,
          },
        });
      }

      return Promise.resolve({
        pluginId: "posthog",
        actionId: "list_issue_events",
        ok: false,
        status: 500,
        summary: "PostHog event API returned HTTP 500.",
        data: {
          events: [],
          hasMore: false,
        },
      });
    });
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    };
    const service = new ErrorSourceSyncService(
      {
        $queryRawUnsafe: () => Promise.resolve([]),
        telemetryDaily: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        telemetryEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 1 }),
        },
        diagnosisEntry: { upsert: vi.fn().mockResolvedValue({ id: 1 }) },
        diagnosisEntrySourceRef: { upsert: vi.fn() },
      },
      sourcesRepository,
      {
        upsert: vi.fn((input: UpsertErrorIssueInput) =>
          Promise.resolve(makeIssue(input)),
        ),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      runtime,
    );

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      "PostHog event API returned HTTP 500.",
    );
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: "failed",
        lastSyncError:
          'Plugin "posthog" failed to list issue events for source sync: PostHog event API returned HTTP 500.',
      }),
    );
    expect(sourcesRepository.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncAt: "2026-06-01T09:00:00.000Z",
        lastSyncStatus: "success",
      }),
    );
  });
});
