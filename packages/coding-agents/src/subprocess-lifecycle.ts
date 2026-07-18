import { spawnSync } from 'child_process'
import type { ChildProcess } from 'child_process'

export const DEFAULT_SUBPROCESS_TERMINATION_GRACE_MS = 2_000
export const DEFAULT_SUBPROCESS_FORCE_KILL_WAIT_MS = 2_000

export type SubprocessTerminationOutcome =
  | 'already-exited'
  | 'gracefully-terminated'
  | 'forcefully-terminated'
  | 'termination-unconfirmed'

export interface SubprocessTerminationResult {
  outcome: SubprocessTerminationOutcome
  pid: number | undefined
  elapsedMs: number
}

export interface SubprocessTerminationOptions {
  graceMs?: number
  forceKillWaitMs?: number
}

function resolvePositiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
}

function waitForProcessExit(child: ChildProcess): { promise: Promise<void>; dispose: () => void } {
  let onExit: (() => void) | undefined
  let onClose: (() => void) | undefined
  let onError: (() => void) | undefined

  const promise = new Promise<void>((resolve) => {
    const settle = (): void => {
      dispose()
      resolve()
    }

    onExit = settle
    onClose = settle
    onError = settle
    child.once('exit', onExit)
    child.once('close', onClose)
    child.once('error', onError)
  })

  const dispose = (): void => {
    if (onExit !== undefined) child.removeListener('exit', onExit)
    if (onClose !== undefined) child.removeListener('close', onClose)
    if (onError !== undefined) child.removeListener('error', onError)
    onExit = undefined
    onClose = undefined
    onError = undefined
  }

  return { promise, dispose }
}

async function waitWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => { resolve(false) }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function requestGracefulTermination(child: ChildProcess): void {
  try {
    child.kill('SIGTERM')
  } catch {
    // The exit waiter observes spawn/IPC failures and keeps cleanup deterministic.
  }
}

function forceKillProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      // Fall through to the direct process kill.
    }
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // The result records that termination could not be confirmed.
  }
}

/**
 * Terminates a child process without leaking exit listeners or escalation timers.
 *
 * A POSIX process first receives SIGTERM. If it does not exit within the grace
 * period we kill its complete Windows process tree, or use SIGKILL elsewhere.
 * The result is intentionally value-based: cleanup callers can safely start it
 * from an event handler without creating an unhandled rejection.
 */
export async function terminateSubprocess(
  child: ChildProcess,
  options: SubprocessTerminationOptions = {},
): Promise<SubprocessTerminationResult> {
  const startedAt = Date.now()
  const pid = child.pid
  const result = (outcome: SubprocessTerminationOutcome): SubprocessTerminationResult => ({
    outcome,
    pid,
    elapsedMs: Date.now() - startedAt,
  })

  if (hasExited(child)) return result('already-exited')

  const exit = waitForProcessExit(child)
  try {
    requestGracefulTermination(child)
    const graceMs = resolvePositiveTimeout(options.graceMs, DEFAULT_SUBPROCESS_TERMINATION_GRACE_MS)
    if (await waitWithin(exit.promise, graceMs)) return result('gracefully-terminated')

    forceKillProcessTree(child)
    const forceKillWaitMs = resolvePositiveTimeout(
      options.forceKillWaitMs,
      DEFAULT_SUBPROCESS_FORCE_KILL_WAIT_MS,
    )
    if (await waitWithin(exit.promise, forceKillWaitMs)) return result('forcefully-terminated')
    return result('termination-unconfirmed')
  } finally {
    exit.dispose()
  }
}

/** Links a parent operation abort to process cleanup and returns a listener disposer. */
export function linkSubprocessAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  options?: SubprocessTerminationOptions,
): () => void {
  if (signal === undefined) return () => undefined

  const abort = (): void => {
    void terminateSubprocess(child, options)
  }

  if (signal.aborted) {
    abort()
    return () => undefined
  }

  signal.addEventListener('abort', abort, { once: true })
  return () => { signal.removeEventListener('abort', abort) }
}
