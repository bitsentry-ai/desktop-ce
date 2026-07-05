import { describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  summarizeRunbookExecutionForToolOutput,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import type {
  AgentRuntimeEventPayload,
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookExecutionService,
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
  accessLevel?: 'supervised' | 'auto-accept-edits' | 'full-access'
}

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

function getSecondCallMessages(llmAdapter: MockLlmAdapter): LlmChatRequest['messages'] {
  const input = llmAdapter.chatWithTools.mock.calls[1]?.[0]
  if (typeof input !== 'object' || input === null || !('messages' in input)) {
    throw new Error('Expected a second LLM call with messages')
  }

  const messages = input.messages
  if (messages === undefined) {
    throw new Error('Expected a second LLM call with messages')
  }

  return messages as LlmChatRequest['messages']
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

function createRuntime(options: {
  llmAdapter: AgentRuntimeLlmAdapter
  runbookStore?: AgentRuntimeRunbookStore
  runbookExecutionService?: AgentRuntimeRunbookExecutionService
  sentEvents?: AgentRuntimeEventPayload[]
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

  return new AgentRuntimeService(
    windowGetter,
    options.llmAdapter,
    options.runbookStore,
    options.runbookExecutionService,
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
})

describe('AgentRuntimeService runbook outcomes', () => {
  it('continues from Sentry output to backend logs using the derived window', async () => {
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
    expect(backendRun[1].parameterValues).toMatchObject({
      since: '2026-05-26 00:54:00 UTC',
      until: '2026-05-26 01:04:00 UTC',
    })
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

  it('creates runbook edit proposals without executing or saving until approval', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [
      {
        id: 'step-1',
        type: 'shell',
        title: 'Check service status',
        command: 'systemctl status bitsentry',
      },
    ])
    const runbookStore = {
      list: vi.fn().mockResolvedValue([originalRunbook]),
      updateMeta: vi.fn().mockResolvedValue(originalRunbook),
      updateActions: vi.fn().mockImplementation(({ actions }: { actions: RunbookRecord['actions'] }) =>
        Promise.resolve({
          ...originalRunbook,
          revisionNumber: 2,
          actions,
        }),
      ),
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
          content: 'I will draft a runbook edit for review.',
          toolCalls: [
            {
              id: 'call-propose-edit',
              name: 'propose_runbook_edit',
              args: {
                runbookId: 'rb-logs',
                prompt: 'Add uptime collection.',
                operations: [
                  {
                    id: 'op-add-uptime',
                    type: 'add_action',
                    rationale: 'Collect host uptime before inspecting logs.',
                    action: {
                      id: 'step-2',
                      type: 'shell',
                      title: 'Collect uptime',
                      command: 'uptime',
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I drafted the edit. It requires approval before saving.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Add uptime collection to the backend log runbook.',
      incidentThreadId: 'incident-authoring-edit',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(runbookExecutionService.start).not.toHaveBeenCalled()
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()

    const proposalCard = getLastAgentToolCalls(service, sessionId).find(
      (toolCall) => toolCall.toolName === 'propose_runbook_edit',
    )
    if (proposalCard?.output === undefined) {
      throw new Error('Expected a runbook authoring proposal tool output')
    }
    const proposalOutput = JSON.parse(proposalCard.output) as {
      proposalId: string
      approvalRequired: boolean
      saved: boolean
      status: string
      operationDiffs: Array<{ operationId: string; riskLabels: string[] }>
    }

    expect(proposalOutput).toMatchObject({
      approvalRequired: true,
      saved: false,
      status: 'pending_approval',
    })
    expect(proposalOutput.operationDiffs[0]).toMatchObject({
      operationId: 'op-add-uptime',
      riskLabels: ['shell'],
    })
    expect(service.listRunbookAuthoringProposals({ sessionId })).toHaveLength(1)

    const approval = await service.approveRunbookAuthoringProposal({
      sessionId,
      proposalId: proposalOutput.proposalId,
    })

    expect(approval.proposal.status).toBe('approved')
    expect(approval.savedRunbook?.actions.map((action) => action.id)).toEqual([
      'step-1',
      'step-2',
    ])
    expect(runbookStore.updateActions).toHaveBeenCalledTimes(1)
    expect(runbookExecutionService.start).not.toHaveBeenCalled()
  })

  it('rejects and revises runbook authoring proposals without saving', async () => {
    const originalRunbook = makeRunbook('rb-logs', 'Check backend logs', [
      {
        id: 'step-1',
        type: 'shell',
        title: 'Check service status',
        command: 'systemctl status bitsentry',
      },
    ])
    const runbookStore = {
      list: vi.fn().mockResolvedValue([originalRunbook]),
      updateMeta: vi.fn(),
      updateActions: vi.fn(),
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
          content: 'I will draft a metadata edit for review.',
          toolCalls: [
            {
              id: 'call-propose-edit',
              name: 'propose_runbook_edit',
              args: {
                runbookTitle: 'Check backend logs',
                prompt: 'Clarify the description.',
                operations: [
                  {
                    id: 'op-description',
                    type: 'update_metadata',
                    rationale: 'Make the runbook intent clearer.',
                    metadata: {
                      description: 'Collect backend service status before log inspection.',
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I drafted the edit. It requires approval before saving.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Improve the backend log runbook description.',
      incidentThreadId: 'incident-authoring-revise',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]
    const revision = service.requestRunbookAuthoringRevision({
      sessionId,
      proposalId: proposal.proposalId,
      requestedEdit: 'Use plainer language and keep it under one sentence.',
    })

    expect(revision.proposal.status).toBe('revision_requested')
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()

    const rejection = service.rejectRunbookAuthoringProposal({
      sessionId,
      proposalId: proposal.proposalId,
      reason: 'The requested revision is no longer needed.',
    })

    expect(rejection.proposal.status).toBe('rejected')
    expect(runbookExecutionService.start).not.toHaveBeenCalled()
    expect(runbookStore.updateMeta).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
  })

  it('creates new runbook proposals without saving until approval', async () => {
    const savedRunbook = makeRunbook('rb-new', 'Collect kernel errors', [])
    const runbookStore = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(savedRunbook),
      updateActions: vi.fn().mockImplementation(({ actions }: { actions: RunbookRecord['actions'] }) =>
        Promise.resolve({
          ...savedRunbook,
          revisionNumber: 2,
          actions,
        }),
      ),
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
          content: 'I will draft a new runbook for review.',
          toolCalls: [
            {
              id: 'call-propose-create',
              name: 'propose_runbook_create',
              args: {
                prompt: 'Create a kernel error runbook.',
                draftRunbook: {
                  title: 'Collect kernel errors',
                  description: 'Collect recent kernel errors from journalctl.',
                  actions: [
                    {
                      id: 'step-1',
                      type: 'shell',
                      title: 'Collect kernel errors',
                      command: 'journalctl -k -p err --since "1 hour ago"',
                    },
                  ],
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'I drafted the runbook. It requires approval before saving.',
          toolCalls: [],
        }),
    }
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Create a runbook for recent kernel errors.',
      incidentThreadId: 'incident-authoring-create',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(runbookStore.create).not.toHaveBeenCalled()
    expect(runbookStore.updateActions).not.toHaveBeenCalled()
    expect(runbookExecutionService.start).not.toHaveBeenCalled()

    const proposal = service.listRunbookAuthoringProposals({ sessionId })[0]
    expect(proposal).toMatchObject({
      kind: 'create_new_runbook',
      status: 'pending_approval',
      approvalRequired: true,
      saved: false,
    })

    const approval = await service.approveRunbookAuthoringProposal({
      sessionId,
      proposalId: proposal.proposalId,
    })

    expect(approval.proposal.status).toBe('approved')
    expect(runbookStore.create).toHaveBeenCalledTimes(1)
    expect(runbookStore.updateActions).toHaveBeenCalledTimes(1)
    expect(approval.savedRunbook?.actions[0]?.command).toBe(
      'journalctl -k -p err --since "1 hour ago"',
    )
  })

  it('keeps explicit journal windows in model context even when the output preview truncates', async () => {
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
    const service = createRuntime({
      llmAdapter,
      runbookStore,
      runbookExecutionService,
    })

    const sessionId = await service.start({
      prompt: 'Pull Jagad errors from Sentry and keep the log windows.',
      incidentThreadId: 'incident-1',
    })

    await waitForCondition(() => service.getStatus(sessionId).state === 'COMPLETED')

    const secondCallMessages = getSecondCallMessages(llmAdapter)
    const toolContext = getRequiredToolContent(secondCallMessages)
    expect(toolContext).toContain('SERVER-292')
    expect(toolContext).toContain('SERVER-293')
    expect(toolContext).toContain('2026-05-26 01:15:00 UTC')
    expect(toolContext).not.toContain('Derived journalctl time window')
    expect(toolContext).toContain('Combined window for one backend log runbook call')
    expect(toolContext).toContain('execute the backend log runbook once')
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
      prompt: 'Run the active incident runbook.',
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

  it('blocks repeated starts of the same runbook with the same parameters in one assistant turn', async () => {
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
      executionCards.some(
        (toolCall) =>
          toolCall.output !== undefined &&
          toolCall.output.includes('"repeatBlocked": true'),
      ),
    ).toBe(true)
    expect(
      executionCards.some((toolCall) =>
        toolCall.output !== undefined &&
          toolCall.output.includes('This runbook was already started in this assistant turn'),
      ),
    ).toBe(true)
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
    expect(executionOutputs.join('\n')).toContain('Backend logs loaded for the 00:00-00:10 UTC window.')
    expect(executionOutputs.join('\n')).toContain('Backend logs loaded for the 00:10-00:20 UTC window.')
  })

  it('waits for a running runbook inspection and then lets the model finish', async () => {
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
          content: 'Backend logs loaded for the Sentry window.',
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
      return lastMessage?.kind === 'agent' && lastMessage.finalText === 'Backend logs loaded for the Sentry window.'
    })
  })

  it('keeps the agent response alive when the session timeout hits during a runbook wait', async () => {
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
    let finishWait: ((execution: RunbookExecutionRecord | null) => void) | undefined
    const runbookExecutionService = {
      start: vi.fn().mockResolvedValue({
        executionId: completedExecution.executionId,
        resultId: 'result-logs',
      }),
      waitForCompletion: vi.fn().mockImplementation(
        () =>
          new Promise<RunbookExecutionRecord | null>((resolve) => {
            finishWait = resolve
          }),
      ),
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

    await waitForCondition(() => runbookExecutionService.waitForCompletion.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(service.getStatus(sessionId).state).toBe('RUNNING')
    expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)

    finishWait?.(completedExecution)
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
    expect(runbookCard?.output).toContain('Backend logs were summarized after the timeout boundary.')
    expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
  })

  it('surfaces completed runbook results when a local provider stalls after tool completion', async () => {
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

      expect(service.getStatus(sessionId).state).toBe('COMPLETED')
      const agentMessage = getLastAgentMessage(service.getSnapshot(sessionId))
      expect(agentMessage).toMatchObject({ kind: 'agent' })
      const visibleText = agentMessage.iterations.at(-1)?.text ?? agentMessage.finalText ?? ''
      expect(agentMessage.status).toBe('done')
      expect(visibleText).toContain('Runbook result: Check Logs in the Jagad backend server')
      expect(visibleText).toContain('Backend logs were summarized without waiting on Sonnet.')
      expect(sentEvents.some(({ event }) => event.type === 'cancelled')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('appends completed runbook output when Cursor stops without inspecting the result', async () => {
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
    expect(visibleText).toContain('Completed runbook output:')
    expect(visibleText).toContain('Runbook result: Check Logs in the Jagad backend server')
    expect(visibleText).toContain('| LOG-001 | Missing bot startup artifact. |')
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

  it('keeps concurrent incident sessions isolated while one runbook is still running', async () => {
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
    const slowCompleted = makeExecution({
      ...slowRunning,
      status: 'completed',
      completedAt: '2026-05-26T01:04:00.000Z',
      completionReason: 'success',
      steps: [
        {
          ...(slowRunning.steps[0]),
          status: 'completed',
          output: 'Slow incident finished.',
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
    let finishSlow: ((execution: RunbookExecutionRecord) => void) | undefined
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
      waitForCompletion: vi.fn().mockImplementation((executionId: string) => {
        if (executionId === slowRunning.executionId) {
          return new Promise<RunbookExecutionRecord>((resolve) => {
            finishSlow = resolve
          })
        }
        return Promise.resolve(fastCompleted)
      }),
      get: vi.fn().mockResolvedValue(null),
      getLatestForIncidentThread: vi.fn().mockResolvedValue(null),
    }
    const llmAdapter = {
      chatWithTools: vi
        .fn()
        .mockImplementation(({ messages }: { messages: Array<{ role?: string; content: unknown }> }) => {
          const text = messages.map((message) => String(message.content)).join('\n')
          if (text.includes('Slow incident finished.')) {
            return Promise.resolve({
              content: 'Slow incident finished.',
              toolCalls: [],
            })
          }
          if (text.includes('Fast incident finished.')) {
            return Promise.resolve({
              content: 'Fast incident finished.',
              toolCalls: [],
            })
          }
          if (text.includes('slow')) {
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
    await waitForCondition(() => finishSlow != null)
    expect(service.getStatus(slowSessionId).state).toBe('RUNNING')

    const fastSessionId = await service.start({
      prompt: 'Start the fast incident.',
      incidentThreadId: 'incident-fast',
    })
    await waitForCondition(() => service.getStatus(fastSessionId).state === 'COMPLETED')
    expect(service.getSnapshot(fastSessionId).messages.at(-1)).toMatchObject({
      kind: 'agent',
      finalText: 'Fast incident finished.',
    })

    finishSlow?.(slowCompleted)
    await waitForCondition(() => service.getStatus(slowSessionId).state === 'COMPLETED')
    expect(service.getSnapshot(slowSessionId).messages.at(-1)).toMatchObject({
      kind: 'agent',
      finalText: 'Slow incident finished.',
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

  it('reuses the existing incident session when send is called without a session id', async () => {
    const pendingResponse = new Promise<never>(() => {})
    const llmAdapter = {
      chatWithTools: vi.fn().mockReturnValue(pendingResponse),
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
    ).rejects.toThrow(
      'The agent is still responding. Wait for it to finish or cancel the current run before sending another message.',
    )

    expect(service.getSnapshot(sessionId).messages).toHaveLength(2)
    service.cancel(sessionId)
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
