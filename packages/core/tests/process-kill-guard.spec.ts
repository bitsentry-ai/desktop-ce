import { describe, expect, it, vi } from 'vitest'
import { guardProcessKill, takeRefusedProcessKills } from './setup/process-kill-guard'

describe('process.kill test guard', () => {
  it.each([-1, 0, 1, -0, Number.NaN])('refuses PID %s and sends no signal', (pid) => {
    const realKill = vi.fn(() => true)
    const kill = guardProcessKill(realKill as unknown as typeof process.kill)

    expect(() => kill(pid, 'SIGTERM')).toThrow(/Refused process\.kill/)
    expect(realKill).not.toHaveBeenCalled()
  })

  it('passes other PIDs through', () => {
    const realKill = vi.fn(() => true)
    const kill = guardProcessKill(realKill as unknown as typeof process.kill)

    kill(-900_000, 'SIGTERM')

    expect(realKill).toHaveBeenCalledWith(-900_000, 'SIGTERM')
  })

  it('is installed on process.kill and records refusals that code swallows', () => {
    // Signal 0 only probes, so this stays harmless even without the guard.
    try {
      process.kill(-1, 0)
    } catch {
      // Swallowed on purpose, like a production group probe.
    }

    // Taking the record keeps the global afterEach from failing this test.
    expect(takeRefusedProcessKills()).toEqual([expect.stringMatching(/^Refused process\.kill\(-1, 0\)/)])
  })
})
