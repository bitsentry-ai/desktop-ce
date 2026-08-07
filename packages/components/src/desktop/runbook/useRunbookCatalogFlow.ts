import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { preserveDraftActions } from "@bitsentry-ce/core";
import type { DesktopRpcChannel, RunbookRecord } from "../../services";
import {
  getActiveEditingRunbook,
  cloneRunbook,
} from "./runbookRecordHelpers";
import {
  readStoredRunbooks,
  replaceRunbookInList,
  RUNBOOKS_KEY,
} from "./storageHelpers";

/**
 * How `replaceRunbook` reconciles the open draft with the persisted runbook.
 *
 * `adopt` takes the server's copy wholesale, which is what a save or a delete
 * wants. `preserve-actions` keeps the draft's own action objects so a reorder
 * cannot discard unsaved edits in another card.
 */
export type DraftReconcileMode = "adopt" | "preserve-actions";

type DesktopIpcInvoke = <T>(
  channel: DesktopRpcChannel,
  payload?: unknown,
) => Promise<T>;

type CaptureDesktopAnalyticsEvent = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

type UseRunbookCatalogFlowOptions = {
  activeId: string | null;
  ipcInvoke: DesktopIpcInvoke;
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent;
  summarizeRunbookForTelemetry: (runbook: RunbookRecord) => Record<string, unknown>;
  navigateToRunbook: (runbookId: string) => void;
  navigateToRunbooks: () => void;
};

