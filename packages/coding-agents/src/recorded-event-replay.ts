export type RecordedProviderName = 'codex' | 'cursor' | 'claude_code' | 'opencode'
export type RecordedProviderTerminalStatus = 'completed' | 'failed' | 'cancelled'

export interface RecordedProviderEvent {
  provider: RecordedProviderName
  sequence: number
  type: 'delta' | 'permission' | 'terminal'
  text?: string
  permission?: 'granted' | 'rejected'
  status?: RecordedProviderTerminalStatus
}

export interface RecordedProviderReplay {
  deltas: string[]
  permissions: Array<'granted' | 'rejected'>
  terminalStatus: RecordedProviderTerminalStatus | null
  ignoredAfterTerminal: number
}

function isProvider(value: unknown): value is RecordedProviderName {
  return value === 'codex' || value === 'cursor' || value === 'claude_code' || value === 'opencode'
}

function isTerminalStatus(value: unknown): value is RecordedProviderTerminalStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

function parseEvent(value: unknown, lineNumber: number): RecordedProviderEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Recorded provider event line ${lineNumber} must be an object`)
  }

  const event = value as Record<string, unknown>
  if (!isProvider(event.provider)) {
    throw new Error(`Recorded provider event line ${lineNumber} has an unsupported provider`)
  }
  if (
    typeof event.sequence !== 'number' ||
    !Number.isInteger(event.sequence) ||
    event.sequence < 0
  ) {
    throw new Error(`Recorded provider event line ${lineNumber} has an invalid sequence`)
  }
  if (event.type !== 'delta' && event.type !== 'permission' && event.type !== 'terminal') {
    throw new Error(`Recorded provider event line ${lineNumber} has an invalid type`)
  }
  if (event.type === 'delta' && typeof event.text !== 'string') {
    throw new Error(`Recorded provider event line ${lineNumber} is missing delta text`)
  }
  if (event.type === 'permission' && event.permission !== 'granted' && event.permission !== 'rejected') {
    throw new Error(`Recorded provider event line ${lineNumber} has an invalid permission result`)
  }
  if (event.type === 'terminal' && !isTerminalStatus(event.status)) {
    throw new Error(`Recorded provider event line ${lineNumber} has an invalid terminal status`)
  }

  return {
    provider: event.provider,
    sequence: event.sequence,
    type: event.type,
    text: typeof event.text === 'string' ? event.text : undefined,
    permission:
      event.permission === 'granted' || event.permission === 'rejected'
        ? event.permission
        : undefined,
    status: isTerminalStatus(event.status) ? event.status : undefined,
  }
}

export function parseRecordedProviderEvents(jsonl: string): RecordedProviderEvent[] {
  const events: RecordedProviderEvent[] = []
  const lines = jsonl.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (line === undefined || line.length === 0) continue

    try {
      events.push(parseEvent(JSON.parse(line), index + 1))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Recorded provider event')) {
        throw error
      }
      throw new Error(`Recorded provider event line ${index + 1} is not valid JSON`)
    }
  }
  return events
}

export function replayRecordedProviderEvents(
  events: readonly RecordedProviderEvent[],
): RecordedProviderReplay {
  let lastSequence = -1
  let terminalStatus: RecordedProviderTerminalStatus | null = null
  const deltas: string[] = []
  const permissions: Array<'granted' | 'rejected'> = []
  let ignoredAfterTerminal = 0

  for (const event of events) {
    if (event.sequence <= lastSequence) {
      throw new Error('Recorded provider events must have strictly increasing sequence numbers')
    }
    lastSequence = event.sequence

    if (terminalStatus !== null) {
      ignoredAfterTerminal += 1
      continue
    }
    if (event.type === 'delta') {
      deltas.push(event.text as string)
      continue
    }
    if (event.type === 'permission') {
      permissions.push(event.permission as 'granted' | 'rejected')
      continue
    }
    terminalStatus = event.status as RecordedProviderTerminalStatus
  }

  return { deltas, permissions, terminalStatus, ignoredAfterTerminal }
}
