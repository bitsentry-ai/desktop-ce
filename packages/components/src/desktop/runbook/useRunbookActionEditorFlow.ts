import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  canPersistRunbookAction,
  createDraftAction,
  reorderRunbookActions,
} from "./actionHelpers";
import { cloneRunbook } from "./runbookRecordHelpers";
import type {
  DesktopRpcChannel,
  RunbookActionRecord,
  RunbookRecord,
} from "../../services";

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
  replaceRunbook: (updated: RunbookRecord) => void;
  validErrorSourceIds: Set<string>;
  validPluginActionIdsByPluginId: Map<string, Set<string>>;
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
}: UseRunbookActionEditorFlowOptions) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    tempActionIdsRef.current.clear();
  }, []);

  useEffect(() => {
    resetActionEditorState();
  }, [activeRunbook?.id, resetActionEditorState]);

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

  useEffect(() => {
    if (expandedId === null) {
      return;
    }

    const handler = (event: MouseEvent) => {
      if (
        expandedCardRef.current !== null &&
        !expandedCardRef.current.contains(event.target as Node)
      ) {
        collapse();
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 50);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [collapse, expandedId]);

  const handleUpdateActionDraft = useCallback(
    (updatedAction: RunbookActionRecord) => {
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
    },
    [setEditingRunbook],
  );

  const handleAddActionAt = useCallback(
    (insertAt: number) => {
      if (activeEditingRunbook === null) {
        return;
      }

      const newAction = createDraftAction();
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
    },
    [
      activeEditingRunbook,
      captureDesktopAnalyticsEvent,
      setEditingRunbook,
      summarizeRunbookForTelemetry,
    ],
  );

  const handleSaveAction = useCallback(
    async (actionId: string) => {
      if (activeEditingRunbook === null) {
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
        )
      ) {
        return;
      }

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
        replaceRunbook(updated);
        setExpandedId(null);
        captureDesktopAnalyticsEvent("desktop_runbook_action_saved", {
          ...summarizeRunbookForTelemetry(updated),
          ...summarizeRunbookActionForTelemetry(action),
        });
      } catch (error) {
        console.error("Failed to save runbook action:", error);
        if (activeRunbook !== null) {
          setEditingRunbook(cloneRunbook(activeRunbook));
        }
      }
    },
    [
      activeEditingRunbook,
      activeRunbook,
      captureDesktopAnalyticsEvent,
      ipcInvoke,
      replaceRunbook,
      setEditingRunbook,
      summarizeRunbookActionForTelemetry,
      summarizeRunbookForTelemetry,
      validErrorSourceIds,
      validPluginActionIdsByPluginId,
    ],
  );

  const handleDeleteAction = useCallback(
    async (actionId: string) => {
      if (activeEditingRunbook === null) {
        return;
      }

      const actionToDelete = activeEditingRunbook.actions.find(
        (action) => action.id === actionId,
      );
      const previousRunbook = cloneRunbook(activeRunbook);
      setExpandedId(null);
      tempActionIdsRef.current.delete(actionId);

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
    },
    [
      activeEditingRunbook,
      activeRunbook,
      captureDesktopAnalyticsEvent,
      ipcInvoke,
      replaceRunbook,
      setEditingRunbook,
      summarizeRunbookActionForTelemetry,
      summarizeRunbookForTelemetry,
    ],
  );

  const handleReorder = useCallback(
    async (nextActions: RunbookActionRecord[]) => {
      if (activeEditingRunbook === null) {
        return;
      }

      const previousRunbook = cloneRunbook(activeRunbook);
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
        replaceRunbook(updated);
        captureDesktopAnalyticsEvent("desktop_runbook_actions_reordered", {
          ...summarizeRunbookForTelemetry(updated),
        });
      } catch (error) {
        console.error("Failed to reorder runbook actions:", error);
        setEditingRunbook(previousRunbook);
      }
    },
    [
      activeEditingRunbook,
      activeRunbook,
      captureDesktopAnalyticsEvent,
      ipcInvoke,
      replaceRunbook,
      setEditingRunbook,
      summarizeRunbookForTelemetry,
    ],
  );

  const handleActionDragEnd = useCallback(
    (event: DesktopDragEndEvent, isSortable: (value: unknown) => value is SortableSourceLike) => {
      window.setTimeout(() => {
        suppressExpandOnNextClickRef.current = false;
      }, 0);
      if (event.canceled) {
        return;
      }

      const source = event.operation.source;
      if (source === null || !isSortable(source)) {
        return;
      }

      const { initialIndex, index } = source;
      const actions = activeEditingRunbook?.actions ?? [];
      const next = reorderRunbookActions(actions, initialIndex, index);
      if (next === null) {
        return;
      }

      void handleReorder(next);
    },
    [activeEditingRunbook?.actions, handleReorder],
  );

  const handleActionDragStart = useCallback(() => {
    suppressExpandOnNextClickRef.current = true;
  }, []);

  const handleActionCardClick = useCallback((actionId: string) => {
    if (suppressExpandOnNextClickRef.current) {
      suppressExpandOnNextClickRef.current = false;
      return;
    }

    setExpandedId(actionId);
  }, []);

  const handleLogFilterSampleChange = useCallback((actionId: string, value: string) => {
    setLogFilterSamples((prev) => ({
      ...prev,
      [actionId]: value,
    }));
  }, []);

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
    resetActionEditorState,
    setModelDropdownOpen,
  };
}
