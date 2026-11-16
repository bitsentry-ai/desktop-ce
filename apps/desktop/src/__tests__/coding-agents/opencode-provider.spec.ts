import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentLlmAdapterService,
  type AgentLlmSettingsStore,
} from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  log: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

vi.mock('electron-log', () => ({
  default: mocks.log,
}))

// Fake PIDs far above any real one; process.kill is mocked below as well.
let nextFakePid = 900_000

function takeFakePid(): number {
  nextFakePid += 1
  return nextFakePid
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = takeFakePid()
  kill = vi.fn(() => { queueMicrotask(() => { this.emit('exit', null) }) })
}

/** OpenCode 2 spawns one `serve` per server and one `run --server` client per turn. */
function mockOpenCode2Processes(): { servers: MockChildProcess[]; clients: MockChildProcess[] } {
  const servers: MockChildProcess[] = []
  const clients: MockChildProcess[] = []
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new MockChildProcess()
    if (args.includes('serve')) {
      servers.push(child)
      const port = 4095 + servers.length
      setImmediate(() => { child.stdout.write(`server listening on http://127.0.0.1:${String(port)}\n`) })
    } else {
      clients.push(child)
    }
    return child
  })
  return { servers, clients }
}

function spawnOptions(child: MockChildProcess): { args: string[]; env: Record<string, string | undefined> } {
  const index = mocks.spawn.mock.results.findIndex((result) => result.value === child)
  return spawnCall(index)
}

async function waitForClients(clients: MockChildProcess[], count: number): Promise<void> {
  await vi.waitFor(() => { expect(clients).toHaveLength(count) })
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

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

function mockOpenCodeVersion(output: string): void {
  mocks.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    queueMicrotask(() => { callback(null, output, '') })
    return { exitCode: 0 }
  })
}

async function waitForSpawn(count = 1): Promise<void> {
  await vi.waitFor(() => { expect(mocks.spawn).toHaveBeenCalledTimes(count) })
}

function spawnCall(index = 0): { args: string[]; env: Record<string, string | undefined> } {
  const [, args, options] = mocks.spawn.mock.calls[index] as [string, string[], { env: Record<string, string | undefined> }]
  return { args, env: options.env }
}

const MCP_ENDPOINT = {
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
}

const LEGACY_OPENCODE_MODEL_MIGRATIONS = [
  { legacyId: 'openai/gpt-5.5-fast', baseId: 'openai/gpt-5.5' },
  { legacyId: 'openai/gpt-5.4-fast', baseId: 'openai/gpt-5.4' },
  { legacyId: 'openai/gpt-5.4-mini-fast', baseId: 'openai/gpt-5.4-mini' },
  { legacyId: 'anthropic/claude-opus-4-8-fast', baseId: 'anthropic/claude-opus-4-8' },
] as const

const LEGACY_OPENCODE_EXECUTION_CASES = [
  ...LEGACY_OPENCODE_MODEL_MIGRATIONS.map((migration) => ({ ...migration, branch: 'saved' as const })),
  ...LEGACY_OPENCODE_MODEL_MIGRATIONS.map((migration) => ({ ...migration, branch: 'override' as const })),
]

