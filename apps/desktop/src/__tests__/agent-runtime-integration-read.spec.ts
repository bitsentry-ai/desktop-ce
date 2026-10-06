import { access, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import { createDesktopAgentService } from '@bitsentry-ce/coding-agents'
import { AgentRuntimeService as ComposedAgentRuntimeService } from '@bitsentry-ce/desktop-cli/runtime/desktop-agent-runtime'
import type {
  DesktopPluginDescriptor,
  DesktopPluginRuntimeService,
  DesktopPluginStoredAuthRecord,
  DesktopPluginStoredAuthStore,
} from '@bitsentry-ce/core/features/plugins'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import type { IntegrationConnection } from '@bitsentry-ce/core/features/plugins/integration-connections'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]

const readAction: DesktopPluginDescriptor['actions'][number] = {
  id: 'get_document',
  title: 'Read document',
  description: 'Read a knowledge document',
  riskLevel: 'read',
  fields: [{ key: 'id', label: 'ID', type: 'string', required: true }],
}
const plugin: DesktopPluginDescriptor = {
  id: 'outline',
  name: 'Outline',
  version: '1.0.0',
  type: 'data_source',
  description: 'Knowledge',
  auth: { fields: [] },
  actions: [readAction],
}
const connection: IntegrationConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Knowledge',
  pluginId: 'outline',
  enabled: true,
  target: 'https://outline.example/api',
  authMode: 'token',
  availability: 'configured',
  actions: [readAction],
}

function createRuntime(
  llmAdapter: AgentRuntimeLlmAdapter,
  pluginRuntime: DesktopPluginRuntimeService,
): AgentRuntimeService {
  return new AgentRuntimeService(
    () => null,
    llmAdapter,
    { listExecutable: async () => [] } as unknown as AgentRuntimeRunbookGateway,
    undefined,
    undefined,
    undefined,
    pluginRuntime,
  )
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(1_000)
  }
  throw new Error('Timed out waiting for agent runtime')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 5_000
  while (Date.now() < timeoutAt) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for agent runtime')
}

function readIntegrationTurn(): AgentRuntimeLlmAdapter {
  return {
    chatWithTools: vi.fn().mockResolvedValueOnce({
      content: 'Reading the failover document.',
      toolCalls: [{
        id: 'call-read',
        name: 'read_integration',
        args: { connectionId: connection.id, actionId: 'get_document', input: { id: 'doc-1' } },
      }],
    }).mockResolvedValueOnce({ content: 'Done.', toolCalls: [] }),
  }
}

