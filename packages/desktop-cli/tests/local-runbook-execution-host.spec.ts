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

  it('uses a runtime-free probe when discovering a running desktop host', async () => {
    const userDataPath = await createUserDataDirectory()
    const desktopRuntime = createRuntime('desktop')
    let runtimeCreations = 0
    const desktopHost = new LocalRunbookExecutionHost({
      userDataPath,
      async createRuntime() {
        runtimeCreations += 1
        return desktopRuntime
      },
    })
    await desktopHost.start()

    try {
      const cliRuntime = await createLocalRunbookExecutionClient({
        userDataPath,
        createHeadlessRuntime: async () => createRuntime('headless'),
      })

      expect(runtimeCreations).toBe(0)
      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'desktop', title: 'desktop runbook' },
      ])
      expect(runtimeCreations).toBe(1)
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

  it('reacquires a runtime when a peer host disappears after the connection probe', async () => {
    const userDataPath = await createUserDataDirectory()
    const desktopHost = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('desktop'),
    })
    const headlessRuntime = createRuntime('headless')
    await desktopHost.start()

    const cliRuntime = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => headlessRuntime,
    })

    try {
      await desktopHost.close()

      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'headless', title: 'headless runbook' },
      ])
    } finally {
      await cliRuntime.destroy()
    }

    expect(headlessRuntime.destroyed).toBe(true)
  })

  it('retries an execution when the peer disappears before its request is sent', async () => {
    const userDataPath = await createUserDataDirectory()
    const desktopHost = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('desktop'),
    })
    const headlessRuntime = createRuntime('headless')
    await desktopHost.start()

    const cliRuntime = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => headlessRuntime,
    })

    try {
      await desktopHost.close()

      await expect(cliRuntime.executeRunbook({ runbookId: 'rb-reacquired' })).resolves.toEqual({
        executionId: 'headless-rb-reacquired-execution',
        resultId: 'headless-rb-reacquired-result',
      })
    } finally {
      await cliRuntime.destroy()
    }

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

  it('serializes concurrent execution starts without serializing execution lifetime', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('shared-headless')
    let activeStarts = 0
    headlessRuntime.executeRunbook = async (input) => {
      activeStarts += 1
      if (activeStarts > 1) throw new Error('concurrent transaction start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeStarts -= 1
      const executionId = `shared-headless-${input.runbookId}-execution`
      const resultId = `shared-headless-${input.runbookId}-result`
      headlessRuntime.executions.set(executionId, { executionId, resultId, status: 'running' })
      return { executionId, resultId }
    }

    const ownerClient = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => headlessRuntime,
    })
    const peerClients = await Promise.all([
      createLocalRunbookExecutionClient({ userDataPath, createHeadlessRuntime: async () => createRuntime('unused') }),
      createLocalRunbookExecutionClient({ userDataPath, createHeadlessRuntime: async () => createRuntime('unused') }),
    ])

    try {
      await expect(Promise.all([
        ownerClient.executeRunbook({ runbookId: 'one' }),
        peerClients[0].executeRunbook({ runbookId: 'two' }),
        peerClients[1].executeRunbook({ runbookId: 'three' }),
      ])).resolves.toHaveLength(3)
    } finally {
      await ownerClient.destroy()
      await Promise.all(peerClients.map(async (client) => await client.destroy()))
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

  it('keeps accepted queued starts alive while the owning CLI client exits', async () => {
    const userDataPath = await createUserDataDirectory()
    const headlessRuntime = createRuntime('shared-headless')
    const originalExecuteRunbook = headlessRuntime.executeRunbook
    let releaseStart: (() => void) | undefined
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let markStartQueued: (() => void) | undefined
    const startQueued = new Promise<void>((resolve) => {
      markStartQueued = resolve
    })
    let finishExecution: (() => void) | undefined
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve
    })
    headlessRuntime.executeRunbook = async (input) => {
      markStartQueued?.()
      await startReleased
      return await originalExecuteRunbook(input)
    }
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
      const accepted = peerClient.executeRunbook({ runbookId: 'rb-queued' })
      await startQueued
      const ownerDestroy = ownerClient.destroy()

      releaseStart?.()
      const execution = await accepted
      await Promise.resolve()
      expect(headlessRuntime.destroyed).toBe(false)
      await expect(peerClient.getExecution(execution.executionId)).resolves.toMatchObject({
        executionId: execution.executionId,
        runbookId: 'rb-queued',
      })

      finishExecution?.()
      await ownerDestroy
      expect(headlessRuntime.destroyed).toBe(true)
    } finally {
      await peerClient.destroy()
    }
  })
})
