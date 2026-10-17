import { describe, expect, it, vi } from 'vitest'
import { draftOutlinePostmortem, readSelectedKnowledge, knowledgeReferences, searchKnowledge, knowledgeSearchSchema } from '../src/features/agent-runtime/knowledge-tools'
import type { IntegrationActionInput } from '../src/features/agent-runtime/integration-tools'
import { executeHostTool } from '../src/features/agent-runtime/host-tools'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import type { DesktopPluginDescriptor } from '../src/features/plugins'
import type { HostToolContext } from '../src/features/agent-runtime/host-tools'
import type { IntegrationResource } from '../src/features/plugins/integration-resources'
const source: IntegrationResource = { threadId: 'thread', connectionId: '11111111-1111-4111-8111-111111111111', connectionName: 'Knowledge', resourceType: 'document', externalId: 'doc', title: 'Evidence', url: 'https://outline.example/doc/evidence', state: {}, observedAt: '2026-09-26T00:00:00.000Z', selected: true }
describe('knowledge to runbook evidence boundaries', () => {
  const runbookContext = (description: string, start: ReturnType<typeof vi.fn>) => ({
    session: { id: 'session', incidentThreadId: 'thread' },
    integrationConnections: { listResources: async () => [{ ...source, selected: true }] },
    gateway: { start, listExecutable: async () => [{ id: 'runbook', title: 'Check', description, actions: [] }] },
  }) as unknown as HostToolContext

  it('blocks model execution of a runbook that was created from selected knowledge', async () => {
    const start = vi.fn()
    const context = runbookContext('Check the failover.' + knowledgeReferences([source]), start)

    const result = await executeHostTool(context, 'execute_runbook', { runbookId: 'runbook' })

    expect(result?.error).toContain('engineer review')
    expect(start).not.toHaveBeenCalled()
  })

  it('still runs an unrelated saved runbook while knowledge sources are selected', async () => {
    const start = vi.fn().mockRejectedValue(new Error('started'))
    const context = runbookContext('Restart the worker.', start)

    const result = await executeHostTool(context, 'execute_runbook', { runbookId: 'runbook' })

    expect(start).toHaveBeenCalledTimes(1)
    expect(result?.error).not.toContain('engineer review')
  })

  it('requires engineer-selected sources before retrieving knowledge', async () => {
    const executeRead = vi.fn()
    const context = { integrationConnections: { listResources: async () => [], executeRead } } as unknown as HostToolContext
    expect((await readSelectedKnowledge(context)).error).toContain('Select')
    expect(executeRead).not.toHaveBeenCalled()
    expect(knowledgeReferences([source])).toContain(source.url)
  })
  it('reads a selected resource of another plugin through the read action that plugin declares', async () => {
    const entry: IntegrationResource = { ...source, connectionId: '33333333-3333-4333-8333-333333333333', connectionName: 'Timer', resourceType: 'time_entry', externalId: '42', title: 'Investigation', state: {}, selected: true }
    const timer = {
      id: 'third-party.time', name: 'Timer', version: '1', description: 'Time entries', type: 'data_source', auth: { fields: [] },
      metadata: { persistence: { configVersion: 1, destinationField: 'serviceUrl', configFields: [], resources: [{ type: 'time_entry', stateVersion: 1, readActionId: 'read_entry' }], eventChannels: [] } },
      actions: [{ id: 'read_entry', title: 'Read entry', description: 'Read entry', riskLevel: 'read', fields: [{ key: 'id', label: 'ID', type: 'number', required: true }] }],
    } as unknown as DesktopPluginDescriptor
    const reads: IntegrationActionInput[] = []
    const context = {
      session: { id: 'session', incidentThreadId: 'thread' },
      pluginRuntime: { listPlugins: () => [timer] },
      integrationConnections: {
        listResources: async () => [entry],
        list: async () => [{ id: entry.connectionId, name: 'Timer', pluginId: timer.id, enabled: true, authMode: 'token', availability: 'configured', target: 'https://timer.example.test', actions: timer.actions }],
        executeRead: async (request: IntegrationActionInput) => { reads.push(request); return { ok: true, status: 200, summary: 'ok', data: { seconds: 15 } } },
      },
    } as unknown as HostToolContext

    const result = await readSelectedKnowledge(context)

    expect(result.error).toBeUndefined()
    expect(reads).toEqual([{ connectionId: entry.connectionId, actionId: 'read_entry', input: { id: 42 } }])
    expect(JSON.parse(String(result.output)).evidence[0].result.content).toContain('15')
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

const itopConnection = '22222222-2222-4222-8222-222222222222'
const outlineConnection = '11111111-1111-4111-8111-111111111111'
const noRequiredFields = { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }
const mappingWith = (overrides: Record<string, unknown> = {}) => itopTicketMappingSchema.parse({
  className: 'UserRequest', fields: { title: 'title', solution: 'solution', rootCause: 'root_cause' }, requiredFields: noRequiredFields, stimuli: {}, ...overrides,
})
const readPlugin = (id: 'itop' | 'outline', actionId: string): DesktopPluginDescriptor => ({
  id, name: id, version: '1.0.0', type: 'data_source', description: id, auth: { fields: [] },
  actions: [{ id: actionId, title: actionId, description: actionId, riskLevel: 'read', fields: ['class', 'query', 'outputFields', 'limit', 'page', 'offset'].map((key) => ({ key, label: key, type: ['limit', 'page', 'offset'].includes(key) ? 'number' as const : 'string' as const, required: false })) }],
})

/** Runs search_knowledge against a fake connection and returns the read request the host sent. */
async function search(query: string, mapping: ReturnType<typeof mappingWith> | undefined, connection: 'itop' | 'outline' = 'itop') {
  const reads: IntegrationActionInput[] = []
  const id = connection === 'itop' ? itopConnection : outlineConnection
  const context = {
    session: { id: 'session', incidentThreadId: 'thread' },
    pluginRuntime: { listPlugins: () => [readPlugin(connection, connection === 'itop' ? 'list_objects' : 'search_documents')] },
    integrationConnections: {
      list: async () => [{ id, name: 'Source', pluginId: connection, enabled: true, authMode: 'token', availability: 'configured', target: 'https://example.test', actions: [], ticketMapping: mapping }],
      executeRead: async (request: IntegrationActionInput) => { reads.push(request); return { ok: true, status: 200, data: {} } },
    },
  } as unknown as HostToolContext
  const result = await searchKnowledge(context, knowledgeSearchSchema.parse({ connectionId: id, query }))
  return { reads, result }
}
const queryOf = (reads: IntegrationActionInput[]) => String(reads[0]?.input.query)

describe('searching earlier ticket solutions', () => {
  it('only returns tickets in a solved state, with the text match grouped so the filter applies to all of it', async () => {
    const { reads } = await search('logon failure', mappingWith())

    expect(queryOf(reads)).toBe("SELECT UserRequest WHERE (title LIKE '%logon failure%' OR solution LIKE '%logon failure%' OR root_cause LIKE '%logon failure%') AND status IN ('resolved', 'closed')")
    expect(queryOf(reads)).not.toContain("'new'")
  })

  it('uses the connection’s own status field and solved states', async () => {
    const { reads } = await search('disk', mappingWith({ className: 'Incident', statusField: 'lifecycle', solvedStates: ['done', 'closed_ok'] }))

    expect(queryOf(reads)).toContain("AND lifecycle IN ('done', 'closed_ok')")
    expect(queryOf(reads)).toContain('SELECT Incident WHERE')
  })

  it('escapes quotes and backslashes in the search text and in the solved states', async () => {
    const { reads } = await search("it's a\\path", mappingWith({ solvedStates: ["won't fix"] }))

    expect(queryOf(reads)).toContain("LIKE '%it\\'s a\\\\path%'")
    expect(queryOf(reads)).toContain("IN ('won\\'t fix')")
  })

  it('leaves the Outline search exactly as it was', async () => {
    const { reads } = await search('failover', undefined, 'outline')

    expect(reads).toEqual([{ connectionId: outlineConnection, actionId: 'search_documents', input: { query: 'failover', limit: 10, offset: 0 } }])
  })

  it('still asks for a ticket mapping before searching tickets', async () => {
    const { reads, result } = await search('logon', undefined)

    expect(reads).toEqual([])
    expect(result.error).toContain('Configure the ticket class')
  })

  it('treats resolved and closed as the solved states when a mapping says nothing', () => {
    expect(mappingWith().solvedStates).toEqual(['resolved', 'closed'])
    expect(mappingWith({ solvedStates: ['done'] }).solvedStates).toEqual(['done'])
    expect(() => mappingWith({ solvedStates: [] })).toThrow()
  })
})
