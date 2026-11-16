import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'

import {
  createLocalRunbookExecutionClient,
  LocalRunbookExecutionHost,
  type LocalRunbookExecutionHostRuntime,
} from '../src/runtime/local-runbook-execution-host'
import { afterEach, describe, expect, it, vi } from 'vitest'

const entryRun = vi.hoisted(() => vi.fn())
vi.mock('../src/cli/runbooks-cli', () => ({ runRunbooksCli: entryRun }))
vi.mock('electron-log', () => ({ default: { transports: { console: { level: 'error' } } } }))
vi.mock('@bitsentry-desktop/runbook-runtime', () => ({ DesktopRunbookRuntime: {} }))

function createRuntime(label: string): LocalRunbookExecutionHostRuntime & {
  readonly executions: Map<string, Record<string, unknown>>
  destroyed: boolean
} {
  const executions = new Map<string, Record<string, unknown>>()
  const runtime: LocalRunbookExecutionHostRuntime & {
    readonly executions: Map<string, Record<string, unknown>>
    destroyed: boolean
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
    waitForExecution: (executionId) => Promise.resolve(executions.get(executionId) ?? null),
    executions,
    destroyed: false,
    async destroy() {
      runtime.destroyed = true
    },
  }
  return runtime
}

describe('local runbook execution host', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
    temporaryDirectories.length = 0
  })

  async function createUserDataDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'bitsentry-runbook-host-'))
    temporaryDirectories.push(directory)
    return directory
  }

  async function createBrokenWrite(directory: string): Promise<Error> {
    const endpoint = path.join(directory, 'broken.sock')
    let closed!: () => void
    const peerClosed = new Promise<void>((resolve) => { closed = resolve })
    const peer = net.createServer((socket) => {
      socket.once('close', closed)
      socket.destroy()
    })
    await new Promise<void>((resolve) => peer.listen(endpoint, resolve))
    const writer = new net.Socket()
    writer.pause()
    const failure = new Promise<Error>((resolve) => writer.once('error', resolve))
    try {
      writer.connect(endpoint)
      await once(writer, 'connect')
      await peerClosed
      writer.write('synthetic')
      return await failure
    } finally {
      writer.destroy()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
    }
  }

  // These barriers assert actual Unix-socket errno; named-pipe coverage remains below.
  it.skipIf(process.platform === 'win32').each(['write', 'remote-response', 'unsafe-fields', 'wait-response'] as const)(
    'prints bounded %s context without leaking request data',
    async (kind) => {
      vi.resetModules()
      const hostModule = await import('../src/runtime/local-runbook-execution-host')
      const directory = await createUserDataDirectory()
      const sentinel = 'DO_NOT_LOG_TOKEN_ARGS_ENV_PATH_STACK'
      const endpoint = path.join(directory, `${sentinel}.sock`)
      const executions: string[] = []
      let host: InstanceType<typeof hostModule.LocalRunbookExecutionHost> | undefined
      let server: net.Server | undefined
      let failure: unknown
      const sockets = new Set<net.Socket>()
      if (kind === 'remote-response') {
        const runtime = createRuntime('diagnostic')
        runtime.executeRunbook = async (input) => {
          executions.push(input.runbookId)
          throw await createBrokenWrite(directory)
        }
        host = new hostModule.LocalRunbookExecutionHost({ userDataPath: directory, runtime })
        await host.start()
      } else {
        let peerClosed!: () => void
        const closed = new Promise<void>((resolve) => { peerClosed = resolve })
        let accepted = false
        server = net.createServer((socket) => {
          sockets.add(socket)
          socket.once('close', () => sockets.delete(socket))
          if (accepted) {
            if (kind === 'wait-response') {
              socket.once('data', (data: Buffer) => {
                const request = JSON.parse(data.toString()) as { args: [{ runbookId: string }] }
                executions.push(request.args[0].runbookId)
                socket.end('{')
              })
              return
            }
            socket.once('close', peerClosed)
            socket.destroy()
            return
          }
          accepted = true
          socket.once('data', (data: Buffer) => {
            const request = JSON.parse(data.toString()) as { id: string }
            socket.end(`${JSON.stringify({ id: request.id, result: null })}\n`)
          })
        })
        await new Promise<void>((resolve) => server!.listen(endpoint, resolve))
        await writeFile(path.join(directory, 'runbook-execution-host.json'), JSON.stringify({
          version: 1, endpoint, token: sentinel,
        }))
        // Hold only the execute write until its real peer has closed.
        const connect = net.createConnection.bind(net)
        const client = await hostModule.createLocalRunbookExecutionClient({
          userDataPath: directory,
          createHeadlessRuntime: async () => { throw new Error('Unexpected execution replay') },
        })
        vi.spyOn(net, 'createConnection').mockImplementationOnce((...args) => {
          const socket = Reflect.apply(connect, net, args) as net.Socket
          if (kind === 'wait-response') return socket
          socket.pause()
          const write = socket.write
          socket.write = ((...writeArgs: unknown[]) => {
            void closed.then(() => Reflect.apply(write, socket, writeArgs))
            return true
          }) as typeof socket.write
          socket.once('error', (error) => {
            Object.assign(error, { path: sentinel, stack: sentinel, env: sentinel })
            if (kind === 'unsafe-fields') Object.assign(error, { code: sentinel, syscall: sentinel })
          })
          return socket
        })
        try { await client.executeRunbook({ runbookId: sentinel }) } catch (error) { failure = error }
        await client.destroy()
      }
      try {
        if (host !== undefined) {
          const client = await hostModule.createLocalRunbookExecutionClient({
            userDataPath: directory,
            createHeadlessRuntime: async () => { throw new Error('Unexpected execution replay') },
          })
          try { await client.executeRunbook({ runbookId: sentinel }) } catch (error) { failure = error }
          await client.destroy()
          expect(executions).toEqual([sentinel])
        }
        const message = kind === 'wait-response'
          ? 'Local runbook host closed the connection before responding.'
          : 'write EPIPE'
        if (kind === 'wait-response') expect(executions).toEqual([sentinel])
        expect(failure).toMatchObject({ message })
        entryRun.mockRejectedValueOnce(failure)
        const output: string[] = []
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
        const previousExitCode = process.exitCode
        try {
          await import('../src/cli/desktop-runbooks-entry')
          await vi.waitFor(() => expect(output.join('').split('\n').filter(Boolean)).toHaveLength(2))
          const lines = output.join('').split('\n').filter(Boolean)
          expect(lines[0]).toBe(message)
          expect(lines[1]!.length).toBeLessThan(384)
          const context = JSON.parse(lines[1]!.replace('[local-runbook-host] ', '')) as unknown
          expect(context).toEqual({
            requestId: expect.stringMatching(/^[a-f0-9]{24}$/),
            method: 'executeRunbook', phase: kind === 'unsafe-fields' ? 'write' : kind,
            pid: process.pid, requestWasSent: true,
            ...(kind === 'write' ? { errno: 'EPIPE', syscall: 'write' } : {}),
            ...(kind === 'wait-response' ? { errno: 'ECONNRESET' } : {}),
          })
          expect(output.join('')).not.toContain(sentinel)
          expect(process.exitCode).toBe(1)
        } finally { process.exitCode = previousExitCode }
      } finally {
        if (host !== undefined) await host.close()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => {
          if (server === undefined) resolve()
          else server.close(() => resolve())
        })
      }
    },
    5_000,
  )

  it.each([true, false])('adds no context line when the entry has no classified failure (success %s)', async (success) => {
    vi.resetModules()
    if (success) entryRun.mockResolvedValueOnce(undefined)
    else entryRun.mockRejectedValueOnce(Object.assign(new Error('synthetic failure'), { token: 'DO_NOT_LOG' }))
    const output: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const previousExitCode = process.exitCode
    try {
      await import('../src/cli/desktop-runbooks-entry')
      expect(output.join('')).toBe(success ? '' : 'synthetic failure\n')
      expect(process.exitCode).toBe(success ? previousExitCode : 1)
    } finally { process.exitCode = previousExitCode }
  })

  it.each(['getExecution', 'executeRunbook'] as const)(
    'settles a disconnected %s request and only retries reads',
    async (method) => {
      const userDataPath = await createUserDataDirectory()
      const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\bitsentry-disconnect-${path.basename(userDataPath)}`
        : path.join(userDataPath, 'host.sock')
      let requests = 0
      const server = net.createServer((socket) => {
        socket.once('data', (data) => {
          const request = JSON.parse(data.toString()) as { id: string; method: string }
          if (request.method === method) {
            requests += 1
            if (requests === 1) {
              // EOF before a complete response must not leave the request pending.
              socket.end('{')
              return
            }
          }
          socket.end(`${JSON.stringify({ id: request.id, result: { status: 'completed' } })}\n`)
        })
      })
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      await writeFile(path.join(userDataPath, 'runbook-execution-host.json'), JSON.stringify({
        version: 1, endpoint, token: 'test-capability',
      }))
      const client = await createLocalRunbookExecutionClient({
        userDataPath,
        createHeadlessRuntime: async () => createRuntime('unexpected'),
      })
      try {
        if (method === 'getExecution') {
          await expect(client.getExecution('execution')).resolves.toEqual({ status: 'completed' })
          expect(requests).toBe(2)
        } else {
          await expect(client.executeRunbook({ runbookId: 'runbook' })).rejects.toThrow(
            'Local runbook host closed the connection before responding.',
          )
          expect(requests).toBe(1)
        }
      } finally {
        await client.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    2_000,
  )

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

  it('reclaims an expired live startup lock with no host metadata', async () => {
    const userDataPath = await createUserDataDirectory()
    await writeFile(
      path.join(userDataPath, 'runbook-execution-host.lock'),
      JSON.stringify({
        pid: process.pid,
        token: 'expired-owner',
        startedAt: Date.now() - 60_000,
      }),
    )
    const headlessRuntime = createRuntime('reclaimed-owner')

    const cliRuntime = await createLocalRunbookExecutionClient({
      userDataPath,
      createHeadlessRuntime: async () => headlessRuntime,
    })

    try {
      await expect(cliRuntime.listRunbooks()).resolves.toEqual([
        { id: 'reclaimed-owner', title: 'reclaimed-owner runbook' },
      ])
    } finally {
      await cliRuntime.destroy()
    }

    expect(headlessRuntime.destroyed).toBe(true)
  })

  it('reclaims a malformed legacy ownership lock immediately', async () => {
    const userDataPath = await createUserDataDirectory()
    const lockPath = path.join(userDataPath, 'runbook-execution-host.lock')
    await writeFile(lockPath, '{', 'utf-8')
    const host = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('competing-owner'),
    })

    try {
      await host.start()
      await expect(readFile(lockPath, 'utf-8')).resolves.toContain(`"pid":${process.pid}`)
    } finally {
      await host.close()
    }
  })

  it('allows one concurrent owner to reclaim a stale lock without deleting its replacement', async () => {
    const userDataPath = await createUserDataDirectory()
    const lockPath = path.join(userDataPath, 'runbook-execution-host.lock')
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: 'expired-owner',
      startedAt: Date.now() - 60_000,
    }))
    const firstHost = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('first-contender'),
    })
    const secondHost = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('second-contender'),
    })

    const results = await Promise.allSettled([firstHost.start(), secondHost.start()])
    const successfulStarts = results.filter((result) => result.status === 'fulfilled')

    try {
      expect(successfulStarts).toHaveLength(1)
      await expect(readFile(lockPath, 'utf-8')).resolves.toContain(`"pid":${process.pid}`)
    } finally {
      await firstHost.close()
      await secondHost.close()
    }
  })

  it('does not remove a foreign ownership lock while closing', async () => {
    const userDataPath = await createUserDataDirectory()
    const lockPath = path.join(userDataPath, 'runbook-execution-host.lock')
    const host = new LocalRunbookExecutionHost({
      userDataPath,
      runtime: createRuntime('original-owner'),
    })
    const foreignLock = JSON.stringify({
      pid: process.pid,
      token: 'foreign-owner',
      startedAt: Date.now(),
    })

    await host.start()
    await writeFile(lockPath, foreignLock)
    await host.close()

    await expect(readFile(lockPath, 'utf-8')).resolves.toBe(foreignLock)
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
