import { describe, expect, it } from 'vitest'

import { buildRunbookOnlyScope } from '@bitsentry-ce/coding-agents/runbook-only-scope'

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('runbook-only scope invariants', () => {
  it('keeps proposal, no-poll, and single-completion rules explicit and singular', () => {
    const scope = buildRunbookOnlyScope()
    expect(scope.length).toBeLessThanOrEqual(1_300)
    expect(countOccurrences(scope, 'Do not refuse a proposal because of its actions; the operator corrects details during review.')).toBe(1)

    expect(countOccurrences(scope, 'Proposals are pending drafts, never executions, regardless of their actions.')).toBe(1)
    expect(scope).not.toContain('Claim creation, edits, or saving only after operator approval and successful persistence.')
    expect(scope).not.toContain('Never claim a runbook was created, edited, or saved unless the operator approved the proposal and the save succeeded.')
    expect(scope).toContain('Never claim a runbook was created, edited, or saved unless the operator approved the proposal and persistence succeeded.')
    expect(scope).not.toContain('When revising a create-kind proposal, use propose_runbook_create')
    expect(scope).not.toContain('Only when a request cannot be expressed as a runbook proposal or execution at all')
    expect(scope).not.toContain('If a runbook tool call fails or appears missing')
    expect(scope).not.toContain('If list_runbooks shows required parameters')
    expect(scope).not.toContain('For incident diagnosis requiring multiple data sources')
    expect(countOccurrences(scope, 'Do not poll it.')).toBe(1)
    expect(countOccurrences(scope, 'call get_runbook_execution once with waitForCompletion: true')).toBe(1)
  })

  it('adds create-kind revision guidance only when a proposal exists', () => {
    const scope = buildRunbookOnlyScope(true)

    expect(countOccurrences(scope, 'When revising a create-kind proposal, use propose_runbook_create because the draft was never saved; when revising an edit-kind proposal, use propose_runbook_edit against the same target runbook.')).toBe(1)
  })

  it('adds Tier A and Tier B fragments only when their behavior flags are present', () => {
    const scope = buildRunbookOnlyScope({
      includeToolFailureInstructions: true,
      includeParameterInstructions: true,
      includeMultiRunbookInstructions: true,
    })

    expect(scope).toContain('If a runbook tool call fails or appears missing')
    expect(scope).toContain('If list_runbooks shows required parameters')
    expect(scope).toContain('For incident diagnosis requiring multiple data sources')
    expect(countOccurrences(scope, 'If a runbook tool call fails or appears missing')).toBe(1)
    expect(countOccurrences(scope, 'If list_runbooks shows required parameters')).toBe(1)
    expect(countOccurrences(scope, 'For incident diagnosis requiring multiple data sources')).toBe(1)
  })
})
