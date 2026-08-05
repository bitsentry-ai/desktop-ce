import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import {
  executeHostTool,
  type HostToolContext,
} from '../src/features/agent-runtime'
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from '../src/features/runbooks/desktop-runbook.types'

function makeRunbook(overrides: Partial<RunbookRecord> = {}): RunbookRecord {
  return {
    id: 'rb-sentry',
    title: 'Investigate Sentry',
    description: 'Investigate recent Sentry alerts.',
    revisionNumber: 3,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    actions: [],
    ...overrides,
  }
}

function makeExecution(overrides: Partial<RunbookExecutionRecord> = {}): RunbookExecutionRecord {
  return {
    executionId: '11111111-1111-4111-8111-111111111111',
    runbookId: 'rb-sentry',
    runbookTitle: 'Investigate Sentry',
    status: 'running',
    startedAt: '2026-07-31T00:00:00.000Z',
    source: 'agent',
    steps: [],
    ...overrides,
  }
}

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
    context.gateway.listExecutable = vi.fn().mockResolvedValue([
      makeRunbook({
        actions: [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check service status',
            command: 'systemctl status bitsentry',
            parameters: [{
              id: 'parameter-region',
              key: 'region',
              description: 'Deployment region.',
              defaultValue: 'ap-southeast-1',
            }, {
              id: 'parameter-token',
              key: 'apiToken',
              description: 'API token for the deployment.',
              defaultValue: 'do-not-disclose',
              secure: true,
            }],
          },
          { id: 'step-2', type: 'http', title: 'Check health endpoint', url: 'https://example.test/health', method: 'GET' },
        ],
      }),
    ])

    const result = await executeHostTool(context, 'list_runbooks', {})

    expect(context.gateway.listExecutable).toHaveBeenCalledOnce()
    expect(JSON.parse(result?.output ?? '')).toMatchObject({
      runbooks: [{
        id: 'rb-sentry',
        actionCount: 2,
        actionTypes: ['shell', 'http'],
        actions: [
          { id: 'step-1', type: 'shell', title: 'Check service status' },
          { id: 'step-2', type: 'http', title: 'Check health endpoint' },
        ],
        parameters: [{
          key: 'region',
          required: true,
          description: 'Deployment region.',
          defaultValue: 'ap-southeast-1',
        }, {
          key: 'apiToken',
          required: true,
        }],
      }],
    })
    const catalog = JSON.parse(result?.output ?? '') as { runbooks: Array<Record<string, unknown>> }
    expect(catalog.runbooks[0]).not.toHaveProperty('actionParameters')
    const secureParameter = (catalog.runbooks[0]?.parameters as Array<Record<string, unknown>>)
      .find((parameter) => parameter.key === 'apiToken')
    expect(secureParameter).toMatchObject({ key: 'apiToken', required: true })
    expect(secureParameter).not.toHaveProperty('description')
    expect(secureParameter).not.toHaveProperty('defaultValue')
  })

  it('rejects an out-of-range proposal idle timeout with the documented unit', async () => {
    const context = createContext()

    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a status runbook.',
      draftRunbook: {
        title: 'Status check',
        description: '',
        idleTimeout: 3600,
        actions: [{ id: 'step-1', type: 'shell', title: 'Check status', command: 'systemctl status bitsentry' }],
      },
    })

    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'INVALID_TOOL_ARGUMENTS',
      toolName: 'propose_runbook_create',
    })
    expect(result?.error).toContain('minutes')
  })

  it('creates a session-only runbook edit proposal through the host-tool registry', async () => {
    const runbook = makeRunbook({ actions: [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }] })
    const context = createContext()
    context.listAuthorableRunbooks = vi.fn().mockResolvedValue([runbook])
    const result = await executeHostTool(context, 'propose_runbook_edit', {
      runbookId: runbook.id, prompt: 'Add an uptime check.', operations: [{ id: 'op-add-uptime', type: 'add_action', rationale: 'Collect uptime before inspecting logs.', action: { id: 'step-2', type: 'shell', title: 'Collect uptime', command: 'uptime' } }],
    })
    expect(JSON.parse(result?.output ?? '')).toMatchObject({ approvalRequired: true, saved: false, status: 'pending_approval', targetRunbookId: runbook.id })
    expect(context.session.runbookAuthoringProposals).toHaveLength(1)
    expect(context.gateway.start).not.toHaveBeenCalled()
  })

  it('lists candidate ids when an authoring title is ambiguous', async () => {
    const context = createContext()
    context.listAuthorableRunbooks = vi.fn().mockResolvedValue([
      makeRunbook({ id: 'rb-claude', title: 'Update Claude Code & Codex CLIs' }),
      makeRunbook({ id: 'rb-codex', title: 'Update Claude Code & Codex CLIs' }),
    ])

    const result = await executeHostTool(context, 'propose_runbook_edit', {
      runbookTitle: 'Update Claude Code & Codex CLIs',
      prompt: 'Add a verification step.',
      operations: [{
        id: 'op-1',
        type: 'update_metadata',
        rationale: 'Clarify the title.',
        metadata: { description: 'Update both CLIs and verify the versions.' },
      }],
    })

    expect(result?.error).toContain('rb-claude (Update Claude Code & Codex CLIs)')
    expect(result?.error).toContain('rb-codex (Update Claude Code & Codex CLIs)')
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

  it('executes a resolved runbook by title and by id', async () => {
    const runbook = makeRunbook()
    const execution = makeExecution()
    const start = vi.fn().mockResolvedValue({
      executionId: execution.executionId,
      resultId: 'result-1',
      execution,
      deduplicated: false,
    })
    const context = createContext()
    context.gateway.listExecutable = vi.fn().mockResolvedValue([runbook])
    context.gateway.start = start

    const byTitle = await executeHostTool(context, 'execute_runbook', {
      runbookTitle: 'Investigate Sentry',
    })
    const byId = await executeHostTool(context, 'execute_runbook', {
      runbookId: 'rb-sentry',
    })

    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({ runbookId: 'rb-sentry' }))
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({ runbookId: 'rb-sentry' }))
    expect(JSON.parse(byTitle?.output ?? '')).toMatchObject({ executionId: execution.executionId })
    expect(JSON.parse(byId?.output ?? '')).toMatchObject({ executionId: execution.executionId })
  })

  it('guides stale runbook ids to list current runbooks before retrying', async () => {
    const context = createContext()
    const staleId = randomUUID()
    const liveTitle = `Live runbook ${randomUUID()}`
    context.gateway.listExecutable = vi.fn().mockResolvedValue([
      makeRunbook({ id: randomUUID(), title: liveTitle }),
    ])

    const result = await executeHostTool(context, 'execute_runbook', { runbookId: staleId })

    expect(result?.error).toContain('may be stale')
    expect(result?.error).toContain('Call list_runbooks, then retry execute_runbook with a current id.')
  })

  it('returns a terminal result after the bounded completion wait', async () => {
    const execution = makeExecution()
    const completedExecution = makeExecution({
      status: 'completed',
      completedAt: '2026-07-31T00:00:30.000Z',
    })
    const context = createContext()
    context.session.latestRunbookExecutionId = execution.executionId
    context.gateway.get = vi.fn().mockResolvedValue(execution)
    context.gateway.waitForCompletion = vi.fn().mockResolvedValue(completedExecution)

    const result = await executeHostTool(context, 'get_runbook_execution', {
      waitForCompletion: true,
    })

    expect(context.gateway.waitForCompletion).toHaveBeenCalledWith(execution.executionId, {
      timeoutMs: 30_000,
    })
    expect(JSON.parse(result?.output ?? '')).toMatchObject({
      executionId: execution.executionId,
      status: 'completed',
    })
    expect(result?.output).not.toContain('stillRunning')
  })

  it('returns the latest running snapshot when the completion wait times out', async () => {
    const execution = makeExecution()
    const context = createContext()
    context.session.latestRunbookExecutionId = execution.executionId
    context.gateway.get = vi.fn().mockResolvedValue(execution)
    context.gateway.waitForCompletion = vi.fn().mockResolvedValue(execution)

    const result = await executeHostTool(context, 'get_runbook_execution', {
      waitForCompletion: true,
    })

    expect(JSON.parse(result?.output ?? '')).toMatchObject({
      executionId: execution.executionId,
      status: 'running',
      stillRunning: true,
      waitedSeconds: 30,
    })
  })

  it('blocks only repeated non-wait lookups of a terminal execution', async () => {
    const execution = makeExecution({
      status: 'completed',
      completedAt: '2026-07-31T00:00:30.000Z',
    })
    const context = createContext()
    context.session.latestRunbookExecutionId = execution.executionId
    context.gateway.get = vi.fn().mockResolvedValue(execution)

    const first = await executeHostTool(context, 'get_runbook_execution', {})
    const repeated = await executeHostTool(context, 'get_runbook_execution', {})

    expect(first?.output).toContain(execution.executionId)
    expect(JSON.parse(repeated?.error ?? '')).toMatchObject({
      code: 'REPEATED_RUNBOOK_EXECUTION_LOOKUP',
      executionId: execution.executionId,
    })
    expect(repeated?.error).toContain('waitForCompletion: true')

    const runningExecution = makeExecution()
    const runningContext = createContext()
    runningContext.session.latestRunbookExecutionId = runningExecution.executionId
    runningContext.gateway.get = vi.fn().mockResolvedValue(runningExecution)
    runningContext.gateway.waitForCompletion = vi.fn().mockResolvedValue(runningExecution)

    await executeHostTool(runningContext, 'get_runbook_execution', { waitForCompletion: true })
    const firstLookupAfterTimeout = await executeHostTool(runningContext, 'get_runbook_execution', {})
    const secondWait = await executeHostTool(runningContext, 'get_runbook_execution', { waitForCompletion: true })

    expect(firstLookupAfterTimeout?.error).toBeUndefined()
    expect(secondWait?.error).toBeUndefined()
  })
})
