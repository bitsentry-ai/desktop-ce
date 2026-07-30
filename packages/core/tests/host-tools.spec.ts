import { describe, expect, it, vi } from 'vitest'
import {
  executeHostTool,
  type HostToolContext,
} from '../src/features/agent-runtime'

function createContext(): HostToolContext {
  return {
    gateway: {
      listExecutable: vi.fn(),
      getRunbookContext: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      getLatestForIncidentThread: vi.fn(),
      waitForCompletion: vi.fn(),
      subscribe: vi.fn(),
      cancel: vi.fn(),
    },
    session: { id: 'session-1' },
  }
}

describe('host tools', () => {
  it('returns a structured model-visible error for invalid arguments', async () => {
    const context = createContext()

    const result = await executeHostTool(context, 'execute_runbook', {
      runbookTitle: 42,
    })

    expect(result?.error).toBeDefined()
    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'INVALID_TOOL_ARGUMENTS',
      toolName: 'execute_runbook',
      issues: [{ path: 'runbookTitle' }],
    })
    expect(context.gateway.listExecutable).not.toHaveBeenCalled()
  })

  it('uses the runbook gateway for list requests', async () => {
    const context = createContext()
    context.gateway.listExecutable = vi.fn().mockResolvedValue([])

    const result = await executeHostTool(context, 'list_runbooks', {})

    expect(context.gateway.listExecutable).toHaveBeenCalledOnce()
    expect(JSON.parse(result?.output ?? '')).toEqual({ runbooks: [] })
  })

  it('reports the host execution lifecycle to the caller', async () => {
    const context = createContext()
    context.gateway.listExecutable = vi.fn().mockResolvedValue([])
    const events: Array<{ type: string; toolName: string; result?: unknown }> = []
    context.onToolEvent = (event) => events.push(event)

    await executeHostTool(context, 'list_runbooks', {})

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'started', toolName: 'list_runbooks', args: {} })
    expect(events[1]).toMatchObject({
      type: 'completed',
      toolName: 'list_runbooks',
      result: { output: expect.stringContaining('runbooks') },
    })
    expect(events[1]?.toolName).toBe(events[0]?.toolName)
  })
})
