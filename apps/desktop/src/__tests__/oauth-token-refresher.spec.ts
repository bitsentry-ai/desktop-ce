import { describe, expect, it, vi } from 'vitest'

import type { SqliteErrorSourcesRepositoryAdapter } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter'
import {
  refreshSourceAccessToken,
  type RefreshAccessTokenInput,
} from '@bitsentry-ce/core/features/error-sources/desktop-oauth-token-refresher'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
} from '@bitsentry-ce/core/features/plugins'

function createOAuthPluginRuntime(input: {
  pluginId: string
  sourceType: 'github' | 'posthog'
  oauth?: {
    envClientIdName: string
    envClientSecretName: string
    publicClient: boolean
  }
  refreshResult?: Record<string, unknown>
}): {
  runtime: DesktopPluginRuntimeService
  executeAction: ReturnType<typeof vi.fn>
} {
  const descriptor: DesktopPluginDescriptor = {
    id: input.pluginId,
    name: input.pluginId,
    version: 'test',
    description: `${input.pluginId} OAuth test plugin`,
    type: "data_source",
    metadata: {
      dataSource: {
        sourceType: input.sourceType,
        oauth: input.oauth,
        setupFields: [],
      },
    },
    auth: {
      fields: [],
    },
    actions: [
      {
        id: 'refresh_token',
        title: 'Refresh token',
        description: 'Refresh OAuth token',
        riskLevel: 'read',
        fields: [],
      },
    ],
  }
  const executeAction = vi.fn(
    (_request: DesktopPluginExecutionRequest): Promise<DesktopPluginExecutionResult> =>
      Promise.resolve({
        pluginId: input.pluginId,
        actionId: 'refresh_token',
        ok: true,
        status: 200,
        summary: 'Refreshed token',
        data: input.refreshResult ?? {},
      }),
  )
  const runtime = new (class TestPluginRuntimeService extends DesktopPluginRuntimeService {
    listPlugins() {
      return [descriptor]
    }

    getPlugin(pluginId: string) {
      if (pluginId === input.pluginId) {
        return descriptor
      }

      return null
    }

    executeAction(request: DesktopPluginExecutionRequest) {
      return executeAction(request)
    }
  })()

  return { runtime, executeAction }
}

function asPluginRuntime(runtime: unknown): DesktopPluginRuntimeService {
  return runtime as DesktopPluginRuntimeService
}

