import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeService, type AgentRuntimeLlmAdapter } from './agent-runtime.service'

describe('completed incident sessions', () => {
  it('restores an evicted conversation from its saved history on a later send', async () => {
    const stored = new Map<string, Array<Record<string, unknown>>>()
    const adapter: AgentRuntimeLlmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: 'Saved answer', toolCalls: [] }),
    }
    const service = new AgentRuntimeService(
      () => null, adapter, undefined, undefined, undefined, undefined, undefined, undefined,
      async (id) => stored.get(id) ?? [],
      async (id, messages) => { stored.set(id, structuredClone(messages)) },
    )
    try {
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const thread = `thread-${String(index)}`
        const id = await service.start({ incidentThreadId: thread, prompt: `Question ${String(index)}` })
        ids.push(id)
        await vi.waitFor(() => {
          expect(service.getStatus(id).state).toBe('COMPLETED')
          expect(stored.get(thread)?.at(-1)).toMatchObject({ status: 'done' })
        })
      }
      expect(() => service.getSnapshot(ids[0])).toThrow('Session not found')
      expect(service.getSnapshot(ids[4]).messages).toHaveLength(2)
      const restored = await service.send({ sessionId: ids[0], incidentThreadId: 'thread-0', message: 'Follow up' })
      await vi.waitFor(() => { expect(service.getStatus(restored).state).toBe('COMPLETED') })
      expect(service.getSnapshot(restored).messages).toMatchObject([
        { kind: 'user', text: 'Question 0' },
        { kind: 'agent', finalText: 'Saved answer' },
        { kind: 'user', text: 'Follow up' },
        { kind: 'agent', finalText: 'Saved answer' },
      ])
    } finally {
      await service.destroy()
    }
  })
})
