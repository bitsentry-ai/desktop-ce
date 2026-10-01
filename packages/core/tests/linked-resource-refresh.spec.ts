import { describe, expect, it } from 'vitest'
import type { IntegrationWriteRuntime } from '../src/features/plugins'
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins'
import { extractIntegrationResources, readNamesResource, refreshLinkedIntegrationResource, StoredIntegrationResources, type IntegrationResource } from '../src/features/plugins/integration-resources'

const connectionId = '11111111-1111-4111-8111-111111111111'
const ticket = (overrides: Partial<IntegrationResource> = {}): IntegrationResource => ({
  threadId: 'thread-1', connectionId, connectionName: 'Itop', resourceType: 'ticket', externalId: '17', url: 'https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=17',
  title: 'R-000017', state: { className: 'UserRequest', ref: 'R-000017', status: 'new' }, observedAt: '2026-10-01T00:00:00.000Z', selected: true, ...overrides,
})
const document_ = (overrides: Partial<IntegrationResource> = {}): IntegrationResource => ({
  threadId: 'thread-1', connectionId, connectionName: 'Wiki', resourceType: 'document', externalId: 'doc-1', url: 'https://outline.example/doc/1',
  title: 'Failover guide', state: { revision: 3 }, observedAt: '2026-10-01T00:00:00.000Z', selected: false, ...overrides,
})
/** The real store over an in-memory credential record, so selection and newer-only rules are the ones the product has. */
function memoryStore(initial: IntegrationResource[]) {
  let value: DesktopPluginStoredAuthRecord = { resources: JSON.stringify(initial) }
  const store = new StoredIntegrationResources({ get: async () => value, set: async (_id, next) => { value = next; return next }, clear: async () => {} })
  return { store, rows: () => (JSON.parse(String(value.resources)) as IntegrationResource[]) }
}
function runtime(pluginId: 'itop' | 'outline', answer: { ok: boolean; status: number; data?: unknown }, overrides: Partial<IntegrationWriteRuntime['connection']> = {}): IntegrationWriteRuntime {
  const actions = pluginId === 'itop' ? [{ id: 'get_object', riskLevel: 'read' as const }] : [{ id: 'get_document', riskLevel: 'read' as const }]
  const read = async () => answer
  return {
    connection: { id: connectionId, name: 'Connection', pluginId, target: pluginId === 'itop' ? 'https://itop.example/' : 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [], ...overrides },
    plugin: { id: pluginId, name: pluginId, version: '1.0.0', description: '', type: 'data_source', auth: { fields: [] }, actions: actions.map((action) => ({ ...action, title: action.id, description: '', fields: [] })) },
    execute: read, read,
  } as unknown as IntegrationWriteRuntime
}
const input = (resource: IntegrationResource) => ({ threadId: resource.threadId, connectionId: resource.connectionId, resourceType: resource.resourceType, externalId: resource.externalId })
const itopAnswer = (status: string) => ({ ok: true, status: 200, data: { objects: { 'UserRequest::17': { key: '17', class: 'UserRequest', fields: { ref: 'R-000017', status, title: 'R-000017' } } } } })

