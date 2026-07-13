import { afterEach, describe, expect, it, vi } from 'vitest'

type ClaudeQuerySession = AsyncIterable<unknown> & {
  getContextUsage: () => Promise<unknown>
  close: () => void
}

interface SpawnClaudeCodeProcessInput {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  signal: AbortSignal
}

interface SpawnedClaudeCodeProcess {
  stdin: object
  stdout: object
  pid: number
  killed: boolean
  exitCode: number | null
  kill: () => boolean
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
}

interface ClaudeQueryOptions {
  permissionMode?: string
  includePartialMessages?: boolean
  allowDangerouslySkipPermissions?: boolean
  betas?: string[]
  spawnClaudeCodeProcess?: (
    input: SpawnClaudeCodeProcessInput,
  ) => SpawnedClaudeCodeProcess
}

interface ClaudeQueryInput {
  options: ClaudeQueryOptions
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
  return call[0].options
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

    const { executeClaudeCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const streamed: string[] = []
    const result = await executeClaudeCode({
      prompt: 'Summarize the findings',
      binaryPath: 'claude',
      abortController: new AbortController(),
      onDelta: (delta) => {
        if (
          delta.type === 'text' &&
          delta.text !== undefined &&
          delta.text.length > 0
        ) {
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
      getContextUsage: getContextUsageMock.mockResolvedValue({ totalTokens: 0, maxTokens: 0 }),
      close: closeMock,
    })

    const { executeClaudeCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )
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

    const { executeClaudeCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

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

    const { executeClaudeCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

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

    const spawnedProcess: SpawnedClaudeCodeProcess = {
      stdin: {},
      stdout: {},
      pid: 1234,
      killed: false,
      exitCode: null,
      kill: vi.fn(() => true),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    }
    spawnMock.mockReturnValue(spawnedProcess)

    const { executeClaudeCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

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
    expect(spawned.kill()).toBe(true)
    expect(spawnSyncMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], {
      stdio: 'ignore',
    })
  })
})
