/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'

import {
  RUNBOOK_EXECUTION_INTERRUPTED_MESSAGE,
  SqliteRunbookResultStore,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook-result.store'
import { createInterruptedExecutionSnapshot } from '@bitsentry-ce/core/features/runbooks/execution'
import type { RunbookExecutionRecord } from '@bitsentry-ce/core/features/runbooks/runbooks.schemas'

const REDACTED_TOKEN = '[secure:api_token]'

function makeRunningSnapshot(): RunbookExecutionRecord {
  return {
    executionId: 'execution-1',
    runbookId: 'runbook-1',
    runbookTitle: 'Inspect production logs',
    status: 'running',
    snapshotVersion: 4,
    startedAt: '2026-07-13T00:00:00.000Z',
    lastActivityAt: '2026-07-13T00:01:00.000Z',
    parameterValues: { api_token: REDACTED_TOKEN },
    source: 'manual',
    steps: [
      {
        actionId: 'step-1',
        order: 0,
        type: 'shell',
        title: 'Read the journal',
        status: 'running',
        startedAt: '2026-07-13T00:01:00.000Z',
        input: { command: `journalctl --token ${REDACTED_TOKEN}` },
      },
    ],
  }
}

function makeCompletedSnapshot(): RunbookExecutionRecord {
  const completedAt = '2026-07-13T00:02:00.000Z'
  return {
    ...makeRunningSnapshot(),
    status: 'completed',
    completedAt,
    completionReason: 'success',
    snapshotVersion: 5,
    steps: [{
      ...makeRunningSnapshot().steps[0],
      status: 'completed',
      completedAt,
      input: { command: 'journalctl --since today' },
      output: 'found 3 entries',
    }],
  }
}

class InMemoryRunbookResultDatabase {
  readonly updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  control: { heartbeatAt?: string | null; cancelRequestedAt?: string | null; completedAt?: string | null } | null = null
  readonly auditEntries: Array<Record<string, unknown>> = []

  readonly auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.auditEntries.push(data)
      return {}
    },
  }

  readonly investigationSession = {
    create: async () => ({}),
    update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      this.updates.push(input)
      return {}
    },
    updateMany: async () => ({ count: 0 }),
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [
      {
        id: 'result-1',
        executionId: 'execution-1',
        status: 'running',
        startedAt: '2026-07-13T00:00:00.000Z',
        executionSnapshotJson: JSON.stringify(makeRunningSnapshot()),
      },
    ],
  }

  async $executeRawUnsafe(query: string): Promise<unknown> {
    if (query.includes('"completedAt" =')) {
      this.control = {
        ...this.control,
        completedAt: '2026-07-13T00:02:00.000Z',
      }
    }
    return 1
  }

  async $queryRawUnsafe<T>(): Promise<T[]> {
    if (this.control === null) {
      return []
    }
    return [this.control as T]
  }
}

class EventJournalDatabase {
  snapshot = makeRunningSnapshot()
  transactionActive = false
  terminalVerificationInsideTransaction = false
  row = {
    id: 'result-1',
    status: this.snapshot.status,
    startedAt: this.snapshot.startedAt,
    completedAt: null as string | null,
    updatedAt: this.snapshot.startedAt,
    executionSnapshotJson: JSON.stringify(this.snapshot),
  }
  readonly journal = new Set<string>()
  readonly updates: Array<Record<string, unknown>> = []
  readonly auditEntries: Array<Record<string, unknown>> = []

  readonly auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.auditEntries.push(data)
      return {}
    },
  }

  readonly investigationSession = {
    create: () => Promise.resolve({}),
    update: ({ data }: { data: Record<string, unknown> }) => {
      this.updates.push(data)
      const saved = JSON.parse(String(data.executionSnapshotJson)) as RunbookExecutionRecord
      this.snapshot = saved
      Object.assign(this.row, data)
      return Promise.resolve({})
    },
    updateMany: ({ data, where }: { data: Record<string, unknown>; where?: Record<string, unknown> }) => {
      if (where?.id !== this.row.id) return Promise.resolve({ count: 0 })
      const directStatus = where.status
      const allowedStatuses = Array.isArray(where.OR)
        ? where.OR
          .filter((condition): condition is Record<string, unknown> =>
            typeof condition === 'object' && condition !== null,
          )
          .map((condition) => condition.status)
        : []
      const statusMatches =
        directStatus === undefined
          ? allowedStatuses.length === 0 || allowedStatuses.includes(this.row.status)
          : this.row.status === directStatus
      if (!statusMatches) return Promise.resolve({ count: 0 })

      Object.assign(this.row, data)
      this.updates.push(data)
      this.snapshot = JSON.parse(String(this.row.executionSnapshotJson)) as RunbookExecutionRecord
      return Promise.resolve({ count: 1 })
    },
    findUnique: () => {
      if (this.row.status !== 'running' && this.transactionActive) {
        this.terminalVerificationInsideTransaction = true
      }
      return Promise.resolve({
        ...this.row,
        startedAt: new Date(this.row.startedAt),
        completedAt:
          this.row.completedAt === null
            ? null
            : new Date(this.row.completedAt),
        updatedAt: new Date(this.row.updatedAt),
      })
    },
    findFirst: () => Promise.resolve(null),
    findMany: () => Promise.resolve([]),
  }

  $executeRawUnsafe(query: string): Promise<unknown> {
    const eventId = query.match(/VALUES \(\s*'[^']+',\s*'([^']+)'/)?.[1]
    if (eventId !== undefined) {
      this.journal.add(eventId)
    }
    return Promise.resolve(null)
  }

  $queryRawUnsafe<T>(query: string): Promise<T[]> {
    const eventId = query.match(/"eventId" = '([^']+)'/)?.[1]
    if (eventId !== undefined && this.journal.has(eventId)) {
      // Generic raw-query fixtures need to emulate the database adapter's cast.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return Promise.resolve([{ eventId } as T])
    }
    return Promise.resolve([])
  }

  async $transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.transactionActive = true
    try {
      return await operation()
    } finally {
      this.transactionActive = false
    }
  }
}

