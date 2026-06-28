import type { DbClient } from '../desktop/desktop-database-client'
import log from 'electron-log'
import { z } from 'zod'
import { errorSourceTypeSchema, POSTHOG_DEFAULT_BASE_URL } from './error-sources.schemas'
import { assertAllowedPostHogBaseUrl } from './posthog-base-url'
import { getErrorMessage } from '../../shared/errors'
import { SqliteErrorSourcesRepositoryAdapter } from './desktop-sqlite-error-sources.adapter'
import { SqliteErrorIssuesRepositoryAdapter } from './desktop-sqlite-error-issues.adapter'
import { SqliteErrorEventsRepositoryAdapter } from './desktop-sqlite-error-events.adapter'
import { ErrorSourceProviderFactory } from './desktop-error-source-provider.factory'
import { ErrorSourceSyncService } from './desktop-error-source-sync.service'
import { getProviderForSource } from './desktop-posthog-provider-binding'
import {
  readConfiguredProjectIds,
  resolveSentryProjectSelection,
} from './desktop-sentry-project-selection'
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
  OAUTH_PLUGIN_ERROR_SOURCE_TYPES,
} from './plugin-backed-error-sources'
import { resolveErrorSourceProviderActionId } from './desktop-plugin-error-source-actions'

const SUPPORTED_OAUTH_SOURCE_TYPES: ReadonlyArray<ErrorSourceType> =
  OAUTH_PLUGIN_ERROR_SOURCE_TYPES
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
    sourceType: z.enum(OAUTH_PLUGIN_ERROR_SOURCE_TYPES).optional().default('sentry'),
    setupValues: handlerPayloadSchema.optional(),
    clientId: z.string().optional(),
    redirectUri: z.string().optional(),
    baseUrl: z.string().optional(),
    posthogBaseUrl: z.string().optional(),
  })
  .optional()
  .default({ sourceType: 'sentry' })
type InitiateOAuthPayload = z.infer<typeof initiateOAuthPayloadSchema>
const completeOAuthPayloadSchema = z
  .object({
    pluginId: z.string().optional(),
    sourceType: z.enum(OAUTH_PLUGIN_ERROR_SOURCE_TYPES).optional().default('sentry'),
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

function parsePostHogExtraAllowedHosts(): string[] {
  const raw = process.env.POSTHOG_ALLOWED_BASE_URLS
  if (raw === undefined || raw.length === 0) return []
  const out: string[] = []
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(new URL(trimmed).host.toLowerCase())
    } catch {
      out.push(trimmed.toLowerCase())
    }
  }
  return out
}

