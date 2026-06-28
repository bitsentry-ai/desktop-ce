import type { ReactNode, RefObject } from "react";

import { BookOpen, Plus } from "../../icons";
import type {
  GlobalVariable,
  PluginManifest,
  RunbookActionRecord,
  RunbookLlmProviderKey,
  RunbookRecord,
} from "../../services";
import {
  actionSummary,
  ACTION_META,
  ACTION_TYPES,
  getActionMeta,
  getRunbookActionRenderState,
  TypeBadge,
} from "./actionHelpers";
import {
  getRunbookMetadataIssues,
  resolvedIdleTimeoutMinutes,
} from "./editorStateHelpers";
import type { LlmModelOption } from "./RunbookActionFieldShared";
import { RunbookActionList } from "./RunbookActionList";
import { RunbookCollapsedActionCard } from "./RunbookCollapsedActionCard";
import { RunbookEditorHeader } from "./RunbookEditorHeader";
import { RunbookExpandedActionCard } from "./RunbookExpandedActionCard";
import { RunbookRunDialog } from "./RunbookRunDialog";
import type { IdleTimeoutPreset, RuntimeParameterDefinition, TranslationFn } from "./types";

type DesktopDragEndEvent = {
  canceled?: boolean;
  operation: {
    source: unknown;
  };
};

