import { describe, expect, it } from 'vitest'

import {
  SqliteRunbookResultStore,
  type DesktopRunbookResultDatabase,
} from '../src/features/runbooks/desktop-runbook-result.store'
import type { RunbookExecutionRecord } from '../src/features/runbooks/desktop-runbook.types'

function snapshot(executionId: string, snapshotVersion: number): RunbookExecutionRecord {
  return {
    executionId,
    runbookId: 'runbook-1',
    runbookRevisionNumber: 1,
    runbookTitle: 'Runbook',
    status: 'running',
    startedAt: '2026-07-30T00:00:00.000Z',
    source: 'manual',
    snapshotVersion,
    steps: [],
  }
}

describe('SqliteRunbookResultStore', () => {
  it('persists concurrent execution snapshots without overlapping SQLite transactions', async () => {
    const snapshots = new Map<string, RunbookExecutionRecord>([
      ['result-a', snapshot('execution-a', 0)],
      ['result-b', snapshot('execution-b', 0)],
    ])
    const rows = new Map<string, Record<string, unknown>>(
      [...snapshots.entries()].map(([id, execution]) => [
        id,
        {
          id,
          status: execution.status,
          startedAt: execution.startedAt,
          completedAt: null,
          updatedAt: execution.startedAt,
          executionSnapshotJson: JSON.stringify(execution),
        },
      ]),
    )
    let transactionActive = false
    const database: DesktopRunbookResultDatabase = {
      investigationSession: {
        create: async () => ({}),
        update: async ({ where, data }) => {
          const row = rows.get(where.id)
          if (row !== undefined) {
            Object.assign(row, data)
          }
          return {}
        },
        updateMany: async ({ where, data }) => {
          const id = String(where?.id)
          const row = rows.get(id)
          if (row === undefined) return { count: 0 }

          const directStatus = where?.status
          const allowedStatuses = Array.isArray(where?.OR)
            ? where.OR
              .filter((condition): condition is Record<string, unknown> =>
                typeof condition === 'object' && condition !== null,
              )
              .map((condition) => condition.status)
            : []
          const statusMatches =
            directStatus === undefined
              ? allowedStatuses.length === 0 || allowedStatuses.includes(row.status)
              : row.status === directStatus
          if (!statusMatches) return { count: 0 }

          Object.assign(row, data)
          const execution = JSON.parse(String(row.executionSnapshotJson)) as RunbookExecutionRecord
          snapshots.set(id, execution)
          return { count: 1 }
        },
        findUnique: async ({ where }) => {
          return rows.get(String(where.id)) ?? null
        },
        findFirst: async () => null,
        findMany: async () => [],
      },
      $executeRawUnsafe: async () => {},
      $queryRawUnsafe: async () => [],
      $transaction: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (transactionActive) {
          throw new Error('cannot start a transaction within a transaction')
        }
        transactionActive = true
        try {
          return await operation()
        } finally {
          transactionActive = false
        }
      },
    }
    const store = new SqliteRunbookResultStore(database)

    await expect(Promise.all([
      store.applyExecutionSnapshotEvent('result-a', {
        eventId: 'event-a',
        expectedSnapshotVersion: 0,
        snapshot: snapshot('execution-a', 1),
      }),
      store.applyExecutionSnapshotEvent('result-b', {
        eventId: 'event-b',
        expectedSnapshotVersion: 0,
        snapshot: snapshot('execution-b', 1),
      }),
    ])).resolves.toEqual(['accepted', 'accepted'])

    expect(snapshots.get('result-a')?.snapshotVersion).toBe(1)
    expect(snapshots.get('result-b')?.snapshotVersion).toBe(1)
  })
})
