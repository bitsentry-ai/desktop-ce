import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chooseCursorPermissionResponse,
  cursorDeltasFromSessionUpdate,
  executeCursor,
  extractCursorModelIds,
} from '@bitsentry-ce/coding-agents/cursor-provider.service'

const tmpDirs: string[] = []

interface LoggedCursorMessage {
  method?: string
  params?: unknown
}

const DEFAULT_CURSOR_CONFIG_OPTIONS = [
  {
    id: 'model',
    type: 'select',
    category: 'model',
    name: 'Model',
    options: [{ value: 'composer-2.5', name: 'Composer 2.5' }],
  },
  {
    id: 'reasoning',
    type: 'select',
    category: 'reasoning',
    name: 'Reasoning',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

function parseJsonLine(line: string): unknown {
  return JSON.parse(line) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseLoggedCursorMessage(line: string): LoggedCursorMessage {
  const parsed = parseJsonLine(line)
  if (!isRecord(parsed)) {
    throw new Error(`Expected logged cursor message object: ${line}`)
  }

  return parsed
}

function getMessageParams(message: LoggedCursorMessage): Record<string, unknown> | undefined {
  if (isRecord(message.params)) {
    return message.params
  }

  return undefined
}

async function readLoggedMessages(logPath: string): Promise<LoggedCursorMessage[]> {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLoggedCursorMessage(line))
}

async function createMockCursorAgent(
  configOptions: unknown[] = DEFAULT_CURSOR_CONFIG_OPTIONS,
): Promise<{ binaryPath: string; logPath: string; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cursor-provider-'))
  tmpDirs.push(cwd)

  const logPath = path.join(cwd, 'messages.jsonl')
  const configOptionsJson = JSON.stringify(configOptions)
  const script = `
const fs = require('fs')
const readline = require('readline')

const logPath = ${JSON.stringify(logPath)}
const logMessage = (message) => {
  fs.appendFileSync(logPath, JSON.stringify(message) + '\\n')
}

if (!process.argv.slice(2).includes('acp')) {
  process.exit(64)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  logMessage(message)

  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    }) + '\\n')
    return
  }

  if (message.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'session-1',
        configOptions: ${configOptionsJson},
      },
    }) + '\\n')
    return
  }

  if (message.method === 'session/set_config_option') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    return
  }

  if (message.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
      },
    }) + '\\n')
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { stopReason: 'end_turn' },
    }) + '\\n')
  }
})
`

  if (process.platform === 'win32') {
    const scriptPath = path.join(cwd, 'mock-cursor-agent.cjs')
    await writeFile(scriptPath, script)
    const binaryPath = path.join(cwd, 'cursor-agent.cmd')
    await writeFile(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`)
    return { binaryPath, logPath, cwd }
  }

  const binaryPath = path.join(cwd, 'cursor-agent')
  await writeFile(binaryPath, `#!/usr/bin/env node\n${script}`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, logPath, cwd }
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const permissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
]

describe('Cursor provider behavior', () => {
  it('chooses ACP permission options from access level and tool kind', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'read-1', kind: 'read', title: 'Read file' },
          options: permissionOptions,
        },
        'supervised',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'supervised',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'auto-accept-edits',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: permissionOptions,
        },
        'auto-accept-edits',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: permissionOptions,
        },
        'full-access',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('keeps automatic full-access approvals scoped to a single Cursor request', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: [
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          ],
        },
        'full-access',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('cancels pending permission requests during abort', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'full-access',
        true,
      ),
    ).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('translates session/update notifications into local stream deltas', () => {
    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      }),
    ).toEqual([{ type: 'text', text: 'hello' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      }),
    ).toEqual([{ type: 'reasoning', text: 'thinking' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          kind: 'execute',
          title: 'Run tests',
          status: 'in_progress',
        },
      }),
    ).toEqual([{ type: 'tool_start', toolName: 'Run tests', status: 'started' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Run tests',
          status: 'completed',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ).toEqual([
      { type: 'command_output', toolName: 'Run tests', text: 'done' },
      { type: 'tool_end', toolName: 'Run tests', status: 'completed' },
    ])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Read file',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'nested output' },
            },
          ],
        },
      }),
    ).toEqual([
      { type: 'command_output', toolName: 'Read file', text: 'nested output' },
    ])
  })

  it('extracts Cursor models from ACP session state and config options', () => {
    expect(
      extractCursorModelIds({
        sessionId: 'session-1',
        models: {
          currentModelId: 'claude-opus-4-6',
          availableModels: [
            { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { modelId: 'gpt-5', name: 'GPT-5' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            type: 'select',
            category: 'model',
            currentValue: 'claude-opus-4-6',
            name: 'Model',
            options: [
              { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
              {
                name: 'OpenAI',
                options: [{ value: 'gpt-5.4', name: 'GPT-5.4' }],
              },
            ],
          },
        ],
      }),
    ).toEqual(['claude-opus-4-6', 'gpt-5', 'claude-sonnet-4-6', 'gpt-5.4'])
  })

  it('sets Cursor effort through advertised ACP config options', async () => {
    const mock = await createMockCursorAgent()

    await expect(
      executeCursor({
        prompt: 'Summarize the incident',
        binaryPath: mock.binaryPath,
        abortController: new AbortController(),
        cwd: mock.cwd,
        model: 'composer-2.5',
        traitValues: { effort: 'high' },
      }),
    ).resolves.toMatchObject({ output: 'done' })

    const messages = await readLoggedMessages(mock.logPath)
    expect(messages).toContainEqual(expect.objectContaining({
      method: 'session/set_config_option',
      params: {
        sessionId: 'session-1',
        configId: 'model',
        value: 'composer-2.5',
      },
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      method: 'session/set_config_option',
      params: {
        sessionId: 'session-1',
        configId: 'reasoning',
        value: 'high',
      },
    }))
  })

  it('skips Cursor effort-looking options that cannot accept the selected value', async () => {
    const mock = await createMockCursorAgent([
      DEFAULT_CURSOR_CONFIG_OPTIONS[0],
      {
        id: 'thinking',
        type: 'boolean',
        category: 'reasoning',
        name: 'Thinking',
      },
      DEFAULT_CURSOR_CONFIG_OPTIONS[1],
    ])

    await expect(
      executeCursor({
        prompt: 'Summarize the incident',
        binaryPath: mock.binaryPath,
        abortController: new AbortController(),
        cwd: mock.cwd,
        model: 'composer-2.5',
        traitValues: { effort: 'high' },
      }),
    ).resolves.toMatchObject({ output: 'done' })

    const messages = await readLoggedMessages(mock.logPath)
    expect(messages.some((message) => {
      if (message.method !== 'session/set_config_option') return false
      const params = getMessageParams(message)
      return params?.configId === 'thinking' && params.value === 'high'
    })).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({
      method: 'session/set_config_option',
      params: {
        sessionId: 'session-1',
        configId: 'reasoning',
        value: 'high',
      },
    }))
  })

})
