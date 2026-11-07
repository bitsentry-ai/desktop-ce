import { describe, expect, it, vi } from 'vitest'

import { AgentRuntimeService } from '../main/features/agent-runtime/services/agent-runtime.service'
import type { AgentRuntimeLlmAdapter } from '../main/features/agent-runtime/services/agent-runtime.service'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]
type LlmChatResponse = Awaited<ReturnType<AgentRuntimeLlmAdapter['chatWithTools']>>
type ScriptedResponse = Omit<LlmChatResponse, 'toolProtocol'>

/** An LLM whose calls wait until the test answers them, in order. */
function createScriptedLlm() {
  const calls: Array<{ messages: LlmChatRequest['messages']; respond: (response: ScriptedResponse) => void }> = []
  const adapter = {
    chatWithTools: vi.fn((request: LlmChatRequest) => new Promise<LlmChatResponse>((resolve, reject) => {
      request.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      // The runtime keeps appending to the same array, so keep what this call saw.
      calls.push({
        messages: [...request.messages],
        respond: (response) => { resolve({ toolProtocol: 'native_function_calling', ...response }) },
      })
    })),
  } as unknown as AgentRuntimeLlmAdapter
  return { adapter, calls }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function userTexts(messages: LlmChatRequest['messages']): string[] {
  return messages.flatMap((message) => message.role === 'user' && typeof message.content === 'string' ? [message.content] : [])
}

const DIRECT_API = { providerKey: 'anthropic' as const, model: 'claude-test' }

describe('agent runtime queue and steer', () => {
  it('runs messages queued during a turn one at a time, in order', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'Check disk usage.', llm: DIRECT_API })
    await waitFor(() => llm.calls.length === 1)

    await runtime.send({ sessionId, message: 'Then check memory.', delivery: 'queue' })
    await runtime.send({ sessionId, message: 'Then check load.' })
    expect(runtime.getSnapshot(sessionId).queuedMessages?.map((message) => message.text)).toEqual([
      'Then check memory.',
      'Then check load.',
    ])

    llm.calls[0].respond({ content: 'Disk is at 40%.', toolCalls: [] })
    await waitFor(() => llm.calls.length === 2)
    expect(userTexts(llm.calls[1].messages)).toEqual(['Check disk usage.', 'Then check memory.'])
    expect(runtime.getSnapshot(sessionId).queuedMessages?.map((message) => message.text)).toEqual(['Then check load.'])

    llm.calls[1].respond({ content: 'Memory is fine.', toolCalls: [] })
    await waitFor(() => llm.calls.length === 3)
    expect(userTexts(llm.calls[2].messages)).toEqual(['Check disk usage.', 'Then check memory.', 'Then check load.'])

    llm.calls[2].respond({ content: 'Load is low.', toolCalls: [] })
    await waitFor(() => runtime.getSnapshot(sessionId).threadState === 'COMPLETED')
    expect(runtime.getSnapshot(sessionId).queuedMessages).toEqual([])
  })

  it('steers a direct API turn after the tool results, before its next model call', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'Investigate the 502s.', llm: DIRECT_API })
    await waitFor(() => llm.calls.length === 1)
    expect(runtime.getSnapshot(sessionId).canSteer).toBe(true)

    await runtime.send({ sessionId, message: 'Focus on nginx only.', delivery: 'steer' })
    expect(runtime.getSnapshot(sessionId).queuedMessages).toEqual([
      expect.objectContaining({ text: 'Focus on nginx only.', steer: true }),
    ])

    llm.calls[0].respond({
      content: 'Listing runbooks first.',
      toolCalls: [{ id: 'tool-1', name: 'list_runbooks', args: {} }],
    })
    await waitFor(() => llm.calls.length === 2)

    const [toolResult, steer] = llm.calls[1].messages.slice(-2)
    expect(toolResult).toMatchObject({ role: 'tool', toolCallId: 'tool-1' })
    expect(steer).toMatchObject({ role: 'user', content: 'Focus on nginx only.' })

    llm.calls[1].respond({ content: 'Only nginx returns 502s.', toolCalls: [] })
    await waitFor(() => runtime.getSnapshot(sessionId).threadState === 'COMPLETED')
    const snapshot = runtime.getSnapshot(sessionId)
    expect(snapshot.queuedMessages).toEqual([])
    expect(snapshot.messages.map((message) => message.kind)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(snapshot.messages[2]).toMatchObject({ kind: 'user', text: 'Focus on nginx only.' })
    expect(snapshot.messages[3]).toMatchObject({ kind: 'agent', finalText: 'Only nginx returns 502s.' })
  })

  it('runs a steer the turn ended before taking as the next follow-up', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'Summarize the incident.', llm: DIRECT_API })
    await waitFor(() => llm.calls.length === 1)

    await runtime.send({ sessionId, message: 'Keep it short.', delivery: 'steer' })
    llm.calls[0].respond({ content: 'Summary.', toolCalls: [] })

    await waitFor(() => llm.calls.length === 2)
    expect(userTexts(llm.calls[1].messages)).toEqual(['Summarize the incident.', 'Keep it short.'])
  })

  it('queues a steer for a coding agent CLI, which cannot take input mid-turn', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'Check the logs.', llm: { providerKey: 'codex', model: 'gpt-test' } })
    await waitFor(() => llm.calls.length === 1)
    expect(runtime.getSnapshot(sessionId).canSteer).toBe(false)

    await runtime.send({ sessionId, message: 'Only the last hour.', delivery: 'steer' })
    expect(runtime.getSnapshot(sessionId).queuedMessages).toEqual([
      expect.objectContaining({ text: 'Only the last hour.', steer: false }),
    ])

    llm.calls[0].respond({ content: 'Logs checked.', toolCalls: [] })
    await waitFor(() => llm.calls.length === 2)
    expect(userTexts(llm.calls[1].messages).at(-1)).toBe('Only the last hour.')
  })

  it('holds the queue after a stop until it is resumed', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'Restart the worker.', llm: DIRECT_API })
    await waitFor(() => llm.calls.length === 1)
    await runtime.send({ sessionId, message: 'Then verify it is healthy.' })

    runtime.cancel(sessionId)
    await waitFor(() => runtime.getSnapshot(sessionId).queueHeld === true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(llm.calls).toHaveLength(1)
    expect(runtime.getSnapshot(sessionId).queuedMessages?.map((message) => message.text)).toEqual(['Then verify it is healthy.'])

    runtime.updateQueue({ sessionId, action: 'resume' })
    await waitFor(() => llm.calls.length === 2)
    expect(userTexts(llm.calls[1].messages).at(-1)).toBe('Then verify it is healthy.')
    expect(runtime.getSnapshot(sessionId).queueHeld).toBe(false)
  })

  it('runs a message sent after a stop once the stopped turn winds down', async () => {
    let releaseFirstCall: (() => void) | undefined
    const calls: LlmChatRequest['messages'][] = []
    const adapter = {
      chatWithTools: vi.fn((request: LlmChatRequest) => {
        calls.push([...request.messages])
        if (calls.length === 1) {
          // A provider that only notices the stop a moment later.
          return new Promise<LlmChatResponse>((_resolve, reject) => {
            releaseFirstCall = () => { reject(new Error('aborted')) }
          })
        }
        return Promise.resolve<LlmChatResponse>({ content: 'Done.', toolCalls: [], toolProtocol: 'native_function_calling' })
      }),
    } as unknown as AgentRuntimeLlmAdapter
    const runtime = new AgentRuntimeService(() => null, adapter)
    const sessionId = await runtime.start({ prompt: 'Rotate the logs.', llm: DIRECT_API })
    await waitFor(() => calls.length === 1)
    await runtime.send({ sessionId, message: 'Queued before the stop.' })

    runtime.cancel(sessionId)
    await runtime.send({ sessionId, message: 'Sent after the stop.' })

    releaseFirstCall?.()
    await waitFor(() => calls.length === 2)
    expect(userTexts(calls[1]).at(-1)).toBe('Sent after the stop.')
    expect(runtime.getSnapshot(sessionId).queuedMessages?.map((message) => message.text)).toEqual(['Queued before the stop.'])
    expect(runtime.getSnapshot(sessionId).queueHeld).toBe(true)
  })

  it('edits, reorders and removes queued messages before they run', async () => {
    const llm = createScriptedLlm()
    const runtime = new AgentRuntimeService(() => null, llm.adapter)
    const sessionId = await runtime.start({ prompt: 'First.', llm: DIRECT_API })
    await waitFor(() => llm.calls.length === 1)
    await runtime.send({ sessionId, message: 'Second.' })
    await runtime.send({ sessionId, message: 'Third.' })
    await runtime.send({ sessionId, message: 'Fourth.' })
    const [second, third, fourth] = runtime.getSnapshot(sessionId).queuedMessages ?? []

    runtime.updateQueue({ sessionId, action: 'edit', messageId: second.id, message: 'Second, edited.' })
    runtime.updateQueue({ sessionId, action: 'reorder', messageId: fourth.id, beforeMessageId: second.id })
    runtime.updateQueue({ sessionId, action: 'remove', messageId: third.id })
    expect(runtime.getSnapshot(sessionId).queuedMessages?.map((message) => message.text)).toEqual(['Fourth.', 'Second, edited.'])

    llm.calls[0].respond({ content: 'One.', toolCalls: [] })
    await waitFor(() => llm.calls.length === 2)
    expect(userTexts(llm.calls[1].messages).at(-1)).toBe('Fourth.')
    llm.calls[1].respond({ content: 'Four.', toolCalls: [] })
    await waitFor(() => llm.calls.length === 3)
    expect(userTexts(llm.calls[2].messages).at(-1)).toBe('Second, edited.')

    expect(() => { runtime.updateQueue({ sessionId, action: 'remove', messageId: third.id }) }).toThrow(/QUEUED_MESSAGE_NOT_FOUND/)
  })
})
