import { describe, expect, it, vi } from 'vitest'
import { createDesktopAgentHandlers } from '@bitsentry-ce/coding-agents/agent.handlers'

describe('desktop agent IPC handlers', () => {
  it('keeps generic incident messages free of implicit runbook context', async () => {
    const agentRuntime = {
      start: vi.fn().mockResolvedValue('session-1'),
      send: vi.fn(),
      cancel: vi.fn(),
      destroy: vi.fn(),
      getStatus: vi.fn(),
      getSnapshot: vi.fn(),
      listRunbookAuthoringProposals: vi.fn(),
      approveRunbookAuthoringProposal: vi.fn(),
      rejectRunbookAuthoringProposal: vi.fn(),
      requestRunbookAuthoringRevision: vi.fn(),
    }
    const getRunbookContext = vi.fn()
    const runbookGateway = { getRunbookContext } as never
    const handlers = createDesktopAgentHandlers({ agentRuntime, runbookGateway })

    await expect(handlers['agent:start']({ prompt: 'List the existing runbooks.' })).resolves.toEqual({
      sessionId: 'session-1',
    })

    expect(getRunbookContext).not.toHaveBeenCalled()
    expect(agentRuntime.start).toHaveBeenCalledWith({
      prompt: 'List the existing runbooks.',
    })
  })
})
