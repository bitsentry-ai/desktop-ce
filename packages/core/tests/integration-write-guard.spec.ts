import { describe, expect, it } from 'vitest'
import { executeHostTool, type HostToolContext } from '../src/features/agent-runtime/host-tools'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import type { DesktopPluginDescriptor } from '../src/features/plugins'

const mappedConnection = '11111111-1111-4111-8111-111111111111'
const unmappedConnection = '22222222-2222-4222-8222-222222222222'

const field = (key: string, type: 'string' | 'number' | 'json', required = false, defaultValue?: string) => ({
  key, label: key, type, required, ...(defaultValue === undefined ? {} : { defaultValue }),
})
const classField = field('class', 'string', false, 'UserRequest')
const common = [field('outputFields', 'string', false, '*'), field('comment', 'string')]
// Mirrors the write actions of the real iTop plugin, including the default class.
const plugin: DesktopPluginDescriptor = {
  id: 'itop', name: 'iTop', version: '1.0.0', type: 'data_source', description: 'Tickets', auth: { fields: [] },
  actions: [
    { id: 'create_object', fields: [classField, field('fields', 'json', true), ...common] },
    { id: 'update_object', fields: [classField, field('id', 'number', true), field('fields', 'json', true), ...common] },
    { id: 'apply_stimulus', fields: [classField, field('id', 'number', true), field('stimulus', 'string', true), field('fields', 'json'), ...common] },
  ].map((action) => ({ ...action, title: action.id, description: action.id, riskLevel: 'write' as const })),
}
const mapping = itopTicketMappingSchema.parse({
  className: 'UserRequest', fields: { title: 'title' },
  requiredFields: { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] },
  stimuli: {},
})

function context(): HostToolContext {
  const connection = (id: string, name: string, ticketMapping?: typeof mapping) => ({
    id, name, pluginId: 'itop' as const, enabled: true, authMode: 'token' as const, availability: 'configured' as const,
    target: 'https://itop.example', actions: plugin.actions, ...(ticketMapping === undefined ? {} : { ticketMapping }),
  })
  return {
    gateway: {} as HostToolContext['gateway'], session: { id: 'session' },
    pluginRuntime: { listPlugins: () => [plugin] },
    integrationConnections: {
      list: async () => [connection(mappedConnection, 'Mapped', mapping), connection(unmappedConnection, 'Unmapped')],
    },
  }
}

async function proposeWrite(connectionId: string, actionId: string, input: Record<string, unknown>) {
  const result = await executeHostTool(context(), 'propose_integration_write', { connectionId, actionId, input })
  return {
    error: result?.error === undefined ? undefined : JSON.parse(result.error) as { code: string },
    preview: result?.output === undefined ? undefined : JSON.parse(result.output) as Record<string, unknown>,
  }
}

const ticketWrites: Array<[string, Record<string, unknown>]> = [
  ['create_object', { class: 'UserRequest', fields: { title: 'API outage' } }],
  ['update_object', { class: 'UserRequest', id: 12, fields: { title: 'Renamed' } }],
  ['apply_stimulus', { class: 'UserRequest', id: 12, stimulus: 'ev_close' }],
]

describe('generic iTop write proposals', () => {
  it.each(ticketWrites)('refuses a generic %s on a connection without a ticket mapping', async (actionId, input) => {
    await expect(proposeWrite(unmappedConnection, actionId, input)).resolves.toEqual({
      error: expect.objectContaining({ code: 'TICKET_MAPPING_REQUIRED' }), preview: undefined,
    })
  })

  it.each(ticketWrites)('refuses a generic %s on the mapped ticket class', async (actionId, input) => {
    await expect(proposeWrite(mappedConnection, actionId, input)).resolves.toEqual({
      error: expect.objectContaining({ code: 'USE_TICKET_OPERATION' }), preview: undefined,
    })
  })

  it('refuses a generic write that leaves the class out or changes its case', async () => {
    // The plugin defaults the class to UserRequest, so omitting it still targets the mapped class.
    await expect(proposeWrite(mappedConnection, 'create_object', { fields: { title: 'API outage' } })).resolves.toMatchObject({
      error: { code: 'USE_TICKET_OPERATION' }, preview: undefined,
    })
    await expect(proposeWrite(mappedConnection, 'create_object', { class: 'userrequest', fields: { title: 'API outage' } })).resolves.toMatchObject({
      error: { code: 'USE_TICKET_OPERATION' }, preview: undefined,
    })
  })

  it('still previews a generic write on an iTop class that is not the mapped ticket class', async () => {
    await expect(proposeWrite(mappedConnection, 'create_object', { class: 'Organization', fields: { name: 'Acme' } })).resolves.toMatchObject({
      error: undefined, preview: { status: 'preview', requiresApproval: true, input: { class: 'Organization' } },
    })
  })

  it('still lets ticket_operation propose a write on the mapped class', async () => {
    const result = await executeHostTool(context(), 'ticket_operation', {
      connectionId: mappedConnection, operation: 'create', fields: { title: 'API outage' },
    })

    expect(result?.error).toBeUndefined()
    expect(JSON.parse(result?.output ?? '{}')).toMatchObject({
      status: 'preview', requiresApproval: true, ticketOperation: 'create', input: { class: 'UserRequest' },
    })
  })
})
