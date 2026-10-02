import { describe, expect, it, vi } from 'vitest'
import { runIntegrationTool } from '../src/features/agent-runtime/integration-tools'
import type { DesktopPluginDescriptor } from '../src/features/plugins'
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
