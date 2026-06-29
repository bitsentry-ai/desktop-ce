import type { DbClient } from '../desktop/desktop-database-client'
import log from 'electron-log'
import { z } from 'zod'
import { errorSourceTypeSchema } from './error-sources.schemas'
import { getErrorMessage } from '../../shared/errors'
import { SqliteErrorSourcesRepositoryAdapter } from './desktop-sqlite-error-sources.adapter'
import { SqliteErrorIssuesRepositoryAdapter } from './desktop-sqlite-error-issues.adapter'
import { SqliteErrorEventsRepositoryAdapter } from './desktop-sqlite-error-events.adapter'
import { ErrorSourceProviderFactory } from './desktop-error-source-provider.factory'
import { ErrorSourceSyncService } from './desktop-error-source-sync.service'
import { getProviderForSource } from './desktop-posthog-provider-binding'
import { SyncSchedulerService } from './desktop-sync-scheduler.service'
import type { DesktopOauthManagerService } from './desktop-oauth-manager'
import type {
  ErrorSourceProvider,
  ProjectSummary,
} from './desktop-error-source-provider.interface'
import type { ErrorSource, ErrorSourceConfiguration, ErrorSourceType, LogLevelThreshold } from './desktop-error-sources.types'
import type {
  DesktopPluginErrorSourceSetupField,
  DesktopPluginRuntimeService,
} from '../plugins'
import {
  createDesktopNodePluginRuntimeService,
} from '../plugins/node'
import {
  hasErrorSourceProviderAction,
  resolveErrorSourceProviderActionId,
} from './desktop-plugin-error-source-actions'

const POSTHOG_PROJECT_SCOPED_API_KEY_MESSAGE =
  'This PostHog API key is scoped to specific projects. Add at least one numeric Project ID so BitSentry can use PostHog project-based endpoints.'
const POSTHOG_PROJECT_SCOPED_ENDPOINT_ERROR =
  'API keys with scoped projects are only supported on project-based endpoints'
const INTERRUPTED_SYNC_MESSAGE = 'Previous sync was interrupted before completion.'
const handlerPayloadSchema = z.record(z.string(), z.unknown())
const createErrorSourcePayloadSchema = z
  .object({
    pluginId: z.string().optional(),
    sourceType: errorSourceTypeSchema,
    name: z.string().min(1),
    setupValues: handlerPayloadSchema.optional(),
    authToken: z.string().optional(),
    organizationSlug: z.string().optional(),
    organizationId: z.string().optional(),
    projectSlugs: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).optional(),
    indexPatterns: z.array(z.string()).optional(),
    sentryBaseUrl: z.string().optional(),
    baseUrl: z.string().optional(),
    posthogBaseUrl: z.string().optional(),
    configuration: handlerPayloadSchema.optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    logLevelThreshold: z.enum(['error', 'warning', 'info', 'debug']).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose()
type CreateErrorSourcePayload = z.infer<typeof createErrorSourcePayloadSchema>
const updateErrorSourcePayloadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    setupValues: handlerPayloadSchema.optional(),
    configuration: handlerPayloadSchema.optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    organizationSlug: z.string().optional(),
    organizationId: z.string().optional(),
    projectSlugs: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).optional(),
    indexPatterns: z.array(z.string()).optional(),
    sentryBaseUrl: z.string().optional(),
    baseUrl: z.string().optional(),
    posthogBaseUrl: z.string().optional(),
    logLevelThreshold: z.enum(['error', 'warning', 'info', 'debug']).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose()
type UpdateErrorSourcePayload = z.infer<typeof updateErrorSourcePayloadSchema>
const initiateOAuthPayloadSchema = z
  .object({
    pluginId: z.string().optional(),
    sourceType: errorSourceTypeSchema.optional(),
    setupValues: handlerPayloadSchema.optional(),
    clientId: z.string().optional(),
    redirectUri: z.string().optional(),
    baseUrl: z.string().optional(),
    posthogBaseUrl: z.string().optional(),
  })
  .optional()
  .default({})
type InitiateOAuthPayload = z.infer<typeof initiateOAuthPayloadSchema>
const completeOAuthPayloadSchema = z
  .object({
    pluginId: z.string().optional(),
    sourceType: errorSourceTypeSchema.optional(),
    setupValues: handlerPayloadSchema.optional(),
    code: z.string().min(1),
    state: z.string().min(1),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().optional(),
    name: z.string().optional(),
    orgSlug: z.string().optional(),
    organizationId: z.string().optional(),
    projectSlugs: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).optional(),
    baseUrl: z.string().optional(),
    posthogBaseUrl: z.string().optional(),
    additionalMetadata: handlerPayloadSchema.optional(),
    logLevelThreshold: z.enum(['error', 'warning', 'info', 'debug']).optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .loose()
type CompleteOAuthPayload = z.infer<typeof completeOAuthPayloadSchema>
const idPayloadSchema = z.object({ id: z.string().min(1) })
const triggerSyncPayloadSchema = z.object({ id: z.string().optional() }).optional().default({})
const errorIssuesListPayloadSchema = z.object({
  sourceId: z.string().min(1),
  status: z.string().optional(),
  level: z.string().optional(),
  projectIdentifier: z.string().optional(),
  environment: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
})
const errorEventsListPayloadSchema = z.object({
  sourceId: z.string().min(1),
  issueId: z.string().optional(),
  level: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
})

type DesktopOauthManagerServiceClass = new (
  db: DbClient,
  providerFactory: ErrorSourceProviderFactory,
) => DesktopOauthManagerService

type PostHogProjectProvider = ErrorSourceProvider & {
  getProject(input: {
    accessToken: string
    projectId: string
    signal?: AbortSignal
  }): Promise<ProjectSummary>
}

let syncScheduler: SyncSchedulerService | null = null
let interruptedSyncRecovery: Promise<void> | null = null

function readHandlerPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) {
    return {}
  }

  return handlerPayloadSchema.parse(payload)
}

