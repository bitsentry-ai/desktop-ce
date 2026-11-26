import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { rollbackRunbookReorder } from "@bitsentry-ce/core";
import {
  canPersistRunbookAction,
  createDraftAction,
  reorderRunbookActions,
} from "./actionHelpers";
import { cloneRunbook } from "./runbookRecordHelpers";
import {
  actionDraftBaseline,
  isActionDraftDirty,
  type ActionDraftBaseline,
} from "./actionDraftGuard";
import {
  applyStoredStepDraft,
  clearStoredStepDraft,
  readStoredStepDraft,
  writeStoredStepDraft,
} from "./stepDraftStore";
import type {
  DesktopRpcChannel,
  RunbookActionRecord,
  RunbookRecord,
} from "../../services";
import type { DraftReconcileMode } from "./useRunbookCatalogFlow";
import type { LlmModelOption } from "./RunbookActionFieldShared";

type DesktopIpcInvoke = <T>(
  channel: DesktopRpcChannel,
  payload?: unknown,
) => Promise<T>;

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type SortableSourceLike = {
  initialIndex: number;
  index: number;
};

type DesktopDragEndEvent = {
  canceled?: boolean;
  operation: {
    source: unknown;
  };
};

type UseRunbookActionEditorFlowOptions = {
  activeRunbook: RunbookRecord | null;
  activeEditingRunbook: RunbookRecord | null;
  setEditingRunbook: Dispatch<SetStateAction<RunbookRecord | null>>;
  ipcInvoke: DesktopIpcInvoke;
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent;
  summarizeRunbookForTelemetry: (runbook: RunbookRecord) => Record<string, unknown>;
  summarizeRunbookActionForTelemetry: (action: RunbookActionRecord) => Record<string, unknown>;
  replaceRunbook: (
    updated: RunbookRecord,
    draftMode?: DraftReconcileMode,
  ) => void;
  validErrorSourceIds: Set<string>;
  validPluginActionIdsByPluginId: Map<string, Set<string>>;
  llmModelOptions?: LlmModelOption[];
  /** Tells the user a step did not save; the open step keeps their edits so they can try again. */
  onActionSaveFailed?: (error: unknown) => void;
};

