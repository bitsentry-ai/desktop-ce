import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { RunbookCliRuntime } from '../cli/runbooks-cli.js'
import { getRuntimeUserDataPath } from './runtime-paths.js'

export const LOCAL_RUNBOOK_EXECUTION_HOST_VERSION = 1 as const

const MAX_PROTOCOL_LINE_BYTES = 1_000_000
const CONNECTION_TIMEOUT_MS = 5_000
const METADATA_FILE_NAME = 'runbook-execution-host.json'
const OWNERSHIP_LOCK_FILE_NAME = 'runbook-execution-host.lock'
const HOST_METADATA_RETRY_DELAY_MS = 50
const HOST_METADATA_RETRY_COUNT = 8

type HostMethod =
  | 'ping'
  | 'listRunbooks'
  | 'deleteRunbook'
  | 'exportRunbooks'
  | 'exportRunbooksToFile'
  | 'importRunbooksFromFile'
  | 'executeRunbook'
  | 'getExecution'
  | 'cancelExecution'
  | 'waitForExecution'

type HostRequest = {
  version: number
  token: string
  id: string
  method: HostMethod
  args: unknown[]
}

type HostResponse = {
  id: string
  result?: unknown
  error?: string
}

type HostConnectionError = Error & {
  readonly requestWasSent?: boolean
}

type HostMetadata = {
  version: number
  endpoint: string
  token: string
}

export type LocalRunbookExecutionHostRuntime = Omit<RunbookCliRuntime, 'destroy'>

export type LocalRunbookExecutionHostOptions = {
  userDataPath: string
} & (
  | { runtime: LocalRunbookExecutionHostRuntime; createRuntime?: never }
  | { runtime?: never; createRuntime(): Promise<LocalRunbookExecutionHostRuntime> }
)

export type LocalRunbookExecutionClientOptions = {
  userDataPath?: string
  createHeadlessRuntime(): Promise<RunbookCliRuntime>
}

export class LocalRunbookExecutionHostVersionError extends Error {}
export class LocalRunbookExecutionHostAlreadyRunningError extends Error {}

function metadataPath(userDataPath: string): string {
  return path.join(userDataPath, METADATA_FILE_NAME)
}

function ownershipLockPath(userDataPath: string): string {
  return path.join(userDataPath, OWNERSHIP_LOCK_FILE_NAME)
}