function readPayloadRecord(value: unknown): Record<string, unknown> | null {
  const parsed = handlerPayloadSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }

  return null
}

function readCreateErrorSourcePayload(payload: unknown): CreateErrorSourcePayload {
  return createErrorSourcePayloadSchema.parse(payload)
}

function readUpdateErrorSourcePayload(payload: unknown): UpdateErrorSourcePayload {
  return updateErrorSourcePayloadSchema.parse(payload)
}

function readInitiateOAuthPayload(payload: unknown): InitiateOAuthPayload {
  return initiateOAuthPayloadSchema.parse(payload)
}

function readCompleteOAuthPayload(payload: unknown): CompleteOAuthPayload {
  return completeOAuthPayloadSchema.parse(payload)
}

function nullableNonEmptyString(value: string): string | null {
  if (value.length === 0) {
    return null
  }

  return value
}

function applyOptionalOAuthConfiguration(
  configuration: ErrorSourceConfiguration,
  values: {
    oauthClientId?: string
    oauthClientSecret?: string
    oauthRedirectUri?: string
  },
): void {
  if (values.oauthClientId !== undefined) {
    configuration.oauthClientId = values.oauthClientId
  }
  if (values.oauthClientSecret !== undefined) {
    configuration.oauthClientSecret = values.oauthClientSecret
  }
  if (values.oauthRedirectUri !== undefined) {
    configuration.oauthRedirectUri = values.oauthRedirectUri
  }
}

function readOAuthConfigurationOverrides(
  configuration: Record<string, unknown>,
): {
  oauthClientId?: string
  oauthClientSecret?: string
  oauthRedirectUri?: string
} {
  const oauthClientId = readOptionalTrimmed(configuration.oauthClientId)
  const oauthClientSecret = readOptionalTrimmed(configuration.oauthClientSecret)
  const oauthRedirectUri = readOptionalTrimmed(configuration.oauthRedirectUri)

  const overrides: {
    oauthClientId?: string
    oauthClientSecret?: string
    oauthRedirectUri?: string
  } = {}
  if (oauthClientId !== undefined) {
    overrides.oauthClientId = oauthClientId
  }
  if (oauthClientSecret !== undefined) {
    overrides.oauthClientSecret = oauthClientSecret
  }
  if (oauthRedirectUri !== undefined) {
    overrides.oauthRedirectUri = oauthRedirectUri
  }

  return overrides
}

function buildPluginOAuthConfiguration(input: {
  payload: CompleteOAuthPayload
  persistedSetup: PersistedPluginSetup
  oauthClientId?: string
  oauthClientSecret?: string
  oauthRedirectUri?: string
}): ErrorSourceConfiguration {
  const configuration: ErrorSourceConfiguration = {
    ...input.persistedSetup.configuration,
  }
  const baseUrl = readOptionalTrimmed(input.payload.baseUrl)
  if (baseUrl !== undefined) {
    configuration.baseUrl = baseUrl
  }
  const posthogBaseUrl = readOptionalTrimmed(input.payload.posthogBaseUrl)
  if (posthogBaseUrl !== undefined) {
    configuration.posthogBaseUrl = posthogBaseUrl
  }
  const orgSlug = readOptionalTrimmed(
    input.payload.orgSlug ?? input.payload.organizationId,
  )
  if (orgSlug !== undefined) {
    configuration.orgSlug = orgSlug
  }
  const projectIds = readStringArray(input.payload.projectIds)
  if (projectIds.length > 0) {
    configuration.projectIds = projectIds
  }
  const projectSlugs = readStringArray(input.payload.projectSlugs)
  if (projectSlugs.length > 0) {
    configuration.projectSlugs = projectSlugs
  }
  applyOptionalOAuthConfiguration(configuration, {
    oauthClientId: input.oauthClientId,
    oauthClientSecret: input.oauthClientSecret,
    oauthRedirectUri: input.oauthRedirectUri,
  })
  return configuration
}

function toLogLevelThreshold(value: unknown): LogLevelThreshold {
  let raw = 'error'
  if (typeof value === 'string') {
    raw = value
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'debug') return 'debug'
  if (normalized === 'info') return 'info'
  if (normalized === 'warning') return 'warning'
  return 'error'
}

function readOptionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    return undefined
  }

  return normalized
}

function readRequiredTrimmed(value: unknown, label: string): string {
  const normalized = readOptionalTrimmed(value)
  if (normalized === undefined) {
    throw new Error(`${label} is required`)
  }

  return normalized
}

