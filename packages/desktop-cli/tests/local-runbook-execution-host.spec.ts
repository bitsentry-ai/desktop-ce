import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createLocalRunbookExecutionClient,
  LocalRunbookExecutionHost,
  type LocalRunbookExecutionHostRuntime,
} from '../src/runtime/local-runbook-execution-host'
import { afterEach, describe, expect, it, vi } from 'vitest'

function createRuntime(label: string): LocalRunbookExecutionHostRuntime & { destroy: ReturnType<typeof vi.fn> } {
  return {
    listRunbooks: () => Promise.resolve([{ id: label, title: `${label} runbook` }]),
    deleteRunbook: () => Promise.resolve({ ok: true as const }),
    exportRunbooks: () => Promise.resolve({ version: 1, runbooks: [] }),
    exportRunbooksToFile: (filePath) => Promise.resolve({ ok: true as const, filePath, count: 0 }),
    importRunbooksFromFile: () => Promise.resolve({ imported: 0 }),
    executeRunbook: () => Promise.resolve({ executionId: 'execution-1', resultId: 'result-1' }),
    getExecution: () => Promise.resolve(null),
    cancelExecution: () => Promise.resolve(),
    waitForExecution: () => Promise.resolve(null),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

describe('local runbook execution host', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
    temporaryDirectories.length = 0
  })

  async function createUserDataDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'bitsentry-runbook-host-'))
    temporaryDirectories.push(directory)
    return directory
  }

  it('routes CLI calls to the running desktop host without constructing a second runtime', async () => {
    const userDataPath = await createUserDataDirectory()
    const desktopRuntime = createRuntime('desktop')
    const desktopHost = new LocalRunbookExecutionHost({ userDataPath, runtime: desktopRuntime })
    await desktopHost.start()
    const createHeadlessRuntime = vi.fn().mockResolvedValue(createRuntime('headless'))

    try {
      const cliRuntime = await createLocalRunbookExecutionClient({
        userDataPath,
        createHeadlessRuntime,
      })

      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'desktop', title: 'desktop runbook' },
      ])
      expect(createHeadlessRuntime).not.toHaveBeenCalled()
      await cliRuntime.destroy()
    } finally {
      await desktopHost.close()
    }
  })

  it('owns a temporary headless host only when no desktop host is available', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('headless')
    const createHeadlessRuntime = vi.fn().mockResolvedValue(headlessRuntime)

    const cliRuntime = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime,
    })

    expect(createHeadlessRuntime).not.toHaveBeenCalled()
    await expect(cliRuntime.listRunbooks()).resolves.toEqual([
      { id: 'headless', title: 'headless runbook' },
    ])
    await cliRuntime.destroy()

    expect(createHeadlessRuntime).toHaveBeenCalledTimes(1)
    expect(headlessRuntime.destroy).toHaveBeenCalledTimes(1)
  })

  it('converges concurrent CLI clients on one headless execution owner', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('shared-headless')
    const createHeadlessRuntime = vi.fn().mockResolvedValue(headlessRuntime)

    const [firstClient, secondClient] = await Promise.all([
      createLocalRunbookExecutionClient({ userDataPath, createHeadlessRuntime }),
      createLocalRunbookExecutionClient({ userDataPath, createHeadlessRuntime }),
    ])

    try {
      await expect(firstClient.listRunbooks()).resolves.toEqual([
        { id: 'shared-headless', title: 'shared-headless runbook' },
      ])
      await expect(secondClient.listRunbooks()).resolves.toEqual([
        { id: 'shared-headless', title: 'shared-headless runbook' },
      ])
      expect(createHeadlessRuntime).toHaveBeenCalledTimes(1)
    } finally {
      await firstClient.destroy()
      await secondClient.destroy()
    }
  })
})
