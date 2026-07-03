import log from 'electron-log'
import { z } from 'zod'
import type { DbClient } from '../desktop/desktop-database-client'
import { mapDiagnosisSourceContext } from '../diagnosis-workflow'
import { SqliteErrorEventsRepositoryAdapter } from './desktop-sqlite-error-events.adapter'
import { SqliteErrorIssuesRepositoryAdapter } from './desktop-sqlite-error-issues.adapter'
import { SqliteErrorSourcesRepositoryAdapter } from './desktop-sqlite-error-sources.adapter'
import type {
  ErrorEvent,
  ErrorIssue,
  ErrorSource,
  LogLevelThreshold,
} from './desktop-error-sources.types'
import {
  buildCompactExternalSourceEventFallback,
  buildCompactExternalSourceIssueFallback,
  buildCompactExternalSourceTelemetryPayload,
  isCompactExternalSourceTelemetryPayload,
  summarizeExternalSourcePayload,
} from './desktop-external-source-telemetry-storage'
import {
  createDesktopNodePluginRuntimeService,
} from '../plugins/node'
import type {
  DesktopPluginErrorSourceRecord,
  DesktopPluginRuntimeService,
} from '../plugins'
import {
  hasErrorSourceProviderAction,
  resolveErrorSourceProviderActionId,
} from './desktop-plugin-error-source-actions'

type ExternalPayloadRecord = Record<string, unknown>

const externalPayloadRecordSchema = z.record(z.string(), z.unknown())

interface ErrorSourceSyncDatabase {
  telemetryDaily: Pick<DbClient['telemetryDaily'], 'upsert'>
  telemetryEntry: Pick<DbClient['telemetryEntry'], 'create' | 'findUnique'>
  diagnosisEntry: Pick<DbClient['diagnosisEntry'], 'upsert'>
  diagnosisEntrySourceRef: Pick<DbClient['diagnosisEntrySourceRef'], 'upsert'>
  $queryRawUnsafe: DbClient['$queryRawUnsafe']
}

type ErrorSourcesRepository = Pick<
  SqliteErrorSourcesRepositoryAdapter,
  'findById' | 'findSyncEnabled' | 'update' | 'updateSyncStatus'
>
type ErrorIssuesRepository = Pick<SqliteErrorIssuesRepositoryAdapter, 'findById' | 'upsert'>
type ErrorEventsRepository = Pick<SqliteErrorEventsRepositoryAdapter, 'findById' | 'upsert'>

type DiagnosisIssueContext = Pick<
  ErrorIssue,
  'id' | 'externalIssueId' | 'title' | 'projectIdentifier' | 'environment' | 'level'
>

type DiagnosisEventContext = Pick<
  ErrorEvent,
  | 'id'
  | 'externalEventId'
  | 'timestamp'
  | 'message'
  | 'exceptionType'
  | 'exceptionValue'
  | 'environment'
  | 'serverName'
>

interface CustomPluginSyncCapabilities {
  issueAction: 'listIssues' | 'queryIssues'
  hasListIssueEvents: boolean
}

interface CustomPluginIssueContext {
  issue: ErrorIssue
  externalIssueId: string
  title: string
  tags: Record<string, unknown>
  lastSeen: string
}

const MAX_GENERIC_PLUGIN_ISSUE_PAGES = 10
const MAX_GENERIC_PLUGIN_ISSUES_PER_PAGE = 100
const MAX_GENERIC_PLUGIN_EVENT_PAGES_PER_ISSUE = 10

function readRecord(value: unknown): ExternalPayloadRecord | null {
  const parsed = externalPayloadRecordSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }

  return null
}

function readRecordArray(value: unknown): ExternalPayloadRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const record = readRecord(item)
    if (record === null) {
      return []
    }

    return [record]
  })
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized.length > 0) {
      return normalized
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return null
}

function readRequiredString(value: unknown, fallback: string): string {
  return readOptionalString(value) ?? fallback
}

function readNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null
  }

  return Boolean(value)
}

function readRecordString(record: ExternalPayloadRecord | null, key: string): string | null {
  if (record === null) {
    return null
  }

  return readOptionalString(record[key])
}

function formatElapsedMs(startMs: number): string {
  return String(Date.now() - startMs)
}

function optionalJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

function parseIssueTags(tags: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {}

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (Array.isArray(tag) && tag.length >= 2) {
        const key = readOptionalString(tag[0])
        if (key === null) continue
        output[key] = tag[1]
        continue
      }

      const tagRecord = readRecord(tag)
      if (tagRecord === null) continue

      const key = readOptionalString(tagRecord.key)
      if (key === null) continue
      output[key] = tagRecord.value
    }
    return output
  }

  const tagsRecord = readRecord(tags)
  if (tagsRecord !== null) {
    for (const [key, value] of Object.entries(tagsRecord)) {
      const normalizedKey = key.trim()
      if (normalizedKey.length === 0) continue
      output[normalizedKey] = value
    }
  }

  return output
}

function extractTagValue(tags: Record<string, unknown>, tagKey: string): string | null {
  const value = tags[tagKey]
  if (value == null) return null
  return readOptionalString(value)
}

function extractIssueField(issue: ExternalPayloadRecord, tagKey: string): string | null {
  const parsedTags = parseIssueTags(issue.tags)
  return extractTagValue(parsedTags, tagKey)
}

