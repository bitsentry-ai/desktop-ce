import { describe, expect, it } from 'vitest'
import { ticketOperation, ticketOperationToolSchema } from '../src/features/agent-runtime/ticket-tools'
import type { HostToolContext } from '../src/features/agent-runtime/host-tools'
import type { IntegrationActionInput, IntegrationReadOptions } from '../src/features/agent-runtime/integration-tools'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import type { DesktopPluginDescriptor, IntegrationResource } from '../src/features/plugins'

const production = '11111111-1111-4111-8111-111111111111'
const staging = '22222222-2222-4222-8222-222222222222'

const noRequiredFields = { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }
// Two iTop installations with different status fields, stimuli, and lifecycles.
const mappings = {
  [production]: itopTicketMappingSchema.parse({
    className: 'UserRequest', fields: { title: 'title', caller: 'caller_id', agent: 'agent_id', priority: 'priority' },
    // A default describes a new ticket, e.g. its priority.
    defaults: { priority: 3 },
    requiredFields: { ...noRequiredFields, create: ['title', 'caller'], assign: ['agent'] },
    stimuli: {
      acknowledge: { stimulus: 'ev_assign', from: ['new'] },
      assign: { stimulus: 'ev_assign', from: ['new', 'escalated_tto'] },
      resolve: { stimulus: 'ev_resolve', from: ['assigned'] },
      close: { stimulus: 'ev_close', from: ['resolved'] },
    },
  }),
  [staging]: itopTicketMappingSchema.parse({
    className: 'Incident', statusField: 'state', fields: { title: 'title' }, requiredFields: noRequiredFields,
    stimuli: { close: { stimulus: 'ev_finish', from: ['done'] }, resolve: { stimulus: 'ev_solve' } },
  }),
}
// Remote tickets per connection; staging keeps its lifecycle in `state`, not `status`.
const tickets: Record<string, Record<number, Record<string, string>>> = {
  [production]: { 12: { status: 'resolved' }, 13: { status: 'new' }, 14: { status: 'assigned' } },
  [staging]: { 12: { state: 'done', status: 'new' } },
}

const plugin: DesktopPluginDescriptor = {
  id: 'itop', name: 'iTop', version: '1.0.0', type: 'data_source', description: 'Tickets', auth: { fields: [] },
  actions: [
    ...['get_object', 'list_objects'].map((id) => ({ id, riskLevel: 'read' as const })),
    ...['create_object', 'update_object', 'apply_stimulus'].map((id) => ({ id, riskLevel: 'write' as const })),
  ].map(({ id, riskLevel }) => ({
    id, title: id, description: id, riskLevel,
    fields: ['class', 'fields', 'id', 'outputFields', 'comment', 'stimulus', 'query', 'limit', 'page'].map((key) => ({
      key, label: key, type: key === 'fields' ? 'json' as const : ['id', 'limit', 'page'].includes(key) ? 'number' as const : 'string' as const, required: false,
    })),
  })),
}

/** Fake iTop: serves each connection's own tickets and records every action it receives. */
function remote(resources?: IntegrationResource[]) {
  const received: Array<{ connectionId: string; actionId: string; id?: unknown; options?: IntegrationReadOptions }> = []
  const context: HostToolContext = {
    gateway: {} as HostToolContext['gateway'], session: { id: 'session' },
    pluginRuntime: { listPlugins: () => [plugin] },
    integrationConnections: {
      list: async () => [production, staging].map((id) => ({
        id, name: id === production ? 'Production' : 'Staging', pluginId: 'itop' as const, enabled: true, authMode: 'token' as const,
        availability: 'configured' as const, target: 'https://itop.example', actions: plugin.actions, ticketMapping: mappings[id],
      })),
      ...(resources === undefined ? {} : { listResources: async () => resources }),
      executeRead: async (request: IntegrationActionInput, _expected?: unknown, options?: IntegrationReadOptions) => {
        received.push({ connectionId: request.connectionId, actionId: request.actionId, id: request.input.id, options })
        const id = Number(request.input.id)
        const ticket = tickets[request.connectionId]?.[id]
        if (request.actionId !== 'get_object' || ticket === undefined) return { ok: false, status: 404, summary: 'iTop object was not found' }
        return { ok: true, status: 200, summary: 'ok', data: { code: 0, objects: { [`${String(request.input.class)}::${id}`]: { code: 0, fields: ticket } } } }
      },
    },
  }
  return { context, received }
}

async function run(context: HostToolContext, input: Record<string, unknown>) {
  const result = await ticketOperation(context, ticketOperationToolSchema.parse(input))
  return {
    error: result.error === undefined ? undefined : JSON.parse(result.error) as Record<string, unknown>,
    preview: result.output === undefined ? undefined : JSON.parse(result.output) as Record<string, unknown>,
  }
}

