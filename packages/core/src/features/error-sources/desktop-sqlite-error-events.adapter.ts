import { randomUUID } from 'crypto'
import type { DbClient } from '../desktop/desktop-database-client'
import type { ErrorEvent, ErrorEventQuery } from './desktop-error-sources.types'
import {
  nullableJsonRecordArraySchema,
  nullableJsonRecordSchema,
  parseSqliteJson,
  sqliteIso,
  sqliteJsonArrayText,
  sqliteJsonText,
  sqliteNullableValue,
  sqliteNullableText,
  sqliteText,
  type SqliteRow,
} from './desktop-sqlite-row'

export interface UpsertErrorEventInput {
  sourceId: string
  issueId: string
  externalEventId: string
  timestamp: string
  message?: string | null
  exceptionType?: string | null
  exceptionValue?: string | null
  exceptionMechanism?: Record<string, unknown> | null
  stacktrace?: Record<string, unknown> | null
  inAppFrames?: Array<Record<string, unknown>> | null
  tags?: Record<string, unknown> | null
  contexts?: Record<string, unknown> | null
  userContext?: Record<string, unknown> | null
  requestContext?: Record<string, unknown> | null
  environment?: string | null
  release?: string | null
  serverName?: string | null
  traceId?: string | null
  requestId?: string | null
  transactionName?: string | null
  additionalMetadata?: Record<string, unknown> | null
}

export class SqliteErrorEventsRepositoryAdapter {
  constructor(private readonly db: DbClient) {}

  async upsert(input: UpsertErrorEventInput): Promise<ErrorEvent> {
    const existing = await this.db.errorEvent.findUnique({
      where: {
        sourceId: input.sourceId,
        externalEventId: input.externalEventId,
      },
    })

    const eventData = this.toEventData(input)

    let row: SqliteRow
    if (existing !== null) {
      row = await this.db.errorEvent.update({
        where: { id: existing.id },
        data: eventData,
      })
    } else {
      row = await this.db.errorEvent.create({
        data: {
          id: randomUUID(),
          ...eventData,
        },
      })
    }

    return this.toDomain(row)
  }

  async findById(id: string): Promise<ErrorEvent | null> {
    const row = await this.db.errorEvent.findUnique({ where: { id } })
    if (row === null) {
      return null
    }

    return this.toDomain(row)
  }

  async list(query: ErrorEventQuery): Promise<{ data: ErrorEvent[]; total: number }> {
    const take = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)))
    const skip = Math.max(0, Math.trunc(query.offset ?? 0))
    const where: Record<string, unknown> = { sourceId: query.sourceId }
    if (query.issueId !== undefined && query.issueId.length > 0) {
      where.issueId = query.issueId
    }
    const keyword = this.normalizeSearch(query.search)

    if (keyword.length === 0) {
      const [rows, total] = await Promise.all([
        this.db.errorEvent.findMany({
          where,
          orderBy: { timestamp: 'desc' },
          take,
          skip,
        }),
        this.db.errorEvent.count({ where }),
      ])

      return {
        data: rows.map((row) => this.toDomain(row)),
        total,
      }
    }

    const rows = await this.db.errorEvent.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 1000,
      skip: 0,
    })

    const filtered = rows
      .map((row) => this.toDomain(row))
      .filter((row: ErrorEvent) => this.matchesSearchKeyword(row, keyword))

    return {
      data: filtered.slice(skip, skip + take),
      total: filtered.length,
    }
  }

  private toDomain(row: SqliteRow): ErrorEvent {
    return {
      id: sqliteText(row.id),
      sourceId: sqliteText(row.sourceId),
      issueId: sqliteText(row.issueId),
      externalEventId: sqliteText(row.externalEventId),
      timestamp: sqliteIso(row.timestamp),
      message: sqliteNullableText(row.message),
      exceptionType: sqliteNullableText(row.exceptionType),
      exceptionValue: sqliteNullableText(row.exceptionValue),
      exceptionMechanism: parseSqliteJson(row.exceptionMechanism, nullableJsonRecordSchema, null),
      stacktrace: parseSqliteJson(row.stacktrace, nullableJsonRecordSchema, null),
      inAppFrames: parseSqliteJson(row.inAppFrames, nullableJsonRecordArraySchema, null),
      tags: parseSqliteJson(row.tags, nullableJsonRecordSchema, null),
      contexts: parseSqliteJson(row.contexts, nullableJsonRecordSchema, null),
      userContext: parseSqliteJson(row.userContext, nullableJsonRecordSchema, null),
      requestContext: parseSqliteJson(row.requestContext, nullableJsonRecordSchema, null),
      environment: sqliteNullableText(row.environment),
      release: sqliteNullableText(row.release),
      serverName: sqliteNullableText(row.serverName),
      traceId: sqliteNullableText(row.traceId),
      requestId: sqliteNullableText(row.requestId),
      transactionName: sqliteNullableText(row.transactionName),
      additionalMetadata: parseSqliteJson(
        row.additionalMetadata,
        nullableJsonRecordSchema,
        null,
      ),
      createdAt: sqliteIso(row.createdAt),
      updatedAt: sqliteIso(row.updatedAt),
    }
  }

  private toEventData(input: UpsertErrorEventInput): Record<string, unknown> {
    return {
      sourceId: input.sourceId,
      issueId: input.issueId,
      externalEventId: input.externalEventId,
      timestamp: input.timestamp,
      message: sqliteNullableValue(input.message),
      exceptionType: sqliteNullableValue(input.exceptionType),
      exceptionValue: sqliteNullableValue(input.exceptionValue),
      exceptionMechanism: sqliteJsonText(input.exceptionMechanism),
      stacktrace: sqliteJsonText(input.stacktrace),
      inAppFrames: sqliteJsonArrayText(input.inAppFrames),
      tags: sqliteJsonText(input.tags),
      contexts: sqliteJsonText(input.contexts),
      userContext: sqliteJsonText(input.userContext),
      requestContext: sqliteJsonText(input.requestContext),
      environment: sqliteNullableValue(input.environment),
      release: sqliteNullableValue(input.release),
      serverName: sqliteNullableValue(input.serverName),
      traceId: sqliteNullableValue(input.traceId),
      requestId: sqliteNullableValue(input.requestId),
      transactionName: sqliteNullableValue(input.transactionName),
      additionalMetadata: sqliteJsonText(input.additionalMetadata),
    }
  }

  private matchesSearchKeyword(row: ErrorEvent, keyword: string): boolean {
    return this.searchHaystack(row).includes(keyword)
  }

  private searchHaystack(row: ErrorEvent): string {
    return [
      row.externalEventId,
      row.message,
      row.exceptionType,
      row.exceptionValue,
      row.environment,
      row.release,
      row.serverName,
      row.transactionName,
      row.traceId,
      row.requestId,
    ]
      .map((value) => sqliteNullableValue(value) ?? '')
      .join(' ')
      .toLowerCase()
  }

  private normalizeSearch(search: string | undefined): string {
    if (search !== undefined) {
      return search.trim().toLowerCase()
    }

    return ''
  }
}
