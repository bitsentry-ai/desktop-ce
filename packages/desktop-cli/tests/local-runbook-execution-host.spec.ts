import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createLocalRunbookExecutionClient,
  LocalRunbookExecutionHost,
  type LocalRunbookExecutionHostRuntime,
} from '../src/runtime/local-runbook-execution-host'
import { afterEach, describe, expect, it } from 'vitest'

function createRuntime(label: string): LocalRunbookExecutionHostRuntime & {
  readonly executions: Map<string, Record<string, unknown>>
  destroyed: boolean
  lastWaitOptions: unknown
} {
  const executions = new Map<string, Record<string, unknown>>()
  const runtime: LocalRunbookExecutionHostRuntime & {
    readonly executions: Map<string, Record<string, unknown>>
    destroyed: boolean
    lastWaitOptions: unknown
  } = {
    listRunbooks: () => Promise.resolve([{ id: label, title: `${label} runbook` }]),
    deleteRunbook: () => Promise.resolve({ ok: true as const }),
    exportRunbooks: () => Promise.resolve({ version: 1, runbooks: [] }),
    exportRunbooksToFile: (filePath) => Promise.resolve({ ok: true as const, filePath, count: 0 }),
    importRunbooksFromFile: () => Promise.resolve({ imported: 0 }),
    executeRunbook: (input) => {
      const executionId = `${label}-${input.runbookId}-execution`
      const resultId = `${label}-${input.runbookId}-result`
      executions.set(executionId, {
        executionId,
        resultId,
        runbookId: input.runbookId,
        incidentThreadId: input.incidentThreadId,
        status: 'running',
      })
      return Promise.resolve({ executionId, resultId })
    },
    getExecution: (executionId) => Promise.resolve(executions.get(executionId) ?? null),
    cancelExecution: () => Promise.resolve(),
    waitForExecution: (executionId, options) => {
      runtime.lastWaitOptions = options
      return Promise.resolve(executions.get(executionId) ?? null)
    },
    executions,
    destroyed: false,
    lastWaitOptions: undefined,
    async destroy() {
      runtime.destroyed = true
    },
  }
  return runtime
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
    const createHeadlessRuntime = async () => createRuntime('headless')

    try {
      const cliRuntime = await createLocalRunbookExecutionClient({
        userDataPath,
        createHeadlessRuntime,
      })

      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'desktop', title: 'desktop runbook' },
      ])
      const accepted = await cliRuntime.executeRunbook({
        runbookId: 'rb-desktop',
        incidentThreadId: 'incident-desktop',
      })
      const visibleInDesktop = await desktopRuntime.getExecution(accepted.executionId)
      await expect(cliRuntime.getExecution(accepted.executionId)).resolves.toEqual(visibleInDesktop)
      expect(visibleInDesktop).toMatchObject({
        executionId: accepted.executionId,
        runbookId: 'rb-desktop',
        incidentThreadId: 'incident-desktop',
      })
      await cliRuntime.destroy()
    } finally {
      await desktopHost.close()
    }
  })

  it('accepts a local host response that takes longer than the connection handshake', async () => {
    const userDataPath = await createUserDataDirectory()
    const desktopRuntime = createRuntime('slow-desktop')
    desktopRuntime.listRunbooks = async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return [{ id: 'slow-desktop', title: 'slow-desktop runbook' }]
    }
    const desktopHost = new LocalRunbookExecutionHost({ userDataPath, runtime: desktopRuntime })
    await desktopHost.start()

    try {
      const cliRuntime = await createLocalRunbookExecutionClient({
        userDataPath,
        createHeadlessRuntime: async () => createRuntime('headless'),
      })

      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'slow-desktop', title: 'slow-desktop runbook' },
      ])
      await cliRuntime.destroy()
    } finally {
      await desktopHost.close()
    }
  })

  it('owns a temporary headless host only when no desktop host is available', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('headless')
    const createHeadlessRuntime = async () => headlessRuntime

    const cliRuntime = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime,
    })

    await expect(cliRuntime.listRunbooks()).resolves.toEqual([
      { id: 'headless', title: 'headless runbook' },
    ])
    const accepted = await cliRuntime.executeRunbook({ runbookId: 'rb-headless' })
    await expect(cliRuntime.waitForExecution(accepted.executionId)).resolves.toMatchObject({
      executionId: accepted.executionId,
      runbookId: 'rb-headless',
      status: 'running',
    })
    expect(headlessRuntime.lastWaitOptions).toBeUndefined()
    await cliRuntime.destroy()

    expect(headlessRuntime.destroyed).toBe(true)
  })

  it('converges concurrent CLI clients on one headless execution owner', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('shared-headless')
    const createHeadlessRuntime = async () => headlessRuntime

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
      const firstAccepted = await firstClient.executeRunbook({ runbookId: 'rb-shared' })
      await expect(secondClient.getExecution(firstAccepted.executionId)).resolves.toMatchObject({
        executionId: firstAccepted.executionId,
        runbookId: 'rb-shared',
      })
    } finally {
      await firstClient.destroy()
      await secondClient.destroy()
    }
  })

  it('keeps the headless host alive until executions accepted for other CLI clients finish', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('shared-headless')
    let finishExecution: (() => void) | undefined
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve
    })
    headlessRuntime.waitForExecution = async (executionId) => {
      await executionFinished
      return headlessRuntime.executions.get(executionId) ?? null
    }

    const ownerClient = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => headlessRuntime,
    })
    const peerClient = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => createRuntime('unexpected-second-owner'),
    })

    try {
      const accepted = await peerClient.executeRunbook({ runbookId: 'rb-shared' })
      const ownerDestroy = ownerClient.destroy()

      await Promise.resolve()
      expect(headlessRuntime.destroyed).toBe(false)
      await expect(peerClient.getExecution(accepted.executionId)).resolves.toMatchObject({
        executionId: accepted.executionId,
        runbookId: 'rb-shared',
      })

      finishExecution?.()
      await ownerDestroy
      expect(headlessRuntime.destroyed).toBe(true)
    } finally {
      await peerClient.destroy()
    }
  })
})