function extractException(event: ExternalPayloadRecord): {
  exceptionType: string | null
  exceptionValue: string | null
  stacktrace: Record<string, unknown> | null
  inAppFrames: Array<Record<string, unknown>> | null
  mechanism: Record<string, unknown> | null
} {
  const entries = readRecordArray(event.entries)
  const exceptionEntry = entries.find((entry) => entry.type === 'exception')
  let exceptionDataInput: unknown
  if (exceptionEntry !== undefined) {
    exceptionDataInput = exceptionEntry.data
  }
  const exceptionData = readRecord(exceptionDataInput)

  let valuesInput: unknown
  if (exceptionData !== null) {
    valuesInput = exceptionData.values
  }
  const values = readRecordArray(valuesInput)
  const first = values[0]

  let stacktraceInput: unknown
  if (first !== undefined) {
    stacktraceInput = first.stacktrace
  }
  const stacktrace = readRecord(stacktraceInput)

  let framesInput: unknown
  if (stacktrace !== null) {
    framesInput = stacktrace.frames
  }
  const frames = readRecordArray(framesInput)

  let exceptionTypeInput: unknown
  let exceptionValueInput: unknown
  let mechanismInput: unknown
  if (first !== undefined) {
    exceptionTypeInput = first.type
    exceptionValueInput = first.value
    mechanismInput = first.mechanism
  }

  return {
    exceptionType: readOptionalString(exceptionTypeInput),
    exceptionValue: readOptionalString(exceptionValueInput),
    stacktrace,
    inAppFrames: frames.filter((frame) => frame.inApp === true || frame.in_app === true),
    mechanism: readRecord(mechanismInput),
  }
}

function extractBreadcrumbs(event: ExternalPayloadRecord): Array<Record<string, unknown>> {
  const entries = readRecordArray(event.entries)
  const breadcrumbsEntry = entries.find((entry) => entry.type === 'breadcrumbs')
  const breadcrumbsData = readRecord(breadcrumbsEntry?.data)
  const topLevelBreadcrumbs = readRecord(event.breadcrumbs)
  const valuesFromEntries = readRecordArray(breadcrumbsData?.values)
  if (valuesFromEntries.length > 0) {
    return valuesFromEntries
  }

  return readRecordArray(topLevelBreadcrumbs?.values)
}

function mergeContextsWithBreadcrumbs(
  contexts: Record<string, unknown> | null,
  breadcrumbs: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (breadcrumbs.length === 0) {
    return contexts
  }
  let next: Record<string, unknown> = {}
  if (contexts !== null) {
    next = { ...contexts }
  }
  next.__breadcrumbs = breadcrumbs
  return next
}

function toIsoOrNow(value: unknown): string {
  const raw = readOptionalString(value) ?? ''
  const parsed = new Date(raw)
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString()
  }
  return new Date().toISOString()
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function readPluginIndexPattern(source: ErrorSource): string | undefined {
  const indexPatterns = readStringArray(source.configuration.indexPatterns)
  if (indexPatterns.length > 0) {
    return indexPatterns.join(',')
  }

  const legacyProjectSlugs = readStringArray(source.configuration.projectSlugs)
  if (legacyProjectSlugs.length > 0) {
    return legacyProjectSlugs.join(',')
  }

  return undefined
}

function readSourcePluginId(source: ErrorSource): string {
  const pluginId = source.additionalMetadata?.pluginId
  if (typeof pluginId === 'string' && pluginId.trim().length > 0) {
    return pluginId.trim()
  }

  return source.sourceType
}

function pluginSourceRecord(source: ErrorSource): DesktopPluginErrorSourceRecord {
  return {
    id: source.id,
    sourceType: source.sourceType,
    name: source.name,
    accessTokenRef: source.accessTokenRef,
    refreshTokenRef: source.refreshTokenRef,
    expiresAt: source.expiresAt,
    grantedScopes: source.grantedScopes,
    configuration: { ...source.configuration },
  }
}

function buildPluginAuthFromSource(
  source: ErrorSource,
  pluginRuntime: DesktopPluginRuntimeService,
): Promise<Record<string, unknown>> {
  const pluginId = readSourcePluginId(source)
  return pluginRuntime.buildErrorSourceAuth({
    pluginId,
    source: pluginSourceRecord(source),
  })
}

function buildGenericPluginSyncInput(args: {
  source: ErrorSource
  query: string
  limit: number
  cursor?: string
  since?: string
  until?: string
}): Record<string, unknown> {
  const { source, query, limit, cursor, since, until } = args
  const input: Record<string, unknown> = {
    query,
    limit,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
  }

  const orgSlug = readOptionalString(source.configuration.orgSlug)
  if (orgSlug !== null) {
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

  const indexPattern = readPluginIndexPattern(source)
  if (indexPattern !== undefined) {
    input.indexPattern = indexPattern
  }

  if (cursor !== undefined && cursor.length > 0) {
    input.cursor = cursor
  }
  if (since !== undefined) {
    input.since = since
  }
  if (until !== undefined) {
    input.until = until
  }

  return input
}

function readPluginIssueBatch(data: unknown): {
  issues: ExternalPayloadRecord[]
  hasMore: boolean
  nextCursor?: string
} | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }

  const rawIssues = (data as { issues?: unknown }).issues
  if (!Array.isArray(rawIssues)) {
    return null
  }

  const issues = readRecordArray(rawIssues)
  const nextCursor = readOptionalString((data as { nextCursor?: unknown }).nextCursor)

  const page = {
    issues,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  }
  if (nextCursor !== null) {
    return {
      ...page,
      nextCursor,
    }
  }

  return page
}

