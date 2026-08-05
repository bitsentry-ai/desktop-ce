import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import readline from 'readline'
import { EventEmitter } from 'events'
import { codingAgentsLogger as log } from './logger.js'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env.js'
import { terminateSubprocess } from './subprocess-lifecycle.js'

const REQUEST_TIMEOUT_MS = 300_000
const MAX_STDERR_BUFFER = 5_000

function resolveRequestTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : REQUEST_TIMEOUT_MS
}

/** JSON-RPC request id — Codex protocol allows string or number per the
 *  generated schema (ServerRequest__RequestId = string | number). */
export type JsonRpcId = string | number

interface PendingRequest {
  method: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface JsonRpcRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface CodexAppServerClientOptions {
  requestTimeoutMs?: number
  home?: string
}

interface JsonRpcNotification {
  method: string
  params?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return Object.fromEntries(Object.entries(value))
}

function readJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    return value
  }
  return undefined
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  return undefined
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private output: readline.Interface | null = null
  private pending = new Map<JsonRpcId, PendingRequest>()
  private nextId = 1
  private stderrBuffer = ''
  private closed = false
  private termination: Promise<void> | null = null

  constructor(
    private readonly binaryPath: string,
    private readonly cwd: string,
    private readonly extraArgs: string[] = [],
    options: CodexAppServerClientOptions = {},
  ) {
    super()
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs)
    this.home = options.home
  }

  private readonly requestTimeoutMs: number
  private readonly home: string | undefined

  async start(): Promise<void> {
    const args = [...this.extraArgs, 'app-server']
    this.child = spawn(this.binaryPath, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: {
        ...createCodingAgentsProcessEnv(process.env),
        ...(this.home === undefined ? {} : { HOME: this.home }),
      },
    })

    this.output = readline.createInterface({ input: this.child.stdout })

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrBuffer = (this.stderrBuffer + text).slice(-MAX_STDERR_BUFFER)
    })

    this.output.on('line', (line) => this.handleOutputLine(line))

    this.child.once('error', (err) => {
      log.error('[codex-app-server] Process error:', err)
      this.cleanup('process error')
    })

    this.child.once('exit', (code, signal) => {
      if (!this.closed) {
        log.warn(
          `[codex-app-server] Process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        )
      }
      this.cleanup('process exited')
    })

    await this.sendRequestWithTimeout('initialize', {
      clientInfo: {
        name: 'bitsentry_desktop',
        title: 'BitSentry SuperTerminal',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    }, REQUEST_TIMEOUT_MS)

    this.writeMessage({ method: 'initialized' })
  }

  private parseOutputLine(line: string): Record<string, unknown> | undefined {
    if (line.trim().length === 0) return undefined
    try {
      const parsed = asRecord(JSON.parse(line))
      if (parsed !== undefined) return parsed
      this.emit('parseError', { error: 'Expected JSON object', raw: line.slice(0, 500) })
      log.warn('[codex-app-server] Non-object JSON from stdout:', line.slice(0, 200))
    } catch (error) {
      log.warn('[codex-app-server] Invalid JSON from stdout:', line.slice(0, 200))
      this.emit('parseError', { error: String(error), raw: line.slice(0, 500) })
    }
    return undefined
  }

  private handleResponse(parsed: Record<string, unknown>, id: JsonRpcId, hasError: boolean): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    if (!hasError) {
      pending.resolve(parsed.result)
      return
    }
    const error = asRecord(parsed.error)
    const message = error === undefined
      ? `Codex RPC error for ${pending.method}`
      : readStringField(error, 'message') ?? `Codex RPC error for ${pending.method}`
    pending.reject(new Error(message))
  }

  private handleOutputLine(line: string): void {
    const parsed = this.parseOutputLine(line)
    if (parsed === undefined) return
    const id = readJsonRpcId(parsed.id)
    const hasResult = 'result' in parsed
    const hasError = 'error' in parsed
    const method = readStringField(parsed, 'method')
    if (id !== undefined && (hasResult || hasError)) {
      this.handleResponse(parsed, id, hasError)
      return
    }
    if (method === undefined || hasResult || hasError) return
    if (id !== undefined) {
      this.emit('serverRequest', { id, method, params: parsed.params })
      return
    }
    this.emit('notification', { method, params: parsed.params })
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    return this.sendRequestWithTimeout(method, params, this.requestTimeoutMs)
  }

  private async sendRequestWithTimeout(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed || this.child?.stdin.writable !== true) {
      throw new Error(`Cannot send ${method}: Codex app-server is not running`)
    }

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex RPC ${method} timed out after ${String(timeoutMs / 1000)}s`))
      }, timeoutMs)

      this.pending.set(id, { method, timeout, resolve, reject })
      const request: JsonRpcRequest = { id, method, params }
      this.writeMessage(request)
    })
  }

  respondToServerRequest(requestId: JsonRpcId, result: unknown): void {
    this.writeMessage({ id: requestId, result })
  }

  respondToServerRequestError(requestId: JsonRpcId, message: string): void {
    this.writeMessage({ id: requestId, error: { code: -1, message } })
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcNotification | Record<string, unknown>): void {
    if (this.child?.stdin.writable === true) {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`)
    }
  }

  private cleanup(reason: string): Promise<void> {
    if (this.closed) return this.termination ?? Promise.resolve()
    this.closed = true

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex app-server ${reason}: pending ${pending.method} cancelled`))
      this.pending.delete(id)
    }

    if (this.output !== null) {
      this.output.removeAllListeners()
      this.output.close()
      this.output = null
    }

    const child = this.child
    this.child = null

    this.termination = child === null
      ? Promise.resolve()
      : terminateSubprocess(child).then((result) => {
        if (result.outcome === 'termination-unconfirmed') {
          log.warn(`[codex-app-server] Unable to confirm process termination (pid=${String(result.pid)})`)
        }
      })

    this.emit('closed', reason)
    return this.termination
  }

  getStderrTail(): string {
    return this.stderrBuffer
  }

  kill(): Promise<void> {
    return this.cleanup('killed by caller')
  }

  get isRunning(): boolean {
    return !this.closed && this.child !== null
  }
}
