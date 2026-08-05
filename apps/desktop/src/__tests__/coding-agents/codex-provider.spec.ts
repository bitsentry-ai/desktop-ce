import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCodex, withCodexModelArgs } from '@bitsentry-ce/coding-agents/codex-provider.service'
import {
  codexStreamDeltasFromNotification,
  normalizeCodexExecutionError,
} from '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'
import { HOST_MCP_SERVER_NAME } from '@bitsentry-ce/coding-agents/host-mcp-server.service'

const tempDirs: string[] = []
async function createMultiItemCodexAppServer(): Promise<{
  binaryPath: string
  cwd: string
  logPath: string
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-test-'))
  tempDirs.push(cwd)

  const scriptPath = path.join(cwd, 'mock-codex-app-server.cjs')
  const logPath = path.join(cwd, 'messages.jsonl')
  const script = `
const fs = require('fs')
const readline = require('readline')

const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n')
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
    respond(message.id, { thread: { id: 'thread-multi-item' } })
    return
  }

  if (message.method === 'turn/start') {
    respond(message.id, { turn: { id: 'turn-multi-item' } })
    notify('item/started', { item: { id: 'item-streamed', type: 'agentMessage' } })
    notify('item/agentMessage/delta', { itemId: 'item-streamed', delta: 'I will list runbooks.' })
    notify('item/completed', {
      item: { id: 'item-streamed', type: 'agentMessage', text: 'I will list runbooks.' },
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
  return { binaryPath, cwd, logPath }
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

  it('uses a minimal incident harness and keeps runbook scope out of the user prompt', async () => {
    const infos: unknown[][] = []
    setCodingAgentsLoggerForTesting({ info: (...args) => { infos.push(args) }, warn: () => {}, error: () => {} })
    const mock = await createMultiItemCodexAppServer()
    await executeCodex({
      prompt: 'Update the local CLI.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      mcpEndpoint: {
        url: 'http://127.0.0.1:1/mcp',
        token: 'token',
        expiresAt: Date.now() + 60_000,
        command: 'node',
        args: ['host-mcp-shim.js'],
        env: {},
        agentSessionId: 'session-1',
      },
    })

    const messages = await readLoggedCodexMessages(mock.logPath)
    const threadStart = messages.find(
      (message) => message.method === 'thread/start',
    )
    const turnStart = messages.find(
      (message) => message.method === 'turn/start',
    )
    const threadParams = threadStart?.params as {
      baseInstructions?: string
      developerInstructions?: string
      config?: Record<string, unknown>
    } | undefined
    const params = turnStart?.params as { input?: Array<{ text?: string }> } | undefined
    const scope = threadParams?.baseInstructions ?? ''
    for (const hostTool of getHostTools()) {
      expect(scope).toContain(hostTool.name)
    }
    expect(scope).toContain('You must NEVER execute maintenance or remediation steps directly with built-in tools')
    expect(scope).toContain('there is no direct-execution fallback when a runbook is missing or unapproved.')
    expect(scope).not.toContain('call list_runbooks once to verify availability before concluding anything')
    expect(scope).not.toContain('Claim creation, edits, or saving only after operator approval and successful persistence.')
    expect(scope).not.toContain('Only when a request cannot be expressed as a runbook proposal or execution at all')
    expect(scope).not.toContain('Update the local CLI.')
    expect(scope.length).toBeLessThan(4_000)
    expect(threadParams?.developerInstructions).toBe('')
    expect(threadParams?.config).toMatchObject({
      include_permissions_instructions: false,
      include_apps_instructions: false,
      include_collaboration_mode_instructions: false,
      project_doc_max_bytes: 0,
      features: { apps: false, plugins: false },
      skills: { include_instructions: false },
    })
    expect(params?.input?.[0]?.text).toBe('Update the local CLI.')
    expect(infos).toContainEqual([
      '[codex-provider] configured host tools',
      { agentSessionId: 'session-1', toolNames: getHostTools().map((tool) => tool.name) },
    ])
  })

  it('approves a BitSentry MCP tool elicitation at Safe Tools', async () => {
    const infos: unknown[][] = []
    setCodingAgentsLoggerForTesting({ info: (...args) => { infos.push(args) }, warn: () => {}, error: () => {} })
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
    expect(infos).toContainEqual([
      '[codex-provider] approval decision',
      expect.objectContaining({
        method: 'mcpServer/elicitation/request',
        choice: 'allow-host-tool',
        responsePayloadKeys: ['_meta', 'action', 'content'],
        elicitation: expect.objectContaining({
          serverName: HOST_MCP_SERVER_NAME,
          approvalKind: 'mcp_tool_call',
          serverScopedHostApproval: true,
          requestedSchemaShape: {
            keys: ['properties', 'type'],
            type: 'object',
            propertyKeys: [],
          },
        }),
      }),
    ])
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
