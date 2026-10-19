import { describe, expect, it, vi } from 'vitest'

import { AgentRuntimeService } from '../main/features/agent-runtime/services/agent-runtime.service'
import type { AgentRuntimeLlmAdapter } from '../main/features/agent-runtime/services/agent-runtime.service'
import { joinCitations } from '@bitsentry-ce/components/chat/citations'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]

describe('agent runtime citations', () => {
  it('sends the model the quoted text while the thread keeps the citation', async () => {
    const requests: LlmChatRequest['messages'][] = []
    const adapter = {
      chatWithTools: vi.fn(async (request: LlmChatRequest) => {
        requests.push([...request.messages])
        return { content: 'Yes, raise it to auto.', toolCalls: [], toolProtocol: 'native_function_calling' as const }
      }),
    } as unknown as AgentRuntimeLlmAdapter
    const runtime = new AgentRuntimeService(() => null, adapter)
    const message = joinCitations([{
      threadId: 'incident-1',
      sourceId: 'iteration-1:text',
      text: 'nginx is out of workers',
      start: 11,
      end: 34,
      prefix: 'The cause: ',
      suffix: '.',
    }], 'Should we raise worker_processes?')

    const sessionId = await runtime.start({ prompt: message, llm: { providerKey: 'anthropic', model: 'claude-test' } })
    await vi.waitFor(() => { expect(runtime.getSnapshot(sessionId).threadState).toBe('COMPLETED') })

    const userContent = requests[0].find((entry) => entry.role === 'user')?.content
    expect(userContent).toContain('[quote-1] Should we raise worker_processes?')
    expect(userContent).toContain('"text": "nginx is out of workers"')
    expect(runtime.getSnapshot(sessionId).messages[0]).toMatchObject({ kind: 'user', text: message })
  })
})
