import { describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeLlmAdapter,
} from '../main/features/agent-runtime/services/agent-runtime.service'

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 2_000
  while (Date.now() < timeoutAt) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for agent runtime')
}

const persistedThread = [
  { kind: 'user', text: 'Why is api-1 returning 502?' },
  {
    kind: 'agent',
    iterations: [{ id: 'it-1', startedAt: '2026-10-01T10:00:00.000Z', text: 'Disk is full', toolCallIds: [], status: 'done' }],
    activeIterationId: null,
    toolCalls: [],
    finalText: 'Disk is full on /var',
    status: 'done',
    customerReport: { title: 'Disk usage' },
  },
  { kind: 'user', text: 'Which directory?' },
  {
    kind: 'agent',
    iterations: [{ id: 'it-2', startedAt: '2026-10-01T10:01:00.000Z', text: 'Checking', toolCallIds: ['tool-1'], status: 'streaming' }],
    activeIterationId: 'it-2',
    toolCalls: [{ toolCallId: 'tool-1', toolName: 'execute_shell_command', state: 'running' }],
    finalText: null,
    status: 'streaming',
  },
]

describe('AgentRuntimeService incident restore', () => {
  it('continues a persisted incident thread when its live session is gone', async () => {
    const adapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: 'Check /var/log', toolCalls: [] }),
    }
    const service = new AgentRuntimeService(
      () => null, adapter, undefined, undefined, undefined, undefined, undefined, undefined,
      async (incidentThreadId) => incidentThreadId === 'thread-1' ? persistedThread : [],
    )

    const sessionId = await service.send({ sessionId: 'session-before-restart', incidentThreadId: 'thread-1', message: 'What next?' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(sessionId).toBe('session-before-restart')
    const messages = service.getSnapshot(sessionId).messages
    expect(messages.slice(0, 3)).toEqual(persistedThread.slice(0, 3))
    expect(messages[3]).toMatchObject({
      status: 'cancelled',
      activeIterationId: null,
      iterations: [{ status: 'error' }],
      toolCalls: [{ state: 'failed' }],
    })
    expect(messages.slice(4)).toMatchObject([
      { kind: 'user', text: 'What next?' },
      { kind: 'agent', status: 'done', finalText: 'Check /var/log' },
    ])
    // The adapter receives the live history array, which later gains the reply.
    const llmMessages = vi.mocked(adapter.chatWithTools).mock.calls[0]?.[0].messages ?? []
    expect(llmMessages.filter(({ role }) => role !== 'system').slice(0, 5)).toEqual([
      { role: 'user', content: 'Why is api-1 returning 502?' },
      { role: 'assistant', content: 'Disk is full on /var' },
      { role: 'user', content: 'Which directory?' },
      { role: 'assistant', content: 'Tool calls in this turn:\n- execute_shell_command() [failed]: Interrupted before the response finished.\n\nChecking' },
      { role: 'user', content: 'What next?' },
    ])
  })

  it('keeps the saved history when the renderer starts a new turn for an incident after a restart', async () => {
    const adapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: 'Rotate the logs', toolCalls: [] }),
    }
    const service = new AgentRuntimeService(
      () => null, adapter, undefined, undefined, undefined, undefined, undefined, undefined,
      async () => persistedThread.slice(0, 2),
    )

    const sessionId = await service.start({ incidentThreadId: 'thread-1', prompt: 'How do I free space?' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(service.getSnapshot(sessionId).messages).toMatchObject([
      persistedThread[0],
      { kind: 'agent', finalText: 'Disk is full on /var' },
      { kind: 'user', text: 'How do I free space?' },
      { kind: 'agent', status: 'done', finalText: 'Rotate the logs' },
    ])
  })
})
