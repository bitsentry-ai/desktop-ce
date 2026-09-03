import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentLlmAdapterService,
  type AgentLlmCredentialsStore,
  type AgentLlmSettingsStore,
  type LocalAiProviderPort,
} from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'
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

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys)
  }

  if (value === null || typeof value !== 'object') {
    return []
  }

  return Object.entries(value).flatMap(([key, child]) => [key, ...collectObjectKeys(child)])
}

const GEMINI_SCHEMA_FORBIDDEN_KEYS = new Set([
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'const',
  'allOf',
  'oneOf',
  'exclusiveMinimum',
  'additionalItems',
  'prefixItems',
])

describe('AgentLlmAdapterService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setCodingAgentsLoggerForTesting({ info: () => {}, warn: () => {}, error: () => {} })
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

  it('routes provider-less remote catalog models to their native provider', async () => {
    const settingsStore: AgentLlmSettingsStore = {
      setting: {
        findUnique: vi.fn().mockResolvedValue({ value: 'openai' }),
      },
    }
    const adapter = new AgentLlmAdapterService(settingsStore)

    await expect(adapter.getDefaultProviderKey('gpt-5.6-terra')).resolves.toBe('openai')
    await expect(adapter.getDefaultProviderKey('claude-fable-5')).resolves.toBe('anthropic')
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
      usage: { prompt_tokens: 12, completion_tokens: 3 },
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
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 3,
        contextTokens: 15,
        contextLimit: 1_047_576,
      },
    })
  })

  it('adds catalog context metadata to OpenAI streaming usage', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Done"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":24}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseBody, {
      headers: { 'content-type': 'text/event-stream' },
    })))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.6-luna' },
    })

    expect(response).toMatchObject({
      content: 'Done',
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 24,
        contextTokens: 144,
        contextLimit: 1_050_000,
      },
    })
  })

  it('keeps context totals when a cloud model is not in the catalog', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Done' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }))))

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'unlisted-model' },
    })

    expect(response.tokenUsage).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
      contextTokens: 13,
    })
    expect(response.tokenUsage?.contextLimit).toBeUndefined()
  })

  it('serializes nested Gemini tool schemas in the provider wire format', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Done' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      })))
    }))

    const inputSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: {
            $ref: '#/$defs/Value',
            description: 'Values to record.',
          },
        },
        unsupported: {
          const: 'not-supported',
          allOf: [{ type: 'string' }],
          oneOf: [{ type: 'string' }],
          exclusiveMinimum: 0,
          additionalItems: false,
          prefixItems: [{ type: 'string' }],
        },
        cycle: { $ref: '#/$defs/Node' },
      },
      additionalProperties: false,
      $defs: {
        Value: {
          type: 'object',
          properties: { label: { type: 'string', const: 'label' } },
          additionalProperties: false,
        },
        Node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/Node' } },
        },
      },
    }

    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [{ name: 'record_values', description: 'Record values.', inputSchema }],
      signal: new AbortController().signal,
      llm: { providerKey: 'gemini', model: 'gemini-3.5-flash' },
    })

    expect(response.content).toBe('Done')
    expect(response.tokenUsage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      contextTokens: 10,
      contextLimit: 1_048_576,
    })
    const tools = requestBody?.tools as Array<Record<string, unknown>> | undefined
    const declarations = tools?.[0]?.functionDeclarations as Array<Record<string, unknown>> | undefined
    const parameters = declarations?.[0]?.parameters as Record<string, unknown> | undefined
    if (parameters === undefined) {
      throw new Error('Gemini function declaration parameters were not emitted')
    }

    const parameterProperties = parameters.properties as Record<string, unknown>
    const nestedItems = (parameterProperties.values as Record<string, unknown>)?.items

    const forbiddenKeys = collectObjectKeys(parameters).filter((key) =>
      GEMINI_SCHEMA_FORBIDDEN_KEYS.has(key),
    )

    expect(forbiddenKeys).toEqual([])
    expect(nestedItems).toMatchObject({
      type: 'object',
      properties: { label: { type: 'string' } },
      description: 'Values to record.',
    })
    expect(parameterProperties.unsupported).toEqual({})
    expect(
      ((parameterProperties.cycle as Record<string, unknown>).properties as Record<string, unknown>).next,
    ).toEqual({ type: 'object' })
  })

  it('uses Gemini 3 thinkingLevel without sending the legacy thinkingBudget', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Done' }] } }],
      })))
    }))

    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Explain the alert.' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'gemini', model: 'gemini-3.5-flash', thinkingEnabled: true },
      traitValues: { thinkingLevel: 'low' },
    })

    expect(requestBody?.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: 'low' },
    })
    expect(requestBody?.generationConfig).not.toHaveProperty('thinkingBudget')
  })

  it('replays Gemini thought signatures on the next tool turn', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requestBodies: Array<Record<string, unknown>> = []
    let responseNumber = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      responseNumber += 1
      const response = responseNumber === 1
        ? {
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'list_runbooks', args: {} },
                    thoughtSignature: 'AgQKA...',
                  },
                  { functionCall: { name: 'get_runbook', args: { id: 'runbook-1' } } },
                ],
              },
            }],
          }
        : {
            candidates: [{ content: { parts: [{ text: 'Done' }] } }],
          }
      return Promise.resolve(new Response(JSON.stringify(response)))
    }))

    const firstResponse = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'List runbooks.' }],
      tools: [
        { name: 'list_runbooks', description: 'List available runbooks.', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_runbook', description: 'Get a runbook.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
      llm: { providerKey: 'gemini', model: 'gemini-3.6-flash' },
    })

    await adapter.chatWithTools({
      messages: [
        { role: 'user', content: 'List runbooks.' },
        { role: 'assistant', content: '', toolCalls: firstResponse.toolCalls },
        { role: 'tool', content: 'No runbooks found.', toolCallId: firstResponse.toolCalls?.[0]?.id },
        { role: 'tool', content: 'Runbook details.', toolCallId: firstResponse.toolCalls?.[1]?.id },
      ],
      tools: [
        { name: 'list_runbooks', description: 'List available runbooks.', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_runbook', description: 'Get a runbook.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
      llm: { providerKey: 'gemini', model: 'gemini-3.6-flash' },
    })

    expect(firstResponse.toolCalls).toMatchObject([{
      name: 'list_runbooks',
      args: {},
      thoughtSignature: 'AgQKA...',
    }, {
      name: 'get_runbook',
      args: { id: 'runbook-1' },
    }])
    expect(requestBodies[1]?.contents).toEqual([
      { role: 'user', parts: [{ text: 'List runbooks.' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'list_runbooks', args: {} },
            thoughtSignature: 'AgQKA...',
          },
          { functionCall: { name: 'get_runbook', args: { id: 'runbook-1' } } },
        ],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: firstResponse.toolCalls?.[0]?.id,
            response: { result: 'No runbooks found.' },
          },
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: firstResponse.toolCalls?.[1]?.id,
            response: { result: 'Runbook details.' },
          },
        }],
      },
    ])
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

  it('routes GPT-5.6 tool calls with effort through the OpenAI Responses API', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      const responseBody = requests.length === 1
        ? {
            output: [{
              type: 'function_call',
              call_id: 'call-shell',
              name: 'execute_shell_command',
              arguments: '{"command":"pwd"}',
            }],
            usage: { input_tokens: 4, output_tokens: 3 },
          }
        : { choices: [{ message: { content: 'Done' } }] }
      return Promise.resolve(new Response(JSON.stringify(responseBody)))
    }))

    const tool = {
      name: 'execute_shell_command',
      description: 'Execute a shell command.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    }
    const firstResponse = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Print the working directory.' }],
      tools: [tool],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.6-terra' },
      traitValues: { effort: 'medium' },
    })
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Explain this briefly.' }],
      tools: [tool],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.5' },
      traitValues: { effort: 'medium' },
    })

    expect(requests.map((request) => request.url)).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/chat/completions',
    ])
    expect(requests[0]?.body).toMatchObject({
      reasoning: { effort: 'medium' },
      tools: [{
        type: 'function',
        name: 'execute_shell_command',
      }],
    })
    expect(requests[0]?.body.reasoning_effort).toBeUndefined()
    expect(firstResponse).toMatchObject({
      content: '',
      toolProtocol: 'native_function_calling',
      toolCalls: [{
        id: 'call-shell',
        name: 'execute_shell_command',
        args: { command: 'pwd' },
      }],
      tokenUsage: {
        inputTokens: 4,
        outputTokens: 3,
        contextTokens: 7,
        contextLimit: 1_050_000,
      },
    })
  })

  it('routes GPT-5.6 tool calls without effort through Responses with the catalog default', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Promise.resolve(new Response(JSON.stringify({ output_text: 'Done' })))
    }))

    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Summarize this runbook result.' }],
      tools: [{
        name: 'execute_shell_command',
        description: 'Execute a shell command.',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.6-terra' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/responses')
    expect(requests[0]?.body).toMatchObject({
      reasoning: { effort: 'medium' },
      tools: [{ type: 'function', name: 'execute_shell_command' }],
    })
  })

  it('logs effort evidence from the serialized provider request body', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    const infos: unknown[][] = []
    setCodingAgentsLoggerForTesting({
      info: (...args) => { infos.push(args) },
      warn: () => {},
      error: () => {},
    })
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.includes('/responses')) {
        return Promise.resolve(new Response(JSON.stringify({ output_text: 'Done' })))
      }
      if (url.includes('anthropic')) {
        return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: 'Done' }] })))
      }
      if (url.includes('generativelanguage')) {
        return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Done' }] } }] })))
      }
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] })))
    }))

    const tool = {
      name: 'execute_shell_command',
      description: 'Execute a shell command.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    }
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Explain this briefly.' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.5' },
      traitValues: { effort: 'medium' },
    })
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Print the working directory.' }],
      tools: [tool],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.6-terra' },
      traitValues: { effort: 'medium' },
    })
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Solve this task.' }],
      signal: new AbortController().signal,
      llm: {
        providerKey: 'anthropic',
        model: 'claude-sonnet-4-5',
        thinkingEnabled: true,
      },
      traitValues: { effort: 'medium' },
    })
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Solve this task.' }],
      signal: new AbortController().signal,
      llm: {
        providerKey: 'anthropic',
        model: 'claude-sonnet-4-6',
        thinkingEnabled: true,
      },
      traitValues: { effort: 'low' },
    })
    await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Solve this task.' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'gemini', model: 'gemini-3-flash-preview' },
      traitValues: { thinkingLevel: 'medium' },
    })

    const evidence = infos
      .filter(([label]) => label === '[effort-evidence]')
      .map(([, entry]) => entry as Record<string, unknown>)
    expect(evidence).toHaveLength(5)
    const serializedEfforts = [
      requests[0]?.body.reasoning_effort,
      (requests[1]?.body.reasoning as Record<string, unknown> | undefined)?.effort,
      (requests[2]?.body.thinking as Record<string, unknown> | undefined)?.budget_tokens,
      (requests[3]?.body.output_config as Record<string, unknown> | undefined)?.effort,
      (((requests[4]?.body.generationConfig as Record<string, unknown> | undefined)
        ?.thinkingConfig) as Record<string, unknown> | undefined)?.thinkingLevel,
    ]
    expect(evidence).toEqual([
      {
        provider: 'openai',
        model: 'gpt-5.5',
        endpoint: '/v1/chat/completions',
        effort: serializedEfforts[0],
        parameter: 'reasoning_effort',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        endpoint: '/v1/responses',
        effort: serializedEfforts[1],
        parameter: 'reasoning.effort',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        endpoint: '/v1/messages',
        effort: serializedEfforts[2],
        parameter: 'thinking.budget_tokens',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        endpoint: '/v1/messages',
        effort: serializedEfforts[3],
        parameter: 'output_config.effort',
      },
      {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        endpoint: '/v1beta/models/gemini-3-flash-preview:generateContent',
        effort: serializedEfforts[4],
        parameter: 'generationConfig.thinkingConfig.thinkingLevel',
      },
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
      xhigh: 3072,
      ultrathink: 3072,
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

    expect(requestBodies).toHaveLength(6)
    expect(requestBodies.map((body) => body.thinking)).toEqual([
      { type: 'enabled', budget_tokens: expectedBudgets.low },
      { type: 'enabled', budget_tokens: expectedBudgets.medium },
      { type: 'enabled', budget_tokens: expectedBudgets.high },
      { type: 'enabled', budget_tokens: expectedBudgets.max },
      { type: 'enabled', budget_tokens: expectedBudgets.xhigh },
      { type: 'enabled', budget_tokens: expectedBudgets.ultrathink },
    ])
    expect(requestBodies.every((body) => body.output_config === undefined)).toBe(true)
  })

  it('serializes Responses image content with input_image blocks', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({ output_text: 'Done' })))
    }))

    await adapter.chatWithTools({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this image.' },
          {
            type: 'image',
            image: {
              type: 'image',
              name: 'incident.png',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,AAAA',
            },
          },
        ],
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'openai', model: 'gpt-5.6-terra' },
      tools: [{
        name: 'list_runbooks',
        description: 'List available runbooks.',
        inputSchema: { type: 'object', properties: {} },
      }],
      traitValues: { effort: 'medium' },
    })

    expect(requestBody?.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this image.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    }])
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
      ['claude-fable-5', 'high'],
      ['claude-opus-5', 'medium'],
      ['claude-sonnet-5', 'low'],
      ['claude-opus-4-8', 'max'],
      ['claude-sonnet-4-6', 'low'],
      ['claude-opus-4-7', 'max'],
      ['claude-sonnet-4-6', 'xhigh'],
      ['claude-opus-4-7', 'ultrathink'],
    ] as const) {
      await adapter.chatWithTools({
        messages: [{ role: 'user', content: 'Solve this task' }],
        signal: new AbortController().signal,
        llm: { providerKey: 'anthropic', model, thinkingEnabled: true },
        traitValues: { effort },
      })
    }

    expect(requestBodies.map((body) => {
      const outputConfig = body.output_config as { effort: string }
      return outputConfig.effort
    })).toEqual(['high', 'medium', 'low', 'max', 'low', 'max', 'max', 'max'])
    expect(requestBodies.every((body) => {
      const thinking = body.thinking as { budget_tokens?: number } | undefined
      return thinking?.budget_tokens === undefined
    })).toBe(true)
    expect(requestBodies.every((body) =>
      !('temperature' in body) && !('top_p' in body) && !('top_k' in body),
    )).toBe(true)
  })

  it('round-trips Anthropic tool history without an empty assistant text block', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Tool round-trip complete.' }],
      })))
    }))

    const response = await adapter.chatWithTools({
      messages: [
        { role: 'user', content: 'Inspect the runbook.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call-runbook',
            name: 'get_runbook_execution',
            args: { executionId: 'execution-1' },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-runbook',
          content: '{"status":"completed"}',
        },
      ],
      tools: [{
        name: 'get_runbook_execution',
        description: 'Get a runbook execution.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'anthropic', model: 'claude-opus-4-8' },
    })

    const messages = requestBody?.messages as Array<{ role: string; content: unknown }>
    const assistantMessage = messages.find((message) => message.role === 'assistant')
    const assistantContent = assistantMessage?.content as Array<Record<string, unknown>>

    expect(response.content).toBe('Tool round-trip complete.')
    expect(assistantContent).toEqual([{
      type: 'tool_use',
      id: 'call-runbook',
      name: 'get_runbook_execution',
      input: { executionId: 'execution-1' },
    }])
    expect(JSON.stringify(requestBody)).not.toContain('"type":"text","text":""')
  })

  it('preserves non-empty Anthropic assistant text alongside tool_use', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Done.' }],
      })))
    }))

    await adapter.chatWithTools({
      messages: [{
        role: 'assistant',
        content: 'I found the runbook.',
        toolCalls: [{
          id: 'call-runbook',
          name: 'get_runbook_execution',
          args: { executionId: 'execution-1' },
        }],
      }],
      tools: [{
        name: 'get_runbook_execution',
        description: 'Get a runbook execution.',
        inputSchema: { type: 'object', properties: {} },
      }],
      signal: new AbortController().signal,
      llm: { providerKey: 'anthropic', model: 'claude-opus-4-8' },
    })

    const messages = requestBody?.messages as Array<{ role: string; content: unknown }>
    const assistantMessage = messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.content).toEqual([
      { type: 'text', text: 'I found the runbook.' },
      {
        type: 'tool_use',
        id: 'call-runbook',
        name: 'get_runbook_execution',
        input: { executionId: 'execution-1' },
      },
    ])
  })

  it('omits empty plain Anthropic text content', async () => {
    const adapter = createAdapter({
      getApiKey: () => Promise.resolve('test-key'),
    })
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Done.' }],
      })))
    }))

    await adapter.chatWithTools({
      messages: [{ role: 'assistant', content: '' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'anthropic', model: 'claude-opus-4-8' },
    })

    const messages = requestBody?.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]?.content).toEqual([])
    expect(JSON.stringify(requestBody)).not.toContain('"type":"text","text":""')
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
        usage: { input_tokens: 6, output_tokens: 2 },
      })))
    }))

    const response = await adapter.chatWithTools({
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
    expect(response.tokenUsage).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      contextTokens: 8,
      contextLimit: 1_000_000,
    })
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