class TerminalSnapshotRecoveryDatabase {
  readonly snapshot = makeCompletedSnapshot()
  readonly originalStartedAt = '2026-07-12T23:59:00.000Z'
  readonly row = {
    id: 'result-terminal',
    executionId: this.snapshot.executionId,
    status: 'running',
    startedAt: this.originalStartedAt,
    completedAt: null as string | null,
    updatedAt: this.snapshot.startedAt,
    executionSnapshotJson: JSON.stringify(this.snapshot),
  }
  readonly updates: Array<Record<string, unknown>> = []

  readonly investigationSession = {
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async ({ data, where }: { data: Record<string, unknown>; where?: Record<string, unknown> }) => {
      if (where?.id !== this.row.id || where.status !== this.row.status) {
        return { count: 0 }
      }
      Object.assign(this.row, data)
      this.updates.push(data)
      return { count: 1 }
    },
    findUnique: async () => ({
      ...this.row,
      startedAt: new Date(this.row.startedAt),
      completedAt:
        this.row.completedAt === null
          ? null
          : new Date(this.row.completedAt),
      updatedAt: new Date(this.row.updatedAt),
    }),
    findFirst: async () => null,
    findMany: async () => this.row.status === 'running' ? [this.row] : [],
  }

  async $executeRawUnsafe(): Promise<unknown> {
    return 0
  }

  async $queryRawUnsafe<T>(): Promise<T[]> {
    return []
  }

  async $transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation()
  }
}

