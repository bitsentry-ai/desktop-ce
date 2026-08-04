import { describe, expect, it } from 'vitest'

import { buildRunbookOnlyScope } from '@bitsentry-ce/coding-agents/runbook-only-scope'

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('runbook-only scope invariants', () => {
  it('keeps proposal, no-poll, and single-completion rules explicit and singular', () => {
    const scope = buildRunbookOnlyScope()
    expect(countOccurrences(scope, 'Do not refuse a proposal because of its actions; the operator corrects details during review.')).toBe(1)

    expect(countOccurrences(scope, 'Proposals are pending drafts, never executions, regardless of their actions.')).toBe(1)
    expect(scope).not.toContain('Claim creation, edits, or saving only after operator approval and successful persistence.')
    expect(scope).not.toContain('Never claim a runbook was created, edited, or saved unless the operator approved the proposal and the save succeeded.')
    expect(scope).not.toContain('When revising a create-kind proposal, use propose_runbook_create')
    expect(scope).not.toContain('Only when a request cannot be expressed as a runbook proposal or execution at all')
    expect(countOccurrences(scope, 'Do not poll it.')).toBe(1)
    expect(countOccurrences(scope, 'call get_runbook_execution once with waitForCompletion: true')).toBe(1)
  })

  it('adds create-kind revision guidance only when a proposal exists', () => {
    const scope = buildRunbookOnlyScope(true)

    expect(countOccurrences(scope, 'When revising a create-kind proposal, use propose_runbook_create because the draft was never saved; when revising an edit-kind proposal, use propose_runbook_edit against the same target runbook.')).toBe(1)
  })
})
