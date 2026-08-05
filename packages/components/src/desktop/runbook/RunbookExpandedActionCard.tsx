import type { ReactNode, RefObject } from "react";

import { Check, GripVertical, Trash2 } from "../../icons";
import type {
  GlobalVariable,
  PluginDescriptor,
  RunbookActionParameter,
  RunbookActionRecord,
  RunbookActionType,
  RunbookHttpHeader,
  RunbookHttpMethod,
  RunbookLlmProviderKey,
} from "../../services";
import { RunbookActionAdvancedSections } from "./RunbookActionAdvancedSections";
import type { ActionMeta, SupportedActionType } from "./actionHelpers";
import type { LlmModelOption } from "./RunbookActionFieldShared";
import { RunbookActionTypeFields } from "./RunbookActionTypeFields";
import type { TranslationFn } from "./types";

type ActionTypeMeta = Pick<ActionMeta, "icon" | "labelKey">;

type RunbookActionTypeSelectorProps<T extends RunbookActionType> = {
  action: RunbookActionRecord;
  actionTypes: readonly T[];
  actionMeta: Record<T, ActionTypeMeta>;
  onActionChange: (action: RunbookActionRecord) => void;
  t: TranslationFn;
};

export function RunbookActionTypeSelector<T extends RunbookActionType>({
  action,
  actionTypes,
  actionMeta,
  onActionChange,
  t,
}: RunbookActionTypeSelectorProps<T>) {
  return (
    <div
      data-tour="runbooks-action-types"
      className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-5"
    >
      {actionTypes.map((type) => {
        const { labelKey, icon: Icon } = actionMeta[type];
        const actionTypeButtonClass =
          action.type === type
            ? "border-primary bg-primary/5 text-foreground"
            : "border-border text-muted-foreground hover:bg-muted/50";

        return (
          <button
            key={type}
            onClick={() => {
              onActionChange({
                ...action,
                type,
              });
            }}
            className={[
              "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 text-xs transition-colors",
              actionTypeButtonClass,
            ].join(" ")}
          >
            <Icon size={13} />
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}

type RunbookExpandedActionCardProps = {
  action: RunbookActionRecord;
  expandedCardRef: RefObject<HTMLDivElement | null>;
  actionTypes: readonly SupportedActionType[];
  actionMeta: Record<SupportedActionType, ActionMeta>;
  titlePlaceholder: string;
  canSaveAction: boolean;
  headers: RunbookHttpHeader[];
  httpMethods: RunbookHttpMethod[];
  httpBodyPlaceholder: string;
  httpBodyValue: string;
  isGetHttpMethod: boolean;
  llmModelOptions: LlmModelOption[];
  llmProviderHint: string;
  llmProviderLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>;
  modelBorderClass: string;
  modelDropdownOpen: boolean;
  modelDropdownRef: RefObject<HTMLDivElement | null>;
  onModelDropdownOpenChange: (open: boolean) => void;
  errorSourceOptions: Array<{ id: string; label: string }>;
  errorSourcesLoading: boolean;
  pluginDescriptors: PluginDescriptor[];
  pluginOptions: Array<{ id: string; label: string }>;
  pluginsLoading: boolean;
  isMissingErrorSource: boolean;
  sourceHelpClass: string;
  sourceHelpText: string;
  sourcePlaceholderText: string;
  sourceSelectClass: string;
  sourceSelectValue: string;
  parameters: RunbookActionParameter[];
  parameterErrors: string[];
  globalVariables: GlobalVariable[];
  logFilterErrors: string[];
  logFilterPreview: {
    error?: string;
    groupNames?: string[];
    matchCount?: number;
    matched?: boolean;
    structuredOutput?: Record<string, unknown>;
  };
  logFilterSample: string;
  logFilterToggleText: string;
  onCollapse: () => void;
  onActionChange: (action: RunbookActionRecord) => void;
  onLogFilterSampleChange: (value: string) => void;
  onDeleteAction: (actionId: string) => void;
  onSaveAction: (actionId: string) => void;
  t: TranslationFn;
};

export type RunbookExpandedActionCardShellProps = {
  action: RunbookActionRecord;
  index: number;
  expandedCardRef: RefObject<HTMLDivElement | null>;
  canSaveAction: boolean;
  typeBadge: ReactNode;
  children: ReactNode;
  collapse: () => void;
  onActionChange: (action: RunbookActionRecord) => void;
  onDeleteAction: (actionId: string) => void;
  onSaveAction: (actionId: string) => void;
  t: (key: string) => string;
};

/**
 * Shared expanded-card frame for runbook consumers outside the CE editor.
 * The CE editor below remains the canonical full action renderer.
 */
export function RunbookExpandedActionCardShell({
  action,
  index,
  expandedCardRef,
  canSaveAction,
  typeBadge,
  children,
  collapse,
  onActionChange,
  onDeleteAction,
  onSaveAction,
  t,
}: RunbookExpandedActionCardShellProps) {
  return (
    <div
      ref={expandedCardRef}
      data-tour="runbooks-action-card"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          collapse();
        }
      }}
      className="mb-0 rounded-xl border border-primary/40 bg-card shadow-lg"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <GripVertical
          size={14}
          className="shrink-0 cursor-grab text-muted-foreground/40 active:cursor-grabbing"
        />
        <span className="w-4 shrink-0 text-center text-[10px] font-mono text-muted-foreground/40 tabular-nums">
          {index + 1}
        </span>
        <div className="flex-1">
          <input
            type="text"
            value={action.title}
            onChange={(event) => {
              onActionChange({
                ...action,
                title: event.target.value,
              });
            }}
            className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/50"
            placeholder={t("runbooks.runbooks.untitledAction")}
          />
        </div>
        {typeBadge}
      </div>

      <div className="space-y-4 p-4">{children}</div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <button
          onClick={() => {
            onDeleteAction(action.id);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
        >
          <Trash2 size={11} />
          {t("runbooks.runbooks.deleteAction")}
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground/40">
            {t("runbooks.runbooks.escapeToClose")}
          </span>
          <button
            onClick={() => {
              onSaveAction(action.id);
            }}
            disabled={!canSaveAction}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            <Check size={11} />
            {t("common.actions.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RunbookExpandedActionCard({
  action,
  expandedCardRef,
  actionTypes,
  actionMeta,
  titlePlaceholder,
  canSaveAction,
  headers,
  httpMethods,
  httpBodyPlaceholder,
  httpBodyValue,
  isGetHttpMethod,
  llmModelOptions,
  llmProviderHint,
  llmProviderLabelsByKey,
  modelBorderClass,
  modelDropdownOpen,
  modelDropdownRef,
  onModelDropdownOpenChange,
  errorSourceOptions,
  errorSourcesLoading,
  pluginDescriptors,
  pluginOptions,
  pluginsLoading,
  isMissingErrorSource,
  sourceHelpClass,
  sourceHelpText,
  sourcePlaceholderText,
  sourceSelectClass,
  sourceSelectValue,
  parameters,
  parameterErrors,
  globalVariables,
  logFilterErrors,
  logFilterPreview,
  logFilterSample,
  logFilterToggleText,
  onCollapse,
  onActionChange,
  onLogFilterSampleChange,
  onDeleteAction,
  onSaveAction,
  t,
}: RunbookExpandedActionCardProps) {
  return (
    <div
      data-tour="runbooks-action-card"
      ref={expandedCardRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCollapse();
        }
      }}
      className="rounded-xl border border-primary/40 bg-card px-4 py-4 space-y-3 shadow-sm"
    >
      <RunbookActionTypeSelector
        action={action}
        actionTypes={actionTypes}
        actionMeta={actionMeta}
        onActionChange={onActionChange}
        t={t}
      />
      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.title")}
        </label>
        <input
          autoFocus
          value={action.title}
          onChange={(event) => {
            onActionChange({
              ...action,
              title: event.target.value,
            });
          }}
          placeholder={t(titlePlaceholder)}
          className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
        />
      </div>
      <div className="space-y-4">
        <RunbookActionTypeFields
          action={action}
          actionMeta={actionMeta}
          httpMethods={httpMethods}
          headers={headers}
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
          pluginDescriptors={pluginDescriptors}
          pluginOptions={pluginOptions}
          pluginsLoading={pluginsLoading}
          isMissingErrorSource={isMissingErrorSource}
          sourceHelpClass={sourceHelpClass}
          sourceHelpText={sourceHelpText}
          sourcePlaceholderText={sourcePlaceholderText}
          sourceSelectClass={sourceSelectClass}
          sourceSelectValue={sourceSelectValue}
          onActionChange={onActionChange}
          t={t}
        />

        {(action.type === "shell" ||
          action.type === "llm" ||
          action.type === "http" ||
          action.type === "plugin" ||
          action.type === "external_source") && (
          <RunbookActionAdvancedSections
            action={action}
            parameters={parameters}
            parameterErrors={parameterErrors}
            globalVariables={globalVariables}
            logFilterErrors={logFilterErrors}
            logFilterPreview={logFilterPreview}
            logFilterSample={logFilterSample}
            logFilterToggleText={logFilterToggleText}
            onActionChange={onActionChange}
            onLogFilterSampleChange={onLogFilterSampleChange}
            t={t}
          />
        )}
      </div>
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={() => {
            onDeleteAction(action.id);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 size={11} />
          {t("runbooks.runbook.deleteAction")}
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground/40">
            {t("runbooks.runbook.escapeToClose")}
          </span>
          <button
            onClick={() => {
              onSaveAction(action.id);
            }}
            disabled={!canSaveAction}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            <Check size={11} />
            {t("common.actions.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
