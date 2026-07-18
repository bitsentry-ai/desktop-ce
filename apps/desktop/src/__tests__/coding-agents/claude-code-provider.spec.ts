import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ClaudeQuerySession = AsyncIterable<unknown> & {
  getContextUsage: () => Promise<{ totalTokens: number; maxTokens: number }>
  close: () => void
}

interface SpawnClaudeCodeProcessInput {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

type SpawnedClaudeCodeProcess = EventEmitter & {
  stdin: object
  stdout: object
  pid: number
  killed: boolean
  exitCode: number | null
  kill: (signal?: NodeJS.Signals) => boolean
}

interface ClaudeQueryOptions {
  permissionMode?: string
  includePartialMessages?: boolean
  allowDangerouslySkipPermissions?: boolean
  betas?: string[]
  spawnClaudeCodeProcess?: (input: SpawnClaudeCodeProcessInput) => ChildProcess
}

interface ClaudeQueryInput {
  prompt: string
  options?: ClaudeQueryOptions
}

const closeMock = vi.fn()
const getContextUsageMock = vi.fn()
const queryMock = vi.fn<(input: ClaudeQueryInput) => ClaudeQuerySession>()
const spawnMock = vi.hoisted(() => vi.fn())
const spawnSyncMock = vi.hoisted(() => vi.fn())
const logMock = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}

vi.mock('electron-log', () => ({
  default: logMock,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}))

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

function restorePlatform(): void {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  }
}

