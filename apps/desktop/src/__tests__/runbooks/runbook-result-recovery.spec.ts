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
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [
      {
        id: 'result-1',
        executionId: 'execution-1',
        status: 'running',
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
    expect(db.control?.completedAt).toBeDefined()
    expect(db.auditEntries).toHaveLength(1)
    expect(db.auditEntries[0]).toMatchObject({
      action: 'runbook.execution.interrupted_after_restart',
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
})
