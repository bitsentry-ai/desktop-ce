import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'

import {
  AgentRuntimeService,
  summarizeRunbookExecutionForToolOutput,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import type {
  AgentRuntimeEventPayload,
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookGateway,
  AgentRuntimeRunbookStore,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import { createAgentThreadSnapshot, reduceAgentThreadSnapshot } from '@bitsentry-ce/components/chat/runtimeProjection'
import type {
  AgentThreadSnapshot,
  ToolCallCard,
  ChatMessage,
} from '@bitsentry-ce/components/chat/types'
import type {
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
  RunbookParameterValues,
  RunbookRecord,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook-ce.types'
import { executeHostTool } from '@bitsentry-ce/core/features/agent-runtime'
import { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { DesktopRunbookStore } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.store'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]
type MockLlmAdapter = {
  chatWithTools: {
    mock: {
      calls: unknown[][]
    }
  }
}
type RunbookStartOptions = {
  incidentThreadId?: string
  parameterValues?: RunbookParameterValues
  source?: 'manual' | 'agent'
  accessLevel?: 'auto-accept-edits' | 'full-access'
}
type TestRunbookExecutionService = {
  get: AgentRuntimeRunbookGateway['get']
  getLatestForIncidentThread: AgentRuntimeRunbookGateway['getLatestForIncidentThread']
  waitForCompletion: AgentRuntimeRunbookGateway['waitForCompletion']
  start: (runbookId: string, options?: RunbookStartOptions) => Promise<{
    executionId: string
    resultId: string
  }>
}

const sqliteRunbookClients: DbClient[] = []
let supportsDesktopSqlite = true

try {
  const probe = new DbClient({ datasources: { db: { url: ':memory:' } } })
  void probe.$disconnect()
} catch (error) {
  if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(String(error))) {
    throw error
  }
  supportsDesktopSqlite = false
}

const itWithDesktopSqlite = supportsDesktopSqlite ? it : it.skip

async function createSqliteRunbookStore(): Promise<DesktopRunbookStore> {
  const db = new DbClient({ datasources: { db: { url: ':memory:' } } })
  sqliteRunbookClients.push(db)
  await db.$executeRawUnsafe(`
    CREATE TABLE "Runbook" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "idleTimeout" INTEGER,
      "revisionNumber" INTEGER NOT NULL,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL,
      "deletedAt" TEXT
    );
    CREATE TABLE "RunbookAction" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runbookId" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "command" TEXT,
      "prompt" TEXT,
      "llmProviderKey" TEXT,
      "llmModel" TEXT,
      "url" TEXT,
      "method" TEXT,
      "headersJson" TEXT,
      "body" TEXT,
      "query" TEXT,
      "sourceId" TEXT,
      "parametersJson" TEXT,
      "logFilterJson" TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
  `)
  return new DesktopRunbookStore(db as never, {
    list: async () => [],
    create: async () => ({}),
  } as never)
}

function createInMemoryAuthoringStore(options?: { failAfterActionWriteCount?: number }) {
  const rows = new Map<string, { runbook: RunbookRecord; deletedAt: string | null }>()
  let remainingFailures = options?.failAfterActionWriteCount ?? 0
  const store: AgentRuntimeRunbookStore = {
    list: async () => [...rows.values()]
      .filter((row) => row.deletedAt === null)
      .map((row) => row.runbook),
    create: async (payload) => {
      const id = String(payload.id)
      if (rows.has(id)) throw new Error('UNIQUE constraint failed: Runbook.id')
      const runbook = makeRunbook(id, String(payload.title), [])
      runbook.description = String(payload.description ?? '')
      if (typeof payload.idleTimeout === 'number') runbook.idleTimeout = payload.idleTimeout
      rows.set(id, { runbook, deletedAt: null })
      return runbook
    },
    getIncludingDeleted: async (id) => rows.get(id) ?? null,
    updateMeta: async () => null,
    updateActions: async (payload) => {
      const row = rows.get(String(payload.runbookId))
      if (row === undefined) return null
      row.runbook = {
        ...row.runbook,
        actions: (payload.actions as RunbookRecord['actions']).map((action) => ({ ...action })),
      }
      if (remainingFailures > 0) {
        remainingFailures -= 1
        throw new Error('simulated post-write failure')
      }
      return row.runbook
    },
    remove: async () => ({ ok: true }),
    purge: async (payload) => {
      rows.delete(String(payload.id))
      return { ok: true }
    },
  }
  return { store, rows }
}

function makeCreationAuthoringLlmAdapter(title: string, actionId = 'update-claude-code') {
  return {
    chatWithTools: vi.fn()
      .mockResolvedValueOnce({ content: 'I will draft a runbook for review.', toolCalls: [{ id: `call-propose-${title}`, name: 'propose_runbook_create', args: { prompt: `Create ${title}.`, draftRunbook: { title, description: 'Collect status.', actions: [{ id: actionId, type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry' }] } } }] })
      .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
  }
}

async function createPendingRunbookAuthoringProposal(
  runbookStore: AgentRuntimeRunbookStore,
  title: string,
): Promise<{ service: AgentRuntimeService; sessionId: string; proposalId: string }> {
  const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
  const service = createRuntime({
    llmAdapter: makeCreationAuthoringLlmAdapter(title),
    runbookStore: runbookStore as unknown as { list(): Promise<RunbookRecord[]> },
    runbookExecutionService,
  })
  const sessionId = await service.start({ prompt: `Create ${title}.`, incidentThreadId: `incident-${title}` })
  await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
  return {
    service,
    sessionId,
    proposalId: service.listRunbookAuthoringProposals({ sessionId })[0]!.proposalId,
  }
}

afterEach(async () => {
  await Promise.all(sqliteRunbookClients.splice(0).map((client) => client.$disconnect()))
})

async function waitForCondition(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error('Timed out waiting for condition')
}

async function flushPromises(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve()
  }
}

function makeExecution(overrides: Partial<RunbookExecutionRecord> = {}): RunbookExecutionRecord {
  return {
    executionId: '11111111-1111-4111-8111-111111111111',
    runbookId: 'rb-sentry',
    runbookTitle: "Retrieve errors from Jagad's Sentry",
    status: 'completed',
    startedAt: '2026-05-26T01:00:00.000Z',
    completedAt: '2026-05-26T01:00:20.000Z',
    completionReason: 'success',
    source: 'agent',
    steps: [
      {
        actionId: 'step-1',
        order: 1,
        type: 'external_source',
        title: 'Retrieve errors from Sentry',
        status: 'completed',
        output: 'SERVER-292 last seen at 2026-05-26T00:59:00.000Z',
      },
    ],
    ...overrides,
  }
}

function makeRunbook(id: string, title: string, actions: RunbookRecord['actions']): RunbookRecord {
  return {
    id,
    title,
    description: '',
    revisionNumber: 1,
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    actions,
  }
}

function getLastAgentMessage(snapshot: AgentThreadSnapshot): Extract<ChatMessage, { kind: 'agent' }> {
  const lastMessage = snapshot.messages.at(-1)
  if (lastMessage?.kind !== 'agent') {
    throw new Error('Expected the last message to be an agent message')
  }

  return lastMessage
}

function getLastAgentToolCalls(service: AgentRuntimeService, sessionId: string): ToolCallCard[] {
  return getLastAgentMessage(service.getSnapshot(sessionId)).toolCalls
}

function getAllAgentToolCalls(service: AgentRuntimeService, sessionId: string): ToolCallCard[] {
  return service
    .getSnapshot(sessionId)
    .messages
    .filter((message): message is Extract<ChatMessage, { kind: 'agent' }> => message.kind === 'agent')
    .flatMap((message) => message.toolCalls)
}

function getLlmCallMessages(
  llmAdapter: MockLlmAdapter,
  callIndex: number,
): LlmChatRequest['messages'] {
  const input = llmAdapter.chatWithTools.mock.calls[callIndex]?.[0]
  if (typeof input !== 'object' || input === null || !('messages' in input)) {
    throw new Error(`Expected LLM call ${String(callIndex + 1)} with messages`)
  }

  const messages = input.messages
  if (messages === undefined) {
    throw new Error(`Expected LLM call ${String(callIndex + 1)} with messages`)
  }

  return messages as LlmChatRequest['messages']
}

function getSecondCallMessages(llmAdapter: MockLlmAdapter): LlmChatRequest['messages'] {
  return getLlmCallMessages(llmAdapter, 1)
}

function getRunbookStartCalls(
  start: ReturnType<typeof vi.fn>,
): Array<[string, RunbookStartOptions]> {
  return start.mock.calls as Array<[string, RunbookStartOptions]>
}

function getRequiredToolContent(messages: LlmChatRequest['messages']): string {
  const toolContent = messages.find((message) => message.role === 'tool')?.content
  if (typeof toolContent !== 'string') {
    throw new Error('Expected a tool message with string content')
  }

  return toolContent
}

function getLastToolContent(messages: LlmChatRequest['messages']): string {
  const toolContent = [...messages]
    .reverse()
    .find((message) => message.role === 'tool')?.content
  if (typeof toolContent !== 'string') {
    throw new Error('Expected a tool message with string content')
  }

  return toolContent
}

function getRequiredSystemContent(messages: LlmChatRequest['messages'], text: string): string {
  const systemContent = messages.find((message) => (
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.includes(text)
  ))?.content
  if (typeof systemContent !== 'string') {
    throw new Error(`Expected a system message containing: ${text}`)
  }

  return systemContent
}

function createRuntime(options: {
  llmAdapter: AgentRuntimeLlmAdapter
  runbookStore?: { list(): Promise<RunbookRecord[]> }
  runbookExecutionService?: TestRunbookExecutionService
  sentEvents?: AgentRuntimeEventPayload[]
  onRunbooksChanged?: () => void
}): AgentRuntimeService {
  const windowGetter = () => {
    if (options.sentEvents === undefined) {
      return null
    }

    return {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: AgentRuntimeEventPayload) => {
          options.sentEvents?.push(payload)
        },
      },
    }
  }

  const acceptedRequests = new Map<
    string,
    Promise<{
      executionId: string
      resultId: string
      runbook: { id: string; title: string; revisionNumber: number }
      execution: RunbookExecutionRecord
    }>
  >()
  const runbookGateway =
    options.runbookStore === undefined || options.runbookExecutionService === undefined
      ? undefined
      : {
          ...options.runbookExecutionService,
          listExecutable: async () => {
            const runbooks = await options.runbookStore!.list()
            return runbooks.filter((runbook) => runbook.actions.length > 0)
          },
          getRunbookContext: async () => {
            throw new Error('Runbook context resolution belongs to the IPC handler')
          },
          start: async (request: Parameters<AgentRuntimeRunbookGateway['start']>[0]) => {
            const existing = acceptedRequests.get(request.requestKey)
            const accepted = existing ?? (async () => {
              const started = await options.runbookExecutionService!.start(request.runbookId, {
                incidentThreadId: request.incidentId,
                parameterValues: request.parameterValues,
                source: request.source,
                accessLevel: request.accessLevel,
              })
              const runbook = (await options.runbookStore!.list()).find(
                (item) => item.id === request.runbookId,
              )
              const execution = await options.runbookExecutionService!.get(started.executionId)

              return {
                ...started,
                runbook: {
                  id: request.runbookId,
                  title: runbook?.title ?? request.runbookId,
                  revisionNumber: runbook?.revisionNumber ?? 1,
                },
                execution: execution ?? makeExecution({
                  executionId: started.executionId,
                  runbookId: request.runbookId,
                  runbookTitle: runbook?.title ?? request.runbookId,
                  status: 'running',
                  completedAt: undefined,
                  completionReason: undefined,
                  steps: [],
                }),
              }
            })()
            acceptedRequests.set(request.requestKey, accepted)
            const result = await accepted

            return {
              ...result,
              deduplicated: existing !== undefined,
            }
          },
          subscribe: () => () => undefined,
          cancel: async () => undefined,
        }

  return new AgentRuntimeService(
    windowGetter,
    options.llmAdapter,
    runbookGateway,
    undefined,
    options.runbookStore as AgentRuntimeRunbookStore | undefined,
    options.onRunbooksChanged,
  )
}

describe('summarizeRunbookExecutionForToolOutput', () => {
  it('uses last-seen timestamps instead of first-seen timestamps for journal windows', () => {
    const summary = summarizeRunbookExecutionForToolOutput(
      makeExecution({
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'external_source',
            title: 'Retrieve errors',
            status: 'completed',
            output: [
              'Issue: SERVER-292',
              'First seen / Last seen: 2026-02-25T06:40:00.000Z / 2026-05-26T06:35:39.000Z',
            ].join('\n'),
          },
        ],
      }),
    )

    expect(summary).toMatchObject({
      actionableJournalTimeWindows: [
        {
          issue: 'SERVER-292',
          since: '2026-05-26 06:30:39 UTC',
          until: '2026-05-26 06:40:39 UTC',
        },
      ],
    })
    expect(summary).not.toHaveProperty('derivedJournalTimeWindow')
  })

  it('does not expose a broad aggregate window when issue anchors are far apart', () => {
    const summary = summarizeRunbookExecutionForToolOutput(
      makeExecution({
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'external_source',
            title: 'Retrieve errors',
            status: 'completed',
            output: [
              'Issue: SERVER-292',
              'First seen / Last seen: 2026-02-25T06:40:00.000Z / 2026-05-01T06:35:39.000Z',
              'Issue: SERVER-293',
              'First seen / Last seen: 2026-05-01T06:40:00.000Z / 2026-05-26T06:35:39.000Z',
            ].join('\n'),
          },
        ],
      }),
    )

    expect(summary).not.toHaveProperty('derivedJournalTimeWindow')
    expect(summary).toMatchObject({
      actionableJournalTimeWindowCount: 2,
      actionableJournalTimeWindows: [
        expect.objectContaining({
          issue: 'SERVER-292',
          since: '2026-05-01 06:30:39 UTC',
          until: '2026-05-01 06:40:39 UTC',
        }),
        expect.objectContaining({
          issue: 'SERVER-293',
          since: '2026-05-26 06:30:39 UTC',
          until: '2026-05-26 06:40:39 UTC',
        }),
      ],
    })
  })

  it('exposes one combined journal window for dense multi-issue matrices', () => {
    const summary = summarizeRunbookExecutionForToolOutput(
      makeExecution({
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'llm',
            title: 'Build Sentry matrix',
            status: 'completed',
            output: [
              '| Issue | Last seen | journalctl --since | journalctl --until |',
              '| --- | --- | --- | --- |',
              '| SERVER-287 | 2026-05-30T00:04:11.835Z | 2026-05-29 23:59:11 UTC | 2026-05-30 00:09:11 UTC |',
              '| SERVER-288 | 2026-05-30T00:10:35.000Z | 2026-05-30 00:05:35 UTC | 2026-05-30 00:15:35 UTC |',
              '| SERVER-289 | 2026-05-30T00:30:01.000Z | 2026-05-30 00:25:01 UTC | 2026-05-30 00:35:01 UTC |',
              '| SERVER-290 | 2026-05-30T00:34:21.000Z | 2026-05-30 00:29:21 UTC | 2026-05-30 00:39:21 UTC |',
              '| SERVER-291 | 2026-05-30T00:39:39.000Z | 2026-05-30 00:34:39 UTC | 2026-05-30 00:44:39 UTC |',
              '| SERVER-292 | 2026-05-30T00:40:02.000Z | 2026-05-30 00:35:02 UTC | 2026-05-30 00:45:02 UTC |',
            ].join('\n'),
          },
        ],
      }),
    )

    expect(summary).toMatchObject({
      actionableJournalTimeWindowCount: 6,
      aggregateActionableJournalTimeWindow: {
        since: '2026-05-29 23:59:11 UTC',
        until: '2026-05-30 00:45:02 UTC',
      },
      actionableJournalTimeWindowsTruncated: true,
    })
    expect(summary.actionableJournalTimeWindows).toHaveLength(5)
  })

  it('keeps markdown line structure for visible runbook previews', () => {
    const summary = summarizeRunbookExecutionForToolOutput(
      makeExecution({
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'llm',
            title: 'Summarize logs',
            status: 'completed',
            output: [
              '# Error Matrix Table',
              '',
              '| Issue ID | Project | Root Cause Analysis |',
              '| --- | --- | --- |',
              '| SERVER-292 | Jagad backend server | Transaction polling returned `HTTP 404 Not Found`. |',
            ].join('\n'),
          },
        ],
      }),
    )

    expect(summary.finalOutputExcerpt).toContain('| Issue ID | Project | Root Cause Analysis |')
    expect(summary.finalOutputMarkdownExcerpt).toContain('\n| Issue ID | Project | Root Cause Analysis |')
    expect(summary.finalOutputMarkdownExcerpt).toContain('\n| --- | --- | --- |')
  })

  it('projects the top PostHog issues instead of a raw output prefix', () => {
    const issues = Array.from({ length: 27 }, (_, index) => ({
      id: `issue-${String(index + 1)}`,
      title: `PostHog issue ${String(index + 1)}`,
      status: 'unresolved',
      count: index + 1,
      userCount: 1,
      firstSeen: '2026-07-30T00:00:00.000Z',
      lastSeen: '2026-07-30T01:00:00.000Z',
      level: 'error',
      metadata: { stack: 'x'.repeat(2_700) },
    }))
    const output = `Fetched 27 PostHog issues.\n\n${JSON.stringify({ issues })}`
    expect(output.length).toBeGreaterThan(72_000)

    const summary = summarizeRunbookExecutionForToolOutput(
      makeExecution({
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'plugin',
            title: 'List PostHog exception issues',
            status: 'completed',
            output,
          },
        ],
      }),
    )

    const finalStructuredOutput = summary.finalStructuredOutput as {
      issueCount: number
      issuesTruncated: boolean
      issues: Array<{ title?: string }>
    }
    expect(finalStructuredOutput.issueCount).toBe(27)
    expect(finalStructuredOutput.issuesTruncated).toBe(true)
    expect(finalStructuredOutput.issues).toHaveLength(10)
    expect(finalStructuredOutput.issues[0]).toMatchObject({ title: 'PostHog issue 1' })
    expect(finalStructuredOutput.issues[9]).toMatchObject({ title: 'PostHog issue 10' })
    expect(summary).not.toHaveProperty('finalOutputMarkdownExcerpt')
  })
})

