import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn: spawnMock }))

import { sshJournalQueryTool } from '../src/features/agent-runtime/capabilities/ssh-journal-query.capability'

let nextMockPid = 1

function createSshChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = nextMockPid++
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  return child
}

describe('sshJournalQueryTool', () => {
  afterEach(() => spawnMock.mockReset())

  it('starts SSH queries detached so interactive prompts cannot attach to the desktop terminal', async () => {
    const child = createSshChild()
    spawnMock.mockReturnValue(child)
    const host = `host-${randomUUID()}.example`
    const username = `user${randomUUID().replaceAll('-', '').slice(0, 12)}`

    const result = sshJournalQueryTool.execute(
      { host, username, since: '1 hour ago' },
      { sessionId: randomUUID(), toolCallId: randomUUID(), signal: new AbortController().signal, onChunk: vi.fn() },
    )
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      child.stdout.end()
      child.stderr.end()
    })

    await expect(result).resolves.toEqual({ output: '' })
    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/ssh', expect.any(Array), expect.objectContaining({
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  })
})
