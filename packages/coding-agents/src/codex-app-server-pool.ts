import { CodexAppServerClient } from './codex-app-server-client.js'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env.js'
import {
  createIsolatedCodexIncidentHome,
  type IsolatedCodexIncidentHome,
} from './codex-incident-home.js'

let idleTtlMs = 30_000

export interface CodexAppServerSpec {
  binaryPath: string
  cwd: string
  args: string[] | undefined
  /** Incident session that owns an isolated HOME; undefined runs with the real HOME. */
  isolatedSessionId: string | undefined
}

export interface CodexAppServerLease {
  ready: Promise<CodexAppServerClient>
  /** Keeps new turns off this process; it closes once no turn holds it. */
  retire(): void
  /** Retires the process and kills it now unless another turn is using it. */
  abort(): void
  release(): Promise<void>
}

interface PooledAppServer {
  key: string
  borrowers: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
  ready: Promise<CodexAppServerClient>
  close(): Promise<void>
}

const available = new Map<string, PooledAppServer>()
const live = new Set<PooledAppServer>()

function retire(entry: PooledAppServer): void {
  if (available.get(entry.key) === entry) available.delete(entry.key)
  if (entry.borrowers === 0) void entry.close()
}

function openAppServer(key: string, spec: CodexAppServerSpec): PooledAppServer {
  let home: IsolatedCodexIncidentHome | undefined
  let closing: Promise<void> | undefined
  const opened = (async () => {
    home = spec.isolatedSessionId === undefined ? undefined : await createIsolatedCodexIncidentHome()
    return new CodexAppServerClient(spec.binaryPath, spec.cwd, spec.args, { home: home?.home })
  })()
  const entry: PooledAppServer = {
    key,
    borrowers: 0,
    idleTimer: undefined,
    ready: opened.then(async (client) => {
      if (closing !== undefined) throw new Error('Codex app-server closed before it started')
      client.once('closed', () => retire(entry))
      await client.start()
      return client
    }),
    close: () => {
      closing ??= (async () => {
        clearTimeout(entry.idleTimer)
        if (available.get(key) === entry) available.delete(key)
        live.delete(entry)
        const client = await opened.catch(() => undefined)
        await client?.kill()
        await home?.dispose()
      })()
      return closing
    },
  }
  entry.ready.catch(() => retire(entry))
  available.set(key, entry)
  live.add(entry)
  return entry
}

function keyFor(spec: CodexAppServerSpec): string {
  return JSON.stringify([
    spec.binaryPath,
    spec.args ?? [],
    spec.cwd,
    spec.isolatedSessionId ?? null,
    createCodingAgentsProcessEnv(process.env),
  ])
}

/**
 * Lends a running `codex app-server` per turn. Processes are keyed by
 * everything that shapes their launch, so different configs never share one,
 * and an idle process closes after a short TTL.
 */
export function borrowCodexAppServer(spec: CodexAppServerSpec): CodexAppServerLease {
  const key = keyFor(spec)
  const entry = available.get(key) ?? openAppServer(key, spec)
  entry.borrowers += 1
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
  let released = false

  return {
    ready: entry.ready,
    retire: () => retire(entry),
    abort: () => {
      retire(entry)
      if (entry.borrowers <= 1) void entry.close()
    },
    release: () => {
      if (released) return Promise.resolve()
      released = true
      entry.borrowers -= 1
      if (entry.borrowers > 0) return Promise.resolve()
      if (available.get(key) !== entry) return entry.close()
      entry.idleTimer = setTimeout(() => void entry.close(), idleTtlMs)
      entry.idleTimer.unref()
      return Promise.resolve()
    },
  }
}

export async function closeCodexAppServers(): Promise<void> {
  await Promise.all([...live].map((entry) => entry.close()))
}

export function setCodexAppServerIdleTtlForTesting(ms: number): void {
  idleTtlMs = ms
}