export function useRunbookCatalogFlow({
  activeId,
  ipcInvoke,
  captureDesktopAnalyticsEvent,
  summarizeRunbookForTelemetry,
  navigateToRunbook,
  navigateToRunbooks,
}: UseRunbookCatalogFlowOptions) {
  const [runbooks, setRunbooks] = useState<RunbookRecord[]>([]);
  const [editingRunbook, setEditingRunbook] = useState<RunbookRecord | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const activeRunbook = useMemo(
    () => runbooks.find((runbook) => runbook.id === activeId) ?? null,
    [activeId, runbooks],
  );
  const activeEditingRunbook = useMemo(
    () => getActiveEditingRunbook(editingRunbook, activeId),
    [activeId, editingRunbook],
  );

  // Mirrors `runbooks` so callers can derive the next list without reading stale
  // state from an async callback, and without doing it inside a state updater.
  const runbooksRef = useRef<RunbookRecord[]>([]);
  // Non-zero while this hook is dispatching, so it can skip its own broadcast.
  const selfDispatchDepthRef = useRef(0);

  const syncRunbooksCache = useCallback((nextRunbooks: RunbookRecord[]) => {
    try {
      localStorage.setItem(RUNBOOKS_KEY, JSON.stringify(nextRunbooks));
    } catch {}
  }, []);

  const commitRunbooks = useCallback(
    (nextRunbooks: RunbookRecord[]) => {
      runbooksRef.current = nextRunbooks;
      setRunbooks(nextRunbooks);
      syncRunbooksCache(nextRunbooks);
    },
    [syncRunbooksCache],
  );

  const notifyRunbooksUpdated = useCallback((runbook?: RunbookRecord) => {
    selfDispatchDepthRef.current += 1;
    try {
      window.dispatchEvent(
        new CustomEvent("bitsentry:runbooks-updated", {
          detail: runbook === undefined ? undefined : { runbook },
        }),
      );
    } finally {
      selfDispatchDepthRef.current -= 1;
    }
  }, []);

  const refreshRunbooks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipcInvoke<RunbookRecord[]>("runbooks:list", {});
      commitRunbooks(result);
      return result;
    } finally {
      setLoading(false);
    }
  }, [commitRunbooks, ipcInvoke]);

  const replaceRunbook = useCallback(
    (updated: RunbookRecord, draftMode: DraftReconcileMode = "adopt") => {
      commitRunbooks(replaceRunbookInList(runbooksRef.current, updated));
      setEditingRunbook((prev) => {
        if (draftMode === "preserve-actions") {
          return preserveDraftActions(prev, updated);
        }

        return cloneRunbook(updated);
      });
      // Carries the runbook so listeners reconcile in memory instead of
      // re-reading and re-writing the whole library from localStorage.
      notifyRunbooksUpdated(updated);
    },
    [commitRunbooks, notifyRunbooksUpdated],
  );

  const handleDeleteSuccess = useCallback(
    (nextRunbooks: RunbookRecord[], nextRunbook: RunbookRecord | null) => {
      commitRunbooks(nextRunbooks);
      if (nextRunbook === null) {
        setEditingRunbook(null);
      } else {
        setEditingRunbook(cloneRunbook(nextRunbook));
      }
      notifyRunbooksUpdated();

      if (nextRunbook !== null) {
        navigateToRunbook(nextRunbook.id);
        return;
      }

      navigateToRunbooks();
    },
    [
      commitRunbooks,
      navigateToRunbook,
      navigateToRunbooks,
      notifyRunbooksUpdated,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    const loadRunbooks = async () => {
      try {
        if (!cancelled) {
          await refreshRunbooks();
        }
      } catch (error) {
        console.error("Failed to load runbooks:", error);
        if (!cancelled) {
          runbooksRef.current = [];
          setRunbooks([]);
        }
      }
    };

    void loadRunbooks();
    return () => {
      cancelled = true;
    };
  }, [refreshRunbooks]);

  useEffect(() => {
    const handleRunbooksUpdated = (event: Event) => {
      // This hook already applied its own change before dispatching; re-reading
      // the library here is what used to re-parse and re-clone on every commit.
      if (selfDispatchDepthRef.current > 0) {
        return;
      }

      const updatedRunbook =
        event instanceof CustomEvent &&
        typeof event.detail === "object" &&
        event.detail !== null &&
        "runbook" in event.detail
          ? event.detail.runbook as RunbookRecord
          : undefined;
      const nextRunbooks =
        updatedRunbook === undefined
          ? readStoredRunbooks()
          : replaceRunbookInList(runbooksRef.current, updatedRunbook);
      commitRunbooks(nextRunbooks);

      if (
        activeId !== null &&
        !nextRunbooks.some((runbook) => runbook.id === activeId)
      ) {
        navigateToRunbooks();
      }
    };

    window.addEventListener("bitsentry:runbooks-updated", handleRunbooksUpdated);
    return () => {
      window.removeEventListener(
        "bitsentry:runbooks-updated",
        handleRunbooksUpdated,
      );
    };
  }, [activeId, commitRunbooks, navigateToRunbooks]);

  useEffect(() => {
    // Hydrate the draft when the editor opens a different runbook, or once the
    // library finally loads. An existing draft for the same runbook is kept, so
    // a background refresh cannot wipe unsaved edits.
    if (activeId === null) {
      setEditingRunbook(null);
      return;
    }

    setEditingRunbook((prev) => {
      if (prev !== null && prev.id === activeId) {
        return prev;
      }

      return cloneRunbook(
        runbooksRef.current.find((runbook) => runbook.id === activeId) ?? null,
      );
    });
  }, [activeId, runbooks]);

  const handleNew = useCallback(async () => {
    const id = crypto.randomUUID();
    try {
      const created = await ipcInvoke<RunbookRecord>("runbooks:create", {
        id,
        title: "New Runbook",
        description: "",
      });
      commitRunbooks([created, ...runbooksRef.current]);
      setEditingRunbook(cloneRunbook(created));
      notifyRunbooksUpdated(created);
      captureDesktopAnalyticsEvent("desktop_runbook_created", {
        ...summarizeRunbookForTelemetry(created),
        creation_source: "manual",
      });
      navigateToRunbook(id);
    } catch (error) {
      console.error("Failed to create runbook:", error);
    }
  }, [
    captureDesktopAnalyticsEvent,
    commitRunbooks,
    ipcInvoke,
    navigateToRunbook,
    notifyRunbooksUpdated,
    summarizeRunbookForTelemetry,
  ]);

  return {
    activeEditingRunbook,
    activeRunbook,
    editingRunbook,
    handleDeleteSuccess,
    handleNew,
    loading,
    refreshRunbooks,
    replaceRunbook,
    runbooks,
    setEditingRunbook,
    syncRunbooksCache,
  } satisfies {
    activeEditingRunbook: RunbookRecord | null;
    activeRunbook: RunbookRecord | null;
    editingRunbook: RunbookRecord | null;
    handleDeleteSuccess: (nextRunbooks: RunbookRecord[], nextRunbook: RunbookRecord | null) => void;
    handleNew: () => Promise<void>;
    loading: boolean;
    refreshRunbooks: () => Promise<RunbookRecord[]>;
    replaceRunbook: (
      updated: RunbookRecord,
      draftMode?: DraftReconcileMode,
    ) => void;
    runbooks: RunbookRecord[];
    setEditingRunbook: Dispatch<SetStateAction<RunbookRecord | null>>;
    syncRunbooksCache: (nextRunbooks: RunbookRecord[]) => void;
  };
}