describe('executeOpenCode', () => {
  beforeEach(() => {
    mockOpenCodeVersion('1.14.20')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
  })

  afterEach(async () => {
    const { closePooledProcesses } = await import('@bitsentry-ce/coding-agents/process-pool')
    await closePooledProcesses()
    vi.mocked(process.kill).mockRestore()
    mocks.execFile.mockReset()
    mocks.spawn.mockReset()
    mocks.spawnSync.mockReset()
    mocks.log.warn.mockReset()
    mocks.log.error.mockReset()
    mocks.log.info.mockReset()
    vi.resetModules()
  })

  it.each(LEGACY_OPENCODE_EXECUTION_CASES)(
    'migrates the $branch legacy model before passing the final --model argument ($legacyId)',
    async ({ legacyId, baseId, branch }) => {
      const child = new MockChildProcess()
      mocks.spawn.mockReturnValue(child)
      const { executeOpenCode } = await import(
        '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
      )
      const settingsStore: AgentLlmSettingsStore = {
        setting: {
          findUnique: vi.fn().mockResolvedValue(
            branch === 'saved' ? { value: legacyId } : null,
          ),
        },
      }
      const adapter = new AgentLlmAdapterService(settingsStore)
      adapter.setLocalAiProvider({
        isReady: (provider) => provider === 'opencode',
        listModels: () => Promise.resolve([]),
        execute: (_provider, prompt, abortController, onDelta, cwd, model, accessLevel, traitValues) =>
          executeOpenCode({
            prompt,
            binaryPath: 'opencode',
            abortController,
            onDelta,
            cwd,
            model,
            accessLevel,
            traitValues,
          }),
      })

      const resultPromise = adapter.chatWithTools({
        messages: [{ role: 'user', content: 'Migrate this model.' }],
        signal: new AbortController().signal,
        llm: {
          providerKey: 'opencode',
          ...(branch === 'override' ? { model: legacyId } : {}),
        },
      })

      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
      const [, args] = mocks.spawn.mock.calls[0] as [string, string[]]
      const modelFlagIndex = args.indexOf('--model')
      expect(args.slice(modelFlagIndex, modelFlagIndex + 2)).toEqual(['--model', baseId])

      finishOpenCodeProcess(child)
      await expect(resultPromise).resolves.toMatchObject({ content: '' })
    },
  )

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
      mcpEndpoint: MCP_ENDPOINT,
    })

    await waitForSpawn()
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

    await waitForSpawn()
    finishOpenCodeProcess(child, [
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
    ])

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

    await waitForSpawn()
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

    await waitForSpawn()
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
    await waitForSpawn(2)

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

    await waitForSpawn()
    finishOpenCodeProcess(child, [
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
    ])

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

    await waitForSpawn()
    finishOpenCodeProcess(child, [
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
    ])

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

    await waitForSpawn()
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

    await expect(resultPromise).resolves.toMatchObject({
      output: 'Hello after exit',
      exitCode: 0,
    })
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

    await waitForSpawn()
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

    await expect(resultPromise).rejects.toThrow(
      'OpenCode exited with code 1: model opencode/missing-model is not available (ref: err_model_missing)\nOpenCode logs:',
    )
  })

  it.each([
    { version: '1.14.20', accessLevel: 'auto-accept-edits', flags: ['run', '--format', 'json', '--dir', '/repo', '--model', 'openai/gpt-5', '--variant', 'high'] },
    { version: '1.14.20', accessLevel: 'full-access', flags: ['run', '--format', 'json', '--dir', '/repo', '--model', 'openai/gpt-5', '--variant', 'high', '--dangerously-skip-permissions'] },
  ] as const)('builds $accessLevel run flags for OpenCode $version', async ({ version, accessLevel, flags }) => {
    mockOpenCodeVersion(version)
    const child = new MockChildProcess()
    mocks.spawn.mockReturnValue(child)
    const { executeOpenCode } = await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    const resultPromise = executeOpenCode({
      prompt: 'Investigate',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      cwd: '/repo',
      model: 'openai/gpt-5',
      accessLevel,
      traitValues: { effort: 'high' },
    })
    await waitForSpawn()
    finishOpenCodeProcess(child)

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })
    expect(spawnCall().args.slice(0, -1)).toEqual(flags)
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: '/repo' })
  })

  it('does not start OpenCode when the turn is cancelled during the version check', async () => {
    let finishVersion: () => void = () => {}
    mocks.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      finishVersion = () => { callback(null, 'opencode v2.3.0', '') }
      return { exitCode: 0 }
    })
    const abortController = new AbortController()
    const { executeOpenCode } = await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    const resultPromise = executeOpenCode({ prompt: 'Cancel early', binaryPath: 'opencode', abortController })
    await vi.waitFor(() => { expect(mocks.execFile).toHaveBeenCalledTimes(1) })
    abortController.abort()
    finishVersion()

    await expect(resultPromise).resolves.toEqual({ output: '', exitCode: -1 })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reruns OpenCode 2 on the model default when the model lacks the chosen effort', async () => {
    mockOpenCodeVersion('opencode v2.3.0')
    const { servers, clients } = mockOpenCode2Processes()
    const { executeOpenCode } = await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    const resultPromise = executeOpenCode({
      prompt: 'Reply OK',
      binaryPath: 'opencode',
      abortController: new AbortController(),
      model: 'kimi-code-plan-global/k3',
      traitValues: { effort: 'medium' },
    })
    await waitForClients(clients, 1)
    const [rejected] = clients
    rejected.stdout.write(`${JSON.stringify({
      type: 'error',
      sessionID: 'ses_1',
      error: { type: 'provider.no-route', message: 'Variant unavailable for kimi-code-plan-global/k3: medium' },
    })}\n`)
    rejected.stdout.end()
    rejected.stderr.end()
    rejected.emit('exit', 1)
    rejected.emit('close', 1)
    await waitForClients(clients, 2)
    finishOpenCodeProcess(clients[1], [{ type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', text: 'OK' } } }])

    await expect(resultPromise).resolves.toMatchObject({ output: 'OK', exitCode: 0 })
    expect(servers).toHaveLength(1)
    expect(spawnOptions(rejected).args).toContain('kimi-code-plan-global/k3#medium')
    expect(spawnOptions(clients[1]).args).toContain('kimi-code-plan-global/k3')
    expect(spawnOptions(clients[1]).args.some((arg) => arg.includes('#'))).toBe(false)
  })

  it('fails the turn when OpenCode 2 exits cleanly after an error event', async () => {
    mockOpenCodeVersion('opencode v2.3.0')
    const { clients } = mockOpenCode2Processes()
    const { executeOpenCode } = await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')

    const resultPromise = executeOpenCode({ prompt: 'Use a missing model', binaryPath: 'opencode', abortController: new AbortController() })
    await waitForClients(clients, 1)
    finishOpenCodeProcess(clients[0], [{
      type: 'error',
      sessionID: 'ses_1',
      error: { type: 'provider.no-route', message: 'Model unavailable: nonexistent/fake-model' },
    }])

    await expect(resultPromise).rejects.toThrow('OpenCode reported an error: Model unavailable: nonexistent/fake-model')
  })
})

