import { describe, expect, it } from 'vitest'

import {
  DESKTOP_RPC_CHANNELS,
  type DesktopRpcChannel,
} from '@bitsentry-ce/components/services'
import { validateIpcPayload } from '../main/platform/app/ipc/schemas'

const UUID = '11111111-1111-4111-8111-111111111111'

function makeValidPayloads(): Record<DesktopRpcChannel, unknown> {
  const payloads = Object.fromEntries(
    DESKTOP_RPC_CHANNELS.map((channel) => [channel, {}]),
  ) as Record<DesktopRpcChannel, unknown>

  Object.assign(payloads, {
    'plugins:get': { pluginId: 'sentry' },
    'plugins:selectResource': { threadId: 'thread-1', connectionId: UUID, resourceType: 'ticket', externalId: '42', selected: true },
    'plugins:refreshResource': { threadId: 'thread-1', connectionId: UUID, resourceType: 'ticket', externalId: '42' },
    'plugins:listResources': { threadId: 'thread-1' },
    'plugins:renewOperation': { threadId: 'thread-1', id: UUID },
    'plugins:reconcileOperation': { threadId: 'thread-1', id: UUID, applied: false, confirmed: true },
    'plugins:listOperations': { threadId: 'thread-1' },
    'plugins:approveOperation': { threadId: 'thread-1', id: UUID, closeRequested: false },
    'plugins:cancelOperation': { threadId: 'thread-1', id: UUID },
    'plugins:saveConnection': { id: UUID, name: 'Production', pluginId: 'itop', auth: { baseUrl: 'https://itop.example', authToken: 'example' } },
    'plugins:removeConnection': { id: UUID },
    'plugins:getStoredAuth': { pluginId: 'sentry' },
    'plugins:updateStoredAuth': { pluginId: 'sentry', auth: {} },
    'plugins:clearStoredAuth': { pluginId: 'sentry' },
    'plugins:installFromArtifact': { artifactBase64: 'Y29uc29sZS5sb2coImhlbGxvIik=' },
    'plugins:listAvailable': {},
    'plugins:installFromIndex': { name: 'Sentry' },
    'plugins:execute': { pluginId: 'sentry', actionId: 'listIssues' },
    'errorSources:getOne': { id: 'source-1' },
    'errorSources:create': {
      pluginId: 'sentry',
      sourceType: 'sentry',
      name: 'Production',
    },
    'errorSources:update': { id: 'source-1' },
    'errorSources:delete': { id: 'source-1' },
    'errorSources:initiateOAuth': { pluginId: 'sentry', sourceType: 'sentry' },
    'errorSources:completeOAuth': {
      pluginId: 'sentry',
      sourceType: 'sentry',
      code: 'code',
      state: 'state',
    },
    'errorSources:testConnection': { id: 'source-1' },
    'errorSources:probeConnection': { pluginId: 'sentry', sourceType: 'sentry' },
    'errorIssues:list': { sourceId: 'source-1' },
    'errorEvents:list': { sourceId: 'source-1' },
    'errorEvents:getOne': { id: 'event-1' },
    'settings:updateGeneral': { data: {} },
    'settings:updateSecurity': { data: {} },
    'settings:updateNotifications': { data: {} },
    'globals:create': { key: 'region' },
    'globals:update': { id: 'global-1', patch: {} },
    'globals:delete': { id: 'global-1' },
    'settings:createAlertRule': { rule: {} },
    'settings:updateAlertRule': { ruleId: 'rule-1', data: {} },
    'settings:deleteAlertRule': { ruleId: 'rule-1' },
    'agent:start': { prompt: 'Inspect the local runbook.' },
    'agent:send': { message: 'Continue.' },
    'agent:cancel': { sessionId: UUID },
    'agent:getStatus': { sessionId: UUID },
    'agent:getSnapshot': { sessionId: UUID },
    'agent:listRunbookAuthoringProposals': {},
    'agent:approveRunbookAuthoringProposal': {
      proposalId: UUID,
      approvedOperationIds: ['operation-1'],
    },
    'agent:rejectRunbookAuthoringProposal': {
      proposalId: UUID,
      reason: 'The rollback needs more detail.',
    },
    'agent:requestRunbookAuthoringRevision': {
      proposalId: UUID,
      requestedEdit: 'Include a verification step before restarting the service.',
    },
    'agent:restoreRunbookAuthoringProposal': { proposalId: UUID },
    'runbooks:get': { id: 'runbook-1' },
    'runbooks:create': { id: UUID, title: 'Inspect logs' },
    'runbooks:updateMeta': { id: 'runbook-1' },
    'runbooks:updateActions': { runbookId: 'runbook-1', actions: [] },
    'runbooks:saveAction': {
      runbookId: 'runbook-1',
      action: { id: 'action-1', type: 'shell', title: 'Read logs' },
    },
    'runbooks:deleteAction': { runbookId: 'runbook-1', actionId: 'action-1' },
    'runbooks:reorderActions': { runbookId: 'runbook-1', actionIdsInOrder: [] },
    'runbooks:delete': { id: 'runbook-1' },
    'runbooks:exportContext': { id: 'runbook-1' },
    'runbooks:export': { ids: ['runbook-1'] },
    'runbooks:exportToFile': { ids: ['runbook-1'], filePath: '/tmp/runbooks.json' }, // eslint-disable-line sonarjs/publicly-writable-directories -- Schema fixture; no file access occurs.
    'runbooks:import': { artifact: {} },
    'runbooks:readImportArtifact': { filePath: '/tmp/runbooks.json' }, // eslint-disable-line sonarjs/publicly-writable-directories -- Schema fixture; no file access occurs.
    'runbooks:importFromFile': { filePath: '/tmp/runbooks.json', options: {} }, // eslint-disable-line sonarjs/publicly-writable-directories -- Schema fixture; no file access occurs.
    'runbooks:execute': { runbookId: 'runbook-1' },
    'runbooks:getExecution': { executionId: UUID },
    'runbooks:cancelExecution': { executionId: UUID },
  } satisfies Partial<Record<DesktopRpcChannel, unknown>>)

  return payloads
}

describe('desktop IPC schema parity', () => {
  it('derives one payload schema for every router channel', () => {
    expect([...validateIpcPayload.schemas.keys()].sort()).toEqual(
      [...DESKTOP_RPC_CHANNELS].sort(),
    )
  })

  it('accepts and rejects a contract payload for every registered channel', () => {
    const validPayloads = makeValidPayloads()

    for (const channel of DESKTOP_RPC_CHANNELS) {
      expect(validateIpcPayload(channel, validPayloads[channel])).toBeDefined()
      expect(() => validateIpcPayload(channel, null)).toThrow()
    }
  })
})
