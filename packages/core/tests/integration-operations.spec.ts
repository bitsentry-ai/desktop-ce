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
