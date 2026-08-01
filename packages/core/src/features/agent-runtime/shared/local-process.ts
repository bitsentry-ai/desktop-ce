import type { ChildProcess } from 'child_process'

/**
 * Sends a signal to the complete POSIX process group created by a detached
 * child. On Windows negative PIDs do not address process groups, so preserve
 * Node's existing direct-child behaviour there.
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
    // The group may have already exited, or the runtime may not permit group
    // signalling. Preserve the direct-child fallback in either case.
    child.kill(signal)
  }
}
