import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseRecordedProviderEvents,
  replayRecordedProviderEvents,
} from '@bitsentry-ce/coding-agents/recorded-event-replay'

const fixturePath = resolve(
  __dirname,
  'fixtures/cancelled-codex-events.jsonl',
)

describe('recorded coding-agent event replay', () => {
  it('replays redacted recorded events and suppresses output after cancellation', () => {
    const recording = readFileSync(fixturePath, 'utf8')
    const replay = replayRecordedProviderEvents(parseRecordedProviderEvents(recording))

    expect(replay).toEqual({
      deltas: ['Checking the deployment.'],
      permissions: ['rejected'],
      terminalStatus: 'cancelled',
      ignoredAfterTerminal: 1,
    })
    expect(replay.deltas.join('')).not.toContain('late output')
    expect(recording).not.toContain('token-')
  })

  it('rejects malformed JSONL before it can be replayed', () => {
    expect(() => parseRecordedProviderEvents('{not json}')).toThrow(
      'Recorded provider event line 1 is not valid JSON',
    )
  })

  it('rejects out-of-order event sequences', () => {
    const events = parseRecordedProviderEvents([
      '{"provider":"cursor","sequence":2,"type":"delta","text":"two"}',
      '{"provider":"cursor","sequence":1,"type":"terminal","status":"completed"}',
    ].join('\n'))

    expect(() => replayRecordedProviderEvents(events)).toThrow(
      'Recorded provider events must have strictly increasing sequence numbers',
    )
  })

  it.each(['codex', 'cursor', 'claude_code', 'opencode'] as const)(
    'replays the provider-neutral %s event contract without retaining secrets',
    (provider) => {
      const recording = [
        JSON.stringify({ provider, sequence: 1, type: 'delta', text: '[secure:token]' }),
        JSON.stringify({ provider, sequence: 2, type: 'permission', permission: 'granted' }),
        JSON.stringify({ provider, sequence: 3, type: 'terminal', status: 'completed' }),
      ].join('\n')

      const replay = replayRecordedProviderEvents(parseRecordedProviderEvents(recording))

      expect(replay).toEqual({
        deltas: ['[secure:token]'],
        permissions: ['granted'],
        terminalStatus: 'completed',
        ignoredAfterTerminal: 0,
      })
      expect(recording).not.toContain('raw-secret-token')
    },
  )
})
