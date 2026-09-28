import { describe, expect, it, vi } from 'vitest'
import { IntegrationOperationService, type IntegrationWriteRuntime } from '../src/features/plugins/integration-operations'
import { StoredIntegrationOperations } from '../src/features/plugins/integration-operation-store'
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins/desktop-plugin-auth-store'

function setup() {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  const store = new StoredIntegrationOperations({ get: async (id) => records.get(id) ?? {}, set: async (id, value) => { records.set(id, value); return value }, clear: async (id) => { records.delete(id) } })
  const execute = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: 'remote-document' } })
  const runtime: IntegrationWriteRuntime = {
    connection: { id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, availability: 'configured', actions: [] },
    plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] }, execute,
  }
  const service = new IntegrationOperationService(store, async () => runtime)
  const propose = () => service.propose('thread', { connectionId: runtime.connection.id, actionId: 'create_document', input: { title: 'Exact approved title' } })
  return { service, propose, execute, runtime, store }
}
describe('durable integration approval boundary', () => {
  it('deduplicates concurrent submissions and reconnects before execution', async () => {
    const { service, propose, execute } = setup()
    const proposals = await Promise.all([propose(), propose(), propose()])
    expect(new Set(proposals.map((row) => row.id)).size).toBe(1)
    expect(await service.list('thread')).toHaveLength(1)
    await service.approve('thread', proposals[0].id, false)
    expect((await propose()).status).toBe('succeeded')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('recovers abandoned executions only after explicit inspection and makes repeats deliberate', async () => {
    const { service, propose, store, execute } = setup()
    const proposal = await propose()
    await store.transition(proposal.id, 'proposed', { status: 'executing', updatedAt: new Date(Date.now() - 180_000).toISOString() })
    expect((await service.list('thread'))[0].status).toBe('uncertain')
    await expect(service.renew('thread', proposal.id)).rejects.toThrow()
    await expect(service.reconcile('thread', proposal.id, false, false)).rejects.toThrow()
    expect((await service.reconcile('thread', proposal.id, false, true)).status).toBe('failed')
    const next = await service.renew('thread', proposal.id)
    expect(next.id).not.toBe(proposal.id)
    expect((await service.renew('thread', proposal.id)).id).toBe(next.id)
    expect(execute).not.toHaveBeenCalled()
  })

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
})

it.each([[401, 'failed', 'credentials_rejected'], [409, 'failed', 'stale_resource'], [503, 'uncertain', 'uncertain']])('records remote status %s without retrying', async (status, expected, message) => {
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