describe('AgentRuntimeService runbook outcomes', () => {
  it('places approved authoring outcomes in the next-turn session context', async () => {
    const title = `Generated runbook ${randomUUID()}`
    const { store } = createInMemoryAuthoringStore()
    const llmAdapter = makeCreationAuthoringLlmAdapter(title)
    llmAdapter.chatWithTools.mockResolvedValueOnce({ content: 'Acknowledged.', toolCalls: [] })
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const service = createRuntime({ llmAdapter, runbookStore: store as unknown as { list(): Promise<RunbookRecord[]> }, runbookExecutionService })
    const sessionId = await service.start({ prompt: `Create ${title}.`, incidentThreadId: `incident-${randomUUID()}` })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]!

    expect(proposal.nextStep).toContain('draft runbook id is provisional')
    expect(proposal.nextStep).toContain('list_runbooks or the approval notification')

    const approval = await service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })
    await service.send({ sessionId, message: 'Continue.' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const nextTurnContext = getLlmCallMessages(llmAdapter as MockLlmAdapter, 2)
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    expect(nextTurnContext).toContain(`proposalId=${proposal.proposalId}`)
    expect(nextTurnContext).toContain('decision=approved')
    expect(nextTurnContext).toContain(`savedRunbookId=${approval.savedRunbook?.id}`)
    expect(nextTurnContext).toContain(`savedRunbookTitle=${approval.savedRunbook?.title}`)
    expect(nextTurnContext).toContain('Use savedRunbookId with execute_runbook')
  })

  it('creates an MCP authoring proposal without persisting and rejects stale approval', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }])
    const changedRunbook = { ...originalRunbook, revisionNumber: 2, description: 'Updated outside the proposal.' }
    const runbookStore = { list: vi.fn().mockResolvedValue([originalRunbook]), create: vi.fn(), updateMeta: vi.fn(), updateActions: vi.fn() }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = { chatWithTools: vi.fn().mockResolvedValueOnce({ content: 'I will draft an edit for review.', toolCalls: [{ id: 'call-propose-edit', name: 'propose_runbook_edit', args: { runbookId: 'rb-logs', prompt: 'Add an uptime check.', operations: [{ id: 'op-add-uptime', type: 'add_action', rationale: 'Collect uptime before log inspection.', action: { id: 'step-2', type: 'shell', title: 'Collect uptime', command: 'uptime' } }] } }] }).mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }) }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Add an uptime check to the backend runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]
    expect(proposal).toMatchObject({ approvalRequired: true, saved: false, status: 'pending_approval', targetRunbookId: 'rb-logs' })
    runbookStore.list.mockResolvedValue([changedRunbook])
    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).rejects.toThrow('changed after the authoring proposal was created')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('rechecks an edit proposal immediately before persistence', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }])
    const changedRunbook = { ...originalRunbook, revisionNumber: 2, description: 'Updated after the approval was checked.' }
    const runbookStore = {
      list: vi.fn()
        .mockResolvedValueOnce([originalRunbook])
        .mockResolvedValueOnce([originalRunbook])
        .mockResolvedValueOnce([changedRunbook]),
      create: vi.fn(),
      updateMeta: vi.fn(),
      updateActions: vi.fn(),
      remove: vi.fn(),
    }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi.fn()
        .mockResolvedValueOnce({ content: 'I will draft an edit for review.', toolCalls: [{ id: 'call-propose-edit', name: 'propose_runbook_edit', args: { runbookId: 'rb-logs', prompt: 'Add an uptime check.', operations: [{ id: 'op-add-uptime', type: 'add_action', rationale: 'Collect uptime before log inspection.', action: { id: 'step-2', type: 'shell', title: 'Collect uptime', command: 'uptime' } }] } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Add an uptime check to the backend runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).rejects.toThrow('changed after the authoring proposal was created')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('persists only selected authoring operations', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }])
    const savedRunbook = { ...originalRunbook, title: 'Check backend logs and uptime' }
    const runbookStore = {
      list: vi.fn().mockResolvedValue([originalRunbook]),
      create: vi.fn(),
      updateMeta: vi.fn().mockResolvedValue(savedRunbook),
      updateActions: vi.fn().mockResolvedValue(savedRunbook),
      remove: vi.fn(),
    }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi.fn()
        .mockResolvedValueOnce({ content: 'I will draft an edit for review.', toolCalls: [{ id: 'call-propose-edit', name: 'propose_runbook_edit', args: { runbookId: 'rb-logs', prompt: 'Add an uptime check.', operations: [{ id: 'op-title', type: 'update_metadata', rationale: 'Clarify that uptime is covered.', metadata: { title: 'Check backend logs and uptime' } }, { id: 'op-add-uptime', type: 'add_action', rationale: 'Collect uptime before log inspection.', action: { id: 'step-2', type: 'shell', title: 'Collect uptime', command: 'uptime' } }] } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const onRunbooksChanged = vi.fn()
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      onRunbooksChanged,
    })
    const sessionId = await service.start({ prompt: 'Update the backend runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId, approvedOperationIds: ['op-title'] })).resolves.toMatchObject({ savedRunbook: { title: 'Check backend logs and uptime', actions: [{ id: 'step-1' }] } })
    expect(runbookStore.updateActions).toHaveBeenCalledWith({
      runbookId: 'rb-logs',
      actions: [expect.objectContaining({
        id: expect.any(String),
        type: 'shell',
        title: 'Check service status',
        command: 'systemctl status bitsentry',
      })],
    })
    expect((runbookStore.updateActions.mock.calls[0]?.[0] as { actions: Array<{ id: string }> }).actions[0]?.id).not.toBe('step-1')
    expect(onRunbooksChanged).toHaveBeenCalledTimes(1)
  })

  it('does not persist an invalid approved result', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }])
    const runbookStore = { list: vi.fn().mockResolvedValue([originalRunbook]), create: vi.fn(), updateMeta: vi.fn(), updateActions: vi.fn(), remove: vi.fn() }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi.fn()
        .mockResolvedValueOnce({ content: 'I will draft an edit for review.', toolCalls: [{ id: 'call-propose-edit', name: 'propose_runbook_edit', args: { runbookId: 'rb-logs', prompt: 'Break the shell action.', operations: [{ id: 'op-break-shell', type: 'update_action', rationale: 'This should be rejected during approval.', actionId: 'step-1', action: { id: 'step-1', type: 'shell', title: 'Broken shell action', command: '' } }] } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Break the backend runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).rejects.toThrow('produce an invalid runbook')
    expect(runbookStore.create).not.toHaveBeenCalled()
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('removes an incomplete newly created runbook when writing actions fails', async () => {
    const createdShell = makeRunbook('rb-new', 'New runbook', [])
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(createdShell),
      updateMeta: vi.fn(),
      updateActions: vi.fn().mockRejectedValue(new Error('action persistence failed')),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      getIncludingDeleted: vi.fn(),
      purge: vi.fn().mockResolvedValue({ ok: true }),
    }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi.fn()
        .mockResolvedValueOnce({ content: 'I will draft a runbook for review.', toolCalls: [{ id: 'call-propose-create', name: 'propose_runbook_create', args: { prompt: 'Create a status runbook.', draftRunbook: { title: 'New runbook', description: 'Collect status.', actions: [{ id: 'step-1', type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry' }] } } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Create a status runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).rejects.toThrow('action persistence failed')
    expect(runbookStore.purge).toHaveBeenCalledWith({ id: createdShell.id })
  })

  it('approves proposals with identical model action ids without reusing a stored primary key', async () => {
    const { store, rows } = createInMemoryAuthoringStore()
    const first = await createPendingRunbookAuthoringProposal(store, 'First status runbook')
    const second = await createPendingRunbookAuthoringProposal(store, 'Second status runbook')

    const firstResult = await first.service.approveRunbookAuthoringProposal({
      sessionId: first.sessionId,
      proposalId: first.proposalId,
    })
    const secondResult = await second.service.approveRunbookAuthoringProposal({
      sessionId: second.sessionId,
      proposalId: second.proposalId,
    })

    const persistedActionIds = [...rows.values()].flatMap((row) => row.runbook.actions.map((action) => action.id))
    expect(rows).toHaveLength(2)
    expect(persistedActionIds).toHaveLength(2)
    expect(new Set(persistedActionIds).size).toBe(2)
    expect(persistedActionIds).not.toContain('update-claude-code')
    expect(firstResult.savedRunbook?.actions[0]?.id).not.toBe('update-claude-code')
    expect(secondResult.savedRunbook?.actions[0]?.id).not.toBe('update-claude-code')
  })

  it('purges a failed create attempt and lets the same pending approval converge on retry', async () => {
    const { store, rows } = createInMemoryAuthoringStore({ failAfterActionWriteCount: 1 })
    const pending = await createPendingRunbookAuthoringProposal(store, 'Retry status runbook')

    await expect(pending.service.approveRunbookAuthoringProposal({
      sessionId: pending.sessionId,
      proposalId: pending.proposalId,
    })).rejects.toThrow('simulated post-write failure')
    expect(rows).toHaveLength(0)

    const retried = await pending.service.approveRunbookAuthoringProposal({
      sessionId: pending.sessionId,
      proposalId: pending.proposalId,
    })
    expect(retried.savedRunbook).toMatchObject({ title: 'Retry status runbook' })
    expect(rows).toHaveLength(1)
    expect([...rows.values()][0]?.runbook.actions).toHaveLength(1)
  })

  itWithDesktopSqlite('persists an approval through the real SQLite store after every action row is written', async () => {
    const runbookStore = await createSqliteRunbookStore()
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi.fn()
        .mockResolvedValueOnce({ content: 'I will draft a runbook for review.', toolCalls: [{ id: 'call-propose-create', name: 'propose_runbook_create', args: { prompt: 'Create a status runbook.', draftRunbook: { title: 'New runbook', description: 'Collect status.', actions: [{ id: 'update-claude-code', type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry', parameters: [{ id: 'target-host', key: 'host' }] }, { id: 'update-codex', type: 'shell', title: 'Collect uptime', command: 'uptime' }] } } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Create a status runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    const result = await service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })
    const saved = result.savedRunbook

    expect(saved).toMatchObject({ title: 'New runbook', actions: [{ title: 'Collect status' }, { title: 'Collect uptime' }] })
    expect(saved?.actions.map((action) => action.id)).not.toContain('update-claude-code')
    expect(saved?.actions.map((action) => action.id)).not.toContain('update-codex')
    expect(saved?.actions[0]?.parameters?.[0]?.id).not.toBe('target-host')
    expect(proposal.proposedRunbook.actions.map((action) => action.id)).toEqual([
      'update-claude-code',
      'update-codex',
    ])
  })

  it('persists a store-valid creation proposal with an idle timeout in minutes', async () => {
    const createdRunbook = { ...makeRunbook('rb-new', 'New runbook', []), idleTimeout: 30 }
    const savedRunbook = {
      ...createdRunbook,
      actions: [{ id: 'step-1', type: 'shell' as const, title: 'Collect status', command: 'systemctl status bitsentry' }],
    }
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(createdRunbook),
      updateMeta: vi.fn(),
      updateActions: vi.fn().mockResolvedValue(savedRunbook),
      remove: vi.fn(),
    }
    const runbookExecutionService = { start: vi.fn(), waitForCompletion: vi.fn(), get: vi.fn().mockResolvedValue(null), getLatestForIncidentThread: vi.fn().mockResolvedValue(null) }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({ content: 'I will draft a runbook for review.', toolCalls: [{ id: 'call-propose-create', name: 'propose_runbook_create', args: { prompt: 'Create a status runbook.', draftRunbook: { title: 'New runbook', description: 'Collect status.', idleTimeout: 30, actions: [{ id: 'step-1', type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry' }] } } }] })
        .mockResolvedValueOnce({ content: 'The proposal requires approval.', toolCalls: [] }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })
    const sessionId = await service.start({ prompt: 'Create a status runbook.', incidentThreadId: 'incident-authoring' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).resolves.toMatchObject({
      savedRunbook: { id: 'rb-new', idleTimeout: 30 },
    })
    expect(runbookStore.create).toHaveBeenCalledWith(expect.objectContaining({ idleTimeout: 30 }))
  })
  it('records Claude MCP host tools in the thread snapshot and replay transcript', async () => {
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', 'Investigate Sentry', [
          { id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: '11111111-1111-4111-8111-111111111111',
        resultId: 'result-1',
      }),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(makeExecution({ status: 'running', completedAt: undefined })),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockImplementationOnce(async (input: LlmChatRequest) => {
          await executeHostTool(input.hostToolContext!, 'execute_runbook', {
            runbookTitle: 'Investigate Sentry',
          })
          return {
            content: 'I started the Investigate Sentry runbook.',
            toolCalls: [],
            toolProtocol: 'mcp' as const,
          }
        })
        .mockResolvedValueOnce({ content: 'The runbook is still running.', toolCalls: [] }),
    }
    const sentEvents: AgentRuntimeEventPayload[] = []
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    const sessionId = await service.start({
      prompt: 'Use the available host tools to investigate the active incident.',
      incidentThreadId: 'incident-mcp-ledger',
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
    })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
    ])
    expect(sentEvents.some((payload) => payload.event.type === 'tool_start')).toBe(true)
    expect(sentEvents.some((payload) => payload.event.type === 'tool_end')).toBe(true)
    expect(sentEvents.some((payload) => (
      payload.event.type === 'activity' && payload.event.phase === 'running_runbook'
    ))).toBe(true)
    expect(llmAdapter.chatWithTools).toHaveBeenCalledTimes(1)

    await service.send({ sessionId, message: 'What is its status?' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    expect(getSecondCallMessages(llmAdapter)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: expect.stringContaining('execute_runbook') }),
    ]))
  })

  it('makes list_runbooks results visible to local provider responses', async () => {
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', 'Investigate Sentry', [
          { id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' },
          { id: 'step-2', type: 'llm', title: 'Summarize findings' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn(),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will list the available runbooks.',
          toolCalls: [
            {
              id: 'call-list-runbooks',
              name: 'list_runbooks',
              args: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Available runbooks:\n\n- Investigate Sentry — 2 actions',
          toolCalls: [],
        }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })

    const sessionId = await service.start({
      prompt: 'What runbooks can I use?',
      incidentThreadId: 'incident-runbook-list',
      llm: { providerKey: 'codex', model: 'gpt-5.4-mini' },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage.finalText).toContain('Available runbooks:')
    expect(agentMessage.finalText).toContain('Investigate Sentry')
    expect(agentMessage.finalText?.match(/Available runbooks/gi) ?? []).toHaveLength(1)
    expect(agentMessage.finalText).not.toContain('Completed runbook output:')
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'list_runbooks', state: 'done' }),
    ])
    expect(getRequiredToolContent(getSecondCallMessages(llmAdapter))).toContain(
      'Internal runbook list:',
    )
    expect(getRequiredToolContent(getSecondCallMessages(llmAdapter))).toContain(
      'Summarize the available runbooks for the user in clean Markdown.',
    )
  })

  it('executes an exactly named runbook from an incident prompt before asking the model to summarize it', async () => {
    const sentEvents: AgentRuntimeEventPayload[] = []
    const kanyeExecution = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333333',
      runbookId: 'rb-kanye-rest',
      runbookTitle: 'Kanye Rest',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'llm',
          title: 'Read Kanye Rest output',
          status: 'completed',
          output: 'Kanye Rest said the service is healthy.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-kanye-rest', 'Kanye Rest', [
          {
            id: 'step-1',
            type: 'llm',
            title: 'Read Kanye Rest output',
            prompt: 'Summarize Kanye Rest.',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: kanyeExecution.executionId,
        resultId: 'result-kanye-rest',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(kanyeExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({
        content: 'I will show the Kanye Rest runbook results: service healthy.',
        toolCalls: [],
      }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    const sessionId = await service.start({
      prompt: 'Hey, can you please figure out what Kanye Rest said?',
      incidentThreadId: 'incident-kanye',
      llm: { providerKey: 'codex', model: 'gpt-5.4-mini' },
    })

    await waitForCondition(() => runbookExecutionService.start.mock.calls.length === 1)
    await waitForCondition(() => llmAdapter.chatWithTools.mock.calls.length === 1)

    expect(runbookExecutionService.start).toHaveBeenCalledWith(
      'rb-kanye-rest',
      expect.objectContaining({
        incidentThreadId: 'incident-kanye',
        source: 'agent',
      }),
    )
    const toolCalls = getAllAgentToolCalls(service, sessionId)
    expect(toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'execute_runbook',
        state: 'done',
        output: expect.stringContaining(kanyeExecution.executionId),
      }),
    ])
    expect(
      sentEvents.some((payload) => (
        payload.event.type === 'tool_start' &&
        payload.event.toolName === 'execute_runbook'
      )),
    ).toBe(true)
    const llmMessages = getLlmCallMessages(llmAdapter, 0)
    expect(llmMessages.some((message) => message.role === 'tool')).toBe(false)
    const directRunbookContext = getRequiredSystemContent(
      llmMessages,
      'This was app-owned runbook runtime behavior, not an AI-requested tool call.',
    )
    expect(directRunbookContext).toContain('- Status: running')
    expect(llmAdapter.chatWithTools.mock.calls).toHaveLength(1)
    expect(service.getStatus(sessionId).state).toBe('COMPLETED')
  })

  it.each([
    [
      'initial QA failure',
      [
        'The Posthog Error Check runbook failed before it could reach the actual error analysis.',
        '',
        'What happened:',
        '- Step 1 – PostHog Project Discovery: ❌ Failed',
        '- Step 2 – PostHog Sandbox API Error Check: ⏸ Never ran (blocked by the failed discovery step)',
      ].join('\n'),
    ],
    [
      'repeat QA failure',
      [
        'The Posthog Error Check runbook failed again, at the same step as the previous attempt.',
        '',
        'What happened:',
        '- Step 1 – PostHog Project Discovery: ❌ Failed (second consecutive failure at this exact step)',
        '- Step 2 – PostHog Sandbox API Error Check: ⏸ Never ran (blocked by the failed discovery step)',
      ].join('\n'),
    ],
    [
      'running outcome claim',
      [
        'Checking runbook status for "Sentry Desktop Error Check" — the runbook was started and is currently mid-execution',
        '(List recent Sentry issues step running), so I’ll pull the current results before summarizing.',
      ].join(' '),
    ],
  ])('does not parse %s into a host-tool retry', async (_name, qaFailureText) => {
    const executionId = '66666666-6666-4666-8666-666666666666'
    const sentEvents: AgentRuntimeEventPayload[] = []
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-posthog', 'Posthog Error Check', [
          { id: 'step-1', type: 'external_source', title: 'PostHog Sandbox API Error Check' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({ executionId, resultId: 'result-posthog' }),
      get: vi.fn().mockResolvedValue(null),
      waitForCompletion: vi.fn(),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({ content: qaFailureText, toolCalls: [] }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    const sessionId = await service.start({
      prompt: 'Run the Posthog Error Check runbook for this incident and summarize the three most important unresolved errors.',
      incidentThreadId: 'incident-posthog-outcome-claim',
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-5' },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(llmAdapter.chatWithTools.mock.calls).toHaveLength(1)
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({
        toolName: 'execute_runbook',
        output: expect.stringContaining(executionId),
      }),
    ])
    expect(sentEvents.some((payload) => payload.event.type === 'error')).toBe(false)
  })

  it('accepts an execution outcome claim only after inspecting that persisted execution', async () => {
    const executionId = '77777777-7777-4777-8777-777777777777'
    const persistedFailure = makeExecution({
      executionId,
      runbookId: 'rb-posthog',
      runbookTitle: 'Posthog Error Check',
      status: 'failed',
      completionReason: 'step_failed',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'external_source',
          title: 'PostHog Sandbox API Error Check',
          status: 'failed',
          error: 'PostHog API returned 403.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-posthog', 'Posthog Error Check', [
          { id: 'step-1', type: 'external_source', title: 'PostHog Sandbox API Error Check' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({ executionId, resultId: 'result-posthog' }),
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(persistedFailure),
      waitForCompletion: vi.fn(),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the started runbook execution.',
          toolCalls: [{
            id: 'inspect-posthog-execution',
            name: 'get_runbook_execution',
            args: { executionId },
          }],
        })
        .mockResolvedValueOnce({
          content: 'The Posthog Error Check runbook failed at Step 1 because PostHog API returned 403.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })

    const sessionId = await service.start({
      prompt: 'Run the Posthog Error Check runbook for this incident and summarize the three most important unresolved errors.',
      incidentThreadId: 'incident-posthog-inspected-outcome',
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-5' },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(runbookExecutionService.get).toHaveBeenCalledTimes(2)
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
      expect.objectContaining({
        toolName: 'get_runbook_execution',
        state: 'done',
        output: expect.stringContaining('PostHog API returned 403.'),
      }),
    ])
    expect(getLastAgentMessage(service.getSnapshot(sessionId)).finalText).toContain('failed at Step 1')
  })

  it('leaves a started runbook inspectable when the provider fails during the follow-up turn', async () => {
    const executionId = '55555555-5555-4555-8555-555555555555'
    let persistedExecution = makeExecution({
      executionId,
      runbookId: 'rb-durable',
      runbookTitle: 'Durable runbook',
      status: 'running',
      completedAt: undefined,
      completionReason: undefined,
      steps: [],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-durable', 'Durable runbook', [
          { id: 'step-1', type: 'shell', title: 'Check durable state' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({ executionId, resultId: 'result-durable' }),
      get: vi.fn().mockImplementation(() => Promise.resolve(persistedExecution)),
      waitForCompletion: vi.fn(),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'Starting the durable runbook.',
          toolCalls: [{
            id: 'call-durable',
            name: 'execute_runbook',
            args: { runbookTitle: 'Durable runbook' },
          }],
        })
        .mockRejectedValueOnce(new Error('Provider connection closed during summary')),
    }
    const service = createRuntime({ llmAdapter, runbookStore, runbookExecutionService })

    const sessionId = await service.start({
      prompt: 'Run Durable runbook.',
      incidentThreadId: 'incident-durable',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'FAILED')
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
    ])
    expect(await runbookExecutionService.get(executionId)).toMatchObject({ status: 'running' })

    persistedExecution = makeExecution({
      executionId,
      runbookId: 'rb-durable',
      runbookTitle: 'Durable runbook',
      status: 'completed',
      completionReason: 'success',
      completedAt: '2026-05-26T01:00:20.000Z',
    })

    await expect(runbookExecutionService.get(executionId)).resolves.toMatchObject({
      executionId,
      status: 'completed',
      completionReason: 'success',
    })
  })

  it('does not directly execute a named runbook when the user is only asking whether to run it', async () => {
    const sentEvents: AgentRuntimeEventPayload[] = []
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-kanye-rest', 'Kanye Rest', [
          {
            id: 'step-1',
            type: 'llm',
            title: 'Read Kanye Rest output',
            prompt: 'Summarize Kanye Rest.',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn(),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({
        content: 'You may want to run Kanye Rest if you need the latest result.',
        toolCalls: [],
      }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    await service.start({
      prompt: 'Should we run Kanye Rest?',
      incidentThreadId: 'incident-kanye',
      llm: { providerKey: 'codex', model: 'gpt-5.4-mini' },
    })

    await waitForCondition(() => llmAdapter.chatWithTools.mock.calls.length === 1)

    expect(runbookExecutionService.start).not.toHaveBeenCalled()
    expect(getLlmCallMessages(llmAdapter, 0).some((message) => message.role === 'tool')).toBe(false)
  })

  it('does not directly execute a named runbook when required parameters are missing', async () => {
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-backend-logs', 'Check Backend Logs', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Read backend logs',
            command: 'journalctl --since {{since}} --until {{until}}',
            parameters: [
              { id: 'since-param', key: 'since', required: true },
              { id: 'until-param', key: 'until', required: true },
            ],
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn(),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({
        content: 'I will run Check Backend Logs with the supplied window.',
        toolCalls: [],
      }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    await service.start({
      prompt: 'Run Check Backend Logs.',
      incidentThreadId: 'incident-logs',
      llm: { providerKey: 'codex', model: 'gpt-5.4-mini' },
    })

    await waitForCondition(() => llmAdapter.chatWithTools.mock.calls.length === 1)

    expect(runbookExecutionService.start).not.toHaveBeenCalled()
  })

  it('passes supplied parameter values before direct runbook auto-execution', async () => {
    const logsExecution = makeExecution({
      executionId: '44444444-4444-4444-8444-444444444444',
      runbookId: 'rb-backend-logs',
      runbookTitle: 'Check Backend Logs',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Read backend logs',
          status: 'completed',
          output: 'Backend logs were checked for the requested window.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-backend-logs', 'Check Backend Logs', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Read backend logs',
            command: 'journalctl --since {{since}} --until {{until}}',
            parameters: [
              { id: 'since-param', key: 'since', required: true },
              { id: 'until-param', key: 'until', required: true },
            ],
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: logsExecution.executionId,
        resultId: 'result-backend-logs',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(logsExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockResolvedValue({
        content: 'Backend logs were checked for the requested window.',
        toolCalls: [],
      }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    await service.start({
      prompt: 'Run Check Backend Logs since 2026-05-28 09:15 UTC until 2026-05-28 09:25 UTC.',
      incidentThreadId: 'incident-logs',
      llm: { providerKey: 'codex', model: 'gpt-5.4-mini' },
    })

    await waitForCondition(() => runbookExecutionService.start.mock.calls.length === 1)

    expect(runbookExecutionService.start).toHaveBeenCalledWith(
      'rb-backend-logs',
      expect.objectContaining({
        parameterValues: {
          since: '2026-05-28 09:15 UTC',
          until: '2026-05-28 09:25 UTC',
        },
      }),
    )
  })

  it('does not invent parameters from a runbook that has not finished', async () => {
    const sentryExecution = makeExecution()
    const logsExecution = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend log window loaded without timestamp parse errors.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
            command: 'journalctl --since {{since}} --until {{until}}',
            parameters: [
              { id: 'since-param', key: 'since', required: true },
              { id: 'until-param', key: 'until', required: true },
            ],
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockImplementation((runbookId: string) => {
        if (runbookId === 'rb-logs') {
          return {
            executionId: logsExecution.executionId,
            resultId: 'result-logs',
          }
        }

        return {
          executionId: sentryExecution.executionId,
          resultId: 'result-sentry',
        }
      }),
      waitForCompletion: vi.fn().mockImplementation((executionId: string) => {
        if (executionId === sentryExecution.executionId) return Promise.resolve(sentryExecution)
        if (executionId === logsExecution.executionId) return Promise.resolve(logsExecution)
        return Promise.resolve(null)
      }),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will retrieve the Sentry errors.',
          toolCalls: [
            {
              id: 'call-sentry',
              name: 'execute_runbook',
              args: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I will cross-check the Sentry window against backend logs.',
          toolCalls: [
            {
              id: 'call-logs',
              name: 'execute_runbook',
              args: {
                runbookTitle: 'Check Logs in the Jagad backend server',
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Matrix: backend logs were checked against the Sentry window.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Pull Jagad errors and cross-validate them with backend logs.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => {
      const lastMessage = service.getSnapshot(sessionId).messages.at(-1)
      return (
        lastMessage?.kind === 'agent' &&
        lastMessage.finalText === 'Matrix: backend logs were checked against the Sentry window.'
      )
    })

    const backendRun = getRunbookStartCalls(runbookExecutionService.start).find(
      ([runbookId]) => runbookId === 'rb-logs',
    )
    if (backendRun === undefined) {
      throw new Error('Expected backend log runbook to start')
    }
    expect(backendRun[1].parameterValues).toBeUndefined()
    expect(service.getStatus(sessionId).state).toBe('COMPLETED')
  })

  it('passes the session access level into agent-started runbooks', async () => {
    const execution = makeExecution({
      runbookId: 'rb-summary',
      runbookTitle: 'Summarize runbook output',
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-summary', 'Summarize runbook output', [
          { id: 'step-1', type: 'llm', title: 'Summarize' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: execution.executionId,
        resultId: 'result-summary',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(execution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the summary runbook.',
          toolCalls: [
            {
              id: 'call-summary',
              name: 'execute_runbook',
              args: { runbookTitle: 'Summarize runbook output' },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Summary complete.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Run the summary runbook.',
      accessLevel: 'full-access',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(getRunbookStartCalls(runbookExecutionService.start)[0]?.[1].accessLevel).toBe(
      'full-access',
    )
  })

  it('keeps a pending runbook result out of the model context', async () => {
    const sentryMatrix = [
      '| Issue | Last seen | journalctl --since | journalctl --until | Description |',
      '| --- | --- | --- | --- | --- |',
      `| SERVER-292 | 2026-05-26T00:59:00.000Z | 2026-05-26 00:54:00 UTC | 2026-05-26 01:04:00 UTC | ${'first issue details '.repeat(30)} |`,
      '| SERVER-293 | 2026-05-26T01:20:00.000Z | 2026-05-26 01:15:00 UTC | 2026-05-26 01:25:00 UTC | second issue details |',
    ].join('\n')
    const sentryExecution = makeExecution({
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'llm',
          title: 'Build Sentry matrix',
          status: 'completed',
          output: sentryMatrix,
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: sentryExecution.executionId,
        resultId: 'result-sentry',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(sentryExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will retrieve the Sentry matrix.',
          toolCalls: [
            {
              id: 'call-sentry',
              name: 'execute_runbook',
              args: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I have the exact journal windows.',
          toolCalls: [],
        }),
    }
    const sentEvents: AgentRuntimeEventPayload[] = []
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    const sessionId = await service.start({
      prompt: 'Pull Jagad errors from Sentry and keep the log windows.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const secondCallMessages = getSecondCallMessages(llmAdapter)
    const toolContext = getRequiredToolContent(secondCallMessages)
    expect(toolContext).toContain('Status: running')
    expect(toolContext).not.toContain('SERVER-292')
    expect(toolContext).not.toContain('SERVER-293')
    expect(sentEvents.some((payload) => (
      payload.event.type === 'activity' && payload.event.phase === 'running_runbook'
    ))).toBe(true)
  })

  it('gives the model the top ten PostHog issue titles from a large plugin result', async () => {
    const issues = Array.from({ length: 27 }, (_, index) => ({
      id: `issue-${String(index + 1)}`,
      title: `PostHog issue ${String(index + 1)}`,
      status: 'unresolved',
      count: index + 1,
      userCount: 1,
      firstSeen: '2026-07-30T00:00:00.000Z',
      lastSeen: '2026-07-30T01:00:00.000Z',
      level: 'error',
      metadata: { stack: 'x'.repeat(2_700) },
    }))
    const postHogExecution = makeExecution({
      runbookId: 'rb-posthog',
      runbookTitle: 'PostHog Sandbox API Error Check',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'plugin',
          title: 'List PostHog exception issues',
          status: 'completed',
          output: `Fetched 27 PostHog issues.\n\n${JSON.stringify({ issues })}`,
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-posthog', 'PostHog Sandbox API Error Check', [
          { id: 'step-1', type: 'plugin', title: 'List PostHog exception issues' },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: postHogExecution.executionId,
        resultId: 'result-posthog',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(postHogExecution),
      get: vi
        .fn()
        .mockResolvedValueOnce(makeExecution({
          executionId: postHogExecution.executionId,
          runbookId: 'rb-posthog',
          runbookTitle: 'PostHog Sandbox API Error Check',
          status: 'running',
          completedAt: undefined,
          completionReason: undefined,
          steps: [],
        }))
        .mockResolvedValue(postHogExecution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the PostHog errors.',
          toolCalls: [
            {
              id: 'call-posthog',
              name: 'execute_runbook',
              args: { runbookTitle: 'PostHog Sandbox API Error Check' },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I will inspect the completed PostHog execution before summarizing it.',
          toolCalls: [
            {
              id: 'call-posthog-result',
              name: 'get_runbook_execution',
              args: { executionId: postHogExecution.executionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The top PostHog issues are summarized.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Find the recent exception issues.',
      incidentThreadId: 'incident-posthog',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const toolContext = getLastToolContent(getLlmCallMessages(llmAdapter, 2))
    expect(toolContext).toContain('PostHog issue 1')
    expect(toolContext).toContain('PostHog issue 10')
    expect(toolContext).not.toContain('PostHog issue 11')
    expect(toolContext).not.toContain('xxxxxxxxxx')
  })

  it('rejects malformed runbook identifiers instead of executing the active runbook', async () => {
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-active', 'Active incident runbook', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Active runbook step',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn(),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the active runbook.',
          toolCalls: [
            {
              id: 'call-execute',
              name: 'execute_runbook',
              args: { runbookId: 123 },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The runbook identifier was malformed, so I did not execute it.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Run it now.',
      incidentThreadId: 'incident-1',
      runbookContext: {
        id: 'rb-active',
        title: 'Active incident runbook',
        description: '',
        actions: [{ id: 'step-1', type: 'shell', title: 'Active runbook step' }],
      },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'The runbook identifier was malformed, so I did not execute it.',
    })
    const toolCalls = agentMessage.toolCalls
    const failedExecutionCard = toolCalls.find((toolCall) => toolCall.toolName === 'execute_runbook')
    expect(failedExecutionCard).toMatchObject({ state: 'failed' })
    const visibleToolText = [
      failedExecutionCard?.error,
      failedExecutionCard?.output,
      failedExecutionCard?.modelContext,
    ].join('\n')
    expect(visibleToolText).toContain('execute_runbook')
  })

  it('rejects malformed runbook execution identifiers instead of returning the latest execution', async () => {
    const latestExecution = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-latest',
      runbookTitle: 'Latest incident runbook',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Latest runbook step',
          status: 'completed',
          output: 'Latest execution should not be returned for malformed input.',
        },
      ],
    })
    const runbookExecutionService = {
      start: vi.fn(),
      get: vi.fn(),
      waitForCompletion: vi.fn(),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(latestExecution),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the runbook execution.',
          toolCalls: [
            {
              id: 'call-get',
              name: 'get_runbook_execution',
              args: { executionId: 123 },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The execution identifier was malformed, so I did not use the latest runbook result.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore: { list: vi.fn().mockResolvedValue([]) },
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Inspect the runbook execution.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'The execution identifier was malformed, so I did not use the latest runbook result.',
    })
    const toolCalls = agentMessage.toolCalls
    const failedInspectionCard = toolCalls.find((toolCall) => toolCall.toolName === 'get_runbook_execution')
    expect(failedInspectionCard).toMatchObject({ state: 'failed' })
    const visibleToolText = [
      failedInspectionCard?.error,
      failedInspectionCard?.output,
      failedInspectionCard?.modelContext,
    ].join('\n')
    expect(visibleToolText).toContain('get_runbook_execution')
    expect(visibleToolText).not.toContain('Latest execution should not be returned')
  })

  it('allows same-turn inspection of the execution that was just started', async () => {
    const sentryExecution = makeExecution()
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: sentryExecution.executionId,
        resultId: 'result-sentry',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(sentryExecution),
      get: vi.fn().mockResolvedValue(sentryExecution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will start the runbook and inspect the result.',
          toolCalls: [
            {
              id: 'call-execute',
              name: 'execute_runbook',
              args: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
            },
            {
              id: 'call-get',
              name: 'get_runbook_execution',
              args: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Matrix: inspected the just-started Sentry execution.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Retrieve Jagad Sentry errors and inspect the runbook output.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => {
      const lastMessage = service.getSnapshot(sessionId).messages.at(-1)
      return (
        lastMessage?.kind === 'agent' &&
        lastMessage.finalText === 'Matrix: inspected the just-started Sentry execution.'
      )
    })

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'Matrix: inspected the just-started Sentry execution.',
    })
    const toolCalls = agentMessage.toolCalls
    const inspectionCard = toolCalls.find((toolCall) => toolCall.toolName === 'get_runbook_execution')
    expect(inspectionCard).toMatchObject({ state: 'done' })
    expect(inspectionCard?.output).toContain('SERVER-292 last seen')
  })

  it('allows explicit same-turn inspection of a prior runbook execution', async () => {
    const newExecution = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-sentry',
      runbookTitle: "Retrieve errors from Jagad's Sentry",
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'external_source',
          title: 'Retrieve errors from Sentry',
          status: 'completed',
          output: 'New Sentry matrix generated.',
        },
      ],
    })
    const priorExecution = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333333',
      runbookId: 'rb-logs',
      runbookTitle: 'Prior backend log check',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Prior log check',
          status: 'completed',
          output: 'Prior backend logs are still available.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: newExecution.executionId,
        resultId: 'result-sentry',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(newExecution),
      get: vi.fn().mockImplementation((executionId: string) => {
        if (executionId === newExecution.executionId) return Promise.resolve(newExecution)
        if (executionId === priorExecution.executionId) return Promise.resolve(priorExecution)
        return Promise.resolve(null)
      }),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will start a fresh Sentry runbook and compare it to the prior logs.',
          toolCalls: [
            {
              id: 'call-execute',
              name: 'execute_runbook',
              args: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
            },
            {
              id: 'call-get-prior',
              name: 'get_runbook_execution',
              args: { executionId: priorExecution.executionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Compared the new Sentry runbook with the prior backend logs.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Refresh Sentry and compare against the prior log execution.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'Compared the new Sentry runbook with the prior backend logs.',
    })
    const toolCalls = agentMessage.toolCalls
    const inspectionCard = toolCalls.find((toolCall) => toolCall.toolName === 'get_runbook_execution')
    expect(inspectionCard).toMatchObject({ state: 'done' })
    expect(inspectionCard?.output).toContain('Prior backend logs are still available.')
    expect(inspectionCard?.modelContext).not.toContain('lookupDeferred')
  })

  it('falls back from an invented execution id to the real runbook started in the same turn', async () => {
    const sentryExecution = makeExecution({
      executionId: '11111111-1111-4111-8111-111111111111',
      runbookId: 'rb-sentry',
      runbookTitle: "Retrieve errors from Jagad's Sentry",
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'external_source',
          title: 'Retrieve errors from Sentry',
          status: 'completed',
          output: 'SERVER-292 last seen at 2026-05-28T09:23:00.000Z',
        },
      ],
    })
    const inventedExecutionId = '66666666-6666-4666-8666-666666666666'
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: sentryExecution.executionId,
        resultId: 'result-sentry',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(sentryExecution),
      get: vi.fn().mockImplementation((executionId: string) => {
        if (executionId === sentryExecution.executionId) return Promise.resolve(sentryExecution)
        return Promise.resolve(null)
      }),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will start the Sentry runbook and inspect it.',
          toolCalls: [
            {
              id: 'call-execute',
              name: 'execute_runbook',
              args: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
            },
            {
              id: 'call-get-invented',
              name: 'get_runbook_execution',
              args: { executionId: inventedExecutionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Matrix: inspected the real Sentry execution despite the bad id.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Retrieve Jagad Sentry errors and inspect the runbook output.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'Matrix: inspected the real Sentry execution despite the bad id.',
    })
    const toolCalls = agentMessage.toolCalls
    const inspectionCard = toolCalls.find((toolCall) => toolCall.toolName === 'get_runbook_execution')
    expect(inspectionCard).toMatchObject({
      state: 'done',
    })
    expect(inspectionCard?.error).toBeUndefined()
    expect(inspectionCard?.output).toContain('SERVER-292 last seen')
    expect(inspectionCard?.output).not.toContain('Runbook execution not found')
  })

  it('does not substitute an unrelated latest incident execution for a missing explicit execution id', async () => {
    const priorExecution = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333333',
      runbookId: 'rb-logs',
      runbookTitle: 'Prior backend log check',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Prior log check',
          status: 'completed',
          output: 'Prior backend logs should not be substituted.',
        },
      ],
    })
    const missingExecutionId = '77777777-7777-4777-8777-777777777777'
    const runbookExecutionService = {
      start: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      waitForCompletion: vi.fn(),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(priorExecution),
    }
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the requested execution.',
          toolCalls: [
            {
              id: 'call-get-missing',
              name: 'get_runbook_execution',
              args: { executionId: missingExecutionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The requested execution was not found.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Inspect this execution id.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'The requested execution was not found.',
    })
    const toolCalls = agentMessage.toolCalls
    const inspectionCard = toolCalls.find((toolCall) => toolCall.toolName === 'get_runbook_execution')
    const visibleToolText = [inspectionCard?.error, inspectionCard?.output, inspectionCard?.modelContext].join('\n')
    expect(inspectionCard).toMatchObject({
      state: 'failed',
    })
    expect(visibleToolText).toContain(`Runbook execution not found: ${missingExecutionId}`)
    expect(visibleToolText).not.toContain('Prior backend logs should not be substituted.')
  })

  it('resolves Claude-style synthetic runbook ids to exact listed runbook titles', async () => {
    const sentryExecution = makeExecution({
      runbookId: 'rb-sentry',
      runbookTitle: "Retrieve errors from Jagad's Sentry",
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'external_source',
          title: 'Retrieve errors from Sentry',
          status: 'completed',
          output: 'Retrieved Jagad Sentry errors.',
        },
      ],
    })
    const logsExecution = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Checked Jagad backend logs.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', "Retrieve errors from Jagad's Sentry", [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'Retrieve errors from Sentry',
          },
        ]),
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockImplementation((runbookId: string) => {
        if (runbookId === 'rb-logs') {
          return {
            executionId: logsExecution.executionId,
            resultId: 'result-logs',
          }
        }

        return {
          executionId: sentryExecution.executionId,
          resultId: 'result-sentry',
        }
      }),
      waitForCompletion: vi.fn().mockImplementation((executionId: string) => {
        if (executionId === sentryExecution.executionId) return Promise.resolve(sentryExecution)
        if (executionId === logsExecution.executionId) return Promise.resolve(logsExecution)
        return Promise.resolve(null)
      }),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the Jagad Sentry and log runbooks.',
          toolCalls: [
            {
              id: 'call-sentry',
              name: 'execute_runbook',
              args: { runbookId: 'rb-sentry-jagad' },
            },
            {
              id: 'call-logs',
              name: 'execute_runbook',
              args: {
                runbookId: 'rb-logs-jagad',
                parameterValues: {
                  since: '2026-05-28 09:15:01 UTC',
                  until: '2026-05-28 09:25:01 UTC',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Both synthetic runbook ids resolved to real runbooks.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Run the Jagad Sentry and backend log runbooks.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'Both synthetic runbook ids resolved to real runbooks.',
    })
    const toolCalls = agentMessage.toolCalls
    const executionOutputs = toolCalls
      .filter((toolCall) => toolCall.toolName === 'execute_runbook')
      .map((toolCall) => toolCall.output ?? '')
    expect(executionOutputs).toHaveLength(2)
    expect(executionOutputs.join('\n')).toContain('"runbookId": "rb-sentry"')
    expect(executionOutputs.join('\n')).toContain('"runbookId": "rb-logs"')
    expect(
      toolCalls
        .filter((toolCall) => toolCall.toolName === 'execute_runbook')
        .every((toolCall) => toolCall.state === 'done' && toolCall.error === undefined),
    ).toBe(true)
  })

  it('reports one accepted execution when the model repeats the same runbook request', async () => {
    const logsExecution = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend logs loaded for the combined Sentry window.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: logsExecution.executionId,
        resultId: 'result-logs',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(logsExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect multiple log windows.',
          toolCalls: [
            {
              id: 'call-logs-1',
              name: 'execute_runbook',
              args: {
                runbookTitle: 'Check Logs in the Jagad backend server',
                parameterValues: {
                  since: '2026-05-30 00:00:00 UTC',
                  until: '2026-05-30 00:10:00 UTC',
                },
              },
            },
            {
              id: 'call-logs-2',
              name: 'execute_runbook',
              args: {
                runbookTitle: 'Check Logs in the Jagad backend server',
                parameterValues: {
                  until: '2026-05-30 00:10:00 UTC',
                  since: '2026-05-30 00:00:00 UTC',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I used the first log execution and did not restart it.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Cross-validate Jagad Sentry errors with backend logs.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'I used the first log execution and did not restart it.',
    })
    const toolCalls = agentMessage.toolCalls
    const executionCards = toolCalls.filter((toolCall) => toolCall.toolName === 'execute_runbook')
    expect(executionCards).toHaveLength(2)
    expect(
      executionCards.some((toolCall) =>
        toolCall.output !== undefined &&
          toolCall.output.includes('"deduplicated": true'),
      ),
    ).toBe(true)
    const executionIds = executionCards.map((toolCall) => {
      const output = JSON.parse(toolCall.output ?? '{}') as { executionId?: string }
      return output.executionId
    })
    expect(new Set(executionIds).size).toBe(1)
  })

  it('allows the same runbook to start with different parameters in one assistant turn', async () => {
    const firstLogsExecution = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333331',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend logs loaded for the 00:00-00:10 UTC window.',
        },
      ],
    })
    const secondLogsExecution = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333332',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend logs loaded for the 00:10-00:20 UTC window.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi
        .fn()
        .mockResolvedValueOnce({
          executionId: '33333333-3333-4333-8333-333333333331',
          resultId: 'result-logs-1',
        })
        .mockResolvedValueOnce({
          executionId: '33333333-3333-4333-8333-333333333332',
          resultId: 'result-logs-2',
        }),
      waitForCompletion: vi
        .fn()
        .mockResolvedValueOnce(firstLogsExecution)
        .mockResolvedValueOnce(secondLogsExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will compare two requested windows.',
          toolCalls: [
            {
              id: 'call-logs-1',
              name: 'execute_runbook',
              args: {
                runbookTitle: 'Check Logs in the Jagad backend server',
                parameterValues: {
                  since: '2026-05-30 00:00:00 UTC',
                  until: '2026-05-30 00:10:00 UTC',
                },
              },
            },
            {
              id: 'call-logs-2',
              name: 'execute_runbook',
              args: {
                runbookTitle: 'Check Logs in the Jagad backend server',
                parameterValues: {
                  since: '2026-05-30 00:10:00 UTC',
                  until: '2026-05-30 00:20:00 UTC',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I compared both requested windows.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Compare two explicit backend log windows.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'I compared both requested windows.',
    })
    const toolCalls = agentMessage.toolCalls
    const executionOutputs = toolCalls
      .filter((toolCall) => toolCall.toolName === 'execute_runbook')
      .map((toolCall) => toolCall.output ?? '')
    expect(executionOutputs).toHaveLength(2)
    expect(executionOutputs.join('\n')).toContain('33333333-3333-4333-8333-333333333331')
    expect(executionOutputs.join('\n')).toContain('33333333-3333-4333-8333-333333333332')
    expect(executionOutputs.join('\n')).toContain('"status": "running"')
  })

  it('returns the current runbook snapshot without waiting for its terminal state', async () => {
    const runningExecution = makeExecution({
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      status: 'running',
      completedAt: undefined,
      completionReason: undefined,
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'running',
        },
      ],
    })
    const completedExecution = makeExecution({
      ...runningExecution,
      status: 'completed',
      completedAt: '2026-05-26T01:00:30.000Z',
      completionReason: 'success',
      steps: [
        {
          ...(runningExecution.steps[0]),
          status: 'completed',
          output: 'Backend logs loaded for the Sentry window.',
        },
      ],
    })
    const runbookExecutionService = {
      start: vi.fn(),
      get: vi.fn().mockResolvedValue(runningExecution),
      waitForCompletion: vi.fn().mockResolvedValue(completedExecution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the backend log runbook.',
          toolCalls: [
            {
              id: 'call-get',
              name: 'get_runbook_execution',
              args: { executionId: runningExecution.executionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The runbook is still running; its timeline will update independently.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore: { list: vi.fn().mockResolvedValue([]) },
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Inspect the backend log runbook.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => {
      const lastMessage = service.getSnapshot(sessionId).messages.at(-1)
      return lastMessage?.kind === 'agent' && lastMessage.finalText?.includes('is still running') === true
    })
  })

  it('finishes the conversation without extending its timeout for a runbook', async () => {
    const completedExecution = makeExecution({
      executionId: '99999999-9999-4999-8999-999999999999',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend logs were summarized after the timeout boundary.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: completedExecution.executionId,
        resultId: 'result-logs',
      }),
      waitForCompletion: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(completedExecution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the backend log runbook.',
          toolCalls: [
            {
              id: 'call-logs',
              name: 'execute_runbook',
              args: { runbookTitle: 'Check Logs in the Jagad backend server' },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I will inspect the runbook execution before summarizing it.',
          toolCalls: [
            {
              id: 'inspect-logs',
              name: 'get_runbook_execution',
              args: { executionId: completedExecution.executionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'The runbook completed after the timeout boundary.',
          toolCalls: [],
        }),
    }
    const sentEvents: AgentRuntimeEventPayload[] = []
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
      sentEvents,
    })

    const sessionId = await service.start({
      prompt: 'Check Jagad backend logs.',
      incidentThreadId: 'incident-timeout',
      timeoutMs: 100,
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'The runbook completed after the timeout boundary.',
    })
    const toolCalls = agentMessage.toolCalls
    const runbookCard = toolCalls.find((toolCall) => toolCall.toolName === 'execute_runbook')
    expect(runbookCard).toMatchObject({ state: 'done' })
    expect(runbookCard?.error).toBeUndefined()
    expect(runbookCard?.output).toContain('"status": "running"')
    expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
  })

  it('does not synthesize a runbook completion when a local provider stalls', async () => {
    vi.useFakeTimers()
    try {
      const completedExecution = makeExecution({
        executionId: '88888888-8888-4888-8888-888888888888',
        runbookId: 'rb-logs',
        runbookTitle: 'Check Logs in the Jagad backend server',
        steps: [
          {
            actionId: 'step-1',
            order: 1,
            type: 'shell',
            title: 'Check journalctl logs',
            status: 'completed',
            output: 'Backend logs were summarized without waiting on Sonnet.',
          },
        ],
      })
      const runbookStore = {
        list: vi.fn().mockResolvedValue([
          makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
            {
              id: 'step-1',
              type: 'shell',
              title: 'Check journalctl logs',
            },
          ]),
        ]),
      }
      const runbookExecutionService = {
        start: vi.fn().mockResolvedValue({
          executionId: completedExecution.executionId,
          resultId: 'result-logs',
        }),
        waitForCompletion: vi.fn().mockResolvedValue(completedExecution),
        get: vi.fn().mockResolvedValue(null),
        getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
      }
      let stalledFinalizationStarted = false
      const llmAdapter = {
        chatWithTools: vi
          .fn()
          .mockResolvedValueOnce({
            content: 'I will run the backend log runbook.',
            toolCalls: [
              {
                id: 'call-logs',
                name: 'execute_runbook',
                args: { runbookTitle: 'Check Logs in the Jagad backend server' },
              },
            ],
          })
          .mockImplementationOnce(
            ({ signal }: { signal: AbortSignal }) =>
              new Promise((resolve) => {
                stalledFinalizationStarted = true
                signal.addEventListener(
                  'abort',
                  () => {
                    resolve({ content: '', toolCalls: [] })
                  },
                  { once: true },
                )
              }),
          ),
      }
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter,
        runbookStore,
        runbookExecutionService,
        sentEvents,
      })

      const sessionId = await service.start({
        prompt: 'Check Jagad backend logs.',
        incidentThreadId: 'incident-local-timeout',
        llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flushPromises(1)
      }

      expect(stalledFinalizationStarted).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000)
      await flushPromises()

      expect(service.getStatus(sessionId).state).toBe('RUNNING')
      const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
      expect(agentMessage).toMatchObject({ kind: 'agent' })
      const visibleText = agentMessage.iterations.at(-1)?.text ?? agentMessage.finalText ?? ''
      expect(agentMessage.status).not.toBe('done')
      expect(visibleText).not.toContain('Backend logs were summarized without waiting on Sonnet.')
      expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not claim a completed response when a local provider stalls after listing runbooks', async () => {
    vi.useFakeTimers()
    try {
      const runbookStore = {
        list: vi.fn().mockResolvedValue([
          makeRunbook('rb-sentry', 'Investigate Sentry', [
            { id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' },
          ]),
        ]),
      }
      let stalledFinalizationStarted = false
      const llmAdapter = {
        chatWithTools: vi
          .fn()
          .mockResolvedValueOnce({
            content: 'I will list the available runbooks.',
            toolCalls: [{ id: 'call-list-runbooks', name: 'list_runbooks', args: {} }],
          })
          .mockImplementationOnce(
            ({ signal }: { signal: AbortSignal }) =>
              new Promise((resolve) => {
                stalledFinalizationStarted = true
                signal.addEventListener(
                  'abort',
                  () => resolve({ content: '', toolCalls: [] }),
                  { once: true },
                )
              }),
          ),
      }
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter,
        runbookStore,
        runbookExecutionService: {
          start: vi.fn(),
          waitForCompletion: vi.fn(),
          get: vi.fn().mockResolvedValue(null),
          getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
        },
        sentEvents,
      })

      const sessionId = await service.start({
        prompt: 'Find the available runbooks.',
        incidentThreadId: 'incident-list-timeout',
        llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flushPromises(1)
      }

      expect(stalledFinalizationStarted).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000)
      await flushPromises()

      expect(service.getStatus(sessionId).state).toBe('RUNNING')
      const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
      const visibleText = agentMessage.iterations.at(-1)?.text ?? agentMessage.finalText ?? ''
      expect(agentMessage.status).not.toBe('done')
      expect(visibleText).not.toContain('Completed runbook output:')
      expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not append an execution result when Cursor stops after a start acknowledgement', async () => {
    const completedExecution = makeExecution({
      executionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'llm',
          title: 'Make an AI summarization out of the results',
          status: 'completed',
          output: '# Error Matrix Table\n\n| Issue ID | Root Cause Analysis |\n| --- | --- |\n| LOG-001 | Missing bot startup artifact. |',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'llm',
            title: 'Make an AI summarization out of the results',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: completedExecution.executionId,
        resultId: 'result-logs',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(completedExecution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the backend log runbook.',
          toolCalls: [
            {
              id: 'call-logs',
              name: 'execute_runbook',
              args: { runbookTitle: 'Check Logs in the Jagad backend server' },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: "Both runbooks completed; I'll fetch the full backend log runbook output.",
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Check Jagad backend logs.',
      incidentThreadId: 'incident-cursor-no-result',
      llm: { providerKey: 'cursor', model: 'composer-2.5' },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    const visibleText = agentMessage.finalText ?? agentMessage.iterations.at(-1)?.text ?? ''
    expect(visibleText).toContain("Both runbooks completed; I'll fetch")
    expect(visibleText).not.toContain('Completed runbook output:')
    expect(visibleText).not.toContain('| LOG-001 | Missing bot startup artifact. |')
  })

  it('shows a completed local runbook result once when the model inspects the same execution again', async () => {
    const completedExecution = makeExecution({
      executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'completed',
          output: 'Backend logs matched the Sentry window.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-logs', 'Check Logs in the Jagad backend server', [
          {
            id: 'step-1',
            type: 'shell',
            title: 'Check journalctl logs',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: completedExecution.executionId,
        resultId: 'result-logs',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(completedExecution),
      get: vi.fn().mockResolvedValue(completedExecution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will run the backend log runbook.',
          toolCalls: [
            {
              id: 'call-logs',
              name: 'execute_runbook',
              args: { runbookTitle: 'Check Logs in the Jagad backend server' },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I will inspect the same runbook execution.',
          toolCalls: [
            {
              id: 'get-logs',
              name: 'get_runbook_execution',
              args: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Summary: the backend logs match the Sentry window.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Check Jagad backend logs.',
      incidentThreadId: 'incident-local-dedupe',
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({ kind: 'agent', status: 'done' })
    const visibleText = agentMessage.finalText ?? agentMessage.iterations.at(-1)?.text ?? ''
    expect(visibleText).toContain('Backend logs matched the Sentry window.')
    expect(visibleText).toContain('Summary: the backend logs match the Sentry window.')
    expect(visibleText.match(/Runbook result: Check Logs in the Jagad backend server/g) ?? []).toHaveLength(1)
  })

  it('stops with a waiting status instead of polling a running runbook again', async () => {
    const runningExecution = makeExecution({
      runbookId: 'rb-logs',
      runbookTitle: 'Check Logs in the Jagad backend server',
      status: 'running',
      completedAt: undefined,
      completionReason: undefined,
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Check journalctl logs',
          status: 'running',
        },
      ],
    })
    const runbookExecutionService = {
      start: vi.fn(),
      get: vi.fn().mockResolvedValue(runningExecution),
      waitForCompletion: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect whether the log runbook has finished.',
          toolCalls: [
            {
              id: 'call-get',
              name: 'get_runbook_execution',
              args: { executionId: runningExecution.executionId },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'This should not be reached while the runbook is still running.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore: { list: vi.fn().mockResolvedValue([]) },
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Check whether the backend log runbook is done.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
    const lastMessage = service.getSnapshot(sessionId).messages.at(-1)
    expect(lastMessage?.kind).toBe('agent')
    if (lastMessage?.kind === 'agent') {
      expect(lastMessage.finalText).toContain('is still running')
      expect(lastMessage.finalText).not.toContain('should not be reached')
    }
  })

  it('keeps concurrent incident runbook starts isolated', async () => {
    const slowRunning = makeExecution({
      executionId: '11111111-1111-4111-8111-111111111111',
      runbookId: 'rb-slow',
      runbookTitle: 'Slow incident runbook',
      status: 'running',
      completedAt: undefined,
      completionReason: undefined,
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'shell',
          title: 'Slow check',
          status: 'running',
        },
      ],
    })
    const fastCompleted = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      runbookId: 'rb-fast',
      runbookTitle: 'Fast incident runbook',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'http',
          title: 'Fast check',
          status: 'completed',
          output: 'Fast incident finished.',
        },
      ],
    })
    const runbookStore = {
      list: vi
        .fn()
        .mockResolvedValue([
          makeRunbook('rb-slow', 'Slow incident runbook', [
            { id: 'step-1', type: 'shell', title: 'Slow check' },
          ]),
          makeRunbook('rb-fast', 'Fast incident runbook', [{ id: 'step-1', type: 'http', title: 'Fast check' }]),
        ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockImplementation((runbookId: string) => {
        if (runbookId === 'rb-slow') {
          return {
            executionId: slowRunning.executionId,
            resultId: 'result-slow',
          }
        }

        return {
          executionId: fastCompleted.executionId,
          resultId: 'result-fast',
        }
      }),
      waitForCompletion: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    let slowRunbookStarted = false
    let fastRunbookStarted = false
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockImplementation(({ messages }: { messages: Array<{ role?: string; content: unknown }> }) => {
          const text = messages.map((message) => String(message.content)).join('\n')
          if (text.includes('slow') && slowRunbookStarted) {
            return Promise.resolve({
              content: 'The slow incident request remains isolated from the fast incident request.',
              toolCalls: [],
            })
          }
          if (!text.includes('slow') && fastRunbookStarted) {
            return Promise.resolve({
              content: 'The fast incident request remains isolated from the slow incident request.',
              toolCalls: [],
            })
          }
          if (text.includes('slow')) {
            slowRunbookStarted = true
            return Promise.resolve({
              content: 'I will start the slow runbook.',
              toolCalls: [
                {
                  id: 'call-slow',
                  name: 'execute_runbook',
                  args: { runbookTitle: 'Slow incident runbook' },
                },
              ],
            })
          }
          fastRunbookStarted = true
          return Promise.resolve({
            content: 'I will start the fast runbook.',
            toolCalls: [
              {
                id: 'call-fast',
                name: 'execute_runbook',
                args: { runbookTitle: 'Fast incident runbook' },
              },
            ],
          })
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const slowSessionId = await service.start({
      prompt: 'Start the slow incident.',
      incidentThreadId: 'incident-slow',
    })
    await waitForCondition(() => service.getStatus(slowSessionId).state === 'COMPLETED')

    const fastSessionId = await service.start({
      prompt: 'Start the fast incident.',
      incidentThreadId: 'incident-fast',
    })
    await waitForCondition(() => service.getStatus(fastSessionId).state === 'COMPLETED')
    expect(service.getSnapshot(fastSessionId).messages.at(-1)).toMatchObject({
      kind: 'agent',
      finalText: 'The fast incident request remains isolated from the slow incident request.',
    })

    expect(service.getSnapshot(slowSessionId).messages.at(-1)).toMatchObject({
      kind: 'agent',
      finalText: 'The slow incident request remains isolated from the fast incident request.',
    })
    expect(getRunbookStartCalls(runbookExecutionService.start).map(([, options]) => options.incidentThreadId)).toEqual([
      'incident-slow',
      'incident-fast',
    ])
  })

  it('rejects starting a second active session for the same incident thread', async () => {
    const pendingResponse = new Promise<never>(() => {})
    const llmAdapter = {
      chatWithTools: vi.fn().mockReturnValue(pendingResponse),
    }
    const service = createRuntime({
      llmAdapter,
    })

    const sessionId = await service.start({
      prompt: 'Start investigating Jagad.',
      incidentThreadId: 'incident-dup',
    })

    expect(service.getStatus(sessionId).state).toBe('RUNNING')
    await expect(
      service.start({
        prompt: 'Start another investigation on the same incident.',
        incidentThreadId: 'incident-dup',
      }),
    ).rejects.toThrow(
      'An agent session is already running for this incident. Wait for it to finish or cancel it before starting another response.',
    )

    service.cancel(sessionId)
  })

  it('delivers a follow-up queued while an incident turn is active', async () => {
    let resolveFirstResponse: ((response: { content: string; toolCalls: [] }) => void) | undefined
    const firstResponse = new Promise<{ content: string; toolCalls: [] }>((resolve) => {
      resolveFirstResponse = resolve
    })
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockReturnValueOnce(firstResponse)
        .mockResolvedValueOnce({
          content: 'The queued follow-up was delivered.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
    })

    const sessionId = await service.start({
      prompt: 'Start investigating Jagad.',
      incidentThreadId: 'incident-reuse',
    })

    await expect(
      service.send({
        message: 'What was the result?',
        incidentThreadId: 'incident-reuse',
      }),
    ).resolves.toBe(sessionId)

    expect(service.getSnapshot(sessionId).messages).toHaveLength(2)
    resolveFirstResponse?.({ content: 'The first incident response is ready.', toolCalls: [] })

    await waitForCondition(() => {
      const messages = service.getSnapshot(sessionId).messages
      const lastMessage = messages.at(-1)
      return (
        lastMessage?.kind === 'agent' &&
        lastMessage.finalText === 'The queued follow-up was delivered.'
      )
    })

    expect(service.getSnapshot(sessionId).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'What was the result?' }),
        expect.objectContaining({ kind: 'agent', finalText: 'The first incident response is ready.' }),
      ]),
    )
  })

  it('executes duplicate tool call ids only once per assistant response', async () => {
    const execution = makeExecution()
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
    }
    const runbookExecutionService = {
      start: vi.fn(),
      waitForCompletion: vi.fn().mockResolvedValue(execution),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(execution),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'I will inspect the latest runbook result.',
          toolCalls: [
            {
              id: 'dup-get',
              name: 'get_runbook_execution',
              args: {},
            },
            {
              id: 'dup-get',
              name: 'get_runbook_execution',
              args: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Done.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Inspect the latest runbook result once.',
      incidentThreadId: 'incident-dedupe',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
    expect(agentMessage).toMatchObject({
      kind: 'agent',
      finalText: 'Done.',
    })
    const toolCalls = agentMessage.toolCalls
    expect(toolCalls.filter((toolCall) => toolCall.toolName === 'get_runbook_execution')).toHaveLength(1)
  })

  it('resumes a completed session with prior chat context for follow-up turns', async () => {
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          content: 'First answer.',
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: 'Follow-up answer using prior context.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({ llmAdapter })

    const sessionId = await service.start({ prompt: 'Check Jagad logs.' })
    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    await expect(
      service.send({
        sessionId,
        message: 'Continue.',
      }),
    ).resolves.toBe(sessionId)

    await waitForCondition(() => {
      const lastMessage = service.getSnapshot(sessionId).messages.at(-1)
      return lastMessage?.kind === 'agent' && lastMessage.finalText === 'Follow-up answer using prior context.'
    })
    const secondCallMessages = getSecondCallMessages(llmAdapter)
    expect(secondCallMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Check Jagad logs.' }),
        expect.objectContaining({
          role: 'assistant',
          content: 'First answer.',
        }),
        expect.objectContaining({ role: 'user', content: 'Continue.' }),
      ]),
    )
  })
})

describe('runtime projection outcomes', () => {
  it('projects explicit incident-chat activity through runbook start and summary handoff', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-activity',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'activity',
      timestamp: '2026-05-26T00:00:01.000Z',
      phase: 'asking_model',
    })
    expect(getLastAgentMessage(snapshot).activity).toBe('asking_model')

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'activity',
      timestamp: '2026-05-26T00:00:02.000Z',
      phase: 'running_runbook',
    })
    expect(getLastAgentMessage(snapshot).activity).toBe('running_runbook')

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'activity',
      timestamp: '2026-05-26T00:00:03.000Z',
      phase: 'waiting_for_summary',
    })
    expect(getLastAgentMessage(snapshot).activity).toBe('waiting_for_summary')

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'final',
      timestamp: '2026-05-26T00:00:04.000Z',
      response: 'The runbook is running; its timeline will update here.',
    })
    expect(getLastAgentMessage(snapshot).activity).toBeUndefined()
  })

  it('projects the final response over earlier planning text in the last iteration', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-1',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'thinking_start',
      timestamp: '2026-05-26T00:00:01.000Z',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'assistant_delta',
      timestamp: '2026-05-26T00:00:02.000Z',
      delta: 'I am checking the completed runbook details.',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'final',
      timestamp: '2026-05-26T00:00:03.000Z',
      response: 'The runbook completed and the backend logs were checked.',
    })

    const lastMessage = snapshot.messages.at(-1)
    expect(lastMessage?.kind).toBe('agent')
    if (lastMessage?.kind !== 'agent') {
      throw new Error('Expected the last message to be an agent message')
    }
    expect(lastMessage.finalText).toBe('The runbook completed and the backend logs were checked.')
    expect(lastMessage.iterations.at(-1)?.text).toBe('The runbook completed and the backend logs were checked.')
  })

  it('uses the full final response when it extends streamed post-tool answer text', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-1',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'tool_start',
      timestamp: '2026-05-26T00:00:01.000Z',
      toolName: 'execute_runbook',
      toolCallId: 'tool-1',
      input: {},
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'tool_end',
      timestamp: '2026-05-26T00:00:02.000Z',
      toolCallId: 'tool-1',
      state: 'COMPLETED',
      output: 'Runbook completed.',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'thinking_start',
      timestamp: '2026-05-26T00:00:03.000Z',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'assistant_delta',
      timestamp: '2026-05-26T00:00:04.000Z',
      delta: 'Here is the matrix',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'assistant_delta',
      timestamp: '2026-05-26T00:00:05.000Z',
      delta: ' with RCA.',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'final',
      timestamp: '2026-05-26T00:00:06.000Z',
      response: 'Here is the matrix with RCA.\n\nExtra final-only note.',
    })

    const lastMessage = snapshot.messages.at(-1)
    expect(lastMessage?.kind).toBe('agent')
    if (lastMessage?.kind !== 'agent') {
      throw new Error('Expected the last message to be an agent message')
    }
    expect(lastMessage.finalText).toBe('Here is the matrix with RCA.\n\nExtra final-only note.')
    const finalIteration = lastMessage.iterations.at(-1)
    expect(finalIteration?.text).toBe('Here is the matrix with RCA.\n\nExtra final-only note.')
    expect(finalIteration?.streamDeltas?.map((delta) => delta.text)).toEqual([
      'Here is the matrix',
      ' with RCA.',
    ])
  })

  it('preserves visible runbook output when the final event only completes the turn', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-1',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'thinking_start',
      timestamp: '2026-05-26T00:00:01.000Z',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'assistant_delta',
      timestamp: '2026-05-26T00:00:02.000Z',
      delta: 'Runbook result: Check Logs in the Jagad backend server\n\nBackend logs are ready.',
      kind: 'command_output',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'final',
      timestamp: '2026-05-26T00:00:03.000Z',
      response: '',
    })

    const lastMessage = snapshot.messages.at(-1)
    expect(lastMessage?.kind).toBe('agent')
    if (lastMessage?.kind !== 'agent') {
      throw new Error('Expected the last message to be an agent message')
    }
    expect(lastMessage.status).toBe('done')
    expect(lastMessage.finalText).toBeNull()
    expect(lastMessage.iterations.at(-1)?.text).toContain('Backend logs are ready.')
  })

  it('appends final model text after visible runbook output instead of replacing it', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-1',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'thinking_start',
      timestamp: '2026-05-26T00:00:01.000Z',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'assistant_delta',
      timestamp: '2026-05-26T00:00:02.000Z',
      delta: 'Runbook result: Check Logs in the Jagad backend server\n\nBackend logs are ready.',
      kind: 'command_output',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'final',
      timestamp: '2026-05-26T00:00:03.000Z',
      response: 'Summary: the backend logs match the Sentry window.',
    })

    const lastMessage = snapshot.messages.at(-1)
    expect(lastMessage?.kind).toBe('agent')
    if (lastMessage?.kind !== 'agent') {
      throw new Error('Expected the last message to be an agent message')
    }
    expect(lastMessage.finalText).toContain('Backend logs are ready.')
    expect(lastMessage.finalText).toContain('Summary: the backend logs match the Sentry window.')
    expect(lastMessage.iterations.at(-1)?.text).toBe(lastMessage.finalText)
  })

  it('projects runbook model context separately from raw tool output for tool cards', () => {
    let snapshot = createAgentThreadSnapshot({
      sessionId: 'session-1',
      startedAt: '2026-05-26T00:00:00.000Z',
      runtimeState: 'RUNNING',
      prompt: 'Check Jagad logs.',
    })

    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'thinking_start',
      timestamp: '2026-05-26T00:00:01.000Z',
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'tool_start',
      timestamp: '2026-05-26T00:00:02.000Z',
      toolCallId: 'call-1',
      toolName: 'execute_runbook',
      input: { runbookTitle: "Retrieve errors from Jagad's Sentry" },
    })
    snapshot = reduceAgentThreadSnapshot(snapshot, {
      type: 'tool_end',
      timestamp: '2026-05-26T00:00:03.000Z',
      toolCallId: 'call-1',
      state: 'COMPLETED',
      output: '{"status":"completed"}',
      modelContext:
        'Internal runbook execution update:\n- Derived journalctl time window: since="2026-05-26 00:54:00 UTC", until="2026-05-26 01:04:00 UTC".',
    })

    const lastMessage = getLastAgentMessage(snapshot)
    const firstToolCall = lastMessage.toolCalls[0]
    expect(firstToolCall.output).toBe('{"status":"completed"}')
    expect(firstToolCall.modelContext).toEqual(
      expect.stringContaining('Derived journalctl time window'),
    )
  })

  it('executes Claude list, run, and matching inspection through MCP before accepting the outcome', async () => {
    const execution = makeExecution({
      executionId: '88888888-8888-4888-8888-888888888888',
      runbookId: 'rb-sentry',
      runbookTitle: 'Sentry Desktop Error Check',
      steps: [
        {
          actionId: 'step-1',
          order: 1,
          type: 'external_source',
          title: 'List recent Sentry issues',
          status: 'completed',
          input: { projectSlugs: ['desktop'] },
          output: 'Fetched 5 Sentry issues.',
        },
      ],
    })
    const runbookStore = {
      list: vi.fn().mockResolvedValue([
        makeRunbook('rb-sentry', 'Sentry Desktop Error Check', [
          {
            id: 'step-1',
            type: 'external_source',
            title: 'List recent Sentry issues',
          },
        ]),
      ]),
    }
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: execution.executionId,
        resultId: 'result-sentry',
      }),
      waitForCompletion: vi.fn().mockResolvedValue(execution),
      get: vi.fn().mockResolvedValue(execution),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi.fn().mockImplementation(async (input: LlmChatRequest) => {
        const context = input.hostToolContext
        if (context === undefined) {
          throw new Error('Expected Claude MCP host-tool context')
        }

        await executeHostTool(context, 'list_runbooks', {})
        const runResult = await executeHostTool(context, 'execute_runbook', {
          runbookTitle: 'Sentry Desktop Error Check',
        })
        expect(runResult?.output).toContain(execution.executionId)
        const inspectResult = await executeHostTool(context, 'get_runbook_execution', {
          executionId: execution.executionId,
          waitForCompletion: true,
        })
        expect(inspectResult?.output).toContain('Fetched 5 Sentry issues.')

        return {
          content: 'Sentry Desktop Error Check completed successfully after fetching 5 issues.',
          toolCalls: [],
          toolProtocol: 'mcp' as const,
        }
      }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt:
        'Use the host tools to list, execute, and inspect the relevant error-check runbook.',
      incidentThreadId: 'incident-claude-mcp',
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-5' },
      accessLevel: 'auto-accept-edits',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(llmAdapter.chatWithTools).toHaveBeenCalledTimes(1)
    expect(runbookExecutionService.waitForCompletion).toHaveBeenCalledWith(execution.executionId, {
      timeoutMs: 30_000,
    })
    const finalText = getLastAgentMessage(service.getSnapshot(sessionId)).finalText
    expect(finalText).toContain('Runbook result: Sentry Desktop Error Check')
    expect(finalText).toContain(
      'Sentry Desktop Error Check completed successfully after fetching 5 issues.',
    )
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'list_runbooks', state: 'done' }),
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
      expect.objectContaining({
        toolName: 'get_runbook_execution',
        state: 'done',
        output: expect.stringContaining('Fetched 5 Sentry issues.'),
      }),
    ])
  })
})
