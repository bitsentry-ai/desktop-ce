import { useCallback, type Dispatch, type SetStateAction } from "react";

import { resolvedIdleTimeoutMinutes } from "./editorStateHelpers";
import {
  createRunbooksExportFilename,
  getRunbookExportTitle,
  getRunbookIdsToExport,
  RUNBOOK_ARTIFACT_FILE_FILTERS,
} from "./storageHelpers";
import {
  applyRunbookMetaPatch,
  cloneRunbook,
  hasRunbookMetaChanged,
  toErrorMessage,
  type RunbookMetaPatch,
} from "./runbookRecordHelpers";
import type { TranslationFn } from "./types";
import type { DesktopRpcChannel, RunbookRecord } from "../../services";

type DesktopIpcInvoke = <T>(
  channel: DesktopRpcChannel,
  payload?: unknown,
) => Promise<T>;

type ToastFn = (options: {
  variant?: "destructive";
  title: string;
  description: string;
}) => void;

type ShowSaveDialog = (options: {
  defaultFileName: string;
  filters: typeof RUNBOOK_ARTIFACT_FILE_FILTERS;
  trustScope: "runbooks-export";
}) => Promise<{
  filePath: string | null;
  canceled: boolean;
}>;

type UseRunbookPersistenceFlowOptions = {
  activeRunbook: RunbookRecord | null;
  editingRunbook: RunbookRecord | null;
  runbooks: RunbookRecord[];
  setEditingRunbook: Dispatch<SetStateAction<RunbookRecord | null>>;
  replaceRunbook: (updated: RunbookRecord) => void;
  ipcInvoke: DesktopIpcInvoke;
  showSaveDialog: ShowSaveDialog;
  t: TranslationFn;
  toast: ToastFn;
};

export function useRunbookPersistenceFlow({
  activeRunbook,
  editingRunbook,
  runbooks,
  setEditingRunbook,
  replaceRunbook,
  ipcInvoke,
  showSaveDialog,
  t,
  toast,
}: UseRunbookPersistenceFlowOptions) {
  const commitMeta = useCallback(
    async (patch: RunbookMetaPatch) => {
      if (activeRunbook === null || editingRunbook === null) {
        return;
      }

      const next = applyRunbookMetaPatch(editingRunbook, patch);
      if (!hasRunbookMetaChanged(activeRunbook, next)) {
        return;
      }

      try {
        const updated = await ipcInvoke<RunbookRecord>("runbooks:updateMeta", {
          id: activeRunbook.id,
          title: next.title,
          description: next.description,
          idleTimeout: next.idleTimeout,
        });
        replaceRunbook(updated);
      } catch (error) {
        console.error("Failed to update runbook metadata:", error);
        setEditingRunbook((current) =>
          current === editingRunbook ? cloneRunbook(activeRunbook) : current,
        );
        toast({
          variant: "destructive",
          title: t("runbooks.runbook.saveFailed"),
          description: t("runbooks.runbook.failedToSaveRunbookDetails"),
        });
      }
    },
    [
      activeRunbook,
      editingRunbook,
      ipcInvoke,
      replaceRunbook,
      setEditingRunbook,
      t,
      toast,
    ],
  );

  const handleIdleTimeoutChange = useCallback(
    (idleTimeout: number) => {
      if (activeRunbook === null || editingRunbook === null) {
        return;
      }

      if (resolvedIdleTimeoutMinutes(activeRunbook) === idleTimeout) {
        return;
      }

      setEditingRunbook((prev) => {
        if (prev === null) {
          return prev;
        }

        return { ...prev, idleTimeout };
      });
      void commitMeta({ idleTimeout });
    },
    [activeRunbook, commitMeta, editingRunbook, setEditingRunbook],
  );

  const handleExportRunbooks = useCallback(
    async (targetRunbookId?: string) => {
      const idsToExport = getRunbookIdsToExport(runbooks, targetRunbookId);
      if (idsToExport.length === 0) {
        toast({
          variant: "destructive",
          title: t("runbooks.runbook.exportFailed"),
          description: t("runbooks.runbook.noRunbooksAvailableToExport"),
        });
        return;
      }

      try {
        const exportTitle = getRunbookExportTitle(runbooks, idsToExport);
        const { filePath, canceled } = await showSaveDialog({
          defaultFileName: createRunbooksExportFilename(exportTitle),
          filters: RUNBOOK_ARTIFACT_FILE_FILTERS,
          trustScope: "runbooks-export",
        });

        if (canceled || filePath === null || filePath.length === 0) {
          return;
        }

        await ipcInvoke<{ ok: true; filePath: string; count: number }>(
          "runbooks:exportToFile",
          {
            ids: idsToExport,
            filePath,
            includeGlobals: true,
          },
        );

        toast({
          title: t("runbooks.runbook.exportComplete"),
          description: t("runbooks.runbook.savedRunbooksToFile", {
            count: idsToExport.length,
            filePath,
          }),
        });
      } catch (error) {
        const message = toErrorMessage(error);
        console.error("Failed to export runbooks:", error);
        toast({
          variant: "destructive",
          title: t("runbooks.runbook.exportFailed"),
          description: message,
        });
      }
    },
    [ipcInvoke, runbooks, showSaveDialog, t, toast],
  );

  return {
    commitMeta,
    handleExportRunbooks,
    handleIdleTimeoutChange,
  };
}
