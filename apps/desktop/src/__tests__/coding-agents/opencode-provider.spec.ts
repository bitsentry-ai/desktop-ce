import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
      cwd: '/tmp/bitsentry-incident', // eslint-disable-line sonarjs/publicly-writable-directories -- Mock subprocess fixture; the test never creates or trusts this path.
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

  it('writes a scoped MCP config for the OpenCode subprocess', async () => {
    const infos: unknown[][] = []
    setCodingAgentsLoggerForTesting({ info: (...args) => { infos.push(args) }, warn: () => {}, error: () => {} })
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const resultPromise = executeOpenCode({
      prompt: 'List runbooks',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      mcpEndpoint: {
        url: 'http://127.0.0.1:40123/mcp',
        token: 'token',
        contextId: 'context-opencode',
        command: process.execPath,
        args: ['/tmp/host-mcp-shim.cjs'], // eslint-disable-line sonarjs/publicly-writable-directories -- Mock MCP shim argument; the test never executes this path.
        env: {
          BITSENTRY_MCP_URL: 'http://127.0.0.1:40123/mcp',
          BITSENTRY_MCP_TOKEN: 'token',
          BITSENTRY_MCP_CONTEXT_ID: 'context-opencode',
        },
        agentSessionId: 'agent-session-opencode',
      },
    })

    await delay(50)
    const [, , spawnOptions] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ]
    const configPath = spawnOptions.env.OPENCODE_CONFIG
    expect(configPath).toBeDefined()
    expect(spawnOptions.env).toMatchObject({
      BITSENTRY_MCP_URL: 'http://127.0.0.1:40123/mcp',
      BITSENTRY_MCP_TOKEN: 'token',
      BITSENTRY_MCP_CONTEXT_ID: 'context-opencode',
    })
    const [, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    const scope = args.at(-1) ?? ''
    for (const hostTool of getHostTools()) {
      expect(scope).toContain(hostTool.name)
    }
    expect(scope).toContain('This direct-tool restriction does not prevent you from proposing operator-reviewed runbooks that contain shell or local-software actions.')
    expect(JSON.parse(await readFile(configPath!, 'utf8'))).toMatchObject({
      mcp: {
        bitsentry: {
          type: 'local',
          command: [process.execPath, '/tmp/host-mcp-shim.cjs'], // eslint-disable-line sonarjs/publicly-writable-directories -- Asserted mock config, not an executed filesystem path.
        },
      },
    })
    expect(await readFile(configPath!, 'utf8')).not.toContain('BITSENTRY_MCP_TOKEN')
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as {
      permission: Record<string, string>
    }
    for (const hostTool of getHostTools()) {
      expect(config.permission[`bitsentry_${hostTool.name}`]).toBe('allow')
    }
    expect(infos).toContainEqual([
      '[opencode-provider] configured host tool permissions',
      {
        agentSessionId: 'agent-session-opencode',
        accessLevel: 'auto-accept-edits',
        toolNames: getHostTools().map((tool) => tool.name),
      },
    ])

    finishOpenCodeProcess(child)
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })
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

  it('recovers from delayed, fragmented, and malformed process output before a valid event arrives', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const textDeltas: string[] = []
    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )
    const resultPromise = executeOpenCode({
      prompt: 'Recover from process protocol noise',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      onDelta: (delta) => {
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    await delay(10)
    child.stdout.write('not-json-provider-frame\n')
    child.stdout.write('{"type":"message.part.updated","properties":{"part":')
    child.stdout.write('{"id":"part-1","type":"text","text":"recovered"}}}\n')
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)

    await expect(resultPromise).resolves.toMatchObject({
      output: 'not-json-provider-frame\nrecovered',
      exitCode: 0,
    })
    expect(textDeltas.join('')).toBe('not-json-provider-frame\nrecovered')
  })

  it('cancels a hung OpenCode process and keeps its later output out of the turn', async () => {
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const abortController = new AbortController()
    const statuses: string[] = []
    const textDeltas: string[] = []
    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )
    const resultPromise = executeOpenCode({
      prompt: 'Cancel a hung request',
      binaryPath: 'opencode',
      abortController,
      onDelta: (delta) => {
        if (delta.type === 'status' && delta.status !== undefined) statuses.push(delta.status)
        if (delta.type === 'text' && delta.text !== undefined) textDeltas.push(delta.text)
      },
    })

    await delay(10)
    abortController.abort()
    child.stdout.write(`${JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { id: 'late-part', type: 'text', text: 'late output' } },
    })}\n`)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', null)

    await expect(resultPromise).resolves.toMatchObject({ output: '', exitCode: -1 })
    expect(statuses).toEqual(['started', 'cancelled'])
    expect(textDeltas).toEqual([])
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping OpenCode turns correlated when the second process completes first', async () => {
    const firstChild = new MockChildProcess()
    const secondChild = new MockChildProcess()
    mocks.spawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const { executeOpenCode } = await import(
      '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
    )

    const first = executeOpenCode({
      prompt: 'first turn', binaryPath: 'opencode', abortController: new AbortController(),
    })
    const second = executeOpenCode({
      prompt: 'second turn', binaryPath: 'opencode', abortController: new AbortController(),
    })

    finishOpenCodeProcess(secondChild, [{
      type: 'message.part.updated',
      properties: { part: { id: 'second', type: 'text', text: 'second output' } },
    }])
    await expect(second).resolves.toMatchObject({ output: 'second output' })
    finishOpenCodeProcess(firstChild, [{
      type: 'message.part.updated',
      properties: { part: { id: 'first', type: 'text', text: 'first output' } },
    }])
    await expect(first).resolves.toMatchObject({ output: 'first output' })
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
            ref: 'err_model_missing',
          },
        },
      })}\n`)
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 1)
      child.emit('close', 1)
    })

    await expect(resultPromise).rejects.toThrow(
      'OpenCode exited with code 1: model opencode/missing-model is not available (ref: err_model_missing)\nOpenCode logs:',
    )
  })
})
