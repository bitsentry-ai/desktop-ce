import type { RunbookActionRecord } from "../../services";

/** The open step as it was when it was opened: what "unsaved changes" are measured against. */
export type ActionDraftBaseline = { id: string; snapshot: string };

export function actionDraftBaseline(
  action: RunbookActionRecord | undefined,
): ActionDraftBaseline | null {
  if (action === undefined) return null;
  return { id: action.id, snapshot: JSON.stringify(action) };
}

/**
 * Whether the open step differs from how it was when opened. Undoing an edit by hand makes it clean again. Without a
 * baseline for this step, the saved version stands in; a step that was never saved and has no baseline counts as clean.
 */
export function isActionDraftDirty(
  baseline: ActionDraftBaseline | null,
  draft: RunbookActionRecord | undefined,
  saved: RunbookActionRecord | undefined,
): boolean {
  if (draft === undefined) return false;
  if (baseline !== null && baseline.id === draft.id)
    return JSON.stringify(draft) !== baseline.snapshot;
  if (saved === undefined) return false;
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

/**
 * Escape that nothing inside the step handled. A menu or select in the step closes itself on Escape and marks the
 * event handled, and that must not also close the step.
 */
export function isUnhandledEscape(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented">,
): boolean {
  return event.key === "Escape" && !event.defaultPrevented;
}

/**
 * Why Done is unavailable, as a translation key, so the footer can say what to fix instead of showing a dead button:
 * a missing title first, then any other invalid field. Null when the step can be saved.
 */
export function saveBlockedReasonKey(
  action: Pick<RunbookActionRecord, "title">,
  canSaveAction: boolean,
): string | null {
  if (canSaveAction) return null;
  if (action.title.trim().length === 0) return "runbooks.runbook.saveNeedsTitle";
  return "runbooks.runbook.saveNeedsFixes";
}

/** Marks an Escape as handled by the open step, so a page-level listener does not act on it a second time. */
export function claimEscape(event: { preventDefault: () => void; stopPropagation: () => void }): void {
  event.preventDefault();
  event.stopPropagation();
}
