import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_MCP_SHIM_FILE_NAME, HOST_MCP_SHIM_SOURCE } from './host-mcp-shim-source.js'
import { createHostToolCore } from './host-tool-core.js'
import { scopeOptionsFor, type RunbookOnlyScopeOptions } from './runbook-only-scope.js'
import { codingAgentsLogger as log } from './logger.js'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import {
  type HostToolContext,
} from '@bitsentry-ce/core/features/agent-runtime'

const HOST_MCP_PATH = '/mcp'
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000
const MAX_MCP_REQUEST_BODY_BYTES = 1024 * 1024
export const HOST_MCP_SERVER_NAME = 'bitsentry'

export interface HostMcpEndpoint {
  url: string
  token: string
  contextId: string
  command: string
  args: string[]
  env: Record<string, string>
  agentSessionId: string
  scopeOptions?: RunbookOnlyScopeOptions
}

type HostMcpSession = {
  contextId: string
  context: HostToolContext
  expiresAt: number
  ttlMs: number
  activeRequests: number
}

type HostMcpAuthInfo = {
  extra: { hostMcpSession: HostMcpSession }
}

function sendJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function readBearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
}

function hasMatchingToken(receivedToken: string | undefined, expectedToken: string): boolean {
  if (receivedToken === undefined) return false
  const received = Buffer.from(receivedToken)
  const expected = Buffer.from(expectedToken)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

async function readMcpRequestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.length
    if (byteLength > MAX_MCP_REQUEST_BODY_BYTES) {
      throw new Error('MCP request body exceeds the 1 MiB limit')
    }
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  return body.length === 0 ? undefined : JSON.parse(body)
}

function createSessionServer(session: HostMcpSession): McpServer {
  const server = new McpServer({ name: 'bitsentry-host-tools', version: '1.0.0' })
  const hostTools = createHostToolCore(session.context, undefined, session.contextId)
  for (const hostTool of hostTools.tools) {
    server.registerTool(hostTool.name, {
      description: hostTool.description,
      inputSchema: hostTools.inputSchemaFor(hostTool),
    }, async (args) => await hostTools.call(hostTool.name, args))
  }
  return server
}

export class HostMcpServerService {
  private readonly sessions = new Map<string, HostMcpSession>()
  private httpServer: Server | undefined
  private baseUrl: string | undefined
  private shimDirectory: string | undefined
  private shimPath: string | undefined
  private shimPromise: Promise<string> | undefined
  private sessionSweepTimer: ReturnType<typeof setInterval> | undefined
  private startPromise: Promise<void> | undefined
  private readonly mcpHandler = createMcpHandler(({ authInfo }) => {
    const { hostMcpSession } = (authInfo as unknown as HostMcpAuthInfo).extra
    return createSessionServer(hostMcpSession)
  }, {
    legacy: 'reject',
    onerror: (error) => log.warn('[host-mcp] stateless request failed', { reason: error.message }),
  })
  private readonly nodeMcpHandler = toNodeHandler(this.mcpHandler, {
    onerror: (error) => log.warn('[host-mcp] node transport failed', { reason: error.message }),
  })

  constructor(private readonly sessionSweepIntervalMs = DEFAULT_SESSION_SWEEP_INTERVAL_MS) {}

