import { describe, expect, it } from 'vitest'

import {
  preserveDraftActions,
  reorderActionsById,
  rollbackRunbookReorder,
} from '../src/features/runbooks/reorder-commit'

interface TestAction {
  id: string
  title: string
  command?: string
}

interface TestRunbook {
  id: string
  title: string
  actions: TestAction[]
}

function runbook(overrides: Partial<TestRunbook> = {}): TestRunbook {
  return {
    id: 'rb-1',
    title: 'Restart web tier',
    actions: [
      { id: 'a', title: 'Check disk', command: 'df -h' },
      { id: 'b', title: 'Tail logs', command: 'tail -n 100 app.log' },
      { id: 'c', title: 'Restart', command: 'systemctl restart web' },
    ],
    ...overrides,
  }
}

describe('reorderActionsById', () => {
  it('returns the actions in the requested order', () => {
    const actions = runbook().actions

    expect(reorderActionsById(actions, ['c', 'a', 'b'])).toEqual([
      { id: 'c', title: 'Restart', command: 'systemctl restart web' },
      { id: 'a', title: 'Check disk', command: 'df -h' },
      { id: 'b', title: 'Tail logs', command: 'tail -n 100 app.log' },
    ])
  })

  it('refuses an order that is not a permutation of the current actions', () => {
    const actions = runbook().actions

    expect(reorderActionsById(actions, ['a', 'b'])).toBeNull()
    expect(reorderActionsById(actions, ['a', 'b', 'zz'])).toBeNull()
    expect(reorderActionsById(actions, ['a', 'a', 'b'])).toBeNull()
  })
})

describe('rollbackRunbookReorder', () => {
  it('puts the actions back in the order they had before the failed drag', () => {
    const dragged = runbook({
      actions: [
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'b', title: 'Tail logs', command: 'tail -n 100 app.log' },
      ],
    })

    expect(rollbackRunbookReorder(dragged, ['a', 'b', 'c'])).toEqual(runbook())
  })

  it('keeps edits the user made to another card while the save was in flight', () => {
    const dragged = runbook({
      actions: [
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'b', title: 'Tail logs', command: 'tail -f app.log' },
      ],
    })

    expect(rollbackRunbookReorder(dragged, ['a', 'b', 'c'])?.actions).toEqual([
      { id: 'a', title: 'Check disk', command: 'df -h' },
      { id: 'b', title: 'Tail logs', command: 'tail -f app.log' },
      { id: 'c', title: 'Restart', command: 'systemctl restart web' },
    ])
  })

  it('leaves the draft alone when its actions no longer match that order', () => {
    const withDeletedAction = runbook({
      actions: [
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
        { id: 'a', title: 'Check disk', command: 'df -h' },
      ],
    })

    expect(rollbackRunbookReorder(withDeletedAction, ['a', 'b', 'c'])).toEqual(
      withDeletedAction,
    )
    expect(rollbackRunbookReorder(null, ['a', 'b', 'c'])).toBeNull()
  })
})

describe('preserveDraftActions', () => {
  it('keeps unsaved draft edits while adopting the persisted order', () => {
    const draft = runbook()
    draft.actions[1] = { ...draft.actions[1], command: 'tail -f app.log' }
    const persisted = runbook({
      actions: [
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'b', title: 'Tail logs', command: 'tail -n 100 app.log' },
      ],
    })

    expect(preserveDraftActions(draft, persisted)).toEqual({
      id: 'rb-1',
      title: 'Restart web tier',
      actions: [
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'b', title: 'Tail logs', command: 'tail -f app.log' },
      ],
    })
  })

  it('adopts persisted title changes and actions the draft has never seen', () => {
    const draft = runbook({ actions: [{ id: 'a', title: 'Check disk' }] })
    const persisted = runbook({
      title: 'Restart web tier v2',
      actions: [
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'd', title: 'Added elsewhere' },
      ],
    })

    expect(preserveDraftActions(draft, persisted)).toEqual({
      id: 'rb-1',
      title: 'Restart web tier v2',
      actions: [
        { id: 'a', title: 'Check disk' },
        { id: 'd', title: 'Added elsewhere' },
      ],
    })
  })

  it('drops draft actions the persisted runbook no longer has', () => {
    const draft = runbook()
    const persisted = runbook({
      actions: [
        { id: 'a', title: 'Check disk', command: 'df -h' },
        { id: 'c', title: 'Restart', command: 'systemctl restart web' },
      ],
    })

    expect(preserveDraftActions(draft, persisted).actions).toEqual([
      { id: 'a', title: 'Check disk', command: 'df -h' },
      { id: 'c', title: 'Restart', command: 'systemctl restart web' },
    ])
  })

  it('takes the persisted runbook when no draft is open or a different one is', () => {
    const persisted = runbook()

    expect(preserveDraftActions(null, persisted)).toEqual(persisted)
    expect(
      preserveDraftActions(runbook({ id: 'rb-other' }), persisted),
    ).toEqual(persisted)
  })
})
