import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCodex } from '@bitsentry-ce/coding-agents/codex-provider.service'
import {
  codexStreamDeltasFromNotification,
  normalizeCodexExecutionError,
} from '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'

const tempDirs: string[] = []

async function createMultiItemCodexAppServer(): Promise<{
  binaryPath: string
  cwd: string
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-test-'))
  tempDirs.push(cwd)

  const scriptPath = path.join(cwd, 'mock-codex-app-server.cjs')
  const script = `
const readline = require('readline')

const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n')
const toolCall = '<bitsentry_tool_call>{"name":"list_runbooks","id":"call-list-runbooks","args":{}}</bitsentry_tool_call>'

if (!process.argv.slice(2).includes('app-server')) process.exit(64)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)

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
    notify('item/started', { item: { id: 'item-tool-call', type: 'agentMessage' } })
    notify('item/completed', {
      item: { id: 'item-tool-call', type: 'agentMessage', text: toolCall },
    })
    notify('turn/completed', { turn: { id: 'turn-multi-item' } })
  }
})
`
  await writeFile(scriptPath, script)

  const binaryPath = path.join(cwd, 'codex')
  await writeFile(binaryPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Codex provider behavior', () => {
  it('keeps completed-only agent messages so runtime tool-call blocks survive', async () => {
    const mock = await createMultiItemCodexAppServer()
    const result = await executeCodex({
      prompt: 'List available runbooks.',
      binaryPath: mock.binaryPath,
      cwd: mock.cwd,
      abortController: new AbortController(),
      accessLevel: 'auto-accept-edits',
    })

    expect(result.output).toContain('I will list runbooks.')
    expect(result.output).toContain(
      '<bitsentry_tool_call>{"name":"list_runbooks","id":"call-list-runbooks","args":{}}</bitsentry_tool_call>',
    )
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

describe('normalizeCodexExecutionError', () => {
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
