import type { AgentSendInput } from './types'

/** A follow-up kept across app restarts, like T3 Code's queued runs. */
interface StoredQueuedMessage {
  id: string
  input: AgentSendInput
  queuedAt: string
}

export interface StoredAgentQueue {
  held: boolean
  messages: StoredQueuedMessage[]
}

export interface AgentQueuePersistence {
  load(incidentThreadId: string): Promise<StoredAgentQueue | null>
  /** Replaces the incident's stored queue; an empty queue removes it. */
  save(incidentThreadId: string, queue: StoredAgentQueue): Promise<void>
}

interface QueueRow extends Record<string, unknown> {
  id: string
  incidentThreadId: string
  position: number
  inputJson: string
  queuedAt: string
  held: boolean
}

interface QueueDelegate {
  findMany(args: {
    where: { incidentThreadId: string }
    orderBy: { position: 'asc' }
  }): Promise<Array<Record<string, unknown>>>
  deleteMany(args: { where: { incidentThreadId: string } }): Promise<unknown>
  create(args: { data: QueueRow }): Promise<unknown>
}

function parseRow(row: Record<string, unknown>): StoredQueuedMessage | null {
  if (typeof row.id !== 'string' || typeof row.inputJson !== 'string' || typeof row.queuedAt !== 'string') {
    return null
  }
  try {
    const input = JSON.parse(row.inputJson) as AgentSendInput
    return typeof input.message === 'string' && input.message.length > 0
      ? { id: row.id, input, queuedAt: row.queuedAt }
      : null
  } catch {
    return null
  }
}

export class SqliteAgentQueueStore implements AgentQueuePersistence {
  constructor(private readonly db: {
    agentQueuedMessage: QueueDelegate
    $transaction<T>(operation: () => Promise<T>): Promise<T>
  }) {}

  async load(incidentThreadId: string): Promise<StoredAgentQueue | null> {
    const rows = await this.db.agentQueuedMessage.findMany({
      where: { incidentThreadId },
      orderBy: { position: 'asc' },
    })
    const messages = rows.map(parseRow).filter((message): message is StoredQueuedMessage => message !== null)
    if (messages.length === 0) return null
    return { held: rows.some((row) => row.held === true || row.held === 1), messages }
  }

  async save(incidentThreadId: string, queue: StoredAgentQueue): Promise<void> {
    await this.db.$transaction(async () => {
      await this.db.agentQueuedMessage.deleteMany({ where: { incidentThreadId } })
      for (const [position, message] of queue.messages.entries()) {
        // A session id belongs to one app run, and a delivery only to the turn it was sent during.
        const input: AgentSendInput = { ...message.input }
        delete input.sessionId
        delete input.delivery
        await this.db.agentQueuedMessage.create({
          data: {
            id: message.id,
            incidentThreadId,
            position,
            inputJson: JSON.stringify(input),
            queuedAt: message.queuedAt,
            held: queue.held,
          },
        })
      }
    })
  }
}
