import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { Effect } from 'effect'
import type { Scope } from 'effect'

const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 2_000
const DEFAULT_PROCESS_FORCE_KILL_WAIT_MS = 2_000

type ProcessTerminationOutcome =
  | 'already-exited'
  | 'gracefully-terminated'
  | 'forcefully-terminated'
  | 'termination-unconfirmed'

export interface ProcessTerminationResult {
  outcome: ProcessTerminationOutcome
  pid: number | undefined
  elapsedMs: number
}

export interface ProcessTerminationOptions {
  graceMs?: number
  forceKillWaitMs?: number
}

type TerminableProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill' | 'once' | 'removeListener'>

function hasExited(child: TerminableProcess): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

function resolveDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

const GROUP_POLL_INTERVAL_MS = 50

/**
 * True when `-pid` names the process group of one detached child. Never
 * `-1` (every process the user may signal), `0` (the caller's own group),
 * `1` (init), a missing or non-integer PID, or the caller itself.
 */
function isSignalableProcessGroup(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/**
 * True while any member of the POSIX process group led by `pid` (a child
 * spawned with `detached: true`) is alive. ESRCH, EPERM and an unsafe PID all count
 * as gone, in which case the caller falls back to the direct child.
 */
function isProcessGroupAlive(pid: number): boolean {
  if (!isSignalableProcessGroup(pid)) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!isSignalableProcessGroup(pid)) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group emptied in the meantime; the liveness poll confirms it.
  }
}

function signalChild(child: TerminableProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The exit waiter decides whether termination was confirmed.
  }
}

async function waitUntil(isGone: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!isGone()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS))
  }
  return true
}

async function killWindowsTree(child: TerminableProcess, timeoutMs: number): Promise<void> {
  const killed = await new Promise<boolean>((resolve) => {
    try {
      const taskkill = spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        // Do not leave a hung taskkill.exe behind.
        taskkill.removeAllListeners()
        try { taskkill.kill() } catch { /* already gone */ }
        resolve(false)
      }, timeoutMs)
      taskkill.once('error', () => { clearTimeout(timer); resolve(false) })
      taskkill.once('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
    } catch {
      resolve(false)
    }
  })
  if (!killed) signalChild(child, 'SIGKILL')
}

/** Resolves true once the child exits, or false after `timeoutMs`. */
export function waitForProcessExit(child: TerminableProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const settle = (exited: boolean): void => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolve(exited)
    }
    const onExit = (): void => { settle(true) }
    const timer = setTimeout(() => { settle(hasExited(child)) }, timeoutMs)
    child.once('exit', onExit)
    child.once('close', onExit)
    child.once('error', onExit)
  })
}

/**
 * Terminates a child and its process tree, resolving only once the tree has
 * exited or termination could not be confirmed. Never rejects.
 *
 * POSIX: the process group led by the child is the unit, even when the leader
 * has already exited (the kernel does not reuse a PID that is still a live
 * PGID). SIGTERM the group, poll until it is empty for `graceMs`, then SIGKILL
 * and poll for `forceKillWaitMs`. Without a group, the direct child is used.
 * Windows: `taskkill /T /F` on the tree, then wait.
 */
export async function terminateProcessTree(
  child: TerminableProcess,
  options: ProcessTerminationOptions = {},
): Promise<ProcessTerminationResult> {
  const startedAt = Date.now()
  const pid = child.pid
  const result = (outcome: ProcessTerminationOutcome): ProcessTerminationResult => ({
    outcome,
    pid,
    elapsedMs: Date.now() - startedAt,
  })
  if (pid === undefined) return result('already-exited')

  const forceKillWaitMs = resolveDelay(options.forceKillWaitMs, DEFAULT_PROCESS_FORCE_KILL_WAIT_MS)
  if (process.platform === 'win32') {
    if (hasExited(child)) return result('already-exited')
    await killWindowsTree(child, forceKillWaitMs)
    return result(await waitForProcessExit(child, forceKillWaitMs) ? 'forcefully-terminated' : 'termination-unconfirmed')
  }

  const graceMs = resolveDelay(options.graceMs, DEFAULT_PROCESS_TERMINATION_GRACE_MS)
  return result(await terminatePosixTree(child, pid, graceMs, forceKillWaitMs))
}

async function terminatePosixTree(
  child: TerminableProcess,
  pid: number,
  graceMs: number,
  forceKillWaitMs: number,
): Promise<ProcessTerminationOutcome> {
  let exitSeen = false
  const onExit = (): void => { exitSeen = true }
  child.once('exit', onExit)
  child.once('close', onExit)
  try {
    // Without a live group (not detached, or EPERM) fall back to the direct child.
    const target = isProcessGroupAlive(pid)
      ? { isGone: () => !isProcessGroupAlive(pid), signal: (name: NodeJS.Signals) => { signalProcessGroup(pid, name) } }
      : { isGone: () => exitSeen || hasExited(child), signal: (name: NodeJS.Signals) => { signalChild(child, name) } }
    if (target.isGone()) return 'already-exited'

    target.signal('SIGTERM')
    if (await waitUntil(target.isGone, graceMs)) return 'gracefully-terminated'
    target.signal('SIGKILL')
    return await waitUntil(target.isGone, forceKillWaitMs) ? 'forcefully-terminated' : 'termination-unconfirmed'
  } finally {
    child.removeListener('exit', onExit)
    child.removeListener('close', onExit)
  }
}

/**
 * Scoped child process: closing the scope (success, failure, timeout or
 * interruption) terminates the process tree and waits for it to exit.
 */
export function acquireChildProcess<C extends ChildProcess>(
  spawnChild: () => C,
  options?: ProcessTerminationOptions,
): Effect.Effect<C, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: spawnChild,
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    (child) => Effect.promise(() => terminateProcessTree(child, options)),
  )
}
