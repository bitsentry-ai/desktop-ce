import {
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../hooks/use-toast";
import { RunbookEditorScreen } from "./runbook/RunbookEditorScreen";
import { RunbookLibraryScreen } from "./runbook/RunbookLibraryScreen";
import { useRunbookDeleteFlow } from "./runbook/useRunbookDeleteFlow";
import { useRunbookActionEditorFlow } from "./runbook/useRunbookActionEditorFlow";
import { useRunbookCatalogFlow } from "./runbook/useRunbookCatalogFlow";
import { useRunbookExecutionFlow } from "./runbook/useRunbookExecutionFlow";
import { useRunbookImportFlow } from "./runbook/useRunbookImportFlow";
import { useRunbookMetadataFlow } from "./runbook/useRunbookMetadataFlow";
import { useRunbookNavigation } from "./runbook/useRunbookNavigation";
import { useRunbookPersistenceFlow } from "./runbook/useRunbookPersistenceFlow";
import { useRunbookResourceData } from "./runbook/useRunbookResourceData";
import {
  summarizeRunbookActionForTelemetry,
  summarizeRunbookForTelemetry,
} from "./runbook/runbookRecordHelpers";
import type {
  DesktopRpcChannel,
} from "../services";
import { useGlobalVariables } from "../services";
import {
  type DesktopBitsentryApi,
  getDesktopApi,
} from "../services/desktop-api";
import { useTranslation } from "@bitsentry-ce/i18n";

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

type DesktopDragDropRuntime = {
  DragDropProvider: (props: {
    children: ReactNode;
    onDragStart?: () => void;
    onDragEnd: (event: DesktopDragEndEvent) => void;
  }) => ReactNode;
  isSortable: (value: unknown) => value is SortableSourceLike;
  useSortable: (options: {
    id: string;
    index: number;
    disabled: boolean;
    group: string;
    type: string;
    accept: string;
  }) => {
    ref: (node: HTMLElement | null) => void;
    isDragging: boolean;
    isDragSource: boolean;
    isDropTarget: boolean;
  };
};

type DesktopRunbookPageProps = {
  ipcInvoke: DesktopIpcInvoke;
  captureDesktopAnalyticsEvent: CaptureDesktopAnalyticsEvent;
  dragDropRuntime: DesktopDragDropRuntime;
};

function requireDesktopApi(): ReturnType<typeof getDesktopApi> & {
  llm: NonNullable<DesktopBitsentryApi["llm"]>;
  dialog: NonNullable<DesktopBitsentryApi["dialog"]>;
} {
  const desktopApi = getDesktopApi();
  if (desktopApi?.llm === undefined || desktopApi.dialog === undefined) {
    throw new Error("Desktop API bridge unavailable");
  }

  return desktopApi as DesktopBitsentryApi & {
    llm: NonNullable<DesktopBitsentryApi["llm"]>;
    dialog: NonNullable<DesktopBitsentryApi["dialog"]>;
  };
}

const IDLE_TIMEOUT_PRESETS = [
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "60m", value: 60 },
  { label: "None", value: 0 },
] as const;

