import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { Agent, request as createHttpRequest } from 'node:http'
import {
  HostMcpServerService,
} from '@bitsentry-ce/coding-agents/host-mcp-server.service'
import type { HostMcpEndpoint } from '@bitsentry-ce/coding-agents/host-mcp-server.service'
import type { HostToolContext } from '@bitsentry-ce/core/features/agent-runtime'
import type { RunbookExecutionRecord } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.types'

const servers: HostMcpServerService[] = []
const MCP_PROTOCOL_VERSION = '2026-07-28'

function modernMcpRequest(body: Record<string, unknown>, contextId: string): Record<string, unknown> {
  const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
    ? body.params as Record<string, unknown>
    : {}
  const toolArguments = body.method === 'tools/call'
    ? (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {})
    : undefined
  const modernParams = {
    ...params,
    ...(toolArguments === undefined ? {} : {
      arguments: {
        ...toolArguments,
        ...(toolArguments.contextId === undefined ? { contextId } : {}),
      },
    }),
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'bitsentry-test-client', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  }
  return {
    ...body,
    params: modernParams,
  }
}

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

function makeExecution(overrides: Partial<RunbookExecutionRecord> = {}): RunbookExecutionRecord {
  return {
    executionId: '11111111-1111-4111-8111-111111111111',
    runbookId: 'rb-kanye-rest',
    runbookTitle: 'Kanye Rest',
    status: 'running',
    startedAt: '2026-07-31T00:00:00.000Z',
    source: 'agent',
    steps: [],
    ...overrides,
  }
}

async function request(endpoint: HostMcpEndpoint, body: Record<string, unknown>, token = endpoint.token) {
  const modernBody = modernMcpRequest(body, endpoint.contextId)
  const method = typeof modernBody.method === 'string' ? modernBody.method : ''
  const toolName = method === 'tools/call' && typeof (modernBody.params as Record<string, unknown>).name === 'string'
    ? (modernBody.params as Record<string, unknown>).name as string
    : undefined
  return await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(toolName === undefined ? {} : { 'mcp-name': toolName }),
    },
    body: JSON.stringify(modernBody),
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
  const result = await runShim(endpoint, [body])
  return result.messages[0]
}

async function runShim(
  endpoint: HostMcpEndpoint,
  bodies: Record<string, unknown>[],
): Promise<{ messages: unknown[]; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(endpoint.command, endpoint.args, {
      env: { ...process.env, ...endpoint.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr || `Shim exited with ${String(code)}`))
        return
      }
      resolve({
        messages: stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)),
        stderr,
      })
    })
    child.stdin.end(bodies.map((body) => `${JSON.stringify(body)}\n`).join(''))
  })
}

async function requestInChunks(endpoint: HostMcpEndpoint, body: Buffer, splitAt: number): Promise<number> {
  const url = new URL(endpoint.url)
  return await new Promise((resolve, reject) => {
    const clientRequest = createHttpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': 'tools/list',
      },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    clientRequest.once('error', reject)
    clientRequest.write(body.subarray(0, splitAt))
    clientRequest.end(body.subarray(splitAt))
  })
}

