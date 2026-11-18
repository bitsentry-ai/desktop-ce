import { ChildProcess, spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runRunbooksCli } from '../src/cli/runbooks-cli'

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}))

describe('detached runbook CLI startup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function prepareWorker(publish: (startupFile: string, child: ChildProcess) => void) {
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = new ChildProcess()
      const flags = args as string[]
      const startupFile = flags[flags.indexOf('--startup-file') + 1]!
      publish(startupFile, child)
      return child
    })
    const run = () => runRunbooksCli(
      async () => { throw new Error('Startup must not execute a runbook in this process') },
      ['node', 'bitsentry', 'runbooks', 'execute', '--runbook-id', 'synthetic', '--json'],
    )
    return { run, result: () => JSON.parse(output.join('')) as unknown }
  }

  const started = { executionId: 'synthetic-execution', resultId: 'synthetic-result' }

  it('returns published startup IDs after the worker has already exited successfully', async () => {
    const cli = prepareWorker((file, child) => {
      writeFileSync(file, JSON.stringify(started))
      Object.defineProperty(child, 'exitCode', { value: 0 })
    })
    await cli.run()
    expect(cli.result()).toEqual({ ...started, detached: true, workerPid: -1 })
  })

  it('rechecks startup metadata when the worker exits after an empty read', async () => {
    const cli = prepareWorker((file, child) => {
      // Publish at the exit boundary, after the parent's first metadata read.
      Object.defineProperty(child, 'exitCode', {
        get() {
          writeFileSync(file, JSON.stringify(started))
          return 0
        },
      })
    })
    await cli.run()
    expect(cli.result()).toEqual({ ...started, detached: true, workerPid: -1 })
  })

  it.each([0, 1])('rejects an exited worker without startup metadata (code %s)', async (code) => {
    const cli = prepareWorker((_file, child) => { Object.defineProperty(child, 'exitCode', { value: code }) })
    await expect(cli.run()).rejects.toThrow(`Detached execution worker exited before startup (code=${String(code)})`)
  })

  it('rejects startup metadata without valid IDs', async () => {
    const cli = prepareWorker((file) => { writeFileSync(file, JSON.stringify({ executionId: 1 })) })
    await expect(cli.run()).rejects.toThrow('Detached execution worker wrote invalid startup metadata')
  })

  it('times out a live worker that never publishes startup metadata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const schedule = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, _delay, ...args) => {
      vi.setSystemTime(Date.now() + 45_001)
      return schedule(callback, 0, ...args)
    })
    const cli = prepareWorker(() => {})
    await expect(cli.run()).rejects.toThrow('Detached execution worker did not report startup metadata in time')
  })
})
