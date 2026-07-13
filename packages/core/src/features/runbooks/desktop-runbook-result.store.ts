import { z } from 'zod'
import {
  createInterruptedExecutionSnapshot,
  parseExecutionSnapshot as parseSharedExecutionSnapshot,
} from './execution'

export const RUNBOOK_EXECUTION_INTERRUPTED_MESSAGE =
  'Execution interrupted because the desktop app restarted before completion.'
export const DEFAULT_RUNBOOK_EXECUTION_HEARTBEAT_GRACE_MS = 60_000

export const parseExecutionSnapshot = parseSharedExecutionSnapshot

type RunbookExecutionRecord = NonNullable<
  ReturnType<typeof parseSharedExecutionSnapshot>
>

interface RunbookResultContext {
  runbook: {
    revisionNumber: number
  }
}

interface RunbookResultRunbook {
  id: string
  title: string
}

type DesktopRunbookResultRow = Record<string, unknown>

interface InvestigationSessionTable {
  create(args: {
    data: Record<string, unknown>
  }): Promise<DesktopRunbookResultRow>
  update(args: {
    where: { id: string }
    data: Record<string, unknown>
  }): Promise<DesktopRunbookResultRow>
  findUnique(args: {
    where: Record<string, unknown>
  }): Promise<DesktopRunbookResultRow | null>
  findFirst(args: Record<string, unknown>): Promise<DesktopRunbookResultRow | null>
  findMany(args: Record<string, unknown>): Promise<DesktopRunbookResultRow[]>
}

export interface DesktopRunbookResultDatabase {
  investigationSession: InvestigationSessionTable
  auditLog?: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>
  }
  $executeRawUnsafe(query: string): Promise<unknown>
  $queryRawUnsafe<T extends DesktopRunbookResultRow = DesktopRunbookResultRow>(
    query: string,
  ): Promise<T[]>
}

const runbookSessionRowSchema = z.record(z.string(), z.unknown())

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value
  }

  return fallback
}

function parseRowExecutionSnapshot(row: unknown): RunbookExecutionRecord | null {
  if (row === null || row === undefined) {
    return null
  }

  const session = runbookSessionRowSchema.parse(row)
  return parseExecutionSnapshot(asString(session.executionSnapshotJson))
}

export interface CreateRunbookResultSessionInput {
  resultId: string
  executionId: string
  ownerId: string
  incidentThreadId?: string
  runbook: RunbookResultRunbook
  context: RunbookResultContext
  snapshot: RunbookExecutionRecord
}

export interface RunbookResultPersistence {
  createRunbookResultSession(input: CreateRunbookResultSessionInput): Promise<void>
  saveExecutionSnapshot(resultId: string, snapshot: RunbookExecutionRecord): Promise<void>
  getExecutionSnapshotByExecutionId(executionId: string): Promise<RunbookExecutionRecord | null>
  getExecutionSnapshotByResultId(resultId: string): Promise<RunbookExecutionRecord | null>
  getLatestExecutionSnapshotByIncidentThreadId(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null>
  touchExecutionHeartbeat(
    executionId: string,
    ownerId: string,
    timestamp?: string,
  ): Promise<void>
  requestExecutionCancellation(
    executionId: string,
    requestedAt?: string,
  ): Promise<boolean>
  isExecutionCancellationRequested(executionId: string): Promise<boolean>
  completeExecutionControl(
    executionId: string,
    ownerId: string,
    completedAt?: string,
  ): Promise<void>
  markStaleRunningSessionsFailed(options?: { heartbeatGraceMs?: number }): Promise<number>
}

type ExecutionControlRow = DesktopRunbookResultRow & {
  heartbeatAt?: string | null
  cancelRequestedAt?: string | null
  completedAt?: string | null
}

export class SqliteRunbookResultStore implements RunbookResultPersistence {
  constructor(private readonly db: DesktopRunbookResultDatabase) {}