function readPluginEventBatch(data: unknown): {
  events: ExternalPayloadRecord[]
  hasMore: boolean
  nextCursor?: string
} | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }

  const rawEvents = (data as { events?: unknown }).events
  if (!Array.isArray(rawEvents)) {
    return null
  }

  const events = readRecordArray(rawEvents)
  const nextCursor = readOptionalString((data as { nextCursor?: unknown }).nextCursor)

  const page = {
    events,
    hasMore: (data as { hasMore?: unknown }).hasMore === true,
  }
  if (nextCursor !== null) {
    return {
      ...page,
      nextCursor,
    }
  }

  return page
}

function readPluginExternalId(record: ExternalPayloadRecord): string | null {
  return (
    readOptionalString(record.externalIssueId) ??
    readOptionalString(record.issueId) ??
    readOptionalString(record.externalEventId) ??
    readOptionalString(record.eventId) ??
    readOptionalString(record.id)
  )
}

function readPluginProjectIdentifier(record: ExternalPayloadRecord): string | null {
  const direct =
    readOptionalString(record.projectIdentifier) ??
    readOptionalString(record.projectId) ??
    readOptionalString(record.projectSlug)
  if (direct !== null) {
    return direct
  }

  const project = readRecord(record.project)
  return (
    readOptionalString(project?.slug) ??
    readOptionalString(project?.name) ??
    readOptionalString(project?.id)
  )
}

function readPluginRelease(record: ExternalPayloadRecord): string | null {
  const direct = readOptionalString(record.release)
  if (direct !== null) {
    return direct
  }

  return readRecordString(readRecord(record.release), 'version')
}

function readPluginNumericCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric)
    }
  }

  return null
}

function readPluginBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  return null
}

function readPluginIssueTimestamp(record: ExternalPayloadRecord, fallback: string): string {
  return toIsoOrNow(
    record.lastSeen ??
      record.last_seen ??
      record.firstSeen ??
      record.first_seen ??
      record.timestamp ??
      record.dateCreated ??
      record.createdAt ??
      fallback,
  )
}

function readPluginEventTimestamp(record: ExternalPayloadRecord, fallback: string): string {
  return toIsoOrNow(
    record.timestamp ??
      record.dateCreated ??
      record.createdAt ??
      record.receivedAt ??
      record.lastSeen ??
      record.last_seen ??
      fallback,
  )
}

function parseLevelToRuleLevel(level: string | null): number {
  const normalized = (level ?? '').toLowerCase()
  if (normalized === 'fatal') return 10
  if (normalized === 'error') return 8
  if (normalized === 'warning') return 6
  if (normalized === 'info') return 4
  return 5
}

function severityRank(level: string | null): number {
  const normalized = (level ?? '').trim().toLowerCase()
  if (normalized === 'fatal') return 50
  if (normalized === 'error') return 40
  if (normalized === 'warning' || normalized === 'warn') return 30
  if (normalized === 'info') return 20
  if (normalized === 'debug') return 10
  return 20
}

function shouldIngestByThreshold(level: string | null, threshold: LogLevelThreshold): boolean {
  return severityRank(level) >= severityRank(threshold)
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  try {
    return readRecord(JSON.parse(value))
  } catch {
    // no-op
  }
  return null
}

function extractIssueMetadata(issue: ExternalPayloadRecord): Record<string, unknown> | null {
  return readRecord(issue.metadata)
}

function toDiagnosisIssueContext(
  issue: ErrorIssue | ExternalPayloadRecord | null,
): DiagnosisIssueContext | null {
  if (issue === null) {
    return null
  }

  return {
    id: readRequiredString(issue.id, ''),
    externalIssueId: readRequiredString(issue.externalIssueId, ''),
    title: readRequiredString(issue.title, 'Untitled issue'),
    projectIdentifier: readOptionalString(issue.projectIdentifier),
    environment: readOptionalString(issue.environment),
    level: readRequiredString(issue.level, 'error'),
  }
}

function toDiagnosisEventContext(
  event: ErrorEvent | ExternalPayloadRecord | null,
): DiagnosisEventContext | null {
  if (event === null) {
    return null
  }

  return {
    id: readRequiredString(event.id, ''),
    externalEventId: readRequiredString(event.externalEventId, ''),
    timestamp: readRequiredString(event.timestamp, new Date().toISOString()),
    message: readOptionalString(event.message),
    exceptionType: readOptionalString(event.exceptionType),
    exceptionValue: readOptionalString(event.exceptionValue),
    environment: readOptionalString(event.environment),
    serverName: readOptionalString(event.serverName),
  }
}

export class ErrorSourceSyncService {
  constructor(
    private readonly db: ErrorSourceSyncDatabase,
    private readonly sourcesRepository: ErrorSourcesRepository,
    private readonly issuesRepository: ErrorIssuesRepository,
    private readonly eventsRepository: ErrorEventsRepository,
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
  ) {}

