import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import {
  executeHostTool,
  type HostToolContext,
} from '../src/features/agent-runtime'
import type { DesktopPluginDescriptor } from '../src/features/plugins'
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

function createContext(enabledApiProviders?: string): HostToolContext {
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
    enabledApiProviders,
  }
}

describe('host tools', () => {
  it('lists canonical model IDs and display names for runbook authoring', async () => {
    const result = await executeHostTool(
      createContext('openai,anthropic,gemini,groq,kilocode,openrouter'),
      'list_models',
      {},
    )
    const catalog = JSON.parse(result?.output ?? '') as {
      source: string
      providers: Array<{ providerKey: string; models: Array<{
        modelId: string
        displayName: string
        contextWindowTokens?: number
        maxOutputTokens?: number
      }> }>
    }

    expect(catalog.source).toBe('static_catalog')
    expect(catalog.providers[0]?.providerKey).toBe('openai')
    expect(catalog.providers[0]?.models).toContainEqual({
      modelId: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
    })

    const codex = catalog.providers.find((provider) => provider.providerKey === 'codex')
    expect(codex?.models.some((model) => model.modelId === 'gpt-5.2-codex')).toBe(false)
    expect(codex?.models.some((model) => model.modelId === 'gpt-5.1-codex-mini')).toBe(false)

    const anthropic = catalog.providers.find((provider) => provider.providerKey === 'anthropic')
    expect(anthropic?.models).toEqual(expect.arrayContaining([
      { modelId: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      { modelId: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      { modelId: 'claude-fable-5', displayName: 'Claude Fable 5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
      { modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
    ]))
  })

  it('canonicalizes a friendly LLM model name in Incident proposals', async () => {
    const context = createContext()
    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a summary runbook.',
      draftRunbook: {
        title: 'Summary',
        description: 'Summarize evidence.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize',
          prompt: 'Summarize the evidence.',
          llmModel: 'GPT 5.6 Terra',
        }],
      },
    })

    expect(result?.error).toBeUndefined()
    expect(context.session.runbookAuthoringProposals?.[0]?.proposedRunbook.actions[0]).toMatchObject({
      llmProviderKey: 'openai',
      llmModel: 'gpt-5.6-terra',
    })
  })

  it.each([
    ['Claude Fable 5', 'claude-fable-5'],
    ['Anthropic Claude Fable 5', 'claude-fable-5'],
    ['Fable', 'claude-fable-5'],
    ['Claude Sonnet 5', 'claude-sonnet-5'],
    ['Sonnet 5', 'claude-sonnet-5'],
  ])('canonicalizes %s to native Anthropic in Incident proposals', async (displayName, modelId) => {
    const context = createContext()
    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a summary runbook.',
      draftRunbook: {
        title: 'Summary',
        description: 'Summarize evidence.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize',
          prompt: 'Summarize the evidence.',
          llmModel: displayName,
        }],
      },
    })

    expect(result?.error).toBeUndefined()
    expect(context.session.runbookAuthoringProposals?.[0]?.proposedRunbook.actions[0]).toMatchObject({
      llmProviderKey: 'anthropic',
      llmModel: modelId,
    })
    expect(context.session.runbookAuthoringProposals?.[0]?.proposedRunbook.actions[0]).not.toMatchObject({
      llmProviderKey: 'opencode',
    })
  })

  it('rejects an unknown LLM model instead of saving it into a proposal', async () => {
    const context = createContext()
    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a summary runbook.',
      draftRunbook: {
        title: 'Summary',
        description: 'Summarize evidence.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize',
          prompt: 'Summarize the evidence.',
          llmModel: 'GPT 5.6 Terra (invalid)',
        }],
      },
    })

    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'INVALID_TOOL_ARGUMENTS',
      toolName: 'propose_runbook_create',
      issues: [{ path: 'draftRunbook.actions.0.llmModel' }],
    })
    expect(context.session.runbookAuthoringProposals).toBeUndefined()
  })

  it('rejects an undeclared runbook placeholder before creating a proposal', async () => {
    const context = createContext()
    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a summary runbook.',
      draftRunbook: {
        title: 'Invalid placeholder summary',
        description: 'The proposal should reject step output placeholders.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize',
          prompt: 'Summarize {{step.output}}.',
          llmModel: 'gpt-5.6-terra',
        }],
      },
    })

    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'INVALID_TOOL_ARGUMENTS',
      toolName: 'propose_runbook_create',
      issues: [{ path: 'draftRunbook.actions.0.prompt' }],
    })
    expect(context.session.runbookAuthoringProposals).toBeUndefined()
  })

  it('accepts a declared runbook placeholder in a proposal', async () => {
    const context = createContext()
    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a findings summary runbook.',
      draftRunbook: {
        title: 'Findings summary',
        description: 'Summarize normalized findings.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize findings',
          prompt: 'Summarize {{findings}}.',
          llmModel: 'gpt-5.6-terra',
          parameters: [{ id: 'findings', key: 'findings', required: true }],
        }],
      },
    })

    expect(result?.error).toBeUndefined()
    expect(context.session.runbookAuthoringProposals).toHaveLength(1)
  })

  it('rejects a findings-consuming LLM-only create before pushing a proposal', async () => {
    const context = createContext()
    context.session.normalizedFindings = [{ 'vulnerability.id': 'CVE-2024-0727' }]

    const result = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create an LLM-only CVE summary.',
      draftRunbook: {
        title: 'LLM-only CVE summary',
        description: 'Summarize the attached findings.',
        actions: [{
          id: 'step-summary',
          type: 'llm',
          title: 'Summarize findings',
          prompt: 'Summarize {{findings}}.',
          llmModel: 'gpt-5.6-terra',
          parameters: [{ id: 'findings', key: 'findings', required: true }],
        }],
      },
    })

    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'RUNBOOK_PROPOSAL_VALIDATION',
      toolName: 'propose_runbook_create',
    })
    expect(context.session.runbookAuthoringProposals).toBeUndefined()
  })

  it.each([
    ['propose_runbook_create', 'create'],
    ['propose_runbook_edit', 'edit'],
  ] as const)('rejects a findings-consuming LLM-only %s before pushing a proposal', async (toolName, kind) => {
    const context = createContext()
    context.session.normalizedFindings = [{ 'vulnerability.id': 'CVE-2024-0727' }]

    if (kind === 'edit') {
      context.listAuthorableRunbooks = vi.fn().mockResolvedValue([makeRunbook()])
    }

    const input = kind === 'create'
      ? {
          prompt: 'Create an LLM-only CVE summary.',
          draftRunbook: {
            title: 'LLM-only CVE summary',
            description: 'Summarize the attached findings.',
            actions: [{
              id: 'step-summary',
              type: 'llm',
              title: 'Summarize findings',
              prompt: 'Summarize {{findings}}.',
              llmModel: 'gpt-5.6-terra',
              parameters: [{ id: 'findings', key: 'findings', required: true }],
            }],
          },
        }
      : {
          runbookTitle: 'Investigate Sentry',
          prompt: 'Add an LLM-only CVE summary.',
          operations: [{
            id: 'op-summary',
            type: 'add_action',
            rationale: 'Summarize the attached findings.',
            action: {
              id: 'step-summary',
              type: 'llm',
              title: 'Summarize findings',
              prompt: 'Summarize {{findings}}.',
              llmModel: 'gpt-5.6-terra',
              parameters: [{ id: 'findings', key: 'findings', required: true }],
            },
          }],
        }

    const result = await executeHostTool(context, toolName, input)

    expect(JSON.parse(result?.error ?? '')).toMatchObject({
      code: 'RUNBOOK_PROPOSAL_VALIDATION',
      toolName,
    })
    expect(context.session.runbookAuthoringProposals).toBeUndefined()
  })

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
    const secureParameter = (catalog.runbooks[0]?.parameters as Array<Record<string, unknown>>)
      .find((parameter) => parameter.key === 'apiToken')
    expect(secureParameter).toMatchObject({ key: 'apiToken', required: true })
    expect(secureParameter).not.toHaveProperty('description')
    expect(secureParameter).not.toHaveProperty('defaultValue')
  })

  it('lets an agent discover plugin schemas before creating a valid proposal', async () => {
    const plugin: DesktopPluginDescriptor = {
      id: 'ops-health',
      name: 'Ops Health',
      version: '0.1.0',
      description: 'Health checks for the operations team.',
      type: 'data_source',
      auth: {
        fields: [{
          key: 'apiToken',
          label: 'API token',
          type: 'string',
          required: true,
          secret: true,
          defaultValue: 'do-not-disclose',
        }],
      },
      actions: [{
        id: 'list_checks',
        title: 'List checks',
        description: 'List checks for a team.',
        riskLevel: 'read',
        fields: [{
          key: 'team',
          label: 'Team',
          type: 'string',
          required: true,
          enumValues: ['platform', 'security'],
        }],
      }],
    }
    const context = createContext()
    context.pluginRuntime = {
      listPlugins: () => [plugin],
    }

    const catalogResult = await executeHostTool(context, 'list_plugins', {})
    const catalog = JSON.parse(catalogResult?.output ?? '') as {
      plugins: Array<{
        id: string
        auth: { fields: Array<Record<string, unknown>> }
        actions: Array<{
          id: string
          inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
        }>
      }>
    }
    const discoveredPlugin = catalog.plugins[0]
    const discoveredAction = discoveredPlugin?.actions[0]

    expect(discoveredPlugin?.id).toBe('ops-health')
    expect(discoveredPlugin?.auth).toEqual({
      fields: [{
        key: 'apiToken',
        label: 'API token',
        type: 'string',
        required: true,
        secret: true,
      }],
    })
    expect(discoveredAction?.id).toBe('list_checks')
    expect(discoveredAction?.inputSchema).toMatchObject({
      type: 'object',
      properties: { team: { type: 'string', enum: ['platform', 'security'] } },
      required: ['team'],
    })
    expect(JSON.stringify(catalog)).not.toContain('do-not-disclose')

    const proposalResult = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create a runbook that lists health checks for the platform team.',
      draftRunbook: {
        title: 'List platform health checks',
        description: 'Use the discovered plugin action to list health checks.',
        actions: [{
          id: 'step-list-checks',
          type: 'plugin',
          title: 'List platform checks',
          pluginId: discoveredPlugin?.id,
          pluginActionId: discoveredAction?.id,
          pluginInput: JSON.stringify({ team: 'platform' }),
        }],
      },
    })

    expect(JSON.parse(proposalResult?.output ?? '')).toMatchObject({
      approvalRequired: true,
      saved: false,
      validation: { valid: true, errors: [] },
      proposedRunbook: {
        actions: [{ id: 'step-list-checks', type: 'plugin', title: 'List platform checks' }],
      },
    })
  })

  it('rejects unknown plugin auth keys while accepting descriptor keys', async () => {
    const plugin: DesktopPluginDescriptor = {
      id: 'ops-health',
      name: 'Ops Health',
      version: '0.1.0',
      description: 'Health checks for the operations team.',
      type: 'data_source',
      auth: {
        fields: [{
          key: 'accessToken',
          label: 'Access token',
          type: 'string',
          required: true,
          secret: true,
        }],
      },
      actions: [{
        id: 'list_checks',
        title: 'List checks',
        description: 'List checks for a team.',
        riskLevel: 'read',
        fields: [],
      }],
    }
    const context = createContext()
    context.pluginRuntime = { listPlugins: () => [plugin] }

    const invalidResult = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create an authenticated health-check runbook.',
      draftRunbook: {
        title: 'Invalid auth contract',
        description: 'The proposal should be rejected before approval.',
        actions: [{
          id: 'step-list-checks',
          type: 'plugin',
          title: 'List platform checks',
          pluginId: 'ops-health',
          pluginActionId: 'list_checks',
          pluginAuth: '{"token":"${globals.ops_token}"}',
        }],
      },
    })
    expect(JSON.parse(invalidResult?.output ?? '')).toMatchObject({
      validation: {
        valid: false,
        errors: [expect.stringContaining('unknown auth field "token"')],
      },
    })

    const validResult = await executeHostTool(context, 'propose_runbook_create', {
      prompt: 'Create an authenticated health-check runbook.',
      draftRunbook: {
        title: 'Valid auth contract',
        description: 'The proposal should be approvable.',
        actions: [{
          id: 'step-list-checks',
          type: 'plugin',
          title: 'List platform checks',
          pluginId: 'ops-health',
          pluginActionId: 'list_checks',
          pluginAuth: '{"accessToken":"${globals.ops_token}"}',
        }],
      },
    })
    expect(JSON.parse(validResult?.output ?? '')).toMatchObject({
      validation: { valid: true, errors: [] },
    })
    expect(validResult?.output).not.toContain('do-not-disclose')

    context.listAuthorableRunbooks = vi.fn().mockResolvedValue([makeRunbook()])
    const invalidEditResult = await executeHostTool(context, 'propose_runbook_edit', {
      runbookId: 'rb-sentry',
      prompt: 'Add an authenticated health-check action.',
      operations: [{
        id: 'op-add-checks',
        type: 'add_action',
        rationale: 'Use the plugin to collect health checks.',
        action: {
          id: 'step-list-checks',
          type: 'plugin',
          title: 'List platform checks',
          pluginId: 'ops-health',
          pluginActionId: 'list_checks',
          pluginAuth: '{"token":"${globals.ops_token}"}',
        },
      }],
    })
    expect(JSON.parse(invalidEditResult?.output ?? '')).toMatchObject({
      validation: {
        valid: false,
        errors: [expect.stringContaining('unknown auth field "token"')],
      },
    })
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
