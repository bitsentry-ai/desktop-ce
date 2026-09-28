import { describe, expect, it, vi } from 'vitest'
import { ticketOperation, ticketOperationToolSchema } from '../src/features/agent-runtime/ticket-tools'
import type { HostToolContext } from '../src/features/agent-runtime/host-tools'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import type { DesktopPluginDescriptor } from '../src/features/plugins'

const connectionId = '11111111-1111-4111-8111-111111111111'
function context(): HostToolContext {
  const mapping = itopTicketMappingSchema.parse({
    className: 'UserRequest', fields: { title: 'title', caller: 'caller_id' },
    requiredFields: { create: ['title', 'caller'], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] },
    stimuli: { close: 'ev_close' },
  })
  const plugin: DesktopPluginDescriptor = {
    id: 'itop', name: 'iTop', version: '1.0.0', type: 'data_source', description: 'Tickets', auth: { fields: [] },
    actions: ['create_object', 'update_object', 'apply_stimulus'].map((id) => ({
      id, title: id, description: id, riskLevel: 'write',
      fields: ['class', 'fields', 'id', 'outputFields', 'comment', 'stimulus'].map((key) => ({ key, label: key, type: key === 'fields' ? 'json' : key === 'id' ? 'number' : 'string', required: false })),
    })),
  }
  return {
    gateway: {} as HostToolContext['gateway'], session: { id: 'session' },
    pluginRuntime: { listPlugins: () => [plugin] },
    integrationConnections: { list: async () => [{ id: connectionId, name: 'Production', pluginId: 'itop', enabled: true, availability: 'configured', target: 'https://itop.example', actions: plugin.actions, ticketMapping: mapping }], executeRead: vi.fn() },
  }
}

describe('ticket operations', () => {
  it('asks for installation-specific required fields without calling the API', async () => {
    const host = context()
    const result = await ticketOperation(host, ticketOperationToolSchema.parse({ connectionId, operation: 'create', fields: { title: 'API outage' } }))
    expect(result.error).toContain('caller')
    expect(host.integrationConnections?.executeRead).not.toHaveBeenCalled()
  })
  it('appends public log entries in text format and explicitly identifies the audience', async () => {
    const host = context()
    const result = await ticketOperation(host, ticketOperationToolSchema.parse({ connectionId, operation: 'public_log', ticketId: '12', message: 'Investigating <now>' }))
    const preview = JSON.parse(result.output ?? '{}')
    expect(preview.publicUpdate).toBe(true)
    expect(preview.input.fields.public_log).toEqual({ add_item: { message: 'Investigating <now>', format: 'text' } })
    expect(preview.input.fields.public_log).not.toHaveProperty('items')
    expect(host.integrationConnections?.executeRead).not.toHaveBeenCalled()
  })
  it('refuses to guess a lifecycle and requires a numeric mutation target', async () => {
    const host = context()
    expect((await ticketOperation(host, ticketOperationToolSchema.parse({ connectionId, operation: 'assign', ticketId: '12' }))).error).toContain('no configured mapping')
    expect((await ticketOperation(host, ticketOperationToolSchema.parse({ connectionId, operation: 'close', ticketId: 'R-000012' }))).error).toContain('numeric external ID')
    const result = await ticketOperation(host, ticketOperationToolSchema.parse({ connectionId, operation: 'close', ticketId: '12' }))
    expect(JSON.parse(result.output ?? '{}')).toMatchObject({ requiresExplicitCloseRequest: true, requiresApproval: true })
  })
})
