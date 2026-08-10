import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCodex, withCodexModelArgs } from '@bitsentry-ce/coding-agents/codex-provider.service'
import {
  codexStreamDeltasFromNotification,
  normalizeCodexExecutionError,
} from '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'
import { HOST_MCP_SERVER_NAME } from '@bitsentry-ce/coding-agents/host-mcp-server.service'

const tempDirs: string[] = []
async function createMultiItemCodexAppServer(options: { readsGlobalCodexInstructions?: boolean } = {}): Promise<{
  binaryPath: string
  cwd: string
  logPath: string
  argsPath: string
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-test-'))
  tempDirs.push(cwd)

  const scriptPath = path.join(cwd, 'mock-codex-app-server.cjs')
  const logPath = path.join(cwd, 'messages.jsonl')
  const argsPath = path.join(cwd, 'args.json')
  const script = `
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n')
const logMessage = (message) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(message) + '\\n')
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
const responseText = ${options.readsGlobalCodexInstructions === true}
  ? (fs.existsSync(path.join(process.env.HOME || '', '.codex', 'config.toml'))
      ? 'Global instruction loaded.'
      : 'Incident instruction boundary preserved.')
  : 'I will list runbooks.'
if (!process.argv.slice(2).includes('app-server')) process.exit(64)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  logMessage(message)

  if (message.method === 'initialize') {
    respond(message.id, { userAgent: 'mock-codex-app-server' })
    return
  }

  if (message.method === 'thread/start') {
    respond(message.id, { thread: { id: 'thread-multi-item' } })
    return
  }

  if (message.method === 'turn/start') {
    respond(message.id, { turn: { id: 'turn-multi-item' } })
    notify('item/started', { item: { id: 'item-streamed', type: 'agentMessage' } })
    notify('item/agentMessage/delta', { itemId: 'item-streamed', delta: responseText })
    notify('item/completed', {
      item: { id: 'item-streamed', type: 'agentMessage', text: responseText },
    })
    notify('item/started', { item: { id: 'item-tool-call', type: 'mcpToolCall' } })
    notify('item/completed', {
      item: { id: 'item-tool-call', type: 'mcpToolCall' },
    })
    notify('turn/completed', { turn: { id: 'turn-multi-item' } })
  }
})
`
  await writeFile(scriptPath, script)

  const binaryPath = path.join(cwd, 'codex')
  await writeFile(binaryPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd, logPath, argsPath }
}

async function readLoggedCodexMessages(logPath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function createHostApprovalCodexAppServer(): Promise<{
  binaryPath: string
  cwd: string
  logPath: string
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-approval-'))
  tempDirs.push(cwd)
  const scriptPath = path.join(cwd, 'mock-codex-app-server-approval.cjs')
  const logPath = path.join(cwd, 'messages.jsonl')
  const script = `
const fs = require('fs')
const readline = require('readline')

const approvalId = 'mcp-approval-1'
const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n')
const requestApproval = () => process.stdout.write(JSON.stringify({
  id: approvalId,
  method: 'mcpServer/elicitation/request',
  params: {
    threadId: 'thread-approval',
    turnId: 'turn-approval',
    serverName: ${JSON.stringify(HOST_MCP_SERVER_NAME)},
    mode: 'form',
    message: 'Allow MCP call?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: 'session',
      tool_description: 'Creates a governed runbook proposal.',
      tool_params: {},
      tool_params_display: [],
    },
  },
}) + '\\n')
const logMessage = (message) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(message) + '\\n')

if (!process.argv.slice(2).includes('app-server')) process.exit(64)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  logMessage(message)

  if (message.method === 'initialize') {
    respond(message.id, { userAgent: 'mock-codex-app-server' })
    return
  }
  if (message.method === 'thread/start') {
    respond(message.id, { thread: { id: 'thread-approval' } })
    return
  }
  if (message.method === 'turn/start') {
    respond(message.id, { turn: { id: 'turn-approval' } })
    requestApproval()
    return
  }
  if (message.id === approvalId) {
    notify('turn/completed', { turn: { id: 'turn-approval' } })
  }
})
`
  await writeFile(scriptPath, script)
  const binaryPath = path.join(cwd, 'codex')
  await writeFile(binaryPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd, logPath }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  setCodingAgentsLoggerForTesting({ info: () => {}, warn: () => {}, error: () => {} })
})