function readSourceType(value: unknown): ErrorSourceType | null {
  const normalized = readOptionalTrimmed(value)
  if (normalized !== undefined) {
    return normalized
  }

  return null
}

function readRequiredSourceType(value: unknown, label: string): ErrorSourceType {
  const sourceType = readSourceType(value)
  if (sourceType === null) {
    throw new Error(`${label} requires a sourceType`)
  }

  return sourceType
}

function readPluginId(value: unknown): string | undefined {
  const normalized = readOptionalTrimmed(value)
  if (normalized === undefined || normalized.length === 0) {
    return undefined
  }

  return normalized
}

function readSetupTrimmed(
  setupValues: Record<string, unknown>,
  key: string,
): string | undefined {
  return readOptionalTrimmed(setupValues[key])
}

function readSetupStringArray(
  setupValues: Record<string, unknown>,
  key: string,
): string[] {
  return readStringArray(setupValues[key])
}

type PersistedPluginSetup = {
  accessTokenRef?: string
  configuration: Record<string, unknown>
}

function readDelimitedStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  return readStringArray(value)
}

function readPluginSetupFieldValue(
  field: DesktopPluginErrorSourceSetupField,
  setupValues: Record<string, unknown>,
): unknown {
  const rawValue = setupValues[field.key]

  if (field.control === 'multiline_list') {
    const items = readDelimitedStringArray(rawValue)
    if (items.length === 0) {
      return undefined
    }

    return items
  }

  const normalized = readOptionalTrimmed(rawValue)
  if (normalized === undefined) {
    return undefined
  }

  return normalized
}

function readPluginErrorSourceSetupFields(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
): DesktopPluginErrorSourceSetupField[] {
  const plugin = pluginRuntime.getPlugin(pluginId)
  return plugin?.metadata?.errorSource?.setupFields ?? []
}

function hasMatchingErrorSourcePlugin(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
  sourceType: ErrorSourceType,
): boolean {
  const errorSource = pluginRuntime.getPlugin(pluginId)?.metadata?.errorSource
  return errorSource?.sourceType === sourceType
}

function resolvePersistedPluginSetup(
  pluginRuntime: DesktopPluginRuntimeService,
  pluginId: string,
  setupValues: Record<string, unknown>,
): PersistedPluginSetup {
  const persisted: PersistedPluginSetup = {
    configuration: {},
  }

  for (const field of readPluginErrorSourceSetupFields(pluginRuntime, pluginId)) {
    const value = readPluginSetupFieldValue(field, setupValues)
    if (value === undefined) {
      continue
    }

    if (field.storage === 'accessTokenRef') {
      if (typeof value === 'string') {
        persisted.accessTokenRef = value
      }
      continue
    }

    persisted.configuration[field.configurationKey ?? field.key] = value
  }

  return persisted
}

function readSourcePluginId(source: ErrorSource): string {
  const pluginId = readPluginId(source.additionalMetadata?.pluginId)
  if (pluginId !== undefined) {
    return pluginId
  }

  return source.sourceType
}

function mergeErrorSourceAdditionalMetadata(
  additionalMetadata: Record<string, unknown> | null | undefined,
  pluginId: string | undefined,
): Record<string, unknown> | null {
  let nextMetadata: Record<string, unknown> = {}
  if (additionalMetadata !== null && additionalMetadata !== undefined) {
    nextMetadata = { ...additionalMetadata }
  }

  if (pluginId !== undefined && pluginId.length > 0) {
    nextMetadata.pluginId = pluginId
  }

  if (Object.keys(nextMetadata).length === 0) {
    return null
  }

  return nextMetadata
}

function hasPostHogProjectAccess(
  provider: unknown,
): provider is PostHogProjectProvider {
  if (provider === null || provider === undefined) {
    return false
  }

  return typeof (provider as { getProject?: unknown }).getProject === 'function'
}

function resolveStoredErrorSourceToken(
  value: string | null | undefined,
): string {
  return value?.trim() ?? ''
}

function toRendererErrorSource(source: ErrorSource) {
  const pluginId = readPluginId(source.additionalMetadata?.pluginId)
  return {
    id: source.id,
    pluginId,
    sourceType: source.sourceType,
    name: source.name,
    syncEnabled: source.syncEnabled,
    autoDiagnosisEnabled: source.autoDiagnosisEnabled,
    logLevelThreshold: source.logLevelThreshold,
    lastSyncAt: source.lastSyncAt,
    lastSyncStatus: source.lastSyncStatus,
    lastSyncError: source.lastSyncError,
    configuration: sanitizeErrorSourceConfiguration(source.configuration),
  }
}

function sanitizeErrorSourceConfiguration(
  configuration: ErrorSource['configuration'] | null | undefined,
): Record<string, unknown> {
  if (configuration === null || configuration === undefined) {
    return {}
  }

  const sanitized: Record<string, unknown> = { ...configuration }
  delete sanitized.oauthClientSecret
  return sanitized
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'string') {
      return []
    }

    const normalized = item.trim()
    if (normalized.length === 0) {
      return []
    }

    return [normalized]
  })
}

