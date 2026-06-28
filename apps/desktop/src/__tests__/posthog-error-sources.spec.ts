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
  assertAllowedPostHogBaseUrl,
  createErrorSourceSchema,
  ErrorSourceProviderFactory,
  getProviderForSource,
  parsePostHogAllowedHostsEnv,
  resolveSameOriginNextUrl,
} from '@bitsentry-ce/core/features/error-sources'
import {
  OauthManagerService,
  PROVIDER_CONFIGS,
} from '../main/features/error-sources/services/oauth-manager.service'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
  DesktopPluginDescriptor,
} from '@bitsentry-ce/core/features/plugins'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'

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

const posthogPluginDescriptor: DesktopPluginDescriptor = {
  id: 'posthog',
  name: 'PostHog',
  version: 'test',
  description: 'Test PostHog code plugin descriptor.',
  metadata: {
    errorSource: {
      sourceType: 'posthog',
      setupFields: [],
      providerActions: {
        buildAuthorizeUrl: 'build_authorize_url',
        exchangeCodeForToken: 'exchange_code_for_token',
        refreshToken: 'refresh_token',
        listOrganizations: 'list_organizations',
        listProjects: 'list_projects',
        getProject: 'get_project',
        queryIssues: 'query_issues',
        listIssues: 'list_issues',
        listIssueEvents: 'list_issue_events',
      },
    },
  },
  auth: {
    fields: [],
  },
  actions: [],
  triggers: [],
}

function createPluginRuntime(
  descriptors: DesktopPluginDescriptor[],
): DesktopPluginRuntimeService {
  return new (class TestPluginRuntimeService extends DesktopPluginRuntimeService {
    listPlugins() {
      return descriptors
    }

    getPlugin(pluginId: string) {
      return descriptors.find((plugin) => plugin.id === pluginId) ?? null
    }

    executeAction(
      _input: DesktopPluginExecutionRequest,
    ): Promise<DesktopPluginExecutionResult> {
      return Promise.reject(
        new Error('executeAction is not used by these PostHog OAuth tests'),
      )
    }
  })()
}

function createRepoPluginProviderFactory(): ErrorSourceProviderFactory {
  return new ErrorSourceProviderFactory(
    createDesktopNodePluginRuntimeService([
      path.resolve(process.cwd(), '../../packages/plugins'),
    ]),
  )
}

function createRepoPostHogProvider(baseUrl = 'https://eu.posthog.com') {
  return getProviderForSource(createRepoPluginProviderFactory(), {
    sourceType: 'posthog',
    configuration: { posthogBaseUrl: baseUrl },
  })
}

function requireProjectProvider(provider: ReturnType<typeof createRepoPostHogProvider>) {
  if (typeof (provider as { getProject?: unknown }).getProject !== 'function') {
    throw new Error('Expected PostHog plugin provider to expose getProject')
  }

  return provider as typeof provider & {
    getProject(input: {
      accessToken: string
      projectId: string
    }): Promise<{
      id: string
      slug: string
      name: string
      organizationId?: string
    }>
  }
}

