import type { ReactNode } from "react";

import {
  AlertCircle,
  Bot,
  Globe,
  Puzzle,
  Terminal,
  type LucideIcon,
} from "../../icons";
import { useTranslation } from "@bitsentry-ce/i18n";
import { previewRunbookLogFilter, validateRunbookLogFilterConfig } from "@bitsentry-ce/core";
import { cn } from "../../lib/utils";
import type {
  RunbookActionParameter,
  RunbookActionRecord,
  RunbookActionType,
  RunbookHttpHeader,
  RunbookHttpMethod,
  RunbookLlmProviderKey,
  PluginDescriptor,
} from "../../services";
import type { TranslationFn } from "./types";

const MISSING_SOURCE_SELECT_VALUE = "__missing__";

export type ActionMeta = {
  labelKey: string;
  icon: LucideIcon;
  badgeCls: string;
  placeholderKey: string;
  fieldLabelKey: string;
  fieldPlaceholderKey: string;
};

export const ACTION_TYPES = [
  "shell",
  "llm",
  "http",
  "plugin",
  "external_source",
] as const satisfies readonly RunbookActionType[];

export type SupportedActionType = (typeof ACTION_TYPES)[number];

export const ACTION_META: Record<SupportedActionType, ActionMeta> = {
  shell: {
    labelKey: "runbooks.runbook.actionTypeShell",
    icon: Terminal,
    badgeCls: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    placeholderKey: "runbooks.runbook.exampleRunBackupScript",
    fieldLabelKey: "runbooks.runbook.command",
    fieldPlaceholderKey: "runbooks.runbook.fetchLogsPlaceholder",
  },
  llm: {
    labelKey: "runbooks.runbook.actionTypeAi",
    icon: Bot,
    badgeCls: "text-blue-500 bg-blue-500/10 border-blue-500/20",
    placeholderKey: "runbooks.runbook.exampleAnalyzeTheOutput",
    fieldLabelKey: "runbooks.runbook.prompt",
    fieldPlaceholderKey: "runbooks.runbook.analyzeErrorsPlaceholder",
  },
  http: {
    labelKey: "runbooks.runbook.actionTypeHttp",
    icon: Globe,
    badgeCls: "text-amber-500 bg-amber-500/10 border-amber-500/20",
    placeholderKey: "runbooks.runbook.exampleFetchApiData",
    fieldLabelKey: "runbooks.runbook.url",
    fieldPlaceholderKey: "runbooks.runbook.apiEndpointPlaceholder",
  },
  plugin: {
    labelKey: "runbooks.runbook.actionTypePlugin",
    icon: Puzzle,
    badgeCls: "text-rose-500 bg-rose-500/10 border-rose-500/20",
    placeholderKey: "runbooks.runbook.exampleQueryGitHubIssues",
    fieldLabelKey: "runbooks.runbook.pluginAction",
    fieldPlaceholderKey: "runbooks.runbook.selectAPluginAction",
  },
  external_source: {
    labelKey: "runbooks.runbook.actionTypeExternalSource",
    icon: AlertCircle,
    badgeCls: "text-purple-500 bg-purple-500/10 border-purple-500/20",
    placeholderKey: "runbooks.runbook.exampleSearchRecentErrors",
    fieldLabelKey: "runbooks.runbook.query",
    fieldPlaceholderKey: "runbooks.runbook.isUnresolvedLevelError",
  },
};

const ACTION_TYPE_SET = new Set<SupportedActionType>(ACTION_TYPES);

export type RunbookActionRenderState = {
  modelBorderClass: string;
  isMissingErrorSource: boolean;
  parameterErrors: string[];
  logFilterErrors: string[];
  logFilterPreview: ReturnType<typeof previewRunbookLogFilter>;
  logFilterSample: string;
  canSaveAction: boolean;
  llmProviderHint: string;
  headers: RunbookHttpHeader[];
  isGetHttpMethod: boolean;
  httpBodyValue: string;
  httpBodyPlaceholder: string;
  sourceSelectValue: string;
  sourceSelectClass: string;
  sourceHelpClass: string;
  sourceHelpText: string;
  sourcePlaceholderText: string;
  parameters: RunbookActionParameter[];
  logFilterToggleText: string;
  collapsedActionTitle: ReactNode;
};

