import type { ChildProcess } from 'child_process'

/**
 * Signals the complete POSIX process group created by a detached child.
 * Windows does not support negative-PID process groups, so it retains Node's
 * direct-child behaviour.
 */
export function terminateLocalProcessTree(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
  signal: NodeJS.Signals,
): void {
  if (process.platform === 'win32' || child.pid === undefined) {
    child.kill(signal)
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group may already have exited, or group signalling may be denied.
    // Retain direct-child termination as the safe fallback.
    child.kill(signal)
  }
}
