import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
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
  RunbookParameterValues,
  RunbookRecord,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook-ce.types'
import type { RunbookAuthoringProposal } from '@bitsentry-ce/core/features/runbooks/authoring'
import type { RunbookAuthoringProposalPersistence } from '@bitsentry-ce/core/features/runbooks'
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
    proposalId: (await service.listRunbookAuthoringProposals({ sessionId }))[0]!.proposalId,
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
  authoringProposalStore?: RunbookAuthoringProposalPersistence
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
    undefined,
    options.authoringProposalStore,
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


type ScriptedToolCall = { id: string; name: string; args: Record<string, unknown> }
type StartInput = Parameters<AgentRuntimeService['start']>[0]

const CODEX = { providerKey: 'codex', model: 'gpt-5.4-mini' } as const
const CLAUDE_SONNET_4_6 = { providerKey: 'claude_code', model: 'claude-sonnet-4-6' } as const
const CLAUDE_SONNET_5 = { providerKey: 'claude_code', model: 'claude-sonnet-5' } as const
const LOGS_TITLE = 'Check Logs in the Jagad backend server'
const SENTRY_TITLE = "Retrieve errors from Jagad's Sentry"

const tool = (id: string, name: string, args: Record<string, unknown> = {}): ScriptedToolCall => ({ id, name, args })

function scriptedLlm(...replies: Array<{ content: string; toolCalls?: ScriptedToolCall[] } | Error>) {
  const chatWithTools = vi.fn()
  for (const reply of replies) {
    if (reply instanceof Error) chatWithTools.mockRejectedValueOnce(reply)
    else chatWithTools.mockResolvedValueOnce({ toolCalls: [], ...reply })
  }
  return { chatWithTools }
}

