import { randomUUID } from 'crypto'
import type { DbClient } from '../desktop/desktop-database-client'
import type { ErrorIssue, ErrorIssueQuery } from './desktop-error-sources.types'
import {
  nullableJsonRecordSchema,
  parseSqliteJson,
  sqliteIso,
  sqliteJsonText,
  sqliteNullableBoolean,
  sqliteNullableNumber,
  sqliteNullableText,
  sqliteNullableValue,
  sqliteNumber,
  sqliteText,
  type SqliteRow,
} from './desktop-sqlite-row'

export interface UpsertErrorIssueInput {
  sourceId: string
  externalIssueId: string
  externalShortId?: string | null
  title: string
  culprit?: string | null
  type?: string | null
  metadata?: Record<string, unknown> | null
  projectIdentifier?: string | null
  level: string
  status: string
  isUnhandled?: boolean | null
  firstSeen: string
  lastSeen: string
  eventCount: number
  userCount?: number | null
  tags?: Record<string, unknown> | null
  environment?: string | null
  release?: string | null
  platform?: string | null
  additionalMetadata?: Record<string, unknown> | null
}

export class SqliteErrorIssuesRepositoryAdapter {
  constructor(private readonly db: DbClient) {}

  async upsert(input: UpsertErrorIssueInput): Promise<ErrorIssue> {
    const existing = await this.db.errorIssue.findUnique({
      where: {
        sourceId: input.sourceId,
        externalIssueId: input.externalIssueId,
      },
    })

    const issueData = this.toIssueData(input)

    if (existing !== null) {
      const row = await this.db.errorIssue.update({
        where: { id: existing.id },
        data: issueData,
      })
      return this.toDomain(row)
    }

    const row = await this.db.errorIssue.create({
      data: {
        id: randomUUID(),
        ...issueData,
      },
    })

    return this.toDomain(row)
  }

  async findById(id: string): Promise<ErrorIssue | null> {
    const row = await this.db.errorIssue.findUnique({ where: { id } })
    if (row === null) {
      return null
    }

    return this.toDomain(row)
  }

  async list(query: ErrorIssueQuery): Promise<{ data: ErrorIssue[]; total: number }> {
    const where: Record<string, unknown> = {
      sourceId: query.sourceId,
    }
    this.addIssueFilter(where, 'status', query.status)
    this.addIssueFilter(where, 'level', query.level)
    this.addIssueFilter(where, 'projectIdentifier', query.projectIdentifier)
    this.addIssueFilter(where, 'environment', query.environment)

    const take = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)))
    const skip = Math.max(0, Math.trunc(query.offset ?? 0))

    const [rows, total] = await Promise.all([
      this.db.errorIssue.findMany({
        where,
        orderBy: { lastSeen: 'desc' },
        take,
        skip,
      }),
      this.db.errorIssue.count({ where }),
    ])

    return {
      data: rows.map((row) => this.toDomain(row)),
      total,
    }
  }

  private toDomain(row: SqliteRow): ErrorIssue {
    return {
      id: sqliteText(row.id),
      sourceId: sqliteText(row.sourceId),
      externalIssueId: sqliteText(row.externalIssueId),
      externalShortId: sqliteNullableText(row.externalShortId),
      title: sqliteText(row.title),
      culprit: sqliteNullableText(row.culprit),
      type: sqliteNullableText(row.type),
      metadata: parseSqliteJson(row.metadata, nullableJsonRecordSchema, null),
      projectIdentifier: sqliteNullableText(row.projectIdentifier),
      level: sqliteText(row.level, 'error'),
      status: sqliteText(row.status, 'unresolved'),
      isUnhandled: sqliteNullableBoolean(row.isUnhandled),
      firstSeen: sqliteIso(row.firstSeen),
      lastSeen: sqliteIso(row.lastSeen),
      eventCount: sqliteNumber(row.eventCount),
      userCount: sqliteNullableNumber(row.userCount),
      tags: parseSqliteJson(row.tags, nullableJsonRecordSchema, null),
      environment: sqliteNullableText(row.environment),
      release: sqliteNullableText(row.release),
      platform: sqliteNullableText(row.platform),
      additionalMetadata: parseSqliteJson(
        row.additionalMetadata,
        nullableJsonRecordSchema,
        null,
      ),
      diagnosisStatus: sqliteNullableText(row.diagnosisStatus),
      diagnosisResult: parseSqliteJson(row.diagnosisResult, nullableJsonRecordSchema, null),
      createdAt: sqliteIso(row.createdAt),
      updatedAt: sqliteIso(row.updatedAt),
    }
  }

  private toIssueData(input: UpsertErrorIssueInput): Record<string, unknown> {
    return {
      sourceId: input.sourceId,
      externalIssueId: input.externalIssueId,
      externalShortId: sqliteNullableValue(input.externalShortId),
      title: input.title,
      culprit: sqliteNullableValue(input.culprit),
      type: sqliteNullableValue(input.type),
      metadata: sqliteJsonText(input.metadata),
      projectIdentifier: sqliteNullableValue(input.projectIdentifier),
      level: input.level,
      status: input.status,
      isUnhandled: sqliteNullableValue(input.isUnhandled),
      firstSeen: input.firstSeen,
      lastSeen: input.lastSeen,
      eventCount: input.eventCount,
      userCount: sqliteNullableValue(input.userCount),
      tags: sqliteJsonText(input.tags),
      environment: sqliteNullableValue(input.environment),
      release: sqliteNullableValue(input.release),
      platform: sqliteNullableValue(input.platform),
      additionalMetadata: sqliteJsonText(input.additionalMetadata),
    }
  }

  private addIssueFilter(
    where: Record<string, unknown>,
    key: 'status' | 'level' | 'projectIdentifier' | 'environment',
    value: string | undefined,
  ): void {
    if (value === undefined || value.length === 0) {
      return
    }

    where[key] = value
  }
}
