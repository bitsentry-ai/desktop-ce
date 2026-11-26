import type { RunbookActionRecord } from "../../services";

/**
 * An open runbook step with unsaved edits, kept for this browser tab so leaving the runbook (another runbook, a
 * sidebar link, a reload) never throws typed work away. `baseline` is the step as it was when opened, so the restored
 * step still knows what counts as a change; `isNew` and `index` put a never-saved step back where it was added.
 */
export type StoredStepDraft = {
  action: RunbookActionRecord;
  baseline: string;
  isNew: boolean;
  index: number;
};

const KEY_PREFIX = "bitsentry:runbook-step-draft:";

function storageKey(runbookId: string): string {
  return `${KEY_PREFIX}${runbookId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionRecord(value: unknown): value is RunbookActionRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.type === "string"
  );
}

function isStoredStepDraft(value: unknown): value is StoredStepDraft {
  return (
    isRecord(value) &&
    isActionRecord(value.action) &&
    typeof value.baseline === "string" &&
    typeof value.isNew === "boolean" &&
    typeof value.index === "number"
  );
}

/** Keeps the unsaved step for this runbook; false when storage is unavailable (private mode, quota). */
export function writeStoredStepDraft(
  runbookId: string,
  draft: StoredStepDraft,
): boolean {
  try {
    sessionStorage.setItem(storageKey(runbookId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** The unsaved step kept for this runbook, or null when there is none or it cannot be read. */
export function readStoredStepDraft(runbookId: string): StoredStepDraft | null {
  try {
    const raw = sessionStorage.getItem(storageKey(runbookId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredStepDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Forgets the unsaved step for this runbook (saved, discarded or undone); false when storage is unavailable. */
export function clearStoredStepDraft(runbookId: string): boolean {
  try {
    sessionStorage.removeItem(storageKey(runbookId));
    return true;
  } catch {
    return false;
  }
}

/**
 * The runbook with the kept step put back: a never-saved step is inserted at its old position, an edited step replaces
 * the saved one. Null when the edited step no longer exists, so a stale draft never resurrects a deleted step.
 */
export function applyStoredStepDraft<
  T extends { actions: RunbookActionRecord[] },
>(runbook: T, draft: StoredStepDraft): T | null {
  const existing = runbook.actions.findIndex(
    (action) => action.id === draft.action.id,
  );
  if (existing !== -1) {
    const actions = [...runbook.actions];
    actions[existing] = draft.action;
    return { ...runbook, actions };
  }
  if (!draft.isNew) return null;
  const actions = [...runbook.actions];
  const at = Math.min(Math.max(draft.index, 0), actions.length);
  actions.splice(at, 0, draft.action);
  return { ...runbook, actions };
}
