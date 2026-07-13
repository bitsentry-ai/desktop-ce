import { describe, expect, it, vi } from 'vitest'

import {
  DesktopIpcDispatchError,
  DesktopIpcDispatcher,
} from '@bitsentry-ce/components/services'
import { validateIpcPayload } from '../main/platform/app/ipc/schemas'

function createDispatcher(): DesktopIpcDispatcher {
  return new DesktopIpcDispatcher({
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    captureException: vi.fn(),
    validatePayload: validateIpcPayload,
  })
}

describe('desktop IPC dispatch boundary', () => {
  it('accepts a valid runbook execution request and passes only the validated payload', async () => {
    const dispatcher = createDispatcher()
    const handler = vi.fn((payload: unknown) => Promise.resolve(payload))
    dispatcher.register('runbooks:execute', handler)

    const result = await dispatcher.dispatch('runbooks:execute', {
      runbookId: 'runbook-1',
      accessLevel: 'supervised',
    })

    expect(result).toEqual({ runbookId: 'runbook-1', accessLevel: 'supervised' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects malformed input before it reaches an execution handler', async () => {
    const dispatcher = createDispatcher()
    const handler = vi.fn(() => Promise.resolve({ ok: true }))
    dispatcher.register('runbooks:execute', handler)

    await expect(dispatcher.dispatch('runbooks:execute', {
      runbookId: '',
      accessLevel: 'unrestricted',
    })).rejects.toMatchObject<Partial<DesktopIpcDispatchError>>({
      code: 'validation_error',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ['agent:start', { prompt: 'Summarize the local logs.' }],
    ['runbooks:exportToFile', { ids: ['runbook-1'], filePath: '/tmp/runbooks.json' }],
    ['runbooks:importFromFile', { filePath: '/tmp/runbooks.json', options: {} }],
  ] as const)(
    'passes only validated %s payloads to its high-risk handler',
    async (channel, payload) => {
      const dispatcher = createDispatcher()
      const handler = vi.fn((received: unknown) => Promise.resolve(received))
      dispatcher.register(channel, handler)

      await expect(dispatcher.dispatch(channel, payload)).resolves.toEqual(payload)
      expect(handler).toHaveBeenCalledWith(payload)
    },
  )

  it('blocks renderer attempts to invoke an uncontracted path', async () => {
    const dispatcher = createDispatcher()

    await expect(dispatcher.dispatch('shell:run', { command: 'rm -rf /' })).rejects.toMatchObject<
      Partial<DesktopIpcDispatchError>
    >({
      code: 'forbidden',
      message: 'Blocked RPC channel: shell:run',
    })
  })
})
