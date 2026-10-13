import type { ChildProcess } from 'node:child_process'

/**
 * True when `-pid` names the process group of one detached child. Never
 * `-1` (every process the user may signal), `0` (the caller's own group),
 * `1` (init), a missing or non-integer PID, or the caller itself.
 */
function isSignalableProcessGroup(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/**
 * Signals the complete POSIX process group created by a detached child.
 * Windows does not support negative-PID process groups, so it retains Node's
 * direct-child behaviour, as does any PID that is unsafe to negate.
 */
export function terminateLocalProcessTree(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
  signal: NodeJS.Signals,
): void {
  if (process.platform === 'win32' || !isSignalableProcessGroup(child.pid)) {
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
