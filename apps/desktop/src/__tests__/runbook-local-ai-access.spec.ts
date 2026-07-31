import { describe, expect, it } from 'vitest'
import {
  resolveRunbookLocalAiAccessLevel,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook-execution.service'

describe('resolveRunbookLocalAiAccessLevel', () => {
  it('defaults local providers used by runbook LLM actions to Safe Tools', () => {
    expect(resolveRunbookLocalAiAccessLevel('codex', undefined)).toBe('auto-accept-edits')
  })

  it('preserves explicit supported access levels', () => {
    expect(resolveRunbookLocalAiAccessLevel('codex', 'full-access')).toBe('full-access')
    expect(resolveRunbookLocalAiAccessLevel('opencode', 'auto-accept-edits')).toBe('auto-accept-edits')
  })
})