function executionService(overrides: Partial<Record<keyof TestRunbookExecutionService, Mock>> = {}) {
  return {
    start: vi.fn(),
    waitForCompletion: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

const startsAs = (...executions: RunbookExecutionRecord[]) => vi.fn().mockImplementation((runbookId: string) => {
  const execution = executions.find((candidate) => candidate.runbookId === runbookId) ?? executions[0]!
  return Promise.resolve({ executionId: execution.executionId, resultId: `result-${execution.executionId}` })
})
const findsById = (...executions: RunbookExecutionRecord[]) => vi.fn().mockImplementation((executionId: string) => (
  Promise.resolve(executions.find((candidate) => candidate.executionId === executionId) ?? null)
))
const listing = (...runbooks: RunbookRecord[]) => ({ list: vi.fn().mockResolvedValue(runbooks) })

const logsRunbook = () => makeRunbook('rb-logs', LOGS_TITLE, [{ id: 'step-1', type: 'shell', title: 'Check journalctl logs' }])
const sentryRunbook = () => makeRunbook('rb-sentry', SENTRY_TITLE, [{ id: 'step-1', type: 'external_source', title: 'Retrieve errors from Sentry' }])

function logsExecution(executionId: string, output: string, overrides: Partial<RunbookExecutionRecord> = {}): RunbookExecutionRecord {
  return makeExecution({
    executionId,
    runbookId: 'rb-logs',
    runbookTitle: LOGS_TITLE,
    steps: [{ actionId: 'step-1', order: 1, type: 'shell', title: 'Check journalctl logs', status: 'completed', output }],
    ...overrides,
  })
}

async function runToEnd(service: AgentRuntimeService, input: StartInput): Promise<string> {
  const sessionId = await service.start(input)
  await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
  return sessionId
}

const lastAgent = (service: AgentRuntimeService, sessionId: string) => getLastAgentMessage(service.getSnapshot(sessionId))
const cardsNamed = (service: AgentRuntimeService, sessionId: string, toolName: string) => (
  lastAgent(service, sessionId).toolCalls.filter((toolCall) => toolCall.toolName === toolName)
)
const visibleToolText = (card: ToolCallCard | undefined) => [card?.error, card?.output, card?.modelContext].join('\n')

describe('AgentRuntimeService access levels', () => {
  it.each([
    { accessLevel: 'auto-accept-edits' as const, shouldExecuteShell: false },
    { accessLevel: 'full-access' as const, shouldExecuteShell: true },
  ])('gates API provider shell execution by access level: $accessLevel', async ({ accessLevel, shouldExecuteShell }) => {
    const llmAdapter = scriptedLlm(
      { content: 'I will inspect the working directory.', toolCalls: [tool('call-shell', 'execute_shell_command', { command: 'pwd' })] },
      { content: 'Inspection complete.' },
    )
    const service = createRuntime({ llmAdapter })

    const sessionId = await runToEnd(service, {
      prompt: 'Inspect the working directory.',
      accessLevel,
      llm: { providerKey: 'anthropic', model: 'claude-sonnet-4-6' },
      runbookContext: {
        id: 'runbook-shell',
        title: 'Print working directory',
        description: '',
        actions: [{ id: 'step-shell', type: 'shell', title: 'Print working directory', command: 'pwd' }],
      },
    })

    const restrictedToolNames = ['execute_shell_command', 'ssh_journal_query', 'list_log_sources', 'get_checkpoint']
    const firstRequest = llmAdapter.chatWithTools.mock.calls[0]?.[0]
    const availableToolNames = firstRequest?.tools.map((availableTool: { name: string }) => availableTool.name) ?? []
    const shellToolCall = getAllAgentToolCalls(service, sessionId).find((toolCall) => toolCall.toolName === 'execute_shell_command')
    expect(shellToolCall).toBeDefined()
    if (shouldExecuteShell) {
      expect(availableToolNames).toEqual(expect.arrayContaining(restrictedToolNames))
      expect(shellToolCall?.error).toBeUndefined()
      expect(shellToolCall?.output).toContain('/')
    } else {
      expect(availableToolNames).not.toEqual(expect.arrayContaining(restrictedToolNames))
      expect(shellToolCall?.error).toContain('unavailable to API providers in Safe Tools mode')
      expect(shellToolCall?.output).toBeUndefined()
    }
  })

  it('passes the session access level into agent-started runbooks', async () => {
    const execution = makeExecution({ runbookId: 'rb-summary', runbookTitle: 'Summarize runbook output' })
    const runbooks = executionService({ start: startsAs(execution), waitForCompletion: vi.fn().mockResolvedValue(execution) })
    const service = createRuntime({
      llmAdapter: scriptedLlm(
        { content: 'I will run the summary runbook.', toolCalls: [tool('call-summary', 'execute_runbook', { runbookTitle: 'Summarize runbook output' })] },
        { content: 'Summary complete.' },
      ),
      runbookStore: listing(makeRunbook('rb-summary', 'Summarize runbook output', [{ id: 'step-1', type: 'llm', title: 'Summarize' }])),
      runbookExecutionService: runbooks,
    })

    await runToEnd(service, { prompt: 'Run the summary runbook.', accessLevel: 'full-access' })

    expect(getRunbookStartCalls(runbooks.start)[0]?.[1].accessLevel).toBe('full-access')
  })
})

describe('AgentRuntimeService runbook authoring approvals', () => {
  const backendRunbook = () => makeRunbook('rb-logs', 'Check backend logs', [{ id: 'step-1', type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' }])
  const addUptime = { id: 'op-add-uptime', type: 'add_action', rationale: 'Collect uptime before log inspection.', action: { id: 'step-2', type: 'shell', title: 'Collect uptime', command: 'uptime' } }

  function editStore(list: Mock, saved?: RunbookRecord) {
    return { list, create: vi.fn(), updateMeta: vi.fn().mockResolvedValue(saved), updateActions: vi.fn().mockResolvedValue(saved), remove: vi.fn() }
  }

  async function proposeEdit(runbookStore: ReturnType<typeof editStore>, operations: unknown[], onRunbooksChanged?: () => void) {
    const service = createRuntime({
      llmAdapter: scriptedLlm(
        { content: 'I will draft an edit for review.', toolCalls: [tool('call-propose-edit', 'propose_runbook_edit', { runbookId: 'rb-logs', prompt: 'Add an uptime check.', operations })] },
        { content: 'The proposal requires approval.' },
      ),
      runbookStore,
      runbookExecutionService: executionService(),
      onRunbooksChanged,
    })
    const sessionId = await runToEnd(service, { prompt: 'Update the backend runbook.', incidentThreadId: 'incident-authoring' })
    const proposal = (await service.listRunbookAuthoringProposals({ sessionId }))[0]!
    return {
      proposal,
      approve: (approvedOperationIds?: string[]) => service.approveRunbookAuthoringProposal({
        sessionId,
        proposalId: proposal.proposalId,
        ...(approvedOperationIds === undefined ? {} : { approvedOperationIds }),
      }),
    }
  }

  it('places approved authoring outcomes in the next-turn session context', async () => {
    const title = `Generated runbook ${randomUUID()}`
    const { store } = createInMemoryAuthoringStore()
    const llmAdapter = makeCreationAuthoringLlmAdapter(title)
    llmAdapter.chatWithTools.mockResolvedValueOnce({ content: 'Acknowledged.', toolCalls: [] })
    const service = createRuntime({ llmAdapter, runbookStore: store as unknown as { list(): Promise<RunbookRecord[]> }, runbookExecutionService: executionService() })
    const sessionId = await runToEnd(service, { prompt: `Create ${title}.`, incidentThreadId: `incident-${randomUUID()}` })
    const proposal = (await service.listRunbookAuthoringProposals({ sessionId }))[0]!

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
    const runbookStore = editStore(vi.fn().mockResolvedValue([backendRunbook()]))
    const { proposal, approve } = await proposeEdit(runbookStore, [addUptime])
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
    expect(proposal).toMatchObject({ approvalRequired: true, saved: false, status: 'pending_approval', targetRunbookId: 'rb-logs' })

    runbookStore.list.mockResolvedValue([{ ...backendRunbook(), revisionNumber: 2, description: 'Updated outside the proposal.' }])
    await expect(approve()).rejects.toThrow('changed after the authoring proposal was created')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('rechecks an edit proposal immediately before persistence', async () => {
    const changedRunbook = { ...backendRunbook(), revisionNumber: 2, description: 'Updated after the approval was checked.' }
    const runbookStore = editStore(vi.fn()
      .mockResolvedValueOnce([backendRunbook()])
      .mockResolvedValueOnce([backendRunbook()])
      .mockResolvedValueOnce([changedRunbook]))
    const { approve } = await proposeEdit(runbookStore, [addUptime])

    await expect(approve()).rejects.toThrow('changed after the authoring proposal was created')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('persists only selected authoring operations', async () => {
    const savedRunbook = { ...backendRunbook(), title: 'Check backend logs and uptime' }
    const runbookStore = editStore(vi.fn().mockResolvedValue([backendRunbook()]), savedRunbook)
    const onRunbooksChanged = vi.fn()
    const { approve } = await proposeEdit(runbookStore, [
      { id: 'op-title', type: 'update_metadata', rationale: 'Clarify that uptime is covered.', metadata: { title: 'Check backend logs and uptime' } },
      addUptime,
    ], onRunbooksChanged)

    await expect(approve(['op-title'])).resolves.toMatchObject({ savedRunbook: { title: 'Check backend logs and uptime', actions: [{ id: 'step-1' }] } })
    expect(runbookStore.updateActions).toHaveBeenCalledWith({
      runbookId: 'rb-logs',
      actions: [expect.objectContaining({ id: expect.any(String), type: 'shell', title: 'Check service status', command: 'systemctl status bitsentry' })],
    })
    expect((runbookStore.updateActions.mock.calls[0]?.[0] as { actions: Array<{ id: string }> }).actions[0]?.id).not.toBe('step-1')
    expect(onRunbooksChanged).toHaveBeenCalledTimes(1)
  })

  it('does not persist an invalid approved result', async () => {
    const runbookStore = editStore(vi.fn().mockResolvedValue([backendRunbook()]))
    const { approve } = await proposeEdit(runbookStore, [
      { id: 'op-break-shell', type: 'update_action', rationale: 'This should be rejected during approval.', actionId: 'step-1', action: { id: 'step-1', type: 'shell', title: 'Broken shell action', command: '' } },
    ])

    await expect(approve()).rejects.toThrow('produce an invalid runbook')
    expect(runbookStore.create).not.toHaveBeenCalled()
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('approves proposals with identical model action ids without reusing a stored primary key', async () => {
    const { store, rows } = createInMemoryAuthoringStore()
    const first = await createPendingRunbookAuthoringProposal(store, 'First status runbook')
    const second = await createPendingRunbookAuthoringProposal(store, 'Second status runbook')

    const firstResult = await first.service.approveRunbookAuthoringProposal({ sessionId: first.sessionId, proposalId: first.proposalId })
    const secondResult = await second.service.approveRunbookAuthoringProposal({ sessionId: second.sessionId, proposalId: second.proposalId })

    const persistedActionIds = [...rows.values()].flatMap((row) => row.runbook.actions.map((action) => action.id))
    expect(rows).toHaveLength(2)
    expect(new Set(persistedActionIds).size).toBe(2)
    expect(persistedActionIds).not.toContain('update-claude-code')
    expect(firstResult.savedRunbook?.actions[0]?.id).not.toBe('update-claude-code')
    expect(secondResult.savedRunbook?.actions[0]?.id).not.toBe('update-claude-code')
  })

  it('purges a failed create attempt and lets the same pending approval converge on retry', async () => {
    const { store, rows } = createInMemoryAuthoringStore({ failAfterActionWriteCount: 1 })
    const pending = await createPendingRunbookAuthoringProposal(store, 'Retry status runbook')
    const approve = () => pending.service.approveRunbookAuthoringProposal({ sessionId: pending.sessionId, proposalId: pending.proposalId })

    await expect(approve()).rejects.toThrow('simulated post-write failure')
    expect(rows).toHaveLength(0)

    await expect(approve()).resolves.toMatchObject({ savedRunbook: { title: 'Retry status runbook' } })
    expect(rows).toHaveLength(1)
    expect([...rows.values()][0]?.runbook.actions).toHaveLength(1)
  })

  itWithDesktopSqlite('persists an approval through the real SQLite store after every action row is written', async () => {
    const service = createRuntime({
      llmAdapter: scriptedLlm(
        { content: 'I will draft a runbook for review.', toolCalls: [tool('call-propose-create', 'propose_runbook_create', { prompt: 'Create a status runbook.', draftRunbook: { title: 'New runbook', description: 'Collect status.', actions: [{ id: 'update-claude-code', type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry', parameters: [{ id: 'target-host', key: 'host' }] }, { id: 'update-codex', type: 'shell', title: 'Collect uptime', command: 'uptime' }] } })] },
        { content: 'The proposal requires approval.' },
      ),
      runbookStore: await createSqliteRunbookStore(),
      runbookExecutionService: executionService(),
    })
    const sessionId = await runToEnd(service, { prompt: 'Create a status runbook.', incidentThreadId: 'incident-authoring' })
    const proposal = (await service.listRunbookAuthoringProposals({ sessionId }))[0]!

    const saved = (await service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).savedRunbook

    expect(saved).toMatchObject({ title: 'New runbook', actions: [{ title: 'Collect status' }, { title: 'Collect uptime' }] })
    expect(saved?.actions.map((action) => action.id)).not.toContain('update-claude-code')
    expect(saved?.actions.map((action) => action.id)).not.toContain('update-codex')
    expect(saved?.actions[0]?.parameters?.[0]?.id).not.toBe('target-host')
    expect(proposal.proposedRunbook.actions.map((action) => action.id)).toEqual(['update-claude-code', 'update-codex'])
  })

  it('persists a store-valid creation proposal with an idle timeout in minutes', async () => {
    const createdRunbook = { ...makeRunbook('rb-new', 'New runbook', []), idleTimeout: 30 }
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(createdRunbook),
      updateMeta: vi.fn(),
      updateActions: vi.fn().mockResolvedValue({ ...createdRunbook, actions: [{ id: 'step-1', type: 'shell' as const, title: 'Collect status', command: 'systemctl status bitsentry' }] }),
      remove: vi.fn(),
    }
    const service = createRuntime({
      llmAdapter: scriptedLlm(
        { content: 'I will draft a runbook for review.', toolCalls: [tool('call-propose-create', 'propose_runbook_create', { prompt: 'Create a status runbook.', draftRunbook: { title: 'New runbook', description: 'Collect status.', idleTimeout: 30, actions: [{ id: 'step-1', type: 'shell', title: 'Collect status', command: 'systemctl status bitsentry' }] } })] },
        { content: 'The proposal requires approval.' },
      ),
      runbookStore,
      runbookExecutionService: executionService(),
    })
    const sessionId = await runToEnd(service, { prompt: 'Create a status runbook.', incidentThreadId: 'incident-authoring' })
    const proposal = (await service.listRunbookAuthoringProposals({ sessionId }))[0]!

    await expect(service.approveRunbookAuthoringProposal({ sessionId, proposalId: proposal.proposalId })).resolves.toMatchObject({
      savedRunbook: { id: 'rb-new', idleTimeout: 30 },
    })
    expect(runbookStore.create).toHaveBeenCalledWith(expect.objectContaining({ idleTimeout: 30 }))
  })
})

describe('incident chat runbook journeys', () => {
  it('runs a runbook the operator names only when asked and with the parameters they give', async () => {
    const kanye = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333333',
      runbookId: 'rb-kanye-rest',
      runbookTitle: 'Kanye Rest',
      steps: [{ actionId: 'step-1', order: 1, type: 'llm', title: 'Read Kanye Rest output', status: 'completed', output: 'Kanye Rest said the service is healthy.' }],
    })
    const backendLogs = makeExecution({
      executionId: '44444444-4444-4444-8444-444444444444',
      runbookId: 'rb-backend-logs',
      runbookTitle: 'Check Backend Logs',
      steps: [{ actionId: 'step-1', order: 1, type: 'shell', title: 'Read backend logs', status: 'completed', output: 'Backend logs were checked for the requested window.' }],
    })
    const replies: Array<[prompt: string, reply: string]> = [
      ['Should we run Kanye Rest?', 'You may want to run Kanye Rest if you need the latest result.'],
      ['Run Check Backend Logs.', 'I will run Check Backend Logs with the supplied window.'],
      ['Run Check Backend Logs since 2026-05-28 09:15 UTC until 2026-05-28 09:25 UTC.', 'Backend logs were checked for the requested window.'],
      ['Hey, can you please figure out what Kanye Rest said?', 'I will show the Kanye Rest runbook results: service healthy.'],
    ]
    const llmAdapter = {
      chatWithTools: vi.fn().mockImplementation(({ messages }: LlmChatRequest) => Promise.resolve({
        content: replies.find(([prompt]) => messages.some((message) => message.role === 'user' && String(message.content).includes(prompt)))?.[1] ?? '',
        toolCalls: [],
      })),
    }
    const runbooks = executionService({ start: startsAs(kanye, backendLogs), waitForCompletion: findsById(kanye, backendLogs) })
    const sentEvents: AgentRuntimeEventPayload[] = []
    const service = createRuntime({
      llmAdapter,
      runbookStore: listing(
        makeRunbook('rb-kanye-rest', 'Kanye Rest', [{ id: 'step-1', type: 'llm', title: 'Read Kanye Rest output', prompt: 'Summarize Kanye Rest.' }]),
        makeRunbook('rb-backend-logs', 'Check Backend Logs', [{
          id: 'step-1',
          type: 'shell',
          title: 'Read backend logs',
          command: 'journalctl --since {{since}} --until {{until}}',
          parameters: [{ id: 'since-param', key: 'since', required: true }, { id: 'until-param', key: 'until', required: true }],
        }]),
      ),
      runbookExecutionService: runbooks,
      sentEvents,
    })

    // Asking whether to run it, or naming a runbook without its required parameters, starts nothing.
    await runToEnd(service, { prompt: 'Should we run Kanye Rest?', incidentThreadId: 'incident-kanye-question', llm: CODEX })
    await runToEnd(service, { prompt: 'Run Check Backend Logs.', incidentThreadId: 'incident-logs-missing', llm: CODEX })
    expect(runbooks.start).not.toHaveBeenCalled()
    expect(getLlmCallMessages(llmAdapter, 0).some((message) => message.role === 'tool')).toBe(false)

    // Parameters in the prompt are passed to the runbook the operator named.
    await runToEnd(service, { prompt: replies[2]![0], incidentThreadId: 'incident-logs', llm: CODEX })
    expect(runbooks.start).toHaveBeenLastCalledWith('rb-backend-logs', expect.objectContaining({
      parameterValues: { since: '2026-05-28 09:15 UTC', until: '2026-05-28 09:25 UTC' },
    }))

    // An exactly named runbook starts before the model is asked, and the model is told it is running.
    const llmCallsBefore = llmAdapter.chatWithTools.mock.calls.length
    const sessionId = await runToEnd(service, { prompt: replies[3]![0], incidentThreadId: 'incident-kanye', llm: CODEX })
    expect(runbooks.start).toHaveBeenLastCalledWith('rb-kanye-rest', expect.objectContaining({ incidentThreadId: 'incident-kanye', source: 'agent' }))
    expect(getAllAgentToolCalls(service, sessionId)).toEqual([
      expect.objectContaining({ toolName: 'execute_runbook', state: 'done', output: expect.stringContaining(kanye.executionId) }),
    ])
    expect(sentEvents.some((payload) => (
      payload.sessionId === sessionId && payload.event.type === 'tool_start' && payload.event.toolName === 'execute_runbook'
    ))).toBe(true)
    expect(llmAdapter.chatWithTools.mock.calls).toHaveLength(llmCallsBefore + 1)
    const kanyeMessages = getLlmCallMessages(llmAdapter, llmCallsBefore)
    expect(kanyeMessages.some((message) => message.role === 'tool')).toBe(false)
    expect(getRequiredSystemContent(kanyeMessages, 'This was app-owned runbook runtime behavior, not an AI-requested tool call.')).toContain('- Status: running')
  })

  it('lists, runs and inspects runbooks for every provider protocol and shows each result once', async () => {
    // Codex lists runbooks; the answer reads like a list, once, without a runbook-output banner.
    {
      const llmAdapter = scriptedLlm(
        { content: 'I will list the available runbooks.', toolCalls: [tool('call-list-runbooks', 'list_runbooks')] },
        { content: 'Available runbooks:\n\n- Investigate Sentry — 2 actions' },
      )
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(makeRunbook('rb-sentry', 'Investigate Sentry', [
          { id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' },
          { id: 'step-2', type: 'llm', title: 'Summarize findings' },
        ])),
        runbookExecutionService: executionService(),
      })
      const sessionId = await runToEnd(service, { prompt: 'What runbooks can I use?', incidentThreadId: 'incident-runbook-list', llm: CODEX })

      const finalText = lastAgent(service, sessionId).finalText
      expect(finalText).toContain('Investigate Sentry')
      expect(finalText?.match(/Available runbooks/gi) ?? []).toHaveLength(1)
      expect(finalText).not.toContain('Completed runbook output:')
      expect(getAllAgentToolCalls(service, sessionId)).toEqual([expect.objectContaining({ toolName: 'list_runbooks', state: 'done' })])
      expect(getRequiredToolContent(getSecondCallMessages(llmAdapter))).toContain('Internal runbook list:')
      expect(getRequiredToolContent(getSecondCallMessages(llmAdapter))).toContain('Summarize the available runbooks for the user in clean Markdown.')
    }

    // Claude lists, runs and inspects through MCP host tools in one turn; the chat shows the result and the summary.
    {
      const execution = makeExecution({
        executionId: '88888888-8888-4888-8888-888888888888',
        runbookTitle: 'Sentry Desktop Error Check',
        steps: [{ actionId: 'step-1', order: 1, type: 'external_source', title: 'List recent Sentry issues', status: 'completed', input: { projectSlugs: ['desktop'] }, output: 'Fetched 5 Sentry issues.' }],
      })
      const llmAdapter = {
        chatWithTools: vi.fn().mockImplementation(async (input: LlmChatRequest) => {
          const context = input.hostToolContext
          if (context === undefined) throw new Error('Expected Claude MCP host-tool context')
          await executeHostTool(context, 'list_runbooks', {})
          const runResult = await executeHostTool(context, 'execute_runbook', { runbookTitle: 'Sentry Desktop Error Check' })
          expect(runResult?.output).toContain(execution.executionId)
          const inspectResult = await executeHostTool(context, 'get_runbook_execution', { executionId: execution.executionId, waitForCompletion: true })
          expect(inspectResult?.output).toContain('Fetched 5 Sentry issues.')
          return { content: 'Sentry Desktop Error Check completed successfully after fetching 5 issues.', toolCalls: [], toolProtocol: 'mcp' as const }
        }),
      }
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(makeRunbook('rb-sentry', 'Sentry Desktop Error Check', [{ id: 'step-1', type: 'external_source', title: 'List recent Sentry issues' }])),
        runbookExecutionService: executionService({ start: startsAs(execution), waitForCompletion: vi.fn().mockResolvedValue(execution), get: vi.fn().mockResolvedValue(execution) }),
      })
      const sessionId = await runToEnd(service, {
        prompt: 'Use the host tools to list, execute, and inspect the relevant error-check runbook.',
        incidentThreadId: 'incident-claude-mcp',
        llm: CLAUDE_SONNET_5,
        accessLevel: 'auto-accept-edits',
      })

      expect(llmAdapter.chatWithTools).toHaveBeenCalledTimes(1)
      const finalText = lastAgent(service, sessionId).finalText
      expect(finalText).toContain('Runbook result: Sentry Desktop Error Check')
      expect(finalText).toContain('Sentry Desktop Error Check completed successfully after fetching 5 issues.')
      expect(getAllAgentToolCalls(service, sessionId)).toEqual([
        expect.objectContaining({ toolName: 'list_runbooks', state: 'done' }),
        expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
        expect.objectContaining({ toolName: 'get_runbook_execution', state: 'done', output: expect.stringContaining('Fetched 5 Sentry issues.') }),
      ])
    }

    // MCP host-tool calls appear as tool cards and live events, and are replayed to the model on the next turn.
    {
      const llmAdapter = {
        chatWithTools: vi.fn()
          .mockImplementationOnce(async (input: LlmChatRequest) => {
            await executeHostTool(input.hostToolContext!, 'execute_runbook', { runbookTitle: 'Investigate Sentry' })
            return { content: 'I started the Investigate Sentry runbook.', toolCalls: [], toolProtocol: 'mcp' as const }
          })
          .mockResolvedValueOnce({ content: 'The runbook is still running.', toolCalls: [] }),
      }
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(makeRunbook('rb-sentry', 'Investigate Sentry', [{ id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' }])),
        runbookExecutionService: executionService({
          start: startsAs(makeExecution()),
          get: vi.fn().mockResolvedValue(makeExecution({ status: 'running', completedAt: undefined })),
        }),
        sentEvents,
      })
      const sessionId = await runToEnd(service, {
        prompt: 'Use the available host tools to investigate the active incident.',
        incidentThreadId: 'incident-mcp-ledger',
        llm: CLAUDE_SONNET_4_6,
      })

      expect(getAllAgentToolCalls(service, sessionId)).toEqual([expect.objectContaining({ toolName: 'execute_runbook', state: 'done' })])
      expect(sentEvents.some(({ event }) => event.type === 'tool_start')).toBe(true)
      expect(sentEvents.some(({ event }) => event.type === 'tool_end')).toBe(true)
      expect(sentEvents.some(({ event }) => event.type === 'activity' && event.phase === 'running_runbook')).toBe(true)
      expect(llmAdapter.chatWithTools).toHaveBeenCalledTimes(1)

      await service.send({ sessionId, message: 'What is its status?' })
      await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')
      expect(getSecondCallMessages(llmAdapter)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'tool', toolCallId: expect.stringContaining('execute_runbook') }),
      ]))
    }

    // A failure claim is accepted only after the model inspects the persisted execution.
    {
      const executionId = '77777777-7777-4777-8777-777777777777'
      const persistedFailure = makeExecution({
        executionId,
        runbookId: 'rb-posthog',
        runbookTitle: 'Posthog Error Check',
        status: 'failed',
        completionReason: 'step_failed',
        steps: [{ actionId: 'step-1', order: 1, type: 'external_source', title: 'PostHog Sandbox API Error Check', status: 'failed', error: 'PostHog API returned 403.' }],
      })
      const runbooks = executionService({
        start: startsAs(persistedFailure),
        get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(persistedFailure),
      })
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will inspect the started runbook execution.', toolCalls: [tool('inspect-posthog-execution', 'get_runbook_execution', { executionId })] },
          { content: 'The Posthog Error Check runbook failed at Step 1 because PostHog API returned 403.' },
        ),
        runbookStore: listing(makeRunbook('rb-posthog', 'Posthog Error Check', [{ id: 'step-1', type: 'external_source', title: 'PostHog Sandbox API Error Check' }])),
        runbookExecutionService: runbooks,
      })
      const sessionId = await runToEnd(service, {
        prompt: 'Run the Posthog Error Check runbook for this incident and summarize the three most important unresolved errors.',
        incidentThreadId: 'incident-posthog-inspected-outcome',
        llm: CLAUDE_SONNET_5,
      })

      expect(runbooks.get).toHaveBeenCalledTimes(2)
      expect(getAllAgentToolCalls(service, sessionId)).toEqual([
        expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
        expect.objectContaining({ toolName: 'get_runbook_execution', state: 'done', output: expect.stringContaining('PostHog API returned 403.') }),
      ])
      expect(lastAgent(service, sessionId).finalText).toContain('failed at Step 1')
    }

    // A local provider that inspects the same completed execution again sees one runbook result block.
    {
      const completed = logsExecution('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Backend logs matched the Sentry window.')
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will run the backend log runbook.', toolCalls: [tool('call-logs', 'execute_runbook', { runbookTitle: LOGS_TITLE })] },
          { content: 'I will inspect the same runbook execution.', toolCalls: [tool('get-logs', 'get_runbook_execution')] },
          { content: 'Summary: the backend logs match the Sentry window.' },
        ),
        runbookStore: listing(logsRunbook()),
        runbookExecutionService: executionService({ start: startsAs(completed), waitForCompletion: vi.fn().mockResolvedValue(completed), get: vi.fn().mockResolvedValue(completed) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Check Jagad backend logs.', incidentThreadId: 'incident-local-dedupe', llm: CLAUDE_SONNET_4_6 })

      const agentMessage = lastAgent(service, sessionId)
      expect(agentMessage).toMatchObject({ kind: 'agent', status: 'done' })
      const visibleText = agentMessage.finalText ?? agentMessage.iterations.at(-1)?.text ?? ''
      expect(visibleText).toContain('Backend logs matched the Sentry window.')
      expect(visibleText).toContain('Summary: the backend logs match the Sentry window.')
      expect(visibleText.match(/Runbook result: Check Logs in the Jagad backend server/g) ?? []).toHaveLength(1)
    }

    // A large plugin result reaches the model as its top ten issue titles, without the raw payload.
    {
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
        steps: [{ actionId: 'step-1', order: 1, type: 'plugin', title: 'List PostHog exception issues', status: 'completed', output: `Fetched 27 PostHog issues.\n\n${JSON.stringify({ issues })}` }],
      })
      const llmAdapter = scriptedLlm(
        { content: 'I will inspect the PostHog errors.', toolCalls: [tool('call-posthog', 'execute_runbook', { runbookTitle: 'PostHog Sandbox API Error Check' })] },
        { content: 'I will inspect the completed PostHog execution before summarizing it.', toolCalls: [tool('call-posthog-result', 'get_runbook_execution', { executionId: postHogExecution.executionId })] },
        { content: 'The top PostHog issues are summarized.' },
      )
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(makeRunbook('rb-posthog', 'PostHog Sandbox API Error Check', [{ id: 'step-1', type: 'plugin', title: 'List PostHog exception issues' }])),
        runbookExecutionService: executionService({
          start: startsAs(postHogExecution),
          waitForCompletion: vi.fn().mockResolvedValue(postHogExecution),
          get: vi.fn()
            .mockResolvedValueOnce({ ...postHogExecution, status: 'running', completedAt: undefined, completionReason: undefined, steps: [] })
            .mockResolvedValue(postHogExecution),
        }),
      })
      await runToEnd(service, { prompt: 'Find the recent exception issues.', incidentThreadId: 'incident-posthog' })

      const toolContext = getLastToolContent(getLlmCallMessages(llmAdapter, 2))
      expect(toolContext).toContain('PostHog issue 1')
      expect(toolContext).toContain('PostHog issue 10')
      expect(toolContext).not.toContain('PostHog issue 11')
      expect(toolContext).not.toContain('xxxxxxxxxx')
    }

    // A runbook that is still running is not leaked into the model context, and the chat shows it running.
    {
      const sentryExecution = makeExecution({
        steps: [{
          actionId: 'step-1',
          order: 1,
          type: 'llm',
          title: 'Build Sentry matrix',
          status: 'completed',
          output: [
            '| Issue | Last seen | journalctl --since | journalctl --until | Description |',
            '| --- | --- | --- | --- | --- |',
            `| SERVER-292 | 2026-05-26T00:59:00.000Z | 2026-05-26 00:54:00 UTC | 2026-05-26 01:04:00 UTC | ${'first issue details '.repeat(30)} |`,
            '| SERVER-293 | 2026-05-26T01:20:00.000Z | 2026-05-26 01:15:00 UTC | 2026-05-26 01:25:00 UTC | second issue details |',
          ].join('\n'),
        }],
      })
      const llmAdapter = scriptedLlm(
        { content: 'I will retrieve the Sentry matrix.', toolCalls: [tool('call-sentry', 'execute_runbook', { runbookTitle: SENTRY_TITLE })] },
        { content: 'I have the exact journal windows.' },
      )
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(sentryRunbook()),
        runbookExecutionService: executionService({ start: startsAs(sentryExecution), waitForCompletion: vi.fn().mockResolvedValue(sentryExecution) }),
        sentEvents,
      })
      await runToEnd(service, { prompt: 'Pull Jagad errors from Sentry and keep the log windows.', incidentThreadId: 'incident-1' })

      const toolContext = getRequiredToolContent(getSecondCallMessages(llmAdapter))
      expect(toolContext).toContain('Status: running')
      expect(toolContext).not.toContain('SERVER-292')
      expect(toolContext).not.toContain('SERVER-293')
      expect(sentEvents.some(({ event }) => event.type === 'activity' && event.phase === 'running_runbook')).toBe(true)
    }
  })

  it('starts and inspects exactly the runbooks the model means', async () => {
    const sentry = makeExecution()

    // A malformed runbook id fails visibly instead of running the active runbook.
    {
      const runbooks = executionService()
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will run the active runbook.', toolCalls: [tool('call-execute', 'execute_runbook', { runbookId: 123 })] },
          { content: 'The runbook identifier was malformed, so I did not execute it.' },
        ),
        runbookStore: listing(makeRunbook('rb-active', 'Active incident runbook', [{ id: 'step-1', type: 'shell', title: 'Active runbook step' }])),
        runbookExecutionService: runbooks,
      })
      const sessionId = await runToEnd(service, {
        prompt: 'Run it now.',
        incidentThreadId: 'incident-1',
        runbookContext: { id: 'rb-active', title: 'Active incident runbook', description: '', actions: [{ id: 'step-1', type: 'shell', title: 'Active runbook step' }] },
      })

      expect(lastAgent(service, sessionId).finalText).toBe('The runbook identifier was malformed, so I did not execute it.')
      const [card] = cardsNamed(service, sessionId, 'execute_runbook')
      expect(card).toMatchObject({ state: 'failed' })
      expect(visibleToolText(card)).toContain('execute_runbook')
      expect(runbooks.start).not.toHaveBeenCalled()
    }

    // Claude-style synthetic ids resolve to the listed runbooks they abbreviate.
    {
      const logs = logsExecution('22222222-2222-4222-8222-222222222222', 'Checked Jagad backend logs.')
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          {
            content: 'I will run the Jagad Sentry and log runbooks.',
            toolCalls: [
              tool('call-sentry', 'execute_runbook', { runbookId: 'rb-sentry-jagad' }),
              tool('call-logs', 'execute_runbook', { runbookId: 'rb-logs-jagad', parameterValues: { since: '2026-05-28 09:15:01 UTC', until: '2026-05-28 09:25:01 UTC' } }),
            ],
          },
          { content: 'Both synthetic runbook ids resolved to real runbooks.' },
        ),
        runbookStore: listing(sentryRunbook(), logsRunbook()),
        runbookExecutionService: executionService({ start: startsAs(sentry, logs), waitForCompletion: findsById(sentry, logs) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Run the Jagad Sentry and backend log runbooks.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText).toBe('Both synthetic runbook ids resolved to real runbooks.')
      const cards = cardsNamed(service, sessionId, 'execute_runbook')
      expect(cards).toHaveLength(2)
      expect(cards.map((card) => card.output ?? '').join('\n')).toContain('"runbookId": "rb-sentry"')
      expect(cards.map((card) => card.output ?? '').join('\n')).toContain('"runbookId": "rb-logs"')
      expect(cards.every((card) => card.state === 'done' && card.error === undefined)).toBe(true)
    }

    // Repeating the same request (same parameters in any order) is accepted once; different parameters start twice.
    {
      const window = { since: '2026-05-30 00:00:00 UTC', until: '2026-05-30 00:10:00 UTC' }
      const logs = logsExecution('22222222-2222-4222-8222-222222222222', 'Backend logs loaded for the combined Sentry window.')
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          {
            content: 'I will inspect multiple log windows.',
            toolCalls: [
              tool('call-logs-1', 'execute_runbook', { runbookTitle: LOGS_TITLE, parameterValues: window }),
              tool('call-logs-2', 'execute_runbook', { runbookTitle: LOGS_TITLE, parameterValues: { until: window.until, since: window.since } }),
            ],
          },
          { content: 'I used the first log execution and did not restart it.' },
        ),
        runbookStore: listing(logsRunbook()),
        runbookExecutionService: executionService({ start: startsAs(logs), waitForCompletion: vi.fn().mockResolvedValue(logs) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Cross-validate Jagad Sentry errors with backend logs.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText).toBe('I used the first log execution and did not restart it.')
      const cards = cardsNamed(service, sessionId, 'execute_runbook')
      expect(cards).toHaveLength(2)
      expect(cards.some((card) => card.output?.includes('"deduplicated": true') === true)).toBe(true)
      expect(new Set(cards.map((card) => (JSON.parse(card.output ?? '{}') as { executionId?: string }).executionId)).size).toBe(1)
    }
    {
      const first = logsExecution('33333333-3333-4333-8333-333333333331', 'Backend logs loaded for the 00:00-00:10 UTC window.')
      const second = logsExecution('33333333-3333-4333-8333-333333333332', 'Backend logs loaded for the 00:10-00:20 UTC window.')
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          {
            content: 'I will compare two requested windows.',
            toolCalls: [
              tool('call-logs-1', 'execute_runbook', { runbookTitle: LOGS_TITLE, parameterValues: { since: '2026-05-30 00:00:00 UTC', until: '2026-05-30 00:10:00 UTC' } }),
              tool('call-logs-2', 'execute_runbook', { runbookTitle: LOGS_TITLE, parameterValues: { since: '2026-05-30 00:10:00 UTC', until: '2026-05-30 00:20:00 UTC' } }),
            ],
          },
          { content: 'I compared both requested windows.' },
        ),
        runbookStore: listing(logsRunbook()),
        runbookExecutionService: executionService({
          start: vi.fn()
            .mockResolvedValueOnce({ executionId: first.executionId, resultId: 'result-logs-1' })
            .mockResolvedValueOnce({ executionId: second.executionId, resultId: 'result-logs-2' }),
          waitForCompletion: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
        }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Compare two explicit backend log windows.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText).toBe('I compared both requested windows.')
      const outputs = cardsNamed(service, sessionId, 'execute_runbook').map((card) => card.output ?? '')
      expect(outputs).toHaveLength(2)
      expect(outputs.join('\n')).toContain(first.executionId)
      expect(outputs.join('\n')).toContain(second.executionId)
      expect(outputs.join('\n')).toContain('"status": "running"')
    }

    // A follow-up runbook started after an unfinished one gets no parameters invented from it.
    {
      const logs = logsExecution('22222222-2222-4222-8222-222222222222', 'Backend log window loaded without timestamp parse errors.')
      const runbooks = executionService({ start: startsAs(sentry, logs), waitForCompletion: findsById(sentry, logs) })
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will retrieve the Sentry errors.', toolCalls: [tool('call-sentry', 'execute_runbook', { runbookTitle: SENTRY_TITLE })] },
          { content: 'I will cross-check the Sentry window against backend logs.', toolCalls: [tool('call-logs', 'execute_runbook', { runbookTitle: LOGS_TITLE })] },
          { content: 'Matrix: backend logs were checked against the Sentry window.' },
        ),
        runbookStore: listing(sentryRunbook(), makeRunbook('rb-logs', LOGS_TITLE, [{
          id: 'step-1',
          type: 'shell',
          title: 'Check journalctl logs',
          command: 'journalctl --since {{since}} --until {{until}}',
          parameters: [{ id: 'since-param', key: 'since', required: true }, { id: 'until-param', key: 'until', required: true }],
        }])),
        runbookExecutionService: runbooks,
      })
      const sessionId = await runToEnd(service, { prompt: 'Pull Jagad errors and cross-validate them with backend logs.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText).toBe('Matrix: backend logs were checked against the Sentry window.')
      const backendRun = getRunbookStartCalls(runbooks.start).find(([runbookId]) => runbookId === 'rb-logs')
      expect(backendRun).toBeDefined()
      expect(backendRun?.[1].parameterValues).toBeUndefined()
    }

    // The same tool call id twice in one response runs once.
    {
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will inspect the latest runbook result.', toolCalls: [tool('dup-get', 'get_runbook_execution'), tool('dup-get', 'get_runbook_execution')] },
          { content: 'Done.' },
        ),
        runbookStore: listing(),
        runbookExecutionService: executionService({ waitForCompletion: vi.fn().mockResolvedValue(sentry), getLatestForIncidentThread: vi.fn().mockResolvedValue(sentry) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Inspect the latest runbook result once.', incidentThreadId: 'incident-dedupe' })

      expect(lastAgent(service, sessionId).finalText).toBe('Done.')
      expect(cardsNamed(service, sessionId, 'get_runbook_execution')).toHaveLength(1)
    }

    // Inspection resolves the execution the model means, and never substitutes the incident's latest one.
    const prior = makeExecution({
      executionId: '33333333-3333-4333-8333-333333333333',
      runbookId: 'rb-logs',
      runbookTitle: 'Prior backend log check',
      steps: [{ actionId: 'step-1', order: 1, type: 'shell', title: 'Prior log check', status: 'completed', output: 'Prior backend logs are still available.' }],
    })
    const fresh = makeExecution({
      executionId: '22222222-2222-4222-8222-222222222222',
      steps: [{ actionId: 'step-1', order: 1, type: 'external_source', title: 'Retrieve errors from Sentry', status: 'completed', output: 'New Sentry matrix generated.' }],
    })
    const missingExecutionId = '77777777-7777-4777-8777-777777777777'
    const inspections: Array<{
      name: string
      startsFirst?: RunbookExecutionRecord
      inspectArgs: Record<string, unknown>
      persisted: RunbookExecutionRecord[]
      latest?: RunbookExecutionRecord
      state: 'done' | 'failed'
      shows: string
      hides?: string
    }> = [
      { name: 'the execution started in the same turn', startsFirst: sentry, inspectArgs: {}, persisted: [sentry], state: 'done', shows: 'SERVER-292 last seen' },
      { name: 'an explicitly named prior execution', startsFirst: fresh, inspectArgs: { executionId: prior.executionId }, persisted: [fresh, prior], state: 'done', shows: 'Prior backend logs are still available.', hides: 'lookupDeferred' },
      { name: 'the real execution when the model invents an id', startsFirst: sentry, inspectArgs: { executionId: '66666666-6666-4666-8666-666666666666' }, persisted: [sentry], state: 'done', shows: 'SERVER-292 last seen', hides: 'Runbook execution not found' },
      { name: 'not found instead of the latest execution', inspectArgs: { executionId: missingExecutionId }, persisted: [], latest: prior, state: 'failed', shows: `Runbook execution not found: ${missingExecutionId}`, hides: 'Prior backend logs are still available.' },
      { name: 'a failure for a malformed id instead of the latest execution', inspectArgs: { executionId: 123 }, persisted: [], latest: prior, state: 'failed', shows: 'get_runbook_execution', hides: 'Prior backend logs are still available.' },
    ]
    for (const inspection of inspections) {
      const toolCalls = [tool('call-get', 'get_runbook_execution', inspection.inspectArgs)]
      if (inspection.startsFirst !== undefined) toolCalls.unshift(tool('call-execute', 'execute_runbook', { runbookTitle: SENTRY_TITLE }))
      const service = createRuntime({
        llmAdapter: scriptedLlm({ content: 'I will inspect the runbook execution.', toolCalls }, { content: `Inspected ${inspection.name}.` }),
        runbookStore: listing(sentryRunbook()),
        runbookExecutionService: executionService({
          start: inspection.startsFirst === undefined ? vi.fn() : startsAs(inspection.startsFirst),
          waitForCompletion: vi.fn().mockResolvedValue(inspection.startsFirst ?? null),
          get: findsById(...inspection.persisted),
          getLatestForIncidentThread: vi.fn().mockResolvedValue(inspection.latest ?? null),
        }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Retrieve Jagad Sentry errors and inspect the runbook output.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText, inspection.name).toBe(`Inspected ${inspection.name}.`)
      const [card] = cardsNamed(service, sessionId, 'get_runbook_execution')
      expect(card, inspection.name).toMatchObject({ state: inspection.state })
      // A resolved inspection shows the execution on the card; a refused one explains why.
      const shown = inspection.state === 'done' ? card?.output ?? '' : visibleToolText(card)
      expect(shown, inspection.name).toContain(inspection.shows)
      if (inspection.hides !== undefined) expect(visibleToolText(card), inspection.name).not.toContain(inspection.hides)
      if (inspection.state === 'done') expect(card?.error, inspection.name).toBeUndefined()
    }
  })

  it('reports an unfinished runbook as unfinished instead of inventing an outcome', async () => {
    // Inspecting a running runbook ends the turn with a waiting status instead of polling again.
    {
      const running = makeExecution({
        runbookId: 'rb-logs',
        runbookTitle: LOGS_TITLE,
        status: 'running',
        completedAt: undefined,
        completionReason: undefined,
        steps: [{ actionId: 'step-1', order: 1, type: 'shell', title: 'Check journalctl logs', status: 'running' }],
      })
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will inspect whether the log runbook has finished.', toolCalls: [tool('call-get', 'get_runbook_execution', { executionId: running.executionId })] },
          { content: 'This should not be reached while the runbook is still running.' },
        ),
        runbookStore: listing(),
        runbookExecutionService: executionService({ get: vi.fn().mockResolvedValue(running), waitForCompletion: vi.fn().mockResolvedValue(null) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Check whether the backend log runbook is done.', incidentThreadId: 'incident-1' })

      expect(lastAgent(service, sessionId).finalText).toContain('is still running')
      expect(lastAgent(service, sessionId).finalText).not.toContain('should not be reached')
    }

    // A short conversation timeout is not extended for a runbook, and nothing is cancelled.
    {
      const completed = logsExecution('99999999-9999-4999-8999-999999999999', 'Backend logs were summarized after the timeout boundary.')
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will run the backend log runbook.', toolCalls: [tool('call-logs', 'execute_runbook', { runbookTitle: LOGS_TITLE })] },
          { content: 'I will inspect the runbook execution before summarizing it.', toolCalls: [tool('inspect-logs', 'get_runbook_execution', { executionId: completed.executionId })] },
          { content: 'The runbook completed after the timeout boundary.' },
        ),
        runbookStore: listing(logsRunbook()),
        runbookExecutionService: executionService({ start: startsAs(completed), get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(completed) }),
        sentEvents,
      })
      const sessionId = await runToEnd(service, { prompt: 'Check Jagad backend logs.', incidentThreadId: 'incident-timeout', timeoutMs: 100 })

      expect(lastAgent(service, sessionId).finalText).toBe('The runbook completed after the timeout boundary.')
      const [card] = cardsNamed(service, sessionId, 'execute_runbook')
      expect(card).toMatchObject({ state: 'done' })
      expect(card?.error).toBeUndefined()
      expect(card?.output).toContain('"status": "running"')
      expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
    }

    // Cursor stopping after a start acknowledgement does not get the runbook output pasted under its words.
    {
      const completed = logsExecution('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '# Error Matrix Table\n\n| Issue ID | Root Cause Analysis |\n| --- | --- |\n| LOG-001 | Missing bot startup artifact. |')
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'I will run the backend log runbook.', toolCalls: [tool('call-logs', 'execute_runbook', { runbookTitle: LOGS_TITLE })] },
          { content: "Both runbooks completed; I'll fetch the full backend log runbook output." },
        ),
        runbookStore: listing(makeRunbook('rb-logs', LOGS_TITLE, [{ id: 'step-1', type: 'llm', title: 'Make an AI summarization out of the results' }])),
        runbookExecutionService: executionService({ start: startsAs(completed), waitForCompletion: vi.fn().mockResolvedValue(completed) }),
      })
      const sessionId = await runToEnd(service, { prompt: 'Check Jagad backend logs.', incidentThreadId: 'incident-cursor-no-result', llm: { providerKey: 'cursor', model: 'composer-2.5' } })

      const agentMessage = lastAgent(service, sessionId)
      const visibleText = agentMessage.finalText ?? agentMessage.iterations.at(-1)?.text ?? ''
      expect(visibleText).toContain("Both runbooks completed; I'll fetch")
      expect(visibleText).not.toContain('Completed runbook output:')
      expect(visibleText).not.toContain('| LOG-001 | Missing bot startup artifact. |')
    }

    // A provider failure after the start leaves the turn failed and the started runbook on its card.
    {
      const runbooks = executionService({
        start: vi.fn().mockResolvedValue({ executionId: '55555555-5555-4555-8555-555555555555', resultId: 'result-durable' }),
        get: vi.fn().mockResolvedValue(makeExecution({ executionId: '55555555-5555-4555-8555-555555555555', runbookId: 'rb-durable', runbookTitle: 'Durable runbook', status: 'running', completedAt: undefined, completionReason: undefined, steps: [] })),
      })
      const service = createRuntime({
        llmAdapter: scriptedLlm(
          { content: 'Starting the durable runbook.', toolCalls: [tool('call-durable', 'execute_runbook', { runbookTitle: 'Durable runbook' })] },
          new Error('Provider connection closed during summary'),
        ),
        runbookStore: listing(makeRunbook('rb-durable', 'Durable runbook', [{ id: 'step-1', type: 'shell', title: 'Check durable state' }])),
        runbookExecutionService: runbooks,
      })
      const sessionId = await service.start({ prompt: 'Run Durable runbook.', incidentThreadId: 'incident-durable' })
      await waitForCondition(() => service.getStatus(sessionId).state === 'FAILED')

      expect(getAllAgentToolCalls(service, sessionId)).toEqual([
        expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
        expect.objectContaining({ toolName: 'execute_runbook', state: 'done' }),
      ])
    }

    // Model text that only describes a failed or running runbook is not parsed into another tool call.
    for (const claim of [
      [
        'The Posthog Error Check runbook failed before it could reach the actual error analysis.',
        '',
        'What happened:',
        '- Step 1 – PostHog Project Discovery: ❌ Failed',
        '- Step 2 – PostHog Sandbox API Error Check: ⏸ Never ran (blocked by the failed discovery step)',
      ].join('\n'),
      [
        'The Posthog Error Check runbook failed again, at the same step as the previous attempt.',
        '',
        'What happened:',
        '- Step 1 – PostHog Project Discovery: ❌ Failed (second consecutive failure at this exact step)',
        '- Step 2 – PostHog Sandbox API Error Check: ⏸ Never ran (blocked by the failed discovery step)',
      ].join('\n'),
      [
        'Checking runbook status for "Sentry Desktop Error Check" — the runbook was started and is currently mid-execution',
        '(List recent Sentry issues step running), so I’ll pull the current results before summarizing.',
      ].join(' '),
    ]) {
      const executionId = '66666666-6666-4666-8666-666666666666'
      const llmAdapter = { chatWithTools: vi.fn().mockResolvedValue({ content: claim, toolCalls: [] }) }
      const sentEvents: AgentRuntimeEventPayload[] = []
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(makeRunbook('rb-posthog', 'Posthog Error Check', [{ id: 'step-1', type: 'external_source', title: 'PostHog Sandbox API Error Check' }])),
        runbookExecutionService: executionService({ start: vi.fn().mockResolvedValue({ executionId, resultId: 'result-posthog' }) }),
        sentEvents,
      })
      const sessionId = await runToEnd(service, {
        prompt: 'Run the Posthog Error Check runbook for this incident and summarize the three most important unresolved errors.',
        incidentThreadId: 'incident-posthog-outcome-claim',
        llm: CLAUDE_SONNET_5,
      })

      expect(llmAdapter.chatWithTools.mock.calls).toHaveLength(1)
      expect(getAllAgentToolCalls(service, sessionId)).toEqual([
        expect.objectContaining({ toolName: 'execute_runbook', output: expect.stringContaining(executionId) }),
      ])
      expect(sentEvents.some(({ event }) => event.type === 'error')).toBe(false)
    }

    // A local provider that stalls after a tool result keeps the turn running rather than claiming completion.
    const logs = logsExecution('88888888-8888-4888-8888-888888888888', 'Backend logs were summarized without waiting on Sonnet.')
    for (const stall of [
      { firstCall: tool('call-logs', 'execute_runbook', { runbookTitle: LOGS_TITLE }), runbook: logsRunbook(), hiddenText: 'Backend logs were summarized without waiting on Sonnet.' },
      { firstCall: tool('call-list-runbooks', 'list_runbooks'), runbook: makeRunbook('rb-sentry', 'Investigate Sentry', [{ id: 'step-1', type: 'external_source', title: 'Fetch Sentry issues' }]), hiddenText: 'Completed runbook output:' },
    ]) {
      vi.useFakeTimers()
      try {
        let stalledFinalizationStarted = false
        const llmAdapter = {
          chatWithTools: vi.fn()
            .mockResolvedValueOnce({ content: 'I will use the runbook tools.', toolCalls: [stall.firstCall] })
            .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
              stalledFinalizationStarted = true
              signal.addEventListener('abort', () => resolve({ content: '', toolCalls: [] }), { once: true })
            })),
        }
        const sentEvents: AgentRuntimeEventPayload[] = []
        const service = createRuntime({
          llmAdapter,
          runbookStore: listing(stall.runbook),
          runbookExecutionService: executionService({ start: startsAs(logs), waitForCompletion: vi.fn().mockResolvedValue(logs) }),
          sentEvents,
        })
        const sessionId = await service.start({ prompt: 'Check Jagad backend logs.', incidentThreadId: 'incident-local-timeout', llm: CLAUDE_SONNET_4_6 })
        for (let attempt = 0; attempt < 20; attempt += 1) await flushPromises(1)
        expect(stalledFinalizationStarted).toBe(true)

        await vi.advanceTimersByTimeAsync(60_000)
        await flushPromises()

        expect(service.getStatus(sessionId).state).toBe('RUNNING')
        const agentMessage = lastAgent(service, sessionId)
        expect(agentMessage.status).not.toBe('done')
        expect(agentMessage.iterations.at(-1)?.text ?? agentMessage.finalText ?? '').not.toContain(stall.hiddenText)
        expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('keeps one active session per incident and carries the chat across turns', async () => {
    const alreadyRunning = 'An agent session is already running for this incident. Wait for it to finish or cancel it before starting another response.'

    // A second start on a busy incident is rejected, even when both race past persisted-proposal loading.
    {
      const service = createRuntime({ llmAdapter: { chatWithTools: vi.fn().mockReturnValue(new Promise<never>(() => {})) } })
      const sessionId = await service.start({ prompt: 'Start investigating Jagad.', incidentThreadId: 'incident-dup' })
      expect(service.getStatus(sessionId).state).toBe('RUNNING')
      await expect(service.start({ prompt: 'Start another investigation on the same incident.', incidentThreadId: 'incident-dup' })).rejects.toThrow(alreadyRunning)
      service.cancel(sessionId)
    }
    {
      let resolvePersistedProposals: ((proposals: RunbookAuthoringProposal[]) => void) | undefined
      const listPersistedProposals = vi.fn().mockReturnValue(new Promise<RunbookAuthoringProposal[]>((resolve) => {
        resolvePersistedProposals = resolve
      }))
      const service = createRuntime({
        llmAdapter: { chatWithTools: vi.fn().mockReturnValue(new Promise<never>(() => {})) },
        authoringProposalStore: { list: listPersistedProposals, save: vi.fn().mockResolvedValue(undefined) },
      })
      const starts = [
        service.start({ prompt: 'Start investigating the first request.', incidentThreadId: 'incident-start-race' }),
        service.start({ prompt: 'Start investigating the second request.', incidentThreadId: 'incident-start-race' }),
      ]
      await waitForCondition(() => listPersistedProposals.mock.calls.length === 2)
      resolvePersistedProposals?.([])

      const results = await Promise.allSettled(starts)
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toMatchObject({ message: alreadyRunning })
      service.cancel(fulfilled[0]!.value)
    }

    // A follow-up sent while the incident turn is active is queued and answered after the first response.
    {
      let resolveFirstResponse: ((response: { content: string; toolCalls: [] }) => void) | undefined
      const llmAdapter = {
        chatWithTools: vi.fn()
          .mockReturnValueOnce(new Promise((resolve) => {
            resolveFirstResponse = resolve
          }))
          .mockResolvedValueOnce({ content: 'The queued follow-up was delivered.', toolCalls: [] }),
      }
      const service = createRuntime({ llmAdapter })
      const sessionId = await service.start({ prompt: 'Start investigating Jagad.', incidentThreadId: 'incident-reuse' })

      await expect(service.send({ message: 'What was the result?', incidentThreadId: 'incident-reuse' })).resolves.toBe(sessionId)
      expect(service.getSnapshot(sessionId).messages).toHaveLength(2)
      resolveFirstResponse?.({ content: 'The first incident response is ready.', toolCalls: [] })

      await waitForCondition(() => lastAgent(service, sessionId).finalText === 'The queued follow-up was delivered.')
      expect(service.getSnapshot(sessionId).messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'What was the result?' }),
        expect.objectContaining({ kind: 'agent', finalText: 'The first incident response is ready.' }),
      ]))
    }

    // A completed session resumes with the earlier chat as model context.
    {
      const llmAdapter = scriptedLlm({ content: 'First answer.' }, { content: 'Follow-up answer using prior context.' })
      const service = createRuntime({ llmAdapter })
      const sessionId = await runToEnd(service, { prompt: 'Check Jagad logs.' })

      await expect(service.send({ sessionId, message: 'Continue.' })).resolves.toBe(sessionId)
      await waitForCondition(() => lastAgent(service, sessionId).finalText === 'Follow-up answer using prior context.')
      expect(getSecondCallMessages(llmAdapter)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Check Jagad logs.' }),
        expect.objectContaining({ role: 'assistant', content: 'First answer.' }),
        expect.objectContaining({ role: 'user', content: 'Continue.' }),
      ]))
    }

    // Two incidents running runbooks at once each keep their own runbook and answer.
    {
      const slowRunning = makeExecution({
        executionId: '11111111-1111-4111-8111-111111111111',
        runbookId: 'rb-slow',
        runbookTitle: 'Slow incident runbook',
        status: 'running',
        completedAt: undefined,
        completionReason: undefined,
        steps: [{ actionId: 'step-1', order: 1, type: 'shell', title: 'Slow check', status: 'running' }],
      })
      const fastCompleted = makeExecution({
        executionId: '22222222-2222-4222-8222-222222222222',
        runbookId: 'rb-fast',
        runbookTitle: 'Fast incident runbook',
        steps: [{ actionId: 'step-1', order: 1, type: 'http', title: 'Fast check', status: 'completed', output: 'Fast incident finished.' }],
      })
      let slowRunbookStarted = false
      let fastRunbookStarted = false
      const llmAdapter = {
        chatWithTools: vi.fn().mockImplementation(({ messages }: { messages: Array<{ content: unknown }> }) => {
          const slow = messages.map((message) => String(message.content)).join('\n').includes('slow')
          if (slow && slowRunbookStarted) return Promise.resolve({ content: 'The slow incident request remains isolated from the fast incident request.', toolCalls: [] })
          if (!slow && fastRunbookStarted) return Promise.resolve({ content: 'The fast incident request remains isolated from the slow incident request.', toolCalls: [] })
          if (slow) slowRunbookStarted = true
          else fastRunbookStarted = true
          return Promise.resolve({
            content: `I will start the ${slow ? 'slow' : 'fast'} runbook.`,
            toolCalls: [tool(`call-${slow ? 'slow' : 'fast'}`, 'execute_runbook', { runbookTitle: slow ? 'Slow incident runbook' : 'Fast incident runbook' })],
          })
        }),
      }
      const runbooks = executionService({ start: startsAs(slowRunning, fastCompleted) })
      const service = createRuntime({
        llmAdapter,
        runbookStore: listing(
          makeRunbook('rb-slow', 'Slow incident runbook', [{ id: 'step-1', type: 'shell', title: 'Slow check' }]),
          makeRunbook('rb-fast', 'Fast incident runbook', [{ id: 'step-1', type: 'http', title: 'Fast check' }]),
        ),
        runbookExecutionService: runbooks,
      })
      const slowSessionId = await runToEnd(service, { prompt: 'Start the slow incident.', incidentThreadId: 'incident-slow' })
      const fastSessionId = await runToEnd(service, { prompt: 'Start the fast incident.', incidentThreadId: 'incident-fast' })

      expect(lastAgent(service, fastSessionId).finalText).toBe('The fast incident request remains isolated from the slow incident request.')
      expect(lastAgent(service, slowSessionId).finalText).toBe('The slow incident request remains isolated from the fast incident request.')
      expect(getRunbookStartCalls(runbooks.start).map(([, options]) => options.incidentThreadId)).toEqual(['incident-slow', 'incident-fast'])
    }
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
})
