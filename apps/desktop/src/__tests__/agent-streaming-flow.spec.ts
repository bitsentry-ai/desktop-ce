import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeEventPayload,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import { createAgentThreadSnapshot, reduceAgentThreadSnapshot } from '@bitsentry-ce/components/chat/runtimeProjection'
import type { ChatMessage } from '@bitsentry-ce/components/chat/types'
import type { AgentEventData } from '@bitsentry-ce/core/features/agent-runtime/types'

const timestamp = '2026-10-19T10:00:00.000Z'

function historyMessages(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { id: `m-${String(index)}`, kind: 'user', text: `Question ${String(index)} `.padEnd(400, 'q') }
    : {
        id: `m-${String(index)}`,
        kind: 'agent',
        iterations: [{ id: `it-${String(index)}`, startedAt: timestamp, text: 'a'.repeat(400), toolCallIds: [], status: 'done' }],
        activeIterationId: null,
        toolCalls: [{ toolCallId: `tool-${String(index)}`, toolName: 'execute_shell_command', state: 'done', output: 'o'.repeat(400) }],
        finalText: 'a'.repeat(400),
        status: 'done',
      })
}

/** A restored session whose model call streams `deltaCount` text deltas, then hangs until abort. */
async function startStreamingSession(historyLength: number, deltaCount = 0) {
  const sent: AgentRuntimeEventPayload[] = []
  const streamText = (text: string) => { onDelta?.({ type: 'text', text }) }
  let onDelta: ((delta: { type: 'text'; text: string }) => void) | undefined
  const service = new AgentRuntimeService(
    () => ({ isDestroyed: () => false, webContents: { send: (_channel, payload) => { sent.push(payload) } } }),
    {
      chatWithTools: (input) => {
        onDelta = input.onDelta
        for (let index = 0; index < deltaCount; index += 1) streamText('x')
        return new Promise((_resolve, reject) => { input.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      },
    },
    undefined, undefined, undefined, undefined, undefined, undefined,
    () => Promise.resolve(historyMessages(historyLength)),
  )
  const sessionId = await service.send({ sessionId: 'session-1', incidentThreadId: 'thread-1', message: 'Go on' })
  await vi.advanceTimersByTimeAsync(100)
  const emit = (event: AgentEventData) => {
    (service as unknown as { sendEvent(id: string, data: AgentEventData): void }).sendEvent(sessionId, event)
  }
  return { service, sent, emit, streamText }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agent streaming data flow', () => {
  it('reduces deltas without touching earlier messages or keeping per-token records', () => {
    const turn = createAgentThreadSnapshot({ sessionId: 's', startedAt: timestamp, runtimeState: 'RUNNING', prompt: 'p' })
    let snapshot = { ...turn, messages: [...(historyMessages(28) as unknown as ChatMessage[]), ...turn.messages] }
    expect(snapshot.messages).toHaveLength(30)
    const original = snapshot.messages

    const chunks = Array.from({ length: 100 }, (_, index) => `t${String(index)} `)
    for (const chunk of chunks) snapshot = reduceAgentThreadSnapshot(snapshot, { type: 'assistant_delta', timestamp, delta: chunk })

    original.slice(0, -1).forEach((message, index) => { expect(snapshot.messages[index]).toBe(message) })
    const last = snapshot.messages.at(-1)
    if (last?.kind !== 'agent') throw new Error('Expected an agent message')
    expect(last.iterations.map((iteration) => iteration.text).join('')).toBe(chunks.join(''))
    expect(last.iterations.every((iteration) => !('streamDeltas' in iteration))).toBe(true)
  })

  it('returns the same snapshot for an activity event with the current phase', () => {
    const created = createAgentThreadSnapshot({ sessionId: 's', startedAt: timestamp, runtimeState: 'RUNNING', prompt: 'p' })
    const snapshot = reduceAgentThreadSnapshot(created, { type: 'activity', timestamp, phase: 'asking_model' })
    expect(snapshot).not.toBe(created)
    expect(reduceAgentThreadSnapshot(snapshot, { type: 'activity', timestamp, phase: 'asking_model' })).toBe(snapshot)
  })

  it('coalesces streamed deltas, flushes them before structural events and stops after destroy', async () => {
    vi.useFakeTimers()
    const { service, sent, emit, streamText } = await startStreamingSession(2, 100)

    const messageSends = sent.filter((payload) => payload.kind === 'message')
    expect(messageSends.length).toBeGreaterThan(0)
    expect(messageSends.length).toBeLessThanOrEqual(2)

    // No public path drives a tool_start here, so this ordering check uses the private sendEvent.
    sent.length = 0
    streamText('tail')
    emit({ type: 'tool_start', timestamp, toolName: 'execute_shell_command', toolCallId: 'tool-1', input: {} })
    expect(sent.map((payload) => payload.kind)).toEqual(['message', 'snapshot'])
    const flushed = sent[0]
    if (flushed?.kind !== 'message' || flushed.message.kind !== 'agent') throw new Error('Expected a message flush')
    expect(flushed.message.iterations.at(-1)?.text).toBe(`${'x'.repeat(100)}tail`)

    streamText('late')
    const sentBeforeDestroy = sent.length
    await service.destroy()
    await vi.advanceTimersByTimeAsync(200)
    expect(sent.slice(sentBeforeDestroy).filter((payload) => payload.kind === 'message')).toEqual([])
  })

  it('keeps the streaming payload small and independent of history length', async () => {
    vi.useFakeTimers()
    const flushBytes = async (historyLength: number) => {
      const { service, sent } = await startStreamingSession(historyLength, 50)
      const payload = sent.find((item) => item.kind === 'message')
      await service.destroy()
      return Buffer.byteLength(JSON.stringify(payload))
    }

    const small = await flushBytes(20)
    const large = await flushBytes(200)
    expect(large).toBeLessThan(16 * 1024)
    expect(Math.abs(large - small)).toBeLessThan(64)
  })
})