describe('posthog error source support', () => {
  const originalAllowedHosts = process.env.POSTHOG_ALLOWED_BASE_URLS

  afterEach(() => {
    if (originalAllowedHosts == null) {
      delete process.env.POSTHOG_ALLOWED_BASE_URLS
    } else {
      process.env.POSTHOG_ALLOWED_BASE_URLS = originalAllowedHosts
    }
    vi.restoreAllMocks()
  })

  it('validates default and explicitly allowed PostHog hosts', () => {
    expect(assertAllowedPostHogBaseUrl(undefined)).toBe('https://us.posthog.com')
    expect(assertAllowedPostHogBaseUrl('https://eu.posthog.com/path')).toBe(
      'https://eu.posthog.com',
    )

    const extraHosts = parsePostHogAllowedHostsEnv(
      'https://posthog.example.com, https://posthog.internal:8443',
    )

    expect(
      assertAllowedPostHogBaseUrl('https://posthog.example.com/app', {
        extraAllowedHosts: extraHosts,
      }),
    ).toBe('https://posthog.example.com')
    expect(
      assertAllowedPostHogBaseUrl('https://posthog.internal:8443/app', {
        extraAllowedHosts: extraHosts,
      }),
    ).toBe('https://posthog.internal:8443')
  })

  it('rejects unsafe PostHog base URLs and cross-origin pagination URLs', () => {
    expect(() => assertAllowedPostHogBaseUrl('http://us.posthog.com')).toThrow(
      'PostHog base URL must use https://',
    )
    expect(() =>
      assertAllowedPostHogBaseUrl('https://metadata.google.internal'),
    ).toThrow('is not in the allowlist')
    expect(() =>
      resolveSameOriginNextUrl(
        'https://evil.example/api/projects/1/query/?offset=100',
        'https://us.posthog.com',
      ),
    ).toThrow('Refusing to follow cross-origin PostHog pagination URL')
  })

  it('accepts PostHog code-plugin create inputs in the shared schema', () => {
    expect(
      createErrorSourceSchema.parse({
        pluginId: 'posthog',
        sourceType: 'posthog',
        name: 'Production PostHog',
        authToken: 'phx-token',
        projectIds: ['123', '456'],
        baseUrl: 'https://eu.posthog.com',
        setupValues: {
          baseUrl: 'https://eu.posthog.com',
          projectIds: ['123', '456'],
        },
      }),
    ).toMatchObject({
      pluginId: 'posthog',
      sourceType: 'posthog',
      projectIds: ['123', '456'],
      baseUrl: 'https://eu.posthog.com',
    })
  })

  it('accepts marketplace plugin create inputs in the shared schema', () => {
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

  it('registers PostHog when a code plugin descriptor is available and preserves custom host binding', () => {
    const factory = new ErrorSourceProviderFactory(
      createPluginRuntime([posthogPluginDescriptor]),
    )

    expect(factory.getProvider('posthog')).toMatchObject({ sourceType: 'posthog' })
    expect(
      getProviderForSource(factory, {
        sourceType: 'posthog',
        configuration: { posthogBaseUrl: 'https://eu.posthog.com' },
      }),
    ).toMatchObject({ sourceType: 'posthog' })
    expect(() =>
      getProviderForSource(factory, {
        sourceType: 'posthog',
        configuration: { posthogBaseUrl: 'https://metadata.google.internal' },
      }),
    ).toThrow('is not in the allowlist')
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

    const provider = requireProjectProvider(createRepoPostHogProvider())

    await expect(
      provider.getProject({ accessToken: 'phx-token', projectId: '177710' }),
    ).resolves.toEqual({
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

  it('keeps PostHog OAuth configured as a public-client PKCE provider', () => {
    expect(PROVIDER_CONFIGS.posthog).toMatchObject({
      envClientIdName: 'POSTHOG_OAUTH_CLIENT_ID',
      envClientSecretName: 'POSTHOG_OAUTH_CLIENT_SECRET',
      publicClient: true,
    })
    expect(PROVIDER_CONFIGS.posthog.scopes).toEqual(
      expect.arrayContaining(['organization:read', 'project:read', 'query:read']),
    )
  })

  it('routes PostHog OAuth authorize and token requests through the selected base URL', async () => {
    const provider = createRepoPostHogProvider()

    const authorizeUrl = new URL(
      await provider.buildAuthorizeUrl({
        clientId: 'client-id',
        redirectUri: 'bitsentry-desktop-ce://oauth/callback',
        scopes: ['project:read', 'query:read'],
        state: 'state-1',
        codeChallenge: 'challenge-1',
      }),
    )
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
      provider.exchangeCodeForToken({
        clientId: 'client-id',
        clientSecret: '',
        code: 'code-1',
        redirectUri: 'bitsentry-desktop-ce://oauth/callback',
        codeVerifier: 'verifier-1',
      }),
    ).resolves.toMatchObject({
      accessToken: 'phx-access-token',
      refreshToken: 'phr-refresh-token',
    })
    const [authorizationCodeUrl, authorizationCodeRequestInit] = fetchMock.mock.calls[0]
    expect(authorizationCodeUrl).toBe('https://eu.posthog.com/oauth/token/')
    expect(authorizationCodeRequestInit?.method).toBe('POST')
    expect(requestBodyText(authorizationCodeRequestInit?.body)).toContain(
      'grant_type=authorization_code',
    )

    await provider.refreshToken({
      clientId: 'client-id',
      clientSecret: '',
      refreshToken: 'phr-refresh-token',
    })
    const [refreshUrl, refreshRequestInit] = fetchMock.mock.calls[1]
    expect(refreshUrl).toBe('https://eu.posthog.com/oauth/token/')
    expect(refreshRequestInit?.method).toBe('POST')
    expect(requestBodyText(refreshRequestInit?.body)).toContain('grant_type=refresh_token')
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
      createRepoPluginProviderFactory(),
    )

    const initiated = await manager.initiateOAuth('posthog', {
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
