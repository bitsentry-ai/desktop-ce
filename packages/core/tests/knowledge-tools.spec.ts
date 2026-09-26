import { describe, expect, it, vi } from 'vitest'
import { draftOutlinePostmortem, readSelectedKnowledge, knowledgeReferences } from '../src/features/agent-runtime/knowledge-tools'
import type { IntegrationActionInput } from '../src/features/agent-runtime/integration-tools'
import type { HostToolContext } from '../src/features/agent-runtime/host-tools'
import type { IntegrationResource } from '../src/features/plugins/integration-resources'
const source: IntegrationResource = { threadId: 'thread', connectionId: '11111111-1111-4111-8111-111111111111', connectionName: 'Knowledge', resourceType: 'document', externalId: 'doc', title: 'Evidence', url: 'https://outline.example/doc/evidence', state: {}, observedAt: '2026-09-26T00:00:00.000Z', selected: true }
describe('knowledge to runbook evidence boundaries', () => {
  it('requires engineer-selected sources before retrieving knowledge', async () => {
    const executeRead = vi.fn()
    const context = { integrationConnections: { listResources: async () => [], executeRead } } as unknown as HostToolContext
    expect((await readSelectedKnowledge(context)).error).toContain('Select')
    expect(executeRead).not.toHaveBeenCalled()
    expect(knowledgeReferences([source])).toContain(source.url)
  })
  it('proposes an unpublished postmortem with actual failed execution evidence and source references', async () => {
    const proposeWrite = vi.fn(async (request: IntegrationActionInput) => ({ id: 'proposal', ...request, status: 'proposed' }))
    const context = {
      session: { incidentThreadId: 'thread' },
      integrationConnections: { listResources: async () => [source], list: async () => [{ id: source.connectionId, pluginId: 'outline', name: 'Knowledge', target: 'https://outline.example/api', availability: 'configured' }], proposeWrite },
      pluginRuntime: { listPlugins: () => [{ id: 'outline', actions: [{ id: 'create_document', riskLevel: 'write', fields: [...['collectionId', 'title', 'text'].map((key) => ({ key, label: key, type: 'string', required: true })), { key: 'publish', label: 'Publish', type: 'boolean', required: false }] }] }] },
      gateway: { getLatestForIncidentThread: async () => ({ executionId: 'execution', runbookId: 'runbook', runbookTitle: 'Diagnosis', status: 'failed', steps: [{ title: 'Check', type: 'shell', status: 'failed', exitCode: 1 }] }) },
    } as unknown as HostToolContext
    const result = await draftOutlinePostmortem(context, { connectionId: source.connectionId, collectionId: 'collection', title: 'Postmortem', markdown: 'Draft findings' })
    expect(result.error).toBeUndefined()
    expect(proposeWrite).toHaveBeenCalledTimes(1)
    const request = proposeWrite.mock.calls[0]?.[0]
    expect(request.input.publish).toBe(false)
    expect(request.input.text).toContain(source.url)
    expect(request.input.text).toContain('"status": "failed"')
  })
})
