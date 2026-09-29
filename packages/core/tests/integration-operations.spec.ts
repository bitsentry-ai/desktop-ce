import { describe, expect, it, vi } from 'vitest'
import { IntegrationOperationService, type IntegrationWriteRuntime } from '../src/features/plugins/integration-operations'
import { StoredIntegrationOperations } from '../src/features/plugins/integration-operation-store'
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins/desktop-plugin-auth-store'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'

function memoryStore() {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return new StoredIntegrationOperations({ get: async (id) => records.get(id) ?? {}, set: async (id, value) => { records.set(id, value); return value }, clear: async (id) => { records.delete(id) } })
}

function setup() {
  const store = memoryStore()
  const execute = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: 'remote-document' } })
  const runtime: IntegrationWriteRuntime = {
    connection: { id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [] },
    plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] }, execute,
    read: vi.fn(),
  }
  const service = new IntegrationOperationService(store, async () => runtime)
  const propose = () => service.propose('thread', { connectionId: runtime.connection.id, actionId: 'create_document', input: { title: 'Exact approved title' } })
  return { service, propose, execute, runtime, store }
}
describe('durable integration approval boundary', () => {
  it('persists a preview without executing and executes exact content once under concurrent approval', async () => {
    const { service, propose, execute } = setup()
    const proposal = await propose()
    expect(execute).not.toHaveBeenCalled()
    expect(await service.list('thread')).toHaveLength(1)
    await Promise.all([service.approve('thread', proposal.id, false), service.approve('thread', proposal.id, false)])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0].input).toEqual({ title: 'Exact approved title' })
    expect((await service.approve('thread', proposal.id, false)).status).toBe('succeeded')
  })
  it('rejects a proposal from another thread and a changed remote target', async () => {
    const { service, propose, execute, runtime } = setup()
    const proposal = await propose()
    await expect(service.approve('other', proposal.id, false)).rejects.toThrow()
    runtime.connection.target = 'https://another.example/api'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed')
    expect(execute).not.toHaveBeenCalled()
  })
  it('retains an uncertain outcome without automatic retry after a transport failure', async () => {
    const { service, propose, execute } = setup()
    const proposal = await propose()
    execute.mockRejectedValue(new Error('secret credential'))
    const result = await service.approve('thread', proposal.id, false)
    expect(result.status).toBe('uncertain')
    expect(JSON.stringify(result)).not.toContain('secret credential')
    await service.approve('thread', proposal.id, false)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('never executes a rejected proposal', async () => {
    const { service, propose, execute } = setup()
    const proposal = await propose()
    await service.cancel('thread', proposal.id)
    expect((await service.approve('thread', proposal.id, true)).status).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })
  it('labels a document write as public', async () => {
    const { propose } = setup()
    expect((await propose()).publicUpdate).toBe(true)
  })
  it('refuses to approve after the plugin was updated, without executing', async () => {
    const { service, propose, execute, runtime } = setup()
    const proposal = await propose()
    runtime.plugin.version = '2.0.0'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Plugin changed. Create a new preview.')
    expect(execute).not.toHaveBeenCalled()
    expect((await service.list('thread'))[0]?.status).toBe('proposed')
  })
  it('refuses to approve after the connection was edited on the same target, without executing', async () => {
    const { service, propose, execute, runtime } = setup()
    const proposal = await propose()
    runtime.connection.revision = 'saved-again'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed. Create a new preview.')
    expect(execute).not.toHaveBeenCalled()
    expect((await service.list('thread'))[0]?.status).toBe('proposed')
  })
})

const noRequiredFields = { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }
const itopId = '22222222-2222-4222-8222-222222222222'
const fieldsOf = (...keys: string[]) => keys.map((key) => ({ key, label: key, type: key === 'id' ? 'number' as const : key === 'fields' ? 'json' as const : 'string' as const, required: ['id', 'stimulus'].includes(key) }))