  async syncSourceById(sourceId: string): Promise<{ sourceId: string; syncedIssues: number; syncedEvents: number }> {
    const source = await this.sourcesRepository.findById(sourceId)
    if (source === null) {
      throw new Error(`Error source ${sourceId} not found`)
    }
    return this.syncSource(source)
  }

  async syncAllEnabled(): Promise<Array<{ sourceId: string; syncedIssues: number; syncedEvents: number; error?: string }>> {
    const sources = await this.sourcesRepository.findSyncEnabled()
    const results: Array<{ sourceId: string; syncedIssues: number; syncedEvents: number; error?: string }> = []

    for (const source of sources) {
      try {
        const result = await this.syncSource(source)
        results.push(result)
      } catch (error) {
        let message = String(error)
        if (error instanceof Error) {
          message = error.message
        }
        results.push({
          sourceId: source.id,
          syncedIssues: 0,
          syncedEvents: 0,
          error: message,
        })
      }
    }

    return results
  }

  private async syncSource(source: ErrorSource): Promise<{ sourceId: string; syncedIssues: number; syncedEvents: number }> {
    await this.sourcesRepository.updateSyncStatus(source.id, 'in_progress')
    const syncStartMs = Date.now()
    log.info(
      `[sync] start id=${source.id} type=${source.sourceType} name="${source.name}" threshold=${source.logLevelThreshold} lastSyncAt=${source.lastSyncAt ?? 'never'}`,
    )

    try {
      return await this.syncCustomPluginSource(source)
    } catch (error) {
      let message = String(error)
      if (error instanceof Error) {
        message = error.message
      }
      log.error(
        `[sync] failed id=${source.id} elapsedMs=${formatElapsedMs(syncStartMs)}: ${message}`,
      )
      await this.sourcesRepository.update({
        id: source.id,
        lastSyncStatus: 'failed',
        lastSyncError: message,
      })
      throw error
    }
  }

  private async projectEventToDiagnosis(
    source: ErrorSource,
    issue: DiagnosisIssueContext,
    event: DiagnosisEventContext,
  ): Promise<void> {
    const eventTimestamp = toIsoOrNow(event.timestamp)
    const telemetryDate = eventTimestamp.slice(0, 10)

    const daily = await this.db.telemetryDaily.upsert({
      where: { telemetryDate },
      create: {
        telemetryDate,
        currentState: 'pending',
      },
      update: {},
    })

    const existing = await this.db.telemetryEntry.findUnique({
      where: {
        telemetryId: Number(daily.id),
        entryId: event.externalEventId,
      },
    })

    if (existing !== null) {
      await this.ensureDefaultDiagnosisEntry(Number(existing.id), {
        source,
        issue,
        event,
      })
      return
    }

    const compactPayload = buildCompactExternalSourceTelemetryPayload({
      sourceType: source.sourceType,
      sourceId: source.id,
      issue,
      event,
    })

    const sourceType = source.sourceType
    let ruleDescription = issue.title
    if (ruleDescription.length === 0) {
      ruleDescription = event.exceptionType ?? `${sourceType} Error`
    }
    const created = await this.db.telemetryEntry.create({
      data: {
        telemetryId: Number(daily.id),
        entryId: event.externalEventId,
        entryIndex: issue.externalIssueId,
        entrySource: JSON.stringify(compactPayload),
        entryTimestamp: eventTimestamp,
        fullLog: summarizeExternalSourcePayload(compactPayload),
        decoderName: sourceType,
        location: `${sourceType}://${source.id}/${issue.externalIssueId}`,
        agentName: issue.projectIdentifier,
        agentIp: null,
        ruleId: null,
        ruleDescription,
        ruleLevel: parseLevelToRuleLevel(issue.level),
        processName: `${sourceType}-sync`,
        inputType: sourceType,
        hostname: event.serverName,
        groups: JSON.stringify([sourceType]),
        ruleGroups: JSON.stringify([sourceType]),
        category: 'application',
        state: 'pending',
      },
    })

    await this.ensureDefaultDiagnosisEntry(Number(created.id), {
      source,
      issue,
      event,
    })
  }