describe('ticket operations', () => {
  it('asks for the connection’s required fields instead of guessing them', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: production, operation: 'create', fields: { title: 'API outage' } })).resolves.toEqual({
      error: expect.objectContaining({ code: 'CLARIFICATION_REQUIRED', fields: ['caller'] }), preview: undefined,
    })
    await expect(run(context, { connectionId: production, operation: 'assign', ticketId: '13' })).resolves.toEqual({
      error: expect.objectContaining({ code: 'CLARIFICATION_REQUIRED', fields: ['agent'] }), preview: undefined,
    })
  })

  it('appends public log entries in text format and explicitly identifies the audience', async () => {
    const { context } = remote()

    const { preview } = await run(context, { connectionId: production, operation: 'public_log', ticketId: '12', message: 'Investigating <now>' })

    expect(preview).toMatchObject({ publicUpdate: true, input: { fields: { public_log: { add_item: { message: 'Investigating <now>', format: 'text' } } } } })
  })

  it('uses each connection’s own status field, stimulus, and allowed states', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: production, operation: 'close', ticketId: '12' })).resolves.toMatchObject({
      preview: { status: 'preview', input: { class: 'UserRequest', id: 12, stimulus: 'ev_close' }, observedTicketState: { field: 'status', value: 'resolved', allowedStates: ['resolved'] } },
    })
    await expect(run(context, { connectionId: staging, operation: 'close', ticketId: '12' })).resolves.toMatchObject({
      preview: { status: 'preview', input: { class: 'Incident', id: 12, stimulus: 'ev_finish' }, observedTicketState: { field: 'state', value: 'done', allowedStates: ['done'] } },
    })
  })

  it('refuses a transition from a state the connection does not allow, without a proposal', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: production, operation: 'close', ticketId: '13' })).resolves.toEqual({
      error: expect.objectContaining({ code: 'INVALID_TICKET_STATE', operation: 'close', currentState: 'new', allowedStates: ['resolved'] }), preview: undefined,
    })
  })

  it('creates no proposal when the ticket state cannot be read', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: production, operation: 'resolve', ticketId: '99' })).resolves.toEqual({
      error: expect.objectContaining({ code: 'TICKET_STATE_UNAVAILABLE' }), preview: undefined,
    })
  })

  it('asks for the allowed source states when a lifecycle has none configured', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: staging, operation: 'resolve', ticketId: '12' })).resolves.toEqual({
      error: expect.objectContaining({ code: 'CLARIFICATION_REQUIRED', fields: ['resolve'] }), preview: undefined,
    })
  })

  it('refuses to guess a lifecycle and requires a numeric mutation target', async () => {
    const { context } = remote()

    await expect(run(context, { connectionId: staging, operation: 'assign', ticketId: '12' })).resolves.toMatchObject({ error: { code: 'CLARIFICATION_REQUIRED', fields: ['assign'] } })
    await expect(run(context, { connectionId: production, operation: 'close', ticketId: 'R-000012' })).resolves.toMatchObject({ error: { code: 'CLARIFICATION_REQUIRED', fields: ['ticketId'] } })
    await expect(run(context, { connectionId: production, operation: 'close', ticketId: '12' })).resolves.toMatchObject({ preview: { requiresExplicitCloseRequest: true, requiresApproval: true } })
  })

  it('turns every ticket write into a proposal and never sends a write to iTop', async () => {
    const { context, received } = remote()
    const writes = [
      { operation: 'create', fields: { title: 'API outage', caller: 'Ana' } },
      { operation: 'acknowledge', ticketId: '13' },
      { operation: 'assign', ticketId: '13', fields: { agent: 'Budi' } },
      { operation: 'internal_log', ticketId: '14', message: 'Checked the load balancer' },
      { operation: 'public_log', ticketId: '14', message: 'We are investigating' },
      { operation: 'resolve', ticketId: '14' },
      { operation: 'close', ticketId: '12' },
    ]

    for (const write of writes) {
      await expect(run(context, { connectionId: production, ...write })).resolves.toMatchObject({ preview: { status: 'preview', requiresApproval: true } })
    }
    expect(received.filter(({ actionId }) => actionId !== 'get_object')).toEqual([])
  })

  it('gives only a new ticket the mapping defaults, so a log or lifecycle change cannot overwrite existing fields', async () => {
    const { context } = remote()

    const created = await run(context, { connectionId: production, operation: 'create', fields: { title: 'API outage', caller: 'Ana' } })
    expect(created.preview).toMatchObject({ input: { fields: { title: 'API outage', caller_id: 'Ana', priority: 3 } } })

    const existing = [
      { operation: 'internal_log', ticketId: '14', message: 'Checked the load balancer' },
      { operation: 'public_log', ticketId: '14', message: 'We are investigating' },
      { operation: 'assign', ticketId: '13', fields: { agent: 'Budi' } },
      { operation: 'resolve', ticketId: '14' },
      { operation: 'close', ticketId: '12' },
    ]
    for (const change of existing) {
      const { preview } = await run(context, { connectionId: production, ...change })
      const fields = (preview?.input as { fields: Record<string, unknown> }).fields
      expect(fields).not.toHaveProperty('priority')
    }
  })
})

