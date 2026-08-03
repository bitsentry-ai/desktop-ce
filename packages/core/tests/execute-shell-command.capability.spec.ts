import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn: spawnMock }))

import { executeShellCommandTool } from '../src/features/agent-runtime/capabilities/execute-shell-command.capability'

type SpawnedShell = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function createSpawnedShell(): SpawnedShell {
  const child = new EventEmitter() as SpawnedShell
  child.pid = Math.floor(Math.random() * 100_000) + 1
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}

function context(signal = new AbortController().signal) {
  return {
    sessionId: randomUUID(),
    toolCallId: randomUUID(),
    signal,
    onChunk: vi.fn(),
  }
}

function exitChild(child: SpawnedShell, code: number, signal: NodeJS.Signals | null): void {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
  child.stdout.end()
  child.stderr.end()
}

describe('executeShellCommandTool', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
  })

  it('starts shell commands detached with a non-interactive environment', async () => {
    const child = createSpawnedShell()
    const command = `command-${randomUUID()}`
    spawnMock.mockReturnValue(child)

    const result = executeShellCommandTool.execute({ command }, context())
    queueMicrotask(() => exitChild(child, 0, null))

    await expect(result).resolves.toEqual({ output: 'Command completed with no output.' })
    expect(spawnMock).toHaveBeenCalledWith(command, expect.objectContaining({
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining({ CI: '1' }),
    }))
  })

  it('terminates the full POSIX group when an active shell execution is aborted', async () => {
    const child = createSpawnedShell()
    const controller = new AbortController()
    spawnMock.mockReturnValue(child)
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === -child.pid) setImmediate(() => exitChild(child, 143, 'SIGTERM'))
      return true
    }) as typeof process.kill)

    const result = executeShellCommandTool.execute({ command: `command-${randomUUID()}` }, context(controller.signal))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await expect(result).resolves.toMatchObject({ error: expect.stringContaining('cancelled') })
    if (process.platform === 'win32') {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } else {
      expect(groupKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    }
  })

  it('times out a never-exiting child, removes its process group, and reports timeout output', async () => {
    const child = createSpawnedShell()
    let groupTerminated = false
    spawnMock.mockReturnValue(child)
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === -child.pid) {
        groupTerminated = true
        setImmediate(() => exitChild(child, 143, 'SIGTERM'))
      }
      return true
    }) as typeof process.kill)

    const result = await executeShellCommandTool.execute(
      { command: `command-${randomUUID()}`, timeoutMs: 10 },
      context(),
    )

    expect(result).toMatchObject({
      error: 'Shell command timed out',
      output: expect.stringContaining('stopped this command after 10ms'),
    })
    if (process.platform === 'win32') {
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } else {
      expect(groupKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
      expect(groupTerminated).toBe(true)
    }
  })
})
