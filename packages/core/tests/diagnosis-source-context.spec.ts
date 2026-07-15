import { describe, expect, it } from 'vitest'

import { mapDiagnosisSourceContextFromEntry } from '../src/features/diagnosis-workflow'

describe('mapDiagnosisSourceContextFromEntry', () => {
  it('preserves plugin-synced external-source events as error events when compact payloads only carry sourceType', () => {
    const context = mapDiagnosisSourceContextFromEntry({
      id: 42,
      ruleDescription: 'PostHog checkout failure',
      ruleLevel: 8,
      entrySource: {
        sourceType: 'posthog',
        sourceId: 'source-posthog',
        issueId: 'issue-1',
        eventId: 'event-1',
      },
    })

    expect(context).toMatchObject({
      sourceCategory: 'posthog',
      sourceKind: 'error_event',
      logLevel: 'application',
      severity: 'unknown',
      sourceRef: {
        sourceTableName: 'ErrorEvent',
        sourceFieldName: 'externalEventId',
      },
    })
  })
})
