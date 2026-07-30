import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentLlmAdapterService,
  type AgentLlmSettingsStore,
  type LocalAiProviderPort,
} from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'

function createAdapter(): AgentLlmAdapterService {
  const settingsStore: AgentLlmSettingsStore = {
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  }

  return new AgentLlmAdapterService(settingsStore)
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

  it('hides streamed host tool-call markup from local CLI provider output', async () => {
    const adapter = createAdapter()

    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: () => true,
      execute: (_provider, _prompt, _abortController, onDelta) => {
        onDelta?.({ type: 'text', text: 'Listing runbooks...\n<bitsentry_tool_' })
        onDelta?.({ type: 'text', text: 'call>\n{"name":"list_runbooks","id":"call-1","args":{}}\n</bitsentry_tool_call>\nDone.' })

        return Promise.resolve({
          output: 'Listing runbooks...\n<bitsentry_tool_call>\n{"name":"list_runbooks","id":"call-1","args":{}}\n</bitsentry_tool_call>\nDone.',
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

    expect(streamed.join('')).toBe('Listing runbooks...\n\nDone.')
    expect(response.content).toBe('Listing runbooks...\n\nDone.')
    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'list_runbooks',
        args: {},
      },
    ])
  })

  it('hides foreign function-call markup while retaining an unfulfilled-tool signal', async () => {
    const adapter = createAdapter()
    const output = [
      "I'll discover the available runbooks for this incident.",
      '<function_calls>',
      '[{"tool_name": "list_runbooks", "arguments": {}}]',
      '</function_calls>',
      '<function_calls>',
      '',
      'Here are the available runbooks for this incident:',
      '',
      '1. **CPU Spike Diagnosis** – Analyzes high CPU usage by examining process metrics.',
    ].join('\n')

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
      llm: { providerKey: 'claude_code', model: 'claude-haiku-4-5' },
      accessLevel: 'auto-accept-edits',
    })

    expect(response.content).toBe("I'll discover the available runbooks for this incident.")
    expect(response.content).not.toContain('<function_calls>')
    expect(response.hasForeignToolCallMarkup).toBe(true)
  })

  it('parses valid host tool calls with attributes on the opening tag', async () => {
    const adapter = createAdapter()
    const output = [
      'Listing runbooks...',
      '<bitsentry_tool_call id="call-attribute">',
      '{"name":"list_runbooks","id":"call-attribute","args":{}}',
      '</bitsentry_tool_call>',
    ].join('\n')

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

    expect(response.toolCalls).toEqual([
      {
        id: 'call-attribute',
        name: 'list_runbooks',
        args: {},
      },
    ])
  })

  it('formats local CLI tool-result transcript as internal context without host wrapper tags', async () => {
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

    expect(capturedPrompt).toContain('Internal tool result for call-1:')
    expect(capturedPrompt).toContain('Assistant requested host tool get_runbook_execution (call-1) with args: {"executionId":"abc"}')
    expect(capturedPrompt).toContain(
      'Do not repeat raw JSON, wrapper tags, or transcript labels unless the user explicitly asks for raw output.',
    )
    expect(capturedPrompt).toContain('BitSentry host tool protocol:')
    expect(capturedPrompt).toContain('The host will execute the operation and append the result as a later tool message in the conversation.')
    expect(capturedPrompt).not.toContain('<bitsentry_tool_result')
    expect(capturedPrompt.split('BitSentry host tool protocol:')[0]).not.toContain('<bitsentry_tool_call')
    expect(capturedPrompt).not.toContain('<bitsentry_host_protocol>')
    expect(capturedPrompt).not.toContain('<bitsentry_host_instruction>')
    expect(capturedPrompt).not.toContain('[tool]:')
  })

  it('strips leaked internal host blocks from streamed local CLI output', async () => {
    const adapter = createAdapter()

    adapter.setLocalAiProvider(createLocalAiProvider({
      isReady: () => true,
      execute: (_provider, _prompt, _abortController, onDelta) => {
        onDelta?.({
          type: 'text',
          text: 'I found the runbook and I am starting it.\n<bitsentry_tool_result tool_call_id="exec-1">\nRunbook execution started.\n</bitsentry_tool_result>\n',
        })
        onDelta?.({
          type: 'text',
          text: [
            '<bitsentry_host_instruction>',
            'Do not repeat raw JSON.',
            '</bitsentry_host_instruction>',
            'Internal tool result for exec-sentry:',
            'Internal execution result:',
            '{',
            '"executionId": "e1b2c3d4-0001-0001-0001-000000000001"',
            '}',
            'Use this result as internal context.',
            'Summarize the important findings for the user in clean Markdown.',
            'Do not repeat raw JSON, wrapper tags, or transcript labels unless the user explicitly asks for raw output.',
            'Next I will check the result.',
          ].join('\n'),
        })

        return Promise.resolve({
          output: [
            'I found the runbook and I am starting it.',
            '<bitsentry_tool_result tool_call_id="exec-1">',
            'Runbook execution started.',
            '</bitsentry_tool_result>',
            '<bitsentry_host_instruction>',
            'Do not repeat raw JSON.',
            '</bitsentry_host_instruction>',
            'Internal tool result for exec-sentry:',
            'Internal execution result:',
            '{',
            '"executionId": "e1b2c3d4-0001-0001-0001-000000000001"',
            '}',
            'Use this result as internal context.',
            'Summarize the important findings for the user in clean Markdown.',
            'Do not repeat raw JSON, wrapper tags, or transcript labels unless the user explicitly asks for raw output.',
            'Next I will check the result.',
          ].join('\n'),
        })
      },
    }))

    const streamed: string[] = []
    const response = await adapter.chatWithTools({
      messages: [{ role: 'user', content: 'Start the runbook' }],
      signal: new AbortController().signal,
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      accessLevel: 'auto-accept-edits',
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text !== '') {
          streamed.push(delta.text)
        }
      },
    })

    expect(streamed.join('')).toContain('I found the runbook and I am starting it.')
    expect(streamed.join('')).toContain('Next I will check the result.')
    expect(streamed.join('')).not.toContain('<bitsentry_tool_result')
    expect(streamed.join('')).not.toContain('<bitsentry_host_instruction')
    expect(streamed.join('')).not.toContain('Internal tool result for exec-sentry:')
    expect(streamed.join('')).not.toContain('"executionId": "e1b2c3d4-0001-0001-0001-000000000001"')
    expect(response.content).not.toContain('<bitsentry_tool_result')
    expect(response.content).not.toContain('Internal tool result for exec-sentry:')
    expect(response.content).not.toContain('"executionId": "e1b2c3d4-0001-0001-0001-000000000001"')
  })

  it('strips leaked internal host blocks from replayed local CLI conversation text', async () => {
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
        {
          role: 'assistant',
          content: [
            'I found two runbooks.',
            '<bitsentry_tool_result tool_call_id="exec-1">',
            'Runbook execution started.',
            '</bitsentry_tool_result>',
            '<bitsentry_host_protocol>',
            'internal stuff',
            '</bitsentry_host_protocol>',
          ].join('\n'),
        },
        { role: 'user', content: 'What next?' },
      ],
      signal: new AbortController().signal,
      llm: { providerKey: 'claude_code', model: 'claude-sonnet-4-6' },
      accessLevel: 'auto-accept-edits',
    })

    expect(capturedPrompt).toContain('[assistant]: I found two runbooks.')
    expect(capturedPrompt).not.toContain('<bitsentry_tool_result')
    expect(capturedPrompt).not.toContain('<bitsentry_host_protocol>')
  })

})