describe('refreshSourceAccessToken', () => {
  it('uses stored OAuth tokens directly before deciding whether to refresh', async () => {
    await expect(
      refreshSourceAccessToken({
        source: {
          id: 'source-1',
          name: 'Production PostHog',
          sourceType: 'posthog' as const,
          accessTokenRef: 'stored-access-token',
          refreshTokenRef: 'stored-refresh-token',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          grantedScopes: [],
          configuration: {},
          logLevelThreshold: 'error',
          additionalMetadata: null,
          syncEnabled: true,
          autoDiagnosisEnabled: false,
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        sourcesRepository: {
          update: vi.fn(),
        },
      } satisfies RefreshAccessTokenInput),
    ).resolves.toBe('stored-access-token')
  })

  it('refreshes index-installed plugin sources from plugin OAuth metadata', async () => {
    const update = vi.fn().mockResolvedValue({})
    const { runtime, executeAction } = createOAuthPluginRuntime({
      pluginId: 'github',
      sourceType: 'github',
      oauth: {
        envClientIdName: 'GITHUB_OAUTH_CLIENT_ID',
        envClientSecretName: 'GITHUB_OAUTH_CLIENT_SECRET',
        publicClient: false,
      },
      refreshResult: {
        accessToken: 'refreshed-github-access-token',
        refreshToken: 'refreshed-github-refresh-token',
        expiresIn: 3600,
        scope: 'repo read:org',
      },
    })

    await expect(
      refreshSourceAccessToken({
        source: {
          id: 'source-2',
          name: 'GitHub',
          sourceType: 'github' as const,
          accessTokenRef: 'stale-access-token',
          refreshTokenRef: 'stored-refresh-token',
          expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          grantedScopes: ['repo'],
          configuration: {
            oauthClientId: 'client-id',
            oauthClientSecret: 'client-secret',
          },
          additionalMetadata: {
            pluginId: 'github',
          },
        },
        sourcesRepository: {
          update,
        },
        pluginRuntime: runtime,
      } satisfies RefreshAccessTokenInput),
    ).resolves.toBe('refreshed-github-access-token')

    expect(executeAction).toHaveBeenCalledWith({
      pluginId: 'github',
      actionId: 'refresh_token',
      auth: {},
      input: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'stored-refresh-token',
      },
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-2',
        accessTokenRef: 'refreshed-github-access-token',
        refreshTokenRef: 'refreshed-github-refresh-token',
        grantedScopes: ['repo', 'read:org'],
      }),
    )
  })

  it('does not fall back to host-owned OAuth refresh config', async () => {
    const { runtime, executeAction } = createOAuthPluginRuntime({
      pluginId: 'posthog',
      sourceType: 'posthog',
    })

    await expect(
      refreshSourceAccessToken({
        source: {
          id: 'source-3',
          name: 'Production PostHog',
          sourceType: 'posthog' as const,
          accessTokenRef: 'stale-access-token',
          refreshTokenRef: 'stored-refresh-token',
          expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          grantedScopes: ['project:read'],
          configuration: {
            oauthClientId: 'client-id',
          },
          additionalMetadata: {
            pluginId: 'posthog',
          },
        },
        sourcesRepository: {
          update: vi.fn(),
        },
        pluginRuntime: runtime,
      } satisfies RefreshAccessTokenInput),
    ).rejects.toThrow(
      'OAuth refresh is not configured for source type: posthog',
    )

    expect(executeAction).not.toHaveBeenCalled()
  })

  it('uses plugin-specific OAuth refresh env names for vendor PostHog sources', async () => {
    const originalClientId = process.env.VENDOR_POSTHOG_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.VENDOR_POSTHOG_OAUTH_CLIENT_SECRET
    process.env.VENDOR_POSTHOG_OAUTH_CLIENT_ID = 'vendor-client-id'
    process.env.VENDOR_POSTHOG_OAUTH_CLIENT_SECRET = 'vendor-client-secret'

    try {
      const sourcesRepository = {
        update: vi.fn().mockResolvedValue({ id: 'source-2' }),
      } satisfies Pick<SqliteErrorSourcesRepositoryAdapter, 'update'>
      const getPlugin = vi.fn((pluginId: string) => {
        if (pluginId !== 'vendor-posthog') {
          return null
        }

        return {
          id: 'vendor-posthog',
          name: 'Vendor PostHog',
          version: '1.0.0',
          description: 'Vendor-specific PostHog plugin',
          type: 'data_source' as const,
          metadata: {
            dataSource: {
              sourceType: 'posthog' as const,
              setupFields: [],
              oauth: {
                envClientIdName: 'VENDOR_POSTHOG_OAUTH_CLIENT_ID',
                envClientSecretName: 'VENDOR_POSTHOG_OAUTH_CLIENT_SECRET',
                publicClient: false,
              },
            },
          },
          auth: { fields: [] },
          actions: [
            {
              id: 'refresh_token',
              title: 'Refresh token',
              description: 'Refreshes OAuth tokens.',
              riskLevel: 'write' as const,
              fields: [],
            },
          ],
        }
      })
      const executeAction = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        summary: 'refreshed',
        data: {
          accessToken: 'refreshed-access-token',
          refreshToken: 'refreshed-refresh-token',
          expiresIn: 3600,
          scope: 'projects:read vendor:events',
        },
      })
      const pluginRuntime: Pick<
        DesktopPluginRuntimeService,
        'getPlugin' | 'executeAction'
      > = {
        getPlugin,
        executeAction,
      }

      await expect(
        refreshSourceAccessToken({
          source: {
            id: 'source-2',
            name: 'Vendor PostHog',
            sourceType: 'posthog' as const,
            accessTokenRef: '',
            refreshTokenRef: 'refresh-token-1',
            expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            grantedScopes: ['projects:read'],
            configuration: {},
            additionalMetadata: { pluginId: 'vendor-posthog' },
          },
          sourcesRepository,
          pluginRuntime: asPluginRuntime(pluginRuntime),
        }),
      ).resolves.toBe('refreshed-access-token')

      expect(executeAction).toHaveBeenCalledWith({
        pluginId: 'vendor-posthog',
        actionId: 'refresh_token',
        auth: {},
        input: {
          clientId: 'vendor-client-id',
          clientSecret: 'vendor-client-secret',
          refreshToken: 'refresh-token-1',
        },
      })
      expect(sourcesRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'source-2',
          accessTokenRef: 'refreshed-access-token',
          refreshTokenRef: 'refreshed-refresh-token',
          grantedScopes: ['projects:read', 'vendor:events'],
        }),
      )
    } finally {
      if (originalClientId == null) {
        delete process.env.VENDOR_POSTHOG_OAUTH_CLIENT_ID
      } else {
        process.env.VENDOR_POSTHOG_OAUTH_CLIENT_ID = originalClientId
      }
      if (originalClientSecret == null) {
        delete process.env.VENDOR_POSTHOG_OAUTH_CLIENT_SECRET
      } else {
        process.env.VENDOR_POSTHOG_OAUTH_CLIENT_SECRET = originalClientSecret
      }
    }
  })
})
