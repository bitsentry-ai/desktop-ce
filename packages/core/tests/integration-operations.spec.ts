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
  const remote = { documents: [] as Array<{ id: string; title: string }>, reads: [] as string[] }
  const execute = vi.fn(async (request: Parameters<IntegrationWriteRuntime['execute']>[0]) => {
    const document = { id: 'remote-document', title: String(request.input.title ?? '') }
    remote.documents.push(document)
    return { ok: true, status: 200, data: document }
  })
  const read = vi.fn(async (request: Parameters<IntegrationWriteRuntime['read']>[0]) => {
    const id = String(request.input.id)
    remote.reads.push(id)
    const document = remote.documents.find((row) => row.id === id)
    return document === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, data: document }
  })
  const runtime: IntegrationWriteRuntime = {
    connection: { id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [] },
    plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }, { id: 'get_document', title: 'Read', description: 'Read', riskLevel: 'read', fields: [{ key: 'id', label: 'ID', type: 'string', required: true }] }] }, execute,
    read,
  }
  const service = new IntegrationOperationService(store, async () => runtime)
  const propose = () => service.propose('thread', { connectionId: runtime.connection.id, actionId: 'create_document', input: { title: 'Exact approved title' } })
  return { service, propose, execute, read, runtime, store, remote }
}
describe('durable integration approval boundary', () => {
  it('deduplicates repeated submissions across reconnects by returning the existing result', async () => {
    const { service, propose, runtime, store, remote } = setup()
    const proposals = await Promise.all([propose(), propose(), propose()])
    expect(new Set(proposals.map((row) => row.id)).size).toBe(1)
    expect(await service.list('thread')).toHaveLength(1)
    const approved = await Promise.all(proposals.map((row) => service.approve('thread', row.id, false)))
    expect(approved.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
    const reconnected = new IntegrationOperationService(store, async () => runtime)
    const repeated = await reconnected.propose('thread', { connectionId: runtime.connection.id, actionId: 'create_document', input: { title: 'Exact approved title' } })
    expect(repeated).toMatchObject({ id: proposals[0].id, status: 'succeeded' })
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
  })
  it('creates a fresh preview after the saved connection revision changes', async () => {
    const { propose, runtime, remote } = setup()
    const oldPreview = await propose()
    runtime.connection.revision = 'saved-again'
    const refreshed = await propose()
    expect(refreshed.id).not.toBe(oldPreview.id)
    expect(refreshed).toMatchObject({ status: 'proposed', connectionRevision: 'saved-again' })
    expect(remote.documents).toEqual([])
  })
  it('recovers abandoned executions only after explicit inspection and makes repeats deliberate', async () => {
    const { service, propose, store, remote } = setup()
    const proposal = await propose()
    await store.transition(proposal.id, 'proposed', { status: 'executing', updatedAt: new Date(Date.now() - 180_000).toISOString() })
    expect((await service.list('thread'))[0].status).toBe('uncertain')
    await expect(service.renew('thread', proposal.id)).rejects.toThrow()
    await expect(service.reconcile('thread', proposal.id, false, false)).rejects.toThrow()
    expect((await service.reconcile('thread', proposal.id, false, true)).status).toBe('failed')
    const next = await service.renew('thread', proposal.id)
    expect(next.id).not.toBe(proposal.id)
    expect((await service.renew('thread', proposal.id)).id).toBe(next.id)
    expect(remote.documents).toEqual([])
  })

  it('keeps an uncertain result visible and verifies the remote resource with a read before recovery', async () => {
    const { service, propose, execute, remote } = setup()
    execute.mockImplementation(async (request) => {
      remote.documents.push({ id: 'remote-document', title: String(request.input.title) })
      throw new Error('transport disconnected after the remote write')
    })
    const proposal = await propose()
    const uncertain = await service.approve('thread', proposal.id, false)
    expect(uncertain).toMatchObject({ status: 'uncertain', message: expect.stringContaining('inspect it before retrying') })
    expect(await service.list('thread')).toMatchObject([{ id: proposal.id, status: 'uncertain' }])
    const repeated = await propose()
    expect(repeated).toMatchObject({ id: proposal.id, status: 'uncertain' })
    const reconciled = await service.reconcile('thread', proposal.id, true, true, 'remote-document')
    expect(reconciled).toMatchObject({ status: 'reconciled', result: { id: 'remote-document', title: 'Exact approved title' } })
    expect(remote.reads).toEqual(['remote-document'])
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
  })

  it('does not allow reconciliation while the original write is still running, and keeps it uncertain after a late answer', async () => {
    const { service, propose, execute, runtime, store, remote } = setup()
    const reconnected = new IntegrationOperationService(store, async () => runtime)
    type ExecutionResult = Awaited<ReturnType<IntegrationWriteRuntime['execute']>>
    let finishWrite!: (result: ExecutionResult) => void
    let announceStart!: () => void
    const started = new Promise<void>((resolve) => { announceStart = resolve })
    const pendingWrite = new Promise<ExecutionResult>((resolve) => { finishWrite = resolve })
    execute.mockImplementation(async (request) => {
      announceStart()
      const result = await pendingWrite
      if (result.ok) remote.documents.push({ id: 'remote-document', title: String(request.input.title) })
      return result
    })
    const proposal = await propose()
    const approval = service.approve('thread', proposal.id, false)
    try {
      await started
      const now = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(now + 121_000)
      expect(await service.list('thread')).toMatchObject([{ id: proposal.id, status: 'uncertain', message: expect.stringContaining('still running') }])
      await expect(reconnected.reconcile('thread', proposal.id, false, true)).rejects.toThrow(/still running/i)
      finishWrite({ ok: true, status: 200, data: { id: 'remote-document' } })
      // Ownership was lost when the write was marked uncertain, so a late answer cannot turn it into a success.
      expect(await approval).toMatchObject({ status: 'uncertain' })
      expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
    } finally {
      finishWrite({ ok: true, status: 200, data: { id: 'remote-document' } })
      vi.useRealTimers()
      await approval.catch(() => {})
    }
  })

  it('persists a preview without executing and executes exact content once under concurrent approval', async () => {
    const { service, propose, remote } = setup()
    const proposal = await propose()
    expect(remote.documents).toEqual([])
    expect(await service.list('thread')).toHaveLength(1)
    const approvals = await Promise.all([service.approve('thread', proposal.id, false), service.approve('thread', proposal.id, false)])
    expect(approvals.map((row) => row.status)).toEqual(['succeeded', 'succeeded'])
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
    expect((await service.approve('thread', proposal.id, false)).status).toBe('succeeded')
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
  })
  it('rejects a proposal from another thread and a changed remote target', async () => {
    const { service, propose, runtime, remote } = setup()
    const proposal = await propose()
    await expect(service.approve('other', proposal.id, false)).rejects.toThrow()
    runtime.connection.target = 'https://another.example/api'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed')
    expect(remote.documents).toEqual([])
  })
  it('retains an uncertain outcome without automatic retry after a transport failure', async () => {
    const { service, propose, execute, remote } = setup()
    const proposal = await propose()
    execute.mockImplementation(async (request) => {
      remote.documents.push({ id: 'remote-document', title: String(request.input.title) })
      throw new Error('secret credential')
    })
    const result = await service.approve('thread', proposal.id, false)
    expect(result.status).toBe('uncertain')
    expect(JSON.stringify(result)).not.toContain('secret credential')
    await service.approve('thread', proposal.id, false)
    expect(remote.documents).toEqual([{ id: 'remote-document', title: 'Exact approved title' }])
  })
  it('never executes a rejected proposal', async () => {
    const { service, propose, remote } = setup()
    const proposal = await propose()
    await service.cancel('thread', proposal.id)
    expect((await service.approve('thread', proposal.id, true)).status).toBe('cancelled')
    expect(remote.documents).toEqual([])
  })
  it('labels a document write as public', async () => {
    const { propose } = setup()
    expect((await propose()).publicUpdate).toBe(true)
  })
  it('refuses to approve after the plugin was updated, without executing', async () => {
    const { service, propose, runtime, remote } = setup()
    const proposal = await propose()
    runtime.plugin.version = '2.0.0'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Plugin changed. Create a new preview.')
    expect(remote.documents).toEqual([])
    expect((await service.list('thread'))[0]?.status).toBe('proposed')
  })
  it('refuses to approve after the connection was edited on the same target, without executing', async () => {
    const { service, propose, runtime, remote } = setup()
    const proposal = await propose()
    runtime.connection.revision = 'saved-again'
    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed. Create a new preview.')
    expect(remote.documents).toEqual([])
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
    // `state` is an ordinary mapped field when the preview is made, and becomes the ticket state attribute afterwards.
    runtime.connection.ticketMapping = { ...mapping, fields: { ...mapping.fields, state: 'state' } }
    const proposal = await service.propose('thread', { connectionId: itopId, actionId: 'update_object', input: { class: 'UserRequest', id: 12, fields: { state: 'closed' } } }, { ticketOperation: 'internal_log' })
    runtime.connection.ticketMapping = { ...mapping, fields: { ...mapping.fields, state: 'state' }, statusField: 'state' }

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

it.each([[401, 'failed', 'credentials_rejected'], [409, 'failed', 'stale_resource'], [422, 'failed', 'remote_rejected'], [503, 'uncertain', expect.stringContaining('Inspect the remote resource')]])('records remote status %s without retrying', async (status, expected, message) => {
  const { service, propose, execute } = setup()
  const proposal = await propose()
  execute.mockResolvedValue({ ok: false, status, data: {} })
  expect(await service.approve('thread', proposal.id, false)).toMatchObject({ status: expected, message })
  await service.approve('thread', proposal.id, false)
  expect(execute).toHaveBeenCalledTimes(1)
})
it('keeps reconciliation uncertain when a read returns a different resource', async () => {
  const { service, propose, execute, runtime, store } = setup()
  const proposal = await propose()
  await store.transition(proposal.id, 'proposed', { status: 'uncertain', updatedAt: new Date().toISOString() })
  runtime.plugin.actions.push({ id: 'get_document', title: 'Read', description: 'Read', riskLevel: 'read', fields: [] })
  execute.mockResolvedValue({ ok: true, status: 200, data: { data: { id: 'wrong', title: 'Wrong', url: '/doc/wrong' } } })
  await expect(service.reconcile('thread', proposal.id, true, true, 'expected')).rejects.toThrow('exact remote resource')
  expect((await service.list('thread'))[0].status).toBe('uncertain')
})

it('refuses to propose an Outline update that does not name the revision that was read, and proposes it once it does', async () => {
  const { service, runtime } = setup()
  runtime.plugin.actions.push({ id: 'update_document', title: 'Update', description: 'Update', riskLevel: 'write', fields: [
    { key: 'id', label: 'ID', type: 'string', required: true }, { key: 'text', label: 'Text', type: 'string', required: true },
    { key: 'lastRevision', label: 'Expected revision', type: 'number', required: false },
  ] })
  const update = (input: Record<string, unknown>) => service.propose('thread', { connectionId: runtime.connection.id, actionId: 'update_document', input })

  await expect(update({ id: 'doc', text: 'New text' })).rejects.toThrow('revision')
  expect(await service.list('thread')).toEqual([])
  await expect(update({ id: 'doc', text: 'New text', lastRevision: 4 })).resolves.toMatchObject({ status: 'proposed', input: { lastRevision: 4 } })
})

it('enforces ticket mappings again at the approval boundary for generic writes', async () => {
  const { service, execute, runtime } = setup()
  runtime.connection.pluginId = 'itop'
  runtime.connection.ticketMapping = {
    className: 'UserRequest', referenceField: 'ref', titleField: 'title', internalLogField: 'private_log', publicLogField: 'public_log',
    statusField: 'status', solvedStates: ['resolved', 'closed'], fields: { title: 'title', caller: 'caller_id' }, defaults: {},
    requiredFields: { create: ['title', 'caller'], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }, stimuli: {},
  }
  runtime.plugin.id = 'itop'
  runtime.plugin.actions = [{ id: 'create_object', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'class', label: 'Class', type: 'string', required: true }, { key: 'fields', label: 'Fields', type: 'json', required: true }] }]
  const request = { connectionId: runtime.connection.id, actionId: 'create_object', input: { class: 'UserRequest', fields: { title: 'Outage' } } }
  await expect(service.propose('thread', request)).rejects.toThrow('caller')
  const proposal = await service.propose('thread', { ...request, input: { ...request.input, fields: { title: 'Outage', caller_id: 42 } } })
  runtime.connection.ticketMapping.requiredFields.create.push('organization')
  await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('organization')
  expect(execute).not.toHaveBeenCalled()
})

it('does not expire an execution using an observation made before its latest update', async () => {
  const { propose, store } = setup()
  const proposal = await propose()
  const before = '2026-09-26T11:00:00.000Z'
  const after = '2026-09-26T11:01:00.000Z'
  await store.transition(proposal.id, 'proposed', { status: 'executing', updatedAt: before })
  await store.transition(proposal.id, 'executing', { status: 'executing', updatedAt: after })
  expect(await store.transition(proposal.id, 'executing', { status: 'uncertain', updatedAt: after }, before)).toBe(false)
  expect((await store.get(proposal.id))?.status).toBe('executing')
})