  private async ensureDefaultDiagnosisEntry(
    telemetryEntryId: number,
    context?: {
      source: ErrorSource
      issue: DiagnosisIssueContext | null
      event: DiagnosisEventContext | null
    },
  ): Promise<void> {
    let sourceCategory = 'telemetry'
    let sourceKind = 'telemetry_entry'
    let logLevel = 'infrastructure'
    let category = 'unknown'
    let sourceMetadata: Record<string, unknown> | undefined
    let normalizedData: Record<string, unknown> | undefined
    let sourceRef: {
      sourceTableName: string
      sourceFieldName: string
      sourceKeyValue: string | number
    } = {
      sourceTableName: 'TelemetryEntry',
      sourceFieldName: 'id',
      sourceKeyValue: telemetryEntryId,
    }

    if (context !== undefined) {
      sourceCategory = context.source.sourceType
      sourceKind = 'error_event'
      logLevel = 'application'
      category = 'application'
      sourceMetadata = {
        sourceType: context.source.sourceType,
        sourceId: context.source.id,
        issueId: context.issue?.id ?? null,
        issueExternalId: context.issue?.externalIssueId ?? null,
        eventId: context.event?.id ?? null,
        eventExternalId: context.event?.externalEventId ?? context.event?.id ?? null,
      }
      normalizedData = {
        provider_native_issue_id: context.issue?.externalIssueId ?? null,
        provider_native_event_id: context.event?.externalEventId ?? context.event?.id ?? null,
      }
      sourceRef = {
        sourceTableName: 'ErrorEvent',
        sourceFieldName: 'externalEventId',
        sourceKeyValue:
          context.event?.externalEventId ??
          context.event?.id ??
          telemetryEntryId,
      }
    }

    const mapped = mapDiagnosisSourceContext({
      telemetryEntryId,
      sourceCategory,
      sourceKind,
      logLevel,
      severity: context?.issue?.level ?? null,
      description:
        context?.event?.message ??
        context?.event?.exceptionValue ??
        context?.issue?.title ??
        undefined,
      environment:
        context?.event?.environment ??
        context?.issue?.environment ??
        null,
      providerNativeSeverity: context?.issue?.level ?? null,
      providerNativeId:
        context?.event?.externalEventId ??
        context?.event?.id ??
        context?.issue?.externalIssueId ??
        null,
      sourceMetadata,
      normalizedData,
      sourceRef,
    })

    const createSourceMetadata = optionalJson(mapped.sourceMetadata)
    const createNormalizedData = optionalJson(mapped.normalizedData)
    let updateSourceMetadata: string | undefined
    if (mapped.sourceMetadata !== undefined) {
      updateSourceMetadata = JSON.stringify(mapped.sourceMetadata)
    }
    const updateNormalizedData = JSON.stringify(mapped.normalizedData)

    const diagnosisRow = await this.db.diagnosisEntry.upsert({
      where: { telemetryEntryId },
      create: {
        telemetryEntryId,
        currentState: 'pending',
        stateHistory: '[]',
        stateTexts: '{}',
        sourceCategory: mapped.sourceCategory,
        sourceKind: mapped.sourceKind,
        logLevel: mapped.logLevel,
        severity: mapped.severity,
        category,
        description: mapped.description ?? null,
        environment: mapped.environment ?? null,
        sourceMetadata: createSourceMetadata,
        normalizedData: createNormalizedData,
      },
      update: {
        sourceCategory: mapped.sourceCategory,
        sourceKind: mapped.sourceKind,
        logLevel: mapped.logLevel,
        severity: mapped.severity,
        category,
        description: mapped.description ?? undefined,
        environment: mapped.environment ?? undefined,
        sourceMetadata: updateSourceMetadata,
        normalizedData: updateNormalizedData,
      },
    })

    await this.db.diagnosisEntrySourceRef.upsert({
      where: { diagnosisEntryId: Number(diagnosisRow.id) },
      create: {
        diagnosisEntryId: Number(diagnosisRow.id),
        sourceTableName: mapped.sourceRef.sourceTableName,
        sourceFieldName: mapped.sourceRef.sourceFieldName,
        sourceKeyValue: mapped.sourceRef.sourceKeyValue,
      },
      update: {
        sourceTableName: mapped.sourceRef.sourceTableName,
        sourceFieldName: mapped.sourceRef.sourceFieldName,
        sourceKeyValue: mapped.sourceRef.sourceKeyValue,
      },
    })
  }

  private async backfillMissingDiagnosisEntriesForSource(sourceId: string): Promise<void> {
    const rows = await this.db.$queryRawUnsafe<{ id: number; entrySource: string | null }>(
      `
      SELECT te."id" as "id", te."entrySource" as "entrySource"
      FROM "TelemetryEntry" te
      LEFT JOIN "DiagnosisEntry" de
        ON de."telemetryEntryId" = te."id"
      WHERE de."id" IS NULL
      `,
    )

    const source = await this.sourcesRepository.findById(sourceId)

    for (const row of rows) {
      const payload = parseJsonObject(row.entrySource)
      if (payload === null) continue
      const payloadSourceId = readOptionalString(payload.sourceId)
      if (payloadSourceId === null || payloadSourceId !== sourceId) continue
      if (source === null) {
        await this.ensureDefaultDiagnosisEntry(row.id)
        continue
      }

      if (isCompactExternalSourceTelemetryPayload(payload)) {
        let issueLookup = Promise.resolve<ErrorIssue | null>(null)
        if (payload.issueId !== null) {
          issueLookup = this.issuesRepository.findById(payload.issueId)
        }
        let eventLookup = Promise.resolve<ErrorEvent | null>(null)
        if (payload.eventId !== null) {
          eventLookup = this.eventsRepository.findById(payload.eventId)
        }
        const [issue, event] = await Promise.all([
          issueLookup,
          eventLookup,
        ])
        await this.ensureDefaultDiagnosisEntry(row.id, {
          source,
          issue: toDiagnosisIssueContext(
            issue ?? buildCompactExternalSourceIssueFallback(payload),
          ),
          event: toDiagnosisEventContext(
            event ?? buildCompactExternalSourceEventFallback(payload),
          ),
        })
        continue
      }

      const issue = toDiagnosisIssueContext(readRecord(payload.issue))
      const event = toDiagnosisEventContext(readRecord(payload.event))
      await this.ensureDefaultDiagnosisEntry(row.id, { source, issue, event })
    }
  }

