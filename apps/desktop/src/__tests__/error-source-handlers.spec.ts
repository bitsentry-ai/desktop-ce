import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { createDesktopErrorSourcesHandlers } from '@bitsentry-ce/core/features/error-sources/desktop-error-sources.handlers'
import { createDesktopOauthManagerBindings } from '@bitsentry-ce/core/features/error-sources/desktop-oauth-manager'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
} from '@bitsentry-ce/core/features/plugins'

class TestPluginRuntimeService extends DesktopPluginRuntimeService {
  readonly executeActionMock = vi.fn<
    (input: DesktopPluginExecutionRequest) => Promise<DesktopPluginExecutionResult>
  >()

  constructor(private readonly descriptors: DesktopPluginDescriptor[]) {
    super()
  }

  override listPlugins(): DesktopPluginDescriptor[] {
    return this.descriptors
  }

  override getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.descriptors.find((plugin) => plugin.id === pluginId) ?? null
  }

  override executeAction(
    input: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    return this.executeActionMock(input)
  }
}

function createProviderAction(
  id: string,
): DesktopPluginDescriptor['actions'][number] {
  return {
    id,
    title: id,
    description: `${id} action.`,
    riskLevel: 'read',
    fields: [],
  }
}

function createPostHogPluginDescriptor(): DesktopPluginDescriptor {
  return {
    id: 'posthog',
    name: 'PostHog',
    version: '1.0.0',
    description: 'PostHog code plugin.',
    metadata: {
      errorSource: {
        sourceType: 'posthog',
        setupFields: [
          {
            key: 'accessToken',
            storage: 'accessTokenRef',
            label: 'API key',
            required: true,
            control: 'password',
          },
        ],
      },
    },
    auth: {
      fields: [
        {
          key: 'accessToken',
          label: 'API key',
          type: 'string',
          required: true,
        },
      ],
    },
    actions: [
      createProviderAction('exchange_code_for_token'),
      createProviderAction('query_issues'),
    ],
    triggers: [],
  }
}

function createTestDb() {
  const now = new Date().toISOString()
  const existingSource = {
    id: 'source-1',
    sourceType: 'posthog',
    name: 'Production PostHog',
    accessTokenRef: 'phx-token',
    refreshTokenRef: null,
    expiresAt: null,
    grantedScopes: JSON.stringify([]),
    configuration: JSON.stringify({
      orgSlug: 'org-1',
      projectIds: ['177710'],
    }),
    logLevelThreshold: 'error',
    additionalMetadata: JSON.stringify({
      pluginId: 'posthog',
    }),
    syncEnabled: true,
    autoDiagnosisEnabled: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: now,
    updatedAt: now,
  }
  const create = vi.fn(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...data,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        createdAt: now,
        updatedAt: now,
      }),
  )
  const update = vi.fn(
    ({
      data,
    }: {
      where: { id: string }
      data: Record<string, unknown>
    }) =>
      Promise.resolve({
        ...existingSource,
        ...data,
        updatedAt: now,
      }),
  )

  const db: unknown = {
    errorSource: {
      create,
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(existingSource),
      update,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    setting: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({
        key: 'errorSources.oauth.state-1',
        value: JSON.stringify({
          sourceType: 'posthog',
          pluginId: 'posthog',
          codeVerifier: 'verifier-1',
          createdAt: now,
        }),
      }),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  }
  return { db: db as DbClient, create, update }
}

function createDb(): DbClient {
  return createTestDb().db
}

