import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

vi.mock('electron-log', () => ({
  default: mocks.log,
}))

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 1234
  kill = vi.fn()
}

function finishOpenCodeProcess(child: MockChildProcess, stdoutLines: unknown[] = []): void {
  for (const line of stdoutLines) {
    child.stdout.write(`${JSON.stringify(line)}\n`)
  }
  child.stdout.end()
  child.stderr.end()
  child.emit('exit', 0)
  child.emit('close', 0)
}

describe('executeOpenCode', () => {
  afterEach(() => {
    mocks.spawn.mockReset()
    mocks.spawnSync.mockReset()
    mocks.log.warn.mockReset()
    mocks.log.error.mockReset()
    mocks.log.info.mockReset()
    vi.resetModules()
  })

  it('passes selected reasoning effort to opencode run as a model variant', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Investigate the incident',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      cwd: '/tmp/bitsentry-incident',
      model: 'openai/gpt-5',
      accessLevel: 'auto-accept-edits',
      traitValues: { effort: 'high' },
    })

    queueMicrotask(() => { finishOpenCodeProcess(child); })

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const [, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(args).toEqual(expect.arrayContaining(['--variant', 'high']))
    expect(args.indexOf('--variant')).toBeGreaterThan(args.indexOf('run'))
  })

  it('sets OpenCode permissions as a keyed config object for supervised runs', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Summarize the incident',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'supervised',
    })

    queueMicrotask(() => { finishOpenCodeProcess(child); })

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const [, , options] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ]
    const permissionJson = options.env.OPENCODE_PERMISSION
    expect(permissionJson).toBeDefined()
    if (permissionJson === undefined) {
      throw new Error('OpenCode permission JSON was not set')
    }

    const permission = parseJson(permissionJson)
    expect(Array.isArray(permission)).toBe(false)
    expect(permission).toMatchObject({
      '*': 'deny',
      read: 'deny',
      glob: 'deny',
      grep: 'deny',
      bash: 'deny',
      edit: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      question: 'allow',
    })
  })

  it('appends only new text from cumulative OpenCode part updates', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const textDeltas: string[] = []

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Say hello',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text.length > 0) {
          textDeltas.push(delta.text)
        }
      },
    })

    queueMicrotask(() =>
      { finishOpenCodeProcess(child, [
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_1',
              type: 'text',
              text: 'Hel',
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_1',
              type: 'text',
              text: 'Hello',
            },
          },
        },
      ]); },
    )

    await expect(resultPromise).resolves.toMatchObject({
      output: 'Hello',
      exitCode: 0,
    })
    expect(textDeltas.join('')).toBe('Hello')
  })

  it('filters OpenCode part deltas to visible text parts', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const textDeltas: string[] = []

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Edit a file and summarize it',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'full-access',
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text.length > 0) {
          textDeltas.push(delta.text)
        }
      },
    })

    queueMicrotask(() =>
      { finishOpenCodeProcess(child, [
        {
          type: 'message.part.delta',
          properties: {
            part: {
              id: 'tool_part',
              type: 'tool',
            },
            delta: '{"command":"cat package.json"}',
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'patch_part',
              type: 'patch',
            },
            delta: '--- a/file.ts\n+++ b/file.ts',
          },
        },
        {
          type: 'message.part.delta',
          properties: {
            part: {
              id: 'text_part',
              type: 'text',
            },
            delta: 'Done.',
          },
        },
      ]); },
    )

    await expect(resultPromise).resolves.toMatchObject({
      output: 'Done.',
      exitCode: 0,
    })
    expect(textDeltas.join('')).toBe('Done.')
  })

  it('keeps OpenCode reasoning deltas out of final assistant text', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Think privately, then answer',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'full-access',
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text.length > 0) {
          textDeltas.push(delta.text)
        }
        if (delta.type === 'reasoning' && delta.text !== undefined && delta.text.length > 0) {
          reasoningDeltas.push(delta.text)
        }
      },
    })

    queueMicrotask(() =>
      { finishOpenCodeProcess(child, [
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'reasoning_part',
              type: 'reasoning',
              text: 'private chain',
            },
          },
        },
        {
          type: 'message.part.delta',
          properties: {
            part: {
              id: 'reasoning_part',
              type: 'reasoning',
            },
            delta: ' of thought',
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'text_part',
              type: 'text',
              text: 'Final answer.',
            },
          },
        },
      ]); },
    )

    await expect(resultPromise).resolves.toMatchObject({
      output: 'Final answer.',
      exitCode: 0,
    })
    expect(textDeltas.join('')).toBe('Final answer.')
    expect(reasoningDeltas.join('')).toBe('private chain of thought')
  })

  it('waits for stdout to drain after the process exits', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Say hello',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    queueMicrotask(() => {
      child.emit('exit', 0)
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_1',
              type: 'text',
              text: 'Hello after exit',
            },
          },
        })}\n`)
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      }, 0)
    })

    await expect(resultPromise).resolves.toMatchObject({
      output: 'Hello after exit',
      exitCode: 0,
    })
  })

  it('does not emit a late OpenCode stream event after cancellation', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const abortController = new AbortController()
    const textDeltas: string[] = []

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )
    const resultPromise = executeOpenCode({
      prompt: 'Cancel immediately',
      binaryPath: 'opencode',
      abortController,
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    abortController.abort()
    child.stdout.write(`${JSON.stringify({
      type: 'message.part.updated',
      properties: {
        part: { id: 'late-part', type: 'text', text: 'late output' },
      },
    })}\n`)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)

    await expect(resultPromise).resolves.toMatchObject({ output: '', exitCode: 0 })
    expect(textDeltas).toEqual([])
  })

  it('surfaces JSON error events from OpenCode failures', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)

    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'Use a missing model',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({
        type: 'error',
        error: {
          name: 'ProviderError',
          data: {
            message: 'model opencode/missing-model is not available',
          },
        },
      })}\n`)
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 1)
      child.emit('close', 1)
    })

    await expect(resultPromise).rejects.toThrow(
      'OpenCode exited with code 1: model opencode/missing-model is not available',
    )
  })
})