function endpointForUserDataPath(userDataPath: string): string {
  const digest = createHash('sha256').update(path.resolve(userDataPath)).digest('hex').slice(0, 24)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\bitsentry-ce-runbooks-${digest}`
  }

  // A digest keeps the Unix-domain socket comfortably below platform path limits
  // even when an Electron user-data directory is deeply nested.
  return path.join(os.tmpdir(), `bitsentry-ce-runbooks-${digest}.sock`)
}

function createToken(): string {
  return randomBytes(32).toString('base64url')
}

function isHostMethod(value: unknown): value is HostMethod {
  return value === 'ping' ||
    value === 'listRunbooks' ||
    value === 'deleteRunbook' ||
    value === 'exportRunbooks' ||
    value === 'exportRunbooksToFile' ||
    value === 'importRunbooksFromFile' ||
    value === 'executeRunbook' ||
    value === 'getExecution' ||
    value === 'cancelExecution' ||
    value === 'waitForExecution'
}

function parseRequest(raw: string): HostRequest | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const request = value as Partial<HostRequest>
    if (
      typeof request.version !== 'number' ||
      typeof request.token !== 'string' ||
      typeof request.id !== 'string' ||
      !isHostMethod(request.method) ||
      !Array.isArray(request.args)
    ) {
      return null
    }
    return request as HostRequest
  } catch {
    return null
  }
}

function parseMetadata(raw: string): HostMetadata | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const metadata = value as Partial<HostMetadata>
    if (
      typeof metadata.version !== 'number' ||
      typeof metadata.endpoint !== 'string' ||
      typeof metadata.token !== 'string'
    ) {
      return null
    }
    return metadata as HostMetadata
  } catch {
    return null
  }
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function writeResponse(socket: net.Socket, response: HostResponse): void {
  socket.end(`${JSON.stringify(response)}\n`)
}

async function endpointIsListening(endpoint: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(endpoint)
    const finish = (listening: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => finish(false))
  })
}

async function removeStaleUnixSocket(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return
  if (await endpointIsListening(endpoint)) {
    throw new LocalRunbookExecutionHostAlreadyRunningError(
      'A local runbook execution host is already listening for this user data directory.',
    )
  }
  await rm(endpoint, { force: true })
}

async function readMetadata(userDataPath: string): Promise<HostMetadata | null> {
  try {
    const metadata = parseMetadata(await readFile(metadataPath(userDataPath), 'utf-8'))
    return metadata
  } catch {
    return null
  }
}

async function writeMetadata(userDataPath: string, metadata: HostMetadata): Promise<void> {
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  const target = metadataPath(userDataPath)
  await writeFile(target, JSON.stringify(metadata), { encoding: 'utf-8', mode: 0o600 })
  await chmod(target, 0o600)
}

async function removeMetadataIfOwned(userDataPath: string, token: string): Promise<void> {
  const metadata = await readMetadata(userDataPath)
  if (metadata !== null && tokensMatch(metadata.token, token)) {
    await rm(metadataPath(userDataPath), { force: true })
  }
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isMissingProcess(error)
  }
}

function parseOwnershipLock(raw: string): { pid: number } | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const { pid } = value as { pid?: unknown }
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : null
  } catch {
    return null
  }
}

async function acquireOwnershipLock(userDataPath: string, token: string): Promise<string> {
  const lockPath = ownershipLockPath(userDataPath)
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf-8')
      } finally {
        await handle.close()
      }
      await chmod(lockPath, 0o600)
      return lockPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const current = parseOwnershipLock(await readFile(lockPath, 'utf-8').catch(() => ''))
      if (current === null || isProcessAlive(current.pid)) {
        throw new LocalRunbookExecutionHostAlreadyRunningError(
          'A local runbook execution host is already starting or listening for this user data directory.',
        )
      }

      await rm(lockPath, { force: true })
    }
  }

  throw new LocalRunbookExecutionHostAlreadyRunningError(
    'A local runbook execution host is already starting or listening for this user data directory.',
  )
}

async function removeOwnershipLock(lockPath: string | null, token: string): Promise<void> {
  if (lockPath === null) return
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, 'utf-8'))
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (value as { token?: unknown }).token === token) {
      await rm(lockPath, { force: true })
    }
  } catch {
    // A missing or malformed lock is not owned by this host.
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'Local runbook execution host request failed.'
}

export class LocalRunbookExecutionHost {
  private readonly endpoint: string
  private readonly token = createToken()
  private server: net.Server | null = null
  private ownershipLock: string | null = null
  private runtime: LocalRunbookExecutionHostRuntime | null
  private runtimePromise: Promise<LocalRunbookExecutionHostRuntime> | null = null
  private readonly activeExecutionWaits = new Set<Promise<void>>()

  constructor(private readonly options: LocalRunbookExecutionHostOptions) {
    this.endpoint = endpointForUserDataPath(options.userDataPath)
    this.runtime = options.runtime ?? null
  }

  async start(): Promise<void> {
    if (this.server !== null) return
    this.ownershipLock = await acquireOwnershipLock(this.options.userDataPath, this.token)
    try {
      await removeStaleUnixSocket(this.endpoint)
    } catch (error) {
      await removeOwnershipLock(this.ownershipLock, this.token)
      this.ownershipLock = null
      throw error
    }

    const server = net.createServer((socket) => this.handleConnection(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.endpoint, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        await removeOwnershipLock(this.ownershipLock, this.token)
        this.ownershipLock = null
        throw new LocalRunbookExecutionHostAlreadyRunningError(
          'A local runbook execution host is already listening for this user data directory.',
        )
      }
      await removeOwnershipLock(this.ownershipLock, this.token)
      this.ownershipLock = null
      throw error
    }

    try {
      await writeMetadata(this.options.userDataPath, {
        version: LOCAL_RUNBOOK_EXECUTION_HOST_VERSION,
        endpoint: this.endpoint,
        token: this.token,
      })
      this.server = server
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (process.platform !== 'win32') await rm(this.endpoint, { force: true })
      await removeOwnershipLock(this.ownershipLock, this.token)
      this.ownershipLock = null
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    if (process.platform !== 'win32') await rm(this.endpoint, { force: true })
    await removeMetadataIfOwned(this.options.userDataPath, this.token)
    await removeOwnershipLock(this.ownershipLock, this.token)
    this.ownershipLock = null
  }

  async waitForActiveExecutions(): Promise<void> {
    while (this.activeExecutionWaits.size > 0) {
      await Promise.all(this.activeExecutionWaits)
    }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_PROTOCOL_LINE_BYTES) {
        writeResponse(socket, { id: '', error: 'Runbook host request is too large.' })
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = parseRequest(buffer.slice(0, newline))
      if (request === null) {
        writeResponse(socket, { id: '', error: 'Invalid local runbook host request.' })
        return
      }
      void this.handleRequest(socket, request)
    })
  }

  private async handleRequest(socket: net.Socket, request: HostRequest): Promise<void> {
    if (request.version !== LOCAL_RUNBOOK_EXECUTION_HOST_VERSION) {
      writeResponse(socket, { id: request.id, error: 'Local runbook host protocol version mismatch.' })
      return
    }
    if (!tokensMatch(request.token, this.token)) {
      writeResponse(socket, { id: request.id, error: 'Local runbook host capability token was rejected.' })
      return
    }

    try {
      writeResponse(socket, { id: request.id, result: await this.invoke(request.method, request.args) })
    } catch (error) {
      writeResponse(socket, { id: request.id, error: toErrorMessage(error) })
    }
  }

  private async invoke(method: HostMethod, args: unknown[]): Promise<unknown> {
    if (method === 'ping') return null
    const runtime = await this.getRuntime()
    switch (method) {
      case 'listRunbooks': return runtime.listRunbooks()
      case 'deleteRunbook': return runtime.deleteRunbook(String(args[0] ?? ''))
      case 'exportRunbooks': return runtime.exportRunbooks(args[0] as string[], Boolean(args[1]))
      case 'exportRunbooksToFile': return runtime.exportRunbooksToFile(String(args[0] ?? ''), args[1] as string[], Boolean(args[2]))
      case 'importRunbooksFromFile': return runtime.importRunbooksFromFile(String(args[0] ?? ''), args[1])
      case 'executeRunbook': {
        const execution = await runtime.executeRunbook(
          args[0] as Parameters<RunbookCliRuntime['executeRunbook']>[0],
        )
        this.trackExecution(runtime, execution.executionId)
        return execution
      }
      case 'getExecution': return runtime.getExecution(String(args[0] ?? ''))
      case 'cancelExecution': return runtime.cancelExecution(String(args[0] ?? ''))
      case 'waitForExecution': {
        const options = args[1]
        return runtime.waitForExecution(
          String(args[0] ?? ''),
          options === null
            ? undefined
            : options as Parameters<RunbookCliRuntime['waitForExecution']>[1],
        )
      }
    }
  }

  private async getRuntime(): Promise<LocalRunbookExecutionHostRuntime> {
    if (this.runtime !== null) return this.runtime
    this.runtimePromise ??= this.options.createRuntime!()
    this.runtime = await this.runtimePromise
    return this.runtime
  }

  private trackExecution(
    runtime: LocalRunbookExecutionHostRuntime,
    executionId: string,
  ): void {
    const completion = runtime.waitForExecution(executionId)
      .then(() => {}, () => {})
      .finally(() => this.activeExecutionWaits.delete(completion))
    this.activeExecutionWaits.add(completion)
  }
}

async function requestHost(
  metadata: HostMetadata,
  method: HostMethod,
  args: unknown[],
): Promise<unknown> {
  const id = randomBytes(12).toString('hex')
  return await new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(metadata.endpoint)
    let buffer = ''
    let requestWasSent = false
    const fail = (error: unknown): void => {
      socket.destroy()
      if (error instanceof Error) {
        Object.assign(error as HostConnectionError, { requestWasSent })
        reject(error)
        return
      }
      const wrappedError = new Error(String(error)) as HostConnectionError
      Object.assign(wrappedError, { requestWasSent })
      reject(wrappedError)
    }
    socket.setEncoding('utf-8')
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => fail(new Error('Timed out connecting to the local runbook host.')))
    socket.once('error', fail)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_PROTOCOL_LINE_BYTES) {
        fail(new Error('Local runbook host response is too large.'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as HostResponse
        if (response.id !== id) throw new Error('Local runbook host response id mismatch.')
        if (response.error !== undefined) throw new Error(response.error)
        socket.end()
        resolve(response.result)
      } catch (error) {
        fail(error)
      }
    })
    socket.once('connect', () => {
      // Only bound the handshake. A cold local runtime can legitimately take
      // longer than five seconds to initialise its first request.
      socket.setTimeout(0)
      requestWasSent = true
      socket.write(`${JSON.stringify({
        version: LOCAL_RUNBOOK_EXECUTION_HOST_VERSION,
        token: metadata.token,
        id,
        method,
        args,
      } satisfies HostRequest)}\n`)
    })
  })
}

function isUnavailableConnectionError(error: unknown): boolean {
  return error instanceof Error && (
    'code' in error && (
      (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'EPIPE' ||
      (error as NodeJS.ErrnoException).code === 'ECONNRESET'
    )
  )
}

function requestWasNotSent(error: unknown): boolean {
  return error instanceof Error && (error as HostConnectionError).requestWasSent === false
}

class LocalRunbookExecutionHostClient implements RunbookCliRuntime {
  constructor(
    private readonly metadata: HostMetadata,
    private readonly onDestroy: () => Promise<void>,
  ) {}

  async destroy(): Promise<void> { await this.onDestroy() }
  async listRunbooks() { return await requestHost(this.metadata, 'listRunbooks', []) as Awaited<ReturnType<RunbookCliRuntime['listRunbooks']>> }
  async deleteRunbook(runbookId: string) { return await requestHost(this.metadata, 'deleteRunbook', [runbookId]) as Awaited<ReturnType<RunbookCliRuntime['deleteRunbook']>> }
  async exportRunbooks(runbookIds: string[], includeGlobals?: boolean) { return await requestHost(this.metadata, 'exportRunbooks', [runbookIds, includeGlobals]) as Awaited<ReturnType<RunbookCliRuntime['exportRunbooks']>> }
  async exportRunbooksToFile(filePath: string, runbookIds: string[], includeGlobals?: boolean) { return await requestHost(this.metadata, 'exportRunbooksToFile', [filePath, runbookIds, includeGlobals]) as Awaited<ReturnType<RunbookCliRuntime['exportRunbooksToFile']>> }
  async importRunbooksFromFile(filePath: string, options?: unknown) { return await requestHost(this.metadata, 'importRunbooksFromFile', [filePath, options]) }
  async executeRunbook(input: Parameters<RunbookCliRuntime['executeRunbook']>[0]) { return await requestHost(this.metadata, 'executeRunbook', [input]) as Awaited<ReturnType<RunbookCliRuntime['executeRunbook']>> }
  async getExecution(executionId: string) { return await requestHost(this.metadata, 'getExecution', [executionId]) as Awaited<ReturnType<RunbookCliRuntime['getExecution']>> }
  async cancelExecution(executionId: string) { await requestHost(this.metadata, 'cancelExecution', [executionId]) }
  async waitForExecution(executionId: string, options?: Parameters<RunbookCliRuntime['waitForExecution']>[1]) {
    const args: unknown[] = [executionId]
    if (options !== undefined) args.push(options)
    return await requestHost(this.metadata, 'waitForExecution', args) as Awaited<ReturnType<RunbookCliRuntime['waitForExecution']>>
  }
}

/**
 * A CLI invocation first probes a host, then makes its real request. A host
 * owned by another short-lived CLI invocation can disappear in that gap. Keep
 * the recovery at this boundary so every runbook operation gets the same
 * behaviour on Unix sockets and Windows named pipes.
 */
class RetryingLocalRunbookExecutionClient implements RunbookCliRuntime {
  private destroyed = false

  constructor(
    private client: RunbookCliRuntime,
    private readonly acquireClient: () => Promise<RunbookCliRuntime>,
  ) {}

  async destroy(): Promise<void> {
    this.destroyed = true
    await this.client.destroy()
  }

  async listRunbooks() {
    return await this.request((client) => client.listRunbooks(), true)
  }

  async deleteRunbook(runbookId: string) {
    return await this.request((client) => client.deleteRunbook(runbookId))
  }

  async exportRunbooks(runbookIds: string[], includeGlobals?: boolean) {
    return await this.request((client) => client.exportRunbooks(runbookIds, includeGlobals), true)
  }

  async exportRunbooksToFile(filePath: string, runbookIds: string[], includeGlobals?: boolean) {
    return await this.request((client) => client.exportRunbooksToFile(filePath, runbookIds, includeGlobals))
  }

  async importRunbooksFromFile(filePath: string, options?: unknown) {
    return await this.request((client) => client.importRunbooksFromFile(filePath, options))
  }

  async executeRunbook(input: Parameters<RunbookCliRuntime['executeRunbook']>[0]) {
    return await this.request((client) => client.executeRunbook(input))
  }

  async getExecution(executionId: string) {
    return await this.request((client) => client.getExecution(executionId), true)
  }

  async cancelExecution(executionId: string) {
    await this.request((client) => client.cancelExecution(executionId))
  }

  async waitForExecution(
    executionId: string,
    options?: Parameters<RunbookCliRuntime['waitForExecution']>[1],
  ) {
    return await this.request((client) => client.waitForExecution(executionId, options), true)
  }

  private async request<T>(
    operation: (client: RunbookCliRuntime) => Promise<T>,
    replayAfterSend = false,
  ): Promise<T> {
    const attemptedClient = this.client
    try {
      return await operation(attemptedClient)
    } catch (error) {
      if (
        !isUnavailableConnectionError(error) ||
        this.destroyed ||
        (!replayAfterSend && !requestWasNotSent(error))
      ) throw error

      // A request which never reached the socket is safe to retry. Requests
      // which may have reached the host are retried only for read operations;
      // replaying a write could run a production command twice.
      if (this.client === attemptedClient) {
        this.client = await this.acquireClient()
      }
      return await operation(this.client)
    }
  }
}

async function connectToDesktopHost(userDataPath: string): Promise<LocalRunbookExecutionHostClient | null> {
  const metadata = await readMetadata(userDataPath)
  if (metadata === null) return null
  if (metadata.version !== LOCAL_RUNBOOK_EXECUTION_HOST_VERSION) {
    throw new LocalRunbookExecutionHostVersionError('The running desktop app uses an incompatible local runbook host protocol.')
  }
  try {
    await requestHost(metadata, 'ping', [])
    return new LocalRunbookExecutionHostClient(metadata, async () => {})
  } catch (error) {
    if (!isUnavailableConnectionError(error)) throw error
    await removeMetadataIfOwned(userDataPath, metadata.token)
    return null
  }
}

async function waitForDesktopHost(userDataPath: string): Promise<LocalRunbookExecutionHostClient | null> {
  for (let attempt = 0; attempt < HOST_METADATA_RETRY_COUNT; attempt += 1) {
    const client = await connectToDesktopHost(userDataPath)
    if (client !== null) return client
    await new Promise((resolve) => setTimeout(resolve, HOST_METADATA_RETRY_DELAY_MS))
  }
  return null
}

async function createLocalRunbookExecutionClientOnce(
  options: LocalRunbookExecutionClientOptions,
): Promise<RunbookCliRuntime> {
  const userDataPath = path.resolve(options.userDataPath ?? getRuntimeUserDataPath())
  for (let attempt = 0; attempt < HOST_METADATA_RETRY_COUNT; attempt += 1) {
    const desktopClient = await connectToDesktopHost(userDataPath)
    if (desktopClient !== null) return desktopClient

    let headlessRuntime: RunbookCliRuntime | null = null
    const destroyHeadlessRuntime = async (): Promise<void> => {
      const runtime = headlessRuntime
      if (runtime !== null) await runtime.destroy()
    }
    const host = new LocalRunbookExecutionHost({
      userDataPath,
      async createRuntime() {
        headlessRuntime ??= await options.createHeadlessRuntime()
        return headlessRuntime
      },
    })
    try {
      await host.start()
      const metadata = await readMetadata(userDataPath)
      if (metadata === null) throw new Error('Headless runbook host did not publish its capability metadata.')
      return new LocalRunbookExecutionHostClient(metadata, async () => {
        await host.waitForActiveExecutions()
        await host.close()
        await destroyHeadlessRuntime()
      })
    } catch (error) {
      await host.close().catch(() => {})
      await destroyHeadlessRuntime().catch(() => {})
      if (error instanceof LocalRunbookExecutionHostAlreadyRunningError) {
        const desktopClientAfterRace = await waitForDesktopHost(userDataPath)
        if (desktopClientAfterRace !== null) return desktopClientAfterRace
        if (attempt + 1 < HOST_METADATA_RETRY_COUNT) continue
      }
      throw error
    }
  }

  throw new LocalRunbookExecutionHostAlreadyRunningError(
    'A local runbook execution host did not become available after waiting for its owner to exit.',
  )
}

export async function createLocalRunbookExecutionClient(
  options: LocalRunbookExecutionClientOptions,
): Promise<RunbookCliRuntime> {
  const initialClient = await createLocalRunbookExecutionClientOnce(options)
  return new RetryingLocalRunbookExecutionClient(
    initialClient,
    async () => await createLocalRunbookExecutionClientOnce(options),
  )
}