  private async createExecutionControlRow(
    executionId: string,
    ownerId: string,
    startedAt: string,
  ): Promise<void> {
    const safeExecutionId = executionId.replace(/'/g, "''")
    const safeOwnerId = ownerId.replace(/'/g, "''")
    const safeStartedAt = startedAt.replace(/'/g, "''")

    await this.db.$executeRawUnsafe(`
      INSERT INTO "RunbookExecutionControl" (
        "executionId",
        "ownerId",
        "heartbeatAt",
        "cancelRequestedAt",
        "completedAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        '${safeExecutionId}',
        '${safeOwnerId}',
        '${safeStartedAt}',
        NULL,
        NULL,
        '${safeStartedAt}',
        '${safeStartedAt}'
      )
      ON CONFLICT("executionId") DO UPDATE SET
        "ownerId" = excluded."ownerId",
        "heartbeatAt" = excluded."heartbeatAt",
        "cancelRequestedAt" = NULL,
        "completedAt" = NULL,
        "updatedAt" = excluded."updatedAt"
    `)
  }

  async createRunbookResultSession(
    input: CreateRunbookResultSessionInput,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.createExecutionControlRow(
      input.executionId,
      input.ownerId,
      input.snapshot.startedAt,
    )
    await this.db.investigationSession.create({
      data: {
        id: input.resultId,
        runbookId: input.runbook.id,
        runbookVersionId: null,
        runbookTitle: input.runbook.title,
        runbookRevisionNumber: input.context.runbook.revisionNumber,
        runbookContextJson: JSON.stringify(input.context),
        executionId: input.executionId,
        incidentThreadId: input.incidentThreadId ?? null,
        executionSnapshotJson: JSON.stringify(input.snapshot),
        status: input.snapshot.status,
        startedAt: input.snapshot.startedAt,
        completedAt: input.snapshot.completedAt ?? null,
        prompt: '',
        createdAt: input.snapshot.startedAt,
        updatedAt: now,
      },
    })
  }

  async saveExecutionSnapshot(
    resultId: string,
    snapshot: RunbookExecutionRecord,
  ): Promise<void> {
    await this.db.investigationSession.update({
      where: { id: resultId },
      data: {
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt ?? null,
        executionSnapshotJson: JSON.stringify(snapshot),
        updatedAt: new Date().toISOString(),
      },
    })
  }

  async getExecutionSnapshotByExecutionId(
    executionId: string,
  ): Promise<RunbookExecutionRecord | null> {
    const row = await this.db.investigationSession.findUnique({
      where: { executionId },
    })
    return parseRowExecutionSnapshot(row)
  }

  async getExecutionSnapshotByResultId(
    resultId: string,
  ): Promise<RunbookExecutionRecord | null> {
    const row = await this.db.investigationSession.findUnique({
      where: { id: resultId },
    })
    return parseRowExecutionSnapshot(row)
  }

  async getLatestExecutionSnapshotByIncidentThreadId(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null> {
    const row = await this.db.investigationSession.findFirst({
      where: { incidentThreadId },
      orderBy: { startedAt: 'desc', updatedAt: 'desc' },
    })
    return parseRowExecutionSnapshot(row)
  }

  async touchExecutionHeartbeat(
    executionId: string,
    ownerId: string,
    timestamp = new Date().toISOString(),
  ): Promise<void> {
    const safeExecutionId = executionId.replace(/'/g, "''")
    const safeOwnerId = ownerId.replace(/'/g, "''")
    const safeTimestamp = timestamp.replace(/'/g, "''")

    await this.db.$executeRawUnsafe(`
      INSERT INTO "RunbookExecutionControl" (
        "executionId",
        "ownerId",
        "heartbeatAt",
        "cancelRequestedAt",
        "completedAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        '${safeExecutionId}',
        '${safeOwnerId}',
        '${safeTimestamp}',
        NULL,
        NULL,
        '${safeTimestamp}',
        '${safeTimestamp}'
      )
      ON CONFLICT("executionId") DO UPDATE SET
        "ownerId" = excluded."ownerId",
        "heartbeatAt" = excluded."heartbeatAt",
        "updatedAt" = excluded."updatedAt"
    `)
  }

  async requestExecutionCancellation(
    executionId: string,
    requestedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const safeExecutionId = executionId.replace(/'/g, "''")
    const safeRequestedAt = requestedAt.replace(/'/g, "''")
    const result = await this.db.$executeRawUnsafe(`
      UPDATE "RunbookExecutionControl"
      SET
        "cancelRequestedAt" = COALESCE("cancelRequestedAt", '${safeRequestedAt}'),
        "updatedAt" = '${safeRequestedAt}'
      WHERE "executionId" = '${safeExecutionId}'
        AND "completedAt" IS NULL
    `)

    return Number(result) > 0
  }

  async isExecutionCancellationRequested(executionId: string): Promise<boolean> {
    const row = await this.findExecutionControlRow(executionId)
    return (
      row !== null &&
      row.cancelRequestedAt !== null &&
      row.cancelRequestedAt !== undefined &&
      (row.completedAt === null || row.completedAt === undefined)
    )
  }

  async completeExecutionControl(
    executionId: string,
    ownerId: string,
    completedAt = new Date().toISOString(),
  ): Promise<void> {
    const safeExecutionId = executionId.replace(/'/g, "''")
    const safeOwnerId = ownerId.replace(/'/g, "''")
    const safeCompletedAt = completedAt.replace(/'/g, "''")

    await this.db.$executeRawUnsafe(`
      UPDATE "RunbookExecutionControl"
      SET
        "ownerId" = '${safeOwnerId}',
        "heartbeatAt" = '${safeCompletedAt}',
        "completedAt" = '${safeCompletedAt}',
        "updatedAt" = '${safeCompletedAt}'
      WHERE "executionId" = '${safeExecutionId}'
    `)
  }

  async markStaleRunningSessionsFailed(
    options?: { heartbeatGraceMs?: number },
  ): Promise<number> {
    const rows = await this.db.investigationSession.findMany({
      where: { status: 'running' },
    })

    let updatedCount = 0
    const completedAt = new Date().toISOString()
    const heartbeatGraceMs =
      options?.heartbeatGraceMs ?? DEFAULT_RUNBOOK_EXECUTION_HEARTBEAT_GRACE_MS
    const staleHeartbeatBefore = Date.now() - heartbeatGraceMs

    for (const row of rows) {
      const session = runbookSessionRowSchema.parse(row)
      const resultId = asString(session.id)
      if (resultId.length === 0) continue

      const executionId = asString(session.executionId)
      if (await this.hasActiveExecutionControl(executionId, staleHeartbeatBefore)) {
        continue
      }

      await this.markSessionInterrupted(resultId, session, completedAt)
      await this.recordStaleRecoveryAudit(resultId, executionId, completedAt)
      if (executionId.length > 0) {
        await this.completeExecutionControl(executionId, 'stale-recovery', completedAt)
      }
      updatedCount += 1
    }

    return updatedCount
  }

  private async findExecutionControlRow(
    executionId: string,
  ): Promise<ExecutionControlRow | null> {
    const safeExecutionId = executionId.replace(/'/g, "''")
    const rows = await this.db.$queryRawUnsafe<ExecutionControlRow>(`
      SELECT "heartbeatAt", "cancelRequestedAt", "completedAt"
      FROM "RunbookExecutionControl"
      WHERE "executionId" = '${safeExecutionId}'
      LIMIT 1
    `)

    return rows[0] ?? null
  }

  private async hasActiveExecutionControl(
    executionId: string,
    staleHeartbeatBefore: number,
  ): Promise<boolean> {
    if (executionId.length === 0) {
      return false
    }

    const control = await this.findExecutionControlRow(executionId)
    if (
      control === null ||
      (control.completedAt !== null && control.completedAt !== undefined)
    ) {
      return false
    }

    const heartbeatAt = this.parseHeartbeatAt(control.heartbeatAt)
    return Number.isFinite(heartbeatAt) && heartbeatAt >= staleHeartbeatBefore
  }

  private parseHeartbeatAt(value: string | null | undefined): number {
    if (value === null || value === undefined || value.length === 0) {
      return Number.NaN
    }

    return Date.parse(value)
  }

  private interruptedSnapshotJson(
    session: Record<string, unknown>,
    completedAt: string,
  ): string | null {
    const snapshot = parseExecutionSnapshot(asString(session.executionSnapshotJson))
    if (snapshot === null) {
      return null
    }

    return JSON.stringify(
      createInterruptedExecutionSnapshot(snapshot, {
        completedAt,
        errorMessage: RUNBOOK_EXECUTION_INTERRUPTED_MESSAGE,
      }),
    )
  }

  private async markSessionInterrupted(
    resultId: string,
    session: Record<string, unknown>,
    completedAt: string,
  ): Promise<void> {
    await this.db.investigationSession.update({
      where: { id: resultId },
      data: {
        status: 'failed',
        completedAt,
        executionSnapshotJson: this.interruptedSnapshotJson(session, completedAt),
        updatedAt: completedAt,
      },
    })
  }

  private async recordStaleRecoveryAudit(
    resultId: string,
    executionId: string,
    completedAt: string,
  ): Promise<void> {
    if (this.db.auditLog === undefined) {
      return
    }

    await this.db.auditLog.create({
      data: {
        action: 'runbook.execution.interrupted_after_restart',
        userId: null,
        details: JSON.stringify({
          resultId,
          executionId,
          completionReason: 'app_shutdown',
          completedAt,
        }),
      },
    })
  }
}
