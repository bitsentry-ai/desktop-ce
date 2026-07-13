import { spawn, spawnSync } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import readline from 'readline'
import { EventEmitter } from 'events'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env'
import { codingAgentsLogger as log } from './logger'

const REQUEST_TIMEOUT_MS = 300_000
const MAX_STDERR_BUFFER = 5_000

function resolveRequestTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : REQUEST_TIMEOUT_MS
}

export type CursorJsonRpcId = string | number | null

interface PendingRequest {
  method: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: CursorJsonRpcId
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: CursorJsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

interface CursorMessageMetadata {
  hasId: boolean
  id: CursorJsonRpcId | undefined
  hasResult: boolean
  hasError: boolean
  method: string | undefined
}
type CursorMessageWithId = CursorMessageMetadata & { id: CursorJsonRpcId }
type CursorMessageWithMethod = CursorMessageMetadata & { method: string }

function getJsonRpcMethod(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }

  return value
}

function getCursorMessageMetadata(parsed: Record<string, unknown>): CursorMessageMetadata {
  return {
    hasId: Object.prototype.hasOwnProperty.call(parsed, 'id'),
    id: getJsonRpcId(parsed.id),
    hasResult: Object.prototype.hasOwnProperty.call(parsed, 'result'),
    hasError: Object.prototype.hasOwnProperty.call(parsed, 'error'),
    method: getJsonRpcMethod(parsed.method),
  }
}

function isRpcResponse(message: CursorMessageMetadata): message is CursorMessageWithId {
  return message.hasId &&
    message.id !== undefined &&
    (message.hasResult || message.hasError)
}

function isServerRequest(
  message: CursorMessageMetadata,
): message is CursorMessageWithId & CursorMessageWithMethod {
  return message.method !== undefined &&
    message.hasId &&
    message.id !== undefined &&
    !message.hasResult &&
    !message.hasError
}

function isNotification(message: CursorMessageMetadata): message is CursorMessageWithMethod {
  return message.method !== undefined &&
    !message.hasId &&
    !message.hasResult &&
    !message.hasError
}

function killCursorChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      // Fall through to direct kill.
    }
  }
  child.kill()
}

function appendStderrTail(message: string, stderrTail: string): string {
  const trimmedTail = stderrTail.trim()
  if (trimmedTail === '') return message
  return `${message}\nCursor stderr:\n${trimmedTail}`
}

function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch (error) {
    log.warn('[cursor-acp] Invalid JSON from stdout:', line.slice(0, 200))
    return { parseError: String(error), raw: line.slice(0, 500) }
  }
}

function getJsonRpcId(rawId: unknown): CursorJsonRpcId | undefined {
  if (rawId === null || typeof rawId === 'number' || typeof rawId === 'string') {
    return rawId
  }

  return undefined
}

function getRpcErrorMessage(error: unknown, fallback: string): string {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return fallback
  }

  const { message } = error as { message?: unknown }
  if (typeof message === 'string') {
    return message
  }

  return fallback
}

export class CursorAcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private output: readline.Interface | null = null
  private pending = new Map<CursorJsonRpcId, PendingRequest>()
  private nextId = 1
  private stderrBuffer = ''
  private closed = false
  private readonly requestTimeoutMs: number

  constructor(
    private readonly binaryPath: string,
    private readonly cwd: string,
    options: { requestTimeoutMs?: number } = {},
  ) {
    super()
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs)
  }

  start(_model?: string): Promise<void> {
    if (this.child !== null && !this.closed) {
      return Promise.resolve()
    }

    this.closed = false
    const spawnArgs = ['acp']

    this.child = spawn(this.binaryPath, spawnArgs, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: createCodingAgentsProcessEnv(process.env),
    })

    this.output = readline.createInterface({ input: this.child.stdout })

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrBuffer = (this.stderrBuffer + text).slice(-MAX_STDERR_BUFFER)
    })

    this.output.on('line', (line) => {
      this.handleOutputLine(line)
    })

    this.child.once('error', (err) => {
      log.error('[cursor-acp] Process error:', err)
      this.cleanup('process error')
    })

    this.child.once('exit', (code, signal) => {
      if (!this.closed) {
        log.warn(
          `[cursor-acp] Process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        )
      }
    })

    this.child.once('close', () => {
      this.cleanup('process exited')
    })

    return Promise.resolve()
  }

  private handleOutputLine(line: string): void {
    if (line.trim() === '') return

    const parsed = parseJsonObjectLine(line)
    if (parsed === null) {
      return
    }

    if ('parseError' in parsed) {
      this.emit('parseError', { error: parsed.parseError, raw: parsed.raw })
      return
    }

    const message = getCursorMessageMetadata(parsed)
    if (isRpcResponse(message)) {
      this.handleRpcResponse(message.id, message.hasError, parsed)
      return
    }

    if (isServerRequest(message)) {
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
        params: parsed.params,
      })
      return
    }

    if (isNotification(message)) {
      this.emit('notification', { method: message.method, params: parsed.params })
    }
  }

  private handleRpcResponse(
    id: CursorJsonRpcId,
    hasError: boolean,
    parsed: Record<string, unknown>,
  ): void {
    const pending = this.pending.get(id)
    if (pending === undefined) {
      return
    }

    this.pending.delete(id)
    clearTimeout(pending.timeout)

    if (hasError) {
      pending.reject(new Error(getRpcErrorMessage(
        parsed.error,
        `Cursor ACP RPC error for ${pending.method}`,
      )))
      return
    }

    pending.resolve(parsed.result)
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const child = this.child
    if (this.closed || child === null || !child.stdin.writable) {
      throw new Error(`Cannot send ${method}: Cursor ACP client is not running`)
    }

    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(
          `Cursor ACP RPC ${method} timed out after ${String(this.requestTimeoutMs / 1000)}s`,
        ))
      }, this.requestTimeoutMs)

      this.pending.set(id, { method, timeout, resolve, reject })
      this.writeMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  sendNotification(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', method, params })
  }

  respondToServerRequest(requestId: CursorJsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id: requestId, result })
  }

  respondToServerRequestError(requestId: CursorJsonRpcId, message: string, code = -32601): void {
    this.writeMessage({ jsonrpc: '2.0', id: requestId, error: { code, message } })
  }

  cancelSession(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId })
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const child = this.child
    if (child !== null && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    }
  }

  private cleanup(reason: string): void {
    if (this.closed) return
    this.closed = true

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(appendStderrTail(
        `Cursor ACP client ${reason}: pending ${pending.method} cancelled`,
        this.stderrBuffer,
      )))
      this.pending.delete(id)
    }

    if (this.output !== null) {
      this.output.removeAllListeners()
      this.output.close()
      this.output = null
    }

    if (this.child !== null && !this.child.killed) {
      killCursorChildProcess(this.child)
    }
    this.child = null

    this.emit('closed', reason)
  }

  getStderrTail(): string {
    return this.stderrBuffer
  }

  kill(): void {
    this.cleanup('killed by caller')
  }

  get isRunning(): boolean {
    return !this.closed && this.child !== null
  }
}
