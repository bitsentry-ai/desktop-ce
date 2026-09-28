import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import type { DesktopPluginDescriptor, DesktopPluginRuntimeService } from '@bitsentry-ce/core/features/plugins'
import type { IntegrationConnection } from '@bitsentry-ce/core/features/plugins/integration-connections'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]

const readAction: DesktopPluginDescriptor['actions'][number] = {
  id: 'get_document',
  title: 'Read document',
  description: 'Read a knowledge document',
  riskLevel: 'read',
  fields: [{ key: 'id', label: 'ID', type: 'string', required: true }],
}
const plugin: DesktopPluginDescriptor = {
  id: 'outline',
  name: 'Outline',
  version: '1.0.0',
  type: 'data_source',
  description: 'Knowledge',
  auth: { fields: [] },
  actions: [readAction],
}
const connection: IntegrationConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Knowledge',
  pluginId: 'outline',
  enabled: true,
  target: 'https://outline.example/api',
  authMode: 'token',
  availability: 'configured',
  actions: [readAction],
}

function createRuntime(llmAdapter: AgentRuntimeLlmAdapter): AgentRuntimeService {
  const pluginRuntime = {
    listPlugins: async () => [plugin],
    listIntegrationConnections: async () => [connection],
    // A hung plugin: the read never settles and ignores its abort signal.
    executeIntegrationAction: () => new Promise<never>(() => undefined),
  } as unknown as DesktopPluginRuntimeService

  return new AgentRuntimeService(
    () => null,
    llmAdapter,
    { listExecutable: async () => [] } as unknown as AgentRuntimeRunbookGateway,
    undefined,
    undefined,
    undefined,
    pluginRuntime,
  )
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(1_000)
  }
  throw new Error('Timed out waiting for agent runtime')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('direct integration reads', () => {
  it('ends a read that never completes with a timeout error and finishes the turn', async () => {
    vi.useFakeTimers()
    const llmAdapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValueOnce({
        content: 'Reading the failover document.',
        toolCalls: [{
          id: 'call-read',
          name: 'read_integration',
          args: { connectionId: connection.id, actionId: 'get_document', input: { id: 'doc-1' } },
        }],
      }).mockResolvedValueOnce({ content: 'The knowledge base did not respond.', toolCalls: [] }),
    }
    const service = createRuntime(llmAdapter)

    const sessionId = await service.start({
      prompt: 'Find the database failover document',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await advanceUntil(() => service.getStatus(sessionId).state === 'COMPLETED')

    const followUp = vi.mocked(llmAdapter.chatWithTools).mock.calls[1]?.[0] as LlmChatRequest | undefined
    const toolMessage = followUp?.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('INTEGRATION_READ_TIMEOUT')
    expect(toolMessage?.content).toContain('No write was attempted')
  })
})
