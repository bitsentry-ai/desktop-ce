import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { terminateSubprocess } from '@bitsentry-ce/coding-agents/subprocess-lifecycle'

async function spawnLongRunningChild(ignoreSigterm = false) {
  const source = ignoreSigterm
    ? "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1_000)"
    : "process.stdout.write('ready\\n'); setInterval(() => {}, 1_000)"
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      child.stdout.removeListener('data', onReady)
      reject(error)
    }
    const onReady = (): void => {
      child.removeListener('error', onError)
      resolve()
    }
    child.once('error', onError)
    child.stdout.once('data', onReady)
  })
  return child
}

describe('subprocess lifecycle', () => {
  it('waits for graceful process termination and removes its temporary listeners', async () => {
    const child = await spawnLongRunningChild()

    const result = await terminateSubprocess(child, { graceMs: 1_000, forceKillWaitMs: 1_000 })

    expect(result.outcome).toBe('gracefully-terminated')
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'escalates a process that ignores SIGTERM without leaving listeners behind',
    async () => {
      const child = await spawnLongRunningChild(true)

      const result = await terminateSubprocess(child, { graceMs: 25, forceKillWaitMs: 1_000 })

      expect(result.outcome).toBe('forcefully-terminated')
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
    },
  )
})