function validatePostHogBaseUrl(value: unknown): string {
  let candidate: string | undefined
  if (typeof value === 'string') {
    candidate = value
  }

  return assertAllowedPostHogBaseUrl(candidate, {
    extraAllowedHosts: parsePostHogExtraAllowedHosts(),
  })
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
  if (value === 'sentry' || value === 'posthog') {
    return value
  }

  return null
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

function firstNonEmptyStringArray(readers: Array<() => string[]>): string[] {
  for (const reader of readers) {
    const values = reader()
    if (values.length > 0) {
      return values
    }
  }

  return []
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

function isSupportedOAuthType(value: unknown): value is ErrorSourceType {
  if (typeof value !== 'string') {
    return false
  }

  return SUPPORTED_OAUTH_SOURCE_TYPES.some((sourceType) => sourceType === value)
}

function normalizePostHogBaseUrl(value: unknown): string {
  const raw = readOptionalTrimmed(value)
  if (raw === undefined) return POSTHOG_DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
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

  function getPostHogProviderForBaseUrl(
    baseUrl: string,
    pluginId = 'posthog',
  ): PostHogProjectProvider {
    // Re-run the allowlist on the caller-supplied URL here too - the call
    // sites should already validate, but treating this helper as a single
    // chokepoint keeps the invariant locally enforceable and means a future
    // caller can't sneak past validation.
    const validated = validatePostHogBaseUrl(baseUrl)
    const base = getProviderForSource(providerFactory, {
      sourceType: 'posthog',
      additionalMetadata: { pluginId },
      configuration: { posthogBaseUrl: validated },
    })
    if (hasPostHogProjectAccess(base)) {
      return base
    }

    throw new Error('PostHog provider does not support project-based lookups')
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
  return {

    'errorSources:probeConnection': async (rawPayload: unknown) => {
      const payload = readHandlerPayload(rawPayload)
      const sourceType = readSourceType(payload.sourceType)
      if (sourceType === null) {
        throw new Error(
          'Probe is only supported for sentry and posthog sources',
        )
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
        if (sourceType === 'sentry') {
          const provider = getProviderForSource(providerFactory, {
            sourceType,
            additionalMetadata: { pluginId },
          })
          const orgs = await provider.listOrganizations(authToken)
          const visibleOrgs = filterProbeOrganizations(orgs, requestedOrgSlug)

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
              projects.push({
                id: project.slug,
                name: project.name,
                orgId: org.slug,
              })
            }
          }

          log.info(
            `[error-sources] probeConnection:success type=sentry orgs=${String(organizations.length)} projects=${String(projects.length)}`,
          )
          return { organizations, projects }
        }

        // posthog
        const validatedBaseUrl = validatePostHogBaseUrl(baseUrl)
        const provider = getProviderForSource(providerFactory, {
          sourceType,
          additionalMetadata: { pluginId },
          configuration: { posthogBaseUrl: validatedBaseUrl },
        })
        const orgs = await provider.listOrganizations(authToken)
        const visibleOrgs = filterProbeOrganizations(orgs, requestedOrgSlug)

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
            projects.push({
              id: project.id,
              name: project.name,
              orgId: org.slug,
            })
          }
        }

        log.info(
          `[error-sources] probeConnection:success type=posthog orgs=${String(organizations.length)} projects=${String(projects.length)}`,
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

    // eslint-disable-next-line sonarjs/cognitive-complexity -- Create preserves provider-specific validation and project resolution in one write path.
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
      const authToken =
        readSetupTrimmed(setupValues, 'authToken') ??
        payload.authToken?.trim() ??
        persistedSetup.accessTokenRef ??
        ''
      const sourceName = payload.name

      if (sourceType === 'sentry') {
        const organizationSlug =
          readSetupTrimmed(setupValues, 'organizationSlug') ??
          readSetupTrimmed(setupValues, 'organizationId') ??
          readOptionalTrimmed(persistedSetup.configuration.orgSlug) ??
          payload.organizationSlug?.trim() ??
          ''
        const projectSlugs = firstNonEmptyStringArray([
          () => readSetupStringArray(setupValues, 'projectSlugs'),
          () => readStringArray(persistedSetup.configuration.projectSlugs),
          () => readStringArray(payload.projectSlugs),
        ])
        const sentryBaseUrl = readOptionalTrimmed(
          setupValues.baseUrl ?? payload.sentryBaseUrl,
        )

        if (authToken.length === 0) {
          log.warn('[error-sources] create: missing authToken')
          throw new Error('authToken is required')
        }
        if (organizationSlug.length === 0) {
          log.warn('[error-sources] create: missing organizationSlug')
          throw new Error('organizationSlug is required')
        }

        log.info(
          `[error-sources] create:start type=sentry name="${sourceName}" org="${organizationSlug}" projects=${String(projectSlugs.length)}`,
        )

        try {
          const additionalConfig = {
            ...persistedSetup.configuration,
            ...(payload.configuration ?? {}),
          }
          const provider = getProviderForSource(providerFactory, {
            sourceType,
            additionalMetadata: { pluginId },
          })
          const projects = await provider.listProjects({
            accessToken: authToken,
            orgSlug: organizationSlug,
          })
          const resolvedProjects = resolveSentryProjectSelection(projects, {
            projectIds: readConfiguredProjectIds(additionalConfig),
            projectSlugs,
            defaultToAll: projectSlugs.length === 0,
          })
          if (resolvedProjects.missingProjectSlugs.length > 0) {
            throw new Error(
              `Unknown Sentry project slug(s): ${resolvedProjects.missingProjectSlugs.join(', ')}`,
            )
          }

          const created = await sourcesRepository.create({
            sourceType,
            name: sourceName,
            additionalMetadata: mergeErrorSourceAdditionalMetadata(
              readPayloadRecord(payload.additionalMetadata),
              pluginId,
            ),
            accessTokenRef: authToken,
            refreshTokenRef: null,
            expiresAt: null,
            grantedScopes: [],
            configuration: {
              ...additionalConfig,
              orgSlug: organizationSlug,
              projectIds: resolvedProjects.projectIds,
              projectSlugs: resolvedProjects.projectSlugs,
              projectNames: resolvedProjects.projectNames,
              sentryBaseUrl,
            },
            logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
            syncEnabled: payload.syncEnabled !== false,
            autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
          })
          log.info(
            `[error-sources] create:success id=${created.id} name="${created.name}" org="${organizationSlug}"`,
          )
          return toRendererErrorSource(created)
        } catch (error) {
          log.error('[error-sources] create:failed', error)
          throw error
        }
      }

      if (sourceType === 'posthog') {
        if (authToken.length === 0) {
          log.warn('[error-sources] create: missing authToken')
          throw new Error('authToken is required')
        }

        const baseUrl = validatePostHogBaseUrl(
          setupValues.baseUrl ??
            payload.baseUrl ??
            payload.posthogBaseUrl ??
            persistedSetup.configuration.posthogBaseUrl,
        )
        const requestedProjectIds = firstNonEmptyStringArray([
          () => readSetupStringArray(setupValues, 'projectIds'),
          () => readSetupStringArray(setupValues, 'projectSlugs'),
          () => readStringArray(persistedSetup.configuration.projectIds),
          () => readStringArray(persistedSetup.configuration.projectSlugs),
          () => firstNonEmptyStringArray([
            () => readStringArray(payload.projectIds),
            () => readStringArray(payload.projectSlugs),
          ]),
        ])
        const requestedOrgId = readOptionalTrimmed(
          setupValues.organizationId ??
            setupValues.organizationSlug ??
            persistedSetup.configuration.orgSlug ??
            payload.organizationId ??
            payload.organizationSlug,
        )

        log.info(
          `[error-sources] create:start type=posthog name="${sourceName}" base="${baseUrl}" projects=${String(requestedProjectIds.length)}`,
        )

        try {
          const provider = getPostHogProviderForBaseUrl(baseUrl, pluginId)
          let organizationId = requestedOrgId
          let organizationName: string | undefined
          let projects: Awaited<ReturnType<typeof provider.listProjects>> | undefined
          if (requestedProjectIds.length > 0) {
            projects = await Promise.all(
              requestedProjectIds.map((projectId) =>
                provider.getProject({ accessToken: authToken, projectId }),
              ),
            )
            const projectOrgIds = [
              ...new Set(
                projects
                  .map((project) => project.organizationId)
                  .filter((value): value is string => value !== undefined && value.length > 0),
              ),
            ]
            if ((organizationId === undefined || organizationId.length === 0) && projectOrgIds.length === 1) {
              organizationId = projectOrgIds[0]
              organizationName = projectOrgIds[0]
            }
            if ((organizationId === undefined || organizationId.length === 0) && projectOrgIds.length > 1) {
              throw new Error(
                `Requested PostHog project id(s) span multiple organizations (${projectOrgIds.join(', ')}). Specify organizationId to disambiguate.`,
              )
            }
            if (
              organizationId !== undefined &&
              organizationId.length > 0 &&
              projectOrgIds.length > 0 &&
              !projectOrgIds.includes(organizationId)
            ) {
              throw new Error(
                `Requested PostHog project id(s) do not belong to organization ${organizationId}`,
              )
            }
          }
          if (organizationId === undefined || organizationId.length === 0) {
            let organizations: Awaited<ReturnType<typeof provider.listOrganizations>>
            try {
              organizations = await provider.listOrganizations(authToken)
            } catch (error) {
              if (requestedProjectIds.length === 0 && isPostHogProjectScopedEndpointError(error)) {
                throw new Error(POSTHOG_PROJECT_SCOPED_API_KEY_MESSAGE)
              }
              throw error
            }
            if (organizations.length === 0) {
              throw new Error('No PostHog organizations are accessible with this API key')
            }
            // When the user supplied project ids and didn't pin an organization,
            // we can't blindly pick organizations[0] - the requested projects
            // may live in a different org and validation would later reject
            // them as "Unknown PostHog project id(s)". Probe each org until we
            // find the one that owns the requested projects (or detect the
            // ambiguous case and ask the user to disambiguate).
            if (requestedProjectIds.length > 0 && organizations.length > 1) {
              const matches: Array<{
                slug: string
                name?: string
                projects: Awaited<ReturnType<typeof provider.listProjects>>
              }> = []
              for (const org of organizations) {
                const orgProjects = await provider.listProjects({
                  accessToken: authToken,
                  orgSlug: org.slug,
                })
                // Require every requested id be present in this org. A
                // `some` check would mark an org as ambiguous when it owns
                // any one of the requested ids, falsely rejecting valid
                // requests where overlapping orgs share a subset but only
                // one org actually has them all.
                const orgIdSet = new Set(orgProjects.map((p) => p.id))
                const ownsAll = requestedProjectIds.every((id) => orgIdSet.has(id))
                if (ownsAll) {
                  matches.push({ slug: org.slug, name: org.name, projects: orgProjects })
                }
              }
              if (matches.length === 0) {
                throw new Error(
                  `Unknown PostHog project id(s): ${requestedProjectIds.join(', ')}`,
                )
              }
              if (matches.length > 1) {
                throw new Error(
                  `Requested PostHog project id(s) match multiple organizations (${matches
                    .map((m) => m.slug)
                    .join(
                      ', ',
                    )}). Specify organizationId to disambiguate.`,
                )
              }
              const match = matches[0]
              organizationId = match.slug
              organizationName = match.name
              projects = match.projects
            } else {
              const first = organizations[0]
              // Refuse to auto-pick when the API key can reach multiple
              // organizations and the caller did not pin one. Picking
              // organizations[0] silently binds the source to whichever
              // workspace happens to come first in the response - a different
              // tenant than the caller probably intended - and the mistake
              // only surfaces later as syncs against the wrong data.
              if (organizations.length > 1) {
                throw new Error(
                  `API key has access to multiple PostHog organizations (${organizations
                    .map((org) => org.slug)
                    .join(
                      ', ',
                    )}). Specify organizationId to disambiguate.`,
                )
              }
              organizationId = first.slug
              organizationName = first.name
            }
          }

          if (projects === undefined) {
            projects = await provider.listProjects({
              accessToken: authToken,
              orgSlug: organizationId,
            })
          }
          if (projects.length === 0) {
            throw new Error('No PostHog projects are accessible with this API key')
          }

          const projectsById = new Map(projects.map((project) => [project.id, project]))
          const missingProjectIds: string[] = []
          let resolvedProjectIds: string[]
          let resolvedProjects: typeof projects
          if (requestedProjectIds.length > 0) {
            resolvedProjects = []
            for (const projectId of requestedProjectIds) {
              const project = projectsById.get(projectId)
              if (project === undefined) {
                missingProjectIds.push(projectId)
                continue
              }
              resolvedProjects.push(project)
            }
            if (missingProjectIds.length > 0) {
              throw new Error(
                `Unknown PostHog project id(s): ${missingProjectIds.join(', ')}`,
              )
            }
            resolvedProjectIds = resolvedProjects.map((project) => project.id)
          } else {
            resolvedProjects = projects
            resolvedProjectIds = projects.map((project) => project.id)
          }

          const created = await sourcesRepository.create({
            sourceType,
            name: sourceName,
            additionalMetadata: mergeErrorSourceAdditionalMetadata(
              readPayloadRecord(payload.additionalMetadata),
              pluginId,
            ),
            accessTokenRef: authToken,
            refreshTokenRef: null,
            expiresAt: null,
            grantedScopes: [],
            configuration: {
              ...persistedSetup.configuration,
              orgSlug: organizationId,
              orgName: organizationName,
              projectIds: resolvedProjectIds,
              projectSlugs: resolvedProjectIds,
              projectNames: resolvedProjects.map((project) => project.name),
              posthogBaseUrl: baseUrl,
            },
            logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
            syncEnabled: payload.syncEnabled !== false,
            autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
          })
          log.info(
            `[error-sources] create:success id=${created.id} name="${created.name}" type=posthog`,
          )
          return toRendererErrorSource(created)
        } catch (error) {
          log.error('[error-sources] create:failed', error)
          throw error
        }
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

    // eslint-disable-next-line sonarjs/cognitive-complexity -- Update coordinates persisted config merge plus provider-specific project revalidation.
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
          if (existing.sourceType === 'posthog') {
            nextConfiguration.projectSlugs = nextConfiguration.projectIds
          }
        }
      }
      const setupProjectIds = readSetupStringArray(setupValues, 'projectIds')
      if (setupProjectIds.length > 0) {
        nextConfiguration.projectIds = setupProjectIds
        if (existing.sourceType === 'posthog') {
          nextConfiguration.projectSlugs = nextConfiguration.projectIds
        }
      }
      if (Array.isArray(payload.indexPatterns)) {
        nextConfiguration.indexPatterns = readStringArray(payload.indexPatterns)
      }
      const nextBaseUrl = readOptionalTrimmed(payload.baseUrl)
      if (nextBaseUrl !== undefined && existing.sourceType !== 'posthog') {
        nextConfiguration.baseUrl = nextBaseUrl
      }
      // Accept either `baseUrl` (the field create/IPC uses) or
      // `posthogBaseUrl` here; without honoring `baseUrl`, callers updating a
      // PostHog source (e.g. switching US -> EU) through
      // `errorSources:update` would silently keep the old host because only
      // `posthogBaseUrl` was being read.
      let baseUrlInput: string | null = null
      if (payload.posthogBaseUrl !== undefined && payload.posthogBaseUrl.trim().length > 0) {
        baseUrlInput = payload.posthogBaseUrl
      } else if (payload.baseUrl !== undefined && payload.baseUrl.trim().length > 0) {
        baseUrlInput = payload.baseUrl
      }
      if (baseUrlInput !== null) {
        nextConfiguration.posthogBaseUrl = validatePostHogBaseUrl(baseUrlInput)
      }
      const setupBaseUrl = readSetupTrimmed(setupValues, 'baseUrl')
      if (existing.sourceType === 'posthog' && setupBaseUrl !== undefined) {
        nextConfiguration.posthogBaseUrl = validatePostHogBaseUrl(setupBaseUrl)
        baseUrlInput = setupBaseUrl
      }

      if (
        existing.sourceType === 'sentry' &&
        (
          Array.isArray(payload.projectSlugs) ||
          payload.organizationSlug != null ||
          readSetupTrimmed(setupValues, 'organizationSlug') !== undefined ||
          readSetupTrimmed(setupValues, 'organizationId') !== undefined ||
          readSetupStringArray(setupValues, 'projectSlugs').length > 0
        )
      ) {
        const accessToken = resolveStoredErrorSourceToken(existing.accessTokenRef)
        if (accessToken.length === 0) {
          throw new Error('Access token not found for this source')
        }

        const orgSlug = nextConfiguration.orgSlug?.trim() ?? ''
        if (orgSlug.length === 0) {
          throw new Error('organizationSlug is required')
        }

        const provider = getProviderForSource(providerFactory, {
          sourceType: existing.sourceType,
          additionalMetadata: existing.additionalMetadata,
          configuration: nextConfiguration,
        })
        const projects = await provider.listProjects({ accessToken, orgSlug })
        const resolvedProjects = resolveSentryProjectSelection(projects, {
          projectIds: readConfiguredProjectIds(nextConfiguration),
          projectSlugs: readStringArray(nextConfiguration.projectSlugs),
          defaultToAll:
            !Array.isArray(nextConfiguration.projectSlugs) ||
            nextConfiguration.projectSlugs.length === 0,
        })

        if (resolvedProjects.missingProjectSlugs.length > 0) {
          throw new Error(
            `Unknown Sentry project slug(s): ${resolvedProjects.missingProjectSlugs.join(', ')}`,
          )
        }

        nextConfiguration.projectIds = resolvedProjects.projectIds
        nextConfiguration.projectSlugs = resolvedProjects.projectSlugs
        nextConfiguration.projectNames = resolvedProjects.projectNames
      }

      // PostHog host/org-change handling: when the user pins a new
      // `posthogBaseUrl` (US -> EU, or self-hosted) or switches to a
      // different organization, the previously persisted
      // `projectIds`/`projectSlugs`/`projectNames` were resolved against the
      // old host/org and may not exist in the new tenant. Re-resolve them
      // against the new (host, org) pair so the saved config stays coherent
      // - otherwise the next sync or runbook query would silently fail with
      // "unknown project id".
      const previousPostHogBaseUrl = normalizePostHogBaseUrl(existing.configuration.posthogBaseUrl)
      const nextPostHogBaseUrl = normalizePostHogBaseUrl(
        nextConfiguration.posthogBaseUrl,
      )
      const posthogHostChanged =
        existing.sourceType === 'posthog' &&
        baseUrlInput != null &&
        previousPostHogBaseUrl !== nextPostHogBaseUrl
      const previousPostHogOrgSlug = existing.configuration.orgSlug?.trim() ?? ''
      const nextPostHogOrgSlug = nextConfiguration.orgSlug?.trim() ?? ''
      const posthogOrgChanged =
        existing.sourceType === 'posthog' &&
        nextPostHogOrgSlug.length > 0 &&
        previousPostHogOrgSlug !== nextPostHogOrgSlug
      // Validate `projectIds` even when host and org are unchanged. Without
      // this, a caller can update `projectIds` to ids that don't exist in the
      // current PostHog org and the bad ids would silently persist until the
      // next sync surfaces a generic "unknown project" failure.
      const posthogProjectIdsChanged =
        existing.sourceType === 'posthog' &&
        (
          (Array.isArray(payload.projectIds) &&
            readStringArray(payload.projectIds).length > 0) ||
          readSetupStringArray(setupValues, 'projectIds').length > 0
        )

      if (posthogHostChanged || posthogOrgChanged || posthogProjectIdsChanged) {
        const accessToken = resolveStoredErrorSourceToken(existing.accessTokenRef)
        if (accessToken.length === 0) {
          throw new Error('Access token not found for this source')
        }

        const provider = getProviderForSource(providerFactory, {
          sourceType: existing.sourceType,
          additionalMetadata: existing.additionalMetadata,
          configuration: nextConfiguration,
        })

        const orgSlug = nextConfiguration.orgSlug?.trim() ?? ''
        if (orgSlug.length === 0) {
          throw new Error('organizationId is required')
        }

        const projects = await provider.listProjects({ accessToken, orgSlug })
        if (projects.length === 0) {
          throw new Error('No PostHog projects are accessible for this organization')
        }
        const projectsById = new Map(projects.map((project) => [project.id, project]))

        // If the caller supplied project ids in the same payload, validate
        // them against the new host. If the host changed but no project ids
        // were supplied, drop the stale list and re-fetch all projects from
        // the new host.
        const requestedProjectIds = payload.projectIds ?? []

        if (requestedProjectIds.length > 0) {
          const missing: string[] = []
          const matched: typeof projects = []
          for (const projectId of requestedProjectIds) {
            const project = projectsById.get(projectId)
            if (project === undefined) {
              missing.push(projectId)
              continue
            }
            matched.push(project)
          }
          if (missing.length > 0) {
            throw new Error(
              `Unknown PostHog project id(s): ${missing.join(', ')}`,
            )
          }
          nextConfiguration.projectIds = matched.map((project) => project.id)
          nextConfiguration.projectSlugs = matched.map((project) => project.id)
          nextConfiguration.projectNames = matched.map((project) => project.name)
        } else {
          // Host changed and caller didn't pin specific projects: drop the
          // stale list and default to all projects in the new host so we
          // don't carry over ids that don't exist in the new tenant.
          nextConfiguration.projectIds = projects.map((project) => project.id)
          nextConfiguration.projectSlugs = projects.map((project) => project.id)
          nextConfiguration.projectNames = projects.map((project) => project.name)
        }
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
      const sourceType = payload.sourceType
      const pluginId = readPluginId(payload.pluginId)
      const setupValues = readPayloadRecord(payload.setupValues) ?? {}
      const persistedSetup = resolvePersistedPluginSetup(
        pluginRuntime,
        pluginId ?? sourceType,
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

    // eslint-disable-next-line sonarjs/cognitive-complexity -- OAuth completion handles provider-specific org/project binding after token exchange.
    'errorSources:completeOAuth': async (rawPayload: unknown) => {
      const payload = readCompleteOAuthPayload(rawPayload)
      const sourceType = payload.sourceType
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

        if (sourceType === 'sentry') {
          const provider = getProviderForSource(providerFactory, {
            sourceType,
            additionalMetadata: { pluginId },
          })
          const organizations = await provider.listOrganizations(accessToken)
          log.info(`[error-sources] completeOAuth: fetched organizations count=${String(organizations.length)}`)
          let orgSlug = ''
          if (payload.orgSlug !== undefined) {
            orgSlug = payload.orgSlug.trim()
          }
          if (orgSlug.length === 0 && organizations.length === 0) {
            throw new Error('No accessible Sentry organization found')
          }
          if (orgSlug.length === 0) {
            orgSlug = organizations[0].slug
          }
          if (orgSlug.length === 0) {
            throw new Error('No accessible Sentry organization found')
          }

          const projects = await provider.listProjects({ accessToken, orgSlug })
          log.info(`[error-sources] completeOAuth: fetched projects org="${orgSlug}" count=${String(projects.length)}`)
          const selectedProjects = readStringArray(payload.projectSlugs)
          const resolvedProjects = resolveSentryProjectSelection(projects, {
            projectSlugs: selectedProjects,
            defaultToAll: selectedProjects.length === 0,
          })

          if (resolvedProjects.missingProjectSlugs.length > 0) {
            throw new Error(
              `Unknown Sentry project slug(s): ${resolvedProjects.missingProjectSlugs.join(', ')}`,
            )
          }

          const configuration: ErrorSourceConfiguration = {
            ...persistedSetup.configuration,
            orgSlug,
            orgName: organizations.find((org) => org.slug === orgSlug)?.name,
            projectIds: resolvedProjects.projectIds,
            projectSlugs: resolvedProjects.projectSlugs,
            projectNames: resolvedProjects.projectNames,
          }
          applyOptionalOAuthConfiguration(configuration, {
            oauthClientId,
            oauthClientSecret,
            oauthRedirectUri,
          })

          const source = await sourcesRepository.create({
            sourceType: 'sentry',
            name: payload.name ?? `Sentry (${orgSlug})`,
            additionalMetadata: mergeErrorSourceAdditionalMetadata(
              readPayloadRecord(payload.additionalMetadata),
              pluginId,
            ),
            accessTokenRef: tokenResult.accessToken,
            refreshTokenRef: tokenResult.refreshToken,
            expiresAt: tokenResult.expiresAt,
            grantedScopes: tokenResult.scopes,
            configuration,
            logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
            syncEnabled: payload.syncEnabled !== false,
            autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
          })
          log.info(
            `[error-sources] completeOAuth:success id=${source.id} org="${orgSlug}" selectedProjects=${String(resolvedProjects.projectIds.length)}`,
          )

          return { source: toRendererErrorSource(source), organizations, projects }
        }

        // posthog
        const baseUrl = validatePostHogBaseUrl(oauthBaseUrl)
        const provider = getProviderForSource(providerFactory, {
          sourceType,
          additionalMetadata: { pluginId },
          configuration: { posthogBaseUrl: baseUrl },
        })
        const organizations = await provider.listOrganizations(accessToken)
        log.info(`[error-sources] completeOAuth: fetched PostHog organizations count=${String(organizations.length)}`)
        const requestedOrgSlug = payload.orgSlug?.trim() ?? payload.organizationId?.trim() ?? ''
        const selectedProjectIds = readStringArray(
          payload.projectIds ?? payload.projectSlugs,
        )
        let orgSlug = requestedOrgSlug
        let projects: Awaited<ReturnType<typeof provider.listProjects>> | undefined
        if (orgSlug.length === 0) {
          if (organizations.length === 0) {
            throw new Error('No accessible PostHog organization found')
          }
          // OAuth tokens may unlock multiple PostHog organizations; mirror the
          // API-key flow and probe each org so we don't reject project ids
          // that exist in a different accessible org.
          if (selectedProjectIds.length > 0 && organizations.length > 1) {
            const matches: Array<{
              slug: string
              name?: string
              projects: Awaited<ReturnType<typeof provider.listProjects>>
            }> = []
            for (const org of organizations) {
              const orgProjects = await provider.listProjects({ accessToken, orgSlug: org.slug })
              // Require every requested id be present in this org (see the
              // API-key flow above for rationale).
              const orgIdSet = new Set(orgProjects.map((p) => p.id))
              const ownsAll = selectedProjectIds.every((id) => orgIdSet.has(id))
              if (ownsAll) {
                matches.push({ slug: org.slug, name: org.name, projects: orgProjects })
              }
            }
            if (matches.length === 0) {
              throw new Error(
                `Unknown PostHog project id(s): ${selectedProjectIds.join(', ')}`,
              )
            }
            if (matches.length > 1) {
              throw new Error(
                `Requested PostHog project id(s) match multiple organizations (${matches
                  .map((m) => m.slug)
                  .join(', ')}). Specify organizationId to disambiguate.`,
              )
            }
            orgSlug = matches[0].slug
            projects = matches[0].projects
          } else if (organizations.length > 1) {
            // Refuse to auto-pick when the OAuth token can reach multiple
            // organizations and the caller did not pin one. Binding to
            // organizations[0] silently lands in whichever workspace the
            // API returns first, and the wrong-tenant mistake only surfaces
            // later when issues sync from an unexpected source.
            throw new Error(
              `OAuth token has access to multiple PostHog organizations (${organizations
                .map((org) => org.slug)
                .join(', ')}). Specify organizationId to disambiguate.`,
            )
          } else {
            orgSlug = organizations[0].slug
          }
        }
        if (orgSlug.length === 0) {
          throw new Error('No accessible PostHog organization found')
        }

        if (projects === undefined) {
          projects = await provider.listProjects({ accessToken, orgSlug })
        }
        log.info(`[error-sources] completeOAuth: fetched PostHog projects org="${orgSlug}" count=${String(projects.length)}`)
        const projectsById = new Map(projects.map((project) => [project.id, project]))
        let resolvedProjects = projects
        if (selectedProjectIds.length > 0) {
          resolvedProjects = selectedProjectIds.map((id) => {
            const project = projectsById.get(id)
            if (project === undefined) throw new Error(`Unknown PostHog project id: ${id}`)
            return project
          })
        }
        if (resolvedProjects.length === 0) {
          throw new Error('No PostHog projects are accessible with this OAuth token')
        }

        const resolvedOrgName =
          organizations.find((org) => org.slug === orgSlug)?.name ?? orgSlug
        const configuration: ErrorSourceConfiguration = {
          ...persistedSetup.configuration,
          orgSlug,
          orgName: organizations.find((org) => org.slug === orgSlug)?.name,
          projectIds: resolvedProjects.map((project) => project.id),
          projectSlugs: resolvedProjects.map((project) => project.id),
          projectNames: resolvedProjects.map((project) => project.name),
          posthogBaseUrl: baseUrl,
        }
        applyOptionalOAuthConfiguration(configuration, {
          oauthClientId,
          oauthClientSecret,
          oauthRedirectUri,
        })

        const source = await sourcesRepository.create({
          sourceType: 'posthog',
          name: payload.name ?? `PostHog (${resolvedOrgName})`,
          additionalMetadata: mergeErrorSourceAdditionalMetadata(
            readPayloadRecord(payload.additionalMetadata),
            pluginId,
          ),
          accessTokenRef: tokenResult.accessToken,
          refreshTokenRef: tokenResult.refreshToken,
          expiresAt: tokenResult.expiresAt,
          grantedScopes: tokenResult.scopes,
          configuration,
          logLevelThreshold: toLogLevelThreshold(payload.logLevelThreshold),
          syncEnabled: payload.syncEnabled !== false,
          autoDiagnosisEnabled: payload.autoDiagnosisEnabled === true,
        })
        log.info(
          `[error-sources] completeOAuth:success id=${source.id} type=posthog org="${orgSlug}" projects=${String(resolvedProjects.length)}`,
        )

        return { source: toRendererErrorSource(source), organizations, projects }
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

      if (
        source.sourceType !== 'sentry' &&
        source.sourceType !== 'posthog' &&
        plugin?.metadata?.errorSource?.sourceType === source.sourceType
      ) {
        const providerActions = plugin.metadata.errorSource.providerActions
        const auth = buildPluginAuthFromSource(source, pluginRuntime)
        const input = buildGenericPluginConnectionInput(source)

        try {
          if (providerActions?.queryIssues !== undefined) {
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

          if (providerActions?.searchAlerts !== undefined) {
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

          if (providerActions?.listOrganizations !== undefined) {
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