function itopSetup() {
  // A fake iTop: it holds one ticket's state and records every write it receives.
  const remote = { status: 'resolved', readable: true, writes: [] as Array<Record<string, unknown>> }
  const mapping = itopTicketMappingSchema.parse({
    className: 'UserRequest', fields: { title: 'title' }, requiredFields: noRequiredFields,
    stimuli: { assign: { stimulus: 'ev_assign', from: ['new'] }, close: { stimulus: 'ev_close', from: ['resolved'] } },
  })
  const runtime: IntegrationWriteRuntime = {
    connection: { id: itopId, name: 'Itop Bitsentry', pluginId: 'itop', target: 'https://itop.example', enabled: true, authMode: 'token', availability: 'configured', actions: [], ticketMapping: mapping, revision: 'saved-once' },
    plugin: {
      id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets', type: 'data_source', auth: { fields: [] },
      actions: [
        { id: 'apply_stimulus', title: 'Transition', description: 'Transition', riskLevel: 'write', fields: fieldsOf('class', 'id', 'stimulus', 'fields', 'outputFields', 'comment') },
        { id: 'update_object', title: 'Update', description: 'Update', riskLevel: 'write', fields: fieldsOf('class', 'id', 'fields', 'outputFields', 'comment') },
        { id: 'get_object', title: 'Read', description: 'Read', riskLevel: 'read', fields: fieldsOf('class', 'id', 'outputFields') },
      ],
    },
    execute: vi.fn(async (request) => { remote.writes.push(request as unknown as Record<string, unknown>); return { ok: true, status: 200, data: { code: 0 } } }),
    read: vi.fn(async () => remote.readable
      ? { ok: true, status: 200, data: { code: 0, objects: { 'UserRequest::12': { code: 0, fields: { status: remote.status } } } } }
      : { ok: false, status: 502 }),
  } as unknown as IntegrationWriteRuntime
  const service = new IntegrationOperationService(memoryStore(), async () => runtime)
  const proposeClose = () => service.propose('thread', { connectionId: itopId, actionId: 'apply_stimulus', input: { class: 'UserRequest', id: 12, stimulus: 'ev_close' } }, { ticketOperation: 'close' })
  return { remote, runtime, service, mapping, proposeClose }
}

