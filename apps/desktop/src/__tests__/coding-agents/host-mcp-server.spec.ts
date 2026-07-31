import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  HostMcpServerService,
} from '@bitsentry-ce/coding-agents/host-mcp-server.service'
import type { HostMcpEndpoint } from '@bitsentry-ce/coding-agents/host-mcp-server.service'
import type { HostToolContext } from '@bitsentry-ce/core/features/agent-runtime'

const servers: HostMcpServerService[] = []

function createContext(): HostToolContext {
  return {
    gateway: {
      listExecutable: vi.fn().mockResolvedValue([]),
      getRunbookContext: vi.fn(),
      start: vi.fn(),
      get: vi.fn(),
      getLatestForIncidentThread: vi.fn(),
      waitForCompletion: vi.fn(),
      subscribe: vi.fn(),
      cancel: vi.fn(),
    },
    session: { id: 'session-1' },
  }
}

async function request(endpoint: HostMcpEndpoint, body: Record<string, unknown>, token = endpoint.token) {
  return await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
}

async function readMcpResponse(response: Response): Promise<unknown> {
  const body = await response.text()
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').find((entry) => entry.startsWith('data:'))?.slice('data:'.length).trim()
    : body
  return JSON.parse(payload ?? '')
}

async function requestThroughShim(endpoint: HostMcpEndpoint, body: Record<string, unknown>): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn(endpoint.command, endpoint.args, {
      env: { ...process.env, ...endpoint.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdout.once('data', (chunk: Buffer) => {
      child.kill()
      resolve(JSON.parse(chunk.toString()))
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 && code !== null) reject(new Error(stderr || `Shim exited with ${String(code)}`))
    })
    child.stdin.write(`${JSON.stringify(body)}\n`)
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()))
})

describe('HostMcpServerService', () => {
  it('requires a session token and executes tools in the matching session ledger', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const context = createContext()
    const endpoint = await server.createSession(context)

    await expect(request(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong-token'))
      .resolves.toMatchObject({ status: 401 })

    const response = await request(endpoint, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_runbooks', arguments: {} },
    })

    expect(response.status).toBe(200)
    expect(await readMcpResponse(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text' }] },
    })
    expect(context.gateway.listExecutable).toHaveBeenCalledOnce()
    expect(server.getLedger(endpoint.token)).toEqual([
      expect.objectContaining({ type: 'started', toolName: 'list_runbooks' }),
      expect.objectContaining({ type: 'completed', toolName: 'list_runbooks' }),
    ])
  })

  it('gives each endpoint a distinct scoped token', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const first = await server.createSession(createContext())
    const second = await server.createSession(createContext())

    expect(first.url).toBe(second.url)
    expect(first.token).not.toBe(second.token)
    expect(first.args).toHaveLength(1)
    expect(first.env).toMatchObject({
      BITSENTRY_MCP_URL: first.url,
      BITSENTRY_MCP_TOKEN: first.token,
    })
  })

  it('proxies stdio MCP requests to the token-scoped endpoint', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    await expect(requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'execute_runbook' })]) },
    })
  })

  it('accepts null or omitted arguments for zero-argument MCP tools', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const context = createContext()
    const endpoint = await server.createSession(context)

    const responses = await Promise.all([
      request(endpoint, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'list_runbooks', arguments: null },
      }),
      request(endpoint, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'list_runbooks' },
      }),
    ])

    await expect(Promise.all(responses.map(readMcpResponse))).resolves.toEqual([
      expect.objectContaining({ id: 4, result: expect.anything() }),
      expect.objectContaining({ id: 5, result: expect.anything() }),
    ])
    expect(context.gateway.listExecutable).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent token-scoped requests independent', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const context = createContext()
    const endpoint = await server.createSession(context)

    const responses = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const response = await request(endpoint, {
        jsonrpc: '2.0',
        id: index + 10,
        method: 'tools/list',
      })
      return await readMcpResponse(response)
    }))

    expect(responses).toEqual(Array.from({ length: 8 }, (_, index) =>
      expect.objectContaining({ id: index + 10, result: expect.objectContaining({ tools: expect.any(Array) }) }),
    ))
  })
})
