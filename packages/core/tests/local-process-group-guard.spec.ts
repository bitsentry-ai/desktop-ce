import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateLocalProcessTree } from '../src/features/agent-runtime/shared/local-process'

function fakeChild(pid: number | undefined) {
  return { pid, kill: vi.fn(() => true) }
}

describe.skipIf(process.platform === 'win32')('terminateLocalProcessTree PID guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([1, 0, -1, undefined, Number.NaN, 2.5])('signals only the direct child for unsafe PID %s', (pid) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(pid)

    terminateLocalProcessTree(child, 'SIGTERM')

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('never signals its own process group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(process.pid)

    terminateLocalProcessTree(child, 'SIGKILL')

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('signals the process group of a detached child', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild(900_000)

    terminateLocalProcessTree(child, 'SIGTERM')

    expect(kill).toHaveBeenCalledWith(-900_000, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })
})
