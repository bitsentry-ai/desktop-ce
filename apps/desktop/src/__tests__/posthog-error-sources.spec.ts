import { EventEmitter } from 'events'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    queueMicrotask(() => {
      child.emit('spawn')
    })
    return child
  }),
}))

vi.mock('child_process', () => ({
  spawn: childProcessMocks.spawnMock,
}))

import {
  createErrorSourceSchema,
} from '@bitsentry-ce/core/features/error-sources'
import {
  OauthManagerService,
} from '../main/features/error-sources/services/oauth-manager.service'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import type { OAuthProviderConfig } from '@bitsentry-ce/core/features/error-sources/desktop-oauth-manager'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
  DesktopPluginDescriptor,
} from '@bitsentry-ce/core/features/plugins'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function getOpenExternalInvocation(urlMatcher: unknown): { command: string; args: unknown[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [urlMatcher] }
  }

  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/d', '/s', '/c', 'start', '', urlMatcher] }
  }

  return { command: 'xdg-open', args: [urlMatcher] }
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  throw new Error('Expected request body to be form encoded text')
}

const posthogOauthConfig: OAuthProviderConfig = {
  envClientIdName: 'POSTHOG_OAUTH_CLIENT_ID',
  envClientSecretName: 'POSTHOG_OAUTH_CLIENT_SECRET',
  envRedirectUriName: 'POSTHOG_OAUTH_REDIRECT_URI',
  defaultRedirectUri: 'bitsentry-desktop-ce://oauth/callback',
  scopes: ['organization:read', 'project:read', 'query:read'],
  publicClient: true,
}

function createPluginRuntime(
  descriptors: DesktopPluginDescriptor[],
  executeAction?: (
    input: DesktopPluginExecutionRequest,
  ) => Promise<DesktopPluginExecutionResult>,
): DesktopPluginRuntimeService {
  return new (class TestPluginRuntimeService extends DesktopPluginRuntimeService {
    listPlugins() {
      return descriptors
    }

    getPlugin(pluginId: string) {
      return descriptors.find((plugin) => plugin.id === pluginId) ?? null
    }

    executeAction(
      input: DesktopPluginExecutionRequest,
    ): Promise<DesktopPluginExecutionResult> {
      if (executeAction !== undefined) {
        return executeAction(input)
      }

      return Promise.reject(
        new Error('executeAction is not used by these PostHog OAuth tests'),
      )
    }
  })()
}

function createOAuthDescriptor(input: {
  pluginId: string
  sourceType: 'github' | 'posthog'
  oauth?: OAuthProviderConfig
}): DesktopPluginDescriptor {
  return {
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
      'build_authorize_url',
      'exchange_code_for_token',
      'refresh_token',
    ].map((id) => ({
      id,
      title: id,
      description: `${id} action.`,
      riskLevel: 'read',
      fields: [],
    })),
  }
}

function createRepoPluginRuntime() {
  return createDesktopNodePluginRuntimeService([
    path.resolve(process.cwd(), '../../packages/plugins'),
  ])
}