describe('iTop write approval re-checks what may have changed since the preview', () => {
  it('needs an explicit close request, then writes once from an allowed state', async () => {
    const { remote, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    expect(proposal).toMatchObject({ requiresCloseRequest: true, publicUpdate: false, pluginVersion: '1.0.0', connectionRevision: 'saved-once' })

    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('explicit engineer request')
    expect(remote.writes).toEqual([])

    expect((await service.approve('thread', proposal.id, true)).status).toBe('succeeded')
    expect(remote.writes).toHaveLength(1)
    expect(remote.writes[0]).toMatchObject({ actionId: 'apply_stimulus', input: { id: 12, stimulus: 'ev_close' } })
  })

  it('refuses when the ticket left the allowed state after the preview, and works again once it is back', async () => {
    const { remote, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    remote.status = 'assigned'

    await expect(service.approve('thread', proposal.id, true)).rejects.toThrow('state "assigned"')
    expect(remote.writes).toEqual([])
    expect((await service.list('thread'))[0]?.status).toBe('proposed')

    remote.status = 'resolved'
    expect((await service.approve('thread', proposal.id, true)).status).toBe('succeeded')
    expect(remote.writes).toHaveLength(1)
  })

  it('refuses when the ticket state cannot be read', async () => {
    const { remote, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    remote.readable = false

    await expect(service.approve('thread', proposal.id, true)).rejects.toThrow('Could not read the ticket state')
    expect(remote.writes).toEqual([])
  })

  it('refuses after the connection was edited on the same target', async () => {
    const { remote, runtime, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    runtime.connection.revision = 'saved-twice'

    await expect(service.approve('thread', proposal.id, true)).rejects.toThrow('Connection changed. Create a new preview.')
    expect(remote.writes).toEqual([])
  })

  it('refuses after the plugin was updated', async () => {
    const { remote, runtime, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    runtime.plugin.version = '1.1.0'

    await expect(service.approve('thread', proposal.id, true)).rejects.toThrow('Plugin changed. Create a new preview.')
    expect(remote.writes).toEqual([])
  })

  it('refuses when the configured lifecycle changed after the preview', async () => {
    const { remote, runtime, service, mapping, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    runtime.connection.ticketMapping = { ...mapping, stimuli: { ...mapping.stimuli, close: { stimulus: 'ev_finish', from: ['resolved'] } } }

    await expect(service.approve('thread', proposal.id, true)).rejects.toThrow('lifecycle transition is not configured')
    expect(remote.writes).toEqual([])
  })

  it('refuses a lifecycle proposal that does not come from a configured operation', async () => {
    const { service } = itopSetup()

    await expect(service.propose('thread', { connectionId: itopId, actionId: 'apply_stimulus', input: { class: 'UserRequest', id: 12, stimulus: 'ev_close' } })).rejects.toThrow('lifecycle transition is not configured')
    await expect(service.propose('thread', { connectionId: itopId, actionId: 'apply_stimulus', input: { class: 'UserRequest', id: 12, stimulus: 'ev_assign' } }, { ticketOperation: 'close' })).rejects.toThrow('lifecycle transition is not configured')
  })

  it('refuses a write on an iTop class that is not the mapped ticket class', async () => {
    const { service } = itopSetup()

    await expect(service.propose('thread', { connectionId: itopId, actionId: 'update_object', input: { class: 'Organization', id: 3, fields: { name: 'Acme' } } })).rejects.toThrow('matching ticket mapping')
  })

  it('labels a public log update as public and writes it without a state check', async () => {
    const { remote, service } = itopSetup()
    const proposal = await service.propose('thread', { connectionId: itopId, actionId: 'update_object', input: { class: 'UserRequest', id: 12, fields: { public_log: { add_item: { message: 'Investigating', format: 'text' } } } } }, { ticketOperation: 'public_log' })
    remote.readable = false

    expect(proposal.publicUpdate).toBe(true)
    expect((await service.approve('thread', proposal.id, false)).status).toBe('succeeded')
    expect(remote.writes).toHaveLength(1)
  })

  it.each([
    ['the common status name', 'status', 'status'],
    ['the configured state attribute', 'state', 'state'],
  ])('never proposes a direct change to %s', async (_label, statusField, attribute) => {
    const { runtime, mapping, service } = itopSetup()
    runtime.connection.ticketMapping = { ...mapping, statusField }
    const closeDirectly = (fields: Record<string, unknown>, ticketOperation: 'internal_log' | 'public_log') =>
      service.propose('thread', { connectionId: itopId, actionId: 'update_object', input: { class: 'UserRequest', id: 12, fields } }, { ticketOperation })

    await expect(closeDirectly({ [attribute]: 'closed' }, 'internal_log')).rejects.toThrow('configured lifecycle operation')
    await expect(closeDirectly({ [attribute]: 'closed', public_log: { add_item: { message: 'Done', format: 'text' } } }, 'public_log')).rejects.toThrow('configured lifecycle operation')
  })

  it('refuses an approval when the mapping now names the changed attribute as the ticket state', async () => {
    const { remote, runtime, mapping, service } = itopSetup()
    const proposal = await service.propose('thread', { connectionId: itopId, actionId: 'update_object', input: { class: 'UserRequest', id: 12, fields: { state: 'closed' } } }, { ticketOperation: 'internal_log' })
    runtime.connection.ticketMapping = { ...mapping, statusField: 'state' }

    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('configured lifecycle operation')
    expect(remote.writes).toEqual([])
  })

  it('does not write a proposal that already left the proposed state', async () => {
    const { remote, service, proposeClose } = itopSetup()
    const proposal = await proposeClose()
    await service.cancel('thread', proposal.id)

    expect((await service.approve('thread', proposal.id, true)).status).toBe('cancelled')
    expect(remote.writes).toEqual([])
  })
})
