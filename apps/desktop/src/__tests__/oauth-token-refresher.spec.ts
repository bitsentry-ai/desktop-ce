import { describe, expect, it, vi } from 'vitest'

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
})