  private readCustomPluginSyncCapabilities(
    source: ErrorSource,
    pluginId: string,
  ): CustomPluginSyncCapabilities {
    const plugin = this.pluginRuntime.getPlugin(pluginId)
    if (plugin?.metadata?.errorSource?.sourceType !== source.sourceType) {
      throw new Error(
        `Error source plugin "${pluginId}" does not match source type ${source.sourceType}`,
      )
    }

    const hasListIssues = hasErrorSourceProviderAction(plugin, 'listIssues')
    const hasQueryIssues = hasErrorSourceProviderAction(plugin, 'queryIssues')
    if (!hasListIssues && !hasQueryIssues) {
      throw new Error(
        `Error source plugin "${pluginId}" does not declare listIssues or queryIssues`,
      )
    }

    let issueAction: 'listIssues' | 'queryIssues' = 'queryIssues'
    if (hasListIssues) {
      issueAction = 'listIssues'
    }

    return {
      issueAction,
      hasListIssueEvents: hasErrorSourceProviderAction(plugin, 'listIssueEvents'),
    }
  }

  private async fetchCustomPluginIssuePage(args: {
    source: ErrorSource
    pluginId: string
    auth: Record<string, unknown>
    issueAction: 'listIssues' | 'queryIssues'
    cursor: string | undefined
    since: string | undefined
    until: string
    pageCount: number
  }) {
    const pageStartMs = Date.now()
    const result = await this.pluginRuntime.executeAction({
      pluginId: args.pluginId,
      actionId: resolveErrorSourceProviderActionId({
        runtime: this.pluginRuntime,
        pluginId: args.pluginId,
        sourceType: args.source.sourceType,
        action: args.issueAction,
      }),
      auth: args.auth,
      input: buildGenericPluginSyncInput({
        source: args.source,
        query: '*',
        limit: MAX_GENERIC_PLUGIN_ISSUES_PER_PAGE,
        cursor: args.cursor,
        since: args.since,
        until: args.until,
      }),
    })

    const page = readPluginIssueBatch(result.data)
    if (page === null) {
      throw new Error(
        `Plugin "${args.pluginId}" returned an invalid issue batch for source sync`,
      )
    }

    log.info(
      `[sync] id=${args.source.id} pluginListIssues page=${String(args.pageCount)} returned=${String(page.issues.length)} hasMore=${String(page.hasMore && page.issues.length > 0)} elapsedMs=${formatElapsedMs(pageStartMs)}`,
    )
    return page
  }

  private async upsertCustomPluginIssue(
    source: ErrorSource,
    issueRecord: ExternalPayloadRecord,
    syncStartedAt: string,
  ): Promise<CustomPluginIssueContext | null> {
    const externalIssueId = readPluginExternalId(issueRecord)
    if (externalIssueId === null) {
      return null
    }

    const title =
      readOptionalString(issueRecord.title) ??
      readOptionalString(issueRecord.message) ??
      readOptionalString(issueRecord.name) ??
      'Untitled issue'
    const level = readOptionalString(issueRecord.level) ?? 'error'
    if (!shouldIngestByThreshold(level, source.logLevelThreshold)) {
      return null
    }

    const firstSeen = readPluginIssueTimestamp(issueRecord, syncStartedAt)
    const lastSeen = toIsoOrNow(
      issueRecord.lastSeen ??
        issueRecord.last_seen ??
        issueRecord.timestamp ??
        issueRecord.updatedAt ??
        firstSeen,
    )
    const tags = parseIssueTags(issueRecord.tags)
    const issue = await this.issuesRepository.upsert({
      sourceId: source.id,
      externalIssueId,
      externalShortId:
        readOptionalString(issueRecord.shortId) ??
        readOptionalString(issueRecord.externalShortId),
      title,
      culprit: readOptionalString(issueRecord.culprit),
      type: readOptionalString(issueRecord.type),
      metadata: readRecord(issueRecord.metadata),
      projectIdentifier: readPluginProjectIdentifier(issueRecord),
      level,
      status:
        readOptionalString(issueRecord.status) ??
        readOptionalString(issueRecord.state) ??
        'unresolved',
      isUnhandled: readPluginBoolean(issueRecord.isUnhandled),
      firstSeen,
      lastSeen,
      eventCount: readPluginNumericCount(
        issueRecord.eventCount ?? issueRecord.count,
      ) ?? 1,
      userCount: readPluginNumericCount(issueRecord.userCount),
      tags,
      environment:
        readOptionalString(issueRecord.environment) ??
        extractTagValue(tags, 'environment'),
      release: readPluginRelease(issueRecord) ?? extractTagValue(tags, 'release'),
      platform: readOptionalString(issueRecord.platform) ?? source.sourceType,
      additionalMetadata: issueRecord,
    })

    return { issue, externalIssueId, title, tags, lastSeen }
  }