function readPluginConnectionIndexPattern(
  configuration: ErrorSourceConfiguration,
): string | undefined {
  const indexPatterns = readStringArray(configuration.indexPatterns)
  if (indexPatterns.length > 0) {
    return indexPatterns.join(',')
  }

  const legacyProjectSlugs = readStringArray(configuration.projectSlugs)
  if (legacyProjectSlugs.length > 0) {
    return legacyProjectSlugs.join(',')
  }

  return undefined
}

function buildPluginAuthFromSource(
  source: ErrorSource,
  pluginRuntime: DesktopPluginRuntimeService,
): Record<string, unknown> {
  const pluginId = readSourcePluginId(source)
  const auth: Record<string, unknown> = {}
  const accessToken = resolveStoredErrorSourceToken(source.accessTokenRef)

  for (const field of readPluginErrorSourceSetupFields(pluginRuntime, pluginId)) {
    if (field.storage === 'accessTokenRef') {
      if (accessToken.length > 0) {
        auth[field.key] = accessToken
      }
      continue
    }

    const configurationKey = field.configurationKey ?? field.key
    const value = (source.configuration as Record<string, unknown>)[configurationKey]
    if (value === undefined) {
      continue
    }

    auth[field.key] = value
    if (configurationKey !== field.key) {
      auth[configurationKey] = value
    }
  }

  return auth
}

function readPluginIssueCount(data: unknown): number {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof (data as { issueCount?: unknown }).issueCount === 'number'
  ) {
    const issueCount = (data as { issueCount: number }).issueCount
    if (Number.isFinite(issueCount) && issueCount >= 0) {
      return Math.trunc(issueCount)
    }
  }

  return 0
}

function readPluginIssueBatch(data: unknown): {
  issues: unknown[]
  hasMore: boolean
} | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }

  const rawIssues = (data as { issues?: unknown }).issues
  if (!Array.isArray(rawIssues)) {
    return null
  }

  return {
    issues: rawIssues,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  }
}

function readUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  return []
}

function readConfiguredOrganizationCount(
  configuration: ErrorSourceConfiguration,
): number {
  if (readOptionalTrimmed(configuration.orgSlug) === undefined) {
    return 0
  }

  return 1
}

function buildGenericPluginConnectionInput(source: ErrorSource): Record<string, unknown> {
  const input: Record<string, unknown> = {
    query: '*',
    limit: 1,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
  }

  const orgSlug = readOptionalTrimmed(source.configuration.orgSlug)
  if (orgSlug !== undefined) {
    input.orgSlug = orgSlug
  }

  const projectIds = readStringArray(source.configuration.projectIds)
  if (projectIds.length > 0) {
    input.projectIds = projectIds
  }

  const projectSlugs = readStringArray(source.configuration.projectSlugs)
  if (projectSlugs.length > 0) {
    input.projectSlugs = projectSlugs
  }

  const indexPattern = readPluginConnectionIndexPattern(source.configuration)
  if (indexPattern !== undefined) {
    input.indexPattern = indexPattern
  }

  return input
}

function isMissingPluginAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.startsWith('Missing required auth field:') ||
    error.message.endsWith(' is required')
  )
}

function isPostHogProjectScopedEndpointError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(POSTHOG_PROJECT_SCOPED_ENDPOINT_ERROR)
}

function recoverInterruptedSyncs(
  sourcesRepository: SqliteErrorSourcesRepositoryAdapter,
): Promise<void> {
  if (interruptedSyncRecovery === null) {
    interruptedSyncRecovery = sourcesRepository
      .markInterruptedSyncsFailed(INTERRUPTED_SYNC_MESSAGE)
      .then((count) => {
        if (count > 0) {
          log.warn(`[error-sources] Recovered ${String(count)} interrupted source sync(s)`)
        }
      })
      .catch((error: unknown) => {
        log.warn('[error-sources] Failed to recover interrupted source syncs:', error)
      })
  }
  return interruptedSyncRecovery
}