function getQueryOptions(callIndex: number): ClaudeQueryOptions {
  const call = queryMock.mock.calls[callIndex]
  return call[0].options ?? {}
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

describe('executeClaudeCode', () => {
  afterEach(() => {
    closeMock.mockReset()
    getContextUsageMock.mockReset()
    queryMock.mockReset()
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    logMock.warn.mockReset()
    logMock.error.mockReset()
    logMock.info.mockReset()
    restorePlatform()
    vi.resetModules()
  })

  it('streams leading text blocks and ignores transport-close context usage errors', async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'text',
              text: '## Summary\n',
            },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: '- first finding',
            },
          },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: '## Summary\n- first finding',
          usage: {
            input_tokens: 5,
            output_tokens: 4,
          },
        }
      },
      getContextUsage: getContextUsageMock.mockRejectedValue(
        new Error('ProcessTransport is not ready for writing'),
      ),
      close: closeMock,
    })

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    const streamed: string[] = []
    const result = await executeClaudeCode({
      prompt: 'Summarize the findings',
      binaryPath: 'claude',
      abortController: new AbortController(),
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined && delta.text.length > 0) {
          streamed.push(delta.text)
        }
      },
    })

    expect(streamed.join('')).toBe('## Summary\n- first finding')
    expect(streamed.length).toBeGreaterThan(2)
    expect(result.output).toBe('## Summary\n- first finding')
    expect(result.tokenUsage).toEqual({
      inputTokens: 5,
      outputTokens: 4,
    })
    expect(logMock.warn).not.toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('handles delayed startup plus malformed and partial stream messages without corrupting later output', async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await delay(10)
        yield { type: 'stream_event' }
        yield 'not a Claude SDK message'
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'partial' },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' response' },
          },
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: 'partial response',
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const statuses: string[] = []
    const textDeltas: string[] = []
    const execution = executeClaudeCode({
      prompt: 'Recover from a delayed malformed stream',
      binaryPath: 'claude',
      abortController: new AbortController(),
      onDelta: (delta) => {
        if (delta.type === 'status' && delta.status !== undefined) statuses.push(delta.status)
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    await expect(execution).resolves.toMatchObject({
      output: 'partial response',
    })
    expect(textDeltas.join('')).toBe('partial response')
    expect(statuses).toEqual(['started', 'completed'])
  })

  it('keeps concurrent Claude turns correlated when their stream completion is out of order', async () => {
    const releaseFirst = (() => {
      let release: (() => void) | undefined
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release: () => release?.() }
    })()
    const releaseSecond = (() => {
      let release: (() => void) | undefined
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release: () => release?.() }
    })()

    queryMock.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        if (prompt === 'first turn') await releaseFirst.promise
        if (prompt === 'second turn') await releaseSecond.promise
        let result = 'turn-second'
        if (prompt === 'first turn') {
          result = 'turn-first'
        }
        yield {
          type: 'result',
          subtype: 'success',
          result,
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    }))

    const { __setLoadClaudeSdkQueryForTests, executeClaudeCode: executeSharedClaudeCode } =
      await import('@bitsentry-ce/coding-agents')
    __setLoadClaudeSdkQueryForTests(() => queryMock)

    const first = executeSharedClaudeCode({
      prompt: 'first turn',
      binaryPath: 'claude',
      abortController: new AbortController(),
    })
    const second = executeSharedClaudeCode({
      prompt: 'second turn',
      binaryPath: 'claude',
      abortController: new AbortController(),
    })

    try {
      await vi.waitFor(() => {
        expect(queryMock).toHaveBeenCalledTimes(2)
      })
      releaseSecond.release()
      await expect(second).resolves.toMatchObject({ output: 'turn-second' })
      releaseFirst.release()
      await expect(first).resolves.toMatchObject({ output: 'turn-first' })
    } finally {
      __setLoadClaudeSdkQueryForTests(undefined)
    }
  })

  it('does not emit a late Claude stream event after cancellation', async () => {
    const abortController = new AbortController()
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'before cancellation' },
          },
        }
        abortController.abort()
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' late output' },
          },
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const textDeltas: string[] = []
    const result = await executeClaudeCode({
      prompt: 'Cancel after the first chunk',
      binaryPath: 'claude',
      abortController,
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    expect(result.output).toBe('before cancellation')
    expect(textDeltas.join('')).toBe('before cancellation')
  })

  it('cancels a hung Claude stream without accepting the event released afterwards', async () => {
    const abortController = new AbortController()
    let releaseHungEvent: (() => void) | undefined
    const hungEvent = new Promise<void>((resolve) => {
      releaseHungEvent = resolve
    })
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'before hang' },
          },
        }
        await hungEvent
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' late after hang' },
          },
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })
    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const textDeltas: string[] = []
    const execution = executeClaudeCode({
      prompt: 'Cancel while provider is hung',
      binaryPath: 'claude',
      abortController,
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    await vi.waitFor(() => {
      expect(textDeltas.join('')).toBe('before hang')
    })
    abortController.abort()
    releaseHungEvent?.()

    await expect(execution).resolves.toMatchObject({ output: 'before hang' })
    expect(textDeltas.join('')).toBe('before hang')
  })

  it('reports a Claude configuration failure before a session can start', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('selected model is not configured')
    })
    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const statuses: string[] = []

    await expect(
      executeClaudeCode({
        prompt: 'Use the missing model',
        binaryPath: 'claude',
        abortController: new AbortController(),
        onDelta: (delta) => {
          if (delta.type === 'status' && delta.status !== undefined) {
            statuses.push(delta.status)
          }
        },
      }),
    ).rejects.toThrow('selected model is not configured')

    expect(statuses).toEqual(['started', 'failed'])
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('fails a started turn when its Claude child stream exits unexpectedly', async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'before exit' },
          },
        }
        throw new Error('Claude Code child exited during active turn')
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })
    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const statuses: string[] = []

    await expect(
      executeClaudeCode({
        prompt: 'Handle a child exit',
        binaryPath: 'claude',
        abortController: new AbortController(),
        onDelta: (delta) => {
          if (delta.type === 'status' && delta.status !== undefined) statuses.push(delta.status)
        },
      }),
    ).rejects.toThrow('Claude Code child exited during active turn')

    expect(statuses).toEqual(['started', 'failed'])
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('passes Claude Code native permission modes for local access levels', async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    await executeClaudeCode({
      prompt: 'Edit safely',
      binaryPath: 'claude',
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    await executeClaudeCode({
      prompt: 'Use full access',
      binaryPath: 'claude',
      abortController: new AbortController(),
      accessLevel: 'full-access',
    })

    const autoAcceptOptions = getQueryOptions(0)
    const fullAccessOptions = getQueryOptions(1)

    expect(autoAcceptOptions).toMatchObject({
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
    })
    expect(autoAcceptOptions.allowDangerouslySkipPermissions).toBeUndefined()

    expect(fullAccessOptions).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    })
  })

  it('enables the Claude 1M context beta when requested', async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'result',
          subtype: 'success',
          result: '',
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue({
        totalTokens: 0,
        maxTokens: 0,
      }),
      close: closeMock,
    })

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    await executeClaudeCode({
      prompt: 'Use the larger context window',
      binaryPath: 'claude',
      abortController: new AbortController(),
      contextWindow: '1m',
    })

    expect(getQueryOptions(0).betas).toEqual(['context-1m-2025-08-07'])
  })

  it('wraps Windows npm .cmd shims with the SDK spawn hook', async () => {
    stubPlatform('win32')
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done',
        }
      },
      getContextUsage: getContextUsageMock.mockResolvedValue(undefined),
      close: closeMock,
    })

    const spawnedProcess: SpawnedClaudeCodeProcess = Object.assign(new EventEmitter(), {
      stdin: {},
      stdout: {},
      pid: 1234,
      killed: false,
      exitCode: null,
      kill: vi.fn(() => true),
    })
    spawnMock.mockReturnValue(spawnedProcess)

    const { executeClaudeCode } =
      await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    await executeClaudeCode({
      prompt: 'Run Claude',
      binaryPath: 'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd',
      abortController: new AbortController(),
    })

    const queryOptions = getQueryOptions(queryMock.mock.calls.length - 1)
    expect(queryOptions.spawnClaudeCodeProcess).toEqual(expect.any(Function))

    const abortController = new AbortController()
    const spawnClaudeCodeProcess = queryOptions.spawnClaudeCodeProcess
    if (spawnClaudeCodeProcess === undefined) {
      throw new Error('Expected Windows Claude Code spawn hook to be installed')
    }
    const spawned = spawnClaudeCodeProcess({
      command: 'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Users\\User\\Project',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      signal: abortController.signal,
    })

    expect(spawned).toBe(spawnedProcess)
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '"\"C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd\" \"--output-format\" \"stream-json\""',
      ],
      expect.objectContaining({
        cwd: 'C:\\Users\\User\\Project',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    )
    abortController.abort()
    expect(spawned.kill).toHaveBeenCalledWith('SIGTERM')
    spawnedProcess.emit('close', 0)
  })
})
