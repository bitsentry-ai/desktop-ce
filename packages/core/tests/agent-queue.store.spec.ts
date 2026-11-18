import { describe, expect, it } from 'vitest'
import { SqliteAgentQueueStore } from '../src/features/agent-runtime/agent-queue.store'

function createDelegate() {
  let rows: Array<Record<string, unknown>> = []
  return {
    get rows() { return rows },
    db: {
      agentQueuedMessage: {
        findMany: ({ where }: { where: { incidentThreadId: string } }) => Promise.resolve(
          rows.filter((row) => row.incidentThreadId === where.incidentThreadId)
            .sort((left, right) => Number(left.position) - Number(right.position)),
        ),
        deleteMany: ({ where }: { where: { incidentThreadId: string } }) => {
          rows = rows.filter((row) => row.incidentThreadId !== where.incidentThreadId)
          return Promise.resolve({ count: 0 })
        },
        create: ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data)
          return Promise.resolve(data)
        },
      },
      $transaction: <T>(operation: () => Promise<T>) => operation(),
    },
  }
}

describe('SqliteAgentQueueStore', () => {
  it('stores an incident queue in order without its session, and removes it when empty', async () => {
    const delegate = createDelegate()
    const store = new SqliteAgentQueueStore(delegate.db)

    await store.save('incident-1', {
      held: true,
      messages: [
        { id: 'a', input: { message: 'First.', sessionId: 'old-session', delivery: 'queue' }, queuedAt: '2026-10-19T10:00:00.000Z' },
        { id: 'b', input: { message: 'Second.' }, queuedAt: '2026-10-19T10:00:01.000Z' },
      ],
    })

    expect(await store.load('incident-1')).toEqual({
      held: true,
      messages: [
        { id: 'a', input: { message: 'First.' }, queuedAt: '2026-10-19T10:00:00.000Z' },
        { id: 'b', input: { message: 'Second.' }, queuedAt: '2026-10-19T10:00:01.000Z' },
      ],
    })

    await store.save('incident-1', { held: false, messages: [] })
    expect(await store.load('incident-1')).toBeNull()
  })
})