export default function DesktopRunbookPage({
  ipcInvoke,
  captureDesktopAnalyticsEvent,
  dragDropRuntime,
}: DesktopRunbookPageProps) {
  const { DragDropProvider, isSortable } = dragDropRuntime;
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const activeId = searchParams.get("id");
  const { toast } = useToast();
  const { data: globalVariables = [] } = useGlobalVariables();
  const {
    openResult,
    openRunbook,
    openRunbookResults,
    openRunbooks,
  } = useRunbookNavigation();

  const {
    errorSourceOptions,
    errorSourceLabelsById,
    errorSourcesLoading,
    errorSourceCount,
    validErrorSourceIds,
    pluginDescriptors,
    pluginOptions,
    pluginsLoading,
    validPluginActionIdsByPluginId,
    llmProviderLabelsByKey,
    llmModelOptions,
    selectableLlmProviderCount,
  } = useRunbookResourceData({
    ipcInvoke,
  });

  const {
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
  } = useRunbookCatalogFlow({
    activeId,
    ipcInvoke,
    captureDesktopAnalyticsEvent,
    summarizeRunbookForTelemetry,
    navigateToRunbook: openRunbook,
    navigateToRunbooks: openRunbooks,
  });

  const {
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
    setModelDropdownOpen,
  } = useRunbookActionEditorFlow({
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
  });

  const {
    importDialogOpen,
    importArtifact,
    importConflictPolicy,
    importPreviewSummary,
    importResultSummary,
    importPreviewLoading,
    importSubmitting,
    importErrorMessage,
    includeGlobalsOnImport,
    setImportConflictPolicy,
    setIncludeGlobalsOnImport,
    handleCloseImportDialog,
    handleOpenImportDialog,
    handleConfirmImport,
  } = useRunbookImportFlow({
    ipcInvoke,
    refreshRunbooks,
    captureDesktopAnalyticsEvent,
    t,
    toast,
  });

  const {
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
  } = useRunbookExecutionFlow({
    editingRunbook,
    ipcInvoke,
    captureDesktopAnalyticsEvent,
    summarizeRunbookForTelemetry,
    navigateToResult: openResult,
    t,
  });

  const {
    deleteDialogOpen,
    deleteConfirmText,
    isDeletingRunbook,
    setDeleteConfirmText,
    handleOpenDeleteDialog,
    handleConfirmDeleteRunbook,
    handleDeleteDialogCancel,
    handleDeleteDialogOpenChange,
  } = useRunbookDeleteFlow({
    activeEditingRunbook,
    runbooks,
    ipcInvoke,
    captureDesktopAnalyticsEvent,
    summarizeRunbookForTelemetry,
    onDeleteSuccess: handleDeleteSuccess,
  });
  const {
    commitMeta,
    handleExportRunbooks,
    handleIdleTimeoutChange,
  } = useRunbookPersistenceFlow({
    activeRunbook,
    editingRunbook,
    runbooks,
    setEditingRunbook,
    replaceRunbook,
    ipcInvoke,
    showSaveDialog: (options) => requireDesktopApi().dialog.showSaveDialog(options),
    t,
    toast,
  });
  const {
    handleDescriptionBlur,
    handleDescriptionChange,
    handleTitleBlur,
    handleTitleChange,
    unresolvedGlobalKeys,
  } = useRunbookMetadataFlow({
    activeEditingRunbook,
    globalVariables,
    setEditingRunbook,
    commitMeta,
  });

  if (activeEditingRunbook === null) {
    return (
      <RunbookLibraryScreen
        libraryProps={{
          loading,
          runbooks,
          onOpenImportDialog() {
            void handleOpenImportDialog();
          },
          onCreateRunbook() {
            void handleNew();
          },
          onOpenRunbook: openRunbook,
          onExportRunbooks(runbookId) {
            void handleExportRunbooks(runbookId);
          },
          onOpenRunbookResults: openRunbookResults,
          t,
        }}
        importDialogProps={{
          open: importDialogOpen,
          artifact: importArtifact,
          conflictPolicy: importConflictPolicy,
          includeGlobals: includeGlobalsOnImport,
          previewSummary: importPreviewSummary,
          resultSummary: importResultSummary,
          previewLoading: importPreviewLoading,
          importLoading: importSubmitting,
          errorMessage: importErrorMessage,
          onConflictPolicyChange: setImportConflictPolicy,
          onIncludeGlobalsChange: setIncludeGlobalsOnImport,
          onImport() {
            void handleConfirmImport();
          },
          onClose: handleCloseImportDialog,
        }}
      />
    );
  }

  return (
    <RunbookEditorScreen
      loading={loading}
      loadingLabel={t("runbooks.runbook.loadingRunbooks_2")}
      editorProps={{
        runbook: activeEditingRunbook,
        unresolvedGlobalKeys,
        idleTimeoutPresets: IDLE_TIMEOUT_PRESETS,
        onTitleChange: handleTitleChange,
        onTitleBlur: handleTitleBlur,
        onDescriptionChange: handleDescriptionChange,
        onDescriptionBlur: handleDescriptionBlur,
        onIdleTimeoutChange: handleIdleTimeoutChange,
        onExportRunbooks(runbookId) {
          void handleExportRunbooks(runbookId);
        },
        onOpenResults: openRunbookResults,
        onRun: handleRun,
        onDelete: handleOpenDeleteDialog,
        onCreateRunbook() {
          void handleNew();
        },
        DragDropProvider,
        useSortableRuntime: dragDropRuntime.useSortable,
        expandedId,
        expandedCardRef,
        modelDropdownOpen,
        modelDropdownRef,
        onModelDropdownOpenChange: setModelDropdownOpen,
        errorSourceOptions,
        errorSourceLabelsById,
        errorSourcesLoading,
        errorSourceCount,
        validErrorSourceIds,
        pluginDescriptors,
        pluginOptions,
        pluginsLoading,
        validPluginActionIdsByPluginId,
        llmProviderLabelsByKey,
        llmModelOptions,
        selectableLlmProviderCount,
        globalVariables,
        logFilterSamples,
        onActionDragStart: handleActionDragStart,
        onActionDragEnd(event) {
          handleActionDragEnd(event, isSortable);
        },
        onActionCardClick: handleActionCardClick,
        onAddActionAt: handleAddActionAt,
        onDeleteAction(actionId) {
          void handleDeleteAction(actionId);
        },
        onLogFilterSampleChange: handleLogFilterSampleChange,
        onSaveAction(actionId) {
          void handleSaveAction(actionId);
        },
        onUpdateActionDraft: handleUpdateActionDraft,
        onCollapse: collapse,
        runDialogOpen,
        runtimeParameters,
        runtimeParameterValues,
        visibleSecureParameters,
        missingRuntimeRequiredParameterCount:
          missingRuntimeRequiredParameters.length,
        onRuntimeParameterValueChange: handleRuntimeParameterValueChange,
        onToggleSecureParameterVisibility:
          handleToggleSecureParameterVisibility,
        onCancelRunDialog: handleCancelRunDialog,
        onSubmitRunDialog: handleSubmitRun,
        t,
      }}
      deleteDialogProps={{
        open: deleteDialogOpen,
        runbookTitle: activeEditingRunbook.title,
        confirmText: deleteConfirmText,
        isDeleting: isDeletingRunbook,
        onConfirmTextChange: setDeleteConfirmText,
        onCancel: handleDeleteDialogCancel,
        onConfirm() {
          void handleConfirmDeleteRunbook();
        },
        onOpenChange: handleDeleteDialogOpenChange,
        t,
      }}
    />
  );
}