export function getActionMeta(type: RunbookActionType): ActionMeta {
  if (isSupportedActionType(type)) {
    return ACTION_META[type];
  }

  return {
    labelKey: "runbooks.runbook.actionTypeUnsupported",
    icon: AlertCircle,
    badgeCls: "text-muted-foreground bg-muted border-border",
    placeholderKey: "runbooks.runbook.unsupportedActionType",
    fieldLabelKey: "runbooks.runbook.input",
    fieldPlaceholderKey: "runbooks.runbook.emptyPlaceholder",
  };
}

export function validateActionParameters(
  parameters: RunbookActionParameter[] | undefined,
): string[] {
  if (parameters === undefined || parameters.length === 0) {
    return [];
  }

  const seenKeys = new Set<string>();
  const errors: string[] = [];

  parameters.forEach((parameter, index) => {
    const key = parameter.key.trim();

    if (key.length === 0) {
      errors.push(`Parameter ${String(index + 1)} is missing a key.`);
      return;
    }

    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
      errors.push(
        `Parameter "${key}" can only use letters, numbers, dots, dashes, and underscores.`,
      );
    }

    if (seenKeys.has(key)) {
      errors.push(`Parameter key "${key}" is duplicated.`);
    } else {
      seenKeys.add(key);
    }

    if (
      parameter.secure === true &&
      parameter.defaultValue !== undefined &&
      parameter.defaultValue.trim().length > 0
    ) {
      errors.push(`Secure parameter "${key}" cannot store a default value.`);
    }
  });

  return errors;
}

export function actionSummary(
  action: RunbookActionRecord,
  errorSourceLabelsById: Record<string, string>,
  providerLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>,
  pluginDescriptors: PluginDescriptor[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const suffix = getActionSummarySuffix(action, t);

  switch (action.type) {
    case "shell":
      return summarizeShellAction(action, suffix, t);
    case "llm":
      return summarizeLlmAction(action, providerLabelsByKey, suffix, t);
    case "http":
      return summarizeHttpAction(action, suffix);
    case "plugin":
      return summarizePluginAction(action, pluginDescriptors, suffix, t);
    case "external_source":
      return summarizeExternalSourceAction(
        action,
        errorSourceLabelsById,
        suffix,
        t,
      );
    default:
      if (action.title.length > 0) {
        return action.title;
      }

      return t("runbooks.runbook.unsupportedAction");
  }
}

export function TypeBadge({ type }: { type: RunbookActionType }) {
  const { t } = useTranslation();
  const { labelKey, icon: Icon, badgeCls } = getActionMeta(type);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        badgeCls,
      )}
    >
      <Icon size={9} />
      {t(labelKey)}
    </span>
  );
}

export function createDraftAction(): RunbookActionRecord {
  return {
    id: crypto.randomUUID(),
    type: "shell",
    title: "",
  };
}

export function canPersistRunbookAction(
  action: RunbookActionRecord,
  validErrorSourceIds: Set<string>,
  validPluginActionIdsByPluginId: Map<string, Set<string>>,
): boolean {
  if (action.title.trim().length === 0) {
    return false;
  }

  if (!hasValidExternalSourceActionTarget(action, validErrorSourceIds)) {
    return false;
  }

  if (!hasValidPluginActionTarget(action, validPluginActionIdsByPluginId)) {
    return false;
  }

  if (validateActionParameters(action.parameters).length > 0) {
    return false;
  }

  return validateRunbookLogFilterConfig(action.logFilter).length === 0;
}

export function reorderRunbookActions(
  actions: RunbookActionRecord[],
  initialIndex: number,
  index: number,
): RunbookActionRecord[] | null {
  if (initialIndex === index) {
    return null;
  }

  if (
    initialIndex < 0 ||
    initialIndex >= actions.length ||
    index < 0 ||
    index >= actions.length
  ) {
    return null;
  }

  const next = actions.slice();
  const [moved] = next.splice(initialIndex, 1);
  next.splice(index, 0, moved);
  return next;
}