  private async upsertListedCustomPluginEvent(args: {
    source: ErrorSource
    issue: ErrorIssue
    eventRecord: ExternalPayloadRecord
    externalIssueId: string
    title: string
    lastSeen: string
    syncedEvents: number
  }): Promise<boolean> {
    const eventLevel =
      readOptionalString(args.eventRecord.level) ?? args.issue.level
    if (!shouldIngestByThreshold(eventLevel, args.source.logLevelThreshold)) {
      return false
    }

    const externalEventId =
      readPluginExternalId(args.eventRecord) ??
      `${args.externalIssueId}:event:${String(args.syncedEvents + 1)}`
    const parsedEventTags = parseIssueTags(args.eventRecord.tags)
    const exception = extractException(args.eventRecord)
    const breadcrumbs = extractBreadcrumbs(args.eventRecord)
    const contexts = readRecord(args.eventRecord.contexts)
    const trace = readRecord(contexts?.trace)
    const contextsWithBreadcrumbs = mergeContextsWithBreadcrumbs(contexts, breadcrumbs)
    const eventTimestamp = readPluginEventTimestamp(args.eventRecord, args.lastSeen)
    const message =
      readOptionalString(args.eventRecord.message) ??
      readOptionalString(args.eventRecord.title) ??
      readOptionalString(args.eventRecord.name) ??
      readOptionalString(args.eventRecord.culprit) ??
      args.title
    const environment =
      readOptionalString(args.eventRecord.environment) ??
      extractTagValue(parsedEventTags, 'environment') ??
      args.issue.environment
    const release =
      readPluginRelease(args.eventRecord) ??
      extractTagValue(parsedEventTags, 'release') ??
      args.issue.release
    const serverName =
      readOptionalString(args.eventRecord.serverName) ??
      readOptionalString(readRecord(args.eventRecord.host)?.name) ??
      readOptionalString(args.eventRecord.hostname)
    const exceptionType =
      exception.exceptionType ?? readOptionalString(args.eventRecord.type)
    const exceptionValue =
      exception.exceptionValue ?? readOptionalString(args.eventRecord.value)

    await this.eventsRepository.upsert({
      sourceId: args.source.id,
      issueId: args.issue.id,
      externalEventId,
      timestamp: eventTimestamp,
      message,
      exceptionType,
      exceptionValue,
      exceptionMechanism:
        exception.mechanism ?? readRecord(args.eventRecord.mechanism),
      stacktrace: exception.stacktrace ?? readRecord(args.eventRecord.stacktrace),
      inAppFrames:
        exception.inAppFrames ?? readRecordArray(args.eventRecord.inAppFrames),
      tags: parsedEventTags,
      contexts: contextsWithBreadcrumbs,
      userContext: readRecord(args.eventRecord.user),
      requestContext: readRecord(args.eventRecord.request),
      environment,
      release,
      serverName,
      traceId:
        readOptionalString(trace?.trace_id ?? trace?.traceId) ??
        readOptionalString(args.eventRecord.traceId),
      requestId:
        readOptionalString(trace?.span_id ?? trace?.spanId) ??
        readOptionalString(args.eventRecord.requestId),
      transactionName:
        readOptionalString(args.eventRecord.transaction) ??
        readOptionalString(args.eventRecord.transactionName),
      additionalMetadata: args.eventRecord,
    })
    await this.projectEventToDiagnosis(args.source, args.issue, {
      id: externalEventId,
      externalEventId,
      timestamp: eventTimestamp,
      message,
      exceptionType,
      exceptionValue,
      environment,
      serverName,
    })
    return true
  }

  private async syncListedCustomPluginIssueEvents(args: {
    source: ErrorSource
    pluginId: string
    auth: Record<string, unknown>
    issueContext: CustomPluginIssueContext
    since: string | undefined
    until: string
  }): Promise<number> {
    let syncedEvents = 0
    let eventCursor: string | undefined
    let eventPageCount = 0
    let eventsHasMore = true

    while (
      eventsHasMore &&
      eventPageCount < MAX_GENERIC_PLUGIN_EVENT_PAGES_PER_ISSUE
    ) {
      eventPageCount += 1
      const eventPageStartMs = Date.now()
      const eventResult = await this.pluginRuntime.executeAction({
        pluginId: args.pluginId,
        actionId: resolveErrorSourceProviderActionId({
          runtime: this.pluginRuntime,
          pluginId: args.pluginId,
          sourceType: args.source.sourceType,
          action: 'listIssueEvents',
        }),
        auth: args.auth,
        input: {
          ...buildGenericPluginSyncInput({
            source: args.source,
            query: '*',
            limit: MAX_GENERIC_PLUGIN_ISSUES_PER_PAGE,
            since: args.since,
            until: args.until,
          }),
          issueId: args.issueContext.externalIssueId,
          cursor: eventCursor,
        },
      })
      const eventPage = readPluginEventBatch(eventResult.data)
      if (eventPage === null) {
        throw new Error(
          `Plugin "${args.pluginId}" returned an invalid event batch for source sync`,
        )
      }

      eventsHasMore = eventPage.hasMore && eventPage.events.length > 0
      eventCursor = eventPage.nextCursor
      log.info(
        `[sync] id=${args.source.id} pluginListIssueEvents issue=${args.issueContext.externalIssueId} page=${String(eventPageCount)} returned=${String(eventPage.events.length)} hasMore=${String(eventsHasMore)} elapsedMs=${formatElapsedMs(eventPageStartMs)}`,
      )

      for (const eventRecord of eventPage.events) {
        const didSync = await this.upsertListedCustomPluginEvent({
          source: args.source,
          issue: args.issueContext.issue,
          eventRecord,
          externalIssueId: args.issueContext.externalIssueId,
          title: args.issueContext.title,
          lastSeen: args.issueContext.lastSeen,
          syncedEvents,
        })
        if (didSync) {
          syncedEvents += 1
        }
      }

      if (
        eventPage.nextCursor === undefined &&
        eventPage.events.length < MAX_GENERIC_PLUGIN_ISSUES_PER_PAGE
      ) {
        eventsHasMore = false
      }
    }

    return syncedEvents
  }

