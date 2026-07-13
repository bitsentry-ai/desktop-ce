import { describe, expect, it, vi } from 'vitest'

import { DesktopShutdownCoordinator } from '../../main/platform/app/electron/shutdown-coordinator'

describe('DesktopShutdownCoordinator', () => {
  it('blocks final quit until every resource is released, in dependency order', async () => {
    const calls: string[] = []
    let releaseDatabase: (() => void) | undefined
    const databaseClosed = new Promise<void>((resolve) => {
      releaseDatabase = resolve
    })
    const actions = {
      stopUpdater: vi.fn(() => { calls.push('updater') }),
      destroyAgentRuntime: vi.fn(() => { calls.push('agent-runtime') }),
      destroyCodingAgents: vi.fn(() => { calls.push('coding-agents') }),
      closeSentry: vi.fn(() => { calls.push('sentry') }),
      destroyRunbookExecution: vi.fn(() => { calls.push('runbook-execution') }),
      stopJobRuntime: vi.fn(() => { calls.push('job-runtime') }),
      closeDatabase: vi.fn(async () => {
        calls.push('database')
        await databaseClosed
      }),
    }
    const coordinator = new DesktopShutdownCoordinator(actions)
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()

    coordinator.handleBeforeQuit(event, quit)
    await vi.waitFor(() => {
      expect(actions.closeDatabase).toHaveBeenCalledOnce()
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'updater',
      'agent-runtime',
      'coding-agents',
      'sentry',
      'runbook-execution',
      'job-runtime',
      'database',
    ])

    releaseDatabase?.()
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce()
    })
  })

  it('shares one shutdown operation across duplicate before-quit events and quits once', async () => {
    const actions = {
      stopUpdater: vi.fn(),
      destroyAgentRuntime: vi.fn(),
      destroyCodingAgents: vi.fn(),
      closeSentry: vi.fn(),
      destroyRunbookExecution: vi.fn(),
      stopJobRuntime: vi.fn(),
      closeDatabase: vi.fn(),
    }
    const coordinator = new DesktopShutdownCoordinator(actions)
    const firstEvent = { preventDefault: vi.fn() }
    const secondEvent = { preventDefault: vi.fn() }
    const quit = vi.fn()

    coordinator.handleBeforeQuit(firstEvent, quit)
    coordinator.handleBeforeQuit(secondEvent, quit)
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce()
    })

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce()
    expect(actions.closeDatabase).toHaveBeenCalledOnce()
  })

  it('releases later resources and quits when an earlier cleanup action fails', async () => {
    const onShutdownError = vi.fn()
    const actions = {
      stopUpdater: vi.fn(),
      destroyAgentRuntime: vi.fn(),
      destroyCodingAgents: vi.fn(() => {
        throw new Error('CLI subprocess cleanup failed')
      }),
      closeSentry: vi.fn(),
      destroyRunbookExecution: vi.fn(),
      stopJobRuntime: vi.fn(),
      closeDatabase: vi.fn(),
      onShutdownError,
    }
    const coordinator = new DesktopShutdownCoordinator(actions)
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()

    coordinator.handleBeforeQuit(event, quit)
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledOnce()
    })

    expect(actions.closeDatabase).toHaveBeenCalledOnce()
    expect(onShutdownError).toHaveBeenCalledWith(
      'coding-agents',
      expect.objectContaining({ message: 'CLI subprocess cleanup failed' }),
    )
  })
})
