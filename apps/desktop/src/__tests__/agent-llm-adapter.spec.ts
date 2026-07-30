import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentLlmAdapterService,
  type AgentLlmCredentialsStore,
  type AgentLlmSettingsStore,
  type LocalAiProviderPort,
} from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'

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
    })

    expect(capturedPrompt).toBe('[user]: Check the last runbook\n[assistant]: I will inspect the runbook execution.')
    expect(capturedPrompt).not.toContain('Internal tool result')
    expect(capturedPrompt).not.toContain('Assistant requested host tool')
    expect(capturedPrompt).not.toContain('BitSentry host tool protocol:')
    expect(capturedPrompt).not.toContain('[tool]:')
  })

})