export function useRunbookActionEditorFlow({
  activeRunbook,
  activeEditingRunbook,
  setEditingRunbook,
  ipcInvoke,
  captureDesktopAnalyticsEvent,
  summarizeRunbookForTelemetry,
  summarizeRunbookActionForTelemetry,
  replaceRunbook,
  validErrorSourceIds,
  validPluginActionIdsByPluginId,
  llmModelOptions = [],
  onActionSaveFailed,
}: UseRunbookActionEditorFlowOptions) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] =
    useState<ActionDraftBaseline | null>(null);
  const [unsavedNudge, setUnsavedNudge] = useState(0);
  const [savingActionId, setSavingActionId] = useState<string | null>(null);
  const expandedCardRef = useRef<HTMLDivElement | null>(null);
  const tempActionIdsRef = useRef(new Set<string>());
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const [logFilterSamples, setLogFilterSamples] = useState<
    Record<string, string>
  >({});
  const suppressExpandOnNextClickRef = useRef(false);

  const resetActionEditorState = useCallback(() => {
    setExpandedId(null);
    setDraftBaseline(null);
    setUnsavedNudge(0);
    tempActionIdsRef.current.clear();
  }, []);

  useEffect(() => {
    resetActionEditorState();
  }, [activeRunbook?.id, resetActionEditorState]);

  const restoreCheckedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeEditingRunbook === null) {
      restoreCheckedForRef.current = null;
      return;
    }
    if (restoreCheckedForRef.current === activeEditingRunbook.id) return;
    restoreCheckedForRef.current = activeEditingRunbook.id;
    const stored = readStoredStepDraft(activeEditingRunbook.id);
    if (stored === null) return;
    const restored = applyStoredStepDraft(activeEditingRunbook, stored);
    if (restored === null) {
      clearStoredStepDraft(activeEditingRunbook.id);
      return;
    }
    if (stored.isNew) tempActionIdsRef.current.add(stored.action.id);
    setEditingRunbook(restored);
    setDraftBaseline({ id: stored.action.id, snapshot: stored.baseline });
    setUnsavedNudge(0);
    setExpandedId(stored.action.id);
  }, [activeEditingRunbook, setEditingRunbook]);

  useEffect(() => {
    setModelDropdownOpen(false);
  }, [expandedId]);

  useEffect(() => {
    if (!modelDropdownOpen) {
      return;
    }

    const handler = (event: MouseEvent) => {
      if (
        modelDropdownRef.current !== null &&
        !modelDropdownRef.current.contains(event.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [modelDropdownOpen]);

  const collapse = useCallback(() => {
    setUnsavedNudge(0);
    if (activeEditingRunbook !== null) clearStoredStepDraft(activeEditingRunbook.id);
    if (activeEditingRunbook === null || expandedId === null) {
      setExpandedId(null);
      return;
    }

    if (tempActionIdsRef.current.has(expandedId)) {
      const abandonedAction = activeEditingRunbook.actions.find(
        (action) => action.id === expandedId,
      );
      tempActionIdsRef.current.delete(expandedId);
      if (abandonedAction !== undefined) {
        captureDesktopAnalyticsEvent("desktop_runbook_action_draft_abandoned", {
          ...summarizeRunbookForTelemetry(activeEditingRunbook),
          ...summarizeRunbookActionForTelemetry(abandonedAction),
        });
      }
      setEditingRunbook((prev) => {
        if (prev === null) {
          return prev;
        }

        return {
          ...prev,
          actions: prev.actions.filter((action) => action.id !== expandedId),
        };
      });
      setExpandedId(null);
      return;
    }

    if (activeRunbook === null) {
      setExpandedId(null);
      return;
    }

    const persistedAction = activeRunbook.actions.find(
      (action) => action.id === expandedId,
    );
    if (persistedAction !== undefined) {
      setEditingRunbook((prev) => {
        if (prev === null) {
          return prev;
        }

        return {
          ...prev,
          actions: prev.actions.map((action) => {
            if (action.id === expandedId) {
              return { ...persistedAction };
            }

            return action;
          }),
        };
      });
    }

    setExpandedId(null);
  }, [
    activeEditingRunbook,
    activeRunbook,
    captureDesktopAnalyticsEvent,
    expandedId,
    setEditingRunbook,
    summarizeRunbookActionForTelemetry,
    summarizeRunbookForTelemetry,
  ]);

  const expandedDraftDirty = isActionDraftDirty(
    draftBaseline,
    expandedId === null
      ? undefined
      : activeEditingRunbook?.actions.find((action) => action.id === expandedId),
    expandedId === null
      ? undefined
      : activeRunbook?.actions.find((action) => action.id === expandedId),
  );

  const nudgeUnsavedDraft = useCallback(() => {
    setUnsavedNudge((count) => count + 1);
    expandedCardRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, []);

  /** A click outside the open step, or Escape: closes it, unless that would throw away unsaved edits. */
  const requestCollapse = useCallback(() => {
    if (expandedDraftDirty) {
      nudgeUnsavedDraft();
      return;
    }
    collapse();
  }, [collapse, expandedDraftDirty, nudgeUnsavedDraft]);

  useEffect(() => {
    if (expandedId === null) {
      return;
    }

    const handler = (event: MouseEvent) => {
      if (
        expandedCardRef.current !== null &&
        !expandedCardRef.current.contains(event.target as Node)
      ) {
        requestCollapse();
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 50);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [requestCollapse, expandedId]);

  const keepStepDraft = (action: RunbookActionRecord) => {
    if (activeEditingRunbook === null || action.id !== expandedId) return;
    const dirty = isActionDraftDirty(
      draftBaseline,
      action,
      activeRunbook?.actions.find((saved) => saved.id === action.id),
    );
    if (!dirty) {
      clearStoredStepDraft(activeEditingRunbook.id);
      return;
    }
    writeStoredStepDraft(activeEditingRunbook.id, {
      action,
      baseline: draftBaseline?.snapshot ?? JSON.stringify(action),
      isNew: tempActionIdsRef.current.has(action.id),
      index: activeEditingRunbook.actions.findIndex((item) => item.id === action.id),
    });
  };

  const handleUpdateActionDraft = (updatedAction: RunbookActionRecord) => {
    keepStepDraft(updatedAction);
    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      return {
        ...prev,
        actions: prev.actions.map((action) => {
          if (action.id === updatedAction.id) {
            return updatedAction;
          }

          return action;
        }),
      };
    });
  };

  const handleAddActionAt = (insertAt: number) => {
    if (activeEditingRunbook === null) {
      return;
    }
    if (expandedDraftDirty) {
      nudgeUnsavedDraft();
      return;
    }

    const newAction = createDraftAction();
    setDraftBaseline(actionDraftBaseline(newAction));
    setUnsavedNudge(0);
    tempActionIdsRef.current.add(newAction.id);
    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      return {
        ...prev,
        actions: [
          ...prev.actions.slice(0, insertAt),
          newAction,
          ...prev.actions.slice(insertAt),
        ],
      };
    });
    setExpandedId(newAction.id);
    captureDesktopAnalyticsEvent("desktop_runbook_action_draft_started", {
      ...summarizeRunbookForTelemetry(activeEditingRunbook),
      insert_position: insertAt,
      draft_action_type: newAction.type,
    });
  };

  const handleSaveAction = async (actionId: string) => {
    if (activeEditingRunbook === null || savingActionId !== null) {
      return;
    }

    const action = activeEditingRunbook.actions.find(
      (item) => item.id === actionId,
    );
    if (action === undefined) {
      return;
    }

    if (
      !canPersistRunbookAction(
        action,
        validErrorSourceIds,
        validPluginActionIdsByPluginId,
        llmModelOptions,
      )
    ) {
      return;
    }

    setSavingActionId(actionId);
    try {
      const updated = await ipcInvoke<RunbookRecord>("runbooks:saveAction", {
        runbookId: activeEditingRunbook.id,
        action: {
          ...action,
          sortOrder: activeEditingRunbook.actions.findIndex(
            (item) => item.id === action.id,
          ),
        },
      });
      tempActionIdsRef.current.delete(actionId);
      clearStoredStepDraft(activeEditingRunbook.id);
      replaceRunbook(updated);
      setExpandedId(null);
      setSavingActionId(null);
      captureDesktopAnalyticsEvent("desktop_runbook_action_saved", {
        ...summarizeRunbookForTelemetry(updated),
        ...summarizeRunbookActionForTelemetry(action),
      });
    } catch (error) {
      setSavingActionId(null);
      console.error("Failed to save runbook action:", error);
      onActionSaveFailed?.(error);
    }
  };

  const handleDeleteAction = async (actionId: string) => {
    if (activeEditingRunbook === null) {
      return;
    }

    const actionToDelete = activeEditingRunbook.actions.find(
      (action) => action.id === actionId,
    );
    const previousRunbook = cloneRunbook(activeRunbook);
    setExpandedId(null);
    tempActionIdsRef.current.delete(actionId);
    const stored = readStoredStepDraft(activeEditingRunbook.id);
    if (stored?.action.id === actionId) clearStoredStepDraft(activeEditingRunbook.id);

    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      return {
        ...prev,
        actions: prev.actions.filter((action) => action.id !== actionId),
      };
    });

    try {
      const updated = await ipcInvoke<RunbookRecord>("runbooks:deleteAction", {
        runbookId: activeEditingRunbook.id,
        actionId,
      });
      replaceRunbook(updated);
      if (actionToDelete !== undefined) {
        captureDesktopAnalyticsEvent("desktop_runbook_action_deleted", {
          ...summarizeRunbookForTelemetry(updated),
          ...summarizeRunbookActionForTelemetry(actionToDelete),
        });
      }
    } catch (error) {
      console.error("Failed to delete runbook action:", error);
      setEditingRunbook(previousRunbook);
    }
  };

  const handleReorder = async (nextActions: RunbookActionRecord[]) => {
    if (activeEditingRunbook === null) {
      return;
    }

    const previousActionIds = activeEditingRunbook.actions.map(
      (action) => action.id,
    );
    setEditingRunbook((prev) => {
      if (prev === null) {
        return prev;
      }

      return {
        ...prev,
        actions: nextActions,
      };
    });

    try {
      const updated = await ipcInvoke<RunbookRecord>(
        "runbooks:reorderActions",
        {
          runbookId: activeEditingRunbook.id,
          actionIdsInOrder: nextActions.map((action) => action.id),
        },
      );
      // A reorder must not adopt the server's action objects: another card may
      // be expanded with unsaved edits that only exist in the draft.
      replaceRunbook(updated, "preserve-actions");
      captureDesktopAnalyticsEvent("desktop_runbook_actions_reordered", {
        ...summarizeRunbookForTelemetry(updated),
      });
    } catch (error) {
      console.error("Failed to reorder runbook actions:", error);
      setEditingRunbook((prev) =>
        rollbackRunbookReorder(prev, previousActionIds),
      );
    }
  };

  const handleActionDragEnd = (event: DesktopDragEndEvent, isSortable: (value: unknown) => value is SortableSourceLike) => {
    const revalidateActionOrder = () => {
      setEditingRunbook((prev) => {
        if (prev === null) {
          return prev;
        }

        return { ...prev, actions: [...prev.actions] };
      });
    };

    window.setTimeout(() => {
      suppressExpandOnNextClickRef.current = false;
    }, 0);
    if (event.canceled) {
      revalidateActionOrder();
      return;
    }

    const source = event.operation.source;
    if (source === null || !isSortable(source)) {
      revalidateActionOrder();
      return;
    }

    const { initialIndex, index } = source;
    const actions = activeEditingRunbook?.actions ?? [];
    const next = reorderRunbookActions(actions, initialIndex, index);
    if (next === null) {
      revalidateActionOrder();
      return;
    }

    void handleReorder(next);
  };

  const handleActionDragStart = () => {
    suppressExpandOnNextClickRef.current = true;
  };

  const handleActionCardClick = (actionId: string) => {
    if (suppressExpandOnNextClickRef.current) {
      suppressExpandOnNextClickRef.current = false;
      return;
    }
    if (expandedDraftDirty && actionId !== expandedId) {
      nudgeUnsavedDraft();
      return;
    }

    setDraftBaseline(
      actionDraftBaseline(
        activeEditingRunbook?.actions.find((action) => action.id === actionId),
      ),
    );
    setUnsavedNudge(0);
    setExpandedId(actionId);
  };

  const handleLogFilterSampleChange = (actionId: string, value: string) => {
    setLogFilterSamples((prev) => ({
      ...prev,
      [actionId]: value,
    }));
  };

  return {
    expandedId,
    expandedCardRef,
    modelDropdownOpen,
    modelDropdownRef,
    logFilterSamples,
    handleActionDragEnd,
    handleActionDragStart,
    handleActionCardClick,
    handleAddActionAt,
    handleDeleteAction,
    handleLogFilterSampleChange,
    handleSaveAction,
    handleUpdateActionDraft,
    collapse,
    requestCollapse,
    expandedDraftDirty,
    unsavedNudge,
    savingStep: savingActionId !== null,
    resetActionEditorState,
    setModelDropdownOpen,
  };
}