function followUpToolContent(llmAdapter: AgentRuntimeLlmAdapter): string | undefined {
  const followUp = vi.mocked(llmAdapter.chatWithTools).mock.calls[1]?.[0] as LlmChatRequest | undefined
  const content = followUp?.messages.find((message) => message.role === 'tool')?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function knowledgePluginArtifact(riskLevel: 'read' | 'write', writeMarkerPath: string): string {
  return Buffer.from(`
exports.plugin = {
  id: 'outline',
  name: 'Outline',
  version: '1.0.0',
  description: 'Knowledge fixture.',
  auth: { fields: [] },
  actions: [{
    id: 'get_document',
    title: 'Get document',
    description: 'Get a knowledge document.',
    riskLevel: '${riskLevel}',
    fields: [{ key: 'id', label: 'ID', type: 'string', required: true }],
    execute() {
      if ('${riskLevel}' === 'write') require('fs').writeFileSync(${JSON.stringify(writeMarkerPath)}, 'written')
      return { ok: true, status: 200, data: { id: 'doc-1', text: 'Evidence' } }
    },
  }],
}
`, 'utf-8').toString('base64')
}

function createMemoryAuthStore(): DesktopPluginStoredAuthStore {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    get: async (pluginId) => records.get(pluginId) ?? {},
    set: async (pluginId, values) => {
      records.set(pluginId, values)
      return values
    },
    clear: async (pluginId) => {
      records.delete(pluginId)
    },
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

describe('direct integration reads', () => {
  it('ends a read that never completes with a timeout error and finishes the turn', async () => {
    vi.useFakeTimers()
    const llmAdapter = readIntegrationTurn()
    const hungPluginRuntime = {
      listPlugins: async () => [plugin],
      listIntegrationConnections: async () => [connection],
      // A hung plugin: the read never settles and ignores its abort signal.
      executeIntegrationAction: () => new Promise<never>(() => undefined),
    } as unknown as DesktopPluginRuntimeService
    const service = createRuntime(llmAdapter, hungPluginRuntime)

    const sessionId = await service.start({
      prompt: 'Find the database failover document',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await advanceUntil(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(followUpToolContent(llmAdapter)).toContain('INTEGRATION_READ_TIMEOUT')
    expect(followUpToolContent(llmAdapter)).toContain('No write was attempted')
  })

  it('reads an integration through the agent runtime the desktop app composes', async () => {
    const llmAdapter = readIntegrationTurn()
    const pluginRuntime = {
      listPlugins: async () => [plugin],
      listIntegrationConnections: async () => [connection],
      executeIntegrationAction: async () => ({ ok: true, status: 200, summary: 'Read', data: { text: 'Failover evidence' } }),
    } as unknown as DesktopPluginRuntimeService
    // The same wiring the app uses: its dependency object is mapped onto the runtime constructor's positional arguments.
    const service = createDesktopAgentService(
      { llmAdapter, runbookGateway: { listExecutable: async () => [] } as unknown as AgentRuntimeRunbookGateway, pluginRuntime, windowGetter: () => null },
      { AgentRuntimeService: ComposedAgentRuntimeService },
    )

    const sessionId = await service.start({
      prompt: 'Find the database failover document',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await waitFor(() => service.getStatus(sessionId).state === 'COMPLETED')

    expect(followUpToolContent(llmAdapter)).toContain('Failover evidence')
  })

  it('does not execute an action that a registry reload turns into a write', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-integration-read-'))
    tempRoots.push(tempRoot)
    const writeMarkerPath = path.join(tempRoot, 'write-executed')
    const pluginRuntime = createDesktopNodePluginRuntimeService([path.join(tempRoot, 'plugins')], createMemoryAuthStore())
    await pluginRuntime.installFromArtifact({ artifactBase64: knowledgePluginArtifact('read', writeMarkerPath) })
    await pluginRuntime.saveIntegrationConnection({
      id: connection.id,
      name: connection.name,
      pluginId: 'outline',
      enabled: true,
      auth: { apiBase: 'https://outline.example/api', accessToken: 'outline-token' },
    })
    const reloadingPluginRuntime = {
      listPlugins: () => pluginRuntime.listPlugins(),
      listIntegrationConnections: () => pluginRuntime.listIntegrationConnections(),
      executeIntegrationAction: async (...args: Parameters<DesktopPluginRuntimeService['executeIntegrationAction']>) => {
        // The registry reloads after chat validated the action as read-only.
        await pluginRuntime.installFromArtifact({ artifactBase64: knowledgePluginArtifact('write', writeMarkerPath) })
        return pluginRuntime.executeIntegrationAction(...args)
      },
    } as unknown as DesktopPluginRuntimeService
    const llmAdapter = readIntegrationTurn()
    const service = createRuntime(llmAdapter, reloadingPluginRuntime)

    const sessionId = await service.start({
      prompt: 'Find the database failover document',
      llm: { providerKey: 'anthropic', model: 'model-a' },
    })
    await waitFor(() => service.getStatus(sessionId).state === 'COMPLETED')

    await expect(access(writeMarkerPath)).rejects.toThrow()
    expect(followUpToolContent(llmAdapter)).toContain('INTEGRATION_READ_INTERRUPTED')
    expect(followUpToolContent(llmAdapter)).not.toContain('Evidence')
  })

  describe('linking what a read returned to the conversation', () => {
    const readResult = { ok: true, status: 200, data: { data: [{ document: { id: 'doc-1', title: 'Failover', url: '/doc/failover' } }], note: 'Evidence' } }
    const pluginRuntimeWith = (save: (resources: unknown[]) => Promise<void>) => ({
      listPlugins: async () => [plugin],
      listIntegrationConnections: async () => [connection],
      executeIntegrationAction: async () => readResult,
      getIntegrationResources: () => ({ save }),
    }) as unknown as DesktopPluginRuntimeService

    it('retains the linked document after a successful read', async () => {
      const save = vi.fn(async () => undefined)
      const llmAdapter = readIntegrationTurn()
      const service = createRuntime(llmAdapter, pluginRuntimeWith(save))

      const sessionId = await service.start({ prompt: 'Find the failover document', llm: { providerKey: 'anthropic', model: 'model-a' }, incidentThreadId: 'thread-1' })
      await waitFor(() => service.getStatus(sessionId).state === 'COMPLETED')

      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith([expect.objectContaining({ threadId: 'thread-1', connectionId: connection.id, externalId: 'doc-1', resourceType: 'document' })])
      expect(followUpToolContent(llmAdapter)).toContain('Evidence')
    })

    it('still returns the read result when retaining the resource fails', async () => {
      const save = vi.fn(async () => { throw new Error('resource store unavailable') })
      const llmAdapter = readIntegrationTurn()
      const service = createRuntime(llmAdapter, pluginRuntimeWith(save))

      const sessionId = await service.start({ prompt: 'Find the failover document', llm: { providerKey: 'anthropic', model: 'model-a' }, incidentThreadId: 'thread-1' })
      await waitFor(() => service.getStatus(sessionId).state === 'COMPLETED')

      expect(save).toHaveBeenCalledTimes(1)
      expect(followUpToolContent(llmAdapter)).toContain('Evidence')
      expect(followUpToolContent(llmAdapter)).toContain('the resource card could not be saved')
      expect(followUpToolContent(llmAdapter)).not.toContain('resource store unavailable')
    })
  })
})
