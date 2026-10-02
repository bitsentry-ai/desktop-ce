import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../src/features/agent-runtime/shared/effect-orchestration'
import { runIntegrationTool } from '../src/features/agent-runtime/integration-tools'
import type { DesktopPluginDescriptor } from '../src/features/plugins'
import type { IntegrationConnection } from '../src/features/plugins/integration-connections'

const plugin: DesktopPluginDescriptor = {
  id: 'outline', name: 'Outline', version: '1.0.0', type: 'data_source', description: 'Knowledge',
  auth: { fields: [] },
  actions: [
    { id: 'get_document', title: 'Read', description: 'Read', riskLevel: 'read', fields: [{ key: 'id', label: 'ID', type: 'string', required: true }] },
    { id: 'update_document', title: 'Update', description: 'Update', riskLevel: 'write', fields: [
      { key: 'id', label: 'ID', type: 'string', required: true }, { key: 'text', label: 'Text', type: 'string', required: true },
      { key: 'lastRevision', label: 'Expected revision', type: 'number', required: false },
    ] },
  ],
}
const connection: IntegrationConnection = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge', pluginId: 'outline', enabled: true,
  target: 'https://outline.example/api', authMode: 'token', availability: 'configured', actions: plugin.actions,
}
const read = { connectionId: connection.id, actionId: 'get_document', input: { id: 'doc-1' } }
const failure = async (executeRead: () => Promise<unknown>) => {
  const result = await runIntegrationTool({ list: async () => [connection], executeRead: vi.fn(executeRead) as never }, [plugin], read, 'read')
  return JSON.parse(result.error ?? '{}') as { code: string; message: string }
}

describe('why an integration read stopped', () => {
  it('reports a time limit as a timeout', async () => {
    expect((await failure(async () => { throw new OrchestrationError('timeout', 'Integration read') })).code).toBe('INTEGRATION_READ_TIMEOUT')
  })

  it('reports an engineer cancellation as cancelled, never as a failure, and says nothing was written', async () => {
    const result = await failure(async () => { throw new OrchestrationError('cancelled', 'Integration read') })

    expect(result.code).toBe('INTEGRATION_READ_CANCELLED')
    expect(result.message).toContain('cancelled')
    expect(result.message).toContain('No write was attempted')
  })

  it.each([
    ['ITOP_ALLOWED_BASE_URLS', 'Add the exact iTop baseUrl to ITOP_ALLOWED_BASE_URLS on the host'],
    ['OUTLINE_ALLOWED_API_BASES', 'Self-hosted Outline requires its exact API URL in OUTLINE_ALLOWED_API_BASES on the host'],
  ])('reports a destination the host does not allow (%s) and tells the engineer what to do', async (_name, pluginMessage) => {
    const result = await failure(async () => { throw new OrchestrationError('operation', 'Integration read', new Error(pluginMessage)) })

    expect(result.code).toBe('DESTINATION_NOT_ALLOWED')
    expect(result.message).toContain('allowlist')
  })

  it.each(['Connection or plugin is unavailable.', 'Integration connection is missing or disabled.', 'Plugin unavailable.'])('reports an unavailable plugin or connection (%s)', async (message) => {
    expect((await failure(async () => { throw new OrchestrationError('operation', 'Integration read', new Error(message)) })).code).toBe('PLUGIN_UNAVAILABLE')
  })

  it('keeps an unrecognised failure generic and does not claim it was a cancellation', async () => {
    const result = await failure(async () => { throw new Error('socket hang up') })

    expect(result.code).toBe('INTEGRATION_READ_INTERRUPTED')
    expect(result.message).not.toContain('cancelled')
    expect(result.message).not.toContain('socket hang up')
  })

  it.each([[401, 'CREDENTIALS_REJECTED'], [403, 'CREDENTIALS_REJECTED'], [404, 'RESOURCE_NOT_FOUND'], [409, 'STALE_RESOURCE'], [500, 'REMOTE_READ_FAILED']])('tells a %s answer apart from the others', async (status, code) => {
    expect((await failure(async () => ({ ok: false, status }))).code).toBe(code)
  })
})

describe('a read whose card could not be saved', () => {
  it('still returns the evidence and says the link was not kept', async () => {
    const result = await runIntegrationTool({ list: async () => [connection], executeRead: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: 'doc-1' }, resourceWarning: true }) }, [plugin], read, 'read')

    expect(JSON.parse(result.output ?? '{}')).toMatchObject({ content: expect.stringContaining('doc-1'), warnings: [expect.stringContaining('could not be saved')] })
  })

  it('adds no warning when the card was kept', async () => {
    const result = await runIntegrationTool({ list: async () => [connection], executeRead: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: 'doc-1' } }) }, [plugin], read, 'read')

    expect(JSON.parse(result.output ?? '{}').warnings).toEqual([])
  })
})

describe('updating a document that may have changed since it was read', () => {
  const update = (input: Record<string, unknown>) => runIntegrationTool({ list: async () => [connection] }, [plugin], { connectionId: connection.id, actionId: 'update_document', input }, 'preview')

  it('asks for the revision that was read before it proposes an update', async () => {
    const result = await update({ id: 'doc-1', text: 'New text' })

    expect(JSON.parse(result.error ?? '{}')).toMatchObject({ code: 'CLARIFICATION_REQUIRED', fields: ['lastRevision'] })
  })

  it('previews the update once it names the revision', async () => {
    const result = await update({ id: 'doc-1', text: 'New text', lastRevision: 7 })

    expect(JSON.parse(result.output ?? '{}')).toMatchObject({ status: 'preview', requiresApproval: true, input: { lastRevision: 7 } })
  })
})