  private async upsertSyntheticCustomPluginEvent(
    source: ErrorSource,
    issueContext: CustomPluginIssueContext,
    issueRecord: ExternalPayloadRecord,
  ): Promise<void> {
    const syntheticEventId =
      readOptionalString(issueRecord.latestEventId) ??
      readOptionalString(issueRecord.eventId) ??
      `${issueContext.externalIssueId}:latest`
    const syntheticMessage =
      readOptionalString(issueRecord.message) ??
      readOptionalString(issueRecord.culprit) ??
      issueContext.title
    const serverName =
      readOptionalString(issueRecord.serverName) ??
      readOptionalString(readRecord(issueRecord.host)?.name) ??
      readOptionalString(issueRecord.hostname)
    const environment =
      readOptionalString(issueRecord.environment) ??
      extractTagValue(issueContext.tags, 'environment')

    await this.eventsRepository.upsert({
      sourceId: source.id,
      issueId: issueContext.issue.id,
      externalEventId: syntheticEventId,
      timestamp: issueContext.lastSeen,
      message: syntheticMessage,
      exceptionType: readOptionalString(issueRecord.type),
      exceptionValue: readOptionalString(issueRecord.value),
      exceptionMechanism: null,
      stacktrace: readRecord(issueRecord.stacktrace),
      inAppFrames: readRecordArray(issueRecord.inAppFrames),
      tags: issueContext.tags,
      contexts: readRecord(issueRecord.contexts),
      userContext: readRecord(issueRecord.user),
      requestContext: readRecord(issueRecord.request),
      environment,
      release: readPluginRelease(issueRecord),
      serverName,
      traceId: readOptionalString(issueRecord.traceId),
      requestId: readOptionalString(issueRecord.requestId),
      transactionName: readOptionalString(issueRecord.transactionName),
      additionalMetadata: issueRecord,
    })
    await this.projectEventToDiagnosis(source, issueContext.issue, {
      id: syntheticEventId,
      externalEventId: syntheticEventId,
      timestamp: issueContext.lastSeen,
      message: syntheticMessage,
      exceptionType: readOptionalString(issueRecord.type),
      exceptionValue: readOptionalString(issueRecord.value),
      environment,
      serverName,
    })
  }

  private async syncCustomPluginSource(
    source: ErrorSource,
  ): Promise<{ sourceId: string; syncedIssues: number; syncedEvents: number }> {
    const pluginId = readSourcePluginId(source)
    const capabilities = this.readCustomPluginSyncCapabilities(source, pluginId)
    const auth = await buildPluginAuthFromSource(source, this.pluginRuntime)
    const syncStartedAt = new Date().toISOString()
    const since = source.lastSyncAt ?? undefined
    const until = syncStartedAt
    let cursor: string | undefined
    let pageCount = 0
    let hasMore = true
    let syncedIssues = 0
    let syncedEvents = 0

    while (hasMore && pageCount < MAX_GENERIC_PLUGIN_ISSUE_PAGES) {
      pageCount += 1
      const page = await this.fetchCustomPluginIssuePage({
        source,
        pluginId,
        auth,
        issueAction: capabilities.issueAction,
        cursor,
        since,
        until,
        pageCount,
      })
      hasMore = page.hasMore && page.issues.length > 0
      cursor = page.nextCursor

      for (const issueRecord of page.issues) {
        const issueContext = await this.upsertCustomPluginIssue(
          source,
          issueRecord,
          syncStartedAt,
        )
        if (issueContext === null) {
          continue
        }
        syncedIssues += 1

        if (capabilities.hasListIssueEvents) {
          syncedEvents += await this.syncListedCustomPluginIssueEvents({
            source,
            pluginId,
            auth,
            issueContext,
            since,
            until,
          })
        } else {
          await this.upsertSyntheticCustomPluginEvent(source, issueContext, issueRecord)
          syncedEvents += 1
        }
      }

      if (page.nextCursor === undefined && page.issues.length < MAX_GENERIC_PLUGIN_ISSUES_PER_PAGE) {
        hasMore = false
      }
    }

    await this.backfillMissingDiagnosisEntriesForSource(source.id)
    await this.sourcesRepository.update({
      id: source.id,
      lastSyncAt: syncStartedAt,
      lastSyncStatus: 'success',
      lastSyncError: null,
    })
    log.info(
      `[sync] success id=${source.id} type=${source.sourceType} issues=${String(syncedIssues)} events=${String(syncedEvents)}`,
    )
    return {
      sourceId: source.id,
      syncedIssues,
      syncedEvents,
    }
  }
}
