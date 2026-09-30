import { describe, expect, it } from 'vitest'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import { extractIntegrationResources, StoredIntegrationResources } from '../src/features/plugins/integration-resources'
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

const problemMapping = itopTicketMappingSchema.parse({
  className: 'Problem',
  referenceField: 'problem_ref',
  titleField: 'summary',
  statusField: 'lifecycle',
  fields: { owner_team: 'support_group_id', owner: 'assignee_id', headline: 'summary' },
  requiredFields: { create: [], acknowledge: [], assign: ['owner_team', 'owner'], internal_log: [], public_log: [], resolve: [], close: [] },
  stimuli: {},
})
const problem = (fields: Record<string, unknown>) => ({ objects: { 'Problem::7': { class: 'Problem', key: '7', fields } } })

describe('ticket resources for a custom ticket mapping', () => {
  it('keeps the mapped reference, state and assignment attributes and falls back to the reference for the title', () => {
    const rows = extractIntegrationResources('thread', { ...connection, ticketMapping: problemMapping }, problem({
      problem_ref: 'P-7', lifecycle: 'assigned', support_group_id: 39, assignee_id: 14, description: 'long text', private_log: 'secret',
    }))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ externalId: '7', title: 'P-7', state: { problem_ref: 'P-7', lifecycle: 'assigned', support_group_id: 39, assignee_id: 14 } })
    expect(JSON.stringify(rows)).not.toContain('secret')
    expect(rows[0]?.state).not.toHaveProperty('description')
  })

  it('uses the mapped title field first and leaves out long text', () => {
    const rows = extractIntegrationResources('thread', { ...connection, ticketMapping: problemMapping }, problem({
      problem_ref: 'P-7', summary: 'Disk full', lifecycle: 'new', support_group_id: 'x'.repeat(500),
    }))

    expect(rows[0]?.title).toBe('Disk full')
    expect(rows[0]?.state).toEqual({ problem_ref: 'P-7', lifecycle: 'new' })
  })

  it('never uses long text as a card title, even when the mapping names that attribute as the title', () => {
    const longMapping = itopTicketMappingSchema.parse({ ...problemMapping, titleField: 'description' })
    const rows = extractIntegrationResources('thread', { ...connection, ticketMapping: longMapping }, problem({
      problem_ref: 'P-7', lifecycle: 'new', description: 'y'.repeat(500),
    }))

    expect(rows[0]?.title).toBe('P-7')
    expect(JSON.stringify(rows)).not.toContain('yyyy')
  })

  it('still ignores a class that is neither mapped nor a default ticket class', () => {
    const other = { objects: { 'Change::9': { class: 'Change', key: '9', fields: { problem_ref: 'C-9' } } } }

    expect(extractIntegrationResources('thread', { ...connection, ticketMapping: problemMapping }, other)).toEqual([])
  })

  it('keeps the default state keys when the connection has no mapping', () => {
    const rows = extractIntegrationResources('thread', connection, { objects: { 'UserRequest::3': { class: 'UserRequest', key: '3', fields: { title: 'T', ref: 'R-3', status: 'new', agent_id: 14, team_id: 39, request_type: 'incident' } } } })

    expect(rows[0]?.state).toEqual({ ref: 'R-3', status: 'new', agent_id: 14, team_id: 39 })
  })
})

describe('observations that arrive out of order', () => {
  const memory = () => {
    const data = new Map<string, DesktopPluginStoredAuthRecord>()
    return { get: async (id: string) => data.get(id) ?? {}, set: async (id: string, value: DesktopPluginStoredAuthRecord) => { data.set(id, value); return value }, clear: async (id: string) => { data.delete(id) } }
  }
  const observed = (status: string, observedAt: string) => ({
    ...extractIntegrationResources('thread', connection, { objects: { 'UserRequest::42': { class: 'UserRequest', key: '42', fields: { title: 'Outage', status } } } })[0]!,
    observedAt,
  })

  it('does not let an older observation replace a newer one', async () => {
    const store = new StoredIntegrationResources(memory())
    await store.save([observed('resolved', '2026-09-30T10:00:00.000Z')])

    await store.save([observed('new', '2026-09-30T09:00:00.000Z')])

    expect((await store.list('thread'))[0]).toMatchObject({ state: { status: 'resolved' }, observedAt: '2026-09-30T10:00:00.000Z' })
  })

  it('keeps the newest observation when an older write is still in flight', async () => {
    const store = new StoredIntegrationResources(memory())

    await Promise.all([
      store.save([observed('resolved', '2026-09-30T10:00:00.000Z')]),
      store.save([observed('new', '2026-09-30T09:00:00.000Z')]),
    ])

    expect((await store.list('thread'))[0]?.state).toEqual({ status: 'resolved' })
  })

  it('replaces an observation with a newer one', async () => {
    const store = new StoredIntegrationResources(memory())
    await store.save([observed('new', '2026-09-30T09:00:00.000Z')])

    await store.save([observed('assigned', '2026-09-30T10:00:00.000Z')])

    expect((await store.list('thread'))[0]?.state).toEqual({ status: 'assigned' })
  })
})