describe('OpenCode 2 server reuse', () => {
  const bound: string[] = []
  let turnCount = 0
  const incidentEndpoint = (agentSessionId: string) => {
    turnCount += 1
    const token = `turn-token-${String(turnCount)}`
    return {
      ...MCP_ENDPOINT,
      token,
      env: { ...MCP_ENDPOINT.env, BITSENTRY_MCP_TOKEN: token },
      agentSessionId,
      bindIdentity: (identity: { token: string }) => {
        bound.push(identity.token)
        return () => {}
      },
    }
  }

  beforeEach(() => {
    bound.length = 0
    mockOpenCodeVersion('opencode v2.3.0')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
  })

  afterEach(async () => {
    const { closePooledProcesses } = await import('@bitsentry-ce/coding-agents/process-pool')
    await closePooledProcesses()
    vi.mocked(process.kill).mockRestore()
    mocks.execFile.mockReset()
    mocks.spawn.mockReset()
    vi.resetModules()
  })

  async function startTurn(options: {
    clients: MockChildProcess[]
    agentSessionId?: string
    accessLevel?: 'auto-accept-edits' | 'full-access'
    abortController?: AbortController
  }) {
    const { executeOpenCode } = await import('@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents')
    const clientCount = options.clients.length
    const result = executeOpenCode({
      prompt: 'Investigate',
      binaryPath: 'opencode',
      abortController: options.abortController ?? new AbortController(),
      cwd: '/repo',
      model: 'openai/gpt-5',
      traitValues: { effort: 'high' },
      accessLevel: options.accessLevel ?? 'auto-accept-edits',
      mcpEndpoint: incidentEndpoint(options.agentSessionId ?? 'incident-1'),
    })
    await waitForClients(options.clients, clientCount + 1)
    return { result, client: options.clients[clientCount] }
  }

  const answer = (text: string) => [{ type: 'text', sessionID: `ses-${text}`, part: { id: `part-${text}`, type: 'text', text } }]

  it('serves five turns of one incident from one server, each turn binding its tools to that server', async () => {
    const { servers, clients } = mockOpenCode2Processes()
    const outputs: string[] = []
    for (let turn = 1; turn <= 5; turn += 1) {
      const { result, client } = await startTurn({ clients })
      finishOpenCodeProcess(client, answer(`answer ${String(turn)}`))
      outputs.push((await result).output)
    }

    expect(servers).toHaveLength(1)
    expect(outputs).toEqual(['answer 1', 'answer 2', 'answer 3', 'answer 4', 'answer 5'])
    const server = spawnOptions(servers[0])
    expect(server.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0'])
    expect(new Set(bound)).toEqual(new Set([server.env.BITSENTRY_MCP_TOKEN]))
    expect(bound).toHaveLength(5)
    const client = spawnOptions(clients[4])
    expect(client.args.slice(0, -1)).toEqual(['run', '--server', 'http://127.0.0.1:4096', '--format', 'json', '--model', 'openai/gpt-5#high'])
    expect(client.env.OPENCODE_PASSWORD).toBe(server.env.OPENCODE_SERVER_PASSWORD)
    expect(client.env.BITSENTRY_MCP_TOKEN).toBeUndefined()
  })

  it('keeps access limits per server and never shares a server between incidents', async () => {
    const { servers, clients } = mockOpenCode2Processes()
    const runTurn = async (agentSessionId: string, accessLevel: 'auto-accept-edits' | 'full-access') => {
      const { result, client } = await startTurn({ clients, agentSessionId, accessLevel })
      finishOpenCodeProcess(client, answer(agentSessionId))
      await result
      return client
    }
    await runTurn('incident-1', 'auto-accept-edits')
    const reusedClient = await runTurn('incident-1', 'auto-accept-edits')
    const fullAccessClient = await runTurn('incident-1', 'full-access')
    await runTurn('incident-2', 'auto-accept-edits')

    expect(servers).toHaveLength(3)
    const permissionOf = (server: MockChildProcess) =>
      (JSON.parse(spawnOptions(server).env.OPENCODE_CONFIG_CONTENT ?? '{}') as { permission: Record<string, string> }).permission
    const restricted = permissionOf(servers[0])
    expect(restricted).toMatchObject({
      bash: 'deny', task: 'deny', webfetch: 'deny', external_directory: 'deny', execute: 'deny', browser: 'deny', edit: 'allow',
    })
    for (const hostTool of getHostTools()) {
      expect(restricted[`bitsentry_${hostTool.name}`]).toBe('allow')
    }
    expect(JSON.parse(spawnOptions(servers[0]).env.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      mcp: { bitsentry: { type: 'local', command: [process.execPath, MCP_ENDPOINT.args[0]] } },
    })
    expect(spawnOptions(reusedClient).args).not.toContain('--auto')
    expect(Object.values(permissionOf(servers[1]))).toEqual(getHostTools().map(() => 'allow'))
    expect(spawnOptions(fullAccessClient).args).toContain('--auto')
    expect(permissionOf(servers[2])).toEqual(restricted)
    expect(spawnOptions(servers[2]).env.BITSENTRY_MCP_TOKEN).not.toBe(spawnOptions(servers[0]).env.BITSENTRY_MCP_TOKEN)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('replaces a crashed server on the next turn', async () => {
    const { servers, clients } = mockOpenCode2Processes()
    const first = await startTurn({ clients })
    finishOpenCodeProcess(first.client, answer('first'))
    await first.result
    servers[0].emit('exit', 1)

    const second = await startTurn({ clients })
    finishOpenCodeProcess(second.client, answer('second'))

    await expect(second.result).resolves.toMatchObject({ output: 'second', exitCode: 0 })
    expect(servers).toHaveLength(2)
  })

  it('cancels one turn without touching a concurrent turn of the same incident', async () => {
    const { servers, clients } = mockOpenCode2Processes()
    const abortController = new AbortController()
    const cancelled = await startTurn({ clients, abortController })
    const running = await startTurn({ clients })
    expect(servers).toHaveLength(2)

    abortController.abort()
    cancelled.client.emit('close', null)
    await expect(cancelled.result).resolves.toMatchObject({ exitCode: -1 })
    finishOpenCodeProcess(running.client, answer('still running'))

    await expect(running.result).resolves.toMatchObject({ output: 'still running', exitCode: 0 })
    expect(servers[0].kill).toHaveBeenCalled()
    expect(cancelled.client.kill).toHaveBeenCalled()
    expect(servers[1].kill).not.toHaveBeenCalled()
    expect(running.client.kill).not.toHaveBeenCalled()
    const next = await startTurn({ clients })
    finishOpenCodeProcess(next.client, answer('next'))
    await next.result
    expect(servers).toHaveLength(2)
  })
})