describe('posthog error source support', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts PostHog code-plugin create inputs in the shared schema', () => {
    expect(
      createErrorSourceSchema.parse({
        pluginId: 'posthog',
        sourceType: 'posthog',
        name: 'Production PostHog',
        setupValues: {
          authToken: 'phx-token',
          baseUrl: 'https://eu.posthog.com',
          projectIds: ['123', '456'],
        },
      }),
    ).toMatchObject({
      pluginId: 'posthog',
      sourceType: 'posthog',
      setupValues: {
        authToken: 'phx-token',
        baseUrl: 'https://eu.posthog.com',
        projectIds: ['123', '456'],
      },
    })
  })

  it('accepts first-party code-plugin create inputs in the shared schema', () => {
    expect(
      createErrorSourceSchema.parse({
        pluginId: 'github',
        sourceType: 'github',
        name: 'GitHub Issues',
        setupValues: {
          owner: 'bitsentry-ai',
          repo: 'monorepo',
        },
        configuration: {
          defaultQuery: 'is:issue is:open',
        },
      }),
    ).toMatchObject({
      pluginId: 'github',
      sourceType: 'github',
      name: 'GitHub Issues',
      logLevelThreshold: 'error',
      syncEnabled: true,
      autoDiagnosisEnabled: false,
    })
  })

  it('fetches PostHog project details through a project-based endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 177710,
          name: 'Default project',
          organization: 'org-1',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

    const runtime = createRepoPluginRuntime()
    const result = await runtime.executeAction({
      pluginId: 'posthog',
      actionId: 'get_project',
      auth: {
        accessToken: 'phx-token',
        baseUrl: 'https://eu.posthog.com',
      },
      input: {
        projectId: '177710',
      },
    })

    expect(result.data).toEqual({
      id: '177710',
      slug: '177710',
      name: 'Default project',
      organizationId: 'org-1',
    })
    const [projectUrl, projectRequestInit] = fetchMock.mock.calls[0]
    expect(projectUrl).toBe('https://eu.posthog.com/api/projects/177710/')
    expect(projectRequestInit?.headers).toMatchObject({
      Authorization: 'Bearer phx-token',
    })
  })

  it('routes PostHog OAuth authorize and token requests through the selected base URL', async () => {
    const runtime = createRepoPluginRuntime()

    const authorizeResult = await runtime.executeAction({
      pluginId: 'posthog',
      actionId: 'build_authorize_url',
      auth: {
        baseUrl: 'https://eu.posthog.com',
      },
      input: {
        clientId: 'client-id',
        redirectUri: 'bitsentry-desktop-ce://oauth/callback',
        scopes: ['project:read', 'query:read'],
        state: 'state-1',
        codeChallenge: 'challenge-1',
      },
    })
    const authorizeUrl = new URL(String(asRecord(authorizeResult.data).authUrl))
    expect(authorizeUrl.origin).toBe('https://eu.posthog.com')
    expect(authorizeUrl.pathname).toBe('/oauth/authorize/')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('client-id')

    const tokenResponse = () =>
      new Response(
        JSON.stringify({
          access_token: 'phx-access-token',
          refresh_token: 'phr-refresh-token',
          expires_in: 3600,
          scope: 'project:read query:read',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(tokenResponse())

    await expect(
      runtime.executeAction({
        pluginId: 'posthog',
        actionId: 'exchange_code_for_token',
        auth: {
          baseUrl: 'https://eu.posthog.com',
        },
        input: {
          clientId: 'client-id',
          clientSecret: '',
          code: 'code-1',
          redirectUri: 'bitsentry-desktop-ce://oauth/callback',
          codeVerifier: 'verifier-1',
        },
      }),
    ).resolves.toMatchObject({
      data: {
        accessToken: 'phx-access-token',
        refreshToken: 'phr-refresh-token',
      },
    })
    const [authorizationCodeUrl, authorizationCodeRequestInit] = fetchMock.mock.calls[0]
    expect(authorizationCodeUrl).toBe('https://eu.posthog.com/oauth/token/')
    expect(authorizationCodeRequestInit?.method).toBe('POST')
    expect(requestBodyText(authorizationCodeRequestInit?.body)).toContain(
      'grant_type=authorization_code',
    )

    await runtime.executeAction({
      pluginId: 'posthog',
      actionId: 'refresh_token',
      auth: {
        baseUrl: 'https://eu.posthog.com',
      },
      input: {
        clientId: 'client-id',
        clientSecret: '',
        refreshToken: 'phr-refresh-token',
      },
    })
    const [refreshUrl, refreshRequestInit] = fetchMock.mock.calls[1]
    expect(refreshUrl).toBe('https://eu.posthog.com/oauth/token/')
    expect(refreshRequestInit?.method).toBe('POST')
    expect(requestBodyText(refreshRequestInit?.body)).toContain('grant_type=refresh_token')
  })

  it('starts OAuth for index-installed plugin source types', async () => {
    const upsertSetting = vi.fn<DbClient['setting']['upsert']>().mockResolvedValue({})
    const db = {
      setting: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: upsertSetting,
        findUnique: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
      },
    }
    const executeAction = vi.fn(
      (_input: DesktopPluginExecutionRequest): Promise<DesktopPluginExecutionResult> =>
        Promise.resolve({
          pluginId: 'github',
          actionId: 'build_authorize_url',
          ok: true,
          status: 200,
          summary: 'Built authorize URL',
          data: {
            authUrl: 'https://github.com/login/oauth/authorize?state=state-1',
          },
        }),
    )
    const manager = new OauthManagerService(
      db,
      createPluginRuntime([
        createOAuthDescriptor({
          pluginId: 'github',
          sourceType: 'github',
          oauth: {
            envClientIdName: 'GITHUB_OAUTH_CLIENT_ID',
            envClientSecretName: 'GITHUB_OAUTH_CLIENT_SECRET',
            envRedirectUriName: 'GITHUB_OAUTH_REDIRECT_URI',
            defaultRedirectUri: 'bitsentry-desktop-ce://oauth/callback',
            scopes: ['repo'],
            publicClient: false,
          },
        }),
      ], executeAction),
    )

    const initiated = await manager.initiateOAuth('github', {
      pluginId: 'github',
      clientId: 'client-id',
    })

    expect(initiated.authUrl).toBe('https://github.com/login/oauth/authorize?state=state-1')
    const githubAuthorizeRequest = executeAction.mock.calls[0]?.[0] as
      | DesktopPluginExecutionRequest
      | undefined
    expect(githubAuthorizeRequest).toMatchObject({
      pluginId: 'github',
      actionId: 'build_authorize_url',
      auth: {},
    })
    expect(githubAuthorizeRequest?.input).toMatchObject({
      clientId: 'client-id',
      redirectUri: 'bitsentry-desktop-ce://oauth/callback',
      scopes: ['repo'],
    })
    const upsertInput = upsertSetting.mock.calls[0][0]
    expect(JSON.parse(String(upsertInput.create.value))).toMatchObject({
      sourceType: 'github',
      pluginId: 'github',
    })
  })

  it('starts OAuth for code plugins without host-owned base URL restrictions', async () => {
    const upsertSetting = vi.fn<DbClient['setting']['upsert']>().mockResolvedValue({})
    const db = {
      setting: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: upsertSetting,
        findUnique: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
      },
    }
    const executeAction = vi.fn(
      (_input: DesktopPluginExecutionRequest): Promise<DesktopPluginExecutionResult> =>
        Promise.resolve({
          pluginId: 'posthog',
          actionId: 'build_authorize_url',
          ok: true,
          status: 200,
          summary: 'Built authorize URL',
          data: {
            authUrl: 'https://posthog.example/oauth?state=state-1',
          },
        }),
    )
    const manager = new OauthManagerService(
      db,
      createPluginRuntime([
        createOAuthDescriptor({
          pluginId: 'posthog',
          sourceType: 'posthog',
          oauth: posthogOauthConfig,
        }),
      ], executeAction),
    )

    const initiated = await manager.initiateOAuth('posthog', {
      pluginId: 'posthog',
      clientId: 'client-id',
      baseUrl: 'https://self-hosted.posthog.internal',
    })

    expect(initiated.authUrl).toBe('https://posthog.example/oauth?state=state-1')
    const posthogAuthorizeRequest = executeAction.mock.calls[0]?.[0] as
      | DesktopPluginExecutionRequest
      | undefined
    expect(posthogAuthorizeRequest).toMatchObject({
      pluginId: 'posthog',
      actionId: 'build_authorize_url',
      auth: {
        baseUrl: 'https://self-hosted.posthog.internal',
      },
    })
    expect(posthogAuthorizeRequest?.input).toMatchObject({
      clientId: 'client-id',
    })
    const upsertInput = upsertSetting.mock.calls[0][0]
    expect(JSON.parse(String(upsertInput.create.value))).toMatchObject({
      sourceType: 'posthog',
      pluginId: 'posthog',
      providerBaseUrl: 'https://self-hosted.posthog.internal',
    })
  })

  it('rejects code plugins without plugin OAuth metadata', async () => {
    const db = {
      setting: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
      },
    }
    const executeAction = vi.fn()
    const manager = new OauthManagerService(
      db,
      createPluginRuntime([
        createOAuthDescriptor({
          pluginId: 'posthog',
          sourceType: 'posthog',
        }),
      ], executeAction),
    )

    await expect(
      manager.initiateOAuth('posthog', {
        pluginId: 'posthog',
        clientId: 'client-id',
        baseUrl: 'https://eu.posthog.com',
      }),
    ).rejects.toThrow('OAuth is not configured for source type: posthog')
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('preserves the selected PostHog base URL across OAuth state and token exchange', async () => {
    const upsertSetting = vi.fn<DbClient['setting']['upsert']>().mockResolvedValue({})
    const db = {
      setting: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: upsertSetting,
        findUnique: vi.fn().mockResolvedValue({
          key: 'errorSources.oauth.state-1',
          value: JSON.stringify({
            sourceType: 'posthog',
            pluginId: 'posthog',
            codeVerifier: 'verifier-1',
            createdAt: new Date().toISOString(),
            providerBaseUrl: 'https://eu.posthog.com',
          }),
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
    }
    const manager = new OauthManagerService(
      db,
      createRepoPluginRuntime(),
    )

    const initiated = await manager.initiateOAuth('posthog', {
      pluginId: 'posthog',
      clientId: 'client-id',
      baseUrl: 'https://eu.posthog.com',
    })

    expect(new URL(initiated.authUrl).origin).toBe('https://eu.posthog.com')
    const expectedOpenInvocation = getOpenExternalInvocation(
      expect.stringContaining('https://eu.posthog.com/oauth/authorize/'),
    )
    expect(childProcessMocks.spawnMock).toHaveBeenCalledWith(
      expectedOpenInvocation.command,
      expectedOpenInvocation.args,
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }),
    )
    const upsertInput = upsertSetting.mock.calls[0][0]
    expect(JSON.parse(String(upsertInput.create.value))).toMatchObject({
      sourceType: 'posthog',
      pluginId: 'posthog',
      providerBaseUrl: 'https://eu.posthog.com',
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'phx-access-token',
          refresh_token: 'phr-refresh-token',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )

    await manager.completeOAuth('posthog', {
      pluginId: 'posthog',
      code: 'code-1',
      state: 'state-1',
      clientId: 'client-id',
    })

    const [tokenUrl, tokenRequestInit] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://eu.posthog.com/oauth/token/')
    expect(tokenRequestInit?.method).toBe('POST')
    expect(requestBodyText(tokenRequestInit?.body)).toContain('code=code-1')
  })
})
