import { describe, expect, it } from 'vitest'

import {
  normalizeJournalTimeWindowParameterValues,
  normalizeRunbookActionType,
  normalizeRunbookIdleTimeout,
  normalizeRunbookParameterValues,
  normalizeRunbookTriggerContext,
  parseRunbookExecutionSource,
  parseRunbookIdleTimeoutForUpdate,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook-ce.types'

describe('runbook type normalization', () => {
  it('normalizes idle timeouts and rejects out-of-range values', () => {
    expect(normalizeRunbookIdleTimeout('45')).toBe(45)
    expect(normalizeRunbookIdleTimeout(0)).toBe(0)
    expect(normalizeRunbookIdleTimeout('  ')).toBeUndefined()
    expect(normalizeRunbookIdleTimeout(1441)).toBeUndefined()
    expect(normalizeRunbookIdleTimeout('not-a-number')).toBeUndefined()
  })

  it('throws on invalid idle timeout updates but allows clearing', () => {
    expect(parseRunbookIdleTimeoutForUpdate('60')).toBe(60)
    expect(parseRunbookIdleTimeoutForUpdate('')).toBeUndefined()
    expect(() => parseRunbookIdleTimeoutForUpdate('9999')).toThrow(
      'Runbook idle timeout must be an integer from 0 to 1440 minutes',
    )
  })

  it('parses execution source and normalizes trigger context', () => {
    expect(parseRunbookExecutionSource('manual')).toBe('manual')
    expect(parseRunbookExecutionSource('invalid')).toBeNull()

    expect(
      normalizeRunbookTriggerContext({
        entrypoint: 'incident_workspace',
        needId: 'need-1',
        sourceType: 'github',
        sourceName: 'GitHub Issues',
        incidentThreadId: 'thread-1',
        ignored: 'value',
      }),
    ).toEqual({
      entrypoint: 'incident_workspace',
      needId: 'need-1',
      sourceType: 'github',
      sourceName: 'GitHub Issues',
      incidentThreadId: 'thread-1',
    })

    expect(normalizeRunbookTriggerContext({ entrypoint: 'invalid' })).toBeUndefined()
    expect(normalizeRunbookTriggerContext(null)).toBeUndefined()
  })

  it('preserves raw ISO-like time window parameters during general normalization', () => {
    expect(
      normalizeRunbookParameterValues({
        ' since ': '2026-05-16T13:20:00',
        until: '2026-05-16T13:22:00Z',
        from: '2026-05-16T13:20:00',
        note: '  keep surrounding spaces  ',
      }),
    ).toEqual({
      since: '2026-05-16T13:20:00',
      until: '2026-05-16T13:22:00Z',
      from: '2026-05-16T13:20:00',
      note: '  keep surrounding spaces  ',
    })
  })

  it('normalizes ISO-like time window parameters for journal-oriented shell actions', () => {
    expect(
      normalizeJournalTimeWindowParameterValues({
        ' since ': '2026-05-16T13:20:00',
        until: '2026-05-16T13:22:00Z',
        from: '2026-05-16T13:20:00',
      }),
    ).toEqual({
      since: '2026-05-16 13:20:00',
      until: '2026-05-16 13:22:00 UTC',
      from: '2026-05-16T13:20:00',
    })

    expect(
      normalizeJournalTimeWindowParameterValues({
        since: '2026-05-16T13:20:00+07:00',
      }),
    ).toEqual({
      since: '2026-05-16 06:20:00 UTC',
    })

    expect(
      normalizeJournalTimeWindowParameterValues({
        since: '1 hour ago',
      }),
    ).toEqual({
      since: '1 hour ago',
    })
  })
  it('maps legacy ai actions to llm and falls back safely', () => {
    expect(normalizeRunbookActionType('AI')).toBe('llm')
    expect(normalizeRunbookActionType('external_source')).toBe('external_source')
    expect(normalizeRunbookActionType('unknown', 'http')).toBe('http')
  })
})