  async start(): Promise<void> {
    if (this.httpServer !== undefined && this.baseUrl !== undefined) return
    if (this.startPromise !== undefined) return await this.startPromise
    this.startPromise = (async () => {
      await this.ensureShimFile()
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          log.warn('[host-mcp] request handler failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
          if (!response.writableEnded) sendJson(response, 500, { error: 'Internal server error' })
        })
      })
      server.keepAliveTimeout = 1_000
      this.httpServer = server
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(0, '127.0.0.1')
        })
        this.sessionSweepTimer = setInterval(() => this.pruneExpiredSessions(), this.sessionSweepIntervalMs)
        this.sessionSweepTimer.unref?.()
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('Host MCP endpoint did not bind to a TCP port')
        this.baseUrl = `http://127.0.0.1:${String(address.port)}${HOST_MCP_PATH}`
      } catch (error) {
        this.httpServer = undefined
        this.baseUrl = undefined
        await new Promise<void>((resolve) => server.close(() => resolve()))
        throw error
      }
    })()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async stop(): Promise<void> {
    const startPromise = this.startPromise
    if (startPromise !== undefined) await startPromise.catch(() => {})
    this.sessions.clear()
    if (this.sessionSweepTimer !== undefined) clearInterval(this.sessionSweepTimer)
    this.sessionSweepTimer = undefined
    const server = this.httpServer
    this.httpServer = undefined
    this.baseUrl = undefined
    const shimDirectory = this.shimDirectory
    this.shimDirectory = undefined
    this.shimPath = undefined
    this.shimPromise = undefined
    if (shimDirectory !== undefined) {
      await rm(shimDirectory, { recursive: true, force: true })
    }
    if (server === undefined) return
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error))
    })
    server.closeAllConnections()
    await closePromise
  }

  // CLIs spawn the shim themselves, so it must exist as a plain file outside
  // the app bundle (electron-vite folds this package into out/main; packaged
  // apps serve code from asar, which external processes cannot execute from).
  private async ensureShimFile(): Promise<string> {
    if (this.shimPath !== undefined) return this.shimPath
    if (this.shimPromise !== undefined) return await this.shimPromise
    this.shimPromise = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bitsentry-host-mcp-'))
      const shimPath = join(directory, HOST_MCP_SHIM_FILE_NAME)
      try {
        await writeFile(shimPath, HOST_MCP_SHIM_SOURCE, { mode: 0o600 })
        this.shimDirectory = directory
        this.shimPath = shimPath
        return shimPath
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    })()
    try {
      return await this.shimPromise
    } finally {
      this.shimPromise = undefined
    }
  }

  async createSession(context: HostToolContext, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<HostMcpEndpoint> {
    await this.start()
    this.pruneExpiredSessions()
    const token = randomBytes(32).toString('base64url')
    const contextId = randomBytes(16).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    this.sessions.set(token, { contextId, context, expiresAt, ttlMs, activeRequests: 0 })
    if (this.baseUrl === undefined) throw new Error('Host MCP endpoint is not running')
    const shimPath = await this.ensureShimFile()
    return {
      url: this.baseUrl,
      token,
      contextId,
      command: process.execPath,
      args: [shimPath],
      env: {
        BITSENTRY_MCP_URL: this.baseUrl,
        BITSENTRY_MCP_TOKEN: token,
        BITSENTRY_MCP_CONTEXT_ID: contextId,
        // Inside Electron, process.execPath is the app binary, not node.
        // Without this flag a spawned shim boots a full Electron instance
        // that never speaks MCP on stdio, and the CLI stalls on startup.
        ELECTRON_RUN_AS_NODE: '1',
      },
      agentSessionId: context.session.id,
      scopeOptions: scopeOptionsFor(context.session),
    }
  }

  closeSession(token: string): void { this.sessions.delete(token) }

  private findSession(receivedToken: string | undefined): HostMcpSession | undefined {
    return [...this.sessions.entries()].find(([token]) => hasMatchingToken(receivedToken, token))?.[1]
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.activeRequests === 0 && session.expiresAt <= now) this.sessions.delete(token)
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.split('?')[0] !== HOST_MCP_PATH) {
      log.warn('[host-mcp] request rejected', {
        agentSessionId: 'unknown',
        reason: 'path_not_found',
        method: request.method,
        path: request.url,
      })
      return sendJson(response, 404, { error: 'Not found' })
    }
    this.pruneExpiredSessions()
    const receivedToken = readBearerToken(request.headers.authorization)
    const session = this.findSession(receivedToken)
    if (session === undefined) {
      log.warn('[host-mcp] request rejected', {
        agentSessionId: 'unknown',
        reason: receivedToken === undefined ? 'missing_bearer_token' : 'invalid_or_expired_token',
        method: request.method,
        path: request.url,
      })
      return sendJson(response, 401, { error: 'Unauthorized' })
    }
    session.expiresAt = Date.now() + session.ttlMs
    session.activeRequests += 1
    try {
      const body = await readMcpRequestBody(request)
      // `toNodeHandler` forwards this private Node request property as trusted
      // authInfo; it never reaches the HTTP wire. The bearer token was checked
      // above, so the MCP factory can use this exact session without re-looking
      // up attacker-controlled request headers.
      const authenticatedRequest = Object.assign(request, {
        auth: {
          token: 'host-mcp-session',
          clientId: session.contextId,
          scopes: [],
          extra: { hostMcpSession: session },
        },
      })
      await this.nodeMcpHandler(authenticatedRequest, response, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid MCP request'
      const statusCode = message === 'MCP request body exceeds the 1 MiB limit' ? 413 : 400
      sendJson(response, statusCode, {
        jsonrpc: '2.0',
        error: { code: -32700, message },
        id: null,
      })
    } finally {
      session.activeRequests -= 1
      this.pruneExpiredSessions()
    }
  }
}
