import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopManagedLlmModelHandler } from '../main/platform/app/electron/llm-models'

describe('desktop managed LLM model handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers the CE IPC channel and returns live Anthropic models', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(channel, handler)
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'claude-opus-4-8' }],
      has_more: false,
    }))))

    registerDesktopManagedLlmModelHandler(ipcMain)
    const handler = handlers.get('bitsentry:llm:listModels')
    if (handler === undefined) throw new Error('Model-list IPC handler was not registered')

    const result = await handler({}, 'anthropic', {
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com',
    })

    expect(result).toMatchObject({
      providerKey: 'anthropic',
      models: ['claude-opus-4-8'],
      count: 1,
    })
  })
})
