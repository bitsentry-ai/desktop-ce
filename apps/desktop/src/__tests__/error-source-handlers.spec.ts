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
        providerActions: {
          queryIssues: 'query_issues',
        },
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
    actions: [],
    triggers: [],
  }
}

function createDb(): DbClient {
  const now = new Date().toISOString()

  const db: unknown = {
    errorSource: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
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
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  }
  return db as DbClient
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
})
