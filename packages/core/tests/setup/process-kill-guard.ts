import { afterEach } from 'vitest'

/**
 * Test safety net: a fake child with PID 1 once reached process.kill(-1,
 * 'SIGTERM'), which signals every process the user owns. Wrap the real
 * process.kill so that broadcast targets throw instead. Tests that mock
 * process.kill with vi.spyOn replace this wrapper and keep working.
 *
 * Production code may swallow the throw (group probes sit in try/catch), so
 * every refusal is also recorded and fails the test that caused it.
 */
type Kill = typeof process.kill

const GUARD_MARKER = Symbol.for('bitsentry.tests.processKillGuard')
const REFUSED_KILLS_KEY = Symbol.for('bitsentry.tests.refusedProcessKills')

function refusedKills(): string[] {
  const store = globalThis as typeof globalThis & { [REFUSED_KILLS_KEY]?: string[] }
  store[REFUSED_KILLS_KEY] ??= []
  return store[REFUSED_KILLS_KEY]
}

/** -1 is every process the user may signal, 0 the caller's group, 1 init. */
function isBroadcastKillTarget(pid: number): boolean {
  return !Number.isInteger(pid) || Math.abs(pid) <= 1
}

export function guardProcessKill(kill: Kill, onRefused: (message: string) => void = () => {}): Kill {
  const guarded = (pid: number, signal?: string | number): true => {
    if (isBroadcastKillTarget(pid)) {
      const message =
        `Refused process.kill(${String(pid)}, ${String(signal ?? 'SIGTERM')}): ` +
        'PID -1, 0, 1 or NaN would signal processes outside this test. ' +
        'Mock process.kill with vi.spyOn and give fake children a PID above 1.'
      onRefused(message)
      throw new Error(message)
    }
    return kill(pid, signal)
  }
  return Object.assign(guarded, { [GUARD_MARKER]: true })
}

/** Returns and clears the refusals recorded since the last call. */
export function takeRefusedProcessKills(): string[] {
  return refusedKills().splice(0)
}

if (!(GUARD_MARKER in process.kill)) {
  process.kill = guardProcessKill(process.kill.bind(process), (message) => refusedKills().push(message))
}

afterEach(() => {
  const refused = takeRefusedProcessKills()
  if (refused.length > 0) throw new Error(refused.join('\n'))
})
