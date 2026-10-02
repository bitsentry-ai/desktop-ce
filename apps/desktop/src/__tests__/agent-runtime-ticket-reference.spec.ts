import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentRuntimeService,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
} from '../main/features/agent-runtime/services/agent-runtime.service'
import {
  itopTicketMappingSchema,
  type DesktopPluginRuntimeService,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthStore,
} from '@bitsentry-ce/core/features/plugins'
import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'

type LlmChatRequest = Parameters<AgentRuntimeLlmAdapter['chatWithTools']>[0]

const connectionId = '11111111-1111-4111-8111-111111111111'
const threadId = 'thread-1'

// A minimal iTop: one ticket (id 12, reference R-000013). It answers a status-only read with the status alone, as iTop does.
const itopArtifact = Buffer.from(`
const fields = (...keys) => keys.map((key) => ({ key, label: key, type: ['id', 'limit', 'page'].includes(key) ? 'number' : key === 'fields' ? 'json' : 'string', required: false }))
const ticket = { ref: 'R-000013', title: 'Disk full', status: 'new', team_id: 0, agent_id: 0, request_type: 'incident' }
const objects = (outputFields) => ({ code: 0, objects: { 'UserRequest::12': { code: 0, class: 'UserRequest', key: '12',
  fields: outputFields === '*' || outputFields === undefined ? ticket : Object.fromEntries(String(outputFields).split(',').map((name) => [name, ticket[name]])) } } })
exports.plugin = {
  id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets fixture.', auth: { fields: [] },
  actions: [
    { id: 'get_object', title: 'Read', description: 'Read', riskLevel: 'read', fields: fields('class', 'id', 'outputFields'),
      execute({ input }) { return { ok: true, status: 200, summary: 'ok', data: objects(input.outputFields) } } },
    { id: 'list_objects', title: 'List', description: 'List', riskLevel: 'read', fields: fields('class', 'query', 'limit', 'page', 'outputFields'),
      execute({ input }) { return { ok: true, status: 200, summary: 'ok', data: objects(input.outputFields) } } },
    { id: 'apply_stimulus', title: 'Stimulus', description: 'Stimulus', riskLevel: 'write', fields: fields('class', 'id', 'stimulus', 'fields', 'outputFields', 'comment'),
      execute() { throw new Error('a proposal must never execute') } },
  ],
}
`, 'utf-8').toString('base64')

const mapping = itopTicketMappingSchema.parse({
  className: 'UserRequest',
  fields: { title: 'title', agent: 'agent_id', team: 'team_id', request_type: 'request_type' },
  requiredFields: { create: [], acknowledge: [], assign: ['agent'], internal_log: [], public_log: [], resolve: [], close: [] },
  stimuli: { assign: { stimulus: 'ev_assign', from: ['new'] } },
})

function createMemoryAuthStore(): DesktopPluginStoredAuthStore {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    get: async (id) => records.get(id) ?? {},
    set: async (id, values) => { records.set(id, values); return values },
    clear: async (id) => { records.delete(id) },
  }
}

function createRuntime(llmAdapter: AgentRuntimeLlmAdapter, pluginRuntime: DesktopPluginRuntimeService): AgentRuntimeService {
  return new AgentRuntimeService(
    () => null, llmAdapter, { listExecutable: async () => [] } as unknown as AgentRuntimeRunbookGateway,
    undefined, undefined, undefined, pluginRuntime,
  )
}

/** One model turn that calls ticket_operation, then a closing message. */
function ticketTurn(args: Record<string, unknown>): AgentRuntimeLlmAdapter {
  return {
    chatWithTools: vi.fn()
      .mockResolvedValueOnce({ content: 'Working on it.', toolCalls: [{ id: 'call-1', name: 'ticket_operation', args: { connectionId, ...args } }] })
      .mockResolvedValueOnce({ content: 'Done.', toolCalls: [] }),
  }
}

function toolResult(llmAdapter: AgentRuntimeLlmAdapter): string {
  const followUp = vi.mocked(llmAdapter.chatWithTools).mock.calls[1]?.[0] as LlmChatRequest | undefined
  const content = followUp?.messages.find((message) => message.role === 'tool')?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 5_000
  while (Date.now() < timeoutAt) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for agent runtime')
}

const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.length = 0
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'bitsentry-ticket-reference-'))
  tempRoots.push(root)
  const pluginRuntime = createDesktopNodePluginRuntimeService([path.join(root, 'plugins')], createMemoryAuthStore())
  await pluginRuntime.installFromArtifact({ artifactBase64: itopArtifact })
  await pluginRuntime.saveIntegrationConnection({
    id: connectionId, name: 'Itop Bitsentry', pluginId: 'itop', enabled: true, ticketMapping: mapping,
    auth: { baseUrl: 'https://itop.example', authToken: 'token' },
  })
  /** Each conversation turn is a brand-new runtime and session: nothing but the stored resources carries over. */
  const turn = async (args: Record<string, unknown>) => {
    const llmAdapter = ticketTurn(args)
    const service = createRuntime(llmAdapter, pluginRuntime)
    const sessionId = await service.start({ prompt: 'Continue.', llm: { providerKey: 'anthropic', model: 'model-a' }, incidentThreadId: threadId })
    await waitFor(() => service.getStatus(sessionId).state === 'COMPLETED')
    return toolResult(llmAdapter)
  }
  return { pluginRuntime, turn }
}

describe('following up on a ticket by its reference after a reload', () => {
  it('assigns the ticket that was read earlier, on the same connection, and keeps its card intact', async () => {
    const { pluginRuntime, turn } = await setup()

    await turn({ operation: 'read', ticketId: 'R-000013' })
    const [card] = await pluginRuntime.getIntegrationResources().list(threadId)
    expect(card).toMatchObject({ externalId: '12', connectionId, title: 'Disk full', state: { ref: 'R-000013', status: 'new' } })

    const assigned = await turn({ operation: 'assign', ticketId: 'R-000013', fields: { agent: 14, team: 39, request_type: 'incident' } })

    expect(assigned).not.toContain('CLARIFICATION_REQUIRED')
    const proposals = await pluginRuntime.getIntegrationOperations().list(threadId)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      status: 'proposed', connectionId, actionId: 'apply_stimulus', ticketOperation: 'assign',
      input: { class: 'UserRequest', id: 12, stimulus: 'ev_assign' },
    })
    // The proposal did not write, and the status pre-check did not replace the full card with a status-only one.
    expect(await pluginRuntime.getIntegrationResources().list(threadId)).toEqual([card])
  })

  it('asks for clarification, and creates no proposal, when nothing was linked for that reference', async () => {
    const { pluginRuntime, turn } = await setup()

    const assigned = await turn({ operation: 'assign', ticketId: 'R-000013', fields: { agent: 14 } })

    expect(assigned).toContain('CLARIFICATION_REQUIRED')
    expect(await pluginRuntime.getIntegrationOperations().list(threadId)).toEqual([])
  })
})
