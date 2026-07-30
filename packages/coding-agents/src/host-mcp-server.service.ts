import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  executeHostTool,
  getHostTools,
  type HostToolContext,
  type HostToolEvent,
} from '@bitsentry-ce/core/features/agent-runtime'

const HOST_MCP_PATH = '/mcp'
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000

export interface HostMcpEndpoint {
  url: string
  token: string
  expiresAt: number
  command: string
  args: string[]
  env: Record<string, string>
}

type HostMcpSession = {
  context: HostToolContext
  expiresAt: number
  ledger: HostToolEvent[]
}

function sendJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
}

function hasMatchingToken(receivedToken: string | undefined, expectedToken: string): boolean {
  if (receivedToken === undefined) return false
  const received = Buffer.from(receivedToken)
  const expected = Buffer.from(expectedToken)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function createSessionServer(session: HostMcpSession): McpServer {
  const server = new McpServer({ name: 'bitsentry-host-tools', version: '1.0.0' })
  for (const hostTool of getHostTools()) {
    server.registerTool(hostTool.name, {
      description: hostTool.description,
      inputSchema: hostTool.argsSchema.shape,
    }, async (args) => {
      const result = await executeHostTool({
        ...session.context,
        onToolEvent: (event) => {
          session.ledger.push(event)
          session.context.onToolEvent?.(event)
        },
      }, hostTool.name, args)
      const text = result?.error ?? result?.output ?? 'Host tool completed without output.'
      return {
        content: [{ type: 'text' as const, text }],
        ...(result?.error !== undefined ? { isError: true } : {}),
      }
    })
  }
  return server
}

export class HostMcpServerService {
  private readonly sessions = new Map<string, HostMcpSession>()
  private httpServer: Server | undefined
  private baseUrl: string | undefined

  async start(): Promise<void> {
    if (this.httpServer !== undefined) return
    this.httpServer = createServer((request, response) => { void this.handleRequest(request, response) })
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject)
      this.httpServer?.listen(0, '127.0.0.1', () => {
        this.httpServer?.off('error', reject)
        resolve()
      })
    })
    const address = this.httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('Host MCP endpoint did not bind to a TCP port')
    this.baseUrl = `http://127.0.0.1:${String(address.port)}${HOST_MCP_PATH}`
  }

  async stop(): Promise<void> {
    this.sessions.clear()
    const server = this.httpServer
    this.httpServer = undefined
    this.baseUrl = undefined
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }

  async createSession(context: HostToolContext, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<HostMcpEndpoint> {
    await this.start()
    this.pruneExpiredSessions()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    this.sessions.set(token, { context, expiresAt, ledger: [] })
    if (this.baseUrl === undefined) throw new Error('Host MCP endpoint is not running')
    return {
      url: this.baseUrl,
      token,
      expiresAt,
      command: process.execPath,
      args: [getHostMcpShimPath()],
      env: { BITSENTRY_MCP_URL: this.baseUrl, BITSENTRY_MCP_TOKEN: token },
    }
  }

  closeSession(token: string): void { this.sessions.delete(token) }

  getLedger(token: string): readonly HostToolEvent[] { return this.sessions.get(token)?.ledger ?? [] }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token)
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.split('?')[0] !== HOST_MCP_PATH) return sendJson(response, 404, { error: 'Not found' })
    this.pruneExpiredSessions()
    const receivedToken = readBearerToken(request)
    const session = [...this.sessions.entries()].find(([token]) => hasMatchingToken(receivedToken, token))?.[1]
    if (session === undefined) return sendJson(response, 401, { error: 'Unauthorized' })
    const server = createSessionServer(session)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } finally {
      await server.close()
    }
  }
}

export function getHostMcpShimPath(): string {
  return fileURLToPath(new URL('./host-mcp-shim.cjs', import.meta.url))
}