async function openKeepAliveConnection(endpoint: HostMcpEndpoint, agent: Agent): Promise<void> {
  const url = new URL(endpoint.url)
  await new Promise<void>((resolve, reject) => {
    const clientRequest = createHttpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      agent,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': 'tools/list',
      },
    }, (response) => {
      response.resume()
      response.once('end', resolve)
    })
    clientRequest.once('error', reject)
    clientRequest.end(JSON.stringify(modernMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, endpoint.contextId)))
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

  it('rejects a context handle that is outside the bearer token scope', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    const response = await request(endpoint, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'execute_runbook', arguments: { contextId: 'foreign-context' } },
    })

    expect(response.status).toBe(200)
    expect(await readMcpResponse(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 9,
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('INVALID_CONTEXT_HANDLE') }],
      },
    })
  })

  it.each(['list_runbooks', 'list_plugins'] as const)(
    'rejects a foreign context handle for %s',
    async (name) => {
      const server = new HostMcpServerService()
      servers.push(server)
      const endpoint = await server.createSession(createContext())

      const response = await request(endpoint, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name, arguments: { contextId: 'foreign-context' } },
      })

      expect(await readMcpResponse(response)).toMatchObject({
        result: {
          isError: true,
          content: [{ type: 'text', text: expect.stringContaining('INVALID_CONTEXT_HANDLE') }],
        },
      })
    },
  )

  it('serves discovery only through the 2026-07-28 request envelope', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    const response = await request(endpoint, {
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
    })

    expect(response.status).toBe(200)
    expect(await readMcpResponse(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: {
        ttlMs: expect.any(Number),
        cacheScope: expect.any(String),
        supportedVersions: expect.arrayContaining([MCP_PROTOCOL_VERSION]),
      },
    })
  })

  it('rejects requests without the required stateless MCP headers and envelope', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    })

    expect(response.status).toBe(400)
    expect(await readMcpResponse(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 8,
      error: expect.objectContaining({ code: expect.any(Number) }),
    })
  })

  it('decodes multibyte request bodies split across TCP chunks', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'bitsentry-😀-client', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }))
    const emojiStart = body.indexOf(Buffer.from('😀'))

    expect(emojiStart).toBeGreaterThanOrEqual(0)
    await expect(requestInChunks(endpoint, body, emojiStart + 2)).resolves.toBe(200)
  })

  it('gives each endpoint a distinct scoped token', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const first = await server.createSession(createContext())
    const second = await server.createSession(createContext())

    expect(first.url).toBe(second.url)
    expect(first.token).not.toBe(second.token)
    expect(first.contextId).not.toBe(second.contextId)
    expect(first.args).toHaveLength(1)
    expect(first.env).toMatchObject({
      BITSENTRY_MCP_URL: first.url,
      BITSENTRY_MCP_TOKEN: first.token,
      BITSENTRY_MCP_CONTEXT_ID: first.contextId,
    })
  })

  it('removes an endpoint ledger when its execution closes', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    expect(server.getLedger(endpoint.token)).toEqual([])
    server.closeSession(endpoint.token)

    expect(server.getLedger(endpoint.token)).toEqual([])
    await expect(request(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      .resolves.toMatchObject({ status: 401 })
  })

  it('sweeps expired endpoint contexts without waiting for another request', async () => {
    const server = new HostMcpServerService(1)
    servers.push(server)
    const endpoint = await server.createSession(createContext(), 1)

    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(request(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      .resolves.toMatchObject({ status: 401 })
  })

  it('translates legacy stdio MCP initialize and tool requests at the shim boundary', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    await expect(requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-cli', version: '1.0.0' },
      },
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: expect.any(Object),
      },
    })

    await expect(requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 4,
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'execute_runbook' })]) },
    })

    await expect(requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'execute_runbook', arguments: {} },
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      result: {
        isError: true,
        content: [{ text: expect.not.stringContaining('INVALID_CONTEXT_HANDLE') }],
      },
    })
  })

  it('reports only the supported legacy protocol version during shim initialization', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    await expect(requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 31,
      method: 'initialize',
      params: {
        protocolVersion: '2099-01-01',
        capabilities: {},
        clientInfo: { name: 'unsupported-legacy-cli', version: '1.0.0' },
      },
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 31,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: expect.any(Object) },
      },
    })
  })

  it('does not respond to failed shim notifications', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())
    const unavailableEndpoint = {
      ...endpoint,
      env: { ...endpoint.env, BITSENTRY_MCP_URL: 'http://127.0.0.1:1/mcp' },
    }

    await expect(runShim(unavailableEndpoint, [{
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
    }])).resolves.toMatchObject({
      messages: [],
      stderr: expect.stringContaining('notification failed'),
    })
  })

  it('returns JSON-RPC errors with the original id when the host is unavailable', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())
    const unavailableEndpoint = {
      ...endpoint,
      env: { ...endpoint.env, BITSENTRY_MCP_URL: 'http://127.0.0.1:1/mcp' },
    }

    await expect(requestThroughShim(unavailableEndpoint, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/list',
    })).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32000 },
    })
  })

  it('advertises clean object schemas for host tools', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const endpoint = await server.createSession(createContext())

    const response = await request(endpoint, { jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const payload = await readMcpResponse(response) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
    }
    const executeRunbook = payload.result.tools.find((tool) => tool.name === 'execute_runbook')

    expect(executeRunbook?.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ contextId: expect.any(Object) }),
    })
    expect((executeRunbook?.inputSchema.required as string[] | undefined) ?? [])
      .not.toContain('contextId')
    expect(executeRunbook?.inputSchema).not.toHaveProperty('anyOf')
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

  it('renews a session TTL when an authenticated request is received', async () => {
    const server = new HostMcpServerService(1)
    servers.push(server)
    const endpoint = await server.createSession(createContext(), 100)

    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(request(endpoint, { jsonrpc: '2.0', id: 18, method: 'tools/list' }))
      .resolves.toMatchObject({ status: 200 })
    await new Promise((resolve) => setTimeout(resolve, 70))

    await expect(request(endpoint, { jsonrpc: '2.0', id: 19, method: 'tools/list' }))
      .resolves.toMatchObject({ status: 200 })
  })

  it('stops promptly when a client keeps its HTTP connection open', async () => {
    const server = new HostMcpServerService()
    const endpoint = await server.createSession(createContext())
    const agent = new Agent({ keepAlive: true })

    try {
      await openKeepAliveConnection(endpoint, agent)
      await expect(Promise.race([
        server.stop(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Host MCP stop timed out')), 200)),
      ])).resolves.toBeUndefined()
    } finally {
      agent.destroy()
    }
  })

  it('stops a host that is still starting', async () => {
    const server = new HostMcpServerService()
    const endpointPromise = server.createSession(createContext())
    const stopPromise = server.stop()

    const endpoint = await endpointPromise
    await stopPromise

    await expect(request(endpoint, { jsonrpc: '2.0', id: 21, method: 'tools/list' }))
      .rejects.toThrow()
  })

  it('keeps a streamable get_runbook_execution request open until the gateway completes', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const context = createContext()
    const runningExecution = makeExecution()
    const completedExecution = makeExecution({
      status: 'completed',
      completedAt: '2026-07-31T00:00:01.000Z',
    })
    let completeExecution: ((execution: RunbookExecutionRecord) => void) | undefined
    const completion = new Promise<RunbookExecutionRecord>((resolve) => {
      completeExecution = resolve
    })
    context.session.latestRunbookExecutionId = runningExecution.executionId
    context.gateway.get = vi.fn().mockResolvedValue(runningExecution)
    context.gateway.waitForCompletion = vi.fn().mockReturnValue(completion)
    const endpoint = await server.createSession(context)

    const responsePromise = request(endpoint, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'get_runbook_execution',
        arguments: { waitForCompletion: true },
      },
    })

    await vi.waitFor(() => {
      expect(context.gateway.waitForCompletion).toHaveBeenCalledWith(runningExecution.executionId, {
        timeoutMs: 30_000,
      })
    })
    expect(completeExecution).toBeDefined()
    completeExecution?.(completedExecution)

    const response = await responsePromise
    const payload = await readMcpResponse(response) as {
      result: { content: Array<{ text: string }> }
    }
    expect(JSON.parse(payload.result.content[0]?.text ?? '')).toMatchObject({
      executionId: runningExecution.executionId,
      status: 'completed',
    })
  })

  it('keeps a shim tool call open beyond the short request timeout', async () => {
    const server = new HostMcpServerService()
    servers.push(server)
    const context = createContext()
    const runningExecution = makeExecution()
    const completedExecution = makeExecution({
      status: 'completed',
      completedAt: '2026-07-31T00:00:11.000Z',
    })
    let completeExecution: ((execution: RunbookExecutionRecord) => void) | undefined
    const completion = new Promise<RunbookExecutionRecord>((resolve) => {
      completeExecution = resolve
    })
    context.session.latestRunbookExecutionId = runningExecution.executionId
    context.gateway.get = vi.fn().mockResolvedValue(runningExecution)
    context.gateway.waitForCompletion = vi.fn().mockReturnValue(completion)
    const endpoint = await server.createSession(context)

    const responsePromise = requestThroughShim(endpoint, {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'get_runbook_execution',
        arguments: { waitForCompletion: true },
      },
    })
    await vi.waitFor(() => {
      expect(context.gateway.waitForCompletion).toHaveBeenCalledOnce()
    })
    await new Promise((resolve) => setTimeout(resolve, 10_100))
    completeExecution?.(completedExecution)

    await expect(responsePromise).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 32,
      result: {
        content: [{ text: expect.stringContaining('completed') }],
      },
    })
  }, 15_000)
})
