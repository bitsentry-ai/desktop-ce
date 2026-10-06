import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INTEGRATION_OPERATIONS_STORE_KEY,
  StoredIntegrationResources,
  itopTicketMappingSchema,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthStore,
  type IntegrationOperation,
} from '../src/features/plugins'
import { createDesktopNodePluginRuntimeService } from '../src/features/plugins/node'

const connectionId = '11111111-1111-4111-8111-111111111111'
const threadId = 'thread-1'

function memoryAuthStore(): DesktopPluginStoredAuthStore {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    get: async (id) => records.get(id) ?? {},
    set: async (id, value) => { records.set(id, value); return value },
    clear: async (id) => { records.delete(id) },
  }
}

const itopArtifact = Buffer.from(`
exports.plugin = {
  id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets fixture.', auth: { fields: [] },
  actions: [{ id: 'get_object', title: 'Read', description: 'Read', riskLevel: 'read', fields: [],
    execute() { return { ok: true, status: 200, summary: 'read', data: { ok: true } } } }],
}
`, 'utf-8').toString('base64')

const problemMapping = itopTicketMappingSchema.parse({
  className: 'Problem',
  referenceField: 'problem_ref',
  statusField: 'lifecycle',
  fields: { owner_team: 'support_group_id', owner: 'assignee_id' },
  requiredFields: { create: [], acknowledge: [], assign: ['owner_team', 'owner'], internal_log: [], public_log: [], resolve: [], close: [] },
  stimuli: {},
})

function succeededOperation(overrides: Partial<IntegrationOperation> = {}): IntegrationOperation {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    threadId,
    connectionId,
    connectionName: 'Itop Bitsentry',
    target: 'https://itop.example/webservices/rest.php',
    pluginId: 'itop',
    actionId: 'create_object',
    input: { class: 'Problem', fields: { summary: 'Disk full' } },
    publicUpdate: false,
    requiresCloseRequest: false,
    pluginVersion: '1.0.0',
    status: 'succeeded',
    createdAt: '2026-09-30T08:00:00.000Z',
    updatedAt: '2026-09-30T08:00:05.000Z',
    result: { objects: { 'Problem::7': { class: 'Problem', key: '7', fields: { problem_ref: 'P-7', lifecycle: 'assigned', support_group_id: 39, assignee_id: 14, description: 'long text' } } } },
    ...overrides,
  }
}

describe('refreshing linked resources from saved operations', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'bitsentry-resources-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function setup(operations: IntegrationOperation[]) {
    const authStore = memoryAuthStore()
    await authStore.set(INTEGRATION_OPERATIONS_STORE_KEY, { operations: JSON.stringify(operations) })
    const service = createDesktopNodePluginRuntimeService([path.join(root, 'plugins')], authStore)
    await service.installFromArtifact({ artifactBase64: itopArtifact })
    await service.saveIntegrationConnection({
      id: connectionId, name: 'Itop Bitsentry', pluginId: 'itop', enabled: true, ticketMapping: problemMapping,
      auth: { baseUrl: 'https://itop.example', authToken: 'token' },
    })
    return { authStore, service }
  }

  it('links a ticket of a custom class using the mapping saved on its connection', async () => {
    const { service } = await setup([succeededOperation()])

    const rows = await service.refreshIntegrationResources(threadId)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      connectionId, resourceType: 'ticket', externalId: '7', title: 'P-7',
      state: { problem_ref: 'P-7', lifecycle: 'assigned', support_group_id: 39, assignee_id: 14 },
    })
    expect(rows[0]?.state).not.toHaveProperty('description')
  })

  it('keeps a newer observation when the saved operation is older', async () => {
    const { authStore, service } = await setup([succeededOperation()])
    const newer = (await service.refreshIntegrationResources(threadId))[0]!
    await new StoredIntegrationResources(authStore).save([{ ...newer, state: { ...newer.state, lifecycle: 'resolved' }, observedAt: '2026-09-30T09:00:00.000Z' }])

    const rows = await service.refreshIntegrationResources(threadId)

    expect(rows[0]).toMatchObject({ state: { lifecycle: 'resolved' }, observedAt: '2026-09-30T09:00:00.000Z' })
  })

  it('still links from an operation whose connection was removed, without a mapping', async () => {
    const { service } = await setup([succeededOperation({ result: { objects: { 'UserRequest::3': { class: 'UserRequest', key: '3', fields: { title: 'T', ref: 'R-3', status: 'new' } } } } })])
    await service.removeIntegrationConnection(connectionId)

    const rows = await service.refreshIntegrationResources(threadId)

    expect(rows[0]).toMatchObject({ externalId: '3', title: 'T', state: { ref: 'R-3', status: 'new' } })
  })
})
