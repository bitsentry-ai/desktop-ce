import { describe, expect, it, vi } from 'vitest'
import { extractIntegrationResources, refreshLinkedIntegrationResource, StoredIntegrationResources } from '../src/features/plugins/integration-resources'
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins/desktop-plugin-auth-store'
const connection = { id: '11111111-1111-4111-8111-111111111111', name: 'Production', pluginId: 'itop' as const, target: 'https://itop.example' }
describe('thread integration resources', () => {
  it('retains stable ticket identities and useful state without retaining ticket content', () => {
    const rows = extractIntegrationResources('thread', connection, { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Database outage', ref: 'R-42', status: 'assigned', private_log: 'sensitive text' } } } })
    expect(rows[0]).toMatchObject({ connectionId: connection.id, resourceType: 'ticket', externalId: '42', state: { ref: 'R-42', status: 'assigned' } })
    expect(rows[0]?.url).toContain('id=42')
    expect(JSON.stringify(rows)).not.toContain('sensitive text')
  })
  it('links Outline search results and rejects foreign or script source URLs', () => {
    const outline = { ...connection, pluginId: 'outline' as const, target: 'https://outline.example/api' }
    const rows = extractIntegrationResources('thread', outline, { data: [{ document: { id: 'good', title: 'Runbook', url: '/doc/runbook' } }, { document: { id: 'foreign', url: 'https://evil.example/doc' } }, { document: { id: 'script', url: 'javascript:alert(1)' } }] })
    expect(rows.map((row) => row.externalId)).toEqual(['good'])
  })
  it('persists cards across store reload and isolates threads and connections', async () => {
    const data = new Map<string, DesktopPluginStoredAuthRecord>()
    const credentials = { get: async (id: string) => data.get(id) ?? {}, set: async (id: string, value: DesktopPluginStoredAuthRecord) => { data.set(id, value); return value }, clear: async (id: string) => { data.delete(id) } }
    const rows = extractIntegrationResources('thread', connection, { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Outage' } } } })
    await new StoredIntegrationResources(credentials).save(rows)
    const reloaded = new StoredIntegrationResources(credentials)
    expect(await reloaded.list('thread')).toHaveLength(1)
    expect(await reloaded.list('other')).toHaveLength(0)
    await reloaded.save(rows)
    expect(await reloaded.list('thread')).toHaveLength(1)
  })
})

it('refreshes only an existing linked resource and preserves source selection', async () => {
  const initial = extractIntegrationResources('thread', connection, { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Old', status: 'new' } } } })[0]
  const store = { list: async () => [{ ...initial, selected: true }], save: vi.fn() }
  const runtime = {
    connection: { ...connection, enabled: true, availability: 'configured' as const, actions: [] },
    plugin: { id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets', type: 'data_source' as const, auth: { fields: [] }, actions: [{ id: 'get_object', title: 'Read', description: 'Read', riskLevel: 'read' as const, fields: [] }] },
    execute: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Current', status: 'assigned' } } } } }),
  }
  const input = { threadId: 'thread', connectionId: connection.id, resourceType: 'ticket' as const, externalId: '42' }
  expect(await refreshLinkedIntegrationResource(input, store, runtime)).toMatchObject({ title: 'Current', state: { status: 'assigned' }, selected: true })
  await expect(refreshLinkedIntegrationResource({ ...input, externalId: '43' }, store, runtime)).rejects.toThrow('unavailable')
  expect(runtime.execute).toHaveBeenCalledTimes(1)
})