type UseSortableRuntime = (options: {
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

type DragDropProviderComponent = (props: {
  children: ReactNode;
  onDragStart?: () => void;
  onDragEnd: (event: DesktopDragEndEvent) => void;
}) => ReactNode;

type RunbookEditorViewProps = {
  runbook: RunbookRecord;
  unresolvedGlobalKeys: string[];
  idleTimeoutPresets: readonly IdleTimeoutPreset[];
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  onDescriptionChange: (value: string) => void;
  onDescriptionBlur: () => void;
  onIdleTimeoutChange: (value: number) => void;
  onExportRunbooks: (runbookId: string) => void;
  onOpenResults: (runbookId: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onCreateRunbook: () => void;
  DragDropProvider: DragDropProviderComponent;
  useSortableRuntime: UseSortableRuntime;
  expandedId: string | null;
  expandedCardRef: RefObject<HTMLDivElement | null>;
  modelDropdownOpen: boolean;
  modelDropdownRef: RefObject<HTMLDivElement | null>;
  onModelDropdownOpenChange: (open: boolean) => void;
  errorSourceOptions: Array<{ id: string; label: string }>;
  errorSourceLabelsById: Record<string, string>;
  errorSourcesLoading: boolean;
  errorSourceCount: number;
  validErrorSourceIds: Set<string>;
  pluginManifests: PluginManifest[];
  pluginOptions: Array<{ id: string; label: string }>;
  pluginsLoading: boolean;
  validPluginActionIdsByPluginId: Map<string, Set<string>>;
  llmProviderLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>;
  llmModelOptions: LlmModelOption[];
  selectableLlmProviderCount: number;
  globalVariables: GlobalVariable[];
  logFilterSamples: Record<string, string>;
  onActionDragStart: () => void;
  onActionDragEnd: (event: DesktopDragEndEvent) => void;
  onActionCardClick: (actionId: string) => void;
  onAddActionAt: (index: number) => void;
  onDeleteAction: (actionId: string) => void;
  onLogFilterSampleChange: (actionId: string, value: string) => void;
  onSaveAction: (actionId: string) => void;
  onUpdateActionDraft: (action: RunbookActionRecord) => void;
  onCollapse: () => void;
  runDialogOpen: boolean;
  runtimeParameters: RuntimeParameterDefinition[];
  runtimeParameterValues: Record<string, string>;
  visibleSecureParameters: Set<string>;
  missingRuntimeRequiredParameterCount: number;
  onRuntimeParameterValueChange: (key: string, value: string) => void;
  onToggleSecureParameterVisibility: (key: string) => void;
  onCancelRunDialog: () => void;
  onSubmitRunDialog: () => void;
  t: TranslationFn;
};

export function RunbookEditorView({
  runbook,
  unresolvedGlobalKeys,
  idleTimeoutPresets,
  onTitleChange,
  onTitleBlur,
  onDescriptionChange,
  onDescriptionBlur,
  onIdleTimeoutChange,
  onExportRunbooks,
  onOpenResults,
  onRun,
  onDelete,
  onCreateRunbook,
  DragDropProvider,
  useSortableRuntime,
  expandedId,
  expandedCardRef,
  modelDropdownOpen,
  modelDropdownRef,
  onModelDropdownOpenChange,
  errorSourceOptions,
  errorSourceLabelsById,
  errorSourcesLoading,
  errorSourceCount,
  validErrorSourceIds,
  pluginManifests,
  pluginOptions,
  pluginsLoading,
  validPluginActionIdsByPluginId,
  llmProviderLabelsByKey,
  llmModelOptions,
  selectableLlmProviderCount,
  globalVariables,
  logFilterSamples,
  onActionDragStart,
  onActionDragEnd,
  onActionCardClick,
  onAddActionAt,
  onDeleteAction,
  onLogFilterSampleChange,
  onSaveAction,
  onUpdateActionDraft,
  onCollapse,
  runDialogOpen,
  runtimeParameters,
  runtimeParameterValues,
  visibleSecureParameters,
  missingRuntimeRequiredParameterCount,
  onRuntimeParameterValueChange,
  onToggleSecureParameterVisibility,
  onCancelRunDialog,
  onSubmitRunDialog,
  t,
}: RunbookEditorViewProps) {
  const currentTimeoutMinutes = resolvedIdleTimeoutMinutes(runbook);
  const currentTimeoutLabel =
    idleTimeoutPresets.find((preset) => preset.value === currentTimeoutMinutes)
      ?.label ?? `${String(currentTimeoutMinutes)}m`;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <RunbookEditorHeader
        runbook={runbook}
        metaIssues={getRunbookMetadataIssues(runbook)}
        currentTimeoutMinutes={currentTimeoutMinutes}
        currentTimeoutLabel={currentTimeoutLabel}
        idleTimeoutPresets={idleTimeoutPresets}
        onTitleChange={onTitleChange}
        onTitleBlur={onTitleBlur}
        onDescriptionChange={onDescriptionChange}
        onDescriptionBlur={onDescriptionBlur}
        onIdleTimeoutChange={onIdleTimeoutChange}
        onExport={() => {
          onExportRunbooks(runbook.id);
        }}
        onOpenResults={() => {
          onOpenResults(runbook.id);
        }}
        onRun={onRun}
        onDelete={onDelete}
        onCreateRunbook={onCreateRunbook}
        t={t}
      />
      {unresolvedGlobalKeys.length > 0 && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-700">
          {t("runbooks.runbook.thisRunbookReferencesMissingGlobals")}{" "}
          {unresolvedGlobalKeys.join(", ")}
          {t("runbooks.runbook.addThemInAppSettings")}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {runbook.actions.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
            <BookOpen size={32} className="opacity-25" />
            <p className="text-sm">{t("runbooks.runbook.noActionsYet")}</p>
            <button
              onClick={() => {
                onAddActionAt(0);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-xs transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Plus size={12} />
              {t("runbooks.runbook.addFirstAction")}
            </button>
          </div>
        )}
        {runbook.actions.length > 0 && (
          <DragDropProvider
            onDragStart={onActionDragStart}
            onDragEnd={onActionDragEnd}
          >
            <RunbookActionList
              actions={runbook.actions}
              useSortableRuntime={useSortableRuntime}
              isExpanded={(action) => expandedId === action.id}
              renderExpandedCard={(action) => {
                const {
                  canSaveAction,
                  headers,
                  httpBodyPlaceholder,
                  httpBodyValue,
                  isGetHttpMethod,
                  isMissingErrorSource,
                  llmProviderHint,
                  logFilterErrors,
                  logFilterPreview,
                  logFilterSample,
                  logFilterToggleText,
                  modelBorderClass,
                  parameterErrors,
                  parameters,
                  sourceHelpClass,
                  sourceHelpText,
                  sourcePlaceholderText,
                  sourceSelectClass,
                  sourceSelectValue,
                } = getRunbookActionRenderState({
                  action,
                  modelDropdownOpen,
                  validErrorSourceIds,
                  validPluginActionIdsByPluginId,
                  selectableLlmProviderCount,
                  llmProviderLabelsByKey,
                  errorSourcesLoading,
                  errorSourceCount,
                  logFilterSamples,
                  t,
                });

                return (
                  <RunbookExpandedActionCard
                    action={action}
                    expandedCardRef={expandedCardRef}
                    actionTypes={ACTION_TYPES}
                    actionMeta={ACTION_META}
                    titlePlaceholder={getActionMeta(action.type).placeholderKey}
                    canSaveAction={canSaveAction}
                    headers={headers}
                    httpMethods={["GET", "POST", "PUT", "PATCH", "DELETE"]}
                    httpBodyPlaceholder={httpBodyPlaceholder}
                    httpBodyValue={httpBodyValue}
                    isGetHttpMethod={isGetHttpMethod}
                    llmModelOptions={llmModelOptions}
                    llmProviderHint={llmProviderHint}
                    llmProviderLabelsByKey={llmProviderLabelsByKey}
                    modelBorderClass={modelBorderClass}
                    modelDropdownOpen={modelDropdownOpen}
                    modelDropdownRef={modelDropdownRef}
                    onModelDropdownOpenChange={onModelDropdownOpenChange}
                    errorSourceOptions={errorSourceOptions}
                    errorSourcesLoading={errorSourcesLoading}
                    pluginManifests={pluginManifests}
                    pluginOptions={pluginOptions}
                    pluginsLoading={pluginsLoading}
                    isMissingErrorSource={isMissingErrorSource}
                    sourceHelpClass={sourceHelpClass}
                    sourceHelpText={sourceHelpText}
                    sourcePlaceholderText={sourcePlaceholderText}
                    sourceSelectClass={sourceSelectClass}
                    sourceSelectValue={sourceSelectValue}
                    parameters={parameters}
                    parameterErrors={parameterErrors}
                    globalVariables={globalVariables}
                    logFilterErrors={logFilterErrors}
                    logFilterPreview={logFilterPreview}
                    logFilterSample={logFilterSample}
                    logFilterToggleText={logFilterToggleText}
                    onCollapse={onCollapse}
                    onActionChange={onUpdateActionDraft}
                    onLogFilterSampleChange={(value) => {
                      onLogFilterSampleChange(action.id, value);
                    }}
                    onDeleteAction={onDeleteAction}
                    onSaveAction={onSaveAction}
                    t={t}
                  />
                );
              }}
              renderCollapsedCard={(action, index, sortableApi) => {
                const { collapsedActionTitle } = getRunbookActionRenderState({
                  action,
                  modelDropdownOpen,
                  validErrorSourceIds,
                  validPluginActionIdsByPluginId,
                  selectableLlmProviderCount,
                  llmProviderLabelsByKey,
                  errorSourcesLoading,
                  errorSourceCount,
                  logFilterSamples,
                  t,
                });

                return (
                  <RunbookCollapsedActionCard
                    index={index}
                    collapsedActionTitle={collapsedActionTitle}
                    actionType={action.type}
                    summary={actionSummary(
                      action,
                      errorSourceLabelsById,
                      llmProviderLabelsByKey,
                      pluginManifests,
                      t,
                    )}
                    isDragging={sortableApi.isDragging}
                    isDragSource={sortableApi.isDragSource}
                    isDropTarget={sortableApi.isDropTarget}
                    onClick={() => {
                      onActionCardClick(action.id);
                    }}
                    onDelete={() => {
                      onDeleteAction(action.id);
                    }}
                    deleteTitle={t("runbooks.runbook.deleteAction_2")}
                    renderTypeBadge={(type) => <TypeBadge type={type} />}
                  />
                );
              }}
              onAddActionAt={onAddActionAt}
              t={t}
            />
          </DragDropProvider>
        )}
      </div>
      <RunbookRunDialog
        open={runDialogOpen}
        runtimeParameters={runtimeParameters}
        runtimeParameterValues={runtimeParameterValues}
        visibleSecureParameters={visibleSecureParameters}
        missingRuntimeRequiredParameterCount={
          missingRuntimeRequiredParameterCount
        }
        onValueChange={onRuntimeParameterValueChange}
        onToggleVisibility={onToggleSecureParameterVisibility}
        onCancel={onCancelRunDialog}
        onSubmit={onSubmitRunDialog}
        t={t}
      />
    </div>
  );
}