export function createDesktopErrorSourcesHandlers(
  db: DbClient,
  dependencies: {
    OauthManagerService: DesktopOauthManagerServiceClass
    pluginRuntime?: DesktopPluginRuntimeService
  },
): Record<string, (payload: unknown) => Promise<unknown>> {
  const sourcesRepository = new SqliteErrorSourcesRepositoryAdapter(db)
  const issuesRepository = new SqliteErrorIssuesRepositoryAdapter(db)
  const eventsRepository = new SqliteErrorEventsRepositoryAdapter(db)
  const pluginRuntime =
    dependencies.pluginRuntime ?? createDesktopNodePluginRuntimeService()
  const providerFactory = new ErrorSourceProviderFactory(pluginRuntime)
  const oauthManager = new dependencies.OauthManagerService(db, providerFactory)
  const syncService = new ErrorSourceSyncService(
    db,
    sourcesRepository,
    issuesRepository,
    eventsRepository,
    providerFactory,
    pluginRuntime,
  )
  const syncRecovery = recoverInterruptedSyncs(sourcesRepository)

  if (syncScheduler === null) {
    syncScheduler = new SyncSchedulerService(syncService, 10 * 60 * 1000)
    void syncRecovery.finally(() => {
      syncScheduler?.start()
    })
  }

  function filterProbeOrganizations<T extends { slug: string }>(
    orgs: T[],
    requestedOrgSlug: string | undefined,
  ): T[] {
    if (requestedOrgSlug === undefined) {
      return orgs
    }

    return orgs.filter((org) => org.slug === requestedOrgSlug)
  }

  function useProjectSlugForProbe(pluginId: string): boolean {
    const fields =
      pluginRuntime.getPlugin(pluginId)?.metadata?.errorSource?.setupFields ?? []
    return fields.some((field) => field.target === 'projectSlugs')
  }

  return {

    'errorSources:probeConnection': async (rawPayload: unknown) => {
      const payload = readHandlerPayload(rawPayload)
      const sourceType = readSourceType(payload.sourceType)
      if (sourceType === null) {
        throw new Error('Probe requires a sourceType')
      }

      const authToken = readRequiredTrimmed(payload.authToken, 'authToken')

      const requestedOrgSlug = readOptionalTrimmed(
        payload.organizationSlug ?? payload.organizationId,
      )
      const pluginId = readPluginId(payload.pluginId) ?? sourceType
      const baseUrl = readOptionalTrimmed(
        payload.baseUrl ?? payload.posthogBaseUrl,
      )

      type ProbeOrg = { id: string; name: string }
      type ProbeProject = { id: string; name: string; orgId: string }

      log.info(
        `[error-sources] probeConnection:start type=${sourceType} org=${requestedOrgSlug ?? '<auto>'}`,
      )

      try {
        let probeConfiguration: { posthogBaseUrl: string } | undefined
        if (baseUrl !== undefined) {
          probeConfiguration = { posthogBaseUrl: baseUrl }
        }
        const provider = getProviderForSource(providerFactory, {
          sourceType,
          additionalMetadata: { pluginId },
          configuration: probeConfiguration,
        })
        const orgs = await provider.listOrganizations(authToken)
        const visibleOrgs = filterProbeOrganizations(orgs, requestedOrgSlug)
        const projectIdFieldUsesSlug = useProjectSlugForProbe(pluginId)

        const organizations: ProbeOrg[] = visibleOrgs.map((org) => ({
          id: org.slug,
          name: org.name,
        }))

        const projects: ProbeProject[] = []
        for (const org of visibleOrgs) {
          const orgProjects = await provider.listProjects({
            accessToken: authToken,
            orgSlug: org.slug,
          })
          for (const project of orgProjects) {
            let projectId = project.id
            if (projectIdFieldUsesSlug) {
              projectId = project.slug
            }
            projects.push({
              id: projectId,
              name: project.name,
              orgId: org.slug,
            })
          }
        }

        log.info(
          `[error-sources] probeConnection:success type=${sourceType} orgs=${String(organizations.length)} projects=${String(projects.length)}`,
        )
        return { organizations, projects }
      } catch (error) {
        log.warn('[error-sources] probeConnection:failed', error)
        let detail = getErrorMessage(error)
        if (sourceType === 'posthog' && isPostHogProjectScopedEndpointError(error)) {
          detail = POSTHOG_PROJECT_SCOPED_API_KEY_MESSAGE
        }
        throw new Error(`Probe failed: ${detail}`)
      }
    },

    'errorSources:getAll': async () => {
      await syncRecovery
      const data = await sourcesRepository.findMany()
      return { data: data.map((source) => toRendererErrorSource(source)), total: data.length }
    },

    'errorSources:getOne': async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload)
      await syncRecovery
      const source = await sourcesRepository.findById(payload.id)
      if (source === null) throw new Error(`Error source ${payload.id} not found`)
      return toRendererErrorSource(source)
    },

    'errorSources:create': async (rawPayload: unknown) => {
      const payload = readCreateErrorSourcePayload(rawPayload)
      const sourceType = payload.sourceType
      const pluginId = readPluginId(payload.pluginId) ?? sourceType
      const setupValues = readPayloadRecord(payload.setupValues) ?? {}
      const persistedSetup = resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      )
      const usePluginCreatePath = hasMatchingErrorSourcePlugin(
        pluginRuntime,
        pluginId,
        sourceType,
      )
      const authToken =
	        readSetupTrimmed(setupValues, 'authToken') ??
	        payload.authToken?.trim() ??
	        persistedSetup.accessTokenRef ??
	        ''
      const sourceName = payload.name

      if (!usePluginCreatePath) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${sourceType}`,
        )
      }

      try {
        let customPluginAuthToken = authToken
        if (customPluginAuthToken.length === 0) {
          customPluginAuthToken = persistedSetup.accessTokenRef ?? ''
        }
        const customPluginConfiguration = {
          ...persistedSetup.configuration,
          ...(readPayloadRecord(payload.configuration) ?? {}),
        }
        const legacyBaseUrl = readOptionalTrimmed(payload.baseUrl)
        if (legacyBaseUrl !== undefined) {
          customPluginConfiguration.baseUrl = legacyBaseUrl
        }
        const sentryBaseUrl = readOptionalTrimmed(payload.sentryBaseUrl)
        if (sentryBaseUrl !== undefined) {
          customPluginConfiguration.sentryBaseUrl = sentryBaseUrl
        }
        const posthogBaseUrl = readOptionalTrimmed(payload.posthogBaseUrl)
        if (posthogBaseUrl !== undefined) {
          customPluginConfiguration.posthogBaseUrl = posthogBaseUrl
        }
        const organizationSlug = readOptionalTrimmed(
          payload.organizationSlug ?? payload.organizationId,
        )
        if (organizationSlug !== undefined) {
          customPluginConfiguration.orgSlug = organizationSlug
        }
        const projectSlugs = readStringArray(payload.projectSlugs)
        if (projectSlugs.length > 0) {
          customPluginConfiguration.projectSlugs = projectSlugs
        }
        const projectIds = readStringArray(payload.projectIds)
        if (projectIds.length > 0) {
          customPluginConfiguration.projectIds = projectIds
        }
        if (Array.isArray(payload.indexPatterns)) {
          customPluginConfiguration.indexPatterns = readStringArray(
            payload.indexPatterns,
          )
        }

        const created = await sourcesRepository.create({
          sourceType,
          name: sourceName,
          additionalMetadata: mergeErrorSourceAdditionalMetadata(
            readPayloadRecord(payload.additionalMetadata),
            pluginId,
          ),
          accessTokenRef: nullableNonEmptyString(customPluginAuthToken),
          refreshTokenRef: null,
          expiresAt: null,
          grantedScopes: [],
          configuration: customPluginConfiguration,
          logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
          syncEnabled: payload.syncEnabled !== false,
          autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
        })
        return toRendererErrorSource(created)
      } catch (error) {
        throw error
      }
    },

    'errorSources:update': async (rawPayload: unknown) => {
      const payload = readUpdateErrorSourcePayload(rawPayload)
      const existing = await sourcesRepository.findById(payload.id)
      if (existing === null) throw new Error(`Error source ${payload.id} not found`)
      const setupValues = readPayloadRecord(payload.setupValues) ?? {}
      const pluginId = readSourcePluginId(existing)
      const persistedSetup = resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      )
      if (!hasMatchingErrorSourcePlugin(pluginRuntime, pluginId, existing.sourceType)) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${existing.sourceType}`,
        )
      }

      let nextConfiguration = { ...existing.configuration }
      if (payload.configuration !== undefined) {
        nextConfiguration = {
          ...nextConfiguration,
          ...payload.configuration,
        }
      }
      if (Object.keys(persistedSetup.configuration).length > 0) {
        nextConfiguration = {
          ...nextConfiguration,
          ...persistedSetup.configuration,
        }
      }

      if (typeof payload.organizationSlug === 'string' && payload.organizationSlug.trim().length > 0) {
        nextConfiguration.orgSlug = payload.organizationSlug.trim()
      }
      if (typeof payload.organizationId === 'string' && payload.organizationId.trim().length > 0) {
        nextConfiguration.orgSlug = payload.organizationId.trim()
      }
      const setupOrganizationSlug =
        readSetupTrimmed(setupValues, 'organizationSlug') ??
        readSetupTrimmed(setupValues, 'organizationId')
      if (setupOrganizationSlug !== undefined) {
        nextConfiguration.orgSlug = setupOrganizationSlug
      }

      if (Array.isArray(payload.projectSlugs)) {
        nextConfiguration.projectSlugs = readStringArray(payload.projectSlugs)
      }
      const setupProjectSlugs = readSetupStringArray(setupValues, 'projectSlugs')
      if (setupProjectSlugs.length > 0) {
        nextConfiguration.projectSlugs = setupProjectSlugs
      }
      if (Array.isArray(payload.projectIds)) {
        const nextProjectIds = readStringArray(payload.projectIds)
        // Treat an explicitly empty `projectIds` as "no change" rather than
        // collapsing the persisted list to zero projects. The create flow
        // interprets empty as "all projects" via auto-resolution; persisting
        // an empty array on update would silently disable sync without any
        // user-visible signal.
        if (nextProjectIds.length > 0) {
          nextConfiguration.projectIds = nextProjectIds
        }
      }
      const setupProjectIds = readSetupStringArray(setupValues, 'projectIds')
      if (setupProjectIds.length > 0) {
        nextConfiguration.projectIds = setupProjectIds
      }
      if (Array.isArray(payload.indexPatterns)) {
        nextConfiguration.indexPatterns = readStringArray(payload.indexPatterns)
      }
      const nextBaseUrl = readOptionalTrimmed(payload.baseUrl)
      if (nextBaseUrl !== undefined) {
        nextConfiguration.baseUrl = nextBaseUrl
      }
      const payloadPostHogBaseUrl = readOptionalTrimmed(payload.posthogBaseUrl)
      if (payloadPostHogBaseUrl !== undefined) {
        nextConfiguration.posthogBaseUrl = payloadPostHogBaseUrl
      }

      const updated = await sourcesRepository.update({
        id: existing.id,
        name: readOptionalTrimmed(payload.name),
        additionalMetadata: readPayloadRecord(payload.additionalMetadata) ?? undefined,
        accessTokenRef: persistedSetup.accessTokenRef,
        configuration: nextConfiguration,
        logLevelThreshold: payload.logLevelThreshold,
        syncEnabled: payload.syncEnabled,
        autoDiagnosisEnabled: payload.autoDiagnosisEnabled,
      })
      if (updated === null) throw new Error(`Error source ${payload.id} not found`)
      return toRendererErrorSource(updated)
    },

    'errorSources:delete': async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload)
      const source = await sourcesRepository.findById(payload.id)
      if (source === null) {
        return { success: true }
      }

      await sourcesRepository.remove(source.id)
      return { success: true }
    },

    'errorSources:initiateOAuth': async (rawPayload: unknown) => {
      const payload = readInitiateOAuthPayload(rawPayload)
      const sourceType = readRequiredSourceType(
        payload.sourceType,
        'OAuth initiation',
      )
      const pluginId = readPluginId(payload.pluginId) ?? sourceType
      const setupValues = readPayloadRecord(payload.setupValues) ?? {}
      const persistedSetup = resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      )
      const oauthConfigOverrides = readOAuthConfigurationOverrides(
        persistedSetup.configuration,
      )
      const baseUrl = readOptionalTrimmed(
        payload.baseUrl ??
          payload.posthogBaseUrl ??
          persistedSetup.configuration.posthogBaseUrl ??
          persistedSetup.configuration.baseUrl,
      )
      log.info(`[error-sources] initiateOAuth:start sourceType=${sourceType}`)
      return oauthManager.initiateOAuth(sourceType, {
        pluginId,
        clientId:
          readOptionalTrimmed(payload.clientId) ??
          oauthConfigOverrides.oauthClientId,
        redirectUri:
          readOptionalTrimmed(payload.redirectUri) ??
          oauthConfigOverrides.oauthRedirectUri,
        baseUrl,
      })
    },

    'errorSources:completeOAuth': async (rawPayload: unknown) => {
      const payload = readCompleteOAuthPayload(rawPayload)
      const sourceType = readRequiredSourceType(
        payload.sourceType,
        'OAuth completion',
      )
      const code = payload.code.trim()
      const state = payload.state.trim()
      const pluginId = readPluginId(payload.pluginId) ?? sourceType
      const setupValues = readPayloadRecord(payload.setupValues) ?? {}
      const persistedSetup = resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId,
        setupValues,
      )
      const oauthConfigOverrides = readOAuthConfigurationOverrides(
        persistedSetup.configuration,
      )
      const oauthBaseUrl = readOptionalTrimmed(
        payload.baseUrl ??
          payload.posthogBaseUrl ??
          persistedSetup.configuration.posthogBaseUrl ??
          persistedSetup.configuration.baseUrl,
      )

      log.info(`[error-sources] completeOAuth:start sourceType=${sourceType}`)
      const oauthClientId =
        readOptionalTrimmed(payload.clientId) ??
        oauthConfigOverrides.oauthClientId
      const oauthClientSecret =
        readOptionalTrimmed(payload.clientSecret) ??
        oauthConfigOverrides.oauthClientSecret
      const oauthRedirectUri =
        readOptionalTrimmed(payload.redirectUri) ??
        oauthConfigOverrides.oauthRedirectUri

      if (!hasMatchingErrorSourcePlugin(pluginRuntime, pluginId, sourceType)) {
        throw new Error(
          `Error source plugin "${pluginId}" does not match source type ${sourceType}`,
        )
      }

      const tokenResult = await oauthManager.completeOAuth(sourceType, {
        code,
        state,
        pluginId,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        redirectUri: oauthRedirectUri,
        baseUrl: oauthBaseUrl,
      })
      try {
        log.info('[error-sources] completeOAuth: token exchange succeeded')
        const accessToken = tokenResult.accessToken.trim()
        if (accessToken.length === 0) {
          throw new Error(`Failed to resolve ${sourceType} access token`)
        }

        const configuration = buildPluginOAuthConfiguration({
          payload,
          persistedSetup,
          oauthClientId,
          oauthClientSecret,
          oauthRedirectUri,
        })
        const source = await sourcesRepository.create({
          sourceType,
          name: payload.name ?? pluginRuntime.getPlugin(pluginId)?.name ?? sourceType,
          additionalMetadata: mergeErrorSourceAdditionalMetadata(
            readPayloadRecord(payload.additionalMetadata),
            pluginId,
          ),
          accessTokenRef: accessToken,
          refreshTokenRef: tokenResult.refreshToken,
          expiresAt: tokenResult.expiresAt,
          grantedScopes: tokenResult.scopes,
          configuration,
          logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
          syncEnabled: payload.syncEnabled !== false,
          autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
        })
        log.info(
          `[error-sources] completeOAuth:success id=${source.id} type=${sourceType} plugin=${pluginId}`,
        )

        return {
          source: toRendererErrorSource(source),
          organizations: [],
          projects: [],
        }
      } catch (error) {
        log.error('[error-sources] completeOAuth:failed', error)
        throw error
      }
    },

    'errorSources:testConnection': async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload)
      const sourceId = payload.id
      log.info(`[error-sources] testConnection:start sourceId=${sourceId}`)
      const source = await sourcesRepository.findById(payload.id)
      if (source === null) throw new Error(`Error source ${payload.id} not found`)
      const pluginId = readSourcePluginId(source)
      const plugin = pluginRuntime.getPlugin(pluginId)

      if (plugin?.metadata?.errorSource?.sourceType === source.sourceType) {
        const auth = buildPluginAuthFromSource(source, pluginRuntime)
        const input = buildGenericPluginConnectionInput(source)

        try {
          if (hasErrorSourceProviderAction(plugin, 'queryIssues')) {
            const result = await pluginRuntime.executeAction({
              pluginId,
              actionId: resolveErrorSourceProviderActionId({
                runtime: pluginRuntime,
                pluginId,
                sourceType: source.sourceType,
                action: 'queryIssues',
              }),
              auth,
              input,
            })
            const issueBatch = readPluginIssueBatch(result.data)
            const issueCount = issueBatch?.issues.length ?? readPluginIssueCount(result.data)
            return {
              success: true,
              provider: source.sourceType,
              organizationCount: readConfiguredOrganizationCount(source.configuration),
              projectCount: issueCount,
            }
          }

          if (hasErrorSourceProviderAction(plugin, 'searchAlerts')) {
            const result = await pluginRuntime.executeAction({
              pluginId,
              actionId: resolveErrorSourceProviderActionId({
                runtime: pluginRuntime,
                pluginId,
                sourceType: source.sourceType,
                action: 'searchAlerts',
              }),
              auth,
              input,
            })
            const issueCount = readPluginIssueCount(result.data)
            return {
              success: true,
              provider: source.sourceType,
              organizationCount: readConfiguredOrganizationCount(source.configuration),
              projectCount: issueCount,
            }
          }

          if (hasErrorSourceProviderAction(plugin, 'listOrganizations')) {
            const result = await pluginRuntime.executeAction({
              pluginId,
              actionId: resolveErrorSourceProviderActionId({
                runtime: pluginRuntime,
                pluginId,
                sourceType: source.sourceType,
                action: 'listOrganizations',
              }),
              auth,
              input: {},
            })
            const organizations = readUnknownArray(result.data)
            return {
              success: true,
              provider: source.sourceType,
              organizationCount: organizations.length,
              projectCount: 0,
            }
          }
        } catch (error) {
          if (isMissingPluginAuthError(error)) {
            log.info(
              `[error-sources] testConnection:plugin sourceId=${source.id} missing plugin auth`,
            )
            return {
              success: false,
              provider: source.sourceType,
              organizationCount: 0,
              projectCount: 0,
            }
          }

          throw error
        }
      }

      const accessToken = resolveStoredErrorSourceToken(source.accessTokenRef)
      if (accessToken.length === 0) {
        throw new Error('Access token not found for this source')
      }

      const provider = getProviderForSource(providerFactory, source)

      if (source.sourceType === 'posthog' && hasPostHogProjectAccess(provider)) {
        const projectIds = readStringArray(
          source.configuration.projectIds ?? source.configuration.projectSlugs,
        )
        if (projectIds.length > 0) {
          await Promise.all(
            projectIds.map((projectId) => provider.getProject({ accessToken, projectId })),
          )
          log.info(
            `[error-sources] testConnection:success sourceId=${source.id} projects=${String(projectIds.length)}`,
          )
          let organizationCount = 0
          if (source.configuration.orgSlug !== undefined && source.configuration.orgSlug.length > 0) {
            organizationCount = 1
          }
          return {
            success: true,
            provider: source.sourceType,
            organizationCount,
            projectCount: projectIds.length,
          }
        }
      }

      let organizations: Awaited<ReturnType<typeof provider.listOrganizations>>
      try {
        organizations = await provider.listOrganizations(accessToken)
      } catch (error) {
        if (source.sourceType === 'posthog' && isPostHogProjectScopedEndpointError(error)) {
          throw new Error(POSTHOG_PROJECT_SCOPED_API_KEY_MESSAGE)
        }
        throw error
      }
      log.info(
        `[error-sources] testConnection:success sourceId=${source.id} organizations=${String(organizations.length)}`,
      )
      return {
        success: true,
        provider: source.sourceType,
        organizationCount: organizations.length,
        projectCount: 0,
      }
    },

    'errorSources:triggerSync': async (rawPayload: unknown) => {
      const payload = triggerSyncPayloadSchema.parse(rawPayload)
      await syncRecovery
      if (payload.id !== undefined && payload.id.length > 0) {
        log.info(`[error-sources] triggerSync:start sourceId=${payload.id}`)
        return syncService.syncSourceById(payload.id)
      }
      log.info('[error-sources] triggerSync:start all enabled sources')
      return syncService.syncAllEnabled()
    },

    'errorIssues:list': async (rawPayload: unknown) => {
      const payload = errorIssuesListPayloadSchema.parse(rawPayload)
      return issuesRepository.list({
        sourceId: payload.sourceId,
        status: payload.status,
        level: payload.level,
        projectIdentifier: payload.projectIdentifier,
        environment: payload.environment,
        limit: payload.limit,
        offset: payload.offset,
      })
    },

    'errorEvents:list': async (rawPayload: unknown) => {
      const payload = errorEventsListPayloadSchema.parse(rawPayload)
      return eventsRepository.list({
        sourceId: payload.sourceId,
        issueId: payload.issueId,
        level: payload.level,
        search: payload.search,
        limit: payload.limit,
        offset: payload.offset,
      })
    },

    'errorEvents:getOne': async (rawPayload: unknown) => {
      const payload = idPayloadSchema.parse(rawPayload)
      const event = await eventsRepository.findById(payload.id)
      if (event === null) throw new Error(`Error event ${payload.id} not found`)
      return event
    },
  }
}