describe('runbook restart recovery', () => {
  it('marks an unowned running snapshot interrupted without replaying its SSH action', async () => {
    const db = new InMemoryRunbookResultDatabase()
    const store = new SqliteRunbookResultStore(db)

    const updated = await store.markStaleRunningSessionsFailed({ heartbeatGraceMs: 0 })

    expect(updated).toBe(1)
    expect(db.updates).toHaveLength(1)
    const savedSnapshot = JSON.parse(
      String(db.updates[0]?.data.executionSnapshotJson),
    ) as RunbookExecutionRecord
    expect(savedSnapshot).toMatchObject({
      status: 'failed',
      completionReason: 'app_shutdown',
      snapshotVersion: 5,
      parameterValues: { api_token: REDACTED_TOKEN },
    })
    expect(savedSnapshot.steps[0]).toMatchObject({
      status: 'failed',
      error: RUNBOOK_EXECUTION_INTERRUPTED_MESSAGE,
    })
    expect(savedSnapshot.steps[0]?.input?.command).toContain(REDACTED_TOKEN)
    expect(db.updates[0]?.data.startedAt).toBe('2026-07-13T00:00:00.000Z')
    expect(db.control?.completedAt).toBeDefined()
    expect(db.auditEntries).toHaveLength(1)
    expect(db.auditEntries[0]).toMatchObject({
      action: 'runbook.execution.interrupted_after_restart',
    })
    expect(JSON.parse(String(db.auditEntries[0]?.details))).toMatchObject({
      recoveredAt: db.updates[0]?.data.completedAt,
    })
    expect(JSON.stringify(db.auditEntries)).not.toContain('journalctl')
  })

  it('leaves a running session alone while its owner heartbeat is still active', async () => {
    const db = new InMemoryRunbookResultDatabase()
    db.control = { heartbeatAt: new Date().toISOString(), completedAt: null }
    const store = new SqliteRunbookResultStore(db)

    const updated = await store.markStaleRunningSessionsFailed({ heartbeatGraceMs: 60_000 })

    expect(updated).toBe(0)
    expect(db.updates).toHaveLength(0)
  })

  it('creates a new terminal snapshot rather than mutating the running snapshot', () => {
    const running = makeRunningSnapshot()
    const interrupted = createInterruptedExecutionSnapshot(running, {
      completedAt: '2026-07-13T00:02:00.000Z',
      errorMessage: RUNBOOK_EXECUTION_INTERRUPTED_MESSAGE,
      includePendingStep: true,
    })

    expect(running.status).toBe('running')
    expect(running.steps[0]?.status).toBe('running')
    expect(interrupted.status).toBe('failed')
    expect(interrupted.snapshotVersion).toBe(5)
  })

  it('reconciles a stale row without recovering an already terminal snapshot', async () => {
    const db = new TerminalSnapshotRecoveryDatabase()
    const store = new SqliteRunbookResultStore(db)

    await expect(
      store.markStaleRunningSessionsFailed({ heartbeatGraceMs: 0 }),
    ).resolves.toBe(0)
    await expect(
      store.markStaleRunningSessionsFailed({ heartbeatGraceMs: 0 }),
    ).resolves.toBe(0)

    expect(db.updates).toHaveLength(1)
    expect(db.row).toMatchObject({
      status: 'completed',
      completedAt: db.snapshot.completedAt,
      startedAt: db.originalStartedAt,
    })
    expect(Date.parse(db.row.updatedAt)).toBeGreaterThan(
      Date.parse(db.snapshot.completedAt ?? ''),
    )
    expect(JSON.parse(db.row.executionSnapshotJson)).toMatchObject({
      status: 'completed',
      completionReason: 'success',
    })
  })

  it('commits a terminal snapshot and journal when persisted dates hydrate as Date values', async () => {
    const db = new EventJournalDatabase()
    const store = new SqliteRunbookResultStore(db)
    const completed = {
      ...makeRunningSnapshot(),
      status: 'completed' as const,
      completedAt: '2026-07-13T00:02:00.000Z',
      completionReason: 'success' as const,
      snapshotVersion: 5,
      steps: [{
        ...makeRunningSnapshot().steps[0],
        status: 'completed' as const,
        completedAt: '2026-07-13T00:02:00.000Z',
        input: { command: 'journalctl --since today' },
        output: 'found 3 entries',
      }],
    }

    await expect(store.applyExecutionSnapshotEvent('result-1', {
      eventId: 'step-1-completed',
      expectedSnapshotVersion: 4,
      snapshot: completed,
    })).resolves.toBe('accepted')
    expect(db.terminalVerificationInsideTransaction).toBe(false)
    await expect(store.applyExecutionSnapshotEvent('result-1', {
      eventId: 'step-1-completed',
      expectedSnapshotVersion: 4,
      snapshot: completed,
    })).resolves.toBe('duplicate')
    await expect(store.applyExecutionSnapshotEvent('result-1', {
      eventId: 'late-step-event',
      expectedSnapshotVersion: 4,
      snapshot: completed,
    })).resolves.toBe('stale')
    await expect(store.applyExecutionSnapshotEvent('result-1', {
      eventId: 'late-terminal-mutation',
      expectedSnapshotVersion: 5,
      snapshot: { ...completed, status: 'failed', snapshotVersion: 6 },
    })).resolves.toBe('stale')
    await expect(store.applyExecutionSnapshotEvent('result-1', {
      eventId: 'late-running-mutation',
      expectedSnapshotVersion: 5,
      snapshot: {
        ...completed,
        status: 'running',
        completedAt: undefined,
        snapshotVersion: 6,
      },
    })).resolves.toBe('stale')

    expect(db.snapshot.status).toBe('completed')
    expect(db.snapshot.snapshotVersion).toBe(5)
    expect(db.row).toMatchObject({
      status: 'completed',
      startedAt: '2026-07-13T00:00:00.000Z',
      completedAt: '2026-07-13T00:02:00.000Z',
    })
    expect(Date.parse(db.row.updatedAt)).toBeGreaterThan(
      Date.parse(completed.completedAt),
    )
    const refreshed = await store.getExecutionSnapshotByResultId('result-1')
    expect(refreshed?.steps[0]).toMatchObject({
      status: 'completed',
      input: { command: 'journalctl --since today' },
      output: 'found 3 entries',
    })
    expect(db.updates).toHaveLength(1)
    expect(db.journal).toContain('step-1-completed')
    expect(db.auditEntries).toHaveLength(1)
    expect(db.auditEntries[0]).toMatchObject({
      action: 'runbook.execution.snapshot_applied',
    })
    expect(JSON.stringify(db.auditEntries)).not.toContain('journalctl')
    expect(JSON.stringify(db.auditEntries)).not.toContain(REDACTED_TOKEN)
  })
})
