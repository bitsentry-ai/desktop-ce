import { useCallback, useMemo, useState } from "react";

import {
  collectRuntimeParameters,
  compactRuntimeParameterValues,
  initialRuntimeParameterValues,
  isRuntimeParameterMissing,
} from "./editorStateHelpers";
import { persistRunningRunResult } from "./storageHelpers";
import type { TranslationFn } from "./types";
import type {
  DesktopRpcChannel,
  RunbookContextV1,
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

type UseRunbookExecutionFlowOptions = {
  editingRunbook: RunbookRecord | null;
  ipcInvoke: DesktopIpcInvoke;
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent;
  summarizeRunbookForTelemetry: (runbook: RunbookRecord) => Record<string, unknown>;
  navigateToResult: (resultId: string) => void;
  t: TranslationFn;
};

export function useRunbookExecutionFlow({
  editingRunbook,
  ipcInvoke,
  captureDesktopAnalyticsEvent,
  summarizeRunbookForTelemetry,
  navigateToResult,
  t,
}: UseRunbookExecutionFlowOptions) {
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runtimeParameterValues, setRuntimeParameterValues] = useState<
    Record<string, string>
  >({});
  const [visibleSecureParameters, setVisibleSecureParameters] = useState<
    Set<string>
  >(() => new Set());

  const runtimeParameters = useMemo(
    () => collectRuntimeParameters(editingRunbook, t),
    [editingRunbook, t],
  );

  const missingRuntimeRequiredParameters = runtimeParameters.filter(
    (parameter) => isRuntimeParameterMissing(parameter, runtimeParameterValues),
  );

  const launchRunbook = useCallback(
    async (parameterValues?: Record<string, string>) => {
      if (editingRunbook === null || editingRunbook.actions.length === 0) {
        return;
      }

      try {
        const context = await ipcInvoke<RunbookContextV1>(
          "runbooks:exportContext",
          {
            id: editingRunbook.id,
          },
        );
        const execution = await ipcInvoke<{
          executionId: string;
          resultId: string;
          execution?: {
            status?: string;
            startedAt?: string;
            completedAt?: string;
          };
        }>("runbooks:execute", {
          runbookId: editingRunbook.id,
          parameterValues,
          triggerContext: {
            entrypoint: "runbooks",
          },
        });

        persistRunningRunResult({
          executionId: execution.executionId,
          resultId: execution.resultId,
          runbook: editingRunbook,
          context,
          execution: execution.execution,
        });

        navigateToResult(execution.resultId);
      } catch (error) {
        console.error("Failed to launch runbook result:", error);
      }
    },
    [editingRunbook, ipcInvoke, navigateToResult],
  );

  const handleRun = useCallback(() => {
    if (editingRunbook === null || editingRunbook.actions.length === 0) return;

    const parameters = collectRuntimeParameters(editingRunbook, t);
    captureDesktopAnalyticsEvent("desktop_runbook_run_dialog_opened", {
      ...summarizeRunbookForTelemetry(editingRunbook),
      runtime_parameter_count: parameters.length,
    });
    if (parameters.length === 0) {
      void launchRunbook();
      return;
    }

    setRuntimeParameterValues(initialRuntimeParameterValues(parameters));
    setVisibleSecureParameters(new Set());
    setRunDialogOpen(true);
  }, [
    captureDesktopAnalyticsEvent,
    editingRunbook,
    launchRunbook,
    summarizeRunbookForTelemetry,
    t,
  ]);

  const handleSubmitRun = useCallback(() => {
    if (missingRuntimeRequiredParameters.length > 0) {
      return;
    }

    const parameterValues = compactRuntimeParameterValues(
      runtimeParameterValues,
    );
    setRunDialogOpen(false);
    setRuntimeParameterValues({});
    setVisibleSecureParameters(new Set());
    void launchRunbook(parameterValues);
  }, [
    launchRunbook,
    missingRuntimeRequiredParameters.length,
    runtimeParameterValues,
  ]);

  const handleRuntimeParameterValueChange = useCallback(
    (key: string, value: string) => {
      setRuntimeParameterValues((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const handleToggleSecureParameterVisibility = useCallback((key: string) => {
    setVisibleSecureParameters((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleCancelRunDialog = useCallback(() => {
    if (editingRunbook !== null) {
      captureDesktopAnalyticsEvent("desktop_runbook_run_dialog_cancelled", {
        ...summarizeRunbookForTelemetry(editingRunbook),
        runtime_parameter_count: runtimeParameters.length,
      });
    }
    setRunDialogOpen(false);
  }, [
    captureDesktopAnalyticsEvent,
    editingRunbook,
    runtimeParameters.length,
    summarizeRunbookForTelemetry,
  ]);

  return {
    runDialogOpen,
    runtimeParameters,
    runtimeParameterValues,
    visibleSecureParameters,
    missingRuntimeRequiredParameters,
    handleRun,
    handleSubmitRun,
    handleRuntimeParameterValueChange,
    handleToggleSecureParameterVisibility,
    handleCancelRunDialog,
  };
}
