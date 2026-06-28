import type { RefObject } from "react";

import type {
  PluginManifest,
  RunbookActionRecord,
  RunbookHttpHeader,
  RunbookHttpMethod,
  RunbookLlmProviderKey,
} from "../../services";
import type { SupportedActionType } from "./actionHelpers";
import type { TranslationFn } from "./types";

export const MISSING_SOURCE_SELECT_VALUE = "__missing__";

type RunbookActionFieldMeta = {
  fieldLabelKey: string;
  fieldPlaceholderKey: string;
};

export type RunbookActionTypeFieldMeta = Record<
  SupportedActionType,
  RunbookActionFieldMeta
>;

export type LlmModelOption = {
  providerKey: RunbookLlmProviderKey;
  modelId: string;
  label: string;
};

export type RunbookActionTypeFieldsProps = {
  action: RunbookActionRecord;
  actionMeta: RunbookActionTypeFieldMeta;
  httpMethods: RunbookHttpMethod[];
  headers: RunbookHttpHeader[];
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
  pluginManifests: PluginManifest[];
  pluginOptions: Array<{ id: string; label: string }>;
  pluginsLoading: boolean;
  isMissingErrorSource: boolean;
  sourceHelpClass: string;
  sourceHelpText: string;
  sourcePlaceholderText: string;
  sourceSelectClass: string;
  sourceSelectValue: string;
  onActionChange: (action: RunbookActionRecord) => void;
  t: TranslationFn;
};

export function createEmptyHttpHeader(): RunbookHttpHeader {
  return {
    key: "",
    value: "",
  };
}
