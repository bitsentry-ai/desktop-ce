import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAppServerClient } from '@bitsentry-ce/coding-agents/codex-app-server-client'

const tmpDirs: string[] = []

interface LoggedMessage {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface MockCodexAppServer {
  binaryPath: string
  cwd: string
  logPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readLoggedMessages(logPath: string): Promise<LoggedMessage[]> {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .map((message) => {
      if (!isRecord(message)) {
        throw new Error(`Expected logged JSON-RPC object: ${JSON.stringify(message)}`)
      }
      return message
    })
}

async function waitFor(
  assertion: () => Promise<void> | void,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  throw lastError
}

async function createMockCodexAppServer(options?: {
  emitMalformedFrame?: boolean
  stderr?: string
}): Promise<MockCodexAppServer> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-client-'))
  tmpDirs.push(cwd)

  const logPath = path.join(cwd, 'messages.jsonl')
  const scriptPath = path.join(cwd, 'mock-codex-app-server.cjs')
  const script = `
const fs = require('fs')
const readline = require('readline')

const logPath = ${JSON.stringify(logPath)}
const emitMalformedFrame = ${JSON.stringify(options?.emitMalformedFrame === true)}
const stderr = ${JSON.stringify(options?.stderr ?? '')}

if (!process.argv.slice(2).includes('app-server')) {
  process.exit(64)
}

const logMessage = (message) => {
  fs.appendFileSync(logPath, JSON.stringify(message) + '\\n')
}
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ id, result }) + '\\n')
}
const respondError = (id, message) => {
  process.stdout.write(JSON.stringify({ id, error: { code: -32000, message } }) + '\\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  logMessage(message)

  if (message.method === 'initialize') {
    if (stderr) process.stderr.write(stderr)
    if (emitMalformedFrame) process.stdout.write('{not json}\\n')
    respond(message.id, { userAgent: 'mock-codex-app-server' })
    return
  }

  if (message.method === 'initialized') {
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'mock server ready' },
    }) + '\\n')
    process.stdout.write(JSON.stringify({
      id: 'approval-1',
      method: 'item/tool/requestUserInput',
      params: { question: 'Continue?' },
    }) + '\\n')
    return
  }

  if (message.method === 'echo') {
    respond(message.id, message.params)
    return
  }

  if (message.method === 'fail') {
    respondError(message.id, 'mock provider failure')
    return
  }

  if (message.method === 'partial') {
    const response = JSON.stringify({ id: message.id, result: { fragmented: true } }) + '\\n'
    process.stdout.write(response.slice(0, 12))
    setTimeout(() => process.stdout.write(response.slice(12)), 5)
    return
  }

  if (message.method === 'slow-first') {
    setTimeout(() => respond(message.id, { request: 'slow-first' }), 25)
    return
  }

  if (message.method === 'fast-second') {
    respond(message.id, { request: 'fast-second' })
    return
  }

  if (message.method === 'exit') {
    process.exit(1)
  }
})

setInterval(() => {}, 1_000)
`
  await writeFile(scriptPath, script)

  if (process.platform === 'win32') {
    const binaryPath = path.join(cwd, 'codex.cmd')
    await writeFile(binaryPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`)
    return { binaryPath, cwd, logPath }
  }

  const binaryPath = path.join(cwd, 'codex')
  await writeFile(binaryPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`)
  await chmod(binaryPath, 0o755)
  return { binaryPath, cwd, logPath }
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CodexAppServerClient subprocess protocol', () => {
  it('initializes a child peer, routes notifications, and answers server requests', async () => {
    const mock = await createMockCodexAppServer()
    const client = new CodexAppServerClient(mock.binaryPath, mock.cwd)
    const notifications: Array<{ method: string; params: unknown }> = []
    const serverRequests: Array<{ id: string | number; method: string; params: unknown }> = []

    client.on('notification', (notification) => {
      notifications.push(notification as { method: string; params: unknown })
    })
    client.on('serverRequest', (request) => {
      const typedRequest = request as { id: string | number; method: string; params: unknown }
      serverRequests.push(typedRequest)
      client.respondToServerRequest(typedRequest.id, { answers: { approved: true } })
    })

    try {
      await client.start()
      await expect(client.sendRequest('echo', { value: 'round trip' })).resolves.toEqual({
        value: 'round trip',
      })

      await waitFor(async () => {
        expect(notifications).toContainEqual({
          method: 'item/agentMessage/delta',
          params: { delta: 'mock server ready' },
        })
        expect(serverRequests).toContainEqual({
          id: 'approval-1',
          method: 'item/tool/requestUserInput',
          params: { question: 'Continue?' },
        })
        await expect(readLoggedMessages(mock.logPath)).resolves.toContainEqual({
          id: 'approval-1',
          result: { answers: { approved: true } },
        })
      })
    } finally {
      client.kill()
    }
  })

  it('surfaces malformed frames while preserving the initialized session and stderr tail', async () => {
    const mock = await createMockCodexAppServer({
      emitMalformedFrame: true,
      stderr: 'provider diagnostic\\n',
    })
    const client = new CodexAppServerClient(mock.binaryPath, mock.cwd)
    const parseErrors: Array<{ error: string; raw: string }> = []
    client.on('parseError', (error) => parseErrors.push(error as { error: string; raw: string }))

    try {
      await client.start()
      await waitFor(() => {
        expect(parseErrors).toHaveLength(1)
        expect(parseErrors[0]?.raw).toContain('{not json}')
      })
      expect(client.getStderrTail()).toContain('provider diagnostic')
      await expect(client.sendRequest('echo', { healthy: true })).resolves.toEqual({ healthy: true })
    } finally {
      client.kill()
    }
  })

  it('rejects typed RPC failures and pending work when the child exits', async () => {
    const mock = await createMockCodexAppServer()
    const client = new CodexAppServerClient(mock.binaryPath, mock.cwd)

    try {
      await client.start()
      await expect(client.sendRequest('fail')).rejects.toThrow('mock provider failure')

      const pendingExit = client.sendRequest('exit')
      await expect(pendingExit).rejects.toThrow(
        'Codex app-server process exited: pending exit cancelled',
      )
    } finally {
      client.kill()
    }
  })

  it('times out a hung request and remains usable for later requests', async () => {
    const mock = await createMockCodexAppServer()
    const client = new CodexAppServerClient(mock.binaryPath, mock.cwd, [], { requestTimeoutMs: 100 })

    try {
      await client.start()
      await expect(client.sendRequest('hang')).rejects.toThrow('Codex RPC hang timed out after 0.1s')
      await expect(client.sendRequest('echo', { recovered: true })).resolves.toEqual({ recovered: true })
    } finally {
      client.kill()
    }
  })

  it('reassembles fragmented frames and correlates overlapping replies by request id', async () => {
    const mock = await createMockCodexAppServer()
    const client = new CodexAppServerClient(mock.binaryPath, mock.cwd)

    try {
      await client.start()
      await expect(client.sendRequest('partial')).resolves.toEqual({ fragmented: true })

      const slow = client.sendRequest('slow-first')
      const fast = client.sendRequest('fast-second')
      await expect(fast).resolves.toEqual({ request: 'fast-second' })
      await expect(slow).resolves.toEqual({ request: 'slow-first' })
    } finally {
      client.kill()
    }
  })
})
