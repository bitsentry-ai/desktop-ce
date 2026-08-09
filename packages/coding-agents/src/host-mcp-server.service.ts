import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_MCP_SHIM_FILE_NAME, HOST_MCP_SHIM_SOURCE } from './host-mcp-shim-source.js'
import { createHostToolCore } from './host-tool-core.js'
import { codingAgentsLogger as log } from './logger.js'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  type HostToolContext,
  type HostToolEvent,
} from '@bitsentry-ce/core/features/agent-runtime'

const HOST_MCP_PATH = '/mcp'
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000
export const HOST_MCP_SERVER_NAME = 'bitsentry'

export interface HostMcpEndpoint {
  url: string
  token: string
  expiresAt: number
  command: string
  args: string[]
  env: Record<string, string>
  agentSessionId: string
  hasRunbookProposal?: boolean
  hasRunbookParameters?: boolean
  hasMultipleRunbooksInPlay?: boolean
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

function readBearerToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
}

function hasMatchingToken(receivedToken: string | undefined, expectedToken: string): boolean {
  if (receivedToken === undefined) return false
  const received = Buffer.from(receivedToken)
  const expected = Buffer.from(expectedToken)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMcpRequestArguments(payload: unknown): unknown {
  const normalizeMessage = (message: unknown): unknown => {
    if (!isRecord(message) || message.method !== 'tools/call' || !isRecord(message.params)) {
      return message
    }
    if (message.params.arguments !== null && message.params.arguments !== undefined) {
      return message
    }
    return { ...message, params: { ...message.params, arguments: {} } }
  }
  return Array.isArray(payload) ? payload.map(normalizeMessage) : normalizeMessage(payload)
}

async function readMcpRequestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body.length === 0 ? undefined : normalizeMcpRequestArguments(JSON.parse(body))
}

function createSessionServer(session: HostMcpSession): McpServer {
  const server = new McpServer({ name: 'bitsentry-host-tools', version: '1.0.0' })
  const hostTools = createHostToolCore(session.context, (event) => session.ledger.push(event))
  for (const hostTool of hostTools.tools) {
    server.registerTool(hostTool.name, {
      description: hostTool.description,
      inputSchema: z.union([hostTool.argsSchema, z.null()]),
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
  private sessionSweepTimer: ReturnType<typeof setInterval> | undefined
  private readonly mcpHandler = createMcpHandler(({ requestInfo }) => {
    const session = this.findSession(readBearerToken(requestInfo?.headers.get('authorization') ?? undefined))
    if (session === undefined) throw new Error('Authenticated host MCP request lost its scoped context')
    return createSessionServer(session)
  }, {
    legacy: 'reject',
    onerror: (error) => log.warn('[host-mcp] stateless request failed', { reason: error.message }),
  })
  private readonly nodeMcpHandler = toNodeHandler(this.mcpHandler, {
    onerror: (error) => log.warn('[host-mcp] node transport failed', { reason: error.message }),
  })

  constructor(private readonly sessionSweepIntervalMs = DEFAULT_SESSION_SWEEP_INTERVAL_MS) {}

  async start(): Promise<void> {
    await this.ensureShimFile()
    if (this.httpServer !== undefined) return
    this.httpServer = createServer((request, response) => { void this.handleRequest(request, response) })
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject)
      this.httpServer?.listen(0, '127.0.0.1', () => {
        this.httpServer?.off('error', reject)
        resolve()
      })
    })
    this.sessionSweepTimer = setInterval(() => this.pruneExpiredSessions(), this.sessionSweepIntervalMs)
    this.sessionSweepTimer.unref?.()
    const address = this.httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('Host MCP endpoint did not bind to a TCP port')
    this.baseUrl = `http://127.0.0.1:${String(address.port)}${HOST_MCP_PATH}`
  }

  async stop(): Promise<void> {
    this.sessions.clear()
    if (this.sessionSweepTimer !== undefined) clearInterval(this.sessionSweepTimer)
    this.sessionSweepTimer = undefined
    const server = this.httpServer
    this.httpServer = undefined
    this.baseUrl = undefined
    const shimDirectory = this.shimDirectory
    this.shimDirectory = undefined
    this.shimPath = undefined
    if (shimDirectory !== undefined) {
      await rm(shimDirectory, { recursive: true, force: true })
    }
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }

  // CLIs spawn the shim themselves, so it must exist as a plain file outside
  // the app bundle (electron-vite folds this package into out/main; packaged
  // apps serve code from asar, which external processes cannot execute from).
  private async ensureShimFile(): Promise<string> {
    if (this.shimPath !== undefined) return this.shimPath
    const directory = await mkdtemp(join(tmpdir(), 'bitsentry-host-mcp-'))
    const shimPath = join(directory, HOST_MCP_SHIM_FILE_NAME)
    await writeFile(shimPath, HOST_MCP_SHIM_SOURCE, { mode: 0o600 })
    this.shimDirectory = directory
    this.shimPath = shimPath
    return shimPath
  }

  async createSession(context: HostToolContext, ttlMs = DEFAULT_SESSION_TTL_MS): Promise<HostMcpEndpoint> {
    await this.start()
    this.pruneExpiredSessions()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    this.sessions.set(token, { context, expiresAt, ledger: [] })
    if (this.baseUrl === undefined) throw new Error('Host MCP endpoint is not running')
    const shimPath = await this.ensureShimFile()
    return {
      url: this.baseUrl,
      token,
      expiresAt,
      command: process.execPath,
      args: [shimPath],
      env: {
        BITSENTRY_MCP_URL: this.baseUrl,
        BITSENTRY_MCP_TOKEN: token,
        // Inside Electron, process.execPath is the app binary, not node.
        // Without this flag a spawned shim boots a full Electron instance
        // that never speaks MCP on stdio, and the CLI stalls on startup.
        ELECTRON_RUN_AS_NODE: '1',
      },
      agentSessionId: context.session.id,
      hasRunbookProposal: (context.session.runbookAuthoringProposals?.length ?? 0) > 0,
      hasRunbookParameters: context.session.hasRunbookParameters === true,
      hasMultipleRunbooksInPlay: context.session.hasMultipleRunbooksInPlay === true,
    }
  }

  closeSession(token: string): void { this.sessions.delete(token) }

  getLedger(token: string): readonly HostToolEvent[] { return this.sessions.get(token)?.ledger ?? [] }

  private findSession(receivedToken: string | undefined): HostMcpSession | undefined {
    return [...this.sessions.entries()].find(([token]) => hasMatchingToken(receivedToken, token))?.[1]
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token)
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
    await this.nodeMcpHandler(request, response, await readMcpRequestBody(request))
  }
}
