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
  let saved = { ...initial, selected: true }
  const store = { list: async () => [saved], save: vi.fn(async (rows: typeof initial[]) => { saved = { ...rows[0], selected: saved.selected } }) }
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

it('ignores unsafe numeric ticket identities instead of rounding them', () => {
  expect(extractIntegrationResources('thread', connection, { objects: { 'UserRequest::9007199254740993': { class: 'UserRequest', key: '9007199254740993', fields: {} } } })).toEqual([])
})
it('retains the stored custom class when the current mapping has changed', () => {
  const rows = extractIntegrationResources('thread', connection, { objects: { 'Problem::42': { class: 'Problem', key: '42', fields: { title: 'Problem' } } } }, 'Problem')
  expect(rows[0]).toMatchObject({ externalId: '42', state: { className: 'Problem' } })
})
it('does not let delayed historical hydration overwrite a newer observation or selection', async () => {
  let value: DesktopPluginStoredAuthRecord = {}
  const store = new StoredIntegrationResources({ get: async () => value, set: async (_id, next) => { value = next; return next }, clear: async () => {} })
  const row = extractIntegrationResources('thread', connection, { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Current' } } } })[0]
  await store.save([{ ...row, observedAt: '2026-09-26T12:00:00.000Z', selected: true }])
  await store.save([{ ...row, title: 'Historical', observedAt: '2026-09-26T11:00:00.000Z' }])
  expect((await store.list('thread'))[0]).toMatchObject({ title: 'Current', selected: true })
})