export function getRunbookActionRenderState(input: {
  action: RunbookActionRecord;
  modelDropdownOpen: boolean;
  validErrorSourceIds: Set<string>;
  validPluginActionIdsByPluginId: Map<string, Set<string>>;
  selectableLlmProviderCount: number;
  llmProviderLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>;
  errorSourcesLoading: boolean;
  errorSourceCount: number;
  logFilterSamples: Record<string, string>;
  t: TranslationFn;
}): RunbookActionRenderState {
  const { action, t } = input;
  const hasSelectedErrorSource = hasSelectedRunbookErrorSource(
    action,
    input.validErrorSourceIds,
  );
  const isMissingErrorSource = isMissingRunbookErrorSource(
    action,
    hasSelectedErrorSource,
  );
  const logFilter = action.logFilter;
  const logFilterSample = input.logFilterSamples[action.id] ?? "";

  return {
    modelBorderClass: runbookModelBorderClass(input.modelDropdownOpen),
    isMissingErrorSource,
    parameterErrors: validateActionParameters(action.parameters),
    logFilterErrors: validateRunbookLogFilterConfig(logFilter),
    logFilterPreview: previewRunbookLogFilter(logFilterSample, logFilter),
    logFilterSample,
    canSaveAction: canPersistRunbookAction(
      action,
      input.validErrorSourceIds,
      input.validPluginActionIdsByPluginId,
    ),
    llmProviderHint: runbookLlmProviderHint(
      action,
      input.selectableLlmProviderCount,
      input.llmProviderLabelsByKey,
      t,
    ),
    headers: action.headers ?? [],
    ...runbookHttpBodyState(action, t),
    ...runbookSourceSelectState({
      action,
      isMissingErrorSource,
      errorSourcesLoading: input.errorSourcesLoading,
      errorSourceCount: input.errorSourceCount,
      t,
    }),
    parameters: action.parameters ?? [],
    logFilterToggleText: runbookLogFilterToggleText(logFilter, t),
    collapsedActionTitle: runbookCollapsedActionTitle(action, t),
  };
}

function isSupportedActionType(
  type: RunbookActionType,
): type is SupportedActionType {
  return ACTION_TYPE_SET.has(type as SupportedActionType);
}

function getActionSummarySuffix(
  action: RunbookActionRecord,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (action.parameters !== undefined && action.parameters.length > 0) {
    parts.push(
      t("runbooks.runbook.parameterCount", {
        count: action.parameters.length,
      }),
    );
  }
  if (action.logFilter !== undefined) {
    parts.push(t("runbooks.runbook.logFilter"));
  }

  if (parts.length === 0) {
    return "";
  }

  return ` · ${parts.join(" · ")}`;
}

function summarizeShellAction(
  action: RunbookActionRecord,
  suffix: string,
  t: (key: string) => string,
): string {
  if (action.command !== undefined && action.command.length > 0) {
    return `${action.command}${suffix}`;
  }

  return `${t("runbooks.runbook.noCommandSet")}${suffix}`;
}

function summarizeLlmAction(
  action: RunbookActionRecord,
  providerLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>,
  suffix: string,
  t: (key: string) => string,
): string {
  let modelLabel = action.llmModel?.trim();
  if (modelLabel === undefined || modelLabel.length === 0) {
    modelLabel = t("runbooks.runbook.primaryProviderDefaultModel");
  }

  if (action.llmProviderKey === undefined) {
    return `${modelLabel}${suffix}`;
  }

  const providerLabel =
    providerLabelsByKey[action.llmProviderKey] ?? action.llmProviderKey;
  return `${modelLabel} · ${providerLabel}${suffix}`;
}

function summarizeHttpAction(
  action: RunbookActionRecord,
  suffix: string,
): string {
  const method = action.method ?? "GET";
  if (action.url !== undefined && action.url.length > 0) {
    return `${method} ${action.url}${suffix}`;
  }

  return `${method} (no URL)${suffix}`;
}

