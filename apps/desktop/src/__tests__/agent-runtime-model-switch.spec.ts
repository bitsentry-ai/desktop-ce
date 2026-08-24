import { describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeEventPayload,
  type AgentRuntimeLlmAdapter,
} from '../main/features/agent-runtime/services/agent-runtime.service'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 2_000
  while (Date.now() < timeoutAt) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for agent runtime')
}

function createRuntime(
  llmAdapter: AgentRuntimeLlmAdapter,
  sentEvents?: AgentRuntimeEventPayload[],
): AgentRuntimeService {
  return new AgentRuntimeService(
    () => sentEvents === undefined ? null : {
      isDestroyed: () => false,
      webContents: {
        send: (_channel, payload) => { sentEvents.push(payload) },
      },
    },
    llmAdapter,
  )
}

function getLlmRequest(adapter: AgentRuntimeLlmAdapter, callIndex: number): LlmChatRequest {
  const request = vi.mocked(adapter.chatWithTools).mock.calls[callIndex]?.[0]
  if (request === undefined) throw new Error(`Missing LLM request ${String(callIndex + 1)}`)
  return request
}

describe('AgentRuntimeService model switching', () => {
  it('uses the new same-provider model on the second turn', async () => {
    const adapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: 'done', toolCalls: [] }),
    }
    const service = createRuntime(adapter)

    const sessionId = await service.start({
      prompt: 'Turn one',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    await service.send({
      sessionId,
      message: 'Turn two',
      llm: { providerKey: 'anthropic', model: 'model-b' },
    })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(getLlmRequest(adapter, 0).llm).toEqual({ providerKey: 'anthropic', model: 'model-a' })
    expect(getLlmRequest(adapter, 1).llm).toEqual({ providerKey: 'anthropic', model: 'model-b' })
  })

  it('reports the model that served the second turn in final metadata', async () => {
    const adapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: 'done', toolCalls: [] }),
    }
    const events: AgentRuntimeEventPayload[] = []
    const service = createRuntime(adapter, events)

    const sessionId = await service.start({
      prompt: 'Turn one',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    await service.send({
      sessionId,
      message: 'Turn two',
      llm: { providerKey: 'anthropic', model: 'model-b' },
    })
    await waitForCondition(() => events.filter(({ event }) => event.type === 'final').length === 2)

    const finalEvents = events.filter(({ event }) => event.type === 'final')
    expect(finalEvents[1]?.event).toMatchObject({
      type: 'final',
      llm: { providerKey: 'anthropic', model: 'model-b' },
    })
  })
})