const stored = (connectionId: string, externalId: string, state: IntegrationResource['state']): IntegrationResource => ({
  threadId: 'thread', connectionId, connectionName: 'Production', resourceType: 'ticket', externalId,
  url: `https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=${externalId}`, title: 'Disk full', state, observedAt: '2026-09-30T09:00:00.000Z',
})
const assign = { operation: 'assign', ticketId: 'R-000013', fields: { agent: 14 } }

describe('a ticket reference in a write', () => {
  it('resolves to the numeric id of the one ticket this conversation linked on that connection', async () => {
    const { context, received } = remote([stored(production, '13', { ref: 'R-000013', status: 'new' })])

    const { error, preview } = await run(context, { connectionId: production, ...assign })

    expect(error).toBeUndefined()
    expect(preview).toMatchObject({ status: 'preview', connectionId: production, input: { class: 'UserRequest', id: 13, stimulus: 'ev_assign' }, observedTicketState: { value: 'new' } })
    expect(received).toContainEqual(expect.objectContaining({ connectionId: production, actionId: 'get_object', id: 13 }))
  })

  it('asks for clarification when no linked ticket has that reference', async () => {
    const { context } = remote([stored(production, '14', { ref: 'R-000014', status: 'assigned' })])

    await expect(run(context, { connectionId: production, ...assign })).resolves.toEqual({
      error: expect.objectContaining({ code: 'CLARIFICATION_REQUIRED', fields: ['ticketId'] }), preview: undefined,
    })
  })

  it('asks which ticket when more than one linked ticket has that reference', async () => {
    const { context, received } = remote([stored(production, '13', { ref: 'R-000013' }), stored(production, '14', { ref: 'R-000013' })])

    const { error, preview } = await run(context, { connectionId: production, ...assign })

    expect(preview).toBeUndefined()
    expect(error).toMatchObject({ code: 'CLARIFICATION_REQUIRED', fields: ['ticketId'], message: expect.stringContaining('More than one linked ticket') })
    expect(received).toEqual([])
  })

  it('never uses a ticket linked through another connection', async () => {
    const { context } = remote([stored(staging, '13', { ref: 'R-000013', state: 'new' })])

    await expect(run(context, { connectionId: production, ...assign })).resolves.toMatchObject({ error: { code: 'CLARIFICATION_REQUIRED', fields: ['ticketId'] } })
  })

  it('ignores a linked document and a resource whose state has no such reference', async () => {
    const document = { ...stored(production, '13', { ref: 'R-000013' }), resourceType: 'document' as const }
    const { context } = remote([document, stored(production, '15', { status: 'new' })])

    await expect(run(context, { connectionId: production, ...assign })).resolves.toMatchObject({ error: { code: 'CLARIFICATION_REQUIRED' } })
  })

  it('uses the connection’s own reference field, not a fixed one', async () => {
    const { context } = remote([stored(staging, '12', { reference: 'INC-12', state: 'done' })])
    mappings[staging] = itopTicketMappingSchema.parse({ ...mappings[staging], referenceField: 'reference', stimuli: { close: { stimulus: 'ev_finish', from: ['done'] } } })

    const { preview } = await run(context, { connectionId: staging, operation: 'close', ticketId: 'INC-12' })

    expect(preview).toMatchObject({ input: { class: 'Incident', id: 12, stimulus: 'ev_finish' } })
  })

  it('leaves a numeric id and every other operation untouched', async () => {
    const { context } = remote([stored(production, '99', { ref: '13' })])

    await expect(run(context, { connectionId: production, operation: 'assign', ticketId: '13', fields: { agent: 14 } })).resolves.toMatchObject({ preview: { input: { id: 13 } } })
  })
})

describe('the status check before a lifecycle proposal', () => {
  it('is an internal read that must not be retained as a resource observation', async () => {
    const { context, received } = remote()

    await run(context, { connectionId: production, operation: 'close', ticketId: '12' })

    expect(received).toEqual([expect.objectContaining({ actionId: 'get_object', id: 12, options: { capture: false } })])
  })
})