function summarizePluginAction(
  action: RunbookActionRecord,
  pluginDescriptors: PluginDescriptor[],
  suffix: string,
  t: (key: string) => string,
): string {
  let pluginLabel = t("runbooks.runbook.noPluginSelected");
  let selectedPlugin: PluginDescriptor | undefined;
  if (action.pluginId !== undefined && action.pluginId.length > 0) {
    selectedPlugin = pluginDescriptors.find((plugin) => plugin.id === action.pluginId);
    pluginLabel =
      selectedPlugin?.name ?? `${t("runbooks.runbook.plugin")} (${action.pluginId})`;
  }

  let actionLabel = t("runbooks.runbook.noPluginActionSelected");
  if (selectedPlugin !== undefined) {
    const selectedAction = selectedPlugin.actions.find(
      (pluginAction) => pluginAction.id === action.pluginActionId,
    );
    actionLabel =
      selectedAction?.title ??
      (action.pluginActionId?.trim().length ? action.pluginActionId : actionLabel);
  } else if (action.pluginActionId?.trim().length) {
    actionLabel = action.pluginActionId;
  }

  return `${pluginLabel} - ${actionLabel}${suffix}`;
}

function summarizeExternalSourceAction(
  action: RunbookActionRecord,
  errorSourceLabelsById: Record<string, string>,
  suffix: string,
  t: (key: string) => string,
): string {
  let sourceLabel = t("runbooks.runbook.noSourceSelected");
  if (action.sourceId !== undefined && action.sourceId.length > 0) {
    sourceLabel =
      errorSourceLabelsById[action.sourceId] ??
      `Missing source (${action.sourceId.slice(0, 8)})`;
  }

  if (action.query !== undefined && action.query.length > 0) {
    return `${sourceLabel} - ${action.query}${suffix}`;
  }

  return `${sourceLabel}${suffix}`;
}

function hasValidExternalSourceActionTarget(
  action: RunbookActionRecord,
  validErrorSourceIds: Set<string>,
): boolean {
  if (action.type !== "external_source") {
    return true;
  }

  const query = action.query?.trim() ?? "";
  const sourceId = action.sourceId ?? "";
  return query.length > 0 && validErrorSourceIds.has(sourceId);
}

function hasValidPluginActionTarget(
  action: RunbookActionRecord,
  validPluginActionIdsByPluginId: Map<string, Set<string>>,
): boolean {
  if (action.type !== "plugin") {
    return true;
  }

  const pluginId = action.pluginId?.trim() ?? "";
  const pluginActionId = action.pluginActionId?.trim() ?? "";
  if (pluginId.length === 0 || pluginActionId.length === 0) {
    return false;
  }

  return validPluginActionIdsByPluginId.get(pluginId)?.has(pluginActionId) === true;
}

function runbookModelBorderClass(modelDropdownOpen: boolean): string {
  if (modelDropdownOpen) {
    return "border-primary/50";
  }

  return "border-border";
}

function hasSelectedRunbookErrorSource(
  action: RunbookActionRecord,
  validErrorSourceIds: Set<string>,
): boolean {
  return (
    typeof action.sourceId === "string" &&
    validErrorSourceIds.has(action.sourceId)
  );
}

function isMissingRunbookErrorSource(
  action: RunbookActionRecord,
  hasSelectedErrorSource: boolean,
): boolean {
  return (
    action.type === "external_source" &&
    typeof action.sourceId === "string" &&
    action.sourceId.length > 0 &&
    !hasSelectedErrorSource
  );
}

function runbookLlmProviderHint(
  action: RunbookActionRecord,
  selectableLlmProviderCount: number,
  llmProviderLabelsByKey: Partial<Record<RunbookLlmProviderKey, string>>,
  t: TranslationFn,
): string {
  if (selectableLlmProviderCount === 0) {
    return t("runbooks.runbook.noConfiguredAiProvidersAre");
  }

  if (action.llmProviderKey !== undefined) {
    return t("runbooks.runbook.thisModelWillRunOn", {
      provider:
        llmProviderLabelsByKey[action.llmProviderKey] ?? action.llmProviderKey,
    });
  }

  return t("runbooks.runbook.ifThisMatchesAConfigured");
}

