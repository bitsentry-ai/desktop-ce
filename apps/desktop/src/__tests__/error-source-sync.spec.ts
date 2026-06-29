import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SqliteErrorSourcesRepositoryAdapter,
  type ErrorSourceDatabase,
} from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter'
import { ErrorSourceProviderFactory } from '@bitsentry-ce/core/features/error-sources'
import { ErrorSourceSyncService } from '@bitsentry-ce/core/features/error-sources/desktop-error-source-sync.service'
import type { UpsertErrorIssueInput } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-issues.adapter'
import type { ErrorIssue, ErrorSource } from '@bitsentry-ce/core/features/error-sources/desktop-error-sources.types'
import {
  DesktopPluginRuntimeService,
  type DesktopPluginDescriptor,
  type DesktopPluginExecutionRequest,
  type DesktopPluginExecutionResult,
} from '@bitsentry-ce/core/features/plugins'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import path from 'path'

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
    actions: [createProviderAction('list_issues')],
    triggers: [],
  }
}

function makeSource(overrides: Partial<ErrorSource> = {}): ErrorSource {
  return {
    id: 'source-sentry',
    sourceType: 'sentry',
    name: 'Jagad',
    accessTokenRef: 'token',
    refreshTokenRef: null,
    expiresAt: null,
    grantedScopes: [],
    configuration: {
      orgSlug: 'jagad',
      projectIds: ['4504367120777216'],
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

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null
}

function rejectUnexpectedDatabaseCall(): Promise<never> {
  return Promise.reject(new Error('Unexpected error source database call'))
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
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('Sentry external source sync', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requires sync to run through a matching code plugin', async () => {
    const source = makeSource()
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    }
    const providerFactory = {
      getProvider: vi.fn(() => {
        throw new Error('Legacy provider should not be used for source sync')
      }),
    }
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
        upsert: vi.fn((input: UpsertErrorIssueInput) => Promise.resolve(makeIssue(input))),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      providerFactory,
      new TestPluginRuntimeService([]),
    )

    await expect(service.syncSourceById(source.id)).rejects.toThrow(
      'Error source plugin "sentry" does not match source type sentry',
    )
    expect(providerFactory.getProvider).not.toHaveBeenCalled()
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: 'failed',
        lastSyncError:
          'Error source plugin "sentry" does not match source type sentry',
      }),
    )
  })

  it('queries Sentry by last seen when doing incremental source sync', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const pluginDirectory = path.resolve(process.cwd(), '../../packages/plugins')
    const provider = new ErrorSourceProviderFactory(
      createDesktopNodePluginRuntimeService([pluginDirectory]),
    ).getProvider('sentry')
    await provider.listIssues({
      accessToken: 'token',
      orgSlug: 'jagad',
      projectIds: ['4504367120777216'],
      since: '2026-06-01T08:00:00.000Z',
      limit: 20,
    })

    const url = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('limit=20')
    expect(url).toContain('project=4504367120777216')
    expect(decodeURIComponent(url)).toContain('query=lastSeen:>=2026-06-01T08:00:00.000Z')
  })

  it('can clear interrupted in-progress source sync status', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const db: ErrorSourceDatabase = {
      errorSource: {
        create: rejectUnexpectedDatabaseCall,
        delete: rejectUnexpectedDatabaseCall,
        findMany: rejectUnexpectedDatabaseCall,
        findUnique: rejectUnexpectedDatabaseCall,
        update: rejectUnexpectedDatabaseCall,
        updateMany,
      },
    }
    const repository = new SqliteErrorSourcesRepositoryAdapter(db)

    await expect(
      repository.markInterruptedSyncsFailed('Previous sync was interrupted before completion.'),
    ).resolves.toBe(1)

    expect(updateMany).toHaveBeenCalledWith({
      where: { lastSyncStatus: 'in_progress' },
      data: {
        lastSyncStatus: 'failed',
        lastSyncError: 'Previous sync was interrupted before completion.',
      },
    })
  })

  it('syncs built-in-named sources through matching code plugin actions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'))

    const source = makeSource({
      id: 'source-posthog',
      sourceType: 'posthog',
      name: 'Production PostHog',
      additionalMetadata: { pluginId: 'posthog' },
    })
    const runtime = new TestPluginRuntimeService([createPostHogPluginDescriptor()])
    runtime.executeActionMock.mockResolvedValue({
      pluginId: 'posthog',
      actionId: 'list_issues',
      ok: true,
      status: 200,
      summary: 'Listed PostHog issues.',
      data: {
        issues: [],
        hasMore: false,
      },
    })
    const sourcesRepository = {
      findById: vi.fn().mockResolvedValue(source),
      findSyncEnabled: vi.fn().mockResolvedValue([source]),
      updateSyncStatus: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(source),
    }
    const providerFactory = {
      getProvider: vi.fn(() => {
        throw new Error('Legacy provider should not be used for plugin-backed sync')
      }),
    }
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
        upsert: vi.fn((input: UpsertErrorIssueInput) => Promise.resolve(makeIssue(input))),
        findById: vi.fn(),
      },
      {
        upsert: vi.fn(),
        findById: vi.fn(),
      },
      providerFactory,
      runtime,
    )

    const result = await service.syncSourceById(source.id)

    expect(result).toEqual({
      sourceId: source.id,
      syncedIssues: 0,
      syncedEvents: 0,
    })
    expect(providerFactory.getProvider).not.toHaveBeenCalled()
    const executionRequest = runtime.executeActionMock.mock.calls[0]?.[0]
    expect(executionRequest).toMatchObject({
      pluginId: 'posthog',
      actionId: 'list_issues',
      auth: {
        accessToken: 'token',
      },
    })
    expect(executionRequest?.input).toMatchObject({
      sourceId: source.id,
      sourceName: 'Production PostHog',
      sourceType: 'posthog',
      orgSlug: 'jagad',
      projectIds: ['4504367120777216'],
      query: '*',
      limit: 100,
      until: '2026-06-01T09:00:00.000Z',
    })
    expect(sourcesRepository.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: source.id,
        lastSyncStatus: 'success',
        lastSyncError: null,
        lastSyncAt: '2026-06-01T09:00:00.000Z',
      }),
    )
  })
})
