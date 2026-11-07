import { describe, expect, it, vi } from 'vitest'

import { AgentRuntimeService } from '../main/features/agent-runtime/services/agent-runtime.service'
import type { AgentRuntimeLlmAdapter } from '../main/features/agent-runtime/services/agent-runtime.service'
import type { AgentQueuePersistence, StoredAgentQueue } from '@bitsentry-ce/core/features/agent-runtime'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]
type LlmChatResponse = Awaited<ReturnType<AgentRuntimeLlmAdapter['chatWithTools']>>

const DIRECT_API = { providerKey: 'anthropic' as const, model: 'claude-test' }

function createScriptedLlm() {
  const calls: Array<{ messages: LlmChatRequest['messages']; respond: (content: string) => void }> = []
  const adapter = {
    chatWithTools: vi.fn((request: LlmChatRequest) => new Promise<LlmChatResponse>((resolve) => {
      calls.push({
        messages: [...request.messages],
        respond: (content) => { resolve({ content, toolCalls: [], toolProtocol: 'native_function_calling' }) },
      })
    })),
  } as unknown as AgentRuntimeLlmAdapter
  return { adapter, calls }
}

function createMemoryStore(initial: Record<string, StoredAgentQueue> = {}) {
  const queues = new Map(Object.entries(initial))
  const store: AgentQueuePersistence = {
    load: (incidentThreadId) => Promise.resolve(queues.get(incidentThreadId) ?? null),
    save: (incidentThreadId, queue) => {
      if (queue.messages.length === 0) queues.delete(incidentThreadId)
      else queues.set(incidentThreadId, structuredClone(queue))
      return Promise.resolve()
    },
  }
  return { store, queues }
}

function createRuntime(adapter: AgentRuntimeLlmAdapter, store: AgentQueuePersistence) {
  return new AgentRuntimeService(() => null, adapter, undefined, undefined, undefined, undefined, undefined, undefined, store)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const storedQueue: StoredAgentQueue = {
  held: false,
  messages: [
    { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', input: { message: 'Then check memory.', llm: DIRECT_API, incidentThreadId: 'incident-1' }, queuedAt: '2026-10-19T10:00:00.000Z' },
    { id: '9b2f1c5e-3d4a-4e8b-9f6c-1a2b3c4d5e6f', input: { message: 'Then check load.', llm: DIRECT_API, incidentThreadId: 'incident-1' }, queuedAt: '2026-10-19T10:00:01.000Z' },
  ],
}

describe('agent runtime queue persistence', () => {
  it('saves the queue as it changes and clears it once it drains', async () => {
    const llm = createScriptedLlm()
    const { store, queues } = createMemoryStore()
    const runtime = createRuntime(llm.adapter, store)
    const sessionId = await runtime.start({ prompt: 'Check disk usage.', llm: DIRECT_API, incidentThreadId: 'incident-1' })
    await waitFor(() => llm.calls.length === 1)

    await runtime.send({ sessionId, message: 'Then check memory.' })
    await waitFor(() => queues.get('incident-1')?.messages.length === 1)
    expect(queues.get('incident-1')?.messages[0].input.message).toBe('Then check memory.')

    llm.calls[0].respond('Disk is fine.')
    await waitFor(() => llm.calls.length === 2)
    await waitFor(() => !queues.has('incident-1'))
  })

  it('brings a saved queue back paused after a restart and runs it only on resume', async () => {
    const llm = createScriptedLlm()
    const { store } = createMemoryStore({ 'incident-1': storedQueue })
    const runtime = createRuntime(llm.adapter, store)

    const restored = await runtime.restoreQueue('incident-1')

    expect(restored?.snapshot.queueHeld).toBe(true)
    expect(restored?.snapshot.queuedMessages?.map((message) => message.text)).toEqual(['Then check memory.', 'Then check load.'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(llm.calls).toHaveLength(0)

    runtime.updateQueue({ sessionId: restored!.sessionId, action: 'resume' })
    await waitFor(() => llm.calls.length === 1)
    const userMessages = llm.calls[0].messages.filter((message) => message.role === 'user')
    expect(userMessages.map((message) => message.content)).toEqual(['Then check memory.'])
  })

  it('keeps a saved queue paused when a new message starts the incident again', async () => {
    const llm = createScriptedLlm()
    const { store, queues } = createMemoryStore({ 'incident-1': storedQueue })
    const runtime = createRuntime(llm.adapter, store)

    const sessionId = await runtime.start({ prompt: 'Start over.', llm: DIRECT_API, incidentThreadId: 'incident-1' })
    await waitFor(() => llm.calls.length === 1)
    llm.calls[0].respond('Started over.')
    await waitFor(() => runtime.getSnapshot(sessionId).threadState === 'COMPLETED')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(llm.calls).toHaveLength(1)
    expect(runtime.getSnapshot(sessionId).queueHeld).toBe(true)
    expect(queues.get('incident-1')?.messages).toHaveLength(2)
  })
})
