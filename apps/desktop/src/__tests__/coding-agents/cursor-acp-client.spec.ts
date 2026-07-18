import { mkdtemp, readFile, rm, writeFile, chmod } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CursorAcpClient } from '@bitsentry-ce/coding-agents'

const tmpDirs: string[] = []

interface CursorNotification {
  method: string
  params: unknown
}

interface CursorServerRequest extends CursorNotification {
  id: string | number | null
}

interface LoggedCursorMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  argv?: string[]
}

function parseJsonLine(line: string): unknown {
  return JSON.parse(line) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isCursorNotification(value: unknown): value is CursorNotification {
  return isRecord(value) && typeof value.method === 'string'
}

function isCursorServerRequest(value: unknown): value is CursorServerRequest {
  return (
    isRecord(value) &&
    typeof value.method === 'string' &&
    (typeof value.id === 'string' || typeof value.id === 'number' || value.id === null)
  )
}

function parseLoggedCursorMessage(line: string): LoggedCursorMessage {
  const parsed = parseJsonLine(line)
  if (!isRecord(parsed)) {
    throw new Error(`Expected logged cursor message object: ${line}`)
  }

  return parsed
}

async function createMockCursorAgent(): Promise<{ binaryPath: string; logPath: string; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cursor-acp-client-'))
  tmpDirs.push(cwd)

  const logPath = path.join(cwd, 'messages.jsonl')
  const scriptPath = path.join(cwd, 'mock-cursor-agent.cjs')
  const script = `
const fs = require('fs')
const readline = require('readline')

const logPath = ${JSON.stringify(logPath)}
const logMessage = (message) => {
  fs.appendFileSync(logPath, JSON.stringify(message) + '\\n')
}

const argv = process.argv.slice(2)
logMessage({ argv })

if (!argv.includes('acp')) {
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
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    }) + '\\n')
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'Run command', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    }) + '\\n')
  }

  if (message.method === 'session/cancel') {
    setTimeout(() => process.exit(0), 10)
  }

  if (message.method === 'test/rpc-error') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32001, message: 'mock Cursor RPC failure' },
    }) + '\\n')
  }

  if (message.method === 'test/malformed-frame') {
    process.stdout.write('not valid json\\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { recovered: true } }) + '\\n')
  }

  if (message.method === 'test/partial-frame') {
    const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { fragmented: true } }) + '\\n'
    process.stdout.write(response.slice(0, 12))
    setTimeout(() => process.stdout.write(response.slice(12)), 5)
  }

  if (message.method === 'test/slow-first') {
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id, result: { request: 'slow-first' },
    }) + '\\n'), 25)
  }

  if (message.method === 'test/fast-second') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id, result: { request: 'fast-second' },
    }) + '\\n')
  }
})

setInterval(() => {}, 1000)
`
  await writeFile(scriptPath, script)

  if (process.platform === 'win32') {
    const binaryPath = path.join(cwd, 'cursor-agent.cmd')
    await writeFile(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`)
    return { binaryPath, logPath, cwd }
  }

  const binaryPath = path.join(cwd, 'cursor-agent')
  await writeFile(binaryPath, `#!/usr/bin/env node\n${script}`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, logPath, cwd }
}

async function createExitingMockCursorAgent(stderr: string): Promise<{ binaryPath: string; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cursor-acp-client-exit-'))
  tmpDirs.push(cwd)

  const scriptPath = path.join(cwd, 'mock-cursor-agent-exit.cjs')
  const script = `
const readline = require('readline')

if (!process.argv.slice(2).includes('acp')) {
  process.exit(64)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
  process.stderr.write(${JSON.stringify(stderr)})
  process.exit(1)
})
`
  await writeFile(scriptPath, script)

  if (process.platform === 'win32') {
    const binaryPath = path.join(cwd, 'cursor-agent.cmd')
    await writeFile(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`)
    return { binaryPath, cwd }
  }

  const binaryPath = path.join(cwd, 'cursor-agent')
  await writeFile(binaryPath, `#!/usr/bin/env node\n${script}`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd }
}

async function readLoggedMessages(logPath: string): Promise<LoggedCursorMessage[]> {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLoggedCursorMessage(line))
}

async function waitFor(
  assertion: () => Promise<void> | void,
  timeoutMs = 3000,
): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CursorAcpClient', () => {
  it('frames JSON-RPC 2.0 requests, routes notifications and responds to server requests', async () => {
    const mock = await createMockCursorAgent()

    const client = new CursorAcpClient(mock.binaryPath, mock.cwd)
    const notifications: CursorNotification[] = []
    const serverRequests: CursorServerRequest[] = []
    client.on('notification', (notification: unknown) => {
      if (!isCursorNotification(notification)) {
        throw new Error('Cursor notification payload was invalid')
      }

      notifications.push(notification)
    })
    client.on('serverRequest', (request) => {
      if (!isCursorServerRequest(request)) {
        throw new Error('Cursor server request payload was invalid')
      }

      serverRequests.push(request)
      client.respondToServerRequest(request.id, {
        outcome: { outcome: 'selected', optionId: 'reject' },
      })
    })

    try {
      await client.start()
      const result = await client.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })

      expect(result).toMatchObject({ protocolVersion: 1 })
      await waitFor(() => {
        expect(notifications).toHaveLength(1)
        expect(serverRequests).toHaveLength(1)
      })

      client.cancelSession('session-1')
      await waitFor(async () => {
        const messages = await readLoggedMessages(mock.logPath)
        expect(messages.some((message) => message.method === 'session/cancel')).toBe(true)
      })

      const messages = await readLoggedMessages(mock.logPath)
      const initializeMessage = messages.find((message) => message.method === 'initialize')
      expect(initializeMessage).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      })
      expect(notifications[0]).toMatchObject({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
          },
        },
      })
      expect(serverRequests[0]).toMatchObject({
        id: 'permission-1',
        method: 'session/request_permission',
      })
      expect(messages).toContainEqual({
        jsonrpc: '2.0',
        id: 'permission-1',
        result: {
          outcome: { outcome: 'selected', optionId: 'reject' },
        },
      })
      const cancelMessage = messages.find((message) => message.method === 'session/cancel')
      expect(cancelMessage).toEqual({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'session-1' },
      })
    } finally {
      await client.kill()
    }
  })

  it('starts ACP without model flags', async () => {
    const mock = await createMockCursorAgent()

    const client = new CursorAcpClient(mock.binaryPath, mock.cwd)

    try {
      await client.start('composer-2.5')

      await waitFor(async () => {
        const messages = await readLoggedMessages(mock.logPath)
        expect(messages[0]).toEqual({ argv: ['acp'] })
      })
    } finally {
      await client.kill()
    }
  })

  it('includes stderr when the ACP process exits with a pending request', async () => {
    const mock = await createExitingMockCursorAgent('not logged in; run cursor-agent login\\n')
    const client = new CursorAcpClient(mock.binaryPath, mock.cwd)

    try {
      await client.start()
      await expect(client.sendRequest('initialize', { protocolVersion: 1 })).rejects.toThrow(
        /Cursor ACP client process exited: pending initialize cancelled[\s\S]*not logged in; run cursor-agent login/,
      )
    } finally {
      await client.kill()
    }
  })

  it('surfaces RPC failures and malformed frames without losing a later response', async () => {
    const mock = await createMockCursorAgent()
    const client = new CursorAcpClient(mock.binaryPath, mock.cwd)
    const parseErrors: Array<{ error: string; raw: string }> = []
    client.on('parseError', (error) => parseErrors.push(error as { error: string; raw: string }))

    try {
      await client.start()
      await expect(client.sendRequest('test/rpc-error')).rejects.toThrow('mock Cursor RPC failure')
      await expect(client.sendRequest('test/malformed-frame')).resolves.toEqual({ recovered: true })
      await waitFor(() => {
        expect(parseErrors).toHaveLength(1)
        expect(parseErrors[0]?.raw).toContain('not valid json')
      })
    } finally {
      await client.kill()
    }
  })

  it('times out a hung request and remains usable for later requests', async () => {
    const mock = await createMockCursorAgent()
    const client = new CursorAcpClient(mock.binaryPath, mock.cwd, { requestTimeoutMs: 100 })

    try {
      await client.start()
      await waitFor(async () => {
        const messages = await readLoggedMessages(mock.logPath)
        expect(messages).toContainEqual({ argv: ['acp'] })
      })
      await expect(client.sendRequest('test/hang')).rejects.toThrow(
        'Cursor ACP RPC test/hang timed out after 0.1s',
      )
      await expect(client.sendRequest('test/fast-second')).resolves.toEqual({ request: 'fast-second' })
    } finally {
      await client.kill()
    }
  })

  it('reassembles fragmented frames and correlates overlapping replies by request id', async () => {
    const mock = await createMockCursorAgent()
    const client = new CursorAcpClient(mock.binaryPath, mock.cwd)

    try {
      await client.start()
      await expect(client.sendRequest('test/partial-frame')).resolves.toEqual({ fragmented: true })

      const slow = client.sendRequest('test/slow-first')
      const fast = client.sendRequest('test/fast-second')
      await expect(fast).resolves.toEqual({ request: 'fast-second' })
      await expect(slow).resolves.toEqual({ request: 'slow-first' })
    } finally {
      await client.kill()
    }
  })
})
