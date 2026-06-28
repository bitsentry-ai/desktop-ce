import { describe, expect, it, vi } from 'vitest'

import { ExternalSourceRunbookQueryService } from '@bitsentry-ce/core/features/error-sources'
import type { ErrorSource } from '@bitsentry-ce/core/features/error-sources/desktop-error-sources.types'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
} from '@bitsentry-ce/core/features/plugins'

function makeWazuhSource(overrides: Partial<ErrorSource> = {}): ErrorSource {
  return {
    id: 'source-wazuh',
    sourceType: 'wazuh',
    name: 'Wazuh',
    accessTokenRef: 'wazuh-secret',
    refreshTokenRef: null,
    expiresAt: null,
    grantedScopes: [],
    configuration: {
      baseUrl: 'https://wazuh.example.com:9200',
      indexPatterns: ['wazuh-alerts-*', 'wazuh-archives-*'],
    },
    logLevelThreshold: 'error',
    additionalMetadata: null,
    syncEnabled: true,
    autoDiagnosisEnabled: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSentrySource(overrides: Partial<ErrorSource> = {}): ErrorSource {
  return {
    id: 'source-sentry',
    sourceType: 'sentry',
    name: 'Sentry',
    accessTokenRef: 'sentry-secret',
    refreshTokenRef: null,
    expiresAt: null,
    grantedScopes: [],
    configuration: {
      orgSlug: 'bitsentry',
      projectIds: ['101', '102'],
      projectSlugs: ['api', 'worker'],
    },
    logLevelThreshold: 'error',
    additionalMetadata: null,
    syncEnabled: true,
    autoDiagnosisEnabled: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function createWazuhDescriptor(): DesktopPluginDescriptor {
  return {
    id: 'wazuh',
    name: 'Wazuh',
    version: '1.0.0',
    description: 'Wazuh code plugin.',
    metadata: {
      errorSource: {
        sourceType: 'wazuh',
        setupFields: [
          {
            key: 'indexUrl',
            target: 'baseUrl',
            storage: 'configuration',
            configurationKey: 'baseUrl',
            label: 'Wazuh index URL',
            required: true,
            control: 'text',
          },
          {
            key: 'indexPassword',
            target: 'authToken',
            storage: 'accessTokenRef',
            label: 'Wazuh index password',
            required: true,
            control: 'password',
          },
          {
            key: 'indexPatterns',
            target: 'indexPatterns',
            storage: 'configuration',
            configurationKey: 'indexPatterns',
            label: 'Index patterns',
            required: false,
            control: 'multiline_list',
          },
        ],
        providerActions: {
          queryIssues: 'query_issues',
          searchAlerts: 'search_alerts',
        },
      },
    },
    auth: {
      fields: [],
    },
    actions: [],
    triggers: [],
  }
}

function createSentryDescriptor(): DesktopPluginDescriptor {
  return {
    id: 'sentry',
    name: 'Sentry',
    version: '1.0.0',
    description: 'Sentry code plugin.',
    metadata: {
      errorSource: {
        sourceType: 'sentry',
        setupFields: [
          {
            key: 'authToken',
            target: 'authToken',
            storage: 'accessTokenRef',
            label: 'Sentry auth token',
            required: true,
            control: 'password',
          },
          {
            key: 'organizationSlug',
            target: 'organizationSlug',
            storage: 'configuration',
            configurationKey: 'orgSlug',
            label: 'Organization slug',
            required: true,
            control: 'text',
          },
          {
            key: 'projectSlugs',
            target: 'projectSlugs',
            storage: 'configuration',
            configurationKey: 'projectSlugs',
            label: 'Project slugs',
            required: false,
            control: 'multiline_list',
          },
        ],
        providerActions: {
          queryIssues: 'query_issues',
        },
      },
    },
    auth: {
      fields: [],
    },
    actions: [],
    triggers: [],
  }
}

class TestPluginRuntimeService extends DesktopPluginRuntimeService {
  readonly executeActionMock = vi.fn<
    (input: DesktopPluginExecutionRequest) => Promise<DesktopPluginExecutionResult>
  >()

  constructor(private readonly descriptors: DesktopPluginDescriptor[]) {
    super()
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

describe('ExternalSourceRunbookQueryService code plugin queries', () => {
  it('routes Sentry runbook queries through the executable plugin action', async () => {
    const source = makeSentrySource()
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      update: vi.fn(),
    }
    const providerFactory = {
      getProvider: vi.fn(() => {
        throw new Error('Sentry should not use a built-in provider')
      }),
    }
    const pluginRuntime = new TestPluginRuntimeService([createSentryDescriptor()])
    pluginRuntime.executeActionMock.mockResolvedValue({
      pluginId: 'sentry',
      actionId: 'query_issues',
      ok: true,
      status: 200,
      summary: 'Fetched 1 Sentry issue.',
      data: {
        issues: [{ id: 'ISSUE-1', title: 'API is unhappy' }],
        hasMore: false,
      },
    })

    const service = new ExternalSourceRunbookQueryService(
      sourcesRepository,
      providerFactory,
      { defaultLimit: 3 },
      pluginRuntime,
    )

    await expect(
      service.execute({
        sourceId: source.id,
        query: 'is:unresolved',
      }),
    ).resolves.toContain('API is unhappy')

    expect(providerFactory.getProvider).not.toHaveBeenCalled()
    const firstPluginCall = pluginRuntime.executeActionMock.mock.calls[0]
    if (firstPluginCall === undefined) {
      throw new Error('Expected Sentry runbook query to execute a plugin action')
    }
    const [pluginRequest] = firstPluginCall
    expect(pluginRequest.auth).toMatchObject({
      accessToken: 'sentry-secret',
      authToken: 'sentry-secret',
      orgSlug: 'bitsentry',
      organizationSlug: 'bitsentry',
      projectSlugs: ['api', 'worker'],
    })
    expect(pluginRequest).toMatchObject({
      pluginId: 'sentry',
      actionId: 'query_issues',
      input: {
        query: 'is:unresolved',
        limit: 3,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: 'sentry',
        orgSlug: 'bitsentry',
        projectIds: ['101', '102'],
        projectSlugs: ['api', 'worker'],
      },
    })
  })

  it('routes Wazuh runbook queries through the executable plugin action', async () => {
    const source = makeWazuhSource()
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      update: vi.fn(),
    }
    const providerFactory = {
      getProvider: vi.fn(() => {
        throw new Error('Wazuh should not use a built-in provider')
      }),
    }
    const pluginRuntime = new TestPluginRuntimeService([createWazuhDescriptor()])
    pluginRuntime.executeActionMock.mockResolvedValue({
      pluginId: 'wazuh',
      actionId: 'query_issues',
      ok: true,
      status: 200,
      summary: 'Fetched 1 Wazuh issue.',
      data: {
        output: 'Wazuh plugin output',
        issues: [{ id: 'alert-1', title: 'sshd brute force attempt' }],
        hasMore: false,
      },
    })

    const service = new ExternalSourceRunbookQueryService(
      sourcesRepository,
      providerFactory,
      { defaultLimit: 2 },
      pluginRuntime,
    )

    await expect(
      service.execute({
        sourceId: source.id,
        query: 'rule.level:>=10',
      }),
    ).resolves.toBe('Wazuh plugin output')

    expect(providerFactory.getProvider).not.toHaveBeenCalled()
    const firstPluginCall = pluginRuntime.executeActionMock.mock.calls[0]
    if (firstPluginCall === undefined) {
      throw new Error('Expected Wazuh runbook query to execute a plugin action')
    }
    const [pluginRequest] = firstPluginCall
    expect(pluginRequest.auth).toMatchObject({
      baseUrl: 'https://wazuh.example.com:9200',
      indexUrl: 'https://wazuh.example.com:9200',
      indexPassword: 'wazuh-secret',
      indexPatterns: ['wazuh-alerts-*', 'wazuh-archives-*'],
    })
    expect(pluginRequest).toMatchObject({
      pluginId: 'wazuh',
      actionId: 'query_issues',
      input: {
        query: 'rule.level:>=10',
        limit: 2,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: 'wazuh',
        indexPattern: 'wazuh-alerts-*,wazuh-archives-*',
      },
    })
  })
})
