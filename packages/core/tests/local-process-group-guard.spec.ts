import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateProcessTree } from '../src/features/agent-runtime/shared/local-process'

function fakeChild(pid: number | undefined) {
  const child = {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal
      return true
    }),
    once: vi.fn(() => child),
    removeListener: vi.fn(() => child),
  }
  return child
}

const fast = { graceMs: 0, forceKillWaitMs: 0 }

describe.skipIf(process.platform === 'win32')('terminateProcessTree PID guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([1, 0, -1, Number.NaN, 2.5])('signals only the direct child for unsafe PID %s', async (pid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(pid)

    await terminateProcessTree(child, fast)

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('never signals its own process group', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(process.pid)

    await terminateProcessTree(child, fast)

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('signals the process group of a detached child', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(900_000)

    await terminateProcessTree(child, fast)

    expect(kill).toHaveBeenCalledWith(-900_000, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })
})
