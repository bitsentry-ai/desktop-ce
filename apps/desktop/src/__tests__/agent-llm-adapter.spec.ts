import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentLlmAdapterService,
  type AgentLlmCredentialsStore,
  type AgentLlmSettingsStore,
  type LocalAiProviderPort,
} from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'
import type { HostToolContext } from '@bitsentry-ce/core/features/agent-runtime'

function createHostToolContext(): HostToolContext {
  return {
    gateway: {
      listExecutable: vi.fn().mockResolvedValue([]),
      getRunbookContext: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      getLatestForIncidentThread: vi.fn(),
      waitForCompletion: vi.fn(),
      subscribe: vi.fn(),
      cancel: vi.fn(),
    },
    session: { id: 'session-under-test' },
  }
}

function createAdapter(credentials?: AgentLlmCredentialsStore): AgentLlmAdapterService {
  const settingsStore: AgentLlmSettingsStore = {
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  }

  return new AgentLlmAdapterService(settingsStore, credentials)
}

function createLocalAiProvider(overrides: Partial<LocalAiProviderPort>): LocalAiProviderPort {
  return {
    isReady: () => true,
    listModels: () => Promise.resolve([]),
    execute: () => Promise.resolve({ output: '' }),
    ...overrides,
  }
}

describe('AgentLlmAdapterService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes a provider-less CLI action by its selected model', async () => {
    const settingsStore: AgentLlmSettingsStore = {
      setting: {
        findUnique: vi.fn().mockResolvedValue({ value: 'codex' }),
      },
    }
    const adapter = new AgentLlmAdapterService(settingsStore)

    // The configured default is Codex, but this model belongs to Claude Code.
    // Selecting it prevents the CLI from receiving a model it cannot serve.
    await expect(adapter.getDefaultProviderKey('claude-sonnet-4-6')).resolves.toBe('claude_code')
    await expect(adapter.getDefaultProviderKey('gpt-5.4')).resolves.toBe('codex')
    await expect(adapter.getDefaultProviderKey('unknown-model')).resolves.toBe('codex')
  })

  it('forwards live text deltas from local CLI providers', async () => {
    const adapter = createAdapter()

    let capturedAccessLevel: Parameters<LocalAiProviderPort['execute']>[6]
    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: () => true,
      execute: (_provider, _prompt, _abortController, onDelta, _cwd, _model, accessLevel) => {
        capturedAccessLevel = accessLevel
        onDelta?.({ type: 'text', text: 'Hel' })
        onDelta?.({ type: 'text', text: 'lo' })
        onDelta?.({
          type: 'token_usage',
          tokenUsage: {
            inputTokens: 3,
            outputTokens: 2,
          },
        })

        return Promise.resolve({
          output: 'Hello',
          tokenUsage: {
            inputTokens: 3,
            outputTokens: 2,
          },
        })
      },
    }))

    const streamed: Array<{ type: string; text?: string }> = []
    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'codex', model: 'gpt-5.4' },
      onDelta: (delta) => {
        if (delta.type === 'text') {
          streamed.push({ type: delta.type, text: delta.text })
        }
      },
    })

    expect(streamed).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
    expect(response.content).toBe('Hello')
    expect(capturedAccessLevel).toBe('auto-accept-edits')
  })

  it('defaults OpenCode to an available free model when no model is saved', async () => {
    const adapter = createAdapter()

    let capturedModel = ''
    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: (provider) => provider === 'opencode',
      listModels: (provider) => {
        let models: string[] = []
        if (provider === 'opencode') {
          models = ['openai/gpt-5', 'opencode/grok-code-fast-free']
        }
        return Promise.resolve(models)
      },
      execute: (_provider, _prompt, _abortController, _onDelta, _cwd, model) => {
        capturedModel = model ?? ''
        return Promise.resolve({ output: 'Hello' })
      },
    }))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'opencode' },
    })

    expect(capturedModel).toBe('opencode/grok-code-fast-free')
    expect(response.content).toBe('Hello')
  })

  it('does not interpret local execution results as MCP tool activity', async () => {
    const adapter = createAdapter()

    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: () => true,
      execute: (_provider, _prompt, _abortController, onDelta) => {
        onDelta?.({ type: 'text', text: 'I found ' })
        onDelta?.({ type: 'text', text: 'two runbooks.' })

        return Promise.resolve({
          output: 'I found two runbooks.',
          toolCalls: [{ id: 'call-1', name: 'list_runbooks', args: {} }],
        })
      },
    }))

    const streamed: string[] = []
    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'List runbooks' }],
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'codex', model: 'gpt-5.4' },
      accessLevel: 'auto-accept-edits',
      hostToolContext: createHostToolContext(),
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text !== '') {
          streamed.push(delta.text)
        }
      },
    })

    expect(streamed.join('')).toBe('I found two runbooks.')
    expect(response.content).toBe('I found two runbooks.')
    expect(response.toolCalls).toEqual([])
    expect(response.toolProtocol).toBe('mcp')
  })

  it('uses MCP without injecting host tool definitions into the prompt', async () => {
    const adapter = createAdapter()
    let capturedPrompt = ''

    adapter.setLocalAiProvider(createLocalAiProvider({
      execute: (_provider, prompt) => {
        capturedPrompt = prompt
        return Promise.resolve({
          output: 'Listing runbooks.',
          toolCalls: [{ id: 'ignored-call', name: 'list_runbooks', args: {} }],
        })
      },
    }))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'List runbooks' }],
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'codex', model: 'gpt-5.4' },
      accessLevel: 'auto-accept-edits',
      hostToolContext: createHostToolContext(),
    })

    expect(response).toMatchObject({
      content: 'Listing runbooks.',
      toolProtocol: 'mcp',
      toolCalls: [],
    })
    expect(capturedPrompt).toBe('[user]: List runbooks')
    expect(capturedPrompt).not.toContain('BitSentry host tool protocol:')
    expect(capturedPrompt).not.toContain('"type":"tool_calls"')
  })

  it('keeps Claude MCP prompts free of the legacy protocol text', async () => {
    const adapter = createAdapter()
    let capturedPrompt = ''
    let capturedSystemPrompt: string | undefined

    adapter.setLocalAiProvider(createLocalAiProvider({
      execute: (_provider, prompt, _abortController, _onDelta, _cwd, _model, _accessLevel, _traits, _context, systemPrompt) => {
        capturedPrompt = prompt
        capturedSystemPrompt = systemPrompt
        return Promise.resolve({ output: 'I found two runbooks.' })
      },
    }))

    const response = await adapter.chatWithTools({
      messages: [
        { role: 'system', content: 'You are an incident-response assistant.' },
        { role: 'user', content: 'List runbooks' },
      ],
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      accessLevel: 'auto-accept-edits',
      hostToolContext: createHostToolContext(),
    })

    expect(capturedPrompt).toBe('[user]: List runbooks')
    expect(capturedPrompt).not.toContain('BitSentry host tool protocol:')
    expect(capturedPrompt).not.toContain('"type":"tool_calls"')
    expect(capturedSystemPrompt).toBe('You are an incident-response assistant.')
    expect(response).toMatchObject({
      content: 'I found two runbooks.',
      toolProtocol: 'mcp',
      toolCalls: [],
    })
  })

  it('extracts system messages for CLI turns without MCP instead of flattening a system role', async () => {
    const adapter = createAdapter()
    let capturedPrompt = ''
    let capturedSystemPrompt: string | undefined

    adapter.setLocalAiProvider(createLocalAiProvider({
      execute: (_provider, prompt, _abortController, _onDelta, _cwd, _model, _accessLevel, _traits, _context, systemPrompt) => {
        capturedPrompt = prompt
        capturedSystemPrompt = systemPrompt
        return Promise.resolve({ output: 'I can help with that.' })
      },
    }))

    const response = await adapter.chatWithTools({
      messages: [
        { role: 'system', content: 'Use concise incident language.' },
        { role: 'user', content: 'Summarize the alert.' },
      ],
      signal: new AbortController().signal,
      llm: { providerKey: 'codex', model: 'gpt-5.4' },
      accessLevel: 'auto-accept-edits',
    })

    expect(capturedPrompt).toBe('[user]: Summarize the alert.')
    expect(capturedPrompt).not.toContain('[system]:')
    expect(capturedSystemPrompt).toBe('Use concise incident language.')
    expect(response.toolProtocol).toBe('none')
  })

  it('normalizes cloud-native function calls into the shared envelope', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'native-call-1',
            function: {
              name: 'list_runbooks',
              arguments: '{}',
            },
          }],
        },
      }],
    }))))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'List runbooks' }],
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-4.1-mini' },
    })

    expect(response).toMatchObject({
      toolProtocol: 'native_function_calling',
      toolCalls: [{
        id: 'native-call-1',
        name: 'list_runbooks',
        args: {},
      }],
    })
  })

  it('emits selected reasoning effort for supported OpenAI-compatible providers', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requestBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'Done' } }],
      })))
    }))

    for (const [providerKey, model, efforts] of [
      ['groq', 'openai/gpt-oss-20b', ['low', 'high']],
      ['kilocode', 'anthropic/claude-opus-4.6', ['low', 'max']],
      ['openrouter', 'openai/gpt-5.2', ['medium', 'xhigh']],
    ] as const) {
      for (const effort of efforts) {
        await adapter.chatWithTools({
          messages: [{ role: 'user', content: 'Explain this briefly.' }],
          signal: new AbortController().signal,
          llm: { providerKey, model },
          traitValues: { effort },
        })
      }
    }

    expect(requestBodies.map((body) => body.reasoning_effort)).toEqual([
      'low', 'high',
      'low', 'max',
      'medium', 'xhigh',
    ])
  })

  it('keeps OpenAI effort clamping and rejects unsupported routed models', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requestBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'Done' } }],
      })))
    }))

    for (const effort of ['xhigh', 'max', 'ultrathink']) {
      await adapter.chatWithTools({
        messages: [{ role: 'user', content: 'Explain this briefly.' }],
        signal: new AbortController().signal,
        llm: { providerKey: 'openai', model: 'gpt-5.2' },
        traitValues: { effort },
      })
    }

    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Explain this briefly.' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'groq', model: 'llama-3.3-70b-versatile' },
      traitValues: { effort: 'high' },
    })

    expect(requestBodies.slice(0, 3).map((body) => body.reasoning_effort)).toEqual([
      'high', 'high', 'high',
    ])
    expect(requestBodies[3]?.reasoning_effort).toBeUndefined()
  })

  it('maps legacy Anthropic effort tiers to distinct manual thinking budgets', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requestBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Done' }],
      })))
    }))

    const expectedBudgets = {
      low: 1024,
      medium: 1536,
      high: 2048,
      max: 3072,
    }

    for (const effort of Object.keys(expectedBudgets)) {
      await adapter.chatWithTools({
        messages: [{ role: 'user', content: 'Solve this task' }],
        signal: new AbortController().signal,
        llm: {
          providerKey: 'anthropic',
          model: 'claude-sonnet-4-5',
          thinkingEnabled: true,
        },
        traitValues: { effort },
      })
    }

    expect(requestBodies).toHaveLength(4)
    expect(requestBodies.map((body) => body.thinking)).toEqual([
      { type: 'enabled', budget_tokens: expectedBudgets.low },
      { type: 'enabled', budget_tokens: expectedBudgets.medium },
      { type: 'enabled', budget_tokens: expectedBudgets.high },
      { type: 'enabled', budget_tokens: expectedBudgets.max },
    ])
    expect(requestBodies.every((body) => body.output_config === undefined)).toBe(true)
  })

  it('maps modern Anthropic effort tiers to adaptive thinking requests', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requestBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Done' }],
      })))
    }))

    for (const [model, effort] of [
      ['claude-sonnet-4-6', 'low'],
      ['claude-opus-4-7', 'max'],
    ] as const) {
      await adapter.chatWithTools({
        messages: [{ role: 'user', content: 'Solve this task' }],
        signal: new AbortController().signal,
        llm: { providerKey: 'anthropic', model, thinkingEnabled: true },
        traitValues: { effort },
      })
    }

    expect(requestBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      }),
      expect.objectContaining({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
      }),
    ]))
    expect(requestBodies.every((body) => {
      const thinking = body.thinking as { budget_tokens?: number } | undefined
      return thinking?.budget_tokens === undefined
    })).toBe(true)
  })

  it('omits Anthropic thinking configuration when thinking is disabled', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Done' }],
      })))
    }))

    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Solve this task' }],
      signal: new AbortController().signal,
      llm: {
        providerKey: 'anthropic',
        model: 'claude-opus-4-7',
        thinkingEnabled: false,
      },
      traitValues: { effort: 'max' },
    })

    expect(requestBody?.thinking).toBeUndefined()
    expect(requestBody?.output_config).toBeUndefined()
  })

  it('keeps a natural MCP CLI response independent of the supplied tool list', async () => {
    const adapter = createAdapter()
    const output = 'I can inspect a runbook after you choose one.'

    adapter.setLocalAiProvider(createLocalAiProvider({
      execute: () => Promise.resolve({ output }),
    }))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'List runbooks' }],
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'codex', model: 'gpt-5.4' },
      accessLevel: 'auto-accept-edits',
      hostToolContext: createHostToolContext(),
    })

    expect(response).toMatchObject({ toolCalls: [], toolProtocol: 'mcp' })
    expect(response.content).toBe(output)
  })

  it('replays only user and assistant chat text to a fresh MCP CLI subprocess', async () => {
    const adapter = createAdapter()

    let capturedPrompt = ''
    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: () => true,
      execute: (_provider, prompt) => {
        capturedPrompt = prompt
        return Promise.resolve({
          output: 'Done',
        })
      },
    }))

    await adapter.chatWithTools({
      messages: [
        { role: 'user', content: 'Check the last runbook' },
        {
          role: 'assistant',
          content: 'I will inspect the runbook execution.',
          toolCalls: [
            {
              id: 'call-1',
              name: 'get_runbook_execution',
              args: { executionId: 'abc' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: '{\n  "executionId": "abc",\n  "status": "completed"\n}',
        },
      ],
      tools: [{
        name: 'get_runbook_execution',
        description: 'Get the latest runbook execution snapshot.',
        inputSchema: {
          type: 'object',
          properties: {
            executionId: { type: 'string' },
          },
        },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      accessLevel: 'auto-accept-edits',
      hostToolContext: createHostToolContext(),
    })

    expect(capturedPrompt).toBe('[user]: Check the last runbook\n[assistant]: I will inspect the runbook execution.')
    expect(capturedPrompt).not.toContain('Internal tool result')
    expect(capturedPrompt).not.toContain('Assistant requested host tool')
    expect(capturedPrompt).not.toContain('BitSentry host tool protocol:')
    expect(capturedPrompt).not.toContain('[tool]:')
  })

})
