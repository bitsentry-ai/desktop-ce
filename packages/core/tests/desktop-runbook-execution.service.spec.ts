import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import {
  RunbookExecutionService,
  type RunbookExecutionLlmAdapter,
} from '../src/features/runbooks/desktop-runbook-execution.service'
import { executeShellCommandTool } from '../src/features/agent-runtime/capabilities/execute-shell-command.capability'
import type { ExternalSourceRunbookQueryExecutor } from '../src/features/error-sources/desktop-external-source-runbook-query-service'
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from '../src/features/runbooks/desktop-runbook.types'
import type { RunbookResultPersistence } from '../src/features/runbooks/desktop-runbook-result.store'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeRunbook(): RunbookRecord {
  return {
    id: 'runbook-1',
    title: 'Fetch external data',
    description: 'A one-step external source runbook',
    revisionNumber: 1,
    actions: [{
      id: 'step-1',
      type: 'external_source',
      title: 'Fetch data',
      sourceId: 'source-1',
      query: 'latest incidents',
    }],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }
}

function makeShellRunbook(): RunbookRecord {
  return {
    ...makeRunbook(),
    actions: [{
      id: 'shell-step-1',
      type: 'shell',
      title: 'Run shell command',
      command: 'never exits',
    }],
  }
}

function createInMemoryResultStore(
  requestExecutionCancellation: () => Promise<boolean>,
): RunbookResultPersistence {
  const snapshots = new Map<string, RunbookExecutionRecord>()
  const resultToExecution = new Map<string, string>()

  return {
    createRunbookResultSession: async ({ resultId, executionId, snapshot }) => {
      snapshots.set(executionId, clone(snapshot))
      resultToExecution.set(resultId, executionId)
    },
    saveExecutionSnapshot: async () => {},
    applyExecutionSnapshotEvent: async (_resultId, input) => {
      snapshots.set(input.snapshot.executionId, clone(input.snapshot))
      return 'accepted'
    },
    getExecutionSnapshotByExecutionId: async (executionId) =>
      clone(snapshots.get(executionId) ?? null),
    getExecutionSnapshotByResultId: async (resultId) => {
      const executionId = resultToExecution.get(resultId)
      return executionId === undefined ? null : clone(snapshots.get(executionId) ?? null)
    },
    getExecutionByRequestKey: async () => null,
    getLatestExecutionSnapshotByIncidentThreadId: async () => null,
    getLatestExecutionByIncidentThreadId: async () => null,
    touchExecutionHeartbeat: async () => {},
    requestExecutionCancellation,
    isExecutionCancellationRequested: async () => false,
    completeExecutionControl: async () => {},
    markStaleRunningSessionsFailed: async () => 0,
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('RunbookExecutionService lifecycle', () => {
  it('retries a rejected terminal snapshot and preserves completed step input/output', async () => {
    const runbook = makeRunbook()
    let persisted: RunbookExecutionRecord | null = null
    let rejectFirstTerminalSnapshot = true

    const resultStore: RunbookResultPersistence = {
      createRunbookResultSession: async ({ snapshot }) => {
        persisted = clone(snapshot)
      },
      saveExecutionSnapshot: async (_resultId, snapshot) => {
        persisted = clone(snapshot)
      },
      applyExecutionSnapshotEvent: async (_resultId, input) => {
        if (
          input.snapshot.status === 'completed' &&
          rejectFirstTerminalSnapshot
        ) {
          rejectFirstTerminalSnapshot = false
          return 'stale'
        }

        if (
          persisted === null ||
          persisted.snapshotVersion !== input.expectedSnapshotVersion ||
          (persisted.status !== 'running' &&
            persisted.status !== input.snapshot.status)
        ) {
          return 'stale'
        }

        persisted = clone(input.snapshot)
        return 'accepted'
      },
      getExecutionSnapshotByExecutionId: async () => clone(persisted),
      getExecutionSnapshotByResultId: async () => clone(persisted),
      getExecutionByRequestKey: async () => null,
      getLatestExecutionSnapshotByIncidentThreadId: async () => null,
      getLatestExecutionByIncidentThreadId: async () => null,
      touchExecutionHeartbeat: async () => {},
      requestExecutionCancellation: async () => false,
      isExecutionCancellationRequested: async () => false,
      completeExecutionControl: async () => {},
      markStaleRunningSessionsFailed: async () => 0,
    }

    const externalSourceQueryExecutor: ExternalSourceRunbookQueryExecutor = {
      execute: async () => 'found 3 entries',
    }
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => runbook } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      {} as RunbookExecutionLlmAdapter,
      externalSourceQueryExecutor,
      resultStore,
      () => null,
      undefined,
      undefined,
      {} as never,
    )

    const started = await service.start('runbook-1')
    await waitFor(() => persisted?.status === 'completed')

    expect(persisted).toMatchObject({
      executionId: started.executionId,
      status: 'completed',
      completionReason: 'success',
    })
    expect(persisted?.steps[0]).toMatchObject({
      status: 'completed',
      input: {
        actionType: 'external_source',
        sourceId: 'source-1',
        query: 'latest incidents',
      },
      output: 'found 3 entries',
    })

    await service.destroy()
    await expect(service.get(started.resultId)).resolves.toMatchObject({
      status: 'completed',
      steps: [{
        status: 'completed',
        output: 'found 3 entries',
      }],
    })
  })

  it('persists cancellation intent and reports when no live session can be stopped', async () => {
    let requestedExecutionId: string | undefined
    const resultStore = {
      requestExecutionCancellation: async (executionId: string) => {
        requestedExecutionId = executionId
        return true
      },
    } as unknown as RunbookResultPersistence
    const service = new RunbookExecutionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      resultStore,
      () => null,
      undefined,
      undefined,
      {} as never,
    )

    await expect(service.cancel('execution-after-restart')).rejects.toThrow(
      'no live execution session is available',
    )
    expect(requestedExecutionId).toBe('execution-after-restart')
  })

  it('rejects cancellation when there is neither a live session nor a cancellable control row', async () => {
    const service = new RunbookExecutionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createInMemoryResultStore(async () => false),
      () => null,
      undefined,
      undefined,
      {} as never,
    )

    await expect(service.cancel('already-finished')).rejects.toThrow(
      "Runbook execution 'already-finished' is no longer cancellable",
    )
  })

  it('cancels an active session when its control row was already completed or absent', async () => {
    const executeSpy = vi.spyOn(executeShellCommandTool, 'execute').mockImplementation(
      async (_input, context) => new Promise((resolve) => {
        context.signal.addEventListener('abort', () => {
          resolve({ error: 'Shell command cancelled' })
        }, { once: true })
      }),
    )
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => makeShellRunbook() } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      {} as RunbookExecutionLlmAdapter,
      {} as never,
      createInMemoryResultStore(async () => false),
      () => null,
      undefined,
      undefined,
      {} as never,
    )

    const started = await service.start('runbook-1')
    await waitFor(() => executeSpy.mock.calls.length === 1)

    await expect(service.cancel(started.executionId)).resolves.toBeUndefined()
    await expect(service.get(started.executionId)).resolves.toMatchObject({
      status: 'cancelled',
      completionReason: 'user_cancelled',
    })

    executeSpy.mockRestore()
    await service.destroy()
  })

  it('turns a timed-out shell step into a terminal failed execution', async () => {
    const executeSpy = vi.spyOn(executeShellCommandTool, 'execute').mockResolvedValue({
      error: 'Shell command timed out',
      output: '[BitSentry stopped this command after 300000ms to avoid a hung runbook.]',
    })
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => makeShellRunbook() } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      {} as RunbookExecutionLlmAdapter,
      {} as never,
      createInMemoryResultStore(async () => true),
      () => null,
      undefined,
      undefined,
      {} as never,
    )

    const started = await service.start('runbook-1')
    await waitFor(async () => (await service.get(started.executionId))?.status === 'failed')

    await expect(service.get(started.executionId)).resolves.toMatchObject({
      status: 'failed',
      completionReason: 'step_failed',
      steps: [{ status: 'failed', error: 'Shell command timed out' }],
    })

    executeSpy.mockRestore()
    await service.destroy()
  })
})
