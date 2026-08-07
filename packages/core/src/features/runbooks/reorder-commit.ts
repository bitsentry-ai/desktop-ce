/**
 * Pure state transitions for the runbook action reorder commit path.
 *
 * The desktop editor keeps two copies of a runbook: the persisted library entry
 * and the in-progress draft the user is editing. A reorder has to move actions
 * in both, but adopting the server's action objects wholesale would discard the
 * user's unsaved edits to any other card. These helpers reorder and reconcile by
 * id so the draft keeps its own action objects wherever it already has one.
 */

export function reorderActionsById<TAction extends { id: string }>(
  actions: readonly TAction[],
  actionIdsInOrder: readonly string[],
): TAction[] | null {
  if (actionIdsInOrder.length !== actions.length) {
    return null;
  }

  const remaining = new Map(actions.map((action) => [action.id, action]));
  const next: TAction[] = [];

  for (const id of actionIdsInOrder) {
    const action = remaining.get(id);
    if (action === undefined) {
      // Unknown id, or the same id twice. Refuse rather than drop an action.
      return null;
    }

    remaining.delete(id);
    next.push(action);
  }

  return next;
}

/**
 * Undo an optimistic reorder after the save failed.
 *
 * Only the order is restored. Reinstating a pre-drag snapshot of the runbook
 * would also throw away any edit the user made to another card while the save
 * was in flight. A draft whose actions no longer match the recorded order is
 * left alone rather than forced into it.
 */
export function rollbackRunbookReorder<
  TAction extends { id: string },
  TRunbook extends { id: string; actions: TAction[] },
>(draft: TRunbook | null, previousActionIds: readonly string[]): TRunbook | null {
  if (draft === null) {
    return draft;
  }

  const restored = reorderActionsById(draft.actions, previousActionIds);
  if (restored === null) {
    return draft;
  }

  return { ...draft, actions: restored };
}

/**
 * Fold a persisted runbook into the open draft.
 *
 * Top-level fields and action order come from the persisted copy, and actions it
 * has that the draft does not are adopted as-is. Actions present in both keep
 * the draft's object, which is what preserves unsaved edits and keeps React
 * element identity stable across the commit.
 */
export function preserveDraftActions<
  TAction extends { id: string },
  TRunbook extends { id: string; actions: TAction[] },
>(draft: TRunbook | null, persisted: TRunbook): TRunbook {
  if (draft === null || draft.id !== persisted.id) {
    return persisted;
  }

  const draftActionsById = new Map(
    draft.actions.map((action) => [action.id, action]),
  );

  return {
    ...persisted,
    actions: persisted.actions.map(
      (action) => draftActionsById.get(action.id) ?? action,
    ),
  };
}
