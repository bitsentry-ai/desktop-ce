import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

import { executeShellCommandTool } from '../src/features/agent-runtime/capabilities/execute-shell-command.capability'

type SpawnedShell = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function createSpawnedShell(pid = 4321): SpawnedShell {
  const child = new EventEmitter() as SpawnedShell
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}

function toolContext(signal = new AbortController().signal) {
  return {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    signal,
    onChunk: vi.fn(),
  }
}

describe('executeShellCommandTool', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
  })

  it('starts shell commands detached with a non-interactive environment', async () => {
    const child = createSpawnedShell()
    spawnMock.mockReturnValue(child)

    const result = executeShellCommandTool.execute(
      { command: 'printf ready' },
      toolContext(),
    )
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      child.stdout.end()
      child.stderr.end()
    })

    await expect(result).resolves.toEqual({ output: 'Command completed with no output.' })
    expect(spawnMock).toHaveBeenCalledWith(
      'printf ready',
      expect.objectContaining({
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ CI: '1' }),
      }),
    )
  })

  it('times out a never-exiting child and signals its detached process group', async () => {
    const child = createSpawnedShell()
    spawnMock.mockReturnValue(child)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === -child.pid) {
        setImmediate(() => {
          child.exitCode = 143
          child.emit('exit', 143, 'SIGTERM')
          child.stdout.end()
          child.stderr.end()
        })
      }
      return true
    }) as typeof process.kill)

    const result = await executeShellCommandTool.execute(
      { command: 'never exits', timeoutMs: 10 },
      toolContext(),
    )

    expect(result).toMatchObject({
      error: 'Shell command timed out',
      output: expect.stringContaining('stopped this command after 10ms'),
    })
    expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
  })
})
