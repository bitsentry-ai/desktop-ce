import type { ReactNode, RefObject } from "react";

import { Check, GripVertical, Loader2, Trash2 } from "../../icons";
import { cn } from "../../lib/utils";
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
import { useRunbookPermissions } from "../../services/context";
import { RunbookActionAdvancedSections } from "./RunbookActionAdvancedSections";
import type { ActionMeta, SupportedActionType } from "./actionHelpers";
import type { LlmModelOption } from "./RunbookActionFieldShared";
import { RunbookActionTypeFields } from "./RunbookActionTypeFields";
import { claimEscape, isUnhandledEscape, saveBlockedReasonKey } from "./actionDraftGuard";
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
  /** Whether the step has edits that are not saved yet; clicking away or Escape then keeps it open. */
  draftDirty?: boolean;
  /** Bumped each time a click away or Escape was refused, so the unsaved line draws the eye again. */
  unsavedNudge?: number;
  /** True while Done is saving; the fields lock so nothing typed meanwhile is lost. */
  saving?: boolean;
  /** Throws the unsaved edits away (a new step disappears). */
  onDiscardDraft?: () => void;
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
  /** Whether the step has edits that are not saved yet; the footer then offers Discard instead of "Escape to close". */
  draftDirty?: boolean;
  /** Bumped each time a click away or Escape was refused, so the unsaved line draws the eye again. */
  unsavedNudge?: number;
  /** True while Done is saving; the fields lock so nothing typed meanwhile is lost. */
  saving?: boolean;
  /** Throws the unsaved edits away (a new step disappears). */
  onDiscardDraft?: () => void;
  t: (key: string) => string;
};

/** The footer's left-of-Done notice: unsaved changes with Discard, or the Escape hint. */
function DraftFooterNotice({
  draftDirty,
  unsavedNudge,
  onDiscardDraft,
  t,
}: {
  draftDirty: boolean;
  unsavedNudge: number;
  onDiscardDraft?: () => void;
  t: (key: string) => string;
}) {
  if (!draftDirty || onDiscardDraft === undefined) {
    return (
      <span className="text-xs text-muted-foreground/60 max-sm:hidden">
        {t("runbooks.runbook.escapeToClose")}
      </span>
    );
  }
  return (
    <span
      key={unsavedNudge}
      role="status"
      data-testid="runbook-unsaved-draft"
      className={cn(
        "flex items-center gap-2 text-xs",
        unsavedNudge > 0
          ? "animate-in fade-in-0 font-medium text-foreground duration-300"
          : "text-muted-foreground",
      )}
    >
      {unsavedNudge > 0
        ? t("runbooks.runbook.unsavedChangesNudge")
        : t("runbooks.runbook.unsavedChanges")}
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onDiscardDraft}
        className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:py-2"
      >
        {t("runbooks.runbook.discardChanges")}
      </button>
    </span>
  );
}

/** Says why Done is unavailable ("Add a title to save"), right beside it; a missing title is one click from its field. */
function SaveBlockedReason({
  action,
  canSaveAction,
  cardRef,
  t,
}: {
  action: Pick<RunbookActionRecord, "title">;
  canSaveAction: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  t: (key: string) => string;
}) {
  const reason = saveBlockedReasonKey(action, canSaveAction);
  if (reason === null) return null;
  if (reason === "runbooks.runbook.saveNeedsTitle") {
    return (
      <button
        type="button"
        data-testid="runbook-save-blocked"
        onClick={() => {
          const title = cardRef.current?.querySelector<HTMLInputElement>("[data-step-title]");
          title?.scrollIntoView({ block: "center", behavior: "smooth" });
          title?.focus({ preventScroll: true });
        }}
        className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:py-2"
      >
        {t(reason)}
      </button>
    );
  }
  return (
    <span data-testid="runbook-save-blocked" className="text-xs text-muted-foreground">
      {t(reason)}
    </span>
  );
}

/** Done, or "Saving..." while the step is being written. */
function DoneButton({
  saving,
  disabled,
  onClick,
  t,
}: {
  saving: boolean;
  disabled: boolean;
  onClick: () => void;
  t: (key: string) => string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || saving}
      aria-busy={saving}
      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-[hsl(var(--primary-hover))] disabled:opacity-40 aria-busy:opacity-70"
    >
      {saving ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Check size={11} aria-hidden="true" />}
      {saving ? t("common.actions.saving") : t("common.actions.done")}
    </button>
  );
}

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
  draftDirty = false,
  unsavedNudge = 0,
  saving = false,
  onDiscardDraft,
  t,
}: RunbookExpandedActionCardShellProps) {
  // Without write permission the step reads as is: fields are disabled and Done only closes it.
  const { canWrite, writeTitle } = useRunbookPermissions();
  return (
    <div
      ref={expandedCardRef}
      data-tour="runbooks-action-card"
      onKeyDown={(event) => {
        if (isUnhandledEscape(event)) {
          claimEscape(event);
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
        <span className="w-4 shrink-0 text-center text-xs font-mono text-muted-foreground/40 tabular-nums">
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
            readOnly={!canWrite || saving}
            data-step-title=""
            title={canWrite ? undefined : writeTitle}
            className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/50"
            placeholder={t("runbooks.runbooks.untitledAction")}
          />
        </div>
        {typeBadge}
      </div>

      <fieldset
        disabled={!canWrite || saving}
        title={canWrite ? undefined : writeTitle}
        className="m-0 min-w-0 space-y-4 border-0 p-4"
      >
        {children}
      </fieldset>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
        {canWrite ? (
          <button
            onClick={() => {
              onDeleteAction(action.id);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 size={11} />
            {t("runbooks.runbooks.deleteAction")}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">{writeTitle}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {canWrite && (
            <DraftFooterNotice
              draftDirty={draftDirty}
              unsavedNudge={unsavedNudge}
              onDiscardDraft={onDiscardDraft}
              t={t}
            />
          )}
          {canWrite && (
            <SaveBlockedReason action={action} canSaveAction={canSaveAction} cardRef={expandedCardRef} t={t} />
          )}
          <DoneButton
            saving={saving}
            disabled={canWrite && !canSaveAction}
            onClick={() => {
              if (canWrite) onSaveAction(action.id);
              else collapse();
            }}
            t={t}
          />
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
  draftDirty = false,
  unsavedNudge = 0,
  saving = false,
  onDiscardDraft,
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
        if (isUnhandledEscape(event)) {
          claimEscape(event);
          onCollapse();
        }
      }}
      className="rounded-xl border border-primary/40 bg-card px-4 py-4 space-y-3 shadow-sm"
    >
      <fieldset disabled={saving} className="m-0 min-w-0 space-y-3 border-0 p-0">
        <RunbookActionTypeSelector
          action={action}
          actionTypes={actionTypes}
          actionMeta={actionMeta}
          onActionChange={onActionChange}
          t={t}
        />
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("runbooks.runbook.title")}
          </label>
          <input
            autoFocus
            data-step-title=""
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
      </fieldset>
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
        <button
          onClick={() => {
            onDeleteAction(action.id);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 size={11} />
          {t("runbooks.runbook.deleteAction")}
        </button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <DraftFooterNotice
            draftDirty={draftDirty}
            unsavedNudge={unsavedNudge}
            onDiscardDraft={onDiscardDraft}
            t={t}
          />
          <SaveBlockedReason action={action} canSaveAction={canSaveAction} cardRef={expandedCardRef} t={t} />
          <DoneButton
            saving={saving}
            disabled={!canSaveAction}
            onClick={() => {
              onSaveAction(action.id);
            }}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
