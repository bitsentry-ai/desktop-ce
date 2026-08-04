import { describe, expect, it } from 'vitest'

import { buildRunbookOnlyScope } from '@bitsentry-ce/coding-agents/runbook-only-scope'

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('runbook-only scope invariants', () => {
  it('keeps proposal, no-poll, and single-completion rules explicit and singular', () => {
    const scope = buildRunbookOnlyScope()

    expect(countOccurrences(scope, 'Proposals are pending drafts, never executions, regardless of their actions.')).toBe(1)
    expect(countOccurrences(scope, 'Claim creation, edits, or saving only after operator approval and successful persistence.')).toBe(1)
    expect(scope).not.toContain('Never claim a runbook was created, edited, or saved unless the operator approved the proposal and the save succeeded.')
    expect(countOccurrences(scope, 'Do not poll it.')).toBe(1)
    expect(countOccurrences(scope, 'call get_runbook_execution once with waitForCompletion: true')).toBe(1)
  })
})