describe('Codex provider behavior', () => {
  it('sends the Safe Tools policy that gates workspace shell execution', async () => {
    const mock = await createMultiItemCodexAppServer()
    await executeCodex({
      prompt: 'Print the current working directory.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    const turnStart = (await readLoggedCodexMessages(mock.logPath)).find(
      (message) => message.method === 'turn/start',
    )
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'workspaceWrite' },
    })
  })

  it('disables native shell execution for Safe Tools without proposing a runbook', async () => {
    const mock = await createMultiItemCodexAppServer()
    const result = await executeCodex({
      prompt: 'Print the current working directory.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    const args = JSON.parse(await readFile(mock.argsPath, 'utf8')) as string[]
    const messages = await readLoggedCodexMessages(mock.logPath)
    const executionItems = messages.filter((message) =>
      message.method === 'item/started' || message.method === 'item/completed',
    )

    expect(args).toEqual(expect.arrayContaining(['-c', 'features.shell_tool=false', 'app-server']))
    expect(executionItems.some((message) => {
      const params = message.params as { item?: { type?: unknown } } | undefined
      return params?.item?.type === 'commandExecution'
    })).toBe(false)
    expect(result.output).not.toMatch(/runbook proposal/i)
  })

  it('keeps completed assistant messages separate from MCP tool activity', async () => {
    const mock = await createMultiItemCodexAppServer()
    const result = await executeCodex({
      prompt: 'List available runbooks.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    expect(result.output).toContain('I will list runbooks.')
    expect(result.output).not.toContain('mcpToolCall')
  })

  it('does not start Codex when cancellation arrives while the isolated HOME is being created', async () => {
    const mock = await createMultiItemCodexAppServer()
    const abortController = new AbortController()
    const execution = executeCodex({
      prompt: 'List available runbooks.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController,
      mcpEndpoint: {
        url: 'http://127.0.0.1:1/mcp',
        token: 'token',
        contextId: 'context-cancelled',
        command: 'node',
        args: ['host-mcp-shim.js'],
        env: {},
        agentSessionId: 'session-cancelled',
      },
    })
    abortController.abort()

    await expect(execution).resolves.toMatchObject({ output: '', exitCode: -1 })
    expect(await readLoggedCodexMessages(mock.logPath)).toEqual([])
  })

  it('keeps global Codex instructions out of incident sessions', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'codex-user-home-'))
    tempDirs.push(userHome)
    await mkdir(path.join(userHome, '.codex'))
    await writeFile(path.join(userHome, '.codex', 'config.toml'), 'developer_instructions = "global"\n')
    const mock = await createMultiItemCodexAppServer({ readsGlobalCodexInstructions: true })
    const originalHome = process.env.HOME
    process.env.HOME = userHome

    try {
      const result = await executeCodex({
        prompt: 'List available runbooks.',
        binaryPath: mock.binaryPath,
        cwd: mock.cwd,
        abortController: new AbortController(),
        mcpEndpoint: {
        url: 'http://127.0.0.1:1/mcp',
        token: 'token',
        contextId: 'context-isolated-home',
          command: 'node',
          args: ['host-mcp-shim.js'],
          env: {},
          agentSessionId: 'session-isolated-home',
        },
      })

      expect(result.output).toBe('Incident instruction boundary preserved.')
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
    }
  })

  it('approves a BitSentry MCP tool elicitation at Safe Tools', async () => {
    const mock = await createHostApprovalCodexAppServer()

    await expect(executeCodex({
      prompt: 'List incident runbooks.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })).resolves.toMatchObject({ threadId: 'thread-approval' })

    const approvalResponse = (await readLoggedCodexMessages(mock.logPath)).find(
      (message) => message.id === 'mcp-approval-1',
    )
    expect(approvalResponse).toEqual({
      id: 'mcp-approval-1',
      result: {
        action: 'accept',
        content: {},
        _meta: null,
      },
    })
  })

  it('keeps Codex assistant, reasoning, and command streams separate', () => {
    expect(
      codexStreamDeltasFromNotification('item/agentMessage/delta', { delta: 'visible answer' }),
    ).toEqual([{ type: 'text', text: 'visible answer' }])

    expect(
      codexStreamDeltasFromNotification('item/reasoning/textDelta', { delta: 'private reasoning' }),
    ).toEqual([{ type: 'reasoning', text: 'private reasoning' }])

    expect(
      codexStreamDeltasFromNotification('item/reasoning/summaryTextDelta', {
        delta: 'summary reasoning',
      }),
    ).toEqual([{ type: 'reasoning', text: 'summary reasoning' }])

    expect(
      codexStreamDeltasFromNotification('item/commandExecution/outputDelta', {
        delta: 'shell output',
      }),
    ).toEqual([{ type: 'command_output', text: 'shell output' }])
  })

  it('ignores empty or unsupported Codex stream notifications', () => {
    expect(
      codexStreamDeltasFromNotification('item/reasoning/textDelta', { delta: '' }),
    ).toEqual([])

    expect(
      codexStreamDeltasFromNotification('item/mcpToolCall/progress', { delta: 'working' }),
    ).toEqual([])
  })
})

async function createFailedTurnCodexAppServer(): Promise<{
  binaryPath: string
  cwd: string
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-failed-turn-'))
  tempDirs.push(cwd)

  const scriptPath = path.join(cwd, 'mock-codex-app-server-failed.cjs')
  const script = `
const readline = require('readline')

const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n')

if (!process.argv.slice(2).includes('app-server')) process.exit(64)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    respond(message.id, { userAgent: 'mock-codex-app-server' })
    return
  }

  if (message.method === 'thread/start') {
    respond(message.id, { thread: { id: 'thread-failed-turn' } })
    return
  }

  if (message.method === 'turn/start') {
    respond(message.id, { turn: { id: 'turn-failed' } })
    notify('turn/completed', {
      turn: {
        id: 'turn-failed',
        status: 'failed',
        error: { message: "The 'gpt-5.6-terra' model requires a newer version of Codex." },
      },
    })
  }
})
`
  await writeFile(scriptPath, script)

  const binaryPath = path.join(cwd, 'codex')
  await writeFile(binaryPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd }
}

describe('Codex model argument handling', () => {
  it('passes the model as a -c config override because app-server ignores --model', () => {
    expect(withCodexModelArgs([], 'gpt-5.4-mini')).toEqual(['-c', 'model="gpt-5.4-mini"'])
  })

  it('keeps user-supplied model overrides untouched', () => {
    expect(withCodexModelArgs(['--model', 'x'], 'gpt-5.4-mini')).toEqual(['--model', 'x'])
    expect(withCodexModelArgs(['-c', 'model="x"'], 'gpt-5.4-mini')).toEqual(['-c', 'model="x"'])
  })

  it('disables reasoning summaries for Codex Spark only', () => {
    expect(withCodexModelArgs([], 'gpt-5.3-codex-spark')).toEqual([
      '-c',
      'model="gpt-5.3-codex-spark"',
      '-c',
      'model_reasoning_summary="none"',
    ])
    expect(withCodexModelArgs([], 'gpt-5.6-terra')).toEqual([
      '-c',
      'model="gpt-5.6-terra"',
    ])
  })

  it('keeps a user-supplied Spark reasoning summary override', () => {
    expect(
      withCodexModelArgs(
        ['-c', 'model_reasoning_summary="concise"'],
        'gpt-5.3-codex-spark',
      ),
    ).toEqual([
      '-c',
      'model_reasoning_summary="concise"',
      '-c',
      'model="gpt-5.3-codex-spark"',
    ])
  })

  it('passes no override when the action has no model', () => {
    expect(withCodexModelArgs([], undefined)).toEqual([])
    expect(withCodexModelArgs([], '')).toEqual([])
  })
})

describe('Codex failed turn handling', () => {
  it('rejects when the turn completes in a failed state instead of returning empty output', async () => {
    const mock = await createFailedTurnCodexAppServer()

    await expect(
      executeCodex({
        prompt: 'Say hi.',
        binaryPath: mock.binaryPath,
        cwd: mock.cwd,
        abortController: new AbortController(),
        accessLevel: 'auto-accept-edits',
      }),
    ).rejects.toThrow(/gpt-5\.6-terra.*newer version of Codex/)
  })
})

describe('normalizeCodexExecutionError', () => {
  it('labels a model rejected for the current ChatGPT account as unavailable', () => {
    const error = normalizeCodexExecutionError(new Error(
      "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
    ))

    expect(error.message).toContain('Codex model unavailable:')
    expect(error.message).toContain('gpt-5.2-codex')
  })

  it('labels account authentication failures as unauthorized', () => {
    const error = normalizeCodexExecutionError(new Error(
      'Codex account is not authenticated or is not authorized for this model.',
    ))

    expect(error.message).toContain('Codex account access unauthorized:')
  })

  it('adds a service_tier hint for Codex config load errors', () => {
    const error = new Error(
      'failed to load configuration: /Users/wirapratama/.codex/config.toml:5:16: unknown variant `default`, expected `fast` or `flex`',
    )

    const normalized = normalizeCodexExecutionError(error)

    expect(normalized.message).toContain('Codex configuration error:')
    expect(normalized.message).toContain('config.toml')
    expect(normalized.message).toContain('Set `service_tier` in your Codex config to `flex` or `fast`.')
  })

  it('preserves non-config errors', () => {
    const error = new Error('Codex app-server closed: exited')

    expect(normalizeCodexExecutionError(error)).toBe(error)
  })
})
