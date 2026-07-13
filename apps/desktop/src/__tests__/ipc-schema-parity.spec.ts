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
    'errorSources:getOne': { id: 'source-1' },
    'errorSources:create': { sourceType: 'sentry', name: 'Production' },
    'errorSources:update': { id: 'source-1' },
    'errorSources:delete': { id: 'source-1' },
    'errorSources:completeOAuth': { code: 'code', state: 'state' },
    'errorSources:testConnection': { id: 'source-1' },
    'errorSources:probeConnection': { sourceType: 'sentry', authToken: 'token' },
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
    'runbooks:exportToFile': { ids: ['runbook-1'], filePath: '/tmp/runbooks.json' },
    'runbooks:import': { artifact: {} },
    'runbooks:readImportArtifact': { filePath: '/tmp/runbooks.json' },
    'runbooks:importFromFile': { filePath: '/tmp/runbooks.json', options: {} },
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

    expect(Object.keys(validPayloads).sort()).toEqual([...DESKTOP_RPC_CHANNELS].sort())
    for (const channel of DESKTOP_RPC_CHANNELS) {
      expect(validateIpcPayload(channel, validPayloads[channel])).toBeDefined()
      expect(() => validateIpcPayload(channel, null)).toThrow()
    }
  })
})
