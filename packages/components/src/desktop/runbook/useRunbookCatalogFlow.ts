import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

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

  const syncRunbooksCache = useCallback((nextRunbooks: RunbookRecord[]) => {
    try {
      localStorage.setItem(RUNBOOKS_KEY, JSON.stringify(nextRunbooks));
    } catch {}
  }, []);

  const notifyRunbooksUpdated = useCallback((runbook?: RunbookRecord) => {
    window.dispatchEvent(
      new CustomEvent("bitsentry:runbooks-updated", {
        detail: runbook === undefined ? undefined : { runbook },
      }),
    );
  }, []);

  const refreshRunbooks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipcInvoke<RunbookRecord[]>("runbooks:list", {});
      setRunbooks(result);
      syncRunbooksCache(result);
      return result;
    } finally {
      setLoading(false);
    }
  }, [ipcInvoke, syncRunbooksCache]);

  const replaceRunbook = useCallback(
    (updated: RunbookRecord) => {
      setRunbooks((prev) => {
        const nextRunbooks = replaceRunbookInList(prev, updated);
        syncRunbooksCache(nextRunbooks);
        return nextRunbooks;
      });
      setEditingRunbook(cloneRunbook(updated));
      notifyRunbooksUpdated();
    },
    [notifyRunbooksUpdated, syncRunbooksCache],
  );

  const handleDeleteSuccess = useCallback(
    (nextRunbooks: RunbookRecord[], nextRunbook: RunbookRecord | null) => {
      setRunbooks(nextRunbooks);
      syncRunbooksCache(nextRunbooks);
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
      navigateToRunbook,
      navigateToRunbooks,
      notifyRunbooksUpdated,
      syncRunbooksCache,
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
          : replaceRunbookInList(runbooks, updatedRunbook);
      setRunbooks(nextRunbooks);
      syncRunbooksCache(nextRunbooks);

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
  }, [activeId, navigateToRunbooks, runbooks, syncRunbooksCache]);

  useEffect(() => {
    setEditingRunbook(cloneRunbook(activeRunbook));
  }, [activeRunbook]);

  const handleNew = useCallback(async () => {
    const id = crypto.randomUUID();
    try {
      const created = await ipcInvoke<RunbookRecord>("runbooks:create", {
        id,
        title: "New Runbook",
        description: "",
      });
      setRunbooks((prev) => {
        const nextRunbooks = [created, ...prev];
        syncRunbooksCache(nextRunbooks);
        return nextRunbooks;
      });
      setEditingRunbook(cloneRunbook(created));
      notifyRunbooksUpdated();
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
    ipcInvoke,
    navigateToRunbook,
    notifyRunbooksUpdated,
    summarizeRunbookForTelemetry,
    syncRunbooksCache,
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
    replaceRunbook: (updated: RunbookRecord) => void;
    runbooks: RunbookRecord[];
    setEditingRunbook: Dispatch<SetStateAction<RunbookRecord | null>>;
    syncRunbooksCache: (nextRunbooks: RunbookRecord[]) => void;
  };
}