describe('refreshing a linked resource', () => {
  it('replaces the card with what the remote system reports now and keeps it selected', async () => {
    const { store, rows } = memoryStore([ticket()])

    const refreshed = await refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', itopAnswer('assigned')))

    expect(refreshed).toMatchObject({ externalId: '17', selected: true, state: { status: 'assigned' } })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ state: { status: 'assigned' }, selected: true })
  })

  it('marks an iTop ticket that no longer exists as deleted and keeps what was last known', async () => {
    const { store, rows } = memoryStore([ticket()])

    const refreshed = await refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', { ok: true, status: 200, data: { objects: null } }))

    expect(refreshed.state).toMatchObject({ deleted: true, ref: 'R-000017', status: 'new' })
    expect(rows()[0]).toMatchObject({ title: 'R-000017', selected: true, state: { deleted: true, status: 'new' } })
  })

  it('marks an Outline document the remote system reports as not found as deleted and keeps what was last known', async () => {
    const { store } = memoryStore([document_({ selected: true })])

    const refreshed = await refreshLinkedIntegrationResource(input(document_()), store, runtime('outline', { ok: false, status: 404 }))

    expect(refreshed).toMatchObject({ title: 'Failover guide', selected: true, state: { revision: 3, deleted: true } })
  })

  it('clears the deleted mark when the resource is found again', async () => {
    const { store, rows } = memoryStore([ticket({ state: { className: 'UserRequest', ref: 'R-000017', status: 'new', deleted: true } })])

    await refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', itopAnswer('new')))

    expect(rows()[0]?.state.deleted).toBeUndefined()
  })

  it.each([[401, /credentials were rejected/i], [403, /credentials were rejected/i], [500, /unavailable/i]])('does not touch the card when the remote system answers %s', async (status, message) => {
    const { store, rows } = memoryStore([ticket()])

    await expect(refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', { ok: false, status }))).rejects.toThrow(message)

    expect(rows()[0]).toEqual(ticket())
  })

  it('refuses when the connection is no longer configured, without reading anything', async () => {
    const { store, rows } = memoryStore([ticket()])

    await expect(refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', itopAnswer('assigned'), { availability: 'disabled' }))).rejects.toThrow(/unavailable/i)

    expect(rows()[0]).toEqual(ticket())
  })

  it('refuses a resource that was never linked in this conversation', async () => {
    const { store } = memoryStore([])

    await expect(refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', itopAnswer('assigned')))).rejects.toThrow(/unavailable/i)
  })

  it('refreshes a ticket of a custom class after the connection mapping changed, instead of calling it deleted', async () => {
    const problem = ticket({ state: { className: 'Problem', ref: 'P-000017', status: 'new' } })
    const { store, rows } = memoryStore([problem])
    const answer = { ok: true, status: 200, data: { objects: { 'Problem::17': { key: '17', class: 'Problem', fields: { ref: 'P-000017', status: 'assigned', title: 'P-000017' } } } } }

    const refreshed = await refreshLinkedIntegrationResource(input(problem), store, runtime('itop', answer))

    expect(refreshed).toMatchObject({ state: { className: 'Problem', status: 'assigned' } })
    expect(rows()[0]?.state.deleted).toBeUndefined()
  })

  it('does not call a ticket deleted when the remote answer has it but in an unusable form', async () => {
    const { store, rows } = memoryStore([ticket()])
    const wrongClass = { ok: true, status: 200, data: { objects: { 'Problem::17': { key: '17', class: 'Problem', fields: {} } } } }

    await expect(refreshLinkedIntegrationResource(input(ticket()), store, runtime('itop', wrongClass))).rejects.toThrow(/exact resource/)

    expect(rows()[0]).toEqual(ticket())
  })

  it('refuses a ticket ID that would be rounded to a different ticket, without reading', async () => {
    const huge = ticket({ externalId: '9007199254740993' })
    const { store } = memoryStore([huge])

    await expect(refreshLinkedIntegrationResource(input(huge), store, runtime('itop', itopAnswer('assigned')))).rejects.toThrow(/supported range/)
  })

  it('keeps a newer observation that landed while the answer was in flight', async () => {
    const { store, rows } = memoryStore([ticket()])
    const slow = runtime('itop', itopAnswer('assigned'))
    const slowRead = slow.read
    slow.read = async (request) => {
      const answer = await slowRead(request)
      await store.save([ticket({ state: { className: 'UserRequest', ref: 'R-000003', status: 'resolved' }, observedAt: new Date(Date.now() + 60_000).toISOString() })])
      return answer
    }

    const refreshed = await refreshLinkedIntegrationResource(input(ticket()), store, slow)

    expect(refreshed.state.status).toBe('resolved')
    expect(rows()[0]?.state.status).toBe('resolved')
  })
})

describe('reading a ticket ID or class from a stored link', () => {
  const mapping = { objects: { 'Problem::42': { class: 'Problem', key: '42', fields: { title: 'Problem' } } } }
  const connection = { id: connectionId, name: 'Itop', pluginId: 'itop' as const, target: 'https://itop.example/', ticketMapping: undefined }

  it('ignores a ticket ID too large to read back exactly', () => {
    expect(extractIntegrationResources('thread-1', connection, { objects: { 'UserRequest::9007199254740993': { class: 'UserRequest', key: '9007199254740993', fields: {} } } })).toEqual([])
  })

  it('keeps the class the link was stored with when the current mapping differs', () => {
    expect(extractIntegrationResources('thread-1', connection, mapping)).toEqual([])
    expect(extractIntegrationResources('thread-1', connection, mapping, 'Problem')[0]).toMatchObject({ externalId: '42', state: { className: 'Problem' } })
  })
})

describe('whether a read answer names the resource', () => {
  it('recognises an iTop ticket from its key and class, or from the map key alone', () => {
    const full = { objects: { 'UserRequest::12': { key: '12', class: 'UserRequest', fields: {} } } }
    const keyedOnly = { objects: { 'UserRequest::12': { code: 0, fields: {} } } }

    expect(readNamesResource('itop', full, '12', 'UserRequest')).toBe(true)
    expect(readNamesResource('itop', keyedOnly, '12', 'UserRequest')).toBe(true)
  })

  it('does not accept another ticket, another class, or no object at all', () => {
    const answer = { objects: { 'UserRequest::12': { key: '12', class: 'UserRequest', fields: {} } } }

    expect(readNamesResource('itop', answer, '13', 'UserRequest')).toBe(false)
    expect(readNamesResource('itop', answer, '12', 'Problem')).toBe(false)
    expect(readNamesResource('itop', { objects: null }, '12')).toBe(false)
  })

  it('recognises an Outline document by its id, wrapped or not, and nothing else', () => {
    expect(readNamesResource('outline', { data: { id: 'doc-1' } }, 'doc-1')).toBe(true)
    expect(readNamesResource('outline', { id: 'doc-1' }, 'doc-1')).toBe(true)
    expect(readNamesResource('outline', { data: { id: 'doc-2' } }, 'doc-1')).toBe(false)
  })
})
