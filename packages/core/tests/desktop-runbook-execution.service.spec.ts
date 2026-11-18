import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins'
import { createDesktopNodePluginRuntimeService } from '../src/features/plugins/desktop-plugin-runtime.node'

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
  const id = randomUUID()
  return {
    ...makeRunbook(),
    id,
    actions: [{
      id: randomUUID(),
      type: 'shell',
      title: `Shell action ${randomUUID()}`,
      command: `command-${randomUUID()}`,
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
    getExecutionSnapshotByExecutionId: async (executionId) => clone(snapshots.get(executionId) ?? null),
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

  it('persists cancellation intent when no live session is available', async () => {
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

    await expect(service.cancel('execution-after-restart')).resolves.toBeUndefined()
    expect(requestedExecutionId).toBe('execution-after-restart')
  })

  it('rejects cancellation when neither a live session nor a cancellable control row exists', async () => {
    const service = new RunbookExecutionService(
      {} as never, {} as never, {} as never, {} as never,
      createInMemoryResultStore(async () => false), () => null,
      undefined, undefined, {} as never,
    )

    await expect(service.cancel(randomUUID())).rejects.toThrow('is no longer cancellable')
  })

  it('reconciles a stale running result before declaring cancellation unavailable', async () => {
    const executionId = randomUUID()
    let reconciled = false
    const resultStore = {
      requestExecutionCancellation: async () => false,
      markStaleRunningSessionsFailed: async () => { reconciled = true; return 1 },
      getExecutionSnapshotByExecutionId: async () => reconciled
        ? { executionId, status: 'failed' }
        : { executionId, status: 'running' },
    } as unknown as RunbookResultPersistence
    const service = new RunbookExecutionService(
      {} as never, {} as never, {} as never, {} as never, resultStore,
      () => null, undefined, undefined, {} as never,
    )

    await expect(service.cancel(executionId)).resolves.toBeUndefined()
    expect(reconciled).toBe(true)
  })

  it('cancels a live session even when its execution control row is absent or terminal', async () => {
    const executeSpy = vi.spyOn(executeShellCommandTool, 'execute').mockImplementation(
      async (_input, context) => await new Promise((resolve) => {
        context.signal.addEventListener('abort', () => resolve({ error: 'Shell command cancelled' }), { once: true })
      }),
    )
    const runbook = makeShellRunbook()
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => runbook } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      {} as RunbookExecutionLlmAdapter,
      {} as never,
      createInMemoryResultStore(async () => false),
      () => null,
      undefined,
      undefined,
      {} as never,
    )
    const started = await service.start(runbook.id)
    await waitFor(() => executeSpy.mock.calls.length === 1)

    await expect(service.cancel(started.executionId)).resolves.toBeUndefined()
    await expect(service.get(started.executionId)).resolves.toMatchObject({
      status: 'cancelled',
      completionReason: 'user_cancelled',
    })

    executeSpy.mockRestore()
    await service.destroy()
  })

  it('reaches a terminal failed state when a shell step reports timeout termination', async () => {
    const executeSpy = vi.spyOn(executeShellCommandTool, 'execute').mockResolvedValue({
      error: 'Shell command timed out',
      output: '[BitSentry stopped this command after timeout.]',
    })
    const runbook = makeShellRunbook()
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => runbook } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      {} as RunbookExecutionLlmAdapter,
      {} as never,
      createInMemoryResultStore(async () => true),
      () => null,
      undefined,
      undefined,
      {} as never,
    )
    const started = await service.start(runbook.id)
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

describe('RunbookExecutionService plugin steps', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function runPluginStep(step: {
    pluginId: string
    pluginActionId: string
    pluginInput: Record<string, unknown>
    pluginSource: string
    storedAuth: DesktopPluginStoredAuthRecord
  }): Promise<RunbookExecutionRecord | null> {
    const root = await mkdtemp(path.join(tmpdir(), 'bitsentry-runbook-plugin-'))
    tempRoots.push(root)
    await mkdir(path.join(root, step.pluginId), { recursive: true })
    await writeFile(path.join(root, step.pluginId, 'plugin.js'), step.pluginSource)
    const pluginRuntime = createDesktopNodePluginRuntimeService([root], {
      get: (pluginId) => Promise.resolve(pluginId === step.pluginId ? step.storedAuth : {}),
      set: (_pluginId, values) => Promise.resolve(values),
      clear: () => Promise.resolve(),
    })
    const runbook: RunbookRecord = {
      id: 'runbook-plugin',
      title: 'Run a plugin action',
      description: 'Run a plugin action from a runbook',
      revisionNumber: 1,
      actions: [{
        id: 'action-plugin',
        type: 'plugin',
        title: 'Plugin action',
        pluginId: step.pluginId,
        pluginActionId: step.pluginActionId,
        pluginInput: JSON.stringify(step.pluginInput, null, 2),
      }],
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
    }
    const service = new RunbookExecutionService(
      { getRunbookOrThrow: async () => runbook } as never,
      { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
      { chatWithTools: () => { throw new Error('LLM should not be used for plugin runbook execution') } } as never,
      { execute: () => { throw new Error('External source executor should not be used for plugin runbook execution') } } as never,
      createInMemoryResultStore(async () => false),
      () => null,
      undefined,
      undefined,
      pluginRuntime,
    )
    try {
      const { executionId } = await service.start(runbook.id)
      return await service.waitForCompletion(executionId, { timeoutMs: 5_000 })
    } finally {
      await service.destroy()
    }
  }

  it('executes a plugin step with saved plugin auth and structured input', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const execution = await runPluginStep({
      pluginId: 'ops-config',
      pluginActionId: 'inspect_config',
      pluginInput: { team: 'platform' },
      storedAuth: { baseUrl: 'https://ops.example.com', includeArchived: true, retryCount: 3, labels: ['alpha', 'beta'], metadata: { region: 'us-east-1' } },
      pluginSource: `
exports.plugin = {
  id: "ops-config",
  name: "Ops Config",
  version: "1.0.0",
  description: "Executable code plugin fixture for runbook tests.",
  auth: {
    fields: [
      { key: "baseUrl", label: "Base URL", type: "string", required: true },
      { key: "includeArchived", label: "Include archived", type: "boolean", required: false },
      { key: "retryCount", label: "Retry count", type: "number", required: false },
      { key: "labels", label: "Labels", type: "string_array", required: false },
      { key: "metadata", label: "Metadata", type: "json", required: false },
    ],
  },
  actions: [
    {
      id: "inspect_config",
      title: "Inspect config",
      description: "Calls an ops config endpoint with saved auth values.",
      riskLevel: "read",
      fields: [{ key: "team", label: "Team", type: "string", required: true }],
      async execute(context) {
        const response = await fetch(context.auth.baseUrl + "/api/config/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            team: context.input.team,
            includeArchived: context.auth.includeArchived,
            retryCount: context.auth.retryCount,
            labels: context.auth.labels,
            metadata: context.auth.metadata,
          }),
        });
        return { status: response.status, summary: "Ops config inspection completed.", data: await response.json() };
      },
    },
  ],
}
`,
    })

    expect(execution).toMatchObject({ status: 'completed', completionReason: 'success' })
    expect(execution?.steps).toHaveLength(1)
    expect(execution?.steps[0]).toMatchObject({
      type: 'plugin',
      status: 'completed',
      input: { actionType: 'plugin', pluginId: 'ops-config', pluginActionId: 'inspect_config', pluginInput: { team: 'platform' } },
      statusCode: 200,
      structuredOutput: { ok: true },
    })
    expect(execution?.steps[0]?.output).toContain('Ops config inspection completed.')
    expect(execution?.steps[0]?.output).toContain('"ok": true')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('https://ops.example.com/api/config/inspect')
    expect(JSON.parse(String(init?.body))).toEqual({
      team: 'platform',
      includeArchived: true,
      retryCount: 3,
      labels: ['alpha', 'beta'],
      metadata: { region: 'us-east-1' },
    })
  })

  it('executes a write plugin step with a saved secret token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ number: 42, title: 'Investigate pager flood' }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    )
    const issue = { owner: 'bitsentry-ai', repo: 'bitsentry-desktop', title: 'Investigate pager flood', body: 'Opened from a runbook plugin action test.' }

    const execution = await runPluginStep({
      pluginId: 'github',
      pluginActionId: 'create_issue',
      pluginInput: issue,
      storedAuth: { accessToken: 'ghp_saved_token' },
      pluginSource: `
exports.plugin = {
  id: "github",
  name: "GitHub",
  version: "1.0.0",
  description: "Executable GitHub code plugin fixture for runbook tests.",
  auth: {
    fields: [{ key: "accessToken", label: "Access token", type: "string", required: true, secret: true }],
  },
  actions: [
    {
      id: "create_issue",
      title: "Create issue",
      description: "Creates a GitHub issue.",
      riskLevel: "write",
      fields: [
        { key: "owner", label: "Owner", type: "string", required: true },
        { key: "repo", label: "Repository", type: "string", required: true },
        { key: "title", label: "Title", type: "string", required: true },
        { key: "body", label: "Body", type: "string", required: false },
      ],
      async execute(context) {
        const response = await fetch(
          "https://api.github.com/repos/" + context.input.owner + "/" + context.input.repo + "/issues",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + context.auth.accessToken,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ title: context.input.title, body: context.input.body }),
          },
        );
        return {
          status: response.status,
          summary: "POST /repos/" + context.input.owner + "/" + context.input.repo + "/issues completed successfully.",
          data: await response.json(),
        };
      },
    },
  ],
}
`,
    })

    expect(execution?.status).toBe('completed')
    expect(execution?.steps[0]).toMatchObject({
      type: 'plugin',
      status: 'completed',
      input: { actionType: 'plugin', pluginId: 'github', pluginActionId: 'create_issue', pluginInput: issue },
      statusCode: 201,
      structuredOutput: { number: 42, title: 'Investigate pager flood' },
    })
    expect(execution?.steps[0]?.output).toContain('POST /repos/bitsentry-ai/bitsentry-desktop/issues completed successfully.')
    expect(execution?.steps[0]?.output).toContain('"number": 42')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('https://api.github.com/repos/bitsentry-ai/bitsentry-desktop/issues')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer ghp_saved_token',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    expect(JSON.parse(String(init?.body))).toEqual({ title: issue.title, body: issue.body })
  })
})
