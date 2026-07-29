import { describe, expect, it } from 'vitest'

import { reorderRunbookActions } from '@bitsentry-ce/components/desktop/runbook/actionHelpers'

describe('runbook action ordering', () => {
  it('moves the first action to the third position without changing the source array', () => {
    const actions = [1, 2, 3, 4, 5].map((number) => ({
      id: `action-${number}`,
      type: 'shell' as const,
      title: `Action ${number}`,
    }))

    const reordered = reorderRunbookActions(actions, 0, 2)

    expect(reordered?.map((action) => action.id)).toEqual([
      'action-2',
      'action-3',
      'action-1',
      'action-4',
      'action-5',
    ])
    expect(actions.map((action) => action.id)).toEqual([
      'action-1',
      'action-2',
      'action-3',
      'action-4',
      'action-5',
    ])
  })
})
