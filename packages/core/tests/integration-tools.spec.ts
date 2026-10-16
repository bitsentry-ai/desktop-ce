import { describe, expect, it, vi } from 'vitest'
import { runIntegrationTool } from '../src/features/agent-runtime/integration-tools'
import type { DesktopPluginDescriptor } from '../src/features/plugins'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import type { IntegrationConnection } from '../src/features/plugins/integration-connections'

const plugin: DesktopPluginDescriptor = {
  id: 'outline', name: 'Outline', version: '1.0.0', type: 'data_source', description: 'Knowledge',
  auth: { fields: [] },
  actions: [
    { id: 'get_document', title: 'Read', description: 'Read', riskLevel: 'read', fields: [{ key: 'id', label: 'ID', type: 'string', required: true }] },
    { id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] },
  ],
}
const connection: IntegrationConnection = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge', pluginId: 'outline', enabled: true,
  target: 'https://outline.example/api', authMode: 'token', availability: 'configured', actions: plugin.actions,
}
function port() {
  return { list: async () => [connection], executeRead: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: 'doc', text: 'Evidence' } }) }
}

describe('integration host boundaries', () => {
  it('rejects a write submitted through the read tool without invoking the remote API', async () => {
    const runtime = port()
    const result = await runIntegrationTool(runtime, [plugin], { connectionId: connection.id, actionId: 'create_document', input: { title: 'Postmortem' } }, 'read')
    expect(result.error).toContain('APPROVAL_REQUIRED')
    expect(runtime.executeRead).not.toHaveBeenCalled()
  })
  it('requests clarification for missing fields before calling the remote API', async () => {
    const runtime = port()
    const result = await runIntegrationTool(runtime, [plugin], { connectionId: connection.id, actionId: 'get_document', input: {} }, 'read')
    expect(result.error).toContain('CLARIFICATION_REQUIRED')
    expect(runtime.executeRead).not.toHaveBeenCalled()
  })
  it('does not execute a mutation preview even when the input is valid', async () => {
    const runtime = port()
    const result = await runIntegrationTool(runtime, [plugin], { connectionId: connection.id, actionId: 'create_document', input: { title: 'Postmortem' } }, 'preview')
    expect(JSON.parse(result.output ?? '{}')).toMatchObject({ status: 'preview', requiresApproval: true, target: connection.target, input: { title: 'Postmortem' } })
    expect(runtime.executeRead).not.toHaveBeenCalled()
  })
  it('redacts transport exception details and bounds model-visible evidence', async () => {
    const runtime = port()
    runtime.executeRead.mockRejectedValueOnce(new Error('token=secret'))
    const request = { connectionId: connection.id, actionId: 'get_document', input: { id: 'doc' } }
    expect((await runIntegrationTool(runtime, [plugin], request, 'read')).error).not.toContain('secret')
    runtime.executeRead.mockResolvedValueOnce({ ok: true, status: 200, data: { text: 'x'.repeat(40_000) } })
    const output = JSON.parse((await runIntegrationTool(runtime, [plugin], request, 'read')).output ?? '{}')
    expect(output.truncated).toBe(true)
    expect(output.content.length).toBeLessThanOrEqual(32_000)
  })
})


describe('ticket deadline evidence on every read path', () => {
  const mapping = itopTicketMappingSchema.parse({
    className: 'UserRequest', fields: {}, requiredFields: { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }, stimuli: {},
    deadlines: {
      timeZone: 'UTC',
      l1: { startField: 'start_date', metField: 'assignment_date', targets: { '2': 1 } },
      l2: { startField: 'assignment_date', metStates: ['resolved'], targets: { '2': 2 } },
    },
  })
  const itop: DesktopPluginDescriptor = {
    ...plugin, id: 'itop', actions: [{
      id: 'get_object', title: 'Read ticket', description: 'Read', riskLevel: 'read',
      fields: [
        { key: 'id', label: 'ID', type: 'number', required: true },
        { key: 'class', label: 'Class', type: 'string', defaultValue: 'UserRequest' },
        { key: 'outputFields', label: 'Fields', type: 'string', defaultValue: 'id' },
      ],
    }],
  }
  const ticketConnection: IntegrationConnection = {
    ...connection, pluginId: 'itop', target: 'https://itop.example', ticketMapping: mapping,
  }
  const fields = { ref: 'R-000033', title: 'Deadline control', status: 'resolved', priority: '2', start_date: '2026-10-15 15:54:21', assignment_date: '2026-10-15 15:57:53' }
  const read = { connectionId: connection.id, actionId: 'get_object', input: { class: 'UserRequest', id: 32, outputFields: '*' } }
  const runtime = () => ({
    list: async () => [ticketConnection],
    executeRead: vi.fn(async (request: typeof read) => ({ ok: true as const, status: 200, data: { objects: { 'UserRequest::32': {
      class: 'UserRequest', key: '32', fields: request.input.outputFields === '*' ? fields : {},
    } } } })),
  })

  it('returns minutes and unknown met time with the ticket read, without another resource lookup', async () => {
    const result = await runIntegrationTool(runtime(), [itop], read, 'read')
    expect(JSON.parse(result.output ?? '{}').ticketDeadlines).toEqual([{
      externalId: '32', className: 'UserRequest', deadlineStatus: {
        priority: '2',
        l1: { kind: 'met', targetMinutes: 1, dueAt: '2026-10-15T15:55:21.000Z', metAt: '2026-10-15T15:57:53.000Z', late: true },
        l2: { kind: 'met', targetMinutes: 2, dueAt: '2026-10-15T15:59:53.000Z', metAt: null, late: null },
      },
    }])
  })

  it('fetches complete mapped tickets when a generic read asks only for id', async () => {
    const port = runtime()
    const result = await runIntegrationTool(port, [itop], { ...read, input: { ...read.input, outputFields: 'id' } }, 'read')
    expect(port.executeRead).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ outputFields: '*' }) }), expect.anything())
    expect(JSON.parse(JSON.parse(result.output ?? '{}').content).objects['UserRequest::32'].fields).toEqual(fields)
  })

  it('keeps the lifecycle status precheck partial and uncaptured', async () => {
    const port = runtime()
    await runIntegrationTool(port, [itop], { ...read, input: { ...read.input, outputFields: 'status' } }, 'read', { capture: false })
    expect(port.executeRead).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ outputFields: 'status' }) }), expect.anything(), { capture: false })
  })
})