function runbookHttpBodyState(
  action: RunbookActionRecord,
  t: TranslationFn,
): Pick<
  RunbookActionRenderState,
  "httpBodyPlaceholder" | "httpBodyValue" | "isGetHttpMethod"
> {
  const httpMethod = action.method ?? "GET";
  const isGetHttpMethod = httpMethod === "GET";
  if (isGetHttpMethod) {
    return {
      isGetHttpMethod,
      httpBodyValue: "",
      httpBodyPlaceholder: t("runbooks.runbook.getRequestsDoNotSend"),
    };
  }

  return {
    isGetHttpMethod,
    httpBodyValue: action.body ?? "",
    httpBodyPlaceholder: t("runbooks.runbook.optionalRequestBody"),
  };
}

function runbookSourceSelectState(input: {
  action: RunbookActionRecord;
  isMissingErrorSource: boolean;
  errorSourcesLoading: boolean;
  errorSourceCount: number;
  t: TranslationFn;
}): Pick<
  RunbookActionRenderState,
  | "sourceHelpClass"
  | "sourceHelpText"
  | "sourcePlaceholderText"
  | "sourceSelectClass"
  | "sourceSelectValue"
> {
  return {
    sourceSelectValue: runbookSourceSelectValue(
      input.action,
      input.isMissingErrorSource,
    ),
    sourceSelectClass: runbookSourceSelectClass(input.isMissingErrorSource),
    sourceHelpClass: runbookSourceHelpClass(input.isMissingErrorSource),
    sourceHelpText: runbookSourceHelpText(input),
    sourcePlaceholderText: runbookSourcePlaceholderText(input),
  };
}

function runbookSourceSelectValue(
  action: RunbookActionRecord,
  isMissingErrorSource: boolean,
): string {
  if (isMissingErrorSource) {
    return MISSING_SOURCE_SELECT_VALUE;
  }

  return action.sourceId ?? "";
}

function runbookSourceSelectClass(isMissingErrorSource: boolean): string {
  if (isMissingErrorSource) {
    return "border-destructive/40";
  }

  return "border-border focus:border-primary/50";
}

function runbookSourceHelpClass(isMissingErrorSource: boolean): string {
  if (isMissingErrorSource) {
    return "text-destructive";
  }

  return "text-muted-foreground/60";
}

function runbookSourceHelpText(input: {
  isMissingErrorSource: boolean;
  errorSourcesLoading: boolean;
  errorSourceCount: number;
  t: TranslationFn;
}): string {
  if (input.isMissingErrorSource) {
    return input.t("runbooks.runbook.thePreviouslySelectedSourceNo");
  }

  if (input.errorSourcesLoading) {
    return input.t("runbooks.runbook.loadingExistingConnectionsFromSettings");
  }

  if (input.errorSourceCount === 0) {
    return input.t("runbooks.runbook.addAnExternalSourceInSettings");
  }

  return input.t("runbooks.runbook.chooseOneOfTheConnected");
}

function runbookSourcePlaceholderText(input: {
  errorSourcesLoading: boolean;
  errorSourceCount: number;
  t: TranslationFn;
}): string {
  if (input.errorSourcesLoading) {
    return input.t("runbooks.runbooks.loadingExternalSources");
  }

  if (input.errorSourceCount === 0) {
    return input.t("runbooks.runbooks.noExternalSourcesConnected");
  }

  return input.t("runbooks.runbooks.selectAnExternalSource");
}

function runbookLogFilterToggleText(
  logFilter: RunbookActionRecord["logFilter"],
  t: TranslationFn,
): string {
  if (logFilter !== undefined) {
    return t("runbooks.runbook.removeFilter");
  }

  return t("runbooks.runbook.addFilter");
}

function runbookCollapsedActionTitle(
  action: RunbookActionRecord,
  t: TranslationFn,
): ReactNode {
  if (action.title.length > 0) {
    return action.title;
  }

  return (
    <span className="font-normal text-muted-foreground/50">
      {t("runbooks.runbook.untitledAction")}
    </span>
  );
}