describe('desktop error source handlers', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('tests built-in-named sources through matching code plugin actions', async () => {
    vi.useFakeTimers()
    const runtime = new TestPluginRuntimeService([createPostHogPluginDescriptor()])
    runtime.executeActionMock.mockResolvedValue({
      pluginId: 'posthog',
      actionId: 'query_issues',
      ok: true,
      status: 200,
      summary: 'Queried PostHog issues.',
      data: {
        issues: [{ id: 'issue-1' }],
        hasMore: false,
      },
    })
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(createDb(), {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:testConnection']?.({ id: 'source-1' }),
    ).resolves.toEqual({
      success: true,
      provider: 'posthog',
      organizationCount: 1,
      projectCount: 1,
    })

    const executionRequest = runtime.executeActionMock.mock.calls[0]?.[0]
    expect(executionRequest).toMatchObject({
      pluginId: 'posthog',
      actionId: 'query_issues',
      auth: {
        accessToken: 'phx-token',
      },
    })
    expect(executionRequest?.input).toMatchObject({
      orgSlug: 'org-1',
      projectIds: ['177710'],
      sourceType: 'posthog',
    })
  })

  it('creates built-in-named sources through matching code plugin metadata', async () => {
    vi.useFakeTimers()
    const runtime = new TestPluginRuntimeService([createPostHogPluginDescriptor()])
    const { db, create } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:create']?.({
        pluginId: 'posthog',
        sourceType: 'posthog',
        name: 'Production PostHog',
        setupValues: {
          accessToken: 'phx-token',
        },
        organizationId: 'org-1',
        projectIds: ['177710'],
        baseUrl: 'https://eu.posthog.com',
        syncEnabled: false,
        autoDiagnosisEnabled: true,
      }),
    ).resolves.toMatchObject({
      pluginId: 'posthog',
      sourceType: 'posthog',
      name: 'Production PostHog',
      syncEnabled: false,
      autoDiagnosisEnabled: true,
      configuration: {
        baseUrl: 'https://eu.posthog.com',
        orgSlug: 'org-1',
        projectIds: ['177710'],
      },
    })

    expect(runtime.executeActionMock).not.toHaveBeenCalled()

    const createCall = create.mock.calls[0]?.[0]
    expect(createCall).toBeDefined()
    expect(createCall?.data).toMatchObject({
      sourceType: 'posthog',
      name: 'Production PostHog',
      accessTokenRef: 'phx-token',
      syncEnabled: false,
      autoDiagnosisEnabled: true,
    })
    expect(JSON.parse(String(createCall?.data.additionalMetadata))).toEqual({
      pluginId: 'posthog',
    })
    expect(JSON.parse(String(createCall?.data.configuration))).toEqual({
      baseUrl: 'https://eu.posthog.com',
      orgSlug: 'org-1',
      projectIds: ['177710'],
    })
  })

  it('rejects source creation without a matching code plugin', async () => {
    const runtime = new TestPluginRuntimeService([])
    const { db, create } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:create']?.({
        pluginId: 'github',
        sourceType: 'github',
        name: 'GitHub Issues',
        setupValues: {
          accessToken: 'gh-token',
        },
        configuration: {
          defaultQuery: 'is:issue is:open',
        },
      }),
    ).rejects.toThrow(
      'Error source plugin "github" does not match source type github',
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('updates built-in-named sources through matching code plugin metadata', async () => {
    vi.useFakeTimers()
    const runtime = new TestPluginRuntimeService([createPostHogPluginDescriptor()])
    const { db, update } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:update']?.({
        id: 'source-1',
        projectIds: ['999'],
        baseUrl: 'https://metadata.google.internal',
      }),
    ).resolves.toMatchObject({
      pluginId: 'posthog',
      sourceType: 'posthog',
      configuration: {
        baseUrl: 'https://metadata.google.internal',
        orgSlug: 'org-1',
        projectIds: ['999'],
      },
    })

    expect(runtime.executeActionMock).not.toHaveBeenCalled()

    const updateCall = update.mock.calls[0]?.[0]
    expect(updateCall).toBeDefined()
    expect(JSON.parse(String(updateCall?.data.configuration))).toEqual({
      baseUrl: 'https://metadata.google.internal',
      orgSlug: 'org-1',
      projectIds: ['999'],
    })
  })

  it('rejects source updates without a matching code plugin', async () => {
    const runtime = new TestPluginRuntimeService([])
    const { db, update } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:update']?.({
        id: 'source-1',
        projectIds: ['999'],
      }),
    ).rejects.toThrow(
      'Error source plugin "posthog" does not match source type posthog',
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('completes OAuth for built-in-named sources through matching code plugin metadata', async () => {
    vi.useFakeTimers()
    const runtime = new TestPluginRuntimeService([createPostHogPluginDescriptor()])
    runtime.executeActionMock.mockResolvedValue({
      pluginId: 'posthog',
      actionId: 'exchange_code_for_token',
      ok: true,
      status: 200,
      summary: 'Exchanged OAuth code.',
      data: {
        accessToken: 'phx-oauth-token',
        refreshToken: 'phr-oauth-refresh-token',
        scope: 'error_tracking:read project:read',
      },
    })
    const { db, create } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:completeOAuth']?.({
        pluginId: 'posthog',
        sourceType: 'posthog',
        code: 'code-1',
        state: 'state-1',
        clientId: 'client-id',
        name: 'OAuth PostHog',
        projectIds: ['999'],
        baseUrl: 'https://eu.posthog.com',
      }),
    ).resolves.toMatchObject({
      source: {
        pluginId: 'posthog',
        sourceType: 'posthog',
        name: 'OAuth PostHog',
        configuration: {
          baseUrl: 'https://eu.posthog.com',
          projectIds: ['999'],
        },
      },
      organizations: [],
      projects: [],
    })

    expect(runtime.executeActionMock).toHaveBeenCalledTimes(1)
    const executionRequest = runtime.executeActionMock.mock.calls[0]?.[0]
    expect(executionRequest).toMatchObject({
      pluginId: 'posthog',
      actionId: 'exchange_code_for_token',
    })
    expect(executionRequest?.input).toMatchObject({
      code: 'code-1',
      clientId: 'client-id',
    })

    const createCall = create.mock.calls[0]?.[0]
    expect(createCall).toBeDefined()
    expect(createCall?.data).toMatchObject({
      sourceType: 'posthog',
      name: 'OAuth PostHog',
      accessTokenRef: 'phx-oauth-token',
      refreshTokenRef: 'phr-oauth-refresh-token',
      grantedScopes: JSON.stringify(['error_tracking:read', 'project:read']),
    })
    expect(JSON.parse(String(createCall?.data.configuration))).toEqual({
      baseUrl: 'https://eu.posthog.com',
      oauthClientId: 'client-id',
      projectIds: ['999'],
    })
  })

  it('rejects OAuth completion without a matching code plugin', async () => {
    const runtime = new TestPluginRuntimeService([])
    const { db, create } = createTestDb()
    const oauthBindings = createDesktopOauthManagerBindings(
      'bitsentry-desktop-ce://oauth/callback',
    )
    const handlers = createDesktopErrorSourcesHandlers(db, {
      OauthManagerService: oauthBindings.OauthManagerService,
      pluginRuntime: runtime,
    })

    await expect(
      handlers['errorSources:completeOAuth']?.({
        pluginId: 'posthog',
        sourceType: 'posthog',
        code: 'code-1',
        state: 'state-1',
      }),
    ).rejects.toThrow(
      'Error source plugin "posthog" does not match source type posthog',
    )
    expect(runtime.executeActionMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
